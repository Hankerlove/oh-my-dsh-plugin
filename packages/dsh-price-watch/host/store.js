/**
 * Persistence for price-watch.
 *
 * Everything lives under `$DSH_HOME/price-watch/`, never in the project
 * directory:
 *
 *   config.json      passengers, cadence, daily budgets, notification settings
 *   monitors.json    the watched routes, each either `calendar` or `watch`
 *   state.json       scheduler cursors, budgets, L2 backoff, day-fire marks
 *   prices/*.jsonl   one append-only series per watch monitor
 *   calendar/*.json  latest full calendar snapshot per calendar monitor
 *   flights/*.json   latest browser flight list per watch monitor
 *   alerts.jsonl     recent deliveries
 *
 * JSON documents are written through a temp file + rename so a crash mid-write
 * cannot truncate them. A document that fails to parse is moved aside to
 * `<name>.bak` and replaced by defaults: a corrupted file must degrade the
 * panel, never block the plugin.
 *
 * The two on-disk schemas from M1/M2 are migrated in `init()` and written back
 * once (idempotent): `cadence.l1Minutes` is folded into `cadence.watchMinutes`,
 * the missing `l1` / `l2.minIntervalMinutes` fields are filled in, and the old
 * `state.l2BlockedUntil` is inherited as `state.l2Backoff` so a running cooldown
 * is not lost on upgrade.
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

/** Cadence buckets offered by the V2 model. 15 minutes no longer exists. */
const CALENDAR_HOURS = [3, 6, 12, 24];
const WATCH_MINUTES = [30, 60, 120, 240];
/** Default rules for a dated monitor; a calendar monitor always has none. */
const DEFAULT_WATCH_RULES = () => [{ kind: 'new_low' }, { kind: 'new_high' }];

// #region normalisation helpers
const DEFAULT_CONFIG = () => ({
  passengers: [],
  cadence: { calendarHours: 6, watchMinutes: 60 },
  l1: { perDay: 200 },
  // L2 (browser) collection: off until the user logs in and opts in.
  l2: { enabled: false, perDay: 3, minIntervalMinutes: 720 },
  notify: {
    feishuWebhook: '',
    quietHours: [22, 8],
    cooldownMinutes: 360,
    digestAt: '09:00',
  },
  panelBaseUrl: '',
});

const DEFAULT_STATE = () => ({
  lastCollectAt: null,
  lastCollectBy: {},
  auth: { status: 'unknown', lastVerifiedAt: null, accountHint: '' },
  // V2 scheduler cursors and budgets.
  nextDue: {},
  l1Runs: { date: '', count: 0 },
  l1BlockedUntil: null,
  l1FailCount: 0,
  l2Runs: { date: '', count: 0 },
  l2Backoff: { level: 0, until: null, trippedDate: null },
  l2DisabledForDay: null,
  l2LastRunBy: {},
  l2LastOk: {},
  calendarFetchedAt: {},
  l2LastError: null,
  // M1/M2 fields kept as-is.
  cooldowns: {},
  dayFired: {},
  sides: {},
  lastDigest: null,
  lastError: {},
  failures: {},
});

/** Round a number up to the nearest allowed bucket (15 → 30, 90 → 120, …). */
function clampUp(value, choices, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return choices.find((choice) => choice >= n) ?? choices[choices.length - 1];
}

/** A non-negative integer, or the fallback. */
function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Fold every accepted config shape into the current schema.
 * `cadence.l1Minutes` is V2's removed field: its value is carried over to
 * `watchMinutes` (rounded up) and then dropped.
 */
function normaliseConfig(raw) {
  const base = DEFAULT_CONFIG();
  const input = raw && typeof raw === 'object' ? raw : {};
  const inputCadence = input.cadence && typeof input.cadence === 'object' ? input.cadence : {};
  const legacyMinutes = inputCadence.watchMinutes === undefined ? inputCadence.l1Minutes : inputCadence.watchMinutes;
  const cadence = {
    calendarHours: CALENDAR_HOURS.includes(Number(inputCadence.calendarHours))
      ? Number(inputCadence.calendarHours)
      : base.cadence.calendarHours,
    watchMinutes: clampUp(legacyMinutes, WATCH_MINUTES, base.cadence.watchMinutes),
  };

  const inputL1 = input.l1 && typeof input.l1 === 'object' ? input.l1 : {};
  const l1 = { perDay: positiveInt(inputL1.perDay, base.l1.perDay) };

  const inputL2 = input.l2 && typeof input.l2 === 'object' ? input.l2 : {};
  const l2 = {
    enabled: inputL2.enabled === undefined ? base.l2.enabled : Boolean(inputL2.enabled),
    perDay: positiveInt(inputL2.perDay, base.l2.perDay),
    // The minimum gap between two L2 runs is free-form (720 = twice a day);
    // only negative/garbage input falls back to the default.
    minIntervalMinutes: positiveInt(inputL2.minIntervalMinutes, base.l2.minIntervalMinutes),
  };

  const passengers = Array.isArray(input.passengers) ? input.passengers.filter((item) => item && typeof item === 'object' && item.id) : [];

  return {
    passengers,
    cadence,
    l1,
    l2,
    notify: { ...base.notify, ...(input.notify && typeof input.notify === 'object' ? input.notify : {}) },
    panelBaseUrl: typeof input.panelBaseUrl === 'string' ? input.panelBaseUrl : '',
  };
}

/** Cadence stored on a monitor only carries the watch interval, in minutes. */
/**
 * Per-monitor cadence. Calendar monitors carry hours, watch monitors minutes;
 * both fall back to the global default so an old monitor keeps working.
 */
function normaliseCadence(input, config, mode = 'watch') {
  const raw = input && typeof input === 'object' ? input : {};
  if (mode === 'calendar') {
    const value = raw.hours !== undefined ? raw.hours : raw.calendarHours;
    const fallback = Number(config?.cadence?.calendarHours) || DEFAULT_CONFIG().cadence.calendarHours;
    return { hours: clampUp(value, CALENDAR_HOURS, fallback) };
  }
  const value = raw.minutes !== undefined ? raw.minutes : raw.l1Minutes;
  const fallback = Number(config?.cadence?.watchMinutes) || DEFAULT_CONFIG().cadence.watchMinutes;
  return { minutes: clampUp(value, WATCH_MINUTES, fallback) };
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
    passengerIds: Array.isArray(monitor.passengerIds) ? monitor.passengerIds.filter((id) => typeof id === 'string') : [],
    rules: mode === 'calendar' ? [] : Array.isArray(monitor.rules) ? monitor.rules : [],
    cadence: normaliseCadence(monitor.cadence, config, mode),
  };
  // An empty rules list is a legitimate choice (track the price, stay silent),
  // so an upgrade must not resurrect defaults here.
  return next;
}

/** Keep a running L2 backoff and inherit the pre-V2 `l2BlockedUntil`. */
function normaliseState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const base = DEFAULT_STATE();
  const state = { ...base, ...input };
  const pick = (value, fallback) => (value && typeof value === 'object' ? value : fallback);
  state.nextDue = pick(input.nextDue, {});
  state.l1Runs = pick(input.l1Runs, base.l1Runs);
  state.l2Runs = pick(input.l2Runs, base.l2Runs);
  state.l2Backoff = pick(input.l2Backoff, base.l2Backoff);
  state.l2LastRunBy = pick(input.l2LastRunBy, {});
  state.l2LastOk = pick(input.l2LastOk, {});
  state.calendarFetchedAt = pick(input.calendarFetchedAt, {});
  state.cooldowns = pick(input.cooldowns, {});
  state.dayFired = pick(input.dayFired, {});
  state.sides = pick(input.sides, {});
  state.lastError = pick(input.lastError, {});
  state.failures = pick(input.failures, {});
  state.lastCollectBy = pick(input.lastCollectBy, {});

  // The M2 field was a single ISO string; V2 needs the whole backoff record.
  // Inheriting it is mandatory: dropping it would let the first tick hammer
  // Ctrip while the previous cooldown is still running.
  const legacy = typeof input.l2BlockedUntil === 'string' ? Date.parse(input.l2BlockedUntil) : NaN;
  const currentUntil = typeof state.l2Backoff?.until === 'string' ? Date.parse(state.l2Backoff.until) : NaN;
  if (Number.isFinite(legacy) && !(Number.isFinite(currentUntil) && currentUntil >= legacy)) {
    state.l2Backoff = {
      level: Math.max(1, Math.floor(Number(state.l2Backoff?.level) || 0)),
      until: new Date(legacy).toISOString(),
      trippedDate: isDateString(state.l2Backoff?.trippedDate) ? state.l2Backoff.trippedDate : isoDate(new Date(legacy)),
    };
  }
  if ('l2BlockedUntil' in state) delete state.l2BlockedUntil;
  return state;
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
    const merged = {
      ...cache.config,
      ...defined,
      cadence: { ...cache.config.cadence, ...(defined.cadence || {}) },
      l1: { ...cache.config.l1, ...(defined.l1 || {}) },
      l2: { ...cache.config.l2, ...(defined.l2 || {}) },
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
    if (passengerIds.length === 0) throw new Error('至少选择一位乘客');
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
      const ids = input.passengerIds.filter((pid) => findPassenger(pid));
      if (ids.length === 0) throw new Error('至少选择一位乘客');
      next.passengerIds = ids;
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
