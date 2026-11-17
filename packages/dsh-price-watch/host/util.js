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
 * Which collection model a monitor uses: a real `departDate` means the user has
 * picked a date (watch), anything else means "date not decided yet" (calendar).
 */
export function monitorMode(params) {
  return isDateString(params?.departDate) ? 'watch' : 'calendar';
}

/**
 * There is deliberately no night-quiet helper here any more: frequency model v2
 * has no collection window, so both modes run 24 hours a day at the cadence the
 * user picked (spec §3). Do not reintroduce one as a "polite" default — it would
 * silently stretch a 30-minute cadence to a 7-hour gap overnight.
 */

/** `12月03日` — the compact date the title uses. */
function monthDay(dateString) {
  const parts = String(dateString || '').split('-');
  if (parts.length !== 3) return '';
  return `${Number(parts[1])}月${parts[2]}日`;
}

/**
 * Human title for a monitor, computed on the Host so both halves agree.
 * The mode is derived from `departDate`, exactly like the model itself.
 */
export function monitorTitle(options) {
  const params = options?.params && typeof options.params === 'object' ? options.params : options || {};
  const name = (code) => CITY_NAMES[code] || code;
  const round = params.trip === 'round';
  const route = round ? `${name(params.dep)} ⇄ ${name(params.arr)}` : `${name(params.dep)} → ${name(params.arr)}`;
  if (monitorMode(params) === 'calendar') {
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
