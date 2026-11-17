/**
 * L1 collection routines and the collector registry.
 *
 * The V2 model has two L1 jobs, one per monitor mode:
 *
 *   calendar  fetch the whole 380-day lowest-price calendar (one request
 *             one-way, two for a round trip) and hand back a snapshot;
 *   watch     read the two rates the monitor is actually about (`departDate`,
 *             plus `returnDate` for a round trip) and hand back price points.
 *
 * Every `fetchCalendar` call passes the scheduler's `beforeL1` guard first: it
 * enforces the global minimum request gap and the daily budget. When the guard
 * refuses, `L1BudgetError` is thrown so the scheduler can skip quietly instead
 * of counting it as a failure.
 */
import { addDays, isoDate, isoNow } from '../util.js';
import { fetchCalendar } from './calendar.js';

/** Registered collectors; `l2` lives in `browser.js`. */
export const COLLECTORS = ['l1', 'l2'];

/** Raised when the daily L1 budget (or its global pause) refuses a request. */
export class L1BudgetError extends Error {
  constructor(message = '今日 L1 请求预算已用完') {
    super(message);
    this.name = 'L1BudgetError';
    this.code = 'L1_BUDGET';
  }
}

/** Run the scheduler guard; `false` means "do not call the endpoint". */
async function guard(beforeL1) {
  if (typeof beforeL1 !== 'function') return;
  const allowed = await beforeL1();
  if (allowed === false) throw new L1BudgetError();
}

/** The calendar always starts tomorrow: today's prices are already stale. */
export function calendarStartDate(now = new Date()) {
  return addDays(isoDate(now), 1);
}

/** `Map<date,{bare,total}>` → ascending `[{date,total,bare}]`, per contract §2. */
function toRows(calendar) {
  const rows = [];
  for (const [date, value] of calendar) {
    const total = Number(value?.total);
    if (!Number.isFinite(total) || total <= 0) continue;
    const bare = Number(value?.bare);
    rows.push({ date, total, bare: Number.isFinite(bare) && bare > 0 ? bare : total });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/**
 * Fetch the whole calendar for a calendar-mode monitor.
 *
 * @returns {Promise<{fetchedAt:string, out:Array<{date:string,total:number,bare:number}>, back:Array|null}>}
 */
export async function collectCalendar(monitor, { signal, beforeL1 } = {}) {
  const params = monitor?.params || {};
  const startDate = calendarStartDate();

  await guard(beforeL1);
  const forward = await fetchCalendar({ dep: params.dep, arr: params.arr, startDate, signal });

  let back = null;
  if (params.trip === 'round') {
    await guard(beforeL1);
    const backward = await fetchCalendar({ dep: params.arr, arr: params.dep, startDate, signal });
    back = toRows(backward);
  }

  return { fetchedAt: isoNow(), out: toRows(forward), back };
}

/**
 * Collect the L1 reference price of a watch monitor.
 *
 * - one-way: the calendar row for `params.departDate`
 * - round trip: forward + backward single fares summed, flagged as an estimate
 *   (the real through-fare needs the browser collector, see contract §7.2)
 *
 * @returns {Promise<Array<{at:string,src:string,key:{departDate:string,returnDate?:string},price:{bare:number,total:number}}>>}
 */
export async function collectMonitor(monitor, { signal, beforeL1 } = {}) {
  const params = monitor?.params || {};
  const at = isoNow();

  if (params.trip === 'round') {
    await guard(beforeL1);
    const forward = await fetchCalendar({ dep: params.dep, arr: params.arr, startDate: params.departDate, signal });
    await guard(beforeL1);
    const backward = await fetchCalendar({ dep: params.arr, arr: params.dep, startDate: params.returnDate, signal });
    const out = forward.get(params.departDate);
    const back = backward.get(params.returnDate);
    if (!out) throw new Error(`去程 ${params.departDate} 暂无价格`);
    if (!back) throw new Error(`返程 ${params.returnDate} 暂无价格`);
    return [
      {
        at,
        src: 'l1-est',
        key: { departDate: params.departDate, returnDate: params.returnDate },
        price: { bare: out.bare + back.bare, total: out.total + back.total },
      },
    ];
  }

  await guard(beforeL1);
  const calendar = await fetchCalendar({ dep: params.dep, arr: params.arr, startDate: params.departDate, signal });
  const point = calendar.get(params.departDate);
  if (!point) throw new Error(`出发日 ${params.departDate} 暂无价格`);
  return [
    {
      at,
      src: 'l1',
      key: { departDate: params.departDate },
      price: { bare: point.bare, total: point.total },
    },
  ];
}

/**
 * Cheap health probe used by the status view: one domestic route that always
 * has inventory. Failures are reported, never thrown to the caller.
 */
export async function probeL1({ signal } = {}) {
  const started = Date.now();
  try {
    const calendar = await fetchCalendar({ dep: 'SHA', arr: 'BJS', startDate: isoDate(), signal });
    return { id: 'l1', ok: true, days: calendar.size, ms: Date.now() - started, checkedAt: isoNow() };
  } catch (error) {
    return { id: 'l1', ok: false, error: String(error?.message || error), ms: Date.now() - started, checkedAt: isoNow() };
  }
}
