/**
 * Persistence for price-watch.
 *
 * Everything lives under `$DSH_HOME/price-watch/`, never in the project
 * directory:
 *
 *   config.json      passengers, the two global cadences, the Feishu webhook
 *   monitors.json    the watched targets: flight (`calendar` / `watch`) or `hotel`
 *   state.json       scheduler cursors, last-run marks, delivery bookkeeping
 *   prices/*.jsonl   one append-only series per watch/hotel monitor
 *   calendar/*.json  latest full calendar snapshot per calendar monitor
 *   flights/*.json   latest browser flight list per watch monitor (+ D10 roundTrip)
 *   hotels/*.json    latest room/price snapshot per hotel monitor (hotel spec §3)
 *   alerts.jsonl     the delivery log (kept under its historical name)
 *
 * Hotel monitors v1 （酒店契约见本地笔记，未入库）: `type:'hotel'`,
 * `mode:'hotel'`, `h_` ids, no passengers (only `params.adults`) and
 * `params.rooms` pinned to 1. Their snapshot has its own whitelist
 * (`normaliseHotelSnapshot`): integer prices, unknown room types dropped and
 * rooms sorted by the whole-stay total. A bad hotel record must always load —
 * `normaliseStoredMonitor` degrades instead of throwing.
 *
 * Storage tools (D-group follow-up): `storageReport()` sizes the data directory
 * for the settings page and `cleanupStorage()` deletes the `*.removed` leftovers
 * that `removeMonitor()` keeps as a safety net. The browser profile is never
 * walked fully (tens of thousands of files) — it is sized with depth/entry caps
 * and reports `null` when that cap is hit.
 *
 * JSON documents are written through a temp file + rename so a crash mid-write
 * cannot truncate them. A document that fails to parse is moved aside to
 * `<name>.bak` and replaced by defaults: a corrupted file must degrade the
 * panel, never block the plugin.
 *
 * Frequency model v2 (the only scheduling input, see spec §1/§2):
 *
 *   config.cadence   { calendarMinutes, watchMinutes }   global defaults, 6h each
 *   monitor.cadence  { minutes }                         per-monitor override
 *
 * Both are clamped up to CADENCE_MINUTES. There is no L1 budget, no L2 daily
 * count, no minimum L2 interval, no quiet window and no backoff anywhere in this
 * file — those concepts are gone, not merely defaulted off.
 *
 * Delivery model (A2 spec §1): `state.delivery[monitorId]` remembers the sha1 of
 * the last card that was actually delivered, so the next identical collection
 * skips the push but still stores its data. `alerts.jsonl` keeps one line per
 * delivery attempt. There are no alert rules, no cooldowns and no daily digest.
 *
 * Delivery channels (A2.2 spec §1): `config.notify` carries either a self-built
 * app (`channel:'app'` + appId/appSecret/chatId, the default) or a custom bot
 * webhook (`channel:'webhook'` + feishuWebhook). The app secret is stored in
 * plain text here because the Host must sign token requests with it; the HTTP
 * layer never returns it, only `appSecretSet`.
 *
 * Migration is idempotent: `init()` reads, folds every historical shape into the
 * current one and writes back only when the serialised document really changed,
 * so a second `init()` on migrated files performs no write at all.
 *
 *   config   `cadence.calendarHours` → `calendarMinutes` (×60); the legacy
 *            `cadence.watchMinutes` / `cadence.l1Minutes` → `watchMinutes`
 *            (clamped); the dead `l1` / `l2` / `notify.quietHours` /
 *            `notify.cooldownMinutes` / `notify.digestAt` fields are dropped
 *            because nothing reads them any more.
 *   monitor  `cadence.hours` → `minutes` (×60); `cadence.minutes` kept; all
 *            clamped to the shared tier list; the dead `rules` field dropped
 *            (alert rules were replaced by the per-collection delivery card).
 *   state    `l1Runs` / `l2Runs` / `l2Backoff` / `l2DisabledForDay` /
 *            `l1BlockedUntil` / `l1FailCount` / `l2BlockedUntil` and the alert
 *            bookkeeping (`cooldowns` / `dayFired` / `sides` / `lastDigest`) are
 *            dropped; every field the scheduler and the API still read is kept.
 */
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  CITY_NAMES,
  cityCode,
  hotelMonitorId,
  isDateString,
  isoDate,
  isoNow,
  monitorId,
  monitorMode,
  monitorTitle,
  nightsBetween,
  numberOr,
  passengerId,
} from './util.js';

/** How many price points a single series read may return. */
const MAX_POINTS = 5000;
/** How many delivery-log lines are kept on disk. */
const MAX_DELIVERIES = 5000;
/** Hard cap on watched routes. */
export const MAX_MONITORS = 20;
export const MAX_PASSENGERS = 12;

/** Hotel v1 bounds (hotel spec §2): 1–30 nights, 1–6 guests, 1 room. */
export const MAX_HOTEL_NIGHTS = 30;
export const HOTEL_ADULTS = { min: 1, max: 6, fallback: 2 };
/** Longest accepted hotel keyword, in characters (hotel spec §6.1). */
export const MAX_HOTEL_KEYWORD = 40;

/**
 * The one and only cadence ladder, in minutes, shared by both modes:
 * 30 分钟 / 1 小时 / 3 小时 / 6 小时 / 12 小时 / 24 小时.
 * A value between two tiers is clamped *up* (120 → 180, 240 → 360) so a user
 * request is never silently made more frequent than asked for.
 */
export const CADENCE_MINUTES = [30, 60, 180, 360, 720, 1440];

/** Global defaults picked by the user: calendar 6h, watch 6h. */
const DEFAULT_CADENCE = { calendarMinutes: 360, watchMinutes: 360 };

// #region normalisation helpers
const DEFAULT_CONFIG = () => ({
  passengers: [],
  cadence: { ...DEFAULT_CADENCE },
  // A2.2 §1: two delivery channels. `app` (企业自建应用) is the new default;
  // `feishuWebhook` is kept so a self-built-bot-only user does not break on
  // upgrade (see the migration below, which pins them to `webhook`).
  notify: {
    channel: 'app',
    appId: '',
    appSecret: '',
    chatId: '',
    feishuWebhook: '',
  },
  panelBaseUrl: '',
});

/**
 * State that survives A2. Written in a fixed key order so that the document
 * round-trips byte-identically through `normaliseState()`.
 */
/** Card kinds that may appear in the delivery log; `hotel` joined in v0.15. */
const DELIVERY_KINDS = ['calendar', 'watch', 'hotel', 'failure'];

const DEFAULT_STATE = () => ({
  lastCollectAt: null,
  lastCollectBy: {},
  auth: { status: 'unknown', lastVerifiedAt: null, accountHint: '' },
  nextDue: {},
  calendarFetchedAt: {},
  l2LastRunBy: {},
  l2LastOk: {},
  l2LastError: null,
  lastError: {},
  failures: {},
  /**
   * `{[monitorId]: { hash, at, ok, error, kind }}` — the sha1 of the last card
   * actually pushed to Feishu. Equal hash on the next collection ⇒ skip the
   * push (but still store the data); different ⇒ push exactly once.
   */
  delivery: {},
});

/** A finite number or `null`; `null` lets the caller fall back to a default. */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Clamp a cadence in minutes up to the nearest ladder tier:
 * 30 → 30, 60 → 60, 120 → 180, 240 → 360, 0 → 30, 999999 → 1440.
 *
 * Why "up" and not "nearest": the cadence is a politeness constraint on
 * Ctrip's endpoints, so rounding down would collect more often than the user
 * asked for. Values that cannot be parsed at all (undefined / null / '') mean
 * "not supplied" and fall back to the mode's global default — which is also
 * what an old monitor without a cadence needs.
 */
export function clampCadence(value, fallback = DEFAULT_CADENCE.calendarMinutes) {
  const n = finiteOrNull(value);
  if (n === null) return clampCadence(fallback);
  return CADENCE_MINUTES.find((choice) => choice >= n) ?? CADENCE_MINUTES[CADENCE_MINUTES.length - 1];
}

/**
 * Fold every accepted config shape into the current schema.
 *
 * Only the fields in spec §2 survive. Historic keys are read once and then
 * dropped: a migrated config must not keep carrying the l1/l2 budget blocks,
 * because leaving them around invites a future reader to honour them again.
 */
function normaliseConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const base = DEFAULT_CONFIG();
  const inputCadence = input.cadence && typeof input.cadence === 'object' ? input.cadence : {};

  // Migration: pre-v2 stored the calendar cadence in hours, and the watch
  // cadence either as `watchMinutes` or (M2) as `l1Minutes`. New fields win.
  const legacyCalendarHours = finiteOrNull(inputCadence.calendarHours);
  const calendarRaw = inputCadence.calendarMinutes !== undefined
    ? inputCadence.calendarMinutes
    : legacyCalendarHours !== null
      ? legacyCalendarHours * 60
      : undefined;
  const watchRaw = inputCadence.watchMinutes !== undefined
    ? inputCadence.watchMinutes
    : inputCadence.l1Minutes;
  const cadence = {
    calendarMinutes: clampCadence(calendarRaw, base.cadence.calendarMinutes),
    watchMinutes: clampCadence(watchRaw, base.cadence.watchMinutes),
  };

  const passengers = Array.isArray(input.passengers)
    ? input.passengers.filter((item) => item && typeof item === 'object' && item.id)
    : [];

  const inputNotify = input.notify && typeof input.notify === 'object' ? input.notify : {};
  const feishuWebhook = typeof inputNotify.feishuWebhook === 'string' ? inputNotify.feishuWebhook : base.notify.feishuWebhook;
  /**
   * 通道迁移（A2.2 §1）：老配置里没有 `channel`，只有 `feishuWebhook`。
   *  - webhook 非空 → 固定成 'webhook'，老用户升级后立刻失效是最糟的结果；
   *  - webhook 为空（A2 默认）→ 用新默认 'app'，用户去设置页填应用信息即可。
   * 显式写的 channel 优先，只接受这两个值。
   */
  const channel = inputNotify.channel === 'app' || inputNotify.channel === 'webhook'
    ? inputNotify.channel
    : feishuWebhook.trim()
      ? 'webhook'
      : base.notify.channel;
  // appSecret 不 trim：它是密钥，不做「顺手清理」，免得把有效凭据改坏。
  const notify = {
    channel,
    appId: typeof inputNotify.appId === 'string' ? inputNotify.appId.trim() : '',
    appSecret: typeof inputNotify.appSecret === 'string' ? inputNotify.appSecret : '',
    chatId: typeof inputNotify.chatId === 'string' ? inputNotify.chatId.trim() : '',
    feishuWebhook,
  };

  return {
    passengers,
    cadence,
    notify,
    panelBaseUrl: typeof input.panelBaseUrl === 'string' ? input.panelBaseUrl : '',
  };
}

/**
 * Per-monitor cadence, always `{ minutes }` regardless of mode.
 *
 * Migration: a calendar monitor used to carry `{ hours }`, a watch monitor
 * `{ minutes }` and M2 `{ l1Minutes }`; all three collapse into minutes and
 * every result is clamped to the shared ladder.
 */
function normaliseCadence(input, config, mode = 'watch') {
  const raw = input && typeof input === 'object' ? input : {};
  const key = mode === 'calendar' ? 'calendarMinutes' : 'watchMinutes';
  const fallback = clampCadence(config?.cadence?.[key], DEFAULT_CADENCE[key]);
  const legacyHours = finiteOrNull(raw.hours);
  const value = raw.minutes !== undefined
    ? raw.minutes
    : legacyHours !== null
      ? legacyHours * 60
      : raw.l1Minutes;
  return { minutes: clampCadence(value, fallback) };
}

// #region hotel helpers
/**
 * A hotel monitor is recognised from the data itself, not just `type`: hand-edited
 * or older documents may carry `mode:'hotel'` / hotel params without a proper
 * `type`, and `checkIn` never appears on a flight monitor.
 */
function isHotelMonitor(monitor) {
  if (!monitor || typeof monitor !== 'object') return false;
  if (monitor.type === 'hotel' || monitor.mode === 'hotel') return true;
  return Boolean(monitor.params && typeof monitor.params === 'object' && isDateString(monitor.params.checkIn));
}

/** 入住人数：1–6 的整数，任何越界/非法输入都收进范围（读取旧数据用）。 */
function clampAdults(value, fallback = HOTEL_ADULTS.fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(HOTEL_ADULTS.max, Math.max(HOTEL_ADULTS.min, Math.round(n)));
}

/** 严格的入住人数校验（新建/修改用）：非整数或越界直接报错。 */
function strictAdults(value) {
  if (value === undefined || value === null || value === '') return HOTEL_ADULTS.fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < HOTEL_ADULTS.min || n > HOTEL_ADULTS.max) {
    throw new Error(`入住人数需要是 ${HOTEL_ADULTS.min}–${HOTEL_ADULTS.max} 之间的整数`);
  }
  return n;
}

/**
 * 酒店监控参数的严格校验（hotel spec §6.1）。失败 throw 普通 Error，由路由转 400。
 *
 * 只校验本地字段，**不做任何网络请求**；`requireIdentity` 控制是否要求
 * `hotelId`/`hotelName`（新建时必须、改日期/人数时已有）。
 * `requireFuture` 只用于新建：`checkIn >= 今天`；改在住行程时不再卡这条。
 */
function normaliseHotelParams(input, { requireIdentity = true, requireFuture = true, validateOptionalIdentity = false } = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const city = cityCode(raw.city);
  if (city.length !== 3) throw new Error('城市需要是 3 位城市三字码（如 SHA）');
  const cityName = String(raw.cityName || CITY_NAMES[city] || city).trim().slice(0, 20) || city;

  const keyword = String(raw.keyword ?? '').trim();
  const keywordLength = [...keyword].length;
  if (keywordLength < 1) throw new Error('酒店名称不能为空');
  if (keywordLength > MAX_HOTEL_KEYWORD) throw new Error(`酒店名称最多 ${MAX_HOTEL_KEYWORD} 个字`);

  const checkIn = isDateString(raw.checkIn) ? raw.checkIn : '';
  if (!checkIn) throw new Error('入住日期格式应为 YYYY-MM-DD');
  const checkOut = isDateString(raw.checkOut) ? raw.checkOut : '';
  if (!checkOut) throw new Error('离店日期格式应为 YYYY-MM-DD');
  if (requireFuture && checkIn < isoDate()) throw new Error('入住日期不能早于今天');
  const nights = nightsBetween(checkIn, checkOut);
  if (!(Number.isFinite(nights) && nights > 0)) throw new Error('离店日期必须晚于入住日期');
  if (nights > MAX_HOTEL_NIGHTS) throw new Error(`入住晚数不能超过 ${MAX_HOTEL_NIGHTS} 晚`);

  // 联想下拉选中后可选带上 hotelId / hotelName（契约 §6.1）。这里只做**本地**
  // 格式校验：id 是 4–12 位数字（携程 productId），名称给了就 1–60 字；
  // 「这个 id 是否仍在候选里」由 index.js 的 confirmHotelId 远端确认。
  const rawHotelId = raw.hotelId;
  const hotelId = rawHotelId === undefined || rawHotelId === null || rawHotelId === ''
    ? ''
    : String(rawHotelId).trim();
  const rawHotelName = String(raw.hotelName ?? '').trim();
  const hotelName = rawHotelName.slice(0, 60);
  const hasIdentityInput = rawHotelId !== undefined || raw.hotelName !== undefined;
  if ((requireIdentity || validateOptionalIdentity || hasIdentityInput) && hotelId && !/^\d{4,12}$/.test(hotelId)) {
    throw new Error('酒店 ID 格式不正确');
  }
  if ((requireIdentity || validateOptionalIdentity) && rawHotelName) {
    const hotelNameLength = [...rawHotelName].length;
    if (hotelNameLength < 1 || hotelNameLength > 60) throw new Error('酒店名称需要 1–60 个字');
  }
  if (requireIdentity) {
    if (!hotelId || !rawHotelName) throw new Error('酒店信息不完整，请重新校验酒店');
  }

  // 字段顺序固定：monitors.json 的酒店项按契约 §2 的顺序落盘，读起来稳定。
  return {
    city,
    cityName,
    keyword,
    hotelId,
    hotelName,
    checkIn,
    checkOut,
    adults: strictAdults(raw.adults),
    rooms: 1,
  };
}

/**
 * 读取磁盘上的酒店参数：绝不 throw。坏字段保留到「能展示」的程度，
 * 缺失的日期留空字符串（监控仍能加载，采集时自然失败并写原因）。
 */
function normaliseStoredHotelParams(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  try {
    return normaliseHotelParams(input, { requireIdentity: false, requireFuture: false });
  } catch {
    const city = cityCode(input.city);
    return {
      city,
      cityName: String(input.cityName || CITY_NAMES[city] || city).trim().slice(0, 20) || city,
      keyword: String(input.keyword ?? '').trim().slice(0, MAX_HOTEL_KEYWORD),
      hotelId: String(input.hotelId ?? '').trim().slice(0, 64),
      hotelName: String(input.hotelName ?? '').trim().slice(0, 80),
      checkIn: isDateString(input.checkIn) ? input.checkIn : '',
      checkOut: isDateString(input.checkOut) ? input.checkOut : '',
      adults: clampAdults(input.adults),
      rooms: 1,
    };
  }
}

/** 酒店监控的磁盘读取升级：保留 type/mode='hotel'，不经过机票的 normaliseParams。 */
function normaliseStoredHotelMonitor(monitor, config) {
  const params = normaliseStoredHotelParams(monitor?.params);
  return {
    id: monitor.id,
    type: 'hotel',
    mode: 'hotel',
    title: monitorTitle(params),
    enabled: monitor.enabled !== false,
    params,
    // 酒店只要人数，不要乘客（契约 §2：passengerIds 恒为空数组）。
    passengerIds: [],
    cadence: normaliseCadence(monitor.cadence, config, 'watch'),
    createdAt: typeof monitor.createdAt === 'string' ? monitor.createdAt : isoNow(),
    updatedAt: typeof monitor.updatedAt === 'string' ? monitor.updatedAt : isoNow(),
  };
}
// #endregion

/**
 * Lenient monitor upgrade: anything read from disk must survive even if it has
 * no `mode` (M1/M2 schema) or half-valid params. Never throws.
 */
function normaliseStoredMonitor(monitor, config) {
  if (!monitor || typeof monitor !== 'object' || !monitor.id) return null;
  // 酒店分支必须早于机票的 normaliseParams 判断：它们的 params 结构完全不同。
  if (isHotelMonitor(monitor)) return normaliseStoredHotelMonitor(monitor, config);
  const params = { ...(monitor.params && typeof monitor.params === 'object' ? monitor.params : {}) };
  const trip = params.trip === 'round' ? 'round' : 'oneway';
  params.trip = trip;
  params.dep = cityCode(params.dep);
  params.arr = cityCode(params.arr);
  params.cabin = params.cabin || 'y_s';
  const mode = monitorMode(params);
  if (mode === 'calendar') {
    delete params.departDate;
    delete params.returnDate;
  } else if (trip === 'round' && !isDateString(params.returnDate)) {
    params.trip = 'oneway';
    delete params.returnDate;
  }
  const next = {
    ...monitor,
    type: 'flight',
    mode,
    params,
    title: monitorTitle(params),
    enabled: monitor.enabled !== false,
    // A calendar monitor may legitimately carry no passenger (the calendar
    // price is passenger-agnostic); only a watch needs a non-empty roster, and
    // that rule is enforced on create/update, not on read: disk data must always
    // load so an upgrade can never brick the panel.
    passengerIds: Array.isArray(monitor.passengerIds) ? monitor.passengerIds.filter((id) => typeof id === 'string') : [],
    cadence: normaliseCadence(monitor.cadence, config, mode),
  };
  // Alert rules were removed with rules.js (A2 §1.2): drop the field instead of
  // carrying a dead array around, otherwise every reader has to know it is inert.
  delete next.rules;
  return next;
}

/**
 * Normalise the delivery bookkeeping: `{[monitorId]: {hash, at, ok, error, kind}}`.
 *
 * Why a fixed field order and a drop of everything else: this record decides
 * whether the next collection pushes a card, so a half-written or hand-edited
 * entry must not be able to make the Host spam Feishu. An entry without a hash
 * is simply forgotten (the next collection will deliver again once).
 */
function normaliseDelivery(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const hash = typeof entry.hash === 'string' ? entry.hash : '';
    if (!hash) continue;
    out[id] = {
      hash,
      at: typeof entry.at === 'string' ? entry.at : null,
      ok: entry.ok === true,
      error: typeof entry.error === 'string' ? entry.error : null,
      kind: DELIVERY_KINDS.includes(entry.kind) ? entry.kind : 'calendar',
    };
  }
  return out;
}

/**
 * Keep exactly the state fields A2 still reads.
 *
 * This is a whitelist on purpose: spreading the raw document would preserve
 * `l1Runs`, `l2Backoff`, `cooldowns`, `dayFired`, `sides`, `lastDigest`, …
 * forever, and a dead field that keeps being written looks authoritative to the
 * next reader. Dropping unknown keys is safe here because every one of them
 * belonged to a model that no longer exists (budgets, backoff, alert rules).
 *
 * Key order is fixed by the object literal below, which is what makes a second
 * `init()` byte-identical and therefore write-free.
 */
function normaliseState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const base = DEFAULT_STATE();
  const obj = (value, fallback) => (value && typeof value === 'object' && !Array.isArray(value) ? value : fallback);
  const isoOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

  return {
    lastCollectAt: isoOrNull(input.lastCollectAt),
    lastCollectBy: obj(input.lastCollectBy, {}),
    // Spread rather than whitelist: `auth` is written straight from the browser
    // collector (status / lastVerifiedAt / accountHint today) and a buttoned-up
    // schema here would silently eat a future field. Key order stays stable
    // because the base object always comes first.
    auth: { ...base.auth, ...obj(input.auth, {}) },
    nextDue: obj(input.nextDue, {}),
    calendarFetchedAt: obj(input.calendarFetchedAt, {}),
    l2LastRunBy: obj(input.l2LastRunBy, {}),
    l2LastOk: obj(input.l2LastOk, {}),
    l2LastError: typeof input.l2LastError === 'string' ? input.l2LastError : null,
    lastError: obj(input.lastError, {}),
    failures: obj(input.failures, {}),
    delivery: normaliseDelivery(input.delivery),
  };
}
// #endregion

export function createStore(rootDir) {
  const pricesDir = join(rootDir, 'prices');
  const calendarDir = join(rootDir, 'calendar');
  const flightsDir = join(rootDir, 'flights');
  const hotelsDir = join(rootDir, 'hotels');
  const configPath = join(rootDir, 'config.json');
  const monitorsPath = join(rootDir, 'monitors.json');
  const statePath = join(rootDir, 'state.json');
  const alertsPath = join(rootDir, 'alerts.jsonl');

  /** @type {{ config: any, monitors: any[], state: any }} */
  const cache = { config: DEFAULT_CONFIG(), monitors: [], state: DEFAULT_STATE() };
  let ready = null;

  /** Read JSON; `undefined` means "the file is absent" (fallback returned). */
  async function readJson(path, fallback) {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { value: fallback, raw: undefined };
      return { value: fallback, raw: undefined };
    }
    try {
      return { value: JSON.parse(raw), raw };
    } catch {
      // Unreadable/corrupt document: keep a copy for diagnosis, start clean.
      try {
        await rename(path, `${path}.bak`);
      } catch {
        /* the file may already be gone */
      }
      return { value: fallback, raw: undefined };
    }
  }

  async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
  }

  /** Write only when the normalised document really differs from what is on disk. */
  async function writeIfChanged(path, raw, next) {
    if (raw === undefined) return false;
    if (raw === JSON.stringify(next, null, 2)) return false;
    await writeJsonAtomic(path, next);
    return true;
  }

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      await mkdir(pricesDir, { recursive: true });
      await mkdir(calendarDir, { recursive: true });
      await mkdir(flightsDir, { recursive: true });
      await mkdir(hotelsDir, { recursive: true });

      const configDoc = await readJson(configPath, null);
      cache.config = normaliseConfig(configDoc.value);
      await writeIfChanged(configPath, configDoc.raw, cache.config);

      const monitorsDoc = await readJson(monitorsPath, { monitors: [] });
      const stored = Array.isArray(monitorsDoc.value?.monitors) ? monitorsDoc.value.monitors : [];
      const monitors = stored.map((monitor) => normaliseStoredMonitor(monitor, cache.config)).filter(Boolean);
      cache.monitors = monitors;
      await writeIfChanged(monitorsPath, monitorsDoc.raw, { monitors });

      const stateDoc = await readJson(statePath, null);
      cache.state = normaliseState(stateDoc.value);
      await writeIfChanged(statePath, stateDoc.raw, cache.state);
    })().catch(() => {
      // A broken HOME must not stop the plugin from loading.
      cache.config = DEFAULT_CONFIG();
      cache.monitors = [];
      cache.state = DEFAULT_STATE();
    });
    return ready;
  }

  // #region config
  function getConfig() {
    return cache.config;
  }

  async function saveConfig(patch) {
    // Only keys the caller actually supplied may win: a partial settings POST
    // must not blank out unrelated fields with `undefined`.
    const defined = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (value !== undefined) defined[key] = value;
    }
    // l1 / l2 are deliberately not merged: a stale client sending them must not
    // resurrect the budget model. normaliseConfig drops the keys entirely.
    const notifyPatch = { ...(defined.notify && typeof defined.notify === 'object' ? defined.notify : {}) };
    // A2.2 §1：「App Secret 留空 = 不修改」。客户端永远拿不到明文，所以设置页
    // 保存其它字段时必然带着空 secret；这里必须忽略它而不是把已存值清掉。
    if (typeof notifyPatch.appSecret === 'string' && notifyPatch.appSecret === '') {
      delete notifyPatch.appSecret;
    }
    const merged = {
      ...cache.config,
      ...defined,
      cadence: { ...cache.config.cadence, ...(defined.cadence || {}) },
      notify: { ...cache.config.notify, ...notifyPatch },
    };
    cache.config = normaliseConfig(merged);
    await writeJsonAtomic(configPath, cache.config);
    return cache.config;
  }
  // #endregion

  // #region passengers
  function listPassengers() {
    return cache.config.passengers.slice();
  }

  function findPassenger(id) {
    return cache.config.passengers.find((item) => item.id === id);
  }

  async function addPassenger(input) {
    if (cache.config.passengers.length >= MAX_PASSENGERS) {
      throw new Error(`乘客数量已达上限（${MAX_PASSENGERS}）`);
    }
    const type = input.type === 'student' || input.type === 'child' ? input.type : 'adult';
    const passenger = {
      id: passengerId(),
      nickname: String(input.nickname || '').trim().slice(0, 24) || '乘客',
      type,
      age: Number.isFinite(Number(input.age)) ? Math.max(0, Math.min(120, Number(input.age))) : undefined,
      createdAt: isoNow(),
    };
    await saveConfig({ passengers: [...cache.config.passengers, passenger] });
    return passenger;
  }

  async function updatePassenger(id, input) {
    const index = cache.config.passengers.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = cache.config.passengers[index];
    const next = {
      ...current,
      nickname: input.nickname === undefined ? current.nickname : String(input.nickname).trim().slice(0, 24) || current.nickname,
      type: input.type === 'student' || input.type === 'child' || input.type === 'adult' ? input.type : current.type,
      age: input.age === undefined ? current.age : Number.isFinite(Number(input.age)) ? Number(input.age) : current.age,
    };
    const passengers = cache.config.passengers.slice();
    passengers[index] = next;
    await saveConfig({ passengers });
    return next;
  }

  async function removePassenger(id) {
    const referenced = cache.monitors.filter((monitor) => Array.isArray(monitor.passengerIds) && monitor.passengerIds.includes(id));
    if (referenced.length > 0) {
      const error = new Error('该乘客仍被监控任务引用，请先解除引用');
      error.code = 'PASSENGER_IN_USE';
      throw error;
    }
    const passengers = cache.config.passengers.filter((item) => item.id !== id);
    await saveConfig({ passengers });
    return true;
  }
  // #endregion

  // #region monitors
  function listMonitors() {
    return cache.monitors.slice();
  }

  function findMonitor(id) {
    return cache.monitors.find((item) => item.id === id);
  }

  async function saveMonitors() {
    await writeJsonAtomic(monitorsPath, { monitors: cache.monitors });
  }

  /**
   * Validate and normalise the route the caller wants to watch.
   * A missing `departDate` is legal: it means the calendar model (round trips
   * included), so only a dated trip needs `returnDate`.
   */
  function normaliseParams(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const trip = raw.trip === 'round' ? 'round' : 'oneway';
    const params = {
      trip,
      dep: cityCode(raw.dep),
      arr: cityCode(raw.arr),
      cabin: 'y_s',
    };
    if (params.dep.length !== 3 || params.arr.length !== 3) throw new Error('出发地/目的地需要是 3 位城市三字码（如 BJS、SHA）');
    if (params.dep === params.arr) throw new Error('出发地和目的地不能相同');

    const departDate = isDateString(raw.departDate) ? raw.departDate : '';
    if (raw.departDate !== undefined && raw.departDate !== null && raw.departDate !== '' && !departDate) {
      throw new Error('出发日期格式应为 YYYY-MM-DD');
    }

    if (departDate) {
      if (departDate < isoDate()) throw new Error('出发日期不能早于今天');
      params.departDate = departDate;
      if (trip === 'round') {
        if (!isDateString(raw.returnDate)) throw new Error('往返需要填写返回日期');
        if (raw.returnDate <= departDate) throw new Error('返回日期必须晚于出发日期');
        params.returnDate = raw.returnDate;
      }
    }
    return params;
  }

  /** Accept both the flat V2 body and the legacy `{ params: {...} }` shape. */
  function inputParams(input) {
    return input?.params && typeof input.params === 'object' ? input.params : input;
  }

  async function createMonitor(rawInput) {
    if (cache.monitors.length >= MAX_MONITORS) throw new Error(`监控任务已达上限（${MAX_MONITORS}）`);
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const params = normaliseParams(inputParams(input));
    const mode = monitorMode(params);
    const passengerIds = Array.isArray(input.passengerIds) ? input.passengerIds.filter((id) => findPassenger(id)) : [];
    // 行情模式按平台最低参考价，与乘客身份无关，允许留空；监控模式仍必须有人。
    if (mode === 'watch' && passengerIds.length === 0) throw new Error('监控模式至少选择一位乘客');
    const now = isoNow();
    const monitor = {
      id: monitorId(),
      type: 'flight',
      title: monitorTitle(params),
      enabled: true,
      mode,
      params,
      passengerIds,
      // 不传 cadence 就用该模式的全局默认（spec §1），存成统一的 minutes。
      // 没有 rules 字段：提醒规则随 rules.js 一起删除，卡片由每次采集后的投递负责。
      cadence: normaliseCadence(input.cadence, cache.config, mode),
      createdAt: now,
      updatedAt: now,
    };
    cache.monitors.push(monitor);
    await saveMonitors();
    return monitor;
  }

  /**
   * Hotel v1 creation (hotel spec §6.1). Local validation only — the remote
   * "does this hotel exist" check belongs to the scheduler action, which then
   * passes the resolved `hotelId`/`hotelName` in here. Re-validates everything
   * on purpose so a bypassing caller still cannot store garbage.
   */
  async function createHotelMonitor(rawInput) {
    if (cache.monitors.length >= MAX_MONITORS) throw new Error(`监控任务已达上限（${MAX_MONITORS}）`);
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const params = normaliseHotelParams(inputParams(input), { requireIdentity: true, requireFuture: true });
    const now = isoNow();
    const monitor = {
      id: hotelMonitorId(),
      type: 'hotel',
      mode: 'hotel',
      title: monitorTitle(params),
      enabled: true,
      params,
      passengerIds: [],
      cadence: normaliseCadence(input.cadence, cache.config, 'watch'),
      createdAt: now,
      updatedAt: now,
    };
    cache.monitors.push(monitor);
    await saveMonitors();
    return monitor;
  }

  /**
   * Local validation for the HTTP layer, exposed so `actions.createHotelMonitor`
   * can reject a bad body **before** it spends a network lookup.
   * Accepts the flat params object or `{ params:{...} }`; throws a plain Error.
   */
  function validateHotelInput(rawInput) {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    // 新建前只做本地校验（不查远端）：日期要合法且在未来，联想下拉带来的
    // 可选 hotelId / hotelName 也要先过格式（非法 → 路由 400）。
    return normaliseHotelParams(inputParams(input), {
      requireIdentity: false,
      requireFuture: true,
      validateOptionalIdentity: true,
    });
  }

  async function updateHotelMonitor(index, current, input) {
    const next = { ...current, updatedAt: isoNow() };
    if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
    if (input.params !== undefined) {
      // 改日期/人数：只做本地校验 + 重算 title，**不重新校验酒店**（id 已在库）。
      next.params = normaliseHotelParams(
        { ...current.params, ...inputParams(input.params) },
        { requireIdentity: false, requireFuture: false },
      );
      next.title = monitorTitle(next.params);
    }
    if (input.cadence !== undefined) next.cadence = normaliseCadence(input.cadence, cache.config, 'watch');
    // 酒店只有一种模式：任何路径都不能把它改成 calendar/watch。
    next.type = 'hotel';
    next.mode = 'hotel';
    next.passengerIds = [];
    cache.monitors[index] = next;
    await saveMonitors();
    return next;
  }

  async function updateMonitor(id, patch) {
    const index = cache.monitors.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const input = patch && typeof patch === 'object' ? patch : {};
    const current = cache.monitors[index];
    if (isHotelMonitor(current)) return updateHotelMonitor(index, current, input);
    const next = { ...current, updatedAt: isoNow() };

    if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
    if (input.passengerIds !== undefined) {
      next.passengerIds = Array.isArray(input.passengerIds) ? input.passengerIds.filter((pid) => findPassenger(pid)) : [];
    }
    if (input.params !== undefined) {
      next.params = normaliseParams({ ...current.params, ...inputParams(input.params) });
      next.mode = monitorMode(next.params);
      next.title = monitorTitle(next.params);
    }
    // `rules` 已被删除（A2 §1.2）：老客户端 PATCH 上来的 rules 直接忽略，不报错。
    delete next.rules;
    if (input.cadence !== undefined) next.cadence = normaliseCadence(input.cadence, cache.config, next.mode || monitorMode(next.params));

    // 与 createMonitor 同一规则：行情可以没有乘客，监控必须至少一位。只在这次
    // PATCH 动了乘客或日期（可能把 calendar 变成 watch）时校验，这样一份缺少
    // 乘客的老 watch 数据仍能被暂停/改节奏，不会在无关操作上被卡死。
    if (input.passengerIds !== undefined || input.params !== undefined) {
      if (next.mode === 'watch' && next.passengerIds.length === 0) throw new Error('监控模式至少选择一位乘客');
    }

    cache.monitors[index] = next;
    await saveMonitors();
    return next;
  }

  async function removeMonitor(id) {
    const before = cache.monitors.length;
    cache.monitors = cache.monitors.filter((item) => item.id !== id);
    if (cache.monitors.length === before) return false;
    await saveMonitors();
    // Snapshots and the series are per monitor: move them aside, never delete
    // in place, so a mistaken removal can still be recovered by hand.
    for (const path of [
      join(pricesDir, `${id}.jsonl`),
      join(calendarDir, `${id}.json`),
      join(flightsDir, `${id}.json`),
      join(hotelsDir, `${id}.json`),
    ]) {
      try {
        await rename(path, `${path}.removed`);
      } catch {
        /* the file may never have been written */
      }
    }
    // Drop this monitor's scheduler bookkeeping, otherwise `state.json` keeps a
    // dead entry per deleted monitor forever and grows without bound.
    const state = { ...cache.state };
    let touched = false;
    for (const field of ['nextDue', 'lastCollectBy', 'failures', 'lastError', 'l2LastRunBy', 'l2LastOk', 'calendarFetchedAt', 'delivery']) {
      if (state[field] && Object.prototype.hasOwnProperty.call(state[field], id)) {
        state[field] = { ...state[field] };
        delete state[field][id];
        touched = true;
      }
    }
    if (touched) await saveState(state);
    return true;
  }
  // #endregion

  // #region snapshots
  async function readCalendarSnapshot(id) {
    return (await readJson(join(calendarDir, `${id}.json`), null)).value;
  }

  async function writeCalendarSnapshot(id, snapshot) {
    const doc = {
      fetchedAt: typeof snapshot?.fetchedAt === 'string' ? snapshot.fetchedAt : isoNow(),
      out: Array.isArray(snapshot?.out) ? snapshot.out : [],
      back: Array.isArray(snapshot?.back) ? snapshot.back : null,
    };
    await writeJsonAtomic(join(calendarDir, `${id}.json`), doc);
    return doc;
  }

  async function readFlightsSnapshot(id) {
    const doc = (await readJson(join(flightsDir, `${id}.json`), null)).value;
    if (!doc || typeof doc !== 'object') return doc;
    // 老快照没有 D10-B 的表格数组：读取时也补成空数组，接口契约对客户端保持稳定。
    return { ...doc, roundTrip: normaliseRoundTrip(doc.roundTrip) };
  }

  /**
   * `lowest` = 本次采集的最低待支付价，卡片和面板都用它。
   * D10 起往返监控还可能带 `scheme: 'round'|'oneway'`（这个最低价来自哪种买法）。
   */
  function normaliseLowest(value) {
    if (!value || typeof value !== 'object') return null;
    const total = Number(value.total);
    if (!Number.isFinite(total) || total <= 0) return null;
    return {
      flightNo: typeof value.flightNo === 'string' ? value.flightNo : '',
      total: Math.round(total),
      scheme: value.scheme === 'round' || value.scheme === 'oneway' ? value.scheme : null,
    };
  }

  /**
   * 往返快照里的航班数组规范化（`oneway.outFlights` / `backFlights`，结构与
   * 主 `flights` 数组每项一致）。老快照没有这些字段 → 空数组。
   */
  function normaliseTripFlights(list) {
    if (!Array.isArray(list)) return [];
    const text = (raw) => (typeof raw === 'string' ? raw : '');
    const money = (raw) => (Number.isFinite(Number(raw)) && Number(raw) > 0 ? Math.round(Number(raw)) : null);
    return list
      .filter((item) => item && typeof item === 'object')
      .slice(0, 20)
      .map((flight) => ({
        no: text(flight.no),
        airline: text(flight.airline),
        craft: text(flight.craft),
        depTime: text(flight.depTime),
        arrTime: text(flight.arrTime),
        depAirport: text(flight.depAirport),
        arrAirport: text(flight.arrAirport),
        listPrice: money(flight.listPrice),
        taxIncluded: money(flight.taxIncluded),
        seats: Number.isInteger(flight.seats) ? flight.seats : null,
        soldOut: flight.soldOut === true,
        expanded: flight.expanded === true,
        prices: Array.isArray(flight.prices)
          ? flight.prices
            .filter((price) => price && typeof price === 'object')
            .map((price) => ({
              passengerId: text(price.passengerId),
              bare: money(price.bare),
              total: money(price.total),
              fareLabel: text(price.fareLabel).slice(0, 40),
            }))
          : [],
      }));
  }

  /**
   * D19：往返联程的组合数组（`roundTrip.combos`）。每条 = 一个去程 × 一个返程，
   * `payable` 为真实待支付价，null 表示该条没跑通（快照里 `error` 有原因）。
   * 老快照没有这个字段 → 空数组。
   */
  function normaliseCombos(list) {
    if (!Array.isArray(list)) return [];
    const text = (raw) => (typeof raw === 'string' ? raw : '');
    const money = (raw) => (Number.isFinite(Number(raw)) && Number(raw) > 0 ? Math.round(Number(raw)) : null);
    return list
      .filter((item) => item && typeof item === 'object')
      .slice(0, 20)
      .map((combo) => {
        const out = combo.out && typeof combo.out === 'object' ? combo.out : {};
        const ret = combo.ret && typeof combo.ret === 'object' ? combo.ret : {};
        return {
          out: {
            flightNo: text(out.flightNo),
            airline: text(out.airline),
            craft: text(out.craft),
            depTime: text(out.depTime),
            arrTime: text(out.arrTime),
            depAirport: text(out.depAirport),
            arrAirport: text(out.arrAirport),
            seats: Number.isInteger(out.seats) ? out.seats : null,
            soldOut: out.soldOut === true,
          },
          ret: {
            flightNo: text(ret.flightNo),
            airline: text(ret.airline),
            craft: text(ret.craft),
            depTime: text(ret.depTime),
            arrTime: text(ret.arrTime),
            depAirport: text(ret.depAirport),
            arrAirport: text(ret.arrAirport),
            listPrice: money(ret.listPrice),
          },
          listTotal: money(combo.listTotal),
          payable: money(combo.payable),
          payableSource: combo.payableSource === 'order' ? 'order' : 'list+tax',
          error: text(combo.error) ? text(combo.error).slice(0, 200) : null,
        };
      });
  }

  /**
   * D10-B：往返列表行（详情页「往返航班表」）。字段比单程航班少：没有产品价格，
   * 只有列表「往返总价（起）」与余票。
   */
  function normaliseRoundList(list) {
    if (!Array.isArray(list)) return [];
    const text = (raw) => (typeof raw === 'string' ? raw : '');
    const money = (raw) => (Number.isFinite(Number(raw)) && Number(raw) > 0 ? Math.round(Number(raw)) : null);
    return list
      .filter((item) => item && typeof item === 'object')
      .slice(0, 20)
      .map((row) => ({
        flightNo: text(row.flightNo),
        airline: text(row.airline),
        craft: text(row.craft),
        depTime: text(row.depTime),
        arrTime: text(row.arrTime),
        depAirport: text(row.depAirport),
        arrAirport: text(row.arrAirport),
        listTotal: money(row.listTotal),
        seats: Number.isInteger(row.seats) ? row.seats : null,
        soldOut: row.soldOut === true,
      }));
  }

  /**
   * D10 往返对比（`flights/<id>.json` 的 `roundTrip`）。
   *
   * 字段全部规范化成数字/字符串/null：快照要能被面板稳定读取，且老客户端遇到
   * 未知字段也不会崩。缺失的一头写 null，`partial` 明确告诉 UI「这不是完整对比」。
   * 四个数组（`combos` / `roundList` / `oneway.outFlights` / `oneway.backFlights`）在
   * 老快照里不存在，统一补成空数组，UI 可以直接遍历。
   */
  function normaliseRoundTrip(value) {
    if (!value || typeof value !== 'object') return null;
    const round = (raw) => (Number.isFinite(Number(raw)) && Number(raw) > 0 ? Math.round(Number(raw)) : null);
    const text = (raw) => (typeof raw === 'string' ? raw : '');
    const leg = (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const payable = round(raw.payable);
      if (payable === null) return null;
      return {
        payable,
        flightNo: text(raw.flightNo),
        depTime: text(raw.depTime),
        arrTime: text(raw.arrTime),
        depAirport: text(raw.depAirport),
        arrAirport: text(raw.arrAirport),
      };
    };
    const roundLeg = value.round && typeof value.round === 'object'
      ? {
        payable: round(value.round.payable),
        // order = 预订页真实总价；list = 只有列表起价；list+tax = 列表起价 + 两段实测税费估算。
        payableSource: ['order', 'list', 'list+tax'].includes(value.round.payableSource) ? value.round.payableSource : 'order',
        listTotal: round(value.round.listTotal),
        flightNo: text(value.round.flightNo),
        airline: text(value.round.airline),
        craft: text(value.round.craft),
        depTime: text(value.round.depTime),
        arrTime: text(value.round.arrTime),
        depAirport: text(value.round.depAirport),
        arrAirport: text(value.round.arrAirport),
        // 预订页为什么没读到（进不去 checkout / 读不到总价）：给排查用的原始原因。
        checkoutError: typeof value.round.checkoutError === 'string' && value.round.checkoutError
          ? value.round.checkoutError.slice(0, 200)
          : null,
        seats: Number.isInteger(value.round.seats) ? value.round.seats : null,
        soldOut: value.round.soldOut === true,
        return: value.round.return && typeof value.round.return === 'object'
          ? {
            flightNo: text(value.round.return.flightNo),
            depTime: text(value.round.return.depTime),
            arrTime: text(value.round.return.arrTime),
            depAirport: text(value.round.return.depAirport),
            arrAirport: text(value.round.return.arrAirport),
            listPrice: round(value.round.return.listPrice),
          }
          : null,
      }
      : null;
    const outLeg = leg(value.oneway?.out);
    const backLeg = leg(value.oneway?.back);
    const outFlights = normaliseTripFlights(value.oneway?.outFlights);
    const backFlights = normaliseTripFlights(value.oneway?.backFlights);
    const oneway = outLeg || backLeg || outFlights.length > 0 || backFlights.length > 0
      ? { out: outLeg, back: backLeg, sum: round(value.oneway?.sum), outFlights, backFlights }
      : null;
    const comparison = value.comparison && typeof value.comparison === 'object'
      ? {
        cheaper: ['round', 'oneway', 'tie'].includes(value.comparison.cheaper) ? value.comparison.cheaper : null,
        diff: round(value.comparison.diff) ?? 0,
        diffPct: Number.isFinite(Number(value.comparison.diffPct)) ? Number(value.comparison.diffPct) : null,
        minTotal: round(value.comparison.minTotal),
        maxTotal: round(value.comparison.maxTotal),
      }
      : null;
    return {
      partial: value.partial === true,
      // D19：Top3×Top3 组合；老快照没有这个字段 → 空数组（客户端不用判空）。
      combos: normaliseCombos(value.combos),
      // D10-B：往返列表前 ≤10 行；老快照没有这个字段 → 空数组（客户端不用判空）。
      roundList: normaliseRoundList(value.roundList),
      round: roundLeg && roundLeg.payable !== null ? roundLeg : null,
      oneway,
      comparison,
      errors: {
        round: text(value.errors?.round) || null,
        out: text(value.errors?.out) || null,
        back: text(value.errors?.back) || null,
      },
    };
  }

  async function writeFlightsSnapshot(id, snapshot) {
    const doc = {
      fetchedAt: typeof snapshot?.fetchedAt === 'string' ? snapshot.fetchedAt : isoNow(),
      tax: snapshot?.tax && typeof snapshot.tax === 'object' ? snapshot.tax : null,
      lowest: normaliseLowest(snapshot?.lowest),
      // D10：往返监控的「联程 vs 两段单买」对比；单程监控恒为 null。
      roundTrip: normaliseRoundTrip(snapshot?.roundTrip),
      flights: Array.isArray(snapshot?.flights) ? snapshot.flights : [],
    };
    await writeJsonAtomic(join(flightsDir, `${id}.json`), doc);
    return doc;
  }
  // #endregion

  // #region hotel snapshots
  /** 金额：正整数元；无效返回 null。 */
  function hotelMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  /** 文本字段：去空白、限长；空串/非字符串 → null。 */
  function hotelText(value, max = 120) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text ? text.slice(0, max) : null;
  }

  /** 契约 §3 的酒店信息，字段齐全、类型稳定。 */
  function normaliseHotelInfo(value) {
    const input = value && typeof value === 'object' ? value : {};
    const star = Number(input.star);
    const score = Number(input.score);
    return {
      id: input.id === undefined || input.id === null ? '' : String(input.id).trim().slice(0, 64),
      name: hotelText(input.name) || '',
      star: Number.isFinite(star) && star > 0 ? Math.round(star) : null,
      score: Number.isFinite(score) && score > 0 ? Math.round(score * 10) / 10 : null,
      scoreLabel: hotelText(input.scoreLabel, 20),
      address: hotelText(input.address, 200),
      district: hotelText(input.district, 60),
      cityName: hotelText(input.cityName, 20),
    };
  }

  /**
   * 契约 §3 的房型数组：只留「有名字 + 可订 + 整段总价有效」的房型，按整段
   * 总价升序；未知/残缺房型直接丢弃（面板和卡片都不该出现占位脏行）。
   * `nightly` 缺省时用 `total / nights` 取整补齐（契约的价格口径）。
   */
  function normaliseHotelRooms(list, nights) {
    if (!Array.isArray(list)) return [];
    const rooms = [];
    for (const room of list) {
      if (!room || typeof room !== 'object') continue;
      const name = hotelText(room.name, 60);
      if (!name) continue;
      if (room.bookable === false) continue;
      const total = hotelMoney(room.price?.total);
      if (total === null) continue;
      const nightly = hotelMoney(room.price?.nightly) ?? (nights > 0 ? Math.round(total / nights) : total);
      // 「数字转整数」：采集器若给了数字字符串也收下，非法值给 null。
      const left = Number.isFinite(Number(room.left)) ? Math.max(0, Math.round(Number(room.left))) : null;
      rooms.push({
        id: room.id === undefined || room.id === null ? '' : String(room.id).slice(0, 40),
        name,
        bed: hotelText(room.bed, 40),
        area: hotelText(room.area, 20),
        window: room.window === true ? true : room.window === false ? false : null,
        // v1 不区分含早/可取消（契约 §3）：恒为 null，别让采集器顺手塞值。
        breakfast: null,
        cancellable: null,
        left,
        bookable: true,
        price: { nightly, total },
      });
    }
    rooms.sort((a, b) => a.price.total - b.price.total);
    return rooms;
  }

  /**
   * 契约 §3 快照白名单。未知字段全部丢弃，数字转整数，`lowest` 缺省用
   * `rooms[0]` 补齐；`rooms` 只作为**房型数组**落盘（契约 §3 的示例里同名
   * 数字型 key 是笔误，间数口径由 `monitor.params.rooms` 承担）。
   */
  function normaliseHotelSnapshot(snapshot) {
    const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const checkIn = isDateString(input.checkIn) ? input.checkIn : '';
    const checkOut = isDateString(input.checkOut) ? input.checkOut : '';
    const computedNights = nightsBetween(checkIn, checkOut);
    const nights = computedNights !== null && computedNights > 0
      ? computedNights
      : Math.max(0, Math.round(Number(input.nights) || 0));
    const rooms = normaliseHotelRooms(input.rooms, nights);
    const first = rooms[0] || null;
    const lowestInput = input.lowest && typeof input.lowest === 'object' ? input.lowest : null;
    const lowestTotal = hotelMoney(lowestInput?.total) ?? (first ? first.price.total : null);
    const lowest = lowestTotal === null
      ? null
      : {
        roomId: typeof lowestInput?.roomId === 'string' && lowestInput.roomId
          ? lowestInput.roomId
          : (first ? first.id : ''),
        roomName: typeof lowestInput?.roomName === 'string' && lowestInput.roomName
          ? lowestInput.roomName
          : (first ? first.name : ''),
        nightly: hotelMoney(lowestInput?.nightly) ?? (nights > 0 ? Math.round(lowestTotal / nights) : lowestTotal),
        total: lowestTotal,
      };
    return {
      fetchedAt: typeof input.fetchedAt === 'string' ? input.fetchedAt : isoNow(),
      checkIn,
      checkOut,
      nights,
      adults: clampAdults(input.adults),
      source: typeof input.source === 'string' && input.source ? input.source.slice(0, 20) : 'ctrip',
      hotel: normaliseHotelInfo(input.hotel),
      rooms,
      lowest,
    };
  }

  async function readHotelSnapshot(id) {
    const doc = (await readJson(join(hotelsDir, `${id}.json`), null)).value;
    if (!doc || typeof doc !== 'object') return null;
    return normaliseHotelSnapshot(doc);
  }

  async function writeHotelSnapshot(id, snapshot) {
    const doc = normaliseHotelSnapshot(snapshot);
    await writeJsonAtomic(join(hotelsDir, `${id}.json`), doc);
    return doc;
  }
  // #endregion

  // #region state
  function getState() {
    return cache.state;
  }

  async function saveState(patch) {
    cache.state = { ...cache.state, ...patch };
    await writeJsonAtomic(statePath, cache.state);
    return cache.state;
  }
  // #endregion

  // #region price series
  function seriesPath(id) {
    return join(pricesDir, `${id}.jsonl`);
  }

  async function appendPoints(id, points) {
    if (!Array.isArray(points) || points.length === 0) return;
    const lines = points.map((point) => JSON.stringify(point)).join('\n') + '\n';
    await appendFile(seriesPath(id), lines, 'utf8');
  }

  async function readPoints(id, options = {}) {
    const since = options.since ? Date.parse(options.since) : 0;
    const limit = Math.min(MAX_POINTS, numberOr(options.limit, MAX_POINTS));
    let raw = '';
    try {
      raw = await readFile(seriesPath(id), 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const point = JSON.parse(line);
        if (!point || typeof point.at !== 'string') continue;
        if (since && Date.parse(point.at) < since) continue;
        out.push(point);
      } catch {
        /* skip a torn line */
      }
    }
    return out.slice(-limit);
  }

  async function readAllPoints(id) {
    return readPoints(id, { limit: MAX_POINTS });
  }
  // #endregion

  // #region delivery log
  /**
   * Append one delivery attempt to `alerts.jsonl` (the file keeps its historical
   * name; the payload is the A2 delivery record, not an alert).
   *
   * Fields are fixed so `/deliveries` can document one shape:
   * `{ monitorId, title, kind, at, ok, error }`.
   */
  async function appendDelivery(entry) {
    const line = JSON.stringify({
      monitorId: String(entry?.monitorId || ''),
      title: String(entry?.title || ''),
      kind: DELIVERY_KINDS.includes(entry?.kind) ? entry.kind : 'calendar',
      at: typeof entry?.at === 'string' ? entry.at : isoNow(),
      ok: entry?.ok === true,
      error: typeof entry?.error === 'string' ? entry.error : null,
    }) + '\n';
    await appendFile(alertsPath, line, 'utf8').catch(() => {});
    try {
      const info = await stat(alertsPath);
      if (info.size > 4 * 1024 * 1024) {
        const raw = await readFile(alertsPath, 'utf8');
        const kept = raw.trim().split('\n').slice(-MAX_DELIVERIES);
        await writeFile(alertsPath, kept.join('\n') + '\n', 'utf8');
      }
    } catch {
      /* compaction is best effort */
    }
    return entry;
  }

  /** Newest first, at most 200 per call. */
  async function readDeliveries(limit = 50) {
    let raw = '';
    try {
      raw = await readFile(alertsPath, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        // The file predates the A2 delivery log: old alert records carry no
        // `kind`, and showing them as blank rows in the panel is worse than
        // dropping them. New entries always have kind + at.
        if (!entry || typeof entry.kind !== 'string' || typeof entry.at !== 'string') continue;
        out.push(entry);
      } catch {
        /* skip a torn line */
      }
    }
    return out.slice(-Math.max(1, Math.min(200, limit))).reverse();
  }
  // #endregion

  // #region storage 统计与清理
  /** 目录读取：不存在 → `[]`；其它错误（权限等）→ `null`，调用方降级。 */
  async function readDirEntries(dir) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      return error?.code === 'ENOENT' ? [] : null;
    }
  }

  /**
   * 一个目录里「直接子文件」的数量与字节数。只统计文件，不递归（目录结构是固定的
   * 一层：prices/calendar/flights 都是平铺的）。读不到目录 → 0（降级，不抛）。
   */
  async function dirStats(dir, accept) {
    const stats = { files: 0, bytes: 0 };
    const entries = await readDirEntries(dir);
    if (!Array.isArray(entries)) return stats;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (typeof accept === 'function' && !accept(entry.name)) continue;
      try {
        const info = await stat(join(dir, entry.name));
        stats.files += 1;
        stats.bytes += info.size;
      } catch {
        /* 文件在统计过程中消失了：跳过 */
      }
    }
    return stats;
  }

  /**
   * `browser-profile/` 的大小。
   *
   * 为什么不直接递归：Chrome 的 profile 有几万个文件，面板点一次「存储」就扫一遍
   * 会把 Host 卡住。这里限制深度 3、条目 6000：正常 profile 能算出一个近似值；
   * 超限就直接返回 `null`（面板显示「—」），宁可少报也不拖住。
   */
  async function profileSize() {
    const MAX_ENTRIES = 6000;
    const MAX_DEPTH = 3;
    const rootProfile = join(rootDir, 'browser-profile');
    let bytes = 0;
    let entries = 0;
    const stack = [{ dir: rootProfile, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop();
      const list = await readDirEntries(dir);
      if (!Array.isArray(list)) return null;
      for (const entry of list) {
        entries += 1;
        if (entries > MAX_ENTRIES) return null;
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH) stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          bytes += (await stat(join(dir, entry.name))).size;
        } catch {
          /* ignore */
        }
      }
    }
    return { bytes };
  }

  /** 所有 `*.removed` 残留（根目录 + 四个数据目录）。 */
  async function removedStats() {
    const isRemoved = (name) => name.endsWith('.removed');
    const parts = await Promise.all([rootDir, pricesDir, calendarDir, flightsDir, hotelsDir].map((dir) => dirStats(dir, isRemoved)));
    return parts.reduce((sum, part) => ({ files: sum.files + part.files, bytes: sum.bytes + part.bytes }), { files: 0, bytes: 0 });
  }

  /**
   * `GET /api/storage` 的数据源。任何统计失败都降级成 0 / null，绝不抛——
   * 存储面板拿不到数字也不该让设置页报错。
   */
  async function storageReport() {
    const stats = { dataDir: rootDir, totalBytes: 0, totalFiles: 0 };
    try {
      // 分类统计里排除 `.removed`：残留在 `removed` 桶里单独算，否则总占用会重复计数。
      const notRemoved = (name) => !name.endsWith('.removed');
      const rootFiles = await dirStats(rootDir, (name) => /\.(json|jsonl)$/.test(name));
      const prices = await dirStats(pricesDir, notRemoved);
      const calendar = await dirStats(calendarDir, notRemoved);
      const flights = await dirStats(flightsDir, notRemoved);
      const hotels = await dirStats(hotelsDir, notRemoved);
      const removed = await removedStats();
      let profileBytes = null;
      try {
        profileBytes = (await profileSize())?.bytes ?? null;
      } catch {
        profileBytes = null;
      }
      const buckets = { root: rootFiles, prices, calendar, flights, hotels };
      let totalBytes = 0;
      let totalFiles = 0;
      for (const part of Object.values(buckets)) {
        totalBytes += part.bytes;
        totalFiles += part.files;
      }
      // `.removed` 残留不计入上面四个分类桶（避免重复计数），但确实占磁盘，单加成总量。
      totalBytes += removed.bytes;
      totalFiles += removed.files;
      return {
        ...stats,
        totalBytes,
        totalFiles,
        removed,
        prices: { files: prices.files, bytes: prices.bytes },
        calendar: { files: calendar.files, bytes: calendar.bytes },
        flights: { files: flights.files, bytes: flights.bytes },
        // v0.15 酒店快照目录：additive 键，老客户端读不到就忽略（挡不住谎报占用）。
        hotels: { files: hotels.files, bytes: hotels.bytes },
        profileBytes,
      };
    } catch {
      return { ...stats, totalBytes: 0, totalFiles: 0, removed: { files: 0, bytes: 0 }, prices: { files: 0, bytes: 0 }, calendar: { files: 0, bytes: 0 }, flights: { files: 0, bytes: 0 }, hotels: { files: 0, bytes: 0 }, profileBytes: null };
    }
  }

  /**
   * `POST /api/storage/cleanup`：删除根目录与四个数据目录里的 `*.removed`。
   *
   * 安全约束（写死在这里，路由层不需要也不允许放宽）：
   *  - 只删文件名以 `.removed` 结尾的**普通文件**，其它一律不碰；
   *  - 逐个容错：一个删不掉（权限/被占用）只把 failed 加一，继续删下一个；
   *  - 删除前先取大小，用于汇报「释放了多少字节」。
   */
  async function cleanupStorage() {
    let removed = 0;
    let freedBytes = 0;
    let failed = 0;
    for (const dir of [rootDir, pricesDir, calendarDir, flightsDir, hotelsDir]) {
      const entries = await readDirEntries(dir);
      if (!Array.isArray(entries)) {
        failed += 1;
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.removed')) continue;
        const path = join(dir, entry.name);
        try {
          const info = await stat(path);
          await rm(path, { force: true });
          removed += 1;
          freedBytes += info.size;
        } catch {
          failed += 1;
        }
      }
    }
    return { removed, freedBytes, failed };
  }
  // #endregion

  return {
    rootDir,
    init,
    getConfig,
    saveConfig,
    listPassengers,
    findPassenger,
    addPassenger,
    updatePassenger,
    removePassenger,
    listMonitors,
    findMonitor,
    createMonitor,
    createHotelMonitor,
    validateHotelInput,
    updateMonitor,
    removeMonitor,
    readCalendarSnapshot,
    writeCalendarSnapshot,
    readFlightsSnapshot,
    writeFlightsSnapshot,
    readHotelSnapshot,
    writeHotelSnapshot,
    getState,
    saveState,
    appendPoints,
    readPoints,
    readAllPoints,
    appendDelivery,
    readDeliveries,
    storageReport,
    cleanupStorage,
    today: () => isoDate(),
  };
}
