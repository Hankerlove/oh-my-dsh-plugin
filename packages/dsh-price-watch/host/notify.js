/**
 * Feishu card payloads (A2.2 spec §3 / 卡片重做 2026-11-20 晚 → V10 分块版).
 *
 * Two channels share these builders:
 *   app      a self-built app uploads the rendered PNG (`host/chart.js` +
 *            `host/feishu.js`) and then posts the card through `im/v1/messages`;
 *   webhook  a custom bot receives `{ msg_type:'interactive', card }` on its URL
 *            (`sendFeishu` below) and therefore gets the same card **without** the
 *            `img` element — a custom bot cannot attach an image.
 *
 * 卡片按用户 2026-11-20 的要求分块展示，四块之间用 `hr` 分隔：
 *
 *   header    `价格监控 · 北京 ⇄ 上海（12月01日–12月08日）`，主题色跌绿/涨红/平蓝
 *   结论      大号「当前最低实价」+ 涨跌 + 上次价格；往返再给「联程 vs 两段单买」
 *   走势      区块标题（写明横轴=日期 / 纵轴=实价）+ 带坐标轴的 PNG + 区间统计
 *   明细      最低价对应航班 / 联程组合表 / 两段单买拆分 / 可订航班表（含余票）
 *   采集信息  采集时间 / 采集频率 / 乘客数 / 数据状态，末行给口径
 *
 * 不变式（改这个文件时别破）：
 *  - **没有按钮/action**，**没有字符画**：卡片是报表，不是导航入口；
 *  - 所有 `build*Card` **永不抛**：脏数据只让卡片降级为一句纯文本，不能阻断投递；
 *  - 投递只尝试一次（spec §5），失败由调用方记进 `state.delivery`，这里不重试；
 *  - 口径统一叫「实价」（= 订单页待支付价 / 含机建燃油），日历模式明确标「估算」；
 *  - 拿不到的数字/字段整项省略，**绝不写** `—`、`N/A`、`未填写` 之类的占位。
 */
import { CITY_NAMES, monthDay } from './util.js';
import {
  INK,
  TEMPLATE,
  cardShell,
  comboTable,
  dateCell,
  dayTable,
  divText,
  fieldGrid,
  flightCell,
  flightNo,
  flightTable,
  flightWindow,
  image,
  inline,
  markdown,
  money,
  priceHero,
  rule,
  schemeCompare,
  sectionTitle,
  statLine,
  airlineShort,
} from './card.js';

/** How many cheapest flights the watch card lists. */
const WATCH_TOP_N = 3;
/** 日历卡片统一统计窗口（天）：主视觉 / 走势 / 低价日表都在这 30 天内。 */
const CARD_WINDOW_DAYS = 30;
/** 实价口径（自建应用读的是订单页总价，含机建燃油）。 */
const PRICE_SPEC_WATCH = '实价=待支付价（含机建燃油）';
/** 日历模式是 L1 公开日历价，不是能下单的实价，必须写清楚。 */
const PRICE_SPEC_CALENDAR = '日历最低含税价（估算）';
/** 走势图的纵轴单位（写在区块标题里，图内只画数字刻度）。 */
const AXIS_WATCH = '横轴 采集日期 · 纵轴 待支付实价（元）';
const AXIS_CALENDAR = '横轴 日期 · 纵轴 最低含税价（元）';
/**
 * 酒店监控：横轴是「采集日期」（不是入住日期），纵轴是当日最低**整段总价**。
 * 酒店没有「未来 30 天」这种窗口概念——走势就是全部历史采集点。
 */
const AXIS_HOTEL = '横轴 采集日期 · 纵轴 当日最低总价（元）';
/** 房型表最多展示几行，其余折成一行「另有 N 个房型未显示」。 */
const HOTEL_ROOM_LIMIT = 6;
/** 房型名超过这个字数会压垮表格：按字符截断（中文/emoji 不会被切坏）。 */
const HOTEL_ROOM_NAME_MAX = 14;

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

/** 日历里最便宜的 N 天（原数组是日期升序，这里按价格重排）。 */
function lowestDays(rows, limit = 4) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => money(row?.total))
    .slice()
    .sort((left, right) => Number(left.total) - Number(right.total))
    .slice(0, limit);
}

/** `每 6 小时` / `每 30 分钟` / `每 1 天`；缺失时返回空串。 */
function cadenceLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value === 1440) return '每 1 天';
  if (value % 60 === 0) return `每 ${value / 60} 小时`;
  return `每 ${value} 分钟`;
}

/** `2 位乘客` / 空串（乘客列表缺失时整项省略）。 */
function passengerLabel(monitor) {
  const count = Array.isArray(monitor?.passengerIds) ? monitor.passengerIds.length : 0;
  return count > 0 ? `${count} 位乘客` : '';
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
 * 走势序列的区间统计（`trend` 由 `index.js` 生成：`{values, labels}`，
 * 两者等长，labels 是 X 轴刻度文字）。点数不足 2 个时返回 `null`——
 * 一次采集没有「区间」可言，卡片就不写这一行。
 */
export function trendStats(trend) {
  const values = (Array.isArray(trend?.values) ? trend.values : []).map(Number).filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  const labels = Array.isArray(trend?.labels) ? trend.labels : [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const labelOf = (target) => {
    const index = values.indexOf(target);
    return index >= 0 ? String(labels[index] || '').trim() : '';
  };
  return {
    count: values.length,
    min: { value: Math.round(min), label: labelOf(min) },
    max: { value: Math.round(max), label: labelOf(max) },
    avg: Math.round(avg),
    flat: Math.round(min) === Math.round(max),
  };
}

/**
 * 区间统计文案：`区间 ¥1,080（11-18）– ¥1,160（12-08） · 均价 ¥1,120 · 20 次采集`。
 * 价格全平时只写「一直 ¥1,080」，不硬凑一个假区间。
 */
export function trendSummary(trend, { unit = '次采集' } = {}) {
  const stats = trendStats(trend);
  if (!stats) return '';
  const parts = [];
  if (stats.flat) {
    parts.push(`近 ${stats.count} ${unit}始终 ${money(stats.min.value)}`);
  } else {
    const at = (entry) => (entry.label ? `${money(entry.value)}（${entry.label}）` : money(entry.value));
    parts.push(`最低 ${at(stats.min)}`);
    parts.push(`最高 ${at(stats.max)}`);
    parts.push(`均价 ${money(stats.avg)}`);
    parts.push(`覆盖 ${stats.count} ${unit}`);
  }
  return parts.join(' · ');
}

/**
 * 走势图块：区块标题（横轴/纵轴口径写在这里）+ PNG + 区间统计。
 * 没有 `imageKey`（webhook 通道 / 上传失败 / 点数不足）时只省略图片本身，
 * 标题与统计照常保留——读者仍能看到「最近几次采集中，最低/最高/均价是多少」。
 */
function trendSection({ imageKey, axisText, trend, unit = '次采集' }) {
  const picture = image(imageKey, '价格走势');
  const summary = trendSummary(trend, { unit });
  // 没图（webhook 通道 / 上传失败）也没统计（少于 2 次采集）时整块不出现，
  // 否则会留一条孤零零的分隔线和标题。
  if (!picture && !summary) return [];
  const out = [rule(), sectionTitle('价格走势', axisText)];
  if (picture) out.push(picture);
  if (summary) out.push(statLine(summary));
  return out;
}

/**
 * 「本次采集」区块：采集时间 / 采集频率 / 乘客 / 数据状态 + 口径。
 * 这四个字段是每次投递都会变的元信息，放最后一块，不打断上面的价格阅读流。
 */
function collectSection({ monitor, at, dataState }) {
  const grid = fieldGrid([
    { label: '采集时间', value: localStamp(at) },
    { label: '采集频率', value: cadenceLabel(monitor?.cadence?.minutes) },
    { label: '乘客', value: passengerLabel(monitor) },
    { label: '数据状态', value: dataState },
  ]);
  if (grid.length === 0) return [];
  return [rule(), sectionTitle('本次采集'), ...grid];
}

// #region 酒店卡片（hotel 监控：整段总价 + 房型表）
/**
 * 酒店监控的标题：`价格监控 · 全季酒店(上海虹桥店)（12月05日–12月07日）`。
 * 酒店没有航线，标题用「酒店名 + 入住区间」；两者都拿不到时退回「价格监控」。
 */
function hotelHeading(monitor) {
  const params = monitor?.params || {};
  const name = inline(params.hotelName || params.keyword);
  const checkIn = monthDay(params.checkIn);
  const checkOut = monthDay(params.checkOut);
  const stay = checkIn && checkOut ? `${checkIn}–${checkOut}` : (checkIn || '');
  if (name && stay) return `价格监控 · ${name}（${stay}）`;
  if (name) return `价格监控 · ${name}`;
  if (stay) return `价格监控 · ${stay}`;
  return '价格监控';
}

/** 酒店名：快照里的规范名优先，其次监控参数里的匹配名，最后用户原始关键词。 */
function hotelNameOf(monitor, snapshot) {
  const params = monitor?.params || {};
  return inline(snapshot?.hotel?.name) || inline(params.hotelName) || inline(params.keyword);
}

/** 晚数：快照里的 nights 优先，缺失时按 checkIn/checkOut 现算（1–30 晚）。 */
function nightsOf(monitor, snapshot) {
  const fromSnapshot = Number(snapshot?.nights);
  if (Number.isFinite(fromSnapshot) && fromSnapshot > 0) return Math.round(fromSnapshot);
  const params = monitor?.params || {};
  const start = Date.parse(`${params.checkIn}T00:00:00Z`);
  const end = Date.parse(`${params.checkOut}T00:00:00Z`);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return Math.round((end - start) / 86400000);
  return null;
}

/** `12月05日 → 12月07日（2 晚）`；日期缺失的片段整段省略。 */
function hotelStayLine(monitor, snapshot) {
  const params = monitor?.params || {};
  const checkIn = snapshot?.checkIn || params.checkIn;
  const checkOut = snapshot?.checkOut || params.checkOut;
  const nights = nightsOf(monitor, snapshot);
  const start = monthDay(checkIn);
  const end = monthDay(checkOut);
  const range = start && end ? `${start} → ${end}` : (start || end || '');
  if (range && nights) return `${range}（${nights} 晚）`;
  return range;
}

/** `全季酒店(上海虹桥店) · 3 星 · 4.7 分 很好`：只拼有值的项，不写占位。 */
function hotelIdentityLine(monitor, snapshot) {
  const hotel = snapshot?.hotel && typeof snapshot.hotel === 'object' ? snapshot.hotel : {};
  const parts = [];
  const name = hotelNameOf(monitor, snapshot);
  if (name) parts.push(name);
  const star = Number(hotel.star);
  if (Number.isFinite(star) && star > 0) parts.push(`${star} 星`);
  const score = Number(hotel.score);
  if (Number.isFinite(score) && score > 0) {
    const label = inline(hotel.scoreLabel);
    parts.push(label ? `${score.toFixed(1)} 分 ${label}` : `${score.toFixed(1)} 分`);
  }
  return parts.join(' · ');
}

/** `房型名` 截断到 ~14 个字符；缺失时用破折号（表格列需要占位）。 */
function roomNameCell(value) {
  const text = inline(value);
  if (!text) return '—';
  const chars = [...text];
  return chars.length <= HOTEL_ROOM_NAME_MAX ? text : `${chars.slice(0, HOTEL_ROOM_NAME_MAX - 1).join('')}…`;
}

/**
 * 房型表数据：只保留「可订且整段总价 > 0」的房型（契约第 3 节的价格口径），
 * 按整段总价升序。`nightly` 缺失时用 total / 晚数 现算（副数字容错）。
 */
function hotelRoomRows(rooms, { nights } = {}) {
  return (Array.isArray(rooms) ? rooms : [])
    .filter((room) => room && typeof room === 'object')
    .map((room) => {
      const total = Number(room?.price?.total);
      if (room?.bookable === false || !Number.isFinite(total) || total <= 0) return null;
      const nightlyRaw = Number(room?.price?.nightly);
      const nightly = Number.isFinite(nightlyRaw) && nightlyRaw > 0
        ? Math.round(nightlyRaw)
        : (Number.isFinite(nights) && nights > 0 ? Math.round(total / nights) : null);
      return {
        name: room?.name,
        bed: room?.bed,
        area: room?.area,
        total: Math.round(total),
        nightly,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.total - right.total);
}

/**
 * 房型 Markdown 表（房型 / 床型 / 面积 / 每晚 / 整段）。
 *
 * 最低价行**整行加粗**：读者第一眼要落在最便宜的一行，而不是自己逐行比较。
 * 床型/面积缺失用 `—`（表格里空单元格比破折号更难读）——这是本仓库唯一允许
 * 破折号的地方，仅限房型表的这两个单元格。
 *
 * @returns {{element: object|null, hidden: number}}
 */
function hotelRoomTable(rooms, { nights, limit = HOTEL_ROOM_LIMIT } = {}) {
  const rows = hotelRoomRows(rooms, { nights });
  if (rows.length === 0) return { element: null, hidden: 0 };
  const shown = rows.slice(0, limit);
  const lines = [
    '| 房型 | 床型 | 面积 | 每晚 | 整段 |',
    '| :--- | :--- | :--- | :--- | :--- |',
  ];
  shown.forEach((row, index) => {
    // rows 已按整段总价升序：第一行就是最低价，整行加粗。
    const bold = index === 0;
    const cells = [
      roomNameCell(row.name),
      inline(row.bed) || '—',
      inline(row.area) || '—',
      Number.isFinite(row.nightly) ? money(row.nightly) : '—',
      money(row.total),
    ].map((cell) => (bold ? `**${cell}**` : cell));
    lines.push(`| ${cells.join(' | ')} |`);
  });
  return { element: markdown(lines.join('\n')), hidden: Math.max(0, rows.length - shown.length) };
}

/** 房型列表：快照里 `rooms` 可能是数组（房源列表），也兼容 `roomList`/`hotelRooms`。 */
function hotelRoomList(snapshot) {
  for (const key of ['rooms', 'roomList', 'hotelRooms']) {
    if (Array.isArray(snapshot?.[key])) return snapshot[key];
  }
  return [];
}

// #endregion

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
 * 单程：`未来 30 天最低价 ¥498` + 涨跌 + 最低日 + 走势图 + 最便宜的几天。
 * 往返：主视觉是去程最低价，回程最低价单列一行（L1 的两段相加只是估算，
 * 不合并成一个「联程价」，避免和监控模式的实价口径混在一起）。
 *
 * @param {{ monitor: object, out: Array<{date:string,total:number}>, back?: Array|null,
 *           previous?: { out?: number|null, back?: number|null }|null, imageKey?: string|null,
 *           at?: string, trend?: {values:number[], labels:string[]}|null }} input
 */
export function buildCalendarCard({ monitor, out, back, previous, imageKey, at, trend } = {}) {
  try {
    const forward = Array.isArray(out) ? out : [];
    const backward = Array.isArray(back) ? back : [];
    // 卡片口径统一在「未来 30 天」窗口内：主视觉、最低日、走势图、统计、低价日表
    // 必须来自同一批点。原来价格和明细取全量日历（约 347 天）、图只画 30 天，
    // 会出现「未来 30 天最低价 ¥460」而当天并不在图上这种自相矛盾。
    const forwardWindow = forward.slice(0, CARD_WINDOW_DAYS);
    const backwardWindow = backward.slice(0, CARD_WINDOW_DAYS);
    const forwardLowest = cheapestOf(forwardWindow);
    const backLowest = cheapestOf(backwardWindow);
    const round = monitor?.params?.trip === 'round';
    const price = money(forwardLowest?.total);
    const delta = deltaParts(forwardLowest?.total, Number(previous?.out));
    const backDelta = deltaParts(backLowest?.total, Number(previous?.back));
    const stats = trendStats(trend);
    const elements = [];

    // ── 1. 结论
    if (price) {
      elements.push(...priceHero({
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

    const headline = [];
    if (forwardLowest) {
      const when = dateCell(forwardLowest.date);
      if (when) headline.push(`最低日 ${when}`);
    }
    if (round) {
      const when = backLowest ? dateCell(backLowest.date) : '';
      if (backLowest) {
        headline.push(`回程最低 ${money(backLowest.total)}${when ? `（${when}）` : ''}${backDelta?.text ? `，${backDelta.text}` : ''}`);
      }
    }
    if (headline.length > 0) elements.push(statLine(headline.join(' · ')));

    // ── 2. 走势
    elements.push(...trendSection({
      imageKey,
      axisText: round ? `${AXIS_CALENDAR}（去程）` : AXIS_CALENDAR,
      trend,
      unit: '天',
    }));

    // ── 3. 明细：最便宜的几天
    // 先取更多天再交给 dayTable 去重（同价位只留一天）：直接取 4 天会被
    // 连续 4 天的同一个最低价占满，去重后只剩 1 行。
    const days = lowestDays(forwardWindow, 12);
    const table = dayTable(days, { limit: 4, average: stats?.avg });
    if (table) {
      elements.push(rule(), sectionTitle('最便宜的日期', '按含税价从低到高'), table);
    }

    // ── 4. 采集信息
    const coverage = forward.length > 0 ? `${forward.length} 天` : '';
    elements.push(...collectSection({
      monitor,
      at,
      dataState: forward.length > 0 ? (coverage ? `已覆盖 ${coverage}` : '已更新') : '本轮未取到',
    }));
    const spec = statLine(`口径：${PRICE_SPEC_CALENDAR}`);
    if (spec) elements.push(spec);

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
 * Watch-mode card (spec §3 监控 + D10 往返联程 + V10 分块).
 *
 * 主视觉是「当前最低实价」；往返再加一块「联程组合 vs 两段单买」的对比，
 * 明细区给联程组合 TOP3 和两段单买的拆分（单程给可订航班表 + 余票）。
 *
 * @param {{ monitor: object, lowest?: {flightNo:string,total:number,scheme?:string}|null,
 *           lowestFlight?: object|null, previous?: number|null, flights?: Array<object>,
 *           roundTrip?: object|null, imageKey?: string|null, at?: string,
 *           trend?: {values:number[], labels:string[]}|null }} input
 */
export function buildWatchCard({ monitor, lowest, lowestFlight, previous, flights, roundTrip, imageKey, at, trend } = {}) {
  try {
    const current = Number(lowest?.total);
    const price = money(current);
    const delta = deltaParts(current, previous);
    const scheme = lowest?.scheme === 'round' || lowest?.scheme === 'oneway' ? lowest.scheme : null;
    const schemeLabel = scheme === 'round' ? '联程组合' : scheme === 'oneway' ? '两段单买' : '';
    const elements = [];

    // ── 1. 结论
    if (price) {
      elements.push(...priceHero({
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

    // ── 2. 走势
    elements.push(...trendSection({ imageKey, axisText: AXIS_WATCH, trend }));

    // ── 3. 明细
    const round = monitor?.params?.trip === 'round';
    const detailSub = [];

    if (round && roundTrip && typeof roundTrip === 'object') {
      const combos = comboTable(roundTrip.combos, { limit: 3 });
      if (combos) {
        elements.push(rule(), sectionTitle('联程组合', '按待支付价从低到高'), combos);
      }
      const oneway = roundTrip.oneway && typeof roundTrip.oneway === 'object' ? roundTrip.oneway : null;
      const outPayable = money(oneway?.out?.payable);
      const backPayable = money(oneway?.back?.payable);
      const total = money(oneway?.sum);
      if (outPayable && backPayable && total) {
        elements.push(sectionTitle('两段单买', '去程 + 回程分开买'));
        // 一行说清「哪两班 + 各多少钱 + 合计」：原来拆成三行，信息重复且占高度。
        const outFlight = oneway.out ? flightCell({ ...oneway.out, no: oneway.out.flightNo }) : '';
        const backFlight = oneway.back ? flightCell({ ...oneway.back, no: oneway.back.flightNo }) : '';
        const legs = [
          outFlight ? `去程 ${outFlight} ${outPayable}` : `去程 ${outPayable}`,
          backFlight ? `回程 ${backFlight} ${backPayable}` : `回程 ${backPayable}`,
        ];
        elements.push(statLine(`${legs.join(' · ')} → 合计 ${total}`));
      }
    } else {
      const top = topFlights(flights, 5);
      const table = flightTable(top);
      if (table) {
        elements.push(rule(), sectionTitle(round ? '去程航班' : '可订航班', '按实价从低到高 · 含余票'), table);
      }
      const replayed = lowestFlight
        || (Array.isArray(flights) ? flights.find((flight) => flight?.no && flight.no === lowest?.flightNo) : null);
      const label = flightInline(replayed);
      if (label) detailSub.push(`最低来自 ${label}`);
    }
    if (detailSub.length > 0) elements.push(statLine(detailSub.join(' · ')));

    // ── 4. 采集信息
    const partial = roundTrip?.partial === true;
    const dataState = round
      ? (partial ? '部分数据（有组合没取到实价）' : '完整')
      : (topFlights(flights, 10).length > 0 ? `已取到 ${topFlights(flights, 10).length} 个航班实价` : '本轮未取到');
    elements.push(...collectSection({ monitor, at, dataState }));
    const spec = statLine(`口径：${PRICE_SPEC_WATCH}`);
    if (spec) elements.push(spec);

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
    const elements = [
      sectionTitle('失败原因'),
      divText(detail, { color: INK.up }),
      statLine('这一轮没有写入新价格，下一轮会按采集节奏继续。'),
    ];
    elements.push(...collectSection({ monitor, at, dataState: '本轮失败' }));
    return cardShell({
      template: TEMPLATE.failure,
      title: cardHeading(monitor),
      summary: withRoute(monitor, '本次采集失败'),
      tags: [modeTag(monitor)],
      elements,
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
    const elements = [
      sectionTitle('投递通道'),
      divText(`**${channelLabel}**`),
    ];
    const targetLine = statLine(target);
    if (targetLine) elements.push(targetLine);
    elements.push(divText('收到这条消息说明通道可用；正式卡片包含价格主视觉、带坐标轴的走势图、分块明细与采集信息（走势图仅自建应用通道）。', {
      color: INK.muted,
      size: 'notation',
    }));
    elements.push(rule(), sectionTitle('发送信息'));
    elements.push(...fieldGrid([{ label: '发送时间', value: localStamp(at) }]));
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
 * Hotel-mode card（契约 §7：结论 / 走势 / 房型 / 本次采集 四区块）。
 *
 * 与机票卡片同一套视觉语言：`priceHero` 大号主数字、`sectionTitle` 区块标题、
 * `rule()` 分隔、`fieldGrid` 采集信息、末行口径说明；**没有按钮/action，没有字符画**，
 * 走势只走真 PNG（`imageKey` 为空时整块图省略、只留统计行）。
 *
 * 与机票的三点差异（用户已确认的定案）：
 *  - 主数字是**整段含税总价**（`lowest.total`），每晚价只做副标题；
 *  - 酒店没有「未来 30 天」窗口，走势就是全部历史采集点；
 *  - 涨跌用独立一行（`deltaLine`），不是价格右侧的胶囊。
 *
 * 无价 / 无房型 / 无图时**整块省略**，不写占位；任何脏数据都降级成纯文本，绝不抛
 * （卡片构造失败不能阻断投递）。
 *
 * @param {{ monitor: object, snapshot: object|null, previous?: number|null,
 *           imageKey?: string|null, at?: string,
 *           trend?: {values:number[], labels:string[]}|null }} input
 * @returns {object} 飞书卡片 2.0 JSON
 */
export function buildHotelCard({ monitor, snapshot, previous, imageKey = null, at, trend = null } = {}) {
  try {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : null;
    const params = monitor?.params || {};
    const rooms = hotelRoomList(snap);
    const nights = nightsOf(monitor, snap);
    const adultsRaw = Number(snap?.adults ?? params.adults);
    const adults = Number.isFinite(adultsRaw) && adultsRaw > 0 ? Math.round(adultsRaw) : null;
    const lowestInfo = snap?.lowest && typeof snap.lowest === 'object' ? snap.lowest : null;
    const roomRows = hotelRoomRows(rooms, { nights });
    const lowestRoom = roomRows[0] || null;
    const totalRaw = Number(lowestInfo?.total ?? lowestRoom?.total);
    const total = Number.isFinite(totalRaw) && totalRaw > 0 ? Math.round(totalRaw) : null;
    const price = money(total);
    const delta = deltaParts(total, previous);
    const name = hotelNameOf(monitor, snap);
    const elements = [];

    // ── 1. 结论：大号整段总价 + 每晚/房型副行 + 酒店身份 + 涨跌 + 口径标签
    if (price) {
      elements.push(...priceHero({
        label: '整段最低总价',
        price,
        // 有上一次价格才用涨红跌绿；第一次采集保持中性深色。
        priceColor: delta ? inkFor(delta.dir) : INK.neutral,
      }));
      const subline = [];
      if (Number.isFinite(nights) && nights > 0) subline.push(`${nights} 晚`);
      const nightlyRaw = Number(lowestInfo?.nightly);
      const nightly = Number.isFinite(nightlyRaw) && nightlyRaw > 0
        ? Math.round(nightlyRaw)
        : (Number.isFinite(nights) && nights > 0 && total ? Math.round(total / nights) : null);
      if (nightly) subline.push(`每晚约 ${money(nightly)}`);
      const roomName = inline(lowestInfo?.roomName) || inline(lowestRoom?.name);
      if (roomName) subline.push(roomName);
      if (subline.length > 0) elements.push(statLine(subline.join(' · ')));
      const identity = hotelIdentityLine(monitor, snap);
      if (identity) elements.push(statLine(identity));
      const deltaText = previous !== null && previous !== undefined ? deltaLine(total, previous) : null;
      if (deltaText) elements.push(divText(deltaText, { color: inkFor(delta?.dir), size: 'normal' }));
    }

    // ── 2. 走势：区块标题写横纵轴口径；图/统计都没有才整块省略
    const picture = image(imageKey, '价格走势');
    const trendText = trendSummary(trend);
    if (picture || trendText) {
      elements.push(rule(), sectionTitle('价格走势', AXIS_HOTEL));
      if (picture) elements.push(picture);
      if (trendText) elements.push(statLine(trendText));
    }

    // ── 3. 房型：整段总价升序前 6 行，最低价整行加粗，其余折成一行提示
    const table = hotelRoomTable(rooms, { nights });
    if (table.element) {
      elements.push(rule(), sectionTitle('房型价格', '按整段总价从低到高'), table.element);
      if (table.hidden > 0) elements.push(statLine(`另有 ${table.hidden} 个房型未显示`));
    }

    // ── 4. 本次采集：酒店 / 入住–离店 / 人数 / 时间 / 频率 / 数据状态 + 口径
    const dataState = roomRows.length > 0
      ? `已取到 ${roomRows.length} 个可订房型`
      : (snap ? '本轮未取到可订房型' : '本轮未取到房价');
    const grid = fieldGrid([
      { label: '酒店', value: name },
      { label: '入住–离店', value: hotelStayLine(monitor, snap) },
      { label: '入住人数', value: adults ? `${adults} 人` : '' },
      { label: '采集时间', value: localStamp(at) },
      { label: '采集频率', value: cadenceLabel(monitor?.cadence?.minutes) },
      { label: '数据状态', value: dataState },
    ]);
    if (grid.length > 0) elements.push(rule(), sectionTitle('本次采集'), ...grid);

    // 结论的标题/摘要：有价才有价格，没价就说「本轮未取到房价」，不编数字。
    const summary = price
      ? `${name ? `${name} ` : ''}整段 ${price}${delta ? `，${delta.text}` : ''}`
      : `${name ? `${name} ` : ''}本轮未取到房价`;

    return cardShell({
      template: templateFor(delta?.diff ?? null),
      title: hotelHeading(monitor),
      summary,
      tags: [{ text: '酒店监控', color: 'blue' }],
      elements,
    });
  } catch {
    // 卡片构造绝不能抛：降级成一句纯文本，采集结果仍会正常保存。
    try {
      return cardShell({
        template: TEMPLATE.flat,
        title: hotelHeading(monitor),
        summary: '酒店价格监控 · 本次卡片降级为纯文本',
        elements: [divText('本次卡片构造降级为纯文本，采集结果已正常保存。', { color: INK.muted })],
      });
    } catch {
      return { schema: '2.0', config: { compact_width: false }, body: { elements: [] } };
    }
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
