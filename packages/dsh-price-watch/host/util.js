/**
 * Small shared helpers for the price-watch Host half.
 *
 * Nothing here touches the filesystem or the network: it is only date maths,
 * id minting, JSON guards and a logger that can never throw into the caller.
 */

/** Shorthand for a promise-free sleep. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hard cap already enforced by the route layer; repeated here for tests. */
export const MAX_BODY_BYTES = 32 * 1024;

/** Format a Date as a local YYYY-MM-DD. */
export function isoDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ISO timestamp for storage. */
export function isoNow() {
  return new Date().toISOString();
}

/** YYYY-MM-DD plus a day offset. */
export function addDays(dateString, days) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * 每次采集的最低可订价（A2 §5 的 `min` 序列）。
 *
 * 同一次采集写下的所有点共享同一个 `at`，所以按 `at` 分组取最小值，就等于
 * 「这一轮的最低可订价」。这样不需要额外存一条序列，历史数据也自动生效。
 * 只统计带 positive `price.total` 的点；一次失败的采集没有点，图上就是空洞。
 */
export function minSeries(points) {
  const byAt = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    const at = typeof point?.at === 'string' ? point.at : '';
    const total = Number(point?.price?.total);
    if (!at || !Number.isFinite(total) || total <= 0) continue;
    const current = byAt.get(at);
    if (current === undefined || total < current) byAt.set(at, total);
  }
  return [...byAt.entries()]
    .map(([at, total]) => ({ at, total }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** A valid YYYY-MM-DD string? */
export function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

/**
 * Ctrip encodes dates as `/Date(1794758400000+0800)/`. The epoch is UTC
 * milliseconds, so shifting by the +08:00 offset before slicing gives the
 * calendar day the page actually showed.
 */
export function parseCtripDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/Date\((\d+)([+-]\d{4})?\)/);
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isFinite(ms)) return null;
  const offsetMinutes = match[2] ? Number(match[2].slice(1, 3)) * 60 + Number(match[2].slice(3)) : 0;
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** `m_` + 8 hex. */
export function monitorId() {
  return `m_${mint(8)}`;
}

/** `h_` + 8 hex — hotel monitors use their own prefix so logs stay readable. */
export function hotelMonitorId() {
  return `h_${mint(8)}`;
}

/** `p_` + 6 hex. */
export function passengerId() {
  return `p_${mint(6)}`;
}

function mint(length) {
  const alphabet = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Which collection model a monitor uses.
 *
 * `checkIn` is the hotel marker (hotel monitors always carry it, flight params
 * never do), then a real `departDate` means the user has picked a flight date
 * (watch), anything else means "date not decided yet" (calendar).
 */
export function monitorMode(params) {
  if (isDateString(params?.checkIn)) return 'hotel';
  return isDateString(params?.departDate) ? 'watch' : 'calendar';
}

/**
 * Whole nights between two `YYYY-MM-DD` dates, or `null` when either date is
 * not a real calendar day. Pure date maths (UTC midnight), so it can never be
 * shifted by the Host's local timezone; callers validate the 1–30 range.
 */
export function nightsBetween(checkIn, checkOut) {
  if (!isDateString(checkIn) || !isDateString(checkOut)) return null;
  const nights = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000);
  return Number.isFinite(nights) ? nights : null;
}

/**
 * There is deliberately no night-quiet helper here any more: frequency model v2
 * has no collection window, so both modes run 24 hours a day at the cadence the
 * user picked (spec §3). Do not reintroduce one as a "polite" default — it would
 * silently stretch a 30-minute cadence to a 7-hour gap overnight.
 */

/** `12月03日` — the compact date the titles and cards use. */
export function monthDay(dateString) {
  const parts = String(dateString || '').split('-');
  if (parts.length !== 3) return '';
  return `${Number(parts[1])}月${parts[2]}日`;
}

/**
 * Human title for a monitor, computed on the Host so both halves agree.
 * The mode is derived from the params, exactly like the model itself.
 */
export function monitorTitle(options) {
  const params = options?.params && typeof options.params === 'object' ? options.params : options || {};
  const mode = monitorMode(params);
  if (mode === 'hotel') {
    // `全季酒店(上海虹桥店) · 12月05日–12月07日`（契约 §2）
    const hotelName = String(params.hotelName || params.keyword || '酒店').trim();
    const checkIn = monthDay(params.checkIn);
    const checkOut = monthDay(params.checkOut);
    if (!checkIn) return hotelName;
    return checkOut ? `${hotelName} · ${checkIn}–${checkOut}` : `${hotelName} · ${checkIn}`;
  }
  const name = (code) => CITY_NAMES[code] || code;
  const round = params.trip === 'round';
  const route = round ? `${name(params.dep)} ⇄ ${name(params.arr)}` : `${name(params.dep)} → ${name(params.arr)}`;
  if (mode === 'calendar') {
    return round ? `${route} · 往返 · 日期待定` : `${route} · 日期待定`;
  }
  const depart = monthDay(params.departDate);
  if (!round) return `${route} · ${depart}`;
  const back = monthDay(params.returnDate);
  return back ? `${route} · ${depart}–${back}` : `${route} · ${depart}`;
}

/** A tiny display-name table; unknown codes fall back to the raw code. */
export const CITY_NAMES = {
  BJS: '北京', SHA: '上海', CAN: '广州', SZX: '深圳', CTU: '成都', CKG: '重庆',
  HGH: '杭州', XIY: '西安', KMG: '昆明', WUH: '武汉', NKG: '南京', TAO: '青岛',
  XMN: '厦门', CSX: '长沙', TSN: '天津', CGO: '郑州', SYX: '三亚', HRB: '哈尔滨',
  URC: '乌鲁木齐', SHE: '沈阳', DLC: '大连', FOC: '福州', HAK: '海口', KWE: '贵阳',
  TYN: '太原', LHW: '兰州', HKG: '香港', TPE: '台北', NRT: '东京', ICN: '首尔',
  BKK: '曼谷', SIN: '新加坡', KUL: '吉隆坡', SGN: '胡志明', HAN: '河内',
};

/** Clamp a numeric input, falling back when it is not a finite number. */
export function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalise a three-letter city code (upper-case, letters only). */
export function cityCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
}

/**
 * 心跳间隔是不是「大空档」——也就是机器刚睡过。
 *
 * 背景：进程在系统睡眠期间被冻结，定时器不跑；macOS 电池模式下每 15–20 分钟
 * 会有一次 2–3 秒的维护唤醒（DarkWake），醒来瞬间定时器补一拍。如果这一拍
 * 立刻开始采集，几乎必然落在窗口里被打断（页面只渲染出壳 / Chrome 已被回收）。
 *
 * 所以调度用这个判断来决定「这一拍只记时间，不动手」：间隔超过 3 拍（默认
 * 3 分钟）就认为刚睡醒；下一拍如果间隔正常（≈60 秒），说明系统真的醒着，才采。
 *
 * 第一拍（`gapMs === null`）同样返回 true：DSH 刚启动时先记一拍再采，
 * 这样「休眠后被系统杀掉、进程重启」也走同一条保护路径。
 *
 * @param {number|null} gapMs 距上次心跳的毫秒数（null = 还没有过心跳）
 * @param {{tickMs?: number, factor?: number}} [options]
 * @returns {boolean}
 */
export function isWakeUpGap(gapMs, { tickMs = 60_000, factor = 3 } = {}) {
  if (gapMs === null || gapMs === undefined) return true;
  const gap = Number(gapMs);
  if (!Number.isFinite(gap)) return true;
  if (gap < 0) return true;
  return gap > tickMs * factor;
}

/**
 * A logger facade: the Host may run without `ctx.logger`, and a failing log
 * call must never disturb price collection.
 */
export function createLogger(ctx) {
  const logger = () => ctx.logger;
  const safe = (level, message, error) => {
    try {
      const live = logger();
      if (live && typeof live[level] === 'function') live[level](`[price-watch] ${message}`, error ?? '');
      else if (level === 'warn' || level === 'error') console.warn(`[price-watch] ${message}`, error ?? '');
    } catch {
      /* logging must never throw */
    }
  };
  return {
    info: (message) => safe('info', message),
    warn: (message, error) => safe('warn', message, error),
    error: (message, error) => safe('error', message, error),
  };
}
