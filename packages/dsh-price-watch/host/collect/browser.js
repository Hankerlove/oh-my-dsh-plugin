/**
 * L2 collector: a real logged-in Chrome that reads the fare products Ctrip
 * renders and, when possible, the tax breakdown on the booking page.
 *
 * Why a browser: the flight list and the booking page refuse anonymous plain
 * HTTP (HTTP 432 / `whaleguard`), while a headed Chrome with a persistent
 * profile passes. Nothing here fabricates requests: it drives the same pages a
 * human would open and reads the text.
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
import { join } from 'node:path';

import { isoNow } from '../util.js';

const LIST_BASE = 'https://flights.ctrip.com';
const HOME = 'https://www.ctrip.com/';
const BLOCK_RE = /whaleguard|访问异常|禁止访问|安全验证|请完成验证|拖动滑块|滑动验证/;

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

/**
 * @param {object} deps
 * @param {string} deps.rootDir        `$DSH_HOME/price-watch`
 * @param {object} deps.logger
 * @param {object} deps.store          for auth state + settings
 */
export function createBrowserCollector({ rootDir, logger, store }) {
  const profileDir = join(rootDir, 'browser-profile');
  let playwright = null;
  let playwrightChecked = false;
  let context = null;
  let idleTimer = null;
  let queue = Promise.resolve();

  async function loadPlaywright() {
    if (playwrightChecked) return playwright;
    playwrightChecked = true;
    try {
      playwright = await import('playwright-core');
    } catch (error) {
      logger.warn('未安装 playwright-core，精确采集不可用（L1 仍可用）', error);
      playwright = null;
    }
    return playwright;
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
    }, 120000);
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

  /** Expand one flight row so its fare products render. */
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
  async function readProducts(page) {
    return page.evaluate(() => {
      const row = document.querySelector('.flight-item.active');
      if (!row) return null;
      const header = (row.innerText || '').replace(/\s+/g, ' ');
      const flightNo = (header.match(/[A-Z]{2}\d{3,4}/) || [])[0] || '';
      const airline = (header.match(/^(\S+?(?:航空|公司))/) || [])[1] || '';
      const times = header.match(/\d{2}:\d{2}/g) || [];
      const products = [];
      const seen = new Set();
      for (const button of row.querySelectorAll('button.btn-book')) {
        const label = (button.textContent || '').trim();
        if (!/预订|选购/.test(label)) continue;
        let node = button.parentElement;
        let box = null;
        for (let depth = 0; depth < 7 && node; depth += 1) {
          const text = (node.innerText || '').replace(/\s+/g, ' ');
          if (/¥\s?\d{2,6}/.test(text) && text.length < 420) {
            box = node;
            break;
          }
          node = node.parentElement;
        }
        if (!box) continue;
        const text = (box.innerText || '').replace(/\s+/g, ' ');
        const price = Number((text.match(/¥\s?(\d{2,6})/) || [])[1]);
        if (!Number.isFinite(price) || price <= 0) continue;
        const key = `${price}|${text.slice(0, 60)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        products.push({
          price,
          label,
          text: text.slice(0, 300),
          limits: text.match(/限[^ ]{0,50}/g) || [],
        });
      }
      return { flightNo, airline, depTime: times[0] || '', arrTime: times[1] || '', products };
    });
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
          total: pick(/(?:总价|合计)[^¥]{0,10}¥?\s*(\d{1,5})/),
          sawBooking: /乘机人|证件|订单填写|去支付/.test(text),
        };
      }).catch(() => null);
      await page.goBack({ timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(1500);
      if (!info || !info.sawBooking) return null;
      return info;
    } catch (error) {
      logger.warn('读取订单页含税价失败，回退到日历估算', error);
      return null;
    }
  }

  /**
   * Collect one monitor with the browser.
   * @returns {Promise<Array<object>>} price points, one per passenger
   */
  async function collect(monitor, { signal } = {}) {
    const run = async () => {
      const ctx = await ensureContext();
      if (!(await hasTicket(ctx))) throw new AuthError();
      const page = ctx.pages()[0] || (await ctx.newPage());
      if (signal?.aborted) throw new Error('已取消');

      await page.goto(listUrl(monitor), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForFlights(page);

      if (!(await expandFirstFlight(page))) throw new Error('未能展开票价产品列表');
      await expandAllProducts(page);

      const snapshot = await readProducts(page);
      if (!snapshot || snapshot.products.length === 0) throw new Error('没有解析到票价产品');

      const passengers = (monitor.passengerIds || []).map((id) => store.findPassenger(id)).filter(Boolean);
      if (passengers.length === 0) throw new Error('监控没有有效乘客');
      const paxCount = passengers.length;

      const chosen = [];
      for (const passenger of passengers) {
        const eligible = snapshot.products
          .map((product) => ({ product, rules: parseFareRules(product.limits.join(' ') || product.text) }))
          .filter((entry) => fareFits(entry.rules, passenger, paxCount))
          .sort((a, b) => a.product.price - b.product.price);
        const winner = eligible[0];
        if (!winner) continue;
        chosen.push({ passenger, product: winner.product, rules: winner.rules });
      }
      if (chosen.length === 0) throw new Error('当前乘客没有可订的票价产品');

      const tax = await readOrderTax(page);
      const at = isoNow();
      const points = chosen.map((entry) => {
        const total = tax?.total && tax.total > entry.product.price ? tax.total : null;
        const estimatedBare = entry.product.price;
        const estimatedTotal = total || Math.round(estimatedBare * 1.15);
        return {
          at,
          src: 'l2',
          taxSource: tax?.total ? 'order' : 'estimate',
          key: {
            departDate: monitor.params.departDate,
            ...(monitor.params.trip === 'round' ? { returnDate: monitor.params.returnDate } : {}),
            passengerId: entry.passenger.id,
          },
          price: { bare: estimatedBare, total: estimatedTotal },
          meta: {
            flightNo: snapshot.flightNo,
            airline: snapshot.airline,
            depTime: snapshot.depTime,
            arrTime: snapshot.arrTime,
            fareLabel: entry.product.label,
            fareText: entry.product.text.slice(0, 160),
            restrictions: entry.rules,
            airportFee: tax?.airportFee ?? null,
            fuel: tax?.fuel ?? null,
          },
        };
      });
      scheduleIdleClose();
      return points;
    };

    // Serialise every browser run: one window, one page at a time.
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  return {
    id: 'ctrip-browser',
    isAvailable: async () => Boolean(await loadPlaywright()),
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
