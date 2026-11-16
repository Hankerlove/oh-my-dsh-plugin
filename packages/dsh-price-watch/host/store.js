/**
 * Persistence for price-watch.
 *
 * Everything lives under `$DSH_HOME/price-watch/`, never in the project
 * directory:
 *
 *   config.json    passengers, cadence, notification settings
 *   monitors.json  the watched routes
 *   state.json     scheduler cursors, rule cooldowns, day-fire marks
 *   prices/*.jsonl one append-only series per monitor
 *   alerts.jsonl   recent deliveries
 *
 * JSON documents are written through a temp file + rename so a crash mid-write
 * cannot truncate them. A document that fails to parse is moved aside to
 * `<name>.bak` and replaced by defaults: a corrupted file must degrade the
 * panel, never block the plugin.
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isoDate, isoNow, monitorId, monitorTitle, numberOr, passengerId, cityCode, isDateString } from './util.js';

/** How many price points a single series read may return. */
const MAX_POINTS = 5000;
/** How many alerts are kept on disk. */
const MAX_ALERTS = 5000;
/** Hard cap on watched routes. */
export const MAX_MONITORS = 20;
export const MAX_PASSENGERS = 12;

const DEFAULT_CONFIG = () => ({
  passengers: [],
  cadence: { l1Minutes: 30 },
  // L2 (browser) collection: off until the user logs in and opts in.
  l2: { enabled: false, perDay: 1 },
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
  l2Runs: { date: '', count: 0 },
  l2BlockedUntil: null,
  l2LastError: null,
  cooldowns: {},
  dayFired: {},
  sides: {},
  lastDigest: null,
  lastError: {},
  failures: {},
});

export function createStore(rootDir) {
  const pricesDir = join(rootDir, 'prices');
  const configPath = join(rootDir, 'config.json');
  const monitorsPath = join(rootDir, 'monitors.json');
  const statePath = join(rootDir, 'state.json');
  const alertsPath = join(rootDir, 'alerts.jsonl');

  /** @type {{ config: any, monitors: any[], state: any }} */
  const cache = { config: DEFAULT_CONFIG(), monitors: [], state: DEFAULT_STATE() };
  let ready = null;

  async function readJson(path, fallback) {
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error && error.code === 'ENOENT') return fallback;
      // Unreadable/corrupt document: keep a copy for diagnosis, start clean.
      try {
        await rename(path, `${path}.bak`);
      } catch {
        /* the file may already be gone */
      }
      return fallback;
    }
  }

  async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
  }

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      await mkdir(pricesDir, { recursive: true });
      const config = await readJson(configPath, DEFAULT_CONFIG());
      cache.config = {
        ...DEFAULT_CONFIG(),
        ...config,
        l2: { ...DEFAULT_CONFIG().l2, ...(config.l2 || {}) },
        notify: { ...DEFAULT_CONFIG().notify, ...(config.notify || {}) },
      };
      if (!Array.isArray(cache.config.passengers)) cache.config.passengers = [];
      const monitorsDoc = await readJson(monitorsPath, { monitors: [] });
      cache.monitors = Array.isArray(monitorsDoc?.monitors) ? monitorsDoc.monitors : [];
      cache.state = { ...DEFAULT_STATE(), ...(await readJson(statePath, DEFAULT_STATE())) };
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
    const next = {
      ...cache.config,
      ...defined,
      cadence: { ...cache.config.cadence, ...(defined.cadence || {}) },
      l2: { ...cache.config.l2, ...(defined.l2 || {}) },
      notify: { ...cache.config.notify, ...(defined.notify || {}) },
    };
    cache.config = next;
    await writeJsonAtomic(configPath, next);
    return next;
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

  function normaliseParams(input) {
    const trip = input?.trip === 'round' ? 'round' : 'oneway';
    const params = {
      mode: 'locked',
      trip,
      dep: cityCode(input?.dep),
      arr: cityCode(input?.arr),
      departDate: String(input?.departDate || ''),
      cabin: 'y_s',
    };
    if (trip === 'round') params.returnDate = String(input?.returnDate || '');
    if (params.dep.length !== 3 || params.arr.length !== 3) throw new Error('出发地/目的地需要是 3 位城市三字码（如 BJS、SHA）');
    if (params.dep === params.arr) throw new Error('出发地和目的地不能相同');
    if (!isDateString(params.departDate)) throw new Error('出发日期格式应为 YYYY-MM-DD');
    if (trip === 'round') {
      if (!isDateString(params.returnDate)) throw new Error('往返需要填写返回日期');
      if (params.returnDate < params.departDate) throw new Error('返回日期不能早于出发日期');
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

  function normaliseCadence(input) {
    const allowed = [15, 30, 60, 360];
    const minutes = allowed.includes(Number(input?.l1Minutes)) ? Number(input.l1Minutes) : cache.config.cadence.l1Minutes;
    return { l1Minutes: minutes };
  }

  async function createMonitor(input) {
    if (cache.monitors.length >= MAX_MONITORS) throw new Error(`监控任务已达上限（${MAX_MONITORS}）`);
    const params = normaliseParams(input.params);
    const passengerIds = Array.isArray(input.passengerIds) ? input.passengerIds.filter((id) => findPassenger(id)) : [];
    if (passengerIds.length === 0) throw new Error('至少选择一位乘客');
    const now = isoNow();
    const monitor = {
      id: monitorId(),
      type: 'flight',
      title: monitorTitle(params),
      enabled: true,
      params,
      passengerIds,
      rules: normaliseRules(input.rules),
      cadence: normaliseCadence(input.cadence),
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
    const current = cache.monitors[index];
    const next = { ...current, updatedAt: isoNow() };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.rules !== undefined) next.rules = normaliseRules(patch.rules);
    if (patch.cadence !== undefined) next.cadence = normaliseCadence(patch.cadence);
    if (patch.passengerIds !== undefined) {
      const ids = patch.passengerIds.filter((pid) => findPassenger(pid));
      if (ids.length === 0) throw new Error('至少选择一位乘客');
      next.passengerIds = ids;
    }
    if (patch.params !== undefined) {
      next.params = normaliseParams({ ...current.params, ...patch.params });
      next.title = monitorTitle(next.params);
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
    try {
      await rename(join(pricesDir, `${id}.jsonl`), join(pricesDir, `${id}.jsonl.removed`));
    } catch {
      /* series may never have been written */
    }
    return true;
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
