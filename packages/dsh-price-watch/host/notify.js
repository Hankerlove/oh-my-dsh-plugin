/**
 * Feishu card payloads (A2.2 spec §3 / 卡片重做 2026-11-20).
 *
 * Two channels share these builders:
 *   app      a self-built app uploads the rendered PNG (`host/chart.js` +
 *            `host/feishu.js`) and then posts the card through `im/v1/messages`;
 *   webhook  a custom bot receives `{ msg_type:'interactive', card }` on its URL
 *            (`sendFeishu` below) and therefore gets the same card **without** the
 *            `img` element — a custom bot cannot attach an image.
 *
 * The card is one self-contained message instead of「标题 + 图 + 几行文字」:
 *
 *   header   `价格监控 · 北京 → 上海（日期待定）`，主题色跌绿/涨红/平蓝
 *   hero     「当前最低实价 ¥1,099」大号数字 + 「比上次 -3.7%」同屏、同色系
 *   对比     往返：「联程组合 ¥X」vs「两段单买 ¥Y」+ 谁更便宜、省多少 + 部分数据提示
 *   航班     去程/可选航班 TOP3（航司简称 + 航班号 + 时刻 + 实价），航班号缺失就退到航司/时刻
 *   走势     `renderTrendPng` 生成的真 PNG（绿=最低 红=最高，每个采集点一个圆点）
 *   footer   采集时间（Host 本地时区）+ 口径
 *
 * 不变式（改这个文件时别破）：
 *  - **没有按钮/action**，**没有字符画**：卡片是报表，不是导航入口；
 *  - 所有 `build*Card` **永不抛**：脏数据只让卡片降级为一句纯文本，不能阻断投递；
 *  - 投递只尝试一次（spec §5），失败由调用方记进 `state.delivery`，这里不重试；
 *  - 口径统一叫「实价」（= 订单页待支付价 / 含机建燃油），日历模式明确标「估算」。
 */
import { CITY_NAMES, monthDay } from './util.js';
import {
  INK,
  TEMPLATE,
  cardShell,
  divText,
  flightName,
  flightNo,
  flightTable,
  flightWindow,
  footer,
  image,
  markdown,
  money,
  priceHero,
  schemeCompare,
  airlineShort,
} from './card.js';

/** How many days of the calendar the card image shows. */
const CALENDAR_SPARK_DAYS = 30;
/** How many cheapest flights the watch card lists. */
const WATCH_TOP_N = 3;
/** 实价口径（自建应用读的是订单页总价，含机建燃油）。 */
const PRICE_SPEC_WATCH = '实价=待支付价（含机建燃油）';
/** 日历模式是 L1 公开日历价，不是能下单的实价，必须写清楚。 */
const PRICE_SPEC_CALENDAR = '日历最低含税价（估算）';

/** `12-03` for a YYYY-MM-DD string. */
function shortDay(dateString) {
  const parts = String(dateString || '').split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : '';
}

/** `北京 → 上海` / `北京 ⇄ 上海`；城市码缺失时返回空串（调用方据此省掉这一段）。 */
function routeLabel(monitor) {
  const params = monitor?.params || {};
  const name = (code) => CITY_NAMES[code] || String(code || '').trim();
  const dep = name(params.dep);
  const arr = name(params.arr);
  if (!dep || !arr) return '';
  return params.trip === 'round' ? `${dep} ⇄ ${arr}` : `${dep} → ${arr}`;
}

/** 摘要前缀：`上海 ⇄ 深圳 实价 ¥2,500`；航线不可读时只写结论。 */
function withRoute(monitor, text) {
  const route = routeLabel(monitor);
  return route ? `${route} ${text}` : text;
}

/** `杭州 → 上海（11月25日）` 这一段；航线不可读时整段省略。 */
function whereLabel(monitor) {
  const route = routeLabel(monitor);
  if (!route) return '';
  if (monitor?.mode === 'calendar') return `${route}（日期待定）`;
  const params = monitor?.params || {};
  const depart = monthDay(params.departDate);
  if (params.trip === 'round') {
    const back = monthDay(params.returnDate);
    return `${route}（${depart}${back ? `–${back}` : ''}）`;
  }
  return `${route}（${depart}）`;
}

/**
 * Card heading in the spec's wording:
 * `价格监控 · 北京 → 上海（日期待定）` or `价格监控 · 北京 → 上海（11月25日）`.
 * The stored monitor title uses `·` separators; the card needs the parenthesised
 * form, so it is rebuilt from params instead of patching the title string.
 */
function cardHeading(monitor) {
  const where = whereLabel(monitor);
  return where ? `价格监控 · ${where}` : '价格监控';
}

/** header 右侧的模式标签（行情 / 单程监控 / 往返监控）。 */
function modeTag(monitor) {
  if (monitor?.mode === 'calendar') return { text: '行情', color: 'blue' };
  return monitor?.params?.trip === 'round' ? { text: '往返监控', color: 'blue' } : { text: '单程监控', color: 'blue' };
}

/**
 * 涨跌结构化：
 *   `{ dir:'down', diff:-38, pct:-3.7, text:'比上次 -3.7%', previous:1142 }`
 *   `{ dir:'flat', diff:0, pct:0, text:'与上次持平', previous:1142 }`
 * 拿不到上一次价格时返回 `null`（卡片就只显示价格，不编造对比）。
 */
export function deltaParts(current, previous) {
  const now = Number(current);
  const before = Number(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
  const diff = Math.round(now) - Math.round(before);
  if (diff === 0) return { dir: 'flat', diff: 0, pct: 0, text: '与上次持平', previous: before };
  const pct = ((now - before) / before) * 100;
  const sign = pct > 0 ? '+' : '';
  return { dir: pct > 0 ? 'up' : 'down', diff, pct, text: `比上次 ${sign}${pct.toFixed(1)}%`, previous: before };
}

/** 一句话版涨跌（保留给日志/调试与旧调用方）。 */
export function deltaLine(current, previous) {
  const delta = deltaParts(current, previous);
  if (!delta) return null;
  if (delta.dir === 'flat') return `与上次持平（${money(delta.previous)}）`;
  return `${delta.text}（上次 ${money(delta.previous)}）`;
}

/** 跌绿、涨红、平蓝（沿用旧 `templateFor` 的语义）；未知时蓝。 */
function templateFor(diff) {
  if (diff === null || diff === undefined) return TEMPLATE.flat;
  if (diff < 0) return TEMPLATE.down;
  if (diff > 0) return TEMPLATE.up;
  return TEMPLATE.flat;
}

/** 与 `templateFor` 同语义的文字颜色：跌用绿、涨用红、平/未知用蓝。 */
function inkFor(dir) {
  if (dir === 'down') return INK.down;
  if (dir === 'up') return INK.up;
  return INK.flat;
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

/** `2026-11-18 10:53` in the Host's local timezone (a UTC stamp would confuse). */
function localStamp(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `东方 MU5332 07:15→09:45` / `春秋 07:30→10:10`（逐级省略缺失字段）。 */
function flightInline(flight) {
  return [airlineShort(flight?.airline), flightNo(flight), flightWindow(flight)].filter(Boolean).join(' ');
}

/** 实价升序的前 N 个航班（采集器已经排过，这里再兜一次，防止上游改顺序）。 */
function topFlights(flights, limit = WATCH_TOP_N) {
  return (Array.isArray(flights) ? flights : [])
    .filter((flight) => money(flight?.taxIncluded))
    .sort((a, b) => Number(a.taxIncluded) - Number(b.taxIncluded))
    .slice(0, limit);
}

/**
 * 走势图块：说明 + PNG。没有 `imageKey`（webhook 通道 / 上传失败 / 点数不足）
 * 时整块省略——不写「图片加载失败」这类占位，卡片其余部分照常可读。
 */
function trendBlock(imageKey, caption) {
  const picture = image(imageKey, caption || '价格走势');
  if (!picture) return [];
  const out = [];
  if (caption) out.push(divText(caption, { color: INK.muted, size: 'notation' }));
  out.push(picture);
  return out;
}

/**
 * 卡片构造自身出问题（脏快照、字段类型异常）时的兜底：一句纯文本，绝不抛。
 * 这里连标题都要再包一层，因为 `cardHeading` 也在同一个 try 里失败过。
 */
function degradedCard(monitor) {
  let title = '价格监控';
  try {
    title = cardHeading(monitor) || title;
  } catch {
    /* keep the default title */
  }
  try {
    return cardShell({
      template: TEMPLATE.flat,
      title,
      summary: '价格监控 · 本次卡片降级为纯文本',
      elements: [divText('本次卡片构造降级为纯文本，采集结果已正常保存。', { color: INK.muted })],
    });
  } catch {
    return { schema: '2.0', config: { compact_width: false }, body: { elements: [] } };
  }
}

/**
 * Calendar-mode card (spec §3 行情).
 *
 * 单程：`未来 30 天最低价 ¥498` + 涨跌 + 最低日 + 走势图。
 * 往返：主视觉是去程最低价，回程最低价单列一行（L1 的两段相加只是估算，
 * 不合并成一个「联程价」，避免和监控模式的实价口径混在一起）。
 *
 * @param {{ monitor: object, out: Array<{date:string,total:number}>, back?: Array|null,
 *           previous?: { out?: number|null, back?: number|null }|null, imageKey?: string|null,
 *           at?: string }} input
 */
export function buildCalendarCard({ monitor, out, back, previous, imageKey, at } = {}) {
  try {
    const forward = Array.isArray(out) ? out : [];
    const backward = Array.isArray(back) ? back : [];
    const shown = shownRows(forward);
    const forwardLowest = cheapestOf(forward);
    const backLowest = cheapestOf(backward);
    const round = monitor?.params?.trip === 'round';
    const price = money(forwardLowest?.total);
    const delta = deltaParts(forwardLowest?.total, Number(previous?.out));
    const elements = [];

    if (price) {
      elements.push(priceHero({
        label: round ? '去程最低价 · 未来 30 天' : '未来 30 天最低价',
        price,
        // 有对比才上「涨红跌绿」，第一次采集没有上次价格就用中性深色。
        priceColor: delta ? inkFor(delta.dir) : INK.neutral,
        delta: delta?.text,
        deltaColor: inkFor(delta?.dir),
        previous: delta ? `上次 ${money(delta.previous)}` : null,
      }));
    } else {
      elements.push(divText('本次没有采到日历报价', { color: INK.muted }));
    }

    const notes = [];
    if (forwardLowest) notes.push(`最低日 ${shortDay(forwardLowest.date)}`);
    if (round) {
      notes.push(backLowest
        ? `回程最低 ${money(backLowest.total)}（${shortDay(backLowest.date)}）`
        : '回程暂无可比报价');
    }
    if (notes.length > 0) elements.push(divText(notes.join('\n'), { color: INK.muted, size: 'notation' }));

    const range = rangeLabel(shown);
    elements.push(...trendBlock(
      imageKey,
      `未来 30 天最低价走势${range ? `（${range}）` : ''} · 绿=最低 红=最高`,
    ));
    elements.push(...footer({ at: localStamp(at), priceSpec: PRICE_SPEC_CALENDAR }));

    const summary = price
      ? withRoute(monitor, `${round ? '去程最低' : '未来 30 天最低'} ${price}`)
      : withRoute(monitor, '本次未采到日历报价');

    return cardShell({
      template: templateFor(delta?.diff ?? null),
      title: cardHeading(monitor),
      summary,
      tags: [modeTag(monitor)],
      elements,
    });
  } catch {
    return degradedCard(monitor);
  }
}

/**
 * Watch-mode card (spec §3 监控 + D10 往返联程).
 *
 * 主视觉是「当前最低实价」，往返再加一块「联程组合 vs 两段单买」的对比和
 * 部分数据提示；航班表只列实价最低的 3 个。
 *
 * @param {{ monitor: object, lowest?: {flightNo:string,total:number,scheme?:string}|null,
 *           lowestFlight?: object|null, previous?: number|null, flights?: Array<object>,
 *           roundTrip?: object|null, imageKey?: string|null, at?: string }} input
 */
export function buildWatchCard({ monitor, lowest, lowestFlight, previous, flights, roundTrip, imageKey, at } = {}) {
  try {
    const current = Number(lowest?.total);
    const price = money(current);
    const delta = deltaParts(current, previous);
    const scheme = lowest?.scheme === 'round' || lowest?.scheme === 'oneway' ? lowest.scheme : null;
    const schemeLabel = scheme === 'round' ? '联程组合' : scheme === 'oneway' ? '两段单买' : '';
    const elements = [];

    if (price) {
      elements.push(priceHero({
        label: `当前最低实价${schemeLabel ? ` · ${schemeLabel}` : ''}`,
        price,
        priceColor: delta ? inkFor(delta.dir) : INK.neutral,
        delta: delta?.text,
        deltaColor: inkFor(delta?.dir),
        previous: delta ? `上次 ${money(delta.previous)}` : null,
      }));
    } else {
      elements.push(divText('本次没有采到可用报价', { color: INK.muted }));
    }

    // 联程 / 两段单买：两个数字 + 结论 + 部分数据提示。
    if (roundTrip && typeof roundTrip === 'object') {
      elements.push(...schemeCompare({
        roundPayable: Number(roundTrip.round?.payable),
        onewaySum: Number(roundTrip.oneway?.sum),
        cheaper: roundTrip.comparison?.cheaper,
        diff: Number(roundTrip.comparison?.diff),
        partial: roundTrip.partial === true,
        missing: [
          roundTrip.round ? '' : '联程实价',
          roundTrip.oneway ? '' : '两段单买',
        ].filter(Boolean),
      }));
    }

    // 这个最低价对应哪一班。联程只写去程：对比的是价格，回程时刻没有信息量
    // （用户 2026-11-20 明确要求删掉「回程 MU5332 07:15→09:45」），
    // 两段航班详情看下面的航班表。
    const notes = [];
    const roundFlight = scheme === 'round' ? roundTrip?.round : null;
    if (roundFlight) {
      const outbound = flightInline(roundFlight);
      if (outbound) notes.push(['联程组合', outbound].filter(Boolean).join(' · '));
    } else {
      const replayed = lowestFlight
        || (Array.isArray(flights) ? flights.find((flight) => flight?.no && flight.no === lowest?.flightNo) : null);
      const label = flightInline(replayed);
      if (label) notes.push(`最低来自 ${label}`);
    }
    if (notes.length > 0) elements.push(divText(notes.join('\n'), { color: INK.muted, size: 'notation' }));

    const top = topFlights(flights);
    const table = flightTable(top);
    if (table) {
      elements.push(markdown(`**${monitor?.params?.trip === 'round' ? '去程航班' : '可选航班'} · 实价从低到高**`));
      elements.push(table);
    }

    elements.push(...trendBlock(imageKey, '最近 20 次采集最低实价走势 · 绿=最低 红=最高'));
    elements.push(...footer({ at: localStamp(at), priceSpec: PRICE_SPEC_WATCH }));

    const summary = price
      ? withRoute(monitor, `实价 ${price}${delta ? `，${delta.text}` : ''}`)
      : withRoute(monitor, '本次未采到可用报价');

    return cardShell({
      template: templateFor(delta?.diff ?? null),
      title: cardHeading(monitor),
      summary,
      tags: [modeTag(monitor)],
      elements,
    });
  } catch {
    return degradedCard(monitor);
  }
}

/** Failure card (spec §3 失败卡): no image, no price, still the same heading. */
export function buildFailureCard({ monitor, error, at } = {}) {
  try {
    const detail = String(error || '未知错误').slice(0, 300);
    return cardShell({
      template: TEMPLATE.failure,
      title: cardHeading(monitor),
      summary: withRoute(monitor, '本次采集失败'),
      tags: [modeTag(monitor)],
      elements: [
        divText(`本次采集失败：${detail}`, { color: INK.up }),
        divText('这一轮没有写入新价格，下一轮会按采集节奏继续。', { color: INK.muted, size: 'notation' }),
        ...footer({ at: localStamp(at) }),
      ],
    });
  } catch {
    return degradedCard(monitor);
  }
}

/**
 * Test card for `POST /notify/test` (spec §4). Deliberately image-free and
 * mentions the channel + target so the user can confirm where messages land.
 */
export function buildTestCard({ channel, chatId, webhook, at } = {}) {
  try {
    const channelLabel = channel === 'app' ? '企业自建应用机器人' : '自定义机器人 webhook';
    const target = channel === 'app'
      ? (chatId ? `目标群 ${chatId}` : '')
      : (webhook ? '目标：已配置的自定义机器人' : '');
    const elements = [divText(`投递通道：**${channelLabel}**`)];
    if (target) elements.push(divText(target, { color: INK.muted, size: 'notation' }));
    elements.push(divText('收到这条消息说明通道可用；正式卡片还会带价格主视觉与走势图（走势图仅自建应用通道）。', {
      color: INK.muted,
      size: 'notation',
    }));
    elements.push(...footer({ at: localStamp(at), atLabel: '发送' }));
    return cardShell({
      template: TEMPLATE.test,
      title: '价格监控 · 测试消息',
      summary: `价格监控测试 · ${channelLabel}`,
      elements,
    });
  } catch {
    return degradedCard({});
  }
}

/**
 * POST one card to a Feishu custom-bot webhook. **Exactly one attempt** (spec
 * §5: delivery is a single attempt) — a failure is reported to the caller, which
 * records it in `state.delivery` instead of retrying. Never throws.
 *
 * Custom bots cannot attach images, so this channel is text-only by nature;
 * `card` here is the same card object the app channel sends (it is built without
 * an `img` element when the channel is `webhook`).
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
