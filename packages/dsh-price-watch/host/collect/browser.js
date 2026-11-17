/**
 * L2 collector: a real logged-in Chrome that reads the fare products Ctrip
 * renders and, when possible, the tax breakdown on the booking page.
 *
 * Why a browser: the flight list and the booking page refuse anonymous plain
 * HTTP (HTTP 432 / `whaleguard`), while a headed Chrome with a persistent
 * profile passes. Nothing here fabricates requests: it drives the same pages a
 * human would open and reads the text.
 *
 * V2 (contract §8) returns `{ points, flights, tax }`:
 *  - `flights` lists up to 8 rows of static information read straight from the
 *    list page; only the cheapest row is expanded and gets `products` / `prices`;
 *  - `points` carries one fare per passenger, taken from the cheapest bookable
 *    product of that expanded row;
 *  - `tax` is the order-page fee breakdown, or `null` when it could not be read.
 * Multi-row reading is best effort: when the row selectors do not match, the
 * collector degrades to the single expanded row instead of failing the run.
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
/** How many flight rows one run reads, per contract §8. */
const MAX_ROWS = 8;
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
   * Read up to 8 rows of static list-page information.
   * Best effort by design: any selector failure yields `[]` and the caller then
   * degrades to the single expanded row.
   */
  async function readRowList(page) {
    try {
      return await page.evaluate(({ selectors, maxRows }) => {
        const cap = Math.max(1, Math.min(12, Number(maxRows) || 8));
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
          const prices = [...text.matchAll(/¥\s?(\d{2,6})/g)]
            .map((match) => Number(match[1]))
            .filter((value) => Number.isFinite(value) && value > 0);
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
          };
        }).filter((row) => row.listPrice > 0);
        // Re-number after the filter so row N in the returned array is also the
        // node the "expand row N" step later clicks.
        return parsed.map((row, index) => {
          try {
            row.node.setAttribute('data-pw-row', String(index));
          } catch {
            /* cosmetic */
          }
          delete row.node;
          return row;
        });
      }, { selectors: ROW_SELECTORS, maxRows: MAX_ROWS });
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
      const row = document.querySelector('.flight-item.active')
        || (Number.isInteger(index) && index >= 0 ? document.querySelector('[data-pw-row="' + index + '"]') : null);
      if (!row) return null;
      const header = norm(row.innerText);
      const flightNo = (header.match(/\b[A-Z]{2}\d{3,4}\b/) || [])[0] || '';
      const airline = (header.match(/([\u4e00-\u9fa5]{2,8}航空)/) || [])[1] || '';
      const craft = (header.match(/((?:空客|波音|商飞)\s?[A-Z0-9]{2,4})/) || [])[1] || '';
      const times = header.match(/\b\d{2}:\d{2}\b/g) || [];
      const airports = header.match(/[\u4e00-\u9fa5]{2,6}T\d/g) || [];
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

  /** Contract §8 flight object for a row that was not expanded. */
  function passiveFlight(row) {
    return {
      no: row.flightNo || '',
      airline: row.airline || '',
      craft: row.craft || '',
      depTime: row.depTime || '',
      arrTime: row.arrTime || '',
      depAirport: row.depAirport || '',
      arrAirport: row.arrAirport || '',
      listPrice: Number(row.listPrice) || 0,
      products: null,
      prices: [],
      expanded: false,
    };
  }

  /** Contract §8 flight object for the expanded (cheapest) row. */
  function expandedFlight(row, snapshot, products, prices) {
    return {
      no: row.flightNo || snapshot.flightNo || '',
      airline: row.airline || snapshot.airline || '',
      craft: row.craft || snapshot.craft || '',
      depTime: row.depTime || snapshot.depTime || '',
      arrTime: row.arrTime || snapshot.arrTime || '',
      // The row parser knows which airport sits between the two clock times; the
      // expanded-product reader only sees them in DOM order and gets the
      // departure wrong when an airport has no terminal suffix.
      depAirport: row.depAirport || snapshot.depAirport || '',
      arrAirport: row.arrAirport || snapshot.arrAirport || '',
      listPrice: Number(row.listPrice) || 0,
      products,
      prices,
      expanded: true,
    };
  }

  /**
   * Collect one monitor with the browser.
   * @returns {Promise<{points:Array<object>, flights:Array<object>, tax:object|null}>}
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

        // Step 1 — static information for up to 8 rows (best effort).
        const rows = await readRowList(page);
        const cheapest = rows.length ? rows.reduce((best, row) => (row.listPrice < best.listPrice ? row : best)) : null;
        const targetIndex = cheapest ? rows.indexOf(cheapest) : null;

        // Step 2 — expand only the cheapest row.
        const expanded = await expandRow(page, targetIndex);
        if (!expanded) throw new Error('未能展开票价产品列表');
        await expandAllProducts(page);
        const snapshot = await readProducts(page, targetIndex);
        if (!snapshot || snapshot.products.length === 0) throw new Error('没有解析到票价产品');

        const passengers = (monitor.passengerIds || []).map((id) => store.findPassenger(id)).filter(Boolean);
        if (passengers.length === 0) throw new Error('监控没有有效乘客');
        const paxCount = passengers.length;

        // Cheapest first: products are ordered by bare fare, and the tax part is
        // a constant for the whole page, so the same order holds for totals.
        const catalogue = snapshot.products
          .map((product) => ({ product, rules: parseFareRules(product.limits.join(' ') || product.text) }))
          .sort((a, b) => a.product.price - b.product.price);

        // Step 3 — the tax breakdown, which turns bare fares into real totals.
        const tax = await readOrderTax(page);
        const feesTotal = tax && Number.isFinite(tax.total) ? tax.total : null;
        const estimateTotal = (bare) => Math.round(Number(bare) * 1.15);
        const totalFor = (bare) => (feesTotal !== null ? Math.round(Number(bare) + feesTotal) : estimateTotal(bare));

        // Which row was actually expanded: the click may land on another row when
        // the selector fallback kicked in, so trust the flight number the page
        // rendered. Its cabin/discount also fills in what a product card omits.
        let expandedIndex = targetIndex;
        if (rows.length > 0 && snapshot.flightNo) {
          const match = rows.findIndex((row) => row.flightNo === snapshot.flightNo);
          if (match >= 0) expandedIndex = match;
        }
        const expandedRow = expandedIndex !== null && rows[expandedIndex] ? rows[expandedIndex] : {};
        const cabinOf = (product) => product.cabin || expandedRow.cabin || '';
        const discountOf = (product) => product.discount ?? expandedRow.discount ?? null;
        const fareLabelOf = (product) => {
          const cabin = cabinOf(product);
          const discount = discountOf(product);
          if (cabin) return discount ? `${cabin} ${discount}` : cabin;
          const cleaned = String(product.text || '')
            .replace(/¥\s?\d+/g, '')
            .replace(/(选购|预订|订票|剩\s?\d+\s?张|展开查看所有产品)/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          return cleaned.slice(0, 24) || '票价';
        };

        const products = catalogue.map((entry) => ({
          price: entry.product.price,
          total: feesTotal !== null ? Math.round(Number(entry.product.price) + feesTotal) : null,
          cabin: cabinOf(entry.product),
          discount: discountOf(entry.product),
          text: entry.product.text,
          limits: entry.product.limits,
        }));

        const chosen = [];
        for (const passenger of passengers) {
          const winner = catalogue.find((entry) => fareFits(entry.rules, passenger, paxCount));
          if (!winner) continue;
          chosen.push({ passenger, product: winner.product, rules: winner.rules });
        }
        if (chosen.length === 0) throw new Error('当前乘客没有可订的票价产品');

        const at = isoNow();
        const points = chosen.map((entry) => {
          const bare = Number(entry.product.price);
          return {
            at,
            src: 'l2',
            taxSource: feesTotal !== null ? 'order' : 'estimate',
            key: {
              departDate: params.departDate,
              ...(params.trip === 'round' ? { returnDate: params.returnDate } : {}),
              passengerId: entry.passenger.id,
            },
            price: { bare, total: totalFor(bare) },
            meta: {
              flightNo: snapshot.flightNo,
              airline: snapshot.airline,
              depTime: snapshot.depTime,
              arrTime: snapshot.arrTime,
              fareLabel: fareLabelOf(entry.product),
              fareText: entry.product.text.slice(0, 160),
              restrictions: entry.rules,
              airportFee: tax?.airportFee ?? null,
              fuel: tax?.fuel ?? null,
            },
          };
        });
        const prices = chosen.map((entry) => ({
          passengerId: entry.passenger.id,
          total: totalFor(entry.product.price),
          fareLabel: fareLabelOf(entry.product),
        }));

        // Contract §8 `flights`: every static row, with only the expanded one
        // carrying products.
        const flights = rows.length === 0
          ? [expandedFlight({}, snapshot, products, prices)]
          : rows.map((row, index) => (index === expandedIndex
            ? expandedFlight(row, snapshot, products, prices)
            : passiveFlight(row)));

        return { points, flights, tax };
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
