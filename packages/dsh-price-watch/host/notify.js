/**
 * Outbound Feishu cards (A2 spec §2).
 *
 * One card per *collection attempt*, not per alert: a successful run pushes the
 * card for its mode, a failed run pushes a failure card carrying the reason.
 * Whether the card is actually sent is decided in `index.js` (sha1 idempotency,
 * one attempt only) — nothing in this file retries.
 *
 * Why the trend is a text sparkline and not a chart image: a Feishu custom-bot
 * webhook cannot embed a locally generated image — `img` elements need an
 * `img_key` produced by an upload API that requires tenant permissions a custom
 * bot does not have. So the trend is drawn with the unicode block ladder
 * `▁▂▃▄▅▆▇█`. Do not "improve" this into an image URL: it would silently render
 * as a broken placeholder.
 */
import { CITY_NAMES, monthDay } from './util.js';

/** The block ladder, lowest → highest. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
/** How many days of the calendar a card shows. */
const CALENDAR_SPARK_DAYS = 30;
/** How many collection points the watch trend shows. */
const WATCH_SPARK_POINTS = 20;
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

/**
 * `▁▂▃▂▅█▅▃…` — min/max scaled, one block per value. A flat series would divide
 * by zero, so it draws the middle block instead of an empty line.
 */
export function sparkline(values) {
  const numbers = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (numbers.length === 0) return '';
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  if (max === min) return BLOCKS[3].repeat(numbers.length);
  return numbers
    .map((value) => BLOCKS[Math.round(((value - min) / (max - min)) * (BLOCKS.length - 1))])
    .join('');
}

/** `比上次 -3.7%（上次 ¥540）` / `与上次持平（¥520）` / null when unknown. */
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
function templateFor(delta) {
  if (delta === null) return 'blue';
  if (delta < 0) return 'green';
  if (delta > 0) return 'red';
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

/**
 * One card, shared scaffolding: heading + body lines + a "查看详情" button that
 * deep-links to the standalone page (`#m=<id>` is honoured by host/page.js).
 */
function buildCard({ monitor, template, lines, panelUrl, buttonText }) {
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: lines.filter((line) => typeof line === 'string' && line.length > 0).join('\n') } },
  ];
  const base = String(panelUrl || '').replace(/#.*$/, '');
  if (base) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: String(buttonText || '查看详情').slice(0, 20) },
          url: `${base}#m=${encodeURIComponent(String(monitor?.id || ''))}`,
          type: 'primary',
        },
      ],
    });
  }
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template, title: { tag: 'plain_text', content: cardHeading(monitor).slice(0, 100) } },
      elements,
    },
  };
}

/**
 * The pieces of one calendar leg: the headline (its lowest price + date), the
 * delta against the previous run, the 30-day sparkline block and the cheapest
 * day *inside that window* (the headline lowest may sit outside the first 30
 * days, so annotating the window separately avoids a misleading duplicate).
 */
function calendarLegParts(rows, { label, previous, trendTitle }) {
  const cheapest = cheapestOf(rows);
  const shown = rows.slice(0, CALENDAR_SPARK_DAYS);
  const windowCheapest = cheapestOf(shown);
  const before = Number(previous);
  const diff = cheapest && Number.isFinite(before) && before > 0 ? cheapest.total - before : null;
  const delta = cheapest ? deltaLine(cheapest.total, previous) : null;
  const trend = [];
  if (shown.length >= 2) {
    trend.push(`${trendTitle}（${rangeLabel(shown)}）`);
    trend.push(sparkline(shown.map((row) => row.total)));
  }
  return {
    headline: cheapest ? `${label}${money(cheapest.total)} · ${shortDay(cheapest.date)}` : `${label}暂无报价`,
    diff,
    delta,
    trend,
    window: windowCheapest && shown.length >= 2 ? `图中最低 ${shortDay(windowCheapest.date)} ${money(windowCheapest.total)}` : null,
  };
}

/**
 * Calendar-mode card (spec §2.1). A round trip prints both legs' lowest prices
 * first (去程/回程 each one line), then their deltas and trends — the spec asks
 * for the two minima up front so the card is readable on a phone lock screen.
 *
 * @param {{ monitor: object, out: Array<{date:string,total:number}>, back?: Array|null,
 *           previous?: { out?: number|null, back?: number|null }|null, panelUrl?: string }} input
 */
export function buildCalendarCard({ monitor, out, back, previous, panelUrl }) {
  const forward = Array.isArray(out) ? out : [];
  const backward = Array.isArray(back) ? back : [];
  let firstDelta = null;

  if (monitor?.params?.trip === 'round') {
    const forwardParts = calendarLegParts(forward, {
      label: '去程最低 ',
      previous: previous?.out,
      trendTitle: '去程未来 30 天走势',
    });
    const backParts = calendarLegParts(backward, {
      label: '回程最低 ',
      previous: previous?.back,
      trendTitle: '回程未来 30 天走势',
    });
    firstDelta = forwardParts.diff;
    const lines = [
      forwardParts.headline,
      backParts.headline,
      forwardParts.delta ? `去程${forwardParts.delta}` : null,
      backParts.delta ? `回程${backParts.delta}` : null,
      ...forwardParts.trend,
      forwardParts.window,
      ...backParts.trend,
      backParts.window,
    ];
    return buildCard({ monitor, template: templateFor(firstDelta), lines, panelUrl, buttonText: '查看走势图' });
  }

  const forwardParts = calendarLegParts(forward, {
    label: '当前最低 ',
    previous: previous?.out,
    trendTitle: '未来 30 天走势',
  });
  firstDelta = forwardParts.diff;
  const lines = [forwardParts.headline, forwardParts.delta, ...forwardParts.trend, forwardParts.window];
  return buildCard({ monitor, template: templateFor(firstDelta), lines, panelUrl, buttonText: '查看走势图' });
}

/** `MF8561 08:00 大兴国际机场 → 10:10 浦东国际机场T2`, tolerating missing bits. */
function flightLabel(flight) {
  if (!flight) return '';
  const left = [flight.depTime, flight.depAirport].filter(Boolean).join(' ');
  const right = [flight.arrTime, flight.arrAirport].filter(Boolean).join(' ');
  const route = left || right ? `${left} → ${right}` : '';
  return [flight.no, route].filter(Boolean).join(' ');
}

/**
 * Watch-mode card (spec §2.2).
 *
 * @param {{ monitor: object, lowest?: {flightNo:string,total:number}|null,
 *           lowestFlight?: object|null, previous?: number|null,
 *           minSeries?: number[], flights?: Array<object>, panelUrl?: string }} input
 */
export function buildWatchCard({ monitor, lowest, lowestFlight, previous, minSeries, flights, panelUrl }) {
  const lines = [];
  const current = Number(lowest?.total);
  const before = Number(previous);
  // 卡片要显示「最低价那班」的时刻/机场：优先用调用方给的航班，退回按航班号匹配。
  const replayed = lowestFlight
    || (Array.isArray(flights) ? flights.find((flight) => flight?.no && flight.no === lowest?.flightNo) : null);
  const label = flightLabel(replayed);
  lines.push(`当前最低可订价 ${money(current)}${label ? ` · ${label}` : ''}`);

  const diff = Number.isFinite(current) && Number.isFinite(before) && before > 0 ? current - before : null;
  const delta = deltaLine(current, previous);
  if (delta) lines.push(delta);

  const series = (Array.isArray(minSeries) ? minSeries : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(-WATCH_SPARK_POINTS);
  if (series.length >= 2) {
    lines.push('最近 20 次采集走势');
    lines.push(sparkline(series));
  }

  const top = (Array.isArray(flights) ? flights : [])
    .filter((flight) => Number.isFinite(Number(flight?.taxIncluded)) && Number(flight.taxIncluded) > 0)
    .slice(0, WATCH_TOP_N);
  if (top.length > 0) {
    lines.push(`TOP${top.length}：${top.map((flight) => `${flight.no || '—'} ${money(flight.taxIncluded)}`).join(' / ')}`);
  }

  return buildCard({
    monitor,
    template: templateFor(diff),
    lines,
    panelUrl,
    buttonText: '查看详情',
  });
}

/** Failure card (spec §2.3); the same error twice in a row is only pushed once. */
export function buildFailureCard({ monitor, error, panelUrl }) {
  return buildCard({
    monitor,
    template: 'orange',
    lines: [`本次采集失败：${String(error || '未知错误').slice(0, 300)}`],
    panelUrl,
    buttonText: '查看详情',
  });
}

/**
 * POST one card to a Feishu webhook. **Exactly one attempt** (A2 spec §1.1:
 * "投递只尝试一次，禁止重试") — a failure is reported to the caller, which
 * records it in `state.delivery` instead of retrying. Never throws.
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
      body: JSON.stringify(card),
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
    logger?.warn?.(`飞书投递失败（不再重试）: ${error}`);
    return { ok: false, attempts: 1, error };
  } catch (error) {
    const message = String(error?.message || error);
    logger?.warn?.(`飞书投递失败（不再重试）: ${message}`);
    return { ok: false, attempts: 1, error: message };
  }
}
