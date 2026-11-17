/**
 * Host half of the flight price watch.
 *
 * Data plane: one JSONL series per *watch* monitor under
 * `$DSH_HOME/price-watch/prices/`, a calendar snapshot per *calendar* monitor
 * under `calendar/`, a flight-list snapshot per watch monitor under `flights/`,
 * plus `config.json` / `monitors.json` / `state.json`. Nothing is written into
 * the project directory.
 *
 * V2 model: "is there a date?" decides everything.
 *   calendar  the user has not picked a date. L1 only: the public calendar,
 *             380 days of lowest price, one request (two for a round trip).
 *             Never writes prices, never alerts.
 *   watch     the user picked a date. L1 is the reference trend of that date;
 *             L2 (browser) adds the real fare products and the passenger-level
 *             paid price when the gating in contract §6 allows it.
 *
 * Scheduling: a single 60s heartbeat scans monitors whose `nextDue` has passed.
 * Each successful collection pushes `nextDue` forward with ±15% jitter. Between
 * 01:00 and 06:00 local time calendar monitors wait for 06:00, watch monitors
 * stretch their L1 interval ×4, and L2 never runs. The Host `schedule` service
 * is deliberately not used: it delivers prompts into Sessions and would burn
 * tokens for a job that only needs HTTP.
 *
 * Failure policy: this is a decorative plugin. Every registration and handler
 * degrades instead of throwing, so a broken collector or an unreachable HOME can
 * never stop the Web UI from opening.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { L1BudgetError, collectCalendar, collectMonitor, probeL1 } from './host/collect/index.js';
import { AuthError, BlockedError, createBrowserCollector } from './host/collect/browser.js';
import { buildAlertCard, buildDigestCard, sendFeishu } from './host/notify.js';
import { evaluate } from './host/rules.js';
import { createRouter } from './host/routes.js';
import { createStore } from './host/store.js';
import { createLogger, isNightQuiet, isoDate, isoNow, quietWakeIso, sleep } from './host/util.js';

export const name = 'price-watch';

/** `webServer` carries the browser routes; everything else is optional. */
export const inject = ['webServer'];

/** Heartbeat period. `nextDue` decides what each tick actually does. */
const TICK_MS = 60000;
/** Give the Host a moment to settle before the first catch-up collection. */
const BOOT_DELAY_MS = 8000;
/** Contract §4: never two L1 requests closer than this. */
const L1_SPACING_MS = 1500;
/** Contract §4: consecutive L1 failures before the day is paused. */
const L1_FAILURE_THRESHOLD = 5;
/** Watch monitors raise one anomaly alert after this many failed runs. */
const PER_MONITOR_ANOMALY_THRESHOLD = 3;
/** Contract §5 backoff ladder, indexed by level. */
const L2_BACKOFF_HOURS = [0, 2, 4, 8, 24];
const L2_BACKOFF_MAX_LEVEL = 4;
/** A successful L2 run may only reset the level after a full quiet day. */
const L2_RESET_AFTER_MS = 24 * 3600e3;
/** Health probe cache: the panel polls /status every 30s, do not hammer L1. */
const PROBE_TTL_MS = 30 * 60000;

export function apply(ctx) {
  const logger = createLogger(ctx);

  let store;
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    store = createStore(join(home, 'price-watch'));
  } catch (error) {
    logger.error('price-watch 无法初始化存储，插件已降级', error);
    return;
  }

  const browser = createBrowserCollector({ rootDir: store.rootDir, logger, store });

  let running = false;
  let disposed = false;
  /** Timestamp of the last L1 HTTP call; enforces the global 1500ms gap. */
  let l1LastAt = 0;
  /** Cached L1 health probe so a status poll never costs a request. */
  let probeCache = { at: 0, value: null };

  const panelUrl = () => {
    try {
      const configured = String(store.getConfig()?.panelBaseUrl || '').trim();
      if (configured) return configured.replace(/\/+$/, '') + '/price-watch/';
      const origin = typeof ctx.webServer?.getOrigin === 'function' ? ctx.webServer.getOrigin() : '';
      if (origin) return String(origin).replace(/\/+$/, '') + '/price-watch/';
    } catch {
      /* fall through */
    }
    return '';
  };

  async function deliver(alert) {
    const config = store.getConfig();
    const webhook = config?.notify?.feishuWebhook || '';
    const card = buildAlertCard(alert, { panelUrl: panelUrl() });
    let delivery = { channel: 'feishu', ok: false, at: isoNow(), error: '未配置 webhook' };
    if (webhook) {
      const result = await sendFeishu(webhook, card, { logger });
      delivery = { channel: 'feishu', ok: result.ok, at: isoNow(), error: result.ok ? undefined : result.error };
    }
    try {
      await store.appendAlert({ ...alert, delivery });
    } catch (error) {
      logger.warn('写入提醒记录失败', error);
    }
    return delivery;
  }

  function anomalyAlert(monitor, message, ref) {
    return {
      id: `a_${Math.random().toString(16).slice(2, 10)}`,
      monitorId: monitor.id,
      monitorTitle: monitor.title,
      rule: 'anomaly',
      level: 'critical',
      firedAt: isoNow(),
      total: 0,
      ref: ref ?? null,
      params: monitor.params,
      error: message,
    };
  }

  // #region budgets and cursors
  /** How many runs happened today for a `{date,count}` budget record. */
  function runsToday(runs, today) {
    return runs && runs.date === today ? Math.max(0, Number(runs.count) || 0) : 0;
  }

  /** Defensive read of the L2 backoff record. */
  function backoffOf(state) {
    const backoff = state?.l2Backoff;
    if (!backoff || typeof backoff !== 'object') return { level: 0, until: null, trippedDate: null };
    return {
      level: Math.max(0, Math.min(L2_BACKOFF_MAX_LEVEL, Number(backoff.level) || 0)),
      until: typeof backoff.until === 'string' ? backoff.until : null,
      trippedDate: typeof backoff.trippedDate === 'string' ? backoff.trippedDate : null,
    };
  }

  /**
   * Global L1 gate, run before every `fetchCalendar` call (contract §4):
   * respects the pause, keeps 1500ms between requests and counts the daily
   * budget. Returns `false` when this request must be skipped.
   */
  async function beforeL1() {
    const today = isoDate();
    const state = store.getState();
    const blockedUntil = Date.parse(state.l1BlockedUntil || '');
    if (Number.isFinite(blockedUntil) && Date.now() < blockedUntil) return false;

    const wait = L1_SPACING_MS - (Date.now() - l1LastAt);
    if (wait > 0) await sleep(wait);
    l1LastAt = Date.now();

    const perDay = Math.max(0, Number(store.getConfig()?.l1?.perDay) || 0);
    const used = runsToday(store.getState().l1Runs, today);
    if (used >= perDay) {
      logger.info(`L1 今日请求已达预算（${used}/${perDay}），本次跳过`);
      return false;
    }
    await store.saveState({ l1Runs: { date: today, count: used + 1 } });
    return true;
  }

  /** Count L1 failures across monitors; five in a row pause L1 until 00:05. */
  async function recordL1(ok) {
    const state = store.getState();
    if (ok) {
      if (Number(state.l1FailCount || 0) !== 0) await store.saveState({ l1FailCount: 0 });
      return;
    }
    const count = Number(state.l1FailCount || 0) + 1;
    if (count >= L1_FAILURE_THRESHOLD) {
      const until = new Date();
      until.setDate(until.getDate() + 1);
      until.setHours(0, 5, 0, 0);
      await store.saveState({ l1BlockedUntil: until.toISOString(), l1FailCount: 0 });
      logger.warn(`L1 连续失败 ${count} 次，暂停到 ${until.toISOString()}`);
      return;
    }
    await store.saveState({ l1FailCount: count });
  }

  /** `now + base * (0.85 + rand*0.30)`, contract §3. */
  function computeNextDue(monitor, { quiet = false } = {}) {
    const config = store.getConfig();
    let base;
    if (monitor.mode === 'calendar') {
      base = Math.max(1, Number(config?.cadence?.calendarHours) || 6) * 3600e3;
    } else {
      const minutes = Math.max(1, Number(monitor.cadence?.minutes) || Number(config?.cadence?.watchMinutes) || 60);
      // 夜间静默期间 watch 的 L1 间隔 ×4：不做全停，但也不按原节奏跑。
      base = minutes * 60000 * (quiet ? 4 : 1);
    }
    return new Date(Date.now() + base * (0.85 + Math.random() * 0.30)).toISOString();
  }

  async function setNextDue(monitorId, iso) {
    const state = store.getState();
    await store.saveState({ nextDue: { ...(state.nextDue || {}), [monitorId]: iso } });
  }

  /** L2 run counter: a request that never reached the page still costs budget. */
  async function bumpL2Run() {
    const today = isoDate();
    const used = runsToday(store.getState().l2Runs, today);
    await store.saveState({ l2Runs: { date: today, count: used + 1 } });
  }
  // #endregion

  // #region L2 gating and backoff
  /**
   * Contract §6: all seven conditions must hold. A manual refresh passes
   * `manual: true`, which only skips condition 5 (the per-monitor interval).
   */
  async function l2Gating(monitor, { manual = false } = {}) {
    if (monitor.mode !== 'watch') return { allowed: false, reason: 'calendar' };
    const config = store.getConfig();
    const state = store.getState();
    const today = isoDate();
    const backoff = backoffOf(state);

    if (!config?.l2?.enabled) return { allowed: false, reason: 'l2-disabled' };
    if (state.auth?.status !== 'valid') return { allowed: false, reason: 'auth' };
    const until = Date.parse(backoff.until || '');
    if (Number.isFinite(until) && Date.now() < until) return { allowed: false, reason: 'backoff' };
    if (state.l2DisabledForDay === today) return { allowed: false, reason: 'day-disabled' };
    const perDay = Math.max(0, Number(config?.l2?.perDay) || 0);
    if (runsToday(state.l2Runs, today) >= perDay) return { allowed: false, reason: 'budget' };
    if (!manual) {
      const minGap = Math.max(0, Number(config?.l2?.minIntervalMinutes) || 0) * 60000;
      const lastAt = Date.parse(state.l2LastRunBy?.[monitor.id] || '');
      if (Number.isFinite(lastAt) && Date.now() - lastAt < minGap) return { allowed: false, reason: 'interval' };
    }
    if (isNightQuiet()) return { allowed: false, reason: 'night' };
    const available = await browser.isAvailable();
    if (!available) return { allowed: false, reason: 'browser' };
    return { allowed: true, reason: 'ok' };
  }

  /** Contract §5: exponential backoff, day lock, one critical alert per day. */
  async function onL2Blocked(monitor, message) {
    const today = isoDate();
    const prev = backoffOf(store.getState());
    const level = Math.min(L2_BACKOFF_MAX_LEVEL, prev.level + 1);
    const hours = L2_BACKOFF_HOURS[level] || 24;
    const until = new Date(Date.now() + hours * 3600e3).toISOString();
    const patch = { l2Backoff: { level, until, trippedDate: today }, l2LastError: message };
    // 同一个自然日第二次触发 → 当天不再跑 L2。
    if (prev.trippedDate === today) patch.l2DisabledForDay = today;
    await store.saveState(patch);
    logger.warn(`携程风控拦截，L2 退避 ${hours} 小时（level ${level}/${L2_BACKOFF_MAX_LEVEL}）`);

    const dayFired = { ...(store.getState().dayFired || {}) };
    if (dayFired['l2:blocked'] !== today) {
      dayFired['l2:blocked'] = today;
      await store.saveState({ dayFired });
      await deliver(anomalyAlert(monitor, '携程返回风控/验证页面，精确采集已暂停，期间使用日历参考价'));
    }
  }

  /** Contract §5: an expired login pauses L2 and alerts once per day. */
  async function onL2AuthExpired(monitor, message) {
    const today = isoDate();
    const state = store.getState();
    await store.saveState({
      auth: { ...(state.auth || {}), status: 'expired', lastVerifiedAt: isoNow() },
      l2LastError: message,
    });
    const dayFired = { ...(store.getState().dayFired || {}) };
    if (dayFired['l2:auth'] !== today) {
      dayFired['l2:auth'] = today;
      await store.saveState({ dayFired });
      await deliver(anomalyAlert(monitor, '携程登录态已失效，精确采集暂停，请在面板里重新登录'));
    }
  }

  /** After a success: clear the ladder once a full quiet day has passed. */
  function resetBackoffIfQuiet(state) {
    const backoff = backoffOf(state);
    if (backoff.level === 0) return { level: 0, until: null, trippedDate: null };
    const until = Date.parse(backoff.until || '');
    if (backoff.trippedDate !== isoDate() && Number.isFinite(until) && Date.now() - until >= L2_RESET_AFTER_MS) {
      return { level: 0, until: null, trippedDate: null };
    }
    return state.l2Backoff;
  }
  // #endregion

  // #region rules
  /**
   * Evaluate rules per passenger series. L1 points carry no passenger id and act
   * as one shared series; L2 points are per passenger so each passenger gets its
   * own thresholds. Calendar monitors never reach this function.
   */
  async function evaluateAndNotify(monitor, points) {
    if (monitor.mode !== 'watch') return 0;
    const config = store.getConfig();
    let state = store.getState();
    let alerts = 0;
    const grouped = new Map();
    for (const point of points) {
      const pid = point?.key?.passengerId || '';
      if (!grouped.has(pid)) grouped.set(pid, []);
      grouped.get(pid).push(point);
    }
    for (const [pid] of grouped) {
      const history = await store.readPoints(monitor.id, { limit: 2000 });
      const series = history
        .filter((point) => (point?.key?.passengerId || '') === pid)
        .map((point) => ({ ...point, price: point.price || {} }));
      if (series.length === 0) continue;
      const passenger = pid ? store.findPassenger(pid) : null;
      const scoped = {
        ...monitor,
        title: passenger ? `${monitor.title} · ${passenger.nickname}` : monitor.title,
      };
      const outcome = evaluate(scoped, series, { state, config });
      state = { ...state, ...outcome.state };
      for (const alert of outcome.alerts) {
        logger.info(`触发提醒 ${alert.rule} ${scoped.title} ${alert.total}`);
        await deliver(alert);
        alerts += 1;
      }
    }
    await store.saveState(state);
    return alerts;
  }

  /** Record one failed watch-monitor run; watch-only, calendar stays silent. */
  async function noteWatchFailure(monitor, message) {
    const state = store.getState();
    const failures = { ...(state.failures || {}) };
    const count = Number(failures[monitor.id] || 0) + 1;
    failures[monitor.id] = count;
    await store.saveState({
      failures,
      lastError: { ...(state.lastError || {}), [monitor.id]: { at: isoNow(), message, count } },
    });
    if (count < PER_MONITOR_ANOMALY_THRESHOLD) return;
    const today = isoDate();
    const dayFired = { ...(store.getState().dayFired || {}) };
    const key = `${monitor.id}:anomaly`;
    if (dayFired[key] === today) return;
    dayFired[key] = today;
    await store.saveState({ dayFired });
    await deliver(anomalyAlert(monitor, message, count));
  }
  // #endregion

  // #region collection
  /** Calendar mode (contract §7.1): snapshot only, no prices, no alerts. */
  async function collectCalendarOne(monitor) {
    const startedAt = isoNow();
    if (isNightQuiet()) {
      await setNextDue(monitor.id, quietWakeIso());
      return { ok: true, skipped: 'night', source: 'calendar', points: 0, alerts: 0 };
    }
    try {
      const snapshot = await collectCalendar(monitor, { beforeL1 });
      await recordL1(true);
      await store.writeCalendarSnapshot(monitor.id, snapshot);
      const state = store.getState();
      await store.saveState({
        calendarFetchedAt: { ...(state.calendarFetchedAt || {}), [monitor.id]: snapshot.fetchedAt },
        lastCollectAt: startedAt,
        lastCollectBy: { ...(state.lastCollectBy || {}), [monitor.id]: startedAt },
        failures: { ...(state.failures || {}), [monitor.id]: 0 },
        lastError: { ...(state.lastError || {}), [monitor.id]: null },
      });
      await setNextDue(monitor.id, computeNextDue(monitor));
      return { ok: true, source: 'calendar', points: 0, alerts: 0 };
    } catch (error) {
      if (error instanceof L1BudgetError) {
        await setNextDue(monitor.id, computeNextDue(monitor));
        return { ok: true, skipped: 'l1-budget', source: 'calendar', points: 0, alerts: 0 };
      }
      const message = String(error?.message || error);
      await recordL1(false);
      const state = store.getState();
      const failures = { ...(state.failures || {}) };
      failures[monitor.id] = Number(failures[monitor.id] || 0) + 1;
      await store.saveState({
        failures,
        lastError: { ...(state.lastError || {}), [monitor.id]: { at: isoNow(), message, count: failures[monitor.id] } },
      });
      // 日历模式不发告警（契约 §1/§10），只记日志。
      logger.warn(`日历采集失败 ${monitor.title}: ${message}`);
      await setNextDue(monitor.id, computeNextDue(monitor));
      return { ok: false, error: message, source: 'calendar', points: 0, alerts: 0 };
    }
  }

  /**
   * Watch mode (contract §7.2): L1 always, then L2 only when §6 allows it.
   * `allowL2: false` is the plain "refresh" path (§9: a normal refresh only
   * re-reads L1; only `{ l2: true }` may ask the browser).
   */
  async function collectWatchOne(monitor, { manualL2 = false, allowL2 = true } = {}) {
    const startedAt = isoNow();
    const quiet = isNightQuiet();
    let l1Points = [];
    let l2Points = [];
    let l2Ran = false;
    let l1Error = null;
    let budgetSkipped = false;

    // 第 1 步：L1 参考价（必做）。失败不阻塞后面的 L2。
    try {
      l1Points = await collectMonitor(monitor, { beforeL1 });
      await recordL1(true);
      await store.appendPoints(monitor.id, l1Points);
    } catch (error) {
      if (error instanceof L1BudgetError) {
        budgetSkipped = true;
      } else {
        l1Error = String(error?.message || error);
        await recordL1(false);
        await noteWatchFailure(monitor, l1Error);
        logger.warn(`L1 参考价失败 ${monitor.title}: ${l1Error}`);
      }
    }

    // 第 2 步：L2（§6 全部条件满足才跑；手动 refresh 只跳过条件 5）。
    const gating = allowL2 ? await l2Gating(monitor, { manual: manualL2 }) : { allowed: false, reason: 'l1-only' };
    if (gating.allowed) {
      await bumpL2Run();
      try {
        const result = await browser.collect(monitor);
        const at = isoNow();
        l2Points = Array.isArray(result?.points) ? result.points : [];
        await store.appendPoints(monitor.id, l2Points);
        await store.writeFlightsSnapshot(monitor.id, {
          fetchedAt: at,
          flights: Array.isArray(result?.flights) ? result.flights : [],
          tax: result?.tax || null,
        });
        l2Ran = true;
        const state = store.getState();
        await store.saveState({
          l2LastRunBy: { ...(state.l2LastRunBy || {}), [monitor.id]: at },
          l2LastOk: { ...(state.l2LastOk || {}), [monitor.id]: true },
          l2LastError: null,
          l2Backoff: resetBackoffIfQuiet(state),
        });
      } catch (error) {
        const message = String(error?.message || error);
        const still = store.getState();
        await store.saveState({ l2LastOk: { ...(still.l2LastOk || {}), [monitor.id]: false } });
        if (error instanceof BlockedError || error?.code === 'BLOCKED') {
          await onL2Blocked(monitor, message);
        } else if (error instanceof AuthError || error?.code === 'AUTH_REQUIRED') {
          await onL2AuthExpired(monitor, message);
        } else {
          // L2 失败不阻塞 L1：点已经落库，这里只记错误。
          logger.warn(`L2 采集失败，继续使用 L1 参考价: ${message}`);
          await store.saveState({ l2LastError: message });
        }
      }
    }

    const fresh = [...l1Points, ...l2Points];
    await setNextDue(monitor.id, computeNextDue(monitor, { quiet }));
    if (fresh.length === 0) {
      if (budgetSkipped) return { ok: true, skipped: 'l1-budget', source: 'l1', points: 0, alerts: 0 };
      return { ok: false, error: l1Error || '本次没有采到价格', source: 'l1', points: 0, alerts: 0 };
    }

    const state = store.getState();
    const failures = { ...(state.failures || {}) };
    failures[monitor.id] = 0;
    await store.saveState({
      lastCollectAt: startedAt,
      lastCollectBy: { ...(state.lastCollectBy || {}), [monitor.id]: startedAt },
      failures,
      lastError: { ...(state.lastError || {}), [monitor.id]: null },
    });

    // 第 3 步：只有 watch 模式才有规则可评估。
    const alerts = await evaluateAndNotify(monitor, fresh);
    return { ok: true, source: l2Ran ? 'l2' : 'l1', points: fresh.length, alerts };
  }

  /** Dispatch by mode; a failure never escapes into the scheduler. */
  async function collectOne(monitor, options = {}) {
    try {
      if (monitor.mode === 'calendar') return await collectCalendarOne(monitor);
      return await collectWatchOne(monitor, {
        manualL2: Boolean(options.manualL2),
        allowL2: options.allowL2 !== false,
      });
    } catch (error) {
      logger.warn(`采集流程异常 ${monitor?.title || monitor?.id}: ${String(error?.message || error)}`);
      return { ok: false, error: String(error?.message || error) };
    }
  }
  // #endregion

  async function maybeDigest() {
    try {
      const config = store.getConfig();
      const at = String(config?.notify?.digestAt || '09:00');
      const [hour, minute] = at.split(':').map((part) => Number(part) || 0);
      const now = new Date();
      const today = isoDate(now);
      const state = store.getState();
      if (state.lastDigest === today) return;
      const due = new Date(now.getTime());
      due.setHours(hour, minute, 0, 0);
      if (now.getTime() < due.getTime()) return;

      const webhook = config?.notify?.feishuWebhook || '';
      if (webhook) {
        const rows = [];
        for (const monitor of store.listMonitors()) {
          // Calendar monitors have no series: the digest only covers dated trips.
          if (monitor.mode === 'calendar') continue;
          const points = await store.readPoints(monitor.id, { limit: 1 });
          const latest = points[points.length - 1];
          if (latest) rows.push({ monitor, total: latest.price?.total, at: latest.at });
        }
        const card = buildDigestCard(rows, { panelUrl: panelUrl() });
        const result = await sendFeishu(webhook, card, { logger });
        await store.appendAlert({
          id: `a_${Math.random().toString(16).slice(2, 10)}`,
          monitorId: 'digest',
          monitorTitle: '价格日报',
          rule: 'digest',
          level: 'info',
          firedAt: isoNow(),
          total: 0,
          delivery: { channel: 'feishu', ok: result.ok, at: isoNow(), error: result.error },
        });
      }
      await store.saveState({ lastDigest: today });
    } catch (error) {
      logger.warn('每日摘要失败', error);
    }
  }

  async function tick({ force = false } = {}) {
    if (running || disposed) return { ok: true, skipped: 'busy' };
    running = true;
    try {
      await store.init();
      let collected = 0;
      const targets = store.listMonitors().filter((monitor) => (force ? true : monitor.enabled !== false));
      for (const monitor of targets) {
        if (disposed) break;
        if (!force) {
          const due = Date.parse(store.getState().nextDue?.[monitor.id] || '');
          if (Number.isFinite(due) && due > Date.now()) continue;
        }
        await collectOne(monitor);
        collected += 1;
        // 同一 tick 内多个 monitor 之间也要错开，不要连发（契约 §3）。
        await sleep(1500 + Math.floor(Math.random() * 2500));
      }
      await maybeDigest();
      return { ok: true, collected };
    } catch (error) {
      logger.error('调度心跳失败', error);
      return { ok: false, error: String(error?.message || error) };
    } finally {
      running = false;
    }
  }

  /** L1 health for `/status`; cached for 30 min and outside the daily budget. */
  async function probeL1Cached() {
    const now = Date.now();
    if (probeCache.value && now - probeCache.at < PROBE_TTL_MS) return probeCache.value;
    const state = store.getState();
    const blockedUntil = Date.parse(state.l1BlockedUntil || '');
    if (Number.isFinite(blockedUntil) && now < blockedUntil) {
      probeCache = { at: now, value: { id: 'l1', ok: false, error: 'L1 连续失败，暂停中', checkedAt: isoNow() } };
      return probeCache.value;
    }
    // The probe is cheap but it is still a request: keep the global spacing.
    const wait = L1_SPACING_MS - (Date.now() - l1LastAt);
    if (wait > 0) await sleep(wait);
    l1LastAt = Date.now();
    const value = await probeL1();
    probeCache = { at: Date.now(), value };
    return value;
  }

  const actions = {
    refreshMonitor: async (id, options = {}) => {
      await store.init();
      const monitor = store.findMonitor(id);
      if (!monitor) return { ok: false, error: '监控不存在' };
      if (options.immediate) {
        void (async () => {
          await sleep(50);
          await collectOne(monitor);
        })().catch(() => {});
        return { ok: true, queued: true };
      }
      // §9: a plain refresh only re-reads L1. L2 needs an explicit `{ l2: true }`.
      return collectOne(monitor, { manualL2: Boolean(options.l2), allowL2: Boolean(options.l2) });
    },
    refreshAll: async () => tick({ force: true }),
    loginStart: async () => {
      await store.init();
      return browser.startLogin({});
    },
    loginStatus: async () => {
      await store.init();
      const state = store.getState();
      const available = await browser.isAvailable();
      const backoff = backoffOf(state);
      return {
        available,
        ...(state.auth || { status: 'unknown' }),
        blockedUntil: backoff.until,
        disabledForDay: state.l2DisabledForDay === isoDate(),
        level: backoff.level,
        lastError: state.l2LastError,
      };
    },
    loginProbe: async () => {
      await store.init();
      return browser.authStatus();
    },
    logout: async () => {
      await store.init();
      return browser.logout();
    },
    status: async () => {
      await store.init();
      const config = store.getConfig();
      const state = store.getState();
      const today = isoDate();
      const probe = await probeL1Cached();
      const available = await browser.isAvailable();
      const backoff = backoffOf(state);
      const blockedUntil = backoff.until;
      const blocked = Number.isFinite(Date.parse(blockedUntil || '')) && Date.parse(blockedUntil) > Date.now();
      const monitors = store.listMonitors();
      const failures = Object.values(state.failures || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      return {
        version: '0.1.0',
        auth: { ...(state.auth || { status: 'unknown' }), available, blockedUntil },
        lastCollectAt: state.lastCollectAt,
        monitorCount: monitors.length,
        passengerCount: store.listPassengers().length,
        failures,
        l1: {
          ok: Boolean(probe.ok),
          calendarMonitors: monitors.filter((monitor) => monitor.mode === 'calendar').length,
          watchMonitors: monitors.filter((monitor) => monitor.mode === 'watch').length,
        },
        budgets: {
          l1: { used: runsToday(state.l1Runs, today), perDay: Math.max(0, Number(config?.l1?.perDay) || 0) },
          l2: { used: runsToday(state.l2Runs, today), perDay: Math.max(0, Number(config?.l2?.perDay) || 0) },
        },
        l2: {
          enabled: Boolean(config?.l2?.enabled),
          available,
          blockedUntil,
          disabledForDay: state.l2DisabledForDay === today,
          level: backoff.level,
          lastError: state.l2LastError || null,
          // Why precise collection is unavailable, when it is an import problem.
          loadError: available ? null : browser.loadError?.() || null,
          minIntervalMinutes: Math.max(0, Number(config?.l2?.minIntervalMinutes) || 0),
        },
        collectors: [
          probe,
          {
            id: 'l2',
            // 契约 §9：ok 只反映 available && !blocked，不因 enabled=false 变红。
            ok: available && !blocked,
            enabled: Boolean(config?.l2?.enabled),
            used: runsToday(state.l2Runs, today),
            perDay: Math.max(0, Number(config?.l2?.perDay) || 0),
            blocked,
            error: state.l2LastError || null,
          },
        ],
        notify: { feishu: Boolean(config?.notify?.feishuWebhook) },
        panelUrl: panelUrl(),
      };
    },
    panelUrl,
  };

  const handler = createRouter({ store, logger, actions });

  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/price-watch', handler }),
      'price-watch routes',
    );
  } catch (error) {
    logger.error('price-watch 路由注册失败，面板将不可用', error);
    return;
  }

  try {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void tick();
      }, TICK_MS);
      // Catch-up after a Host restart instead of waiting a whole cadence.
      const boot = setTimeout(() => {
        void tick();
      }, BOOT_DELAY_MS);
      return () => {
        disposed = true;
        clearInterval(timer);
        clearTimeout(boot);
        void browser.dispose();
      };
    }, 'price-watch scheduler');
  } catch (error) {
    logger.warn('price-watch 定时器注册失败，只能手动刷新', error);
  }

  logger.info('price-watch 已加载（V2：日历模式 + 定点监控 + 浏览器精确采集）');
}
