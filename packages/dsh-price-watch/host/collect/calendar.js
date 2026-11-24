/**
 * L1 collector: Ctrip's public lowest-price calendar.
 *
 * One POST covers 380 days of "lowest total price per departure date" for a
 * city pair. It needs no cookie and no signature — this is the cheapest and
 * most stable source, so it carries the daily trend while the browser collector
 * (M2) adds the exact per-fare prices.
 *
 * Verified 2026-11-16: SHA→BJS returns 380 rows, `price` is the bare fare and
 * `totalPrice` includes taxes and fees.
 */
import { parseCtripDate } from '../util.js';

const ENDPOINT = 'https://m.ctrip.com/restapi/soa2/15380/bjjson/FlightIntlAndInlandLowestPriceSearch';

const HEADERS = {
  'content-type': 'application/json',
  'user-agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  origin: 'https://m.ctrip.com',
  referer: 'https://m.ctrip.com/',
  accept: 'application/json, text/plain, */*',
};

/**
 * Fetch the calendar for one city pair starting at `startDate`.
 *
 * @returns {Promise<Map<string, { bare: number, total: number }>>} keyed by YYYY-MM-DD
 */
export async function fetchCalendar({ dep, arr, startDate, signal }) {
  const body = {
    departNewCityCode: dep,
    arriveNewCityCode: arr,
    startDate,
    grade: 3,
    flag: 1,
    channelName: 'FlightIntlOnline',
    searchType: 1,
    calendarSelections: [{ selectionType: 8, selectionContent: ['3'] }],
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw new Error(`机票日历接口 HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('机票日历接口返回的不是 JSON（可能被风控拦截）');
  }

  if (payload?.responseStatus?.Ack && payload.responseStatus.Ack !== 'Success') {
    throw new Error(`机票日历接口返回 ${payload.responseStatus.Ack}`);
  }

  const list = Array.isArray(payload?.priceList) ? payload.priceList : [];
  if (list.length === 0) throw new Error('机票日历接口返回空列表');

  const map = new Map();
  for (const item of list) {
    const date = parseCtripDate(item?.departDate);
    if (!date) continue;
    const total = Number(item?.totalPrice) || 0;
    const bare = Number(item?.price) || 0;
    if (total <= 0) continue;
    map.set(date, { bare: bare > 0 ? bare : total, total });
  }
  if (map.size === 0) throw new Error('该航线暂时没有可用报价');
  return map;
}
