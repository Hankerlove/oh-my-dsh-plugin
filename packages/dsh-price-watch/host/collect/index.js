/**
 * Collector registry and the per-monitor collection routine.
 *
 * M1 ships exactly one collector (L1 calendar). The shape is deliberately a
 * small interface so M2 can register the browser collector without touching the
 * scheduler, the rules or the panel.
 */
import { isoNow } from '../util.js';
import { fetchCalendar } from './calendar.js';

export const COLLECTORS = ['l1'];

/**
 * Collect one price point for a monitor.
 *
 * - one-way: the calendar row for `params.departDate`
 * - round trip: forward + backward single fares summed, flagged as an estimate
 *   (the real through-fare needs the browser collector, see design §4.5)
 *
 * @returns {Promise<Array<{at:string,src:string,key:{departDate:string,returnDate?:string},price:{bare:number,total:number}}>>}
 */
export async function collectMonitor(monitor, { signal } = {}) {
  const params = monitor?.params || {};
  const at = isoNow();

  if (params.trip === 'round') {
    const [forward, backward] = await Promise.all([
      fetchCalendar({ dep: params.dep, arr: params.arr, startDate: params.departDate, signal }),
      fetchCalendar({ dep: params.arr, arr: params.dep, startDate: params.returnDate, signal }),
    ]);
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
 * Cheap health probe used by the settings/status view: one domestic route that
 * always has inventory. Failures are reported, never thrown to the caller.
 */
export async function probeL1({ signal } = {}) {
  const started = Date.now();
  try {
    const calendar = await fetchCalendar({ dep: 'SHA', arr: 'BJS', startDate: new Date().toISOString().slice(0, 10), signal });
    return { id: 'l1', ok: true, days: calendar.size, ms: Date.now() - started, checkedAt: isoNow() };
  } catch (error) {
    return { id: 'l1', ok: false, error: String(error?.message || error), ms: Date.now() - started, checkedAt: isoNow() };
  }
}
