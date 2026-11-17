/**
 * Persistence for price-watch.
 *
 * Everything lives under `$DSH_HOME/price-watch/`, never in the project
 * directory:
 *
 *   config.json      passengers, the two global cadences, notification settings
 *   monitors.json    the watched routes, each either `calendar` or `watch`
 *   state.json       scheduler cursors, last-run marks, alert bookkeeping
 *   prices/*.jsonl   one append-only series per watch monitor (L2 points only)
 *   calendar/*.json  latest full calendar snapshot per calendar monitor
 *   flights/*.json   latest browser flight list per watch monitor
 *   alerts.jsonl     recent deliveries
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
 * Migration is idempotent: `init()` reads, folds every historical shape into the
 * current one and writes back only when the serialised document really changed,
 * so a second `init()` on migrated files performs no write at all.
 *
 *   config   `cadence.calendarHours` → `calendarMinutes` (×60); the legacy
 *            `cadence.watchMinutes` / `cadence.l1Minutes` → `watchMinutes`
 *            (clamped); the dead `l1` / `l2` / `notify.quietHours` blocks are
 *            dropped because nothing reads them any more.
 *   monitor  `cadence.hours` → `minutes` (×60); `cadence.minutes` kept; all
 *            clamped to the shared tier list.
 *   state    `l1Runs` / `l2Runs` / `l2Backoff` / `l2DisabledForDay` /
 *            `l1BlockedUntil` / `l1FailCount` / `l2BlockedUntil` are dropped
 *            (they describe a model that no longer exists); every field the
 *            scheduler and the rules still need is kept as-is.
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  cityCode,
  isDateString,
  isoDate,
  isoNow,
  monitorId,
  monitorMode,
  monitorTitle,
  numberOr,
  passengerId,
} from './util.js';

/** How many price points a single series read may return. */
const MAX_POINTS = 5000;
/** How many alerts are kept on disk. */
const MAX_ALERTS = 5000;
/** Hard cap on watched routes. */
export const MAX_MONITORS = 20;
export const MAX_PASSENGERS = 12;

/**
 * The one and only cadence ladder, in minutes, shared by both modes:
 * 30 分钟 / 1 小时 / 3 小时 / 6 小时 / 12 小时 / 24 小时.
 * A value between two tiers is clamped *up* (120 → 180, 240 → 360) so a user
 * request is never silently made more frequent than asked for.
 */
export const CADENCE_MINUTES = [30, 60, 180, 360, 720, 1440];

/** Global defaults picked by the user: calendar 6h, watch 6h. */
const DEFAULT_CADENCE = { calendarMinutes: 360, watchMinutes: 360 };

/** Default rules for a dated monitor; a calendar monitor always has none. */
const DEFAULT_WATCH_RULES = () => [{ kind: 'new_low' }, { kind: 'new_high' }];

// #region normalisation helpers
const DEFAULT_CONFIG = () => ({
  passengers: [],
  cadence: { ...DEFAULT_CADENCE },
  notify: {
    feishuWebhook: '',
    // Still patchable through the API, but no longer surfaced in the UI.
    cooldownMinutes: 360,
    digestAt: '09:00',
  },
  panelBaseUrl: '',
});

/**
 * State that survives v2. Written in a fixed key order so that the document
 * round-trips byte-identically through `normaliseState()`.
 */
const DEFAULT_STATE = () => ({
  lastCollectAt: null,
  lastCollectBy: {},
  auth: { status: 'unknown', lastVerifiedAt: null, accountHint: '' },
  nextDue: {},
  calendarFetchedAt: {},
  l2LastRunBy: {},
  l2LastOk: {},
  l2LastError: null,
  cooldowns: {},
  dayFired: {},
  sides: {},
  lastDigest: null,
  lastError: {},
  failures: {},
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
  const notify = {
    feishuWebhook: typeof inputNotify.feishuWebhook === 'string' ? inputNotify.feishuWebhook : base.notify.feishuWebhook,
    cooldownMinutes: Math.max(0, finiteOrNull(inputNotify.cooldownMinutes) ?? base.notify.cooldownMinutes),
    digestAt: /^\d{1,2}:\d{2}$/.test(String(inputNotify.digestAt || '')) ? String(inputNotify.digestAt) : base.notify.digestAt,
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

/**
 * Lenient monitor upgrade: anything read from disk must survive even if it has
 * no `mode` (M1/M2 schema) or half-valid params. Never throws.
 */
function normaliseStoredMonitor(monitor, config) {
  if (!monitor || typeof monitor !== 'object' || !monitor.id) return null;
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
    rules: mode === 'calendar' ? [] : Array.isArray(monitor.rules) ? monitor.rules : [],
    cadence: normaliseCadence(monitor.cadence, config, mode),
  };
  // An empty rules list is a legitimate choice (track the price, stay silent),
  // so an upgrade must not resurrect defaults here.
  return next;
}

/**
 * Keep exactly the state fields frequency model v2 still reads.
 *
 * This is a whitelist on purpose: spreading the raw document would preserve
 * `l1Runs`, `l2Backoff`, `l2DisabledForDay`, … forever, and a dead field that
 * keeps being written looks authoritative to the next reader. Dropping unknown
 * keys is safe here because every one of them belonged to the budget/backoff
 * model that no longer exists.
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
    cooldowns: obj(input.cooldowns, {}),
    dayFired: obj(input.dayFired, {}),
    sides: obj(input.sides, {}),
    lastDigest: isoOrNull(input.lastDigest),
    lastError: obj(input.lastError, {}),
    failures: obj(input.failures, {}),
  };
}
// #endregion

export function createStore(rootDir) {
  const pricesDir = join(rootDir, 'prices');
  const calendarDir = join(rootDir, 'calendar');
  const flightsDir = join(rootDir, 'flights');
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
    const merged = {
      ...cache.config,
      ...defined,
      cadence: { ...cache.config.cadence, ...(defined.cadence || {}) },
      notify: { ...cache.config.notify, ...(defined.notify || {}) },
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

  function normaliseRules(input) {
    const rules = [];
    if (!Array.isArray(input)) return rules;
    for (const rule of input) {
      if (!rule || typeof rule !== 'object') continue;
      if (rule.kind === 'target') {
        const value = numberOr(rule.value, NaN);
        if (Number.isFinite(value) && value > 0) rules.push({ kind: 'target', value: Math.round(value) });
      } else if (rule.kind === 'new_low' || rule.kind === 'new_high' || rule.kind === 'digest') {
        rules.push({ kind: rule.kind });
      }
    }
    return rules;
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
    const rules = mode === 'calendar'
      ? []
      : input.rules === undefined
        ? DEFAULT_WATCH_RULES()
        : normaliseRules(input.rules);
    const now = isoNow();
    const monitor = {
      id: monitorId(),
      type: 'flight',
      title: monitorTitle(params),
      enabled: true,
      mode,
      params,
      passengerIds,
      rules,
      // 不传 cadence 就用该模式的全局默认（spec §1），存成统一的 minutes。
      cadence: normaliseCadence(input.cadence, cache.config, mode),
      createdAt: now,
      updatedAt: now,
    };
    cache.monitors.push(monitor);
    await saveMonitors();
    return monitor;
  }

  async function updateMonitor(id, patch) {
    const index = cache.monitors.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const input = patch && typeof patch === 'object' ? patch : {};
    const current = cache.monitors[index];
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
    if (input.rules !== undefined) {
      next.rules = next.mode === 'calendar' ? [] : normaliseRules(input.rules);
    } else if (next.mode === 'calendar') {
      next.rules = [];
    } else if (current.mode === 'calendar') {
      next.rules = DEFAULT_WATCH_RULES();
    }
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
    for (const path of [join(pricesDir, `${id}.jsonl`), join(calendarDir, `${id}.json`), join(flightsDir, `${id}.json`)]) {
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
    for (const field of ['nextDue', 'lastCollectBy', 'failures', 'lastError', 'l2LastRunBy', 'l2LastOk', 'calendarFetchedAt']) {
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
    return (await readJson(join(flightsDir, `${id}.json`), null)).value;
  }

  async function writeFlightsSnapshot(id, snapshot) {
    const doc = {
      fetchedAt: typeof snapshot?.fetchedAt === 'string' ? snapshot.fetchedAt : isoNow(),
      flights: Array.isArray(snapshot?.flights) ? snapshot.flights : [],
      tax: snapshot?.tax && typeof snapshot.tax === 'object' ? snapshot.tax : null,
    };
    await writeJsonAtomic(join(flightsDir, `${id}.json`), doc);
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

  // #region alerts
  async function appendAlert(alert) {
    const line = JSON.stringify(alert) + '\n';
    await appendFile(alertsPath, line, 'utf8').catch(() => {});
    try {
      const info = await stat(alertsPath);
      if (info.size > 4 * 1024 * 1024) {
        const raw = await readFile(alertsPath, 'utf8');
        const kept = raw.trim().split('\n').slice(-MAX_ALERTS);
        await writeFile(alertsPath, kept.join('\n') + '\n', 'utf8');
      }
    } catch {
      /* compaction is best effort */
    }
    return alert;
  }

  async function readAlerts(limit = 50) {
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
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return out.slice(-Math.max(1, Math.min(200, limit))).reverse();
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
    updateMonitor,
    removeMonitor,
    readCalendarSnapshot,
    writeCalendarSnapshot,
    readFlightsSnapshot,
    writeFlightsSnapshot,
    getState,
    saveState,
    appendPoints,
    readPoints,
    readAllPoints,
    appendAlert,
    readAlerts,
    today: () => isoDate(),
  };
}
