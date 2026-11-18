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
 * D10 (round-trip monitors) — the user's call: both buying schemes must be
 * compared on the **payable price**, not on summed list fares, so a round trip
 * runs three browser flows and degrades independently:
 *   a) 联程: round list page → cheapest row (its `¥X起 往返总价`) → 「选为去程」
 *      → pick the cheapest return → booking page → real order total;
 *   b) 去程单买: the normal one-way list flow for the outbound date;
 *   c) 回程单买: the same flow with dep/arr swapped for the return date.
 * `combineRoundSchemes()` (pure, exported) turns them into `roundTrip`
 * (`round` / `oneway` / `comparison` / `errors` / `partial`), the per-passenger
 * points pick the cheaper scheme and tag it in `meta.scheme`, and `lowest`
 * carries the winning `scheme`. A single-trip monitor never runs any of this and
 * its flow is unchanged.
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

/**
 * 解析一条航班列表行文本（单程行与往返行通用；导出以便离线单测）。
 *
 * 单程行示例：
 *   `中国国航 CA1234 波音737(中) 08:00 大兴国际机场 10:10 浦东国际机场T2 ¥330起 剩 3 张`
 * 往返行示例（D10 探测到的真实文本）：
 *   `中国国航 CA8341 波音737(中) 14:30 大兴国际机场 16:35 浦东国际机场T2 ¥800起 往返总价 选为去程 剩1张`
 *
 * 往返行里的 `¥800起` 是**往返总价（起）**，不是单段价，所以额外给出
 * `isRoundRow` / `roundTotal`；下单程行这两个字段是 `false` / `null`。
 * 余票（`seats` / `soldOut`）与 D3 同一套规则，行解析是唯一实现。
 */
export function parseRowText(text) {
  const norm = String(text || '').replace(/\s+/g, ' ').trim();
  const flightNo = (norm.match(/\b[A-Z]{2}\d{3,4}\b/) || [])[0] || '';
  // 「中国国航」这类航司名不带「航空」二字，先试「XX航空」，再试常见简称。
  const airline = (norm.match(/([\u4e00-\u9fa5]{2,8}航空)/) || [])[1]
    || (norm.match(/(中国国航|中国东航|中国南航|中国联航|国航|东航|南航|海航|厦航|川航|深航|山航|吉祥航空|春秋航空)/) || [])[1]
    || '';
  const craft = (norm.match(/((?:空客|波音|商飞)\s?[A-Z0-9]{2,4})/) || [])[1] || '';
  const times = norm.match(/\b\d{2}:\d{2}\b/g) || [];
  const depTime = times[0] || '';
  const arrTime = times[1] || '';
  // 行读作 `08:00 大兴国际机场 10:10 浦东国际机场T2`：两个时刻之间的机场是出发，
  // 第二个时刻之后的机场是到达。切片比 `...T\d` 正则稳，因为多数机场没有航站楼后缀。
  const airportOf = (value) => {
    const match = String(value || '').match(/[^\s\d]{2,12}?机场(?:T\d)?/);
    return match ? match[0] : '';
  };
  const i1 = depTime ? norm.indexOf(depTime) : -1;
  const i2 = i1 >= 0 && arrTime ? norm.indexOf(arrTime, i1 + depTime.length) : -1;
  let depAirport = '';
  let arrAirport = '';
  if (i1 >= 0 && i2 > i1) {
    depAirport = airportOf(norm.slice(i1 + depTime.length, i2));
    arrAirport = airportOf(norm.slice(i2 + arrTime.length));
  } else if (i1 >= 0) {
    depAirport = airportOf(norm.slice(i1 + depTime.length));
  }
  const cabinMatch = norm.match(/(超级经济舱|经济舱|公务舱|头等舱)\s*([\d.]+\s*折)?/);
  const seatInfo = parseSeatInfo(norm);
  // 行里可能有多个 ¥：票价（「¥330起」）、立减/券。优先取带「起」的，且不把
  // ¥100 以下当机票价（那会把优惠券当成票价，把行排到最前面）。
  const matches = [...norm.matchAll(/¥\s?(\d{2,6})\s*(起)?/g)];
  const fromMarked = matches.filter((match) => match[2]).map((match) => Number(match[1]));
  const prices = (fromMarked.length ? fromMarked : matches.map((match) => Number(match[1])))
    .filter((value) => Number.isFinite(value) && value >= 100);
  const listPrice = prices.length ? Math.min(...prices) : 0;
  const isRoundRow = /往返总价/.test(norm);
  return {
    flightNo,
    airline,
    craft: craft.replace(/\s+/g, ''),
    depTime,
    arrTime,
    depAirport,
    arrAirport,
    cabin: cabinMatch ? cabinMatch[1] : '',
    discount: cabinMatch && cabinMatch[2] ? cabinMatch[2].replace(/\s+/g, '') : null,
    listPrice,
    isRoundRow,
    // 往返行：listPrice 即「往返总价（起）」；单程行为 null。
    roundTotal: isRoundRow ? listPrice : null,
    seats: seatInfo.seats,
    soldOut: seatInfo.soldOut,
  };
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

/**
 * 单程列表页 URL（导出：往返方案里的两段单买、以及离线测试都要用它）。
 * 形如 `/online/list/oneway-SHA-BJS?depdate=2026-12-01&cabin=y_s&adult=1&child=0&infant=0`。
 */
export function onewayListUrl({ dep, arr, date, cabin = 'y_s' }) {
  const query = `cabin=${cabin}&adult=1&child=0&infant=0`;
  return `${LIST_BASE}/online/list/oneway-${dep}-${arr}?depdate=${date}&${query}`;
}

/**
 * 往返列表页 URL（D10 联程方案的入口）。
 * 形如 `/online/list/round-SHA-BJS?depdate=2026-12-01_2026-12-08&cabin=y_s&adult=1&child=0&infant=0`。
 */
export function roundListUrl({ dep, arr, departDate, returnDate, cabin = 'y_s' }) {
  const query = `cabin=${cabin}&adult=1&child=0&infant=0`;
  return `${LIST_BASE}/online/list/round-${dep}-${arr}?depdate=${departDate}_${returnDate}&${query}`;
}

/** 监控对应的列表页 URL（单程走单程页，往返走往返页——D10 联程入口）。 */
function listUrl(monitor) {
  const { params } = monitor;
  if (params.trip === 'round') {
    return roundListUrl({ dep: params.dep, arr: params.arr, departDate: params.departDate, returnDate: params.returnDate, cabin: params.cabin });
  }
  return onewayListUrl({ dep: params.dep, arr: params.arr, date: params.departDate, cabin: params.cabin });
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
 * D10：把「联程」与「两段单买」合成一次往返采集的报告（纯函数，导出以便离线单测）。
 *
 * 口径（用户拍板，2026-11-18）：两者都用**待支付价 / 成交价**——联程用预订页总价，
 * 两段用各自预订页的税费 + 票价；列表裸价只在预订页读不到时兜底，并用
 * `payableSource:'list'` 标注、整份结果标 `partial`。
 *
 * @param {object} input
 * @param {object} input.monitor
 * @param {Array<{id:string}>} input.passengers
 * @param {object|null} input.round  联程结果：{listTotal, payable, payableSource, flightNo, ..., return}
 * @param {object|null} input.out    去程单买结果：{flights, tax, orderTotal}
 * @param {object|null} input.back   回程单买结果：同上
 * @param {{round?:string|null,out?:string|null,back?:string|null}} [input.errors]
 * @returns {{points:Array, flights:Array, tax:object|null, lowest:object, roundTrip:object}}
 */
export function combineRoundSchemes({ monitor, passengers, round, out, back, errors = {} }) {
  const params = monitor?.params || {};
  const list = (Array.isArray(passengers) ? passengers : []).filter(Boolean);
  const outFlights = Array.isArray(out?.flights) ? out.flights : [];
  const backFlights = Array.isArray(back?.flights) ? back.flights : [];

  /** 某位乘客在某个单程段里的最低待支付价（连带航班与票价标签）。 */
  const bestFor = (flights, passengerId) => {
    let best = null;
    for (const flight of flights) {
      for (const price of Array.isArray(flight?.prices) ? flight.prices : []) {
        if (price?.passengerId !== passengerId) continue;
        const total = Number(price.total);
        if (!Number.isFinite(total) || total <= 0) continue;
        if (!best || total < best.total) {
          best = { total, bare: Number(price.bare) || 0, fareLabel: price.fareLabel || '', flight };
        }
      }
    }
    return best;
  };

  const roundPayableRaw = Number(round?.payable);
  const roundPayable = Number.isFinite(roundPayableRaw) && roundPayableRaw > 0 ? Math.round(roundPayableRaw) : null;
  const roundSource = round?.payableSource === 'list' ? 'list' : 'order';

  /** 一段单程实测的税费 = 含税价 - 裸价。 */
  const legTaxOf = (best) => (best && best.total > 0 && best.bare > 0 ? Math.max(0, best.total - best.bare) : 0);
  let roundEstimated = false;

  // 每位乘客各算一次「联程 vs 两段单买」，取更便宜的那个作为该乘客的点。
  const perPassenger = list.map((passenger) => {
    const outBest = bestFor(outFlights, passenger.id);
    const backBest = bestFor(backFlights, passenger.id);
    const onewaySum = outBest && backBest ? Math.round(outBest.total + backBest.total) : null;
    // 联程只读到列表裸价时，用两段实测税费把它补成「待支付价」：否则拿裸价去比
    // 两段的含税价，会得出「联程省一大截」的错误结论。
    let roundTotal = roundPayable;
    if (roundSource === 'list' && roundPayable !== null && outBest && backBest) {
      roundTotal = Math.round(roundPayable + legTaxOf(outBest) + legTaxOf(backBest));
      roundEstimated = true;
    }
    const options = [];
    if (roundTotal !== null) {
      options.push({
        scheme: 'round',
        total: roundTotal,
        bare: Number(round?.listTotal) > 0 ? Math.round(Number(round.listTotal)) : 0,
        flightNo: round?.flightNo || '',
        flight: null,
        fareLabel: '',
      });
    }
    if (onewaySum !== null) {
      options.push({
        scheme: 'oneway',
        total: onewaySum,
        bare: Math.round((outBest.bare || 0) + (backBest.bare || 0)),
        flightNo: outBest.flight?.no || '',
        flight: outBest.flight,
        fareLabel: [outBest.fareLabel, backBest.fareLabel].filter(Boolean).join(' + '),
      });
    }
    options.sort((left, right) => left.total - right.total);
    return { passenger, outBest, backBest, onewaySum, roundTotal, chosen: options[0] || null };
  });

  const usable = perPassenger.filter((entry) => entry.chosen);
  if (usable.length === 0) throw new Error('联程与两段单买都没有拿到可用价格');

  // 快照里的「两段单买之和」取所有乘客中的最小和（与 lowest 口径一致）。
  let onewaySum = null;
  for (const entry of perPassenger) {
    if (entry.onewaySum === null) continue;
    if (onewaySum === null || entry.onewaySum < onewaySum) onewaySum = entry.onewaySum;
  }

  // 联程的「到手价」：读不到预订页时用「列表裸价 + 两段实测税费」。
  let roundEffective = null;
  for (const entry of perPassenger) {
    if (entry.roundTotal === null) continue;
    if (roundEffective === null || entry.roundTotal < roundEffective) roundEffective = entry.roundTotal;
  }
  if (roundEffective === null) roundEffective = roundPayable;

  const comparison = roundEffective !== null && onewaySum !== null
    ? (roundPayable === onewaySum
      ? { cheaper: 'tie', diff: 0, diffPct: 0, minTotal: roundEffective, maxTotal: onewaySum }
      : {
        cheaper: roundEffective < onewaySum ? 'round' : 'oneway',
        diff: Math.abs(roundEffective - onewaySum),
        // 百分比按「更贵的那个」算：读作「比另一种买法省 7.2%」，比按低价算更直观。
        diffPct: Number(((Math.abs(roundEffective - onewaySum) / Math.max(roundEffective, onewaySum)) * 100).toFixed(1)),
        minTotal: Math.min(roundEffective, onewaySum),
        maxTotal: Math.max(roundEffective, onewaySum),
      })
    : null;

  // 只要有一头没有真实到手价（联程是估算、或两段缺一段）就标 partial。
  const partial = roundEffective === null || onewaySum === null || roundEstimated || roundSource !== 'order';

  /** 单程段摘要：该段最便宜的可订航班（快照展示用）。 */
  const legSummary = (flights) => {
    let best = null;
    for (const flight of flights) {
      const total = Number(flight?.taxIncluded);
      if (!Number.isFinite(total) || total <= 0) continue;
      if (!best || total < best.payable) best = { payable: Math.round(total), flight };
    }
    if (!best) return null;
    return {
      payable: best.payable,
      flightNo: best.flight.no || '',
      depTime: best.flight.depTime || '',
      arrTime: best.flight.arrTime || '',
      depAirport: best.flight.depAirport || '',
      arrAirport: best.flight.arrAirport || '',
    };
  };

  const at = isoNow();
  const tax = out?.tax ?? back?.tax ?? null;
  const taxSource = tax && Number.isFinite(tax.total) ? 'order' : 'estimate';
  const points = usable.map(({ passenger, chosen }) => ({
    at,
    src: 'l2',
    taxSource,
    key: {
      departDate: params.departDate,
      ...(params.trip === 'round' ? { returnDate: params.returnDate } : {}),
      passengerId: passenger.id,
    },
    price: { bare: chosen.bare, total: chosen.total },
    meta: {
      // D10：这个点用的是哪一种买法，以及两种买法的价格都在 meta 里，供面板/卡片解释。
      scheme: chosen.scheme,
      roundPayable: roundEffective,
      onewaySum,
      comparison: comparison ? { cheaper: comparison.cheaper, diff: comparison.diff } : null,
      flightNo: chosen.flightNo,
      airline: chosen.flight?.airline || round?.airline || '',
      depTime: chosen.flight?.depTime || round?.depTime || '',
      arrTime: chosen.flight?.arrTime || round?.arrTime || '',
      depAirport: chosen.flight?.depAirport || round?.depAirport || '',
      arrAirport: chosen.flight?.arrAirport || round?.arrAirport || '',
      fareLabel: chosen.fareLabel,
      airportFee: tax?.airportFee ?? null,
      fuel: tax?.fuel ?? null,
    },
  }));

  const lowestEntry = usable.slice().sort((left, right) => left.chosen.total - right.chosen.total)[0];
  const lowest = {
    flightNo: lowestEntry.chosen.scheme === 'round' ? (round?.flightNo || '') : (lowestEntry.chosen.flightNo || ''),
    total: lowestEntry.chosen.total,
    scheme: lowestEntry.chosen.scheme,
  };

  const returnLeg = round?.return && typeof round.return === 'object'
    ? {
      flightNo: round.return.flightNo || '',
      depTime: round.return.depTime || '',
      arrTime: round.return.arrTime || '',
      depAirport: round.return.depAirport || '',
      arrAirport: round.return.arrAirport || '',
      listPrice: Number(round.return.listPrice) > 0 ? Math.round(Number(round.return.listPrice)) : null,
    }
    : null;

  return {
    points,
    // 往返监控的航班表展示「去程单买」的 TOP10（每行都有待支付价）；联程信息在 roundTrip 里。
    flights: outFlights,
    tax,
    lowest,
    roundTrip: {
      partial,
      round: roundEffective === null ? null : {
        payable: roundEffective,
        payableSource: roundEstimated ? 'list+tax' : roundSource,
        listTotal: Number(round?.listTotal) > 0 ? Math.round(Number(round.listTotal)) : null,
        flightNo: round?.flightNo || '',
        airline: round?.airline || '',
        craft: round?.craft || '',
        depTime: round?.depTime || '',
        arrTime: round?.arrTime || '',
        depAirport: round?.depAirport || '',
        arrAirport: round?.arrAirport || '',
        seats: Number.isInteger(round?.seats) ? round.seats : null,
        soldOut: round?.soldOut === true,
        return: returnLeg,
      },
      oneway: onewaySum === null ? null : {
        out: legSummary(outFlights),
        back: legSummary(backFlights),
        sum: onewaySum,
      },
      comparison,
      errors: {
        round: typeof errors.round === 'string' && errors.round ? errors.round : null,
        out: typeof errors.out === 'string' && errors.out ? errors.out : null,
        back: typeof errors.back === 'string' && errors.back ? errors.back : null,
      },
    },
  };
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
          // `.flight-item` covers both layouts: one-way rows carry a 订票
          // button, round-trip rows carry 「选为去程」 and no btn-book at all.
          rows: Math.max(
            document.querySelectorAll('.flight-item').length,
            document.querySelectorAll('.btn-book').length,
          ),
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
   * Read the list rows: the DOM side only collects candidate row nodes and their
   * text, the parsing happens in Node via `parseRowText`.
   *
   * Why split: row text parsing is the part that has to be correct (flight info,
   * 「¥X起」, 往返总价, 余票) and it must be testable offline — a `page.evaluate`
   * callback cannot be unit tested because it runs inside the browser. This way
   * one exported pure function is the single implementation for both single-trip
   * and round-trip rows.
   *
   * Best effort by design: any selector failure yields `[]` and the caller then
   * degrades to the single expanded row.
   */
  async function readRowList(page) {
    try {
      const texts = await page.evaluate(({ selectors, maxRows }) => {
        const cap = Math.max(1, Math.min(30, Number(maxRows) || 25));
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const plausiblyARow = (node) => {
          if (!node || !node.querySelector) return false;
          const text = node.innerText || '';
          if (!/¥\s?\d{2,6}/.test(text)) return false;
          const books = node.querySelectorAll('.btn-book').length;
          if (books === 1) return true;
          // A wrapper that holds several book buttons is the list, not a row.
          if (books > 1) return false;
          // Round-trip rows: no 订票 button, but they do carry 「选为去程」.
          return /选为去程|选择去程|订票|预订/.test(text) && text.length < 1200;
        };
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
          for (const button of document.querySelectorAll('.btn-book')) {
            let node = button;
            for (let depth = 0; depth < 8 && node && node.parentElement; depth += 1) {
              node = node.parentElement;
              const text = node.innerText || '';
              if (/¥\s?\d{2,6}/.test(text) && text.length < 900 && node.querySelectorAll('.btn-book').length === 1) {
                if (!seen.has(node)) {
                  seen.add(node);
                  nodes.push(node);
                }
                break;
              }
            }
          }
        }
        // 标记 data-pw-row 供后续「展开/点选这一行」使用；返回文本，解析在 Node 侧。
        return nodes.slice(0, cap).map((node, index) => {
          try {
            node.setAttribute('data-pw-row', String(index));
          } catch {
            /* cosmetic */
          }
          return { rowIndex: index, text: norm(node.innerText) };
        });
      }, { selectors: ROW_SELECTORS, maxRows: READ_ROWS });
      return (Array.isArray(texts) ? texts : [])
        .map(({ rowIndex, text }) => ({ rowIndex, ...parseRowText(text) }))
        .filter((row) => row.listPrice > 0);
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
        const button = row && row.querySelector('.btn-book');
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
        const button = document.querySelector('.btn-book');
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
      for (const button of row.querySelectorAll('.btn-book')) {
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

  /**
   * 读「当前已经在预订页」的页面：机建/燃油拆分 + 订单总价（真正的待支付价）。
   * 只读文本、不点任何东西；读不到返回 null（调用方决定兜底）。
   */
  async function readBookingPage(page) {
    try {
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
          orderTotal: pick(/(?:总价|合计|应付|应付总额|订单总额)[^¥]{0,12}¥?\s*(\d{1,5})/),
          sawBooking: /乘机人|证件|订单填写|去支付|填写订单/.test(text),
        };
      }).catch(() => null);
      if (!info || !info.sawBooking) return null;
      const orderTotal = Number.isFinite(info.orderTotal) && info.orderTotal > 0 ? info.orderTotal : null;
      return { tax: taxFromOrderInfo(info), orderTotal };
    } catch (error) {
      logger.warn('读取预订页总价失败', error);
      return null;
    }
  }

  /**
   * 单程流程用：点开当前展开行的预订页 → 读税费/订单总价 → 回到列表页。
   * Best effort：任何失败都返回 null，交回调用方按估算兜底。
   */
  async function readOrderInfo(page) {
    try {
      const navigated = page.waitForNavigation({ timeout: 18000 }).catch(() => null);
      await page.evaluate(() => {
        const row = document.querySelector('.flight-item.active');
        const button = row && [...row.querySelectorAll('.btn-book')].find((b) => /预订/.test(b.textContent || ''));
        if (button) {
          button.scrollIntoView({ block: 'center' });
          button.click();
        }
      });
      await navigated;
      await page.waitForTimeout(4500);
      const order = await readBookingPage(page);
      await page.goBack({ timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(1500);
      if (!order) {
        logger.info('订单页没读到（未看到乘机人/去支付等标记），含税价改用估算');
        return null;
      }
      if (!order.tax) logger.info('订单页没有解析出机建燃油费，含税价改用估算');
      return order;
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
        const bookButtons = scope.querySelectorAll('.btn-book').length;
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

  // #region list-page pipeline (shared by single-trip and both round legs)
  /**
   * 打开一个列表页并跑完「滚动加载 → 读行 → 展开 TOP_N → 读预订页税费」的全流程。
   *
   * 单程监控、以及往返监控里的「去程单买 / 回程单买」两段，都复用这里；这样
   * 三条路径的「列表价 → 待支付价」口径完全一致。
   *
   * @returns {Promise<{flights:Array, tax:object|null, orderTotal:number|null, rows:Array}>}
   */
  async function collectListFlights(page, url, passengers, paxCount, { signal } = {}) {
    if (signal?.aborted) throw new Error('已取消');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForFlights(page);
    // Human pacing: look at the list for a few seconds before touching it.
    await dwell(page);

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
    const order = await readOrderInfo(page);
    const tax = order?.tax ?? null;
    const feesTotal = tax && Number.isFinite(tax.total) ? tax.total : null;

    // Step 4 — flight objects, cheapest payable first.
    const flights = single
      ? [flightOf({}, single, feesTotal)]
      : targets.map((row) => flightOf(row, expanded.get(row.rowIndex) || null, feesTotal));
    flights.sort(payableOrder);
    return { flights, tax, orderTotal: order?.orderTotal ?? null, rows };
  }
  // #endregion

  // #region round-trip scheme (D10)
  /** 风控/登录失效是「整轮失败」，不能被当成某个子方案降级掉。 */
  function isFatal(error) {
    return error instanceof BlockedError
      || error instanceof AuthError
      || error?.code === 'BLOCKED'
      || error?.code === 'AUTH_REQUIRED';
  }

  /** 列表行里的航班静态信息（联程/回程快照用）。 */
  function pickFlightInfo(row) {
    return {
      flightNo: row.flightNo || '',
      airline: row.airline || '',
      craft: row.craft || '',
      depTime: row.depTime || '',
      arrTime: row.arrTime || '',
      depAirport: row.depAirport || '',
      arrAirport: row.arrAirport || '',
      listPrice: Number(row.listPrice) || 0,
      seats: Number.isInteger(row.seats) ? row.seats : null,
      soldOut: row.soldOut === true,
    };
  }

  /**
   * 在指定行里点一个「文字动作」按钮，例如往返列表的「选为去程」。
   * 只点文本匹配的最小节点，避免把整块行容器点掉。
   */
  async function clickRowAction(page, rowIndex, pattern) {
    try {
      return await page.evaluate(({ idx, source }) => {
        const re = new RegExp(source);
        const row = Number.isInteger(idx) && idx >= 0 ? document.querySelector('[data-pw-row="' + idx + '"]') : null;
        const scopes = row ? [row, document] : [document];
        for (const scope of scopes) {
          const candidates = [...scope.querySelectorAll('button, a, span, div')];
          const target = candidates.find((element) => {
            const text = (element.textContent || '').trim();
            return text.length > 0 && text.length <= 12 && re.test(text) && element.children.length === 0;
          });
          if (target) {
            target.scrollIntoView({ block: 'center' });
            target.click();
            return true;
          }
        }
        return false;
      }, { idx: rowIndex, source: pattern });
    } catch {
      return false;
    }
  }

  /** 点某一行的预订按钮（回程选择页用，通常会跳到预订页）。 */
  async function clickRowBook(page, rowIndex) {
    try {
      return await page.evaluate((idx) => {
        const row = Number.isInteger(idx) && idx >= 0 ? document.querySelector('[data-pw-row="' + idx + '"]') : null;
        const button = row && row.querySelector('.btn-book');
        if (!button) return false;
        button.scrollIntoView({ block: 'center' });
        button.click();
        return true;
      }, rowIndex);
    } catch {
      return false;
    }
  }

  /** 点页面上第一个预订按钮（选择器降级时兜底）。 */
  async function clickFirstBook(page) {
    try {
      return await page.evaluate(() => {
        const button = document.querySelector('.btn-book');
        if (!button) return false;
        button.scrollIntoView({ block: 'center' });
        button.click();
        return true;
      });
    } catch {
      return false;
    }
  }

  /** 等页面变成「航班列表」或「预订页」二选一（选为去程之后不知道会到哪一步）。 */
  async function waitForListOrBooking(page, timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await page.waitForTimeout(800);
      const state = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return {
          rows: document.querySelectorAll('.btn-book').length,
          booking: /乘机人|证件|订单填写|去支付|填写订单/.test(text),
        };
      }).catch(() => ({ rows: 0, booking: false }));
      if (state.booking || state.rows > 0) return true;
    }
    return false;
  }

  /**
   * 从回程列表走到预订页：先点选中那一行，必要时再点一次「下一步/预订」。
   * 携程的往返流程可能是两步（选回程 → 预订）也可能直接跳预订页，所以这里按
   * 「页面上有没有乘机人/去支付」判断，最多点两次，不无限试探。
   */
  async function advanceToBooking(page, rowIndex, { steps = 2 } = {}) {
    const onBooking = async () => page.evaluate(() => /乘机人|证件|订单填写|去支付|填写订单/.test(document.body.innerText || '')).catch(() => false);
    for (let step = 0; step < steps; step += 1) {
      if (await onBooking()) return true;
      const navigated = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
      const clicked = step === 0 && Number.isInteger(rowIndex) && rowIndex >= 0
        ? await clickRowBook(page, rowIndex)
        : await clickFirstBook(page);
      await navigated;
      await page.waitForTimeout(2500 + Math.floor(Math.random() * 1500));
      if (!clicked) return false;
    }
    return onBooking();
  }

  /**
   * 联程方案（D10）：往返列表页 → 取「往返总价（起）」最低的一行 → 点「选为去程」
   * → 回程列表选最便宜的一行 → 预订页读**待支付总价**。
   *
   * Best effort：只要拿到列表行就算成功——预订页读不到总价时用列表「¥X起 往返
   * 总价」兜底，并把 `payableSource` 标成 `'list'`，让上层能给出 partial 结果而
   * 不是整轮失败。
   */
  async function collectRoundScheme(page, monitor, { signal } = {}) {
    const params = monitor?.params || {};
    if (signal?.aborted) throw new Error('已取消');
    await page.goto(roundListUrl({
      dep: params.dep,
      arr: params.arr,
      departDate: params.departDate,
      returnDate: params.returnDate,
      cabin: params.cabin,
    }), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForFlights(page);
    await dwell(page);
    await loadRowWindow(page);

    const rows = await readRowList(page);
    const roundRows = rows.filter((row) => row.isRoundRow || row.roundTotal != null);
    const pool = roundRows.length ? roundRows : rows;
    if (pool.length === 0) throw new Error('往返列表没有解析到航班行');
    const cheapest = pool.slice().sort((a, b) => a.listPrice - b.listPrice)[0];
    const outbound = pickFlightInfo(cheapest);

    // 点「选为去程」进入选回程/预订流程。找不到按钮说明页面结构变了：抛错让上层降级。
    const selected = await clickRowAction(page, cheapest.rowIndex, '选为去程|选择去程|选为去程航班');
    if (!selected) throw new Error('没有找到「选为去程」按钮');
    await waitForListOrBooking(page);

    // 回程页：滚动加载 → 取最便宜的一行 → 点进预订页。失败不致命（总价也许已经能读到）。
    let ret = null;
    try {
      await waitForFlights(page);
      await loadRowWindow(page);
      const backRows = await readRowList(page);
      const backCheapest = backRows.slice().sort((a, b) => a.listPrice - b.listPrice)[0] || null;
      if (backCheapest) {
        ret = pickFlightInfo(backCheapest);
        await advanceToBooking(page, backCheapest.rowIndex);
      } else {
        await advanceToBooking(page, null);
      }
    } catch (error) {
      if (isFatal(error)) throw error;
      logger.warn(`联程回程选择失败，尝试直接读当前页总价: ${String(error?.message || error)}`);
    }

    const order = await readBookingPage(page);
    const orderTotal = order?.orderTotal ?? null;
    const listTotal = Number(cheapest.listPrice) || 0;
    return {
      listTotal,
      // 待支付价：预订页总价优先；读不到才退回列表「往返总价（起）」并标注。
      payable: orderTotal ?? listTotal,
      payableSource: orderTotal !== null ? 'order' : 'list',
      ...outbound,
      return: ret,
    };
  }

  /**
   * 往返监控的一次采集：三组动作各自独立降级（D10）。
   *
   *  - 联程：往返列表 → 预订页总价；
   *  - 去程单买 / 回程单买：现有单程列表流程各跑一次。
   * 任一组普通失败只记录到 `errors`（并在快照里标 partial）；风控/登录失效直接
   * 抛出，交给调度器的安全阀处理。
   */
  async function collectRoundTrip(monitor, page, passengers, paxCount, { signal } = {}) {
    const params = monitor?.params || {};
    const errors = { round: null, out: null, back: null };
    const attempt = async (key, run) => {
      try {
        return await run();
      } catch (error) {
        if (isFatal(error)) throw error;
        errors[key] = String(error?.message || error);
        logger.warn(`往返方案「${key}」失败，降级继续: ${errors[key]}`);
        return null;
      }
    };

    const round = await attempt('round', () => collectRoundScheme(page, monitor, { signal }));
    const out = await attempt('out', () => collectListFlights(
      page,
      onewayListUrl({ dep: params.dep, arr: params.arr, date: params.departDate, cabin: params.cabin }),
      passengers,
      paxCount,
      { signal },
    ));
    const back = await attempt('back', () => collectListFlights(
      page,
      onewayListUrl({ dep: params.arr, arr: params.dep, date: params.returnDate, cabin: params.cabin }),
      passengers,
      paxCount,
      { signal },
    ));

    return combineRoundSchemes({ monitor, passengers, round, out, back, errors });
  }
  // #endregion

  /**
   * Collect one monitor with the browser.
   *
   * 单程监控：完全沿用 D10 之前的流程（D10 只是把列表页那段抽成
   * `collectListFlights`，输入输出不变）。
   * 往返监控：三组动作（联程 / 去程单买 / 回程单买）各自降级后合成对比。
   *
   * @returns {Promise<{points:Array<object>, flights:Array<object>, tax:object|null,
   *                    lowest:{flightNo:string,total:number,scheme?:string},
   *                    roundTrip?:object}>}
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

        const passengers = (monitor.passengerIds || []).map((id) => store.findPassenger(id)).filter(Boolean);
        if (passengers.length === 0) throw new Error('监控没有有效乘客');
        const paxCount = passengers.length;

        // D10：往返监控走三组动作；单程监控走下面的原流程（一行都没动）。
        if (params.trip === 'round') return await collectRoundTrip(monitor, page, passengers, paxCount, { signal });

        const { flights, tax } = await collectListFlights(page, listUrl(monitor), passengers, paxCount, { signal });
        const feesTotal = tax && Number.isFinite(tax.total) ? tax.total : null;
        const taxSource = feesTotal !== null ? 'order' : 'estimate';

        // 单程：整体最低 + 每位乘客一条点（其最便宜的一行）。
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
