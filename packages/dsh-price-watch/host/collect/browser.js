/**
 * L2 collector: a real logged-in Chrome that reads the fare products Ctrip
 * renders and, when possible, the tax breakdown on the booking page.
 *
 * Why a browser: the flight list and the booking page refuse anonymous plain
 * HTTP (HTTP 432 / `whaleguard`), while a headed Chrome with a persistent
 * profile passes. Nothing here fabricates requests: it drives the same pages a
 * human would open and reads the text.
 *
 * A2 (spec §3) returns `{ points, flights, tax, lowest }` and every one of the
 * ten cheapest rows carries a real payable price:
 *  - the list page is read for up to READ_ROWS static rows, sorted by list price,
 *    and the cheapest TOP_N (10) are expanded one by one; a row that fails to
 *    expand keeps its static data with `taxIncluded: null` instead of aborting
 *    the run, so one broken row never costs the whole collection;
 *  - the tax part (机建 + 燃油) is constant for one route + one date, so the
 *    booking page is opened exactly once, after all rows are expanded, and the
 *    same figure is applied to every row;
 *  - each flight gets `prices: [{ passengerId, bare, total, fareLabel }]` and
 *    `taxIncluded` (its cheapest payable price), plus `seats` / `soldOut` (D3:
 *    「剩 N 张」structured out of the row text, `null`/`false` when absent); the
 *    array is sorted by `taxIncluded` ascending with the priceless rows last;
 *  - `points` carries one point per passenger: that passenger's cheapest payable
 *    price across the TOP10;
 *  - `lowest = { flightNo, total }` is the cheapest payable price overall.
 * When the row selectors do not match at all the collector degrades to the old
 * single-row behaviour instead of failing the run.
 *
 * Safety rules baked in:
 *  - one persistent profile under `$DSH_HOME/price-watch/browser-profile/`;
 *    the login cookie never leaves it and never reaches the JSON stores;
 *  - one collection at a time (serial queue), headed window parked off-screen;
 *  - a blocked/verification page aborts the run and raises a typed error so the
 *    scheduler can back off instead of hammering;
 *  - the booking page is only opened for the single cheapest product and never
 *    submitted, so nothing is ever ordered.
 */
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { isoNow } from '../util.js';

const LIST_BASE = 'https://flights.ctrip.com';
const HOME = 'https://www.ctrip.com/';
const BLOCK_RE = /whaleguard|访问异常|禁止访问|安全验证|请完成验证|拖动滑块|滑动验证/;
/** How many flight rows are read from the list page before sorting by price. */
const READ_ROWS = 25;
/** How many of the cheapest rows are expanded and returned (A2 spec §3.2). */
const TOP_N = 10;
/** Park the window for ten idle minutes before closing it. */
const IDLE_CLOSE_MS = 10 * 60 * 1000;
/** Dwell on a page 3–8 s so the traffic still looks human. */
const DWELL_MIN_MS = 3000;
const DWELL_MAX_MS = 8000;
/** Row selectors tried before falling back to climbing from the book buttons. */
const ROW_SELECTORS = ['.flight-item', '[class*="flight-item"]', '[class*="flightItem"]', '.flight-list-item'];

/** Error raised when Ctrip answers with a bot-check page. */
export class BlockedError extends Error {
  constructor(message = '携程返回风控/验证页面') {
    super(message);
    this.name = 'BlockedError';
    this.code = 'BLOCKED';
  }
}

/** Error raised when the profile has no usable login cookie. */
export class AuthError extends Error {
  constructor(message = '携程登录态无效，需要重新授权') {
    super(message);
    this.name = 'AuthError';
    this.code = 'AUTH_REQUIRED';
  }
}

/** Age / headcount constraints parsed out of a fare product's fine print. */
export function parseFareRules(text) {
  const out = {};
  const source = String(text || '');
  let match;
  if ((match = source.match(/(\d{1,2})\s*[-~至]\s*(\d{1,2})\s*周岁/))) {
    out.ageMin = Number(match[1]);
    out.ageMax = Number(match[2]);
  } else if ((match = source.match(/(\d{1,2})\s*周岁\s*(?:及以上|以上)/))) {
    out.ageMin = Number(match[1]);
  } else if ((match = source.match(/(\d{1,2})\s*[-~至]\s*(\d{1,2})\s*岁/))) {
    out.ageMin = Number(match[1]);
    out.ageMax = Number(match[2]);
  }
  if (/学生认证|学生专享|学生票/.test(source)) out.requiresStudent = true;
  if (/儿童票|儿童专享|婴儿票/.test(source)) out.childOnly = true;
  if ((match = source.match(/限至少\s*(\d+)\s*人/))) out.minPax = Number(match[1]);
  if ((match = source.match(/限\s*(\d+)\s*[-~]\s*(\d+)\s*人可订/))) {
    out.minPax = Number(match[1]);
    out.maxPax = Number(match[2]);
  }
  return out;
}

/**
 * D3：从任意一段页面文本解析余票结构。
 *
 * - 「剩 3 张」「还剩3张」 → `{ seats: 3, soldOut: false }`
 * - 「无票 / 售罄 / 已售完」 → `{ seats: null, soldOut: true }`
 * - 都没写 → `{ seats: null, soldOut: false }`
 *
 * 列表行解析在页面上下文（`page.evaluate`）里执行，无法调用这里的函数，所以
 * `readRowList` 里保留了同样的两条正则 —— 改这里时请同步那边。
 */
export function parseSeatInfo(text) {
  const source = String(text || '');
  const match = source.match(/剩\s?(\d+)\s?张/);
  return {
    seats: match ? Number(match[1]) : null,
    soldOut: /无票|售罄|已售完/.test(source),
  };
}

/**
 * D3：行级余票为准，产品级只在行级没写时补齐。
 *
 * 售罄取「或」：任何一层看到无票都算售罄（少报售罄比多报更糟），但行级明确
 * 写了剩余张数时，不采信产品级的「无票」反证。
 */
export function resolveSeatInfo(row, product) {
  const rowSeats = Number.isInteger(row?.seats) ? row.seats : null;
  const rowSoldOut = row?.soldOut === true;
  const productSeats = Number.isInteger(product?.seats) ? product.seats : null;
  const productSoldOut = product?.soldOut === true;
  // 行级说无票就不要再用产品级的张数去「补」——两个口径都指向无票时，露出张数会误导。
  if (rowSoldOut) return { seats: rowSeats, soldOut: true };
  // 行级写了张数：以它为准，忽略产品级的「无票」反证（产品文案常是旧口径）。
  if (rowSeats !== null) return { seats: rowSeats, soldOut: false };
  // 行级完全没写余票：产品级是唯一线索，有则用。
  return { seats: productSeats, soldOut: productSoldOut };
}

/** Can `passenger` book a product carrying `rules`? */
export function fareFits(rules, passenger, paxCount) {
  const age = Number(passenger?.age);
  if (Number.isFinite(rules.ageMin) && !(Number.isFinite(age) && age >= rules.ageMin)) return false;
  if (Number.isFinite(rules.ageMax) && !(Number.isFinite(age) && age <= rules.ageMax)) return false;
  if (rules.requiresStudent && passenger?.type !== 'student') return false;
  if (rules.childOnly && passenger?.type !== 'child') return false;
  if (Number.isFinite(rules.minPax) && paxCount < rules.minPax) return false;
  if (Number.isFinite(rules.maxPax) && paxCount > rules.maxPax) return false;
  return true;
}

function listUrl(monitor) {
  const { params } = monitor;
  const cabin = params.cabin || 'y_s';
  const query = `cabin=${cabin}&adult=1&child=0&infant=0`;
  if (params.trip === 'round') {
    return `${LIST_BASE}/online/list/round-${params.dep}-${params.arr}?depdate=${params.departDate}_${params.returnDate}&${query}`;
  }
  return `${LIST_BASE}/online/list/oneway-${params.dep}-${params.arr}?depdate=${params.departDate}&${query}`;
}

/** Pause for a human-looking 3–8 s; never throws. */
async function dwell(page) {
  const ms = DWELL_MIN_MS + Math.floor(Math.random() * (DWELL_MAX_MS - DWELL_MIN_MS + 1));
  await page.waitForTimeout(ms).catch(() => {});
}

/** Pick the tax figures out of the booking page (best effort). */
function taxFromOrderInfo(info) {
  if (!info) return null;
  const fee = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  const airportFee = fee(info.airportFee);
  const fuel = fee(info.fuel);
  const declared = fee(info.feeSum);
  const total = airportFee !== null && fuel !== null ? airportFee + fuel : declared;
  if (!Number.isFinite(total) || total <= 0) return null;
  return { airportFee, fuel, total };
}

/**
 * @param {object} deps
 * @param {string} deps.rootDir        `$DSH_HOME/price-watch`
 * @param {object} deps.logger
 * @param {object} deps.store          for auth state + settings
 */
export function createBrowserCollector({ rootDir, logger, store }) {
  const profileDir = join(rootDir, 'browser-profile');
  let playwright = null;
  let playwrightAttempts = 0;
  let playwrightRetryAt = 0;
  let lastLoadError = null;
  let context = null;
  let idleTimer = null;
  let queue = Promise.resolve();

  /**
   * Resolve `playwright-core` once it is present.
   *
   * A plain dynamic `import()` of a bare specifier goes through the Host's own
   * module hooks, which fail for a package installed under this plugin only
   * (`Cannot read properties of undefined (reading 'playwright')`). Loading it
   * through `createRequire` uses Node's own CJS resolver and works in-process.
   * A failed resolution is retried later instead of being cached forever: the
   * profile's `node_modules` may be relinked while a plugin reload runs.
   */
  async function loadPlaywright() {
    if (playwright) return playwright;
    if (Date.now() < playwrightRetryAt) return null;
    const errors = [];
    try {
      const requireFromHere = createRequire(import.meta.url);
      const loaded = requireFromHere('playwright-core');
      const candidate = loaded?.chromium ? loaded : loaded?.default;
      if (!candidate?.chromium) throw new Error('playwright-core 未导出 chromium');
      playwright = candidate;
    } catch (cjsError) {
      errors.push(`require: ${cjsError?.message || cjsError}`);
      try {
        const loaded = await import('playwright-core');
        const candidate = loaded?.chromium ? loaded : loaded?.default;
        if (!candidate?.chromium) throw new Error('playwright-core 未导出 chromium');
        playwright = candidate;
      } catch (esmError) {
        errors.push(`import: ${esmError?.message || esmError}`);
        playwright = null;
      }
    }
    if (playwright) {
      playwrightAttempts = 0;
      playwrightRetryAt = 0;
      lastLoadError = null;
      return playwright;
    }
    playwrightAttempts += 1;
    lastLoadError = errors.join(' | ');
    // 1min, 2min, 5min, then every 10min.
    const waitMinutes = Math.min(10, playwrightAttempts <= 1 ? 1 : playwrightAttempts === 2 ? 2 : playwrightAttempts === 3 ? 5 : 10);
    playwrightRetryAt = Date.now() + waitMinutes * 60000;
    logger.warn(`无法加载 playwright-core（第 ${playwrightAttempts} 次），${waitMinutes} 分钟后重试；期间精确采集不可用，L1 仍可用`, lastLoadError);
    return null;
  }

  async function ensureContext({ visible = false } = {}) {
    const pw = await loadPlaywright();
    if (!pw) throw new Error('playwright-core 未安装');
    if (context) {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      return context;
    }
    await mkdir(profileDir, { recursive: true });
    const position = visible ? '60,60' : '-2200,-2200';
    context = await pw.chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1360, height: 950 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: [`--window-position=${position}`, '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {
        /* ignore */
      }
    });
    // Drop the cached page list so a stale tab cannot be reused.
    for (const page of context.pages().slice(1)) await page.close().catch(() => {});
    return context;
  }

  function scheduleIdleClose() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (context) {
        try {
          await context.close();
        } catch {
          /* ignore */
        }
        context = null;
      }
    }, IDLE_CLOSE_MS);
    idleTimer.unref?.();
  }

  async function hasTicket(candidate) {
    const cookies = await (candidate || (await ensureContext())).cookies();
    return cookies.some((cookie) => cookie.name === 'cticket' && String(cookie.value || '').length > 8);
  }

  /** Read the auth state from the profile without opening any page. */
  async function authStatus() {
    const state = store.getState();
    const stored = state.auth || { status: 'unknown', lastVerifiedAt: null };
    const pw = await loadPlaywright();
    if (!pw) return { ...stored, status: 'unavailable', reason: 'playwright-core 未安装' };
    try {
      const ctx = await ensureContext();
      const ok = await hasTicket(ctx);
      const next = {
        status: ok ? 'valid' : stored.status === 'valid' ? 'expired' : 'unknown',
        lastVerifiedAt: isoNow(),
        accountHint: stored.accountHint || '',
      };
      await store.saveState({ auth: next });
      return next;
    } catch (error) {
      return { ...stored, reason: String(error?.message || error) };
    } finally {
      scheduleIdleClose();
    }
  }

  /**
   * Open the real Ctrip home page in a visible window and wait for the user to
   * sign in. Resolves when the `cticket` cookie shows up.
   */
  async function startLogin({ timeoutMs = 8 * 60000 } = {}) {
    const ctx = await ensureContext({ visible: true });
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2500);
      if (await hasTicket(ctx)) {
        let accountHint = '';
        try {
          accountHint = await page.evaluate(() => {
            const text = document.body.innerText.replace(/\s+/g, ' ');
            const known = text.match(/([^\s]{2,12})\s+我的订单/);
            return known ? known[1].slice(0, 12) : '';
          });
        } catch {
          /* hint is cosmetic */
        }
        const auth = { status: 'valid', lastVerifiedAt: isoNow(), accountHint };
        await store.saveState({ auth });
        scheduleIdleClose();
        return { ok: true, auth };
      }
    }
    scheduleIdleClose();
    return { ok: false, error: '未检测到登录，可重试' };
  }

  /** Forget the login by deleting the whole browser profile. */
  async function logout() {
    if (context) {
      await context.close().catch(() => {});
      context = null;
    }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    await store.saveState({ auth: { status: 'unknown', lastVerifiedAt: isoNow(), accountHint: '' } });
    return { ok: true };
  }

  async function waitForFlights(page, timeoutMs = 35000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return {
          rows: document.querySelectorAll('button.btn-book').length,
          blocked: /whaleguard|访问异常|禁止访问|安全验证|请完成验证|拖动滑块|滑动验证/.test(text),
          bodyLen: text.length,
        };
      }).catch(() => ({ rows: 0, blocked: false }));
      if (state.rows > 0) return true;
      if (state.blocked) throw new BlockedError();
      await page.waitForTimeout(1200);
    }
    const diag = await page.evaluate(() => {
      const text = (document.body.innerText || '').replace(/\s+/g, ' ');
      return {
        text: text.slice(0, 300),
        len: text.length,
        priceChips: (text.match(/¥\s?\d{2,6}/g) || []).length,
        title: document.title.slice(0, 40),
      };
    }).catch(() => ({ text: '', len: 0, priceChips: 0, title: '' }));
    if (BLOCK_RE.test(diag.text)) throw new BlockedError(`携程返回验证/风控页：${diag.text.slice(0, 80)}`);
    // The page shell and the date strip render, but the flight rows are withheld:
    // that is Ctrip throttling the list endpoint rather than a layout change.
    if (diag.priceChips > 0 && diag.len > 200) {
      throw new BlockedError(`航班列表被限频（页面壳正常、日期条有价、航班行为空）: ${diag.len} 字`);
    }
    throw new Error(`航班列表未加载出来（${diag.len} 字，价格标记 ${diag.priceChips} 个）`);
  }

  /**
   * The list is virtualised: only the first 7 rows exist in the DOM after load,
   * the rest appear once the page is scrolled. Without this, "TOP 10" could
   * never be more than 7 rows even though 19 flights exist for the day.
   */
  async function loadRowWindow(page, { target = READ_ROWS, rounds = 5, stepMs = 1600 } = {}) {
    let previous = -1;
    let count = 0;
    for (let round = 0; round < rounds; round += 1) {
      count = await page.evaluate(() => document.querySelectorAll('.flight-item').length).catch(() => count);
      if (count >= target) return count;
      if (count === previous) return count; // nothing new loaded, stop early
      previous = count;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.1)).catch(() => {});
      await page.waitForTimeout(stepMs);
    }
    return count;
  }

  /**
   * Read up to 8 rows of static list-page information.
   * Best effort by design: any selector failure yields `[]` and the caller then
   * degrades to the single expanded row.
   */
  async function readRowList(page) {
    try {
      return await page.evaluate(({ selectors, maxRows }) => {
        const cap = Math.max(1, Math.min(30, Number(maxRows) || READ_ROWS));
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const plausiblyARow = (node) => Boolean(
          node
          && node.querySelector
          && node.querySelector('button.btn-book')
          && /¥\s?\d{2,6}/.test(node.innerText || ''),
        );
        let nodes = [];
        for (const selector of selectors) {
          try {
            const found = [...document.querySelectorAll(selector)].filter(plausiblyARow);
            if (found.length > 0) {
              nodes = found;
              break;
            }
          } catch {
            /* a bad selector is not fatal */
          }
        }
        if (nodes.length === 0) {
          // Fallback: climb from each book button to the nearest container that
          // still wraps exactly that one button.
          const seen = new Set();
          for (const button of document.querySelectorAll('button.btn-book')) {
            let node = button;
            for (let depth = 0; depth < 8 && node && node.parentElement; depth += 1) {
              node = node.parentElement;
              const text = node.innerText || '';
              if (/¥\s?\d{2,6}/.test(text) && text.length < 900 && node.querySelectorAll('button.btn-book').length === 1) {
                if (!seen.has(node)) {
                  seen.add(node);
                  nodes.push(node);
                }
                break;
              }
            }
          }
        }
        nodes = nodes.slice(0, cap);
        const parsed = nodes.map((node) => {
          const text = norm(node.innerText);
          const flightNo = (text.match(/\b[A-Z]{2}\d{3,4}\b/) || [])[0] || '';
          const airline = (text.match(/([\u4e00-\u9fa5]{2,8}航空)/) || [])[1] || '';
          const craft = (text.match(/((?:空客|波音|商飞)\s?[A-Z0-9]{2,4})/) || [])[1] || '';
          const times = text.match(/\b\d{2}:\d{2}\b/g) || [];
          const depTime = times[0] || '';
          const arrTime = times[1] || '';
          // A row reads `08:00 大兴国际机场 10:10 浦东国际机场T2 ...`: the airport
          // between the two clock times is the departure and the one after the
          // arrival time is the destination. Slicing beats a `...T\d` regex,
          // because most airports carry no terminal suffix.
          const airportOf = (value) => {
            const match = String(value || '').match(/[^\s\d]{2,12}?机场(?:T\d)?/);
            return match ? match[0] : '';
          };
          const i1 = depTime ? text.indexOf(depTime) : -1;
          const i2 = i1 >= 0 && arrTime ? text.indexOf(arrTime, i1 + depTime.length) : -1;
          let depAirport = '';
          let arrAirport = '';
          if (i1 >= 0 && i2 > i1) {
            depAirport = airportOf(text.slice(i1 + depTime.length, i2));
            arrAirport = airportOf(text.slice(i2 + arrTime.length));
          } else if (i1 >= 0) {
            depAirport = airportOf(text.slice(i1 + depTime.length));
          }
          const cabinMatch = text.match(/(超级经济舱|经济舱|公务舱|头等舱)\s*([\d.]+\s*折)?/);
          // D3 余票结构化：与模块顶部的 parseSeatInfo 保持同步（页面上下文里拿不到
          // 模块作用域的函数）。拿不到就是 null / false —— 不猜。展开产品卡片里也
          // 可能写剩票，但行级是权威来源（优先级见 resolveSeatInfo）。
          const seatMatch = text.match(/剩\s?(\d+)\s?张/);
          const seats = seatMatch ? Number(seatMatch[1]) : null;
          const soldOut = /无票|售罄|已售完/.test(text);
          // Rows carry several ¥ numbers: the fare ("¥330起"), sometimes a
          // discount ("立减¥50") or a coupon. Prefer numbers marked 起, and never
          // trust anything below ¥100 as an airfare — a 50 here sorts the row to
          // the front of the TOP-N queue for no reason.
          const matches = [...text.matchAll(/¥\s?(\d{2,6})\s*(起)?/g)];
          const fromMarked = matches.filter((match) => match[2]).map((match) => Number(match[1]));
          const prices = (fromMarked.length ? fromMarked : matches.map((match) => Number(match[1])))
            .filter((value) => Number.isFinite(value) && value >= 100);
          return {
            node,
            flightNo,
            airline,
            craft: craft.replace(/\s+/g, ''),
            depTime,
            arrTime,
            depAirport,
            arrAirport,
            cabin: cabinMatch ? cabinMatch[1] : '',
            discount: cabinMatch && cabinMatch[2] ? cabinMatch[2].replace(/\s+/g, '') : null,
            listPrice: prices.length ? Math.min(...prices) : 0,
            seats,
            soldOut,
          };
        }).filter((row) => row.listPrice > 0);
        // Re-number after the filter so `rowIndex` is the DOM marker the later
        // "expand this row" click uses; the returned array keeps DOM order and is
        // sorted by price only by the caller.
        return parsed.map((row, index) => {
          try {
            row.node.setAttribute('data-pw-row', String(index));
          } catch {
            /* cosmetic */
          }
          delete row.node;
          return { rowIndex: index, ...row };
        });
      }, { selectors: ROW_SELECTORS, maxRows: READ_ROWS });
    } catch (error) {
      logger.warn('读取航班列表失败，降级为只返回已展开的航班', error);
      return [];
    }
  }

  /** Expand one flight row so its fare products render. */
  async function expandRow(page, index) {
    if (Number.isInteger(index) && index >= 0) {
      const clicked = await page.evaluate((rowIndex) => {
        const row = document.querySelector('[data-pw-row="' + rowIndex + '"]');
        const button = row && row.querySelector('button.btn-book');
        if (!button) return false;
        button.scrollIntoView({ block: 'center' });
        button.click();
        return true;
      }, index).catch(() => false);
      if (clicked) {
        for (let poll = 0; poll < 12; poll += 1) {
          await page.waitForTimeout(700);
          const active = await page.locator('.flight-item.active').count().catch(() => 0);
          if (active > 0) return true;
        }
      }
    }
    // Layout fallback: the old "click the first row" path.
    if (await expandFirstFlight(page)) return true;
    return false;
  }

  /** Expand the first flight row so its fare products render. */
  async function expandFirstFlight(page) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.evaluate(() => {
        const button = document.querySelector('button.btn-book');
        if (button) {
          button.scrollIntoView({ block: 'center' });
          button.click();
        }
      }).catch(() => {});
      for (let poll = 0; poll < 10; poll += 1) {
        await page.waitForTimeout(700);
        const active = await page.locator('.flight-item.active').count().catch(() => 0);
        if (active > 0) return true;
      }
    }
    return false;
  }

  /** Reveal every fare product of the expanded flight when Ctrip collapsed them. */
  async function expandAllProducts(page) {
    const clicked = await page.evaluate(() => {
      const target = [...document.querySelectorAll('*')].find(
        (element) => /展开查看所有产品/.test(element.textContent || '') && (element.textContent || '').length < 30 && element.children.length === 0,
      );
      if (!target) return false;
      target.click();
      return true;
    }).catch(() => false);
    if (clicked) await page.waitForTimeout(2500);
    return clicked;
  }

  /** Read the fare products of the expanded row as plain data. */
  async function readProducts(page, rowIndex) {
    return page.evaluate((index) => {
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      // Prefer the row this run actually clicked: with several rows on screen the
      // `.active` class can still point at the previously expanded one, and then
      // the products read would belong to a different flight.
      const row = (Number.isInteger(index) && index >= 0 ? document.querySelector('[data-pw-row="' + index + '"]') : null)
        || document.querySelector('.flight-item.active');
      if (!row) return null;
      const header = norm(row.innerText);
      const flightNo = (header.match(/\b[A-Z]{2}\d{3,4}\b/) || [])[0] || '';
      const airline = (header.match(/([\u4e00-\u9fa5]{2,8}航空)/) || [])[1] || '';
      const craft = (header.match(/((?:空客|波音|商飞)\s?[A-Z0-9]{2,4})/) || [])[1] || '';
      const times = header.match(/\b\d{2}:\d{2}\b/g) || [];
      const airports = header.match(/[\u4e00-\u9fa5]{2,6}T\d/g) || [];
      const headerCabin = header.match(/(超级经济舱|经济舱|公务舱|头等舱)\s*([\d.]+\s*折)?/);
      const products = [];
      const seen = new Set();
      for (const button of row.querySelectorAll('button.btn-book')) {
        const label = norm(button.textContent);
        if (!/预订|选购/.test(label)) continue;
        let node = button.parentElement;
        let box = null;
        for (let depth = 0; depth < 7 && node; depth += 1) {
          const text = norm(node.innerText);
          if (/¥\s?\d{2,6}/.test(text) && text.length < 420) {
            box = node;
            break;
          }
          node = node.parentElement;
        }
        if (!box) continue;
        const text = norm(box.innerText);
        const price = Number((text.match(/¥\s?(\d{2,6})/) || [])[1]);
        if (!Number.isFinite(price) || price <= 0) continue;
        const key = `${price}|${text.slice(0, 60)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cabin = /超级经济舱/.test(text)
          ? '超级经济舱'
          : /公务舱|商务舱/.test(text)
            ? '公务舱'
            : /头等舱/.test(text)
              ? '头等舱'
              : /经济舱/.test(text)
                ? '经济舱'
                : '';
        const discount = Number((text.match(/(\d(?:\.\d)?)\s*折/) || [])[1]);
        products.push({
          price,
          cabin,
          discount: Number.isFinite(discount) ? discount : null,
          text: text.slice(0, 300),
          limits: text.match(/限[^ ]{0,50}/g) || [],
        });
      }
      return {
        flightNo,
        airline,
        craft: craft.replace(/\s+/g, ''),
        depTime: times[0] || '',
        arrTime: times[1] || '',
        depAirport: airports[0] || '',
        arrAirport: airports[1] || '',
        cabin: headerCabin ? headerCabin[1] : '',
        discount: headerCabin && headerCabin[2] ? headerCabin[2].replace(/\s+/g, '') : null,
        products,
      };
    }, rowIndex ?? null).catch(() => null);
  }

  /** Best-effort tax read on the booking page. Returns null on any trouble. */
  async function readOrderTax(page) {
    try {
      const navigated = page.waitForNavigation({ timeout: 18000 }).catch(() => null);
      await page.evaluate(() => {
        const row = document.querySelector('.flight-item.active');
        const button = row && [...row.querySelectorAll('button.btn-book')].find((b) => /预订/.test(b.textContent || ''));
        if (button) {
          button.scrollIntoView({ block: 'center' });
          button.click();
        }
      });
      await navigated;
      await page.waitForTimeout(4500);
      const info = await page.evaluate(() => {
        const text = (document.body.innerText || '').replace(/\s+/g, ' ');
        const pick = (re) => {
          const match = text.match(re);
          return match ? Number(String(match[1]).replace(/[^\d]/g, '')) : null;
        };
        return {
          airportFee: pick(/机建[^¥]{0,10}¥?\s*(\d{1,5})/),
          fuel: pick(/燃油[^¥]{0,10}¥?\s*(\d{1,5})/),
          feeSum: pick(/(?:税费|基建燃油|机建燃油)[^¥]{0,12}¥?\s*(\d{1,5})/),
          orderTotal: pick(/(?:总价|合计)[^¥]{0,10}¥?\s*(\d{1,5})/),
          sawBooking: /乘机人|证件|订单填写|去支付/.test(text),
        };
      }).catch(() => null);
      await page.goBack({ timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(1500);
      if (!info || !info.sawBooking) return null;
      const tax = taxFromOrderInfo(info);
      if (!tax) logger.info('订单页没有解析出机建燃油费，含税价改用估算');
      return tax;
    } catch (error) {
      logger.warn('读取订单页含税价失败，回退到日历估算', error);
      return null;
    }
  }

  /** Best-effort wait until clicking a row actually rendered its fare products. */
  async function waitRowExpanded(page, rowIndex, timeoutMs = 9000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await page.waitForTimeout(500);
      const ready = await page.evaluate((idx) => {
        const explicit = Number.isInteger(idx) && idx >= 0 ? document.querySelector('[data-pw-row="' + idx + '"]') : null;
        const scope = explicit || document.querySelector('.flight-item.active');
        if (!scope) return false;
        const text = scope.innerText || '';
        const bookButtons = scope.querySelectorAll('button.btn-book').length;
        // A collapsed row has exactly one 「预订」 button; an expanded one has one
        // per fare product (or an explicit 「选购」/「展开所有产品」 entry).
        return bookButtons >= 2 || /选购|展开查看所有产品/.test(text);
      }, rowIndex).catch(() => false);
      if (ready) return true;
    }
    return false;
  }

  /** `经济舱 2.1折`, falling back to the product card's own cleaned text. */
  function fareLabelOf(product, fallback) {
    const cabin = product.cabin || fallback.cabin || '';
    const discount = product.discount ?? fallback.discount ?? null;
    if (cabin) return discount ? `${cabin} ${discount}` : cabin;
    const cleaned = String(product.text || '')
      .replace(/¥\s?\d+/g, '')
      .replace(/(选购|预订|订票|剩\s?\d+\s?张|展开查看所有产品)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, 24) || '票价';
  }

  /** Payable total: real tax when the order page was read, +15% estimate otherwise. */
  function totalWith(bare, feesTotal) {
    return feesTotal !== null ? Math.round(Number(bare) + feesTotal) : Math.round(Number(bare) * 1.15);
  }

  /**
   * Choose one bookable product per passenger out of an expanded row.
   * Returns `null` when the row cannot serve any passenger (e.g. every product is
   * student-only), which the caller treats as "this row has no payable price".
   *
   * Also reports the row's product-level 余票 markers: the list row is the
   * authoritative source (see `flightOf`), these are only a fallback for rows
   * that say nothing themselves.
   */
  function chooseFares(snapshot, passengers, paxCount) {
    if (!snapshot || !Array.isArray(snapshot.products) || snapshot.products.length === 0) return null;
    const catalogue = snapshot.products
      .map((product) => ({ product, rules: parseFareRules(product.limits.join(' ') || product.text) }))
      .sort((a, b) => a.product.price - b.product.price);
    const chosen = [];
    for (const passenger of passengers) {
      const winner = catalogue.find((entry) => fareFits(entry.rules, passenger, paxCount));
      if (!winner) continue;
      chosen.push({
        passengerId: passenger.id,
        bare: Number(winner.product.price),
        // The row header carries the cabin when the product card omits it.
        fareLabel: fareLabelOf(winner.product, {
          cabin: snapshot.cabin,
          discount: snapshot.discount,
        }),
      });
    }
    if (chosen.length === 0) return null;
    // 产品级余票只取最便宜的那个产品卡片：同一行的产品通常共享余票描述。
    const leadProduct = catalogue[0]?.product || null;
    const productSeats = parseSeatInfo(leadProduct?.text);
    return {
      flightNo: snapshot.flightNo || '',
      snapshot,
      chosen,
      productSeats: productSeats.seats,
      productSoldOut: productSeats.soldOut,
    };
  }

  /**
   * Expand one row and read its fares, retrying once because the first click can
   * land before the list finishes rendering. Returns `null` (never throws) when
   * the row cannot be read — the caller keeps its static data and moves on.
   */
  async function expandAndRead(page, row, passengers, paxCount) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const clicked = await expandRow(page, row.rowIndex);
      if (!clicked && attempt === 1) return null;
      await waitRowExpanded(page, row.rowIndex);
      await expandAllProducts(page);
      const snapshot = await readProducts(page, row.rowIndex);
      if (!snapshot) {
        await page.waitForTimeout(1200);
        continue;
      }
      // 选择器降级时点击可能落到别的行：航班号对不上就放弃这一行，宁缺毋错。
      if (row.flightNo && snapshot.flightNo && row.flightNo !== snapshot.flightNo) {
        logger.warn(`展开的航班号不一致（期望 ${row.flightNo}，实际 ${snapshot.flightNo}），跳过该行`);
        return null;
      }
      const hit = chooseFares(snapshot, passengers, paxCount);
      if (hit) return hit;
      await page.waitForTimeout(1200);
    }
    return null;
  }

  /**
   * One A2 §3.3 flight object. `hit` is `{flightNo, snapshot, chosen}` from
   * `chooseFares`, or `null` when the row could not be expanded (static data only).
   */
  function flightOf(row, hit, feesTotal) {
    const snapshot = hit?.snapshot || null;
    const prices = (hit?.chosen || []).map((entry) => ({
      passengerId: entry.passengerId,
      bare: entry.bare,
      total: totalWith(entry.bare, feesTotal),
      fareLabel: entry.fareLabel,
    }));
    const totals = prices.map((price) => price.total).filter((value) => Number.isFinite(value) && value > 0);
    // D3：行级余票为准，产品级只补齐（规则集中在 resolveSeatInfo）。
    const seatInfo = resolveSeatInfo(row, { seats: hit?.productSeats ?? null, soldOut: hit?.productSoldOut === true });
    return {
      no: row.flightNo || hit?.flightNo || snapshot?.flightNo || '',
      airline: row.airline || snapshot?.airline || '',
      craft: row.craft || snapshot?.craft || '',
      depTime: row.depTime || snapshot?.depTime || '',
      arrTime: row.arrTime || snapshot?.arrTime || '',
      // The row parser knows which airport sits between the two clock times; the
      // expanded-product reader only sees them in DOM order and gets the
      // departure wrong when an airport has no terminal suffix.
      depAirport: row.depAirport || snapshot?.depAirport || '',
      arrAirport: row.arrAirport || snapshot?.arrAirport || '',
      listPrice: Number(row.listPrice) || 0,
      taxIncluded: totals.length ? Math.min(...totals) : null,
      seats: seatInfo.seats,
      soldOut: seatInfo.soldOut,
      prices,
      expanded: prices.length > 0,
    };
  }

  /** Cheapest payable price first; rows without any payable price go last. */
  function payableOrder(a, b) {
    const left = Number.isFinite(a.taxIncluded) ? a.taxIncluded : Number.POSITIVE_INFINITY;
    const right = Number.isFinite(b.taxIncluded) ? b.taxIncluded : Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    return (Number(a.listPrice) || 0) - (Number(b.listPrice) || 0);
  }

  /**
   * Collect one monitor with the browser.
   * @returns {Promise<{points:Array<object>, flights:Array<object>, tax:object|null,
   *                    lowest:{flightNo:string,total:number}}>}
   */
  async function collect(monitor, { signal } = {}) {
    const run = async () => {
      try {
        const params = monitor?.params || {};
        if (!params.departDate) throw new Error('日历模式没有确定日期，不做浏览器精确采集');
        const ctx = await ensureContext();
        if (!(await hasTicket(ctx))) throw new AuthError();
        const page = ctx.pages()[0] || (await ctx.newPage());
        if (signal?.aborted) throw new Error('已取消');

        await page.goto(listUrl(monitor), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForFlights(page);
        // Human pacing: look at the list for a few seconds before touching it.
        await dwell(page);

        const passengers = (monitor.passengerIds || []).map((id) => store.findPassenger(id)).filter(Boolean);
        if (passengers.length === 0) throw new Error('监控没有有效乘客');
        const paxCount = passengers.length;

        // Step 1 — static rows, then the cheapest TOP_N by *price*: the list is
        // often ordered by departure time, so the DOM order is not the answer.
        // Scroll first: the list only renders ~7 rows until it is scrolled.
        const loaded = await loadRowWindow(page);
        logger.info(`航班列表已加载 ${loaded} 行，按价格取前 ${TOP_N} 行展开`);
        const rows = await readRowList(page);
        const targets = rows.slice().sort((a, b) => a.listPrice - b.listPrice).slice(0, TOP_N);

        // Step 2 — expand each target row. A single failure only loses that row;
        // the cheapest one failing is tolerated as long as some row succeeded.
        const expanded = new Map();
        for (const row of targets) {
          const label = row.flightNo || `第 ${row.rowIndex + 1} 行`;
          try {
            const hit = await expandAndRead(page, row, passengers, paxCount);
            if (hit) expanded.set(row.rowIndex, hit);
          } catch (error) {
            logger.warn(`展开航班 ${label} 失败，跳过该行: ${String(error?.message || error)}`);
          }
          // Human pacing between row expansions.
          await page.waitForTimeout(900 + Math.floor(Math.random() * 1200)).catch(() => {});
        }

        // Degrade: if the row selectors found nothing at all, fall back to the old
        // "expand the first row" path so a layout change still yields one price.
        let single = null;
        if (rows.length === 0) {
          if (!(await expandFirstFlight(page))) throw new Error('未能展开票价产品列表');
          await expandAllProducts(page);
          const snapshot = await readProducts(page, null);
          single = chooseFares(snapshot, passengers, paxCount);
          if (!single) throw new Error('没有解析到票价产品');
        } else if (expanded.size === 0) {
          // 最低价那行也失败了：这次采集算失败，否则卡片上只有「—」。
          throw new Error('没有展开到任何航班的票价产品');
        }

        // Step 3 — tax once: 机建 + 燃油 are constant for one route + one date, so
        // the booking page is opened exactly once and applied to every row.
        const tax = await readOrderTax(page);
        const feesTotal = tax && Number.isFinite(tax.total) ? tax.total : null;
        const taxSource = feesTotal !== null ? 'order' : 'estimate';

        // Step 4 — flight objects, cheapest payable first.
        const flights = single
          ? [flightOf({}, single, feesTotal)]
          : targets.map((row) => flightOf(row, expanded.get(row.rowIndex) || null, feesTotal));
        flights.sort(payableOrder);

        // Step 5 — overall lowest plus one point per passenger (its cheapest row).
        let lowest = null;
        const bestByPassenger = new Map();
        for (const flight of flights) {
          if (Number.isFinite(flight.taxIncluded) && (!lowest || flight.taxIncluded < lowest.total)) {
            lowest = { flightNo: flight.no, total: flight.taxIncluded };
          }
          for (const price of flight.prices) {
            if (!Number.isFinite(price.total)) continue;
            const current = bestByPassenger.get(price.passengerId);
            if (!current || price.total < current.total) {
              bestByPassenger.set(price.passengerId, { price, flight });
            }
          }
        }
        if (!lowest || bestByPassenger.size === 0) throw new Error('本次没有采到可订的含税价');

        const at = isoNow();
        const points = [...bestByPassenger.entries()].map(([passengerId, entry]) => ({
          at,
          src: 'l2',
          taxSource,
          key: {
            departDate: params.departDate,
            ...(params.trip === 'round' ? { returnDate: params.returnDate } : {}),
            passengerId,
          },
          price: { bare: entry.price.bare, total: entry.price.total },
          meta: {
            flightNo: entry.flight.no,
            airline: entry.flight.airline,
            depTime: entry.flight.depTime,
            arrTime: entry.flight.arrTime,
            depAirport: entry.flight.depAirport,
            arrAirport: entry.flight.arrAirport,
            fareLabel: entry.price.fareLabel,
            airportFee: tax?.airportFee ?? null,
            fuel: tax?.fuel ?? null,
          },
        }));

        return { points, flights, tax, lowest };
      } finally {
        scheduleIdleClose();
      }
    };

    // Serialise every browser run: one window, one page at a time.
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  return {
    id: 'ctrip-browser',
    isAvailable: async () => Boolean(await loadPlaywright()),
    /** Last `playwright-core` resolution error, for the panel's diagnostics. */
    loadError: () => lastLoadError,
    authStatus,
    startLogin,
    logout,
    collect,
    dispose: async () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (context) await context.close().catch(() => {});
      context = null;
    },
  };
}
