/**
 * Feishu card payloads (A2.2 spec §3).
 *
 * Two channels share these builders:
 *   app      a self-built app sends the card object through `im/v1/messages`
 *            after uploading the rendered PNG (`host/feishu.js` + `host/chart.js`);
 *   webhook  a custom bot receives `{ msg_type:'interactive', card }` on its URL
 *            (`sendFeishu` below) and therefore gets the text-only variant.
 *
 * The trend is a **real PNG**, not a text sparkline: A2.2 replaced the character
 * art with `renderTrendPng`, and the card builders accept the resulting
 * `imageKey`. There is deliberately no `action`/button element any more, and no
 * `#m=` deep link — the card is a report, not a navigation entry point.
 *
 * D10: a round-trip watch card also prints 「联程 ¥X / 两段单买 ¥Y / 谁省 Z」 from
 * the snapshot's `roundTrip`, plus a 「部分数据」 marker when one scheme is
 * missing — the two buying schemes are the whole point of that monitor.
 */
import { CITY_NAMES, monthDay } from './util.js';

/** How many days of the calendar the card image shows. */
const CALENDAR_SPARK_DAYS = 30;
/** How many cheapest flights the watch card lists. */
const WATCH_TOP_N = 3;

/** `¥1,234` or `—`. */
function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `¥${Math.round(n).toLocaleString('zh-CN')}` : '—';
}

/** `12-03` for a YYYY-MM-DD string. */
function shortDay(dateString) {
  const parts = String(dateString || '').split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : '';
}

/** `北京 → 上海` / `北京 ⇄ 上海`, unknown codes fall back to the raw code. */
function routeLabel(monitor) {
  const params = monitor?.params || {};
  const name = (code) => CITY_NAMES[code] || String(code || '');
  return params.trip === 'round' ? `${name(params.dep)} ⇄ ${name(params.arr)}` : `${name(params.dep)} → ${name(params.arr)}`;
}

/**
 * Card heading in the spec's wording:
 * `价格监控 · 北京 → 上海（日期待定）` or `价格监控 · 北京 → 上海（11月25日）`.
 * The stored monitor title uses `·` separators; the card needs the parenthesised
 * form, so it is rebuilt from params instead of patching the title string.
 */
function cardHeading(monitor) {
  const params = monitor?.params || {};
  const route = routeLabel(monitor);
  if (monitor?.mode === 'calendar') return `价格监控 · ${route}（日期待定）`;
  const depart = monthDay(params.departDate);
  if (params.trip === 'round') {
    const back = monthDay(params.returnDate);
    return `价格监控 · ${route}（${depart}${back ? `–${back}` : ''}）`;
  }
  return `价格监控 · ${route}（${depart}）`;
}

/** `比上次 -3.7%（上次 ¥540）` / `与上次持平（¥540）` / null when unknown. */
export function deltaLine(current, previous) {
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
  if (Math.round(now) === Math.round(before)) return `与上次持平（${money(before)}）`;
  const pct = ((now - before) / before) * 100;
  const sign = pct > 0 ? '+' : '';
  return `比上次 ${sign}${pct.toFixed(1)}%（上次 ${money(before)}）`;
}

/** Green when the price fell (good news), red when it rose, blue when unknown. */
function templateFor(diff) {
  if (diff === null || diff === undefined) return 'blue';
  if (diff < 0) return 'green';
  if (diff > 0) return 'red';
  return 'blue';
}

/** `11-18 → 12-17` for a list of rows sorted ascending. */
function rangeLabel(rows) {
  if (rows.length === 0) return '';
  return `${shortDay(rows[0].date)} → ${shortDay(rows[rows.length - 1].date)}`;
}

/** The lowest row of a calendar leg. */
function cheapestOf(rows) {
  let best = null;
  for (const row of rows) {
    const total = Number(row?.total);
    if (!Number.isFinite(total) || total <= 0) continue;
    if (!best || total < best.total) best = { date: row.date, total };
  }
  return best;
}

/** The last N rows the image shows for a calendar leg. */
function shownRows(rows) {
  return Array.isArray(rows) ? rows.slice(0, CALENDAR_SPARK_DAYS) : [];
}

/**
 * One card object: optional image + caption + markdown body.
 *
 * The image is inserted only when an `img_key` was uploaded; every builder still
 * produces a complete card when it was not, because a failed render/upload must
 * degrade to text instead of blocking the delivery (spec §5).
 */
function buildCard({ template, title, imageKey, caption, bodyLines }) {
  const elements = [];
  if (imageKey) {
    if (caption) elements.push({ tag: 'div', text: { tag: 'lark_md', content: caption } });
    elements.push({
      tag: 'img',
      img_key: imageKey,
      alt: { tag: 'plain_text', content: String(caption || '价格走势').slice(0, 100) },
      mode: 'fit_horizontal',
      preview: false,
    });
  }
  const body = (Array.isArray(bodyLines) ? bodyLines : []).filter((line) => typeof line === 'string' && line.length > 0);
  if (body.length > 0) elements.push({ tag: 'div', text: { tag: 'lark_md', content: body.join('\n') } });
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: String(title).slice(0, 100) } },
    elements,
  };
}

/**
 * Calendar-mode card (spec §3 行情).
 *
 * Single trip:
 *   **¥498** 当前最低 · 12-03 / 图中最低 12-03 ¥498 / 比上次 -3.7%（上次 ¥517）
 * Round trip prints both legs' minima first, then the forward trend image.
 *
 * @param {{ monitor: object, out: Array<{date:string,total:number}>, back?: Array|null,
 *           previous?: { out?: number|null, back?: number|null }|null, imageKey?: string|null }} input
 */
export function buildCalendarCard({ monitor, out, back, previous, imageKey }) {
  const forward = Array.isArray(out) ? out : [];
  const backward = Array.isArray(back) ? back : [];
  const shown = shownRows(forward);
  const forwardLowest = cheapestOf(forward);
  const backLowest = cheapestOf(backward);
  const previousForward = Number(previous?.out);
  const diff = forwardLowest && Number.isFinite(previousForward) && previousForward > 0
    ? forwardLowest.total - previousForward
    : null;
  const caption = shown.length >= 2
    ? `未来 30 天最低价走势（${rangeLabel(shown)}）`
    : '未来 30 天最低价走势';

  const body = [];
  if (monitor?.params?.trip === 'round') {
    body.push(forwardLowest ? `去程最低 ${money(forwardLowest.total)}（${shortDay(forwardLowest.date)}）` : '去程暂无报价');
    body.push(backLowest ? `回程最低 ${money(backLowest.total)}（${shortDay(backLowest.date)}）` : '回程暂无报价');
    if (forwardLowest) body.push(`图中最低 ${shortDay(forwardLowest.date)} ${money(forwardLowest.total)}`);
    const delta = deltaLine(forwardLowest?.total, previousForward);
    if (delta) body.push(`去程${delta}`);
  } else {
    if (forwardLowest) {
      body.push(`**${money(forwardLowest.total)}** 当前最低 · ${shortDay(forwardLowest.date)}`);
      body.push(`图中最低 ${shortDay(forwardLowest.date)} ${money(forwardLowest.total)}`);
    } else {
      body.push('本次没有采到日历报价');
    }
    const delta = deltaLine(forwardLowest?.total, previousForward);
    if (delta) body.push(delta);
  }

  return buildCard({
    template: templateFor(diff),
    title: cardHeading(monitor),
    imageKey: imageKey || null,
    caption,
    bodyLines: body,
  });
}

/** `MF8561 08:00 大兴国际机场 → 10:10 浦东国际机场T2`, tolerating missing bits. */
function flightLabel(flight) {
  if (!flight) return '';
  const left = [flight.depTime, flight.depAirport].filter(Boolean).join(' ');
  const right = [flight.arrTime, flight.arrAirport].filter(Boolean).join(' ');
  const route = left || right ? `${left} → ${right}` : '';
  return [flight.no, route].filter(Boolean).join(' · ');
}

/**
 * D10：往返监控的对比行。用户要的是「联程到手价 / 两段单买和 / 谁更便宜 / 差多少」，
 * 所以数字与结论必须同屏出现，而不是让读者自己算。
 *
 * @param {{round?:{payable?:number}|null, oneway?:{sum?:number}|null,
 *          comparison?:{cheaper?:string,diff?:number}|null, partial?:boolean}|null} roundTrip
 */
function roundSchemeLines(roundTrip) {
  if (!roundTrip || typeof roundTrip !== 'object') return [];
  const roundPayable = Number(roundTrip.round?.payable);
  const onewaySum = Number(roundTrip.oneway?.sum);
  const parts = [];
  if (Number.isFinite(roundPayable) && roundPayable > 0) parts.push(`联程 ${money(roundPayable)}`);
  if (Number.isFinite(onewaySum) && onewaySum > 0) parts.push(`两段单买 ${money(onewaySum)}`);
  const lines = [];
  if (parts.length > 0) {
    let text = parts.join(' / ');
    const comparison = roundTrip.comparison;
    if (comparison && comparison.cheaper === 'tie') {
      text += ' / 两者持平';
    } else if (comparison && Number.isFinite(Number(comparison.diff)) && Number(comparison.diff) > 0) {
      const winner = comparison.cheaper === 'round' ? '联程' : '两段单买';
      text += ` / ${winner}省 ${money(comparison.diff)}`;
    }
    lines.push(text);
  }
  if (roundTrip.partial === true) {
    const missing = [];
    if (!roundTrip.round) missing.push('联程到手价');
    if (!roundTrip.oneway) missing.push('两段单买');
    lines.push(`（部分数据：缺 ${missing.length ? missing.join('、') : '完整到手价'}）`);
  }
  return lines;
}

/**
 * Watch-mode card (spec §3 监控).
 *
 * @param {{ monitor: object, lowest?: {flightNo:string,total:number}|null,
 *           lowestFlight?: object|null, previous?: number|null,
 *           flights?: Array<object>, imageKey?: string|null }} input
 */
export function buildWatchCard({ monitor, lowest, lowestFlight, previous, flights, roundTrip, imageKey }) {
  const current = Number(lowest?.total);
  const before = Number(previous);
  // D10：往返监控的最低价值得说明来自哪种买法；联程时航班信息取联程的那一班。
  const scheme = lowest?.scheme === 'round' || lowest?.scheme === 'oneway' ? lowest.scheme : null;
  const roundFlight = scheme === 'round' && roundTrip?.round
    ? {
      no: roundTrip.round.flightNo || '',
      depTime: roundTrip.round.depTime || '',
      arrTime: roundTrip.round.arrTime || '',
      depAirport: roundTrip.round.depAirport || '',
      arrAirport: roundTrip.round.arrAirport || '',
    }
    : null;
  const replayed = roundFlight
    || lowestFlight
    || (Array.isArray(flights) ? flights.find((flight) => flight?.no && flight.no === lowest?.flightNo) : null);
  const label = flightLabel(replayed);
  const diff = Number.isFinite(current) && Number.isFinite(before) && before > 0 ? current - before : null;

  const body = [`**${money(current)}** 当前最低可订价${scheme ? ` · ${scheme === 'round' ? '联程' : '两段单买'}` : ''}`];
  body.push(...roundSchemeLines(roundTrip));
  if (label) body.push(label);
  const delta = deltaLine(current, previous);
  if (delta) body.push(delta);
  const top = (Array.isArray(flights) ? flights : [])
    .filter((flight) => Number.isFinite(Number(flight?.taxIncluded)) && Number(flight.taxIncluded) > 0)
    .slice(0, WATCH_TOP_N);
  if (top.length > 0) {
    body.push(`TOP${top.length}：${top.map((flight) => `${flight.no || '—'} ${money(flight.taxIncluded)}`).join(' / ')}`);
  }

  return buildCard({
    template: templateFor(diff),
    title: cardHeading(monitor),
    imageKey: imageKey || null,
    caption: '最近 20 次采集的最低可订价走势',
    bodyLines: body,
  });
}

/** Failure card (spec §3 失败卡): no image, pure markdown, same idempotency. */
export function buildFailureCard({ monitor, error }) {
  return buildCard({
    template: 'orange',
    title: cardHeading(monitor),
    imageKey: null,
    caption: '',
    bodyLines: [`本次采集失败：${String(error || '未知错误').slice(0, 300)}`],
  });
}

/** `2026-11-18 10:53` in the Host's local timezone (a UTC stamp would confuse). */
function localStamp(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Test card for `POST /notify/test` (spec §4). Deliberately image-free and
 * mentions the channel + target so the user can confirm where messages land.
 */
export function buildTestCard({ channel, chatId, webhook, at }) {
  const channelLabel = channel === 'app' ? '企业自建应用机器人' : '自定义机器人 webhook';
  const target = channel === 'app'
    ? `目标群：${chatId || '—'}`
    : `目标：${webhook ? '自定义机器人已配置' : '—'}`;
  const when = localStamp(at);
  return buildCard({
    template: 'blue',
    title: '价格监控 · 测试消息',
    imageKey: null,
    caption: '',
    bodyLines: [`投递通道：${channelLabel}`, target, `时间：${when}`],
  });
}

/**
 * POST one card to a Feishu custom-bot webhook. **Exactly one attempt** (spec
 * §5: delivery is a single attempt) — a failure is reported to the caller, which
 * records it in `state.delivery` instead of retrying. Never throws.
 *
 * Custom bots cannot attach images, so this channel is text-only by nature;
 * `card` here is the same card object the app channel sends.
 *
 * @returns {Promise<{ok:boolean, attempts:number, error?:string}>}
 */
export async function sendFeishu(webhook, card, { logger, signal } = {}) {
  const url = String(webhook || '').trim();
  if (!/^https:\/\//i.test(url)) return { ok: false, attempts: 1, error: '未配置有效的飞书 webhook' };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'interactive', card }),
      signal,
    });
    const text = await response.text().catch(() => '');
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      /* Feishu answers JSON; anything else is treated as a failure below */
    }
    const code = payload?.code ?? payload?.StatusCode ?? 0;
    if (response.ok && (code === 0 || code === undefined)) return { ok: true, attempts: 1 };
    const error = `HTTP ${response.status} ${String(text).slice(0, 120)}`;
    logger?.warn?.(`飞书 webhook 投递失败（不再重试）: ${error}`);
    return { ok: false, attempts: 1, error };
  } catch (error) {
    const message = String(error?.message || error);
    logger?.warn?.(`飞书 webhook 投递失败（不再重试）: ${message}`);
    return { ok: false, attempts: 1, error: message };
  }
}
