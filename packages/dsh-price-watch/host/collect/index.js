/**
 * L1 collection: the public price calendar, and nothing else.
 *
 * Frequency model v2 splits collection by mode, not by budget:
 *
 *   calendar  (no date yet) → this file. One request for the whole 380-day
 *             lowest-price calendar, two for a round trip, snapshot only.
 *   watch     (date fixed)  → `browser.js` only (L2, the logged-in page).
 *             A watch monitor never calls the L1 endpoint: the calendar price
 *             is a different kind of number (lowest fare of the day, not the
 *             passenger's payable price), so mixing it into the series would
 *             draw a fake trend. That is why `collectMonitor` — the old L1
 *             reference collector — is gone rather than merely unused.
 *
 * `pace` is a politeness callback supplied by the scheduler: it awaits the
 * minimum gap between two Ctrip requests. It is not a budget: it never refuses
 * a request, because v2 has no quotas and no quiet window.
 */
import { addDays, isoDate, isoNow } from '../util.js';
import { fetchCalendar } from './calendar.js';

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

/** Let the caller space two requests; a no-op when no pacer was supplied. */
async function paceWith(pace) {
  if (typeof pace === 'function') await pace();
}

/**
 * Fetch the whole calendar for a calendar-mode monitor.
 *
 * @param {object} monitor
 * @param {{ signal?: AbortSignal, pace?: () => Promise<void> }} [options]
 * @returns {Promise<{fetchedAt:string, out:Array<{date:string,total:number,bare:number}>, back:Array|null}>}
 */
export async function collectCalendar(monitor, { signal, pace } = {}) {
  const params = monitor?.params || {};
  const startDate = calendarStartDate();

  await paceWith(pace);
  const forward = await fetchCalendar({ dep: params.dep, arr: params.arr, startDate, signal });

  let back = null;
  if (params.trip === 'round') {
    await paceWith(pace);
    const backward = await fetchCalendar({ dep: params.arr, arr: params.dep, startDate, signal });
    back = toRows(backward);
  }

  return { fetchedAt: isoNow(), out: toRows(forward), back };
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
