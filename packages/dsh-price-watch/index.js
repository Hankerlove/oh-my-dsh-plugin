/**
 * Host half of the flight price watch.
 *
 * Data plane: one JSONL series per *watch* monitor under
 * `$DSH_HOME/price-watch/prices/`, a calendar snapshot per *calendar* monitor
 * under `calendar/`, a flight-list snapshot per watch monitor under `flights/`,
 * plus `config.json` / `monitors.json` / `state.json`. Nothing is written into
 * the project directory.
 *
 * Frequency model v2 — "is there a date?" still decides everything, but the two
 * modes no longer share a budget, a window or a fallback:
 *
 *   calendar  the user has not picked a date. L1 only: the public calendar,
 *             380 days of lowest price, one request (two for a round trip).
 *             Snapshot only — never writes a price series, never alerts.
 *   watch     the user picked a date. L2 only: the logged-in browser reads the
 *             real fare products and the passenger's payable price. L1 is never
 *             called from this path; when L2 fails the chart keeps a hole rather
 *             than being back-filled with a different kind of price.
 *
 * Scheduling: a single 60s heartbeat collects every monitor whose `nextDue` has
 * passed. `nextDue = now + base * (0.85 + rand*0.30)`, where `base` is the
 * monitor's cadence in minutes (or its mode's global default). There is no quiet
 * window, no daily quota, no minimum interval, no adaptive slowdown and no
 * exponential backoff. The one protective rule left is the risk-control page
 * (`BlockedError`): it pushes that single monitor's `nextDue` one extra full
 * period forward, i.e. it skips one round. The Host `schedule` service is
 * deliberately not used: it delivers prompts into Sessions and would burn tokens
 * for a job that only needs HTTP.
 *
 * Failure policy: this is a decorative plugin. Every registration and handler
 * degrades instead of throwing, so a broken collector or an unreachable HOME can
 * never stop the Web UI from opening.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { collectCalendar, probeL1 } from './host/collect/index.js';
import { AuthError, BlockedError, createBrowserCollector } from './host/collect/browser.js';
import { buildAlertCard, buildDigestCard, sendFeishu } from './host/notify.js';
import { evaluate } from './host/rules.js';
import { createRouter } from './host/routes.js';
import { clampCadence, createStore } from './host/store.js';
import { createLogger, isoDate, isoNow, sleep } from './host/util.js';

export const name = 'price-watch';

/** `webServer` carries the browser routes; everything else is optional. */
export const inject = ['webServer'];

/** Heartbeat period. `nextDue` decides what each tick actually does. */
const TICK_MS = 60000;
/** Give the Host a moment to settle before the first catch-up collection. */
const BOOT_DELAY_MS = 8000;
/**
 * Politeness only: keep at least this gap between two Ctrip requests so a
 * catch-up tick with several monitors does not fire them simultaneously.
 * This is NOT a budget — it never refuses a request.
 */
const L1_SPACING_MS = 1500;
/** Watch monitors raise one anomaly alert after this many failed runs. */
const PER_MONITOR_ANOMALY_THRESHOLD = 3;
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
  /** Timestamp of the last Ctrip request; enforces the global 1500ms gap. */
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

  // #region cadence and cursors
  /** The cadence that decides this monitor's rhythm, in minutes (spec §3). */
  function cadenceMinutesOf(monitor) {
    const key = monitor?.mode === 'calendar' ? 'calendarMinutes' : 'watchMinutes';
    const config = store.getConfig();
    // 不传 cadence 就用该模式的全局默认；两侧都按同一套档位夹取。
    const configured = clampCadence(config?.cadence?.[key]);
    return clampCadence(monitor?.cadence?.minutes ?? configured, configured);
  }

  /** `now + base * (0.85 + rand*0.30)`, spec §3. */
  function computeNextDue(monitor) {
    const base = cadenceMinutesOf(monitor) * 60000;
    return new Date(Date.now() + base * (0.85 + Math.random() * 0.30)).toISOString();
  }

  /**
   * The one and only safety valve (spec §3): a risk-control page makes this
   * monitor skip a round. Normal scheduling already waits one period, so
   * "skip a round" means one extra full period: `now + 2 × base`, without
   * jitter so the value stays readable while debugging. The user's cadence
   * itself is never modified, and other monitors are unaffected.
   */
  function blockedNextDue(monitor) {
    return new Date(Date.now() + cadenceMinutesOf(monitor) * 60000 * 2).toISOString();
  }

  async function setNextDue(monitorId, iso) {
    const state = store.getState();
    await store.saveState({ nextDue: { ...(state.nextDue || {}), [monitorId]: iso } });
  }
  // #endregion

  // #region L2 preconditions
  /**
   * The complete set of preconditions for a watch run (spec §4.2): a valid login
   * plus a usable browser module. Nothing else — no daily count, no minimum
   * interval, no night check, no backoff.
   */
  async function l2Ready() {
    if (store.getState().auth?.status !== 'valid') {
      return { ok: false, reason: 'auth', message: '携程登录态无效，请先在面板里重新登录' };
    }
    if (!(await browser.isAvailable())) {
      return { ok: false, reason: 'browser', message: browser.loadError?.() || '浏览器采集模块不可用（playwright-core 未安装）' };
    }
    return { ok: true };
  }
  // #endregion

  // #region rules
  /**
   * Evaluate rules per passenger series. Every point here is an L2 point and
   * carries its passenger, so each passenger gets its own thresholds. Calendar
   * monitors never reach this function and old L1 reference points are not fed
   * in: they are a different kind of number.
   */
  async function evaluateAndNotify(monitor, points) {
    if (monitor.mode !== 'watch') return 0;
    if (!Array.isArray(points) || points.length === 0) return 0;
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
      // 只看本次新点的乘客：没有新点的人不该被重新评估。
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

  /** Record one failed watch-monitor run; calendar stays silent by design. */
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
  /**
   * Politeness gate shared by every L1 request (and the health probe): wait out
   * the minimum gap, then record the moment. Never refuses — v2 has no quota.
   */
  async function paceL1() {
    const wait = L1_SPACING_MS - (Date.now() - l1LastAt);
    if (wait > 0) await sleep(wait);
    l1LastAt = Date.now();
  }

  /** 行情模式（spec §4.1）：只写日历快照，不写价格序列、不告警。 */
  async function collectCalendarOne(monitor) {
    const startedAt = isoNow();
    try {
      const snapshot = await collectCalendar(monitor, { pace: paceL1 });
      const state = store.getState();
      await store.writeCalendarSnapshot(monitor.id, snapshot);
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
      const message = String(error?.message || error);
      // 行情模式不发告警（spec §4.1）：失败只是没刷新快照，面板上还有上一次的数据。
      logger.warn(`日历采集失败 ${monitor.title}: ${message}`);
      const state = store.getState();
      const failures = { ...(state.failures || {}) };
      failures[monitor.id] = Number(failures[monitor.id] || 0) + 1;
      await store.saveState({
        failures,
        lastError: { ...(state.lastError || {}), [monitor.id]: { at: isoNow(), message, count: failures[monitor.id] } },
      });
      await setNextDue(monitor.id, computeNextDue(monitor));
      return { ok: false, error: message, source: 'calendar', points: 0, alerts: 0 };
    }
  }

  /**
   * 监控模式（spec §4.2）：只走 L2，绝不调 L1。
   *
   * 前置条件只有两个；任一不满足就只记错误、不写点。风控页 / 登录失效 / 其它
   * 异常同样只记错误、不写点，图表因此留空洞 —— 这是故意的：L1 参考价与乘客
   * 实付价不是同一种数，混写会画出假曲线。
   */
  async function collectWatchOne(monitor) {
    const startedAt = isoNow();
    const ready = await l2Ready();
    if (!ready.ok) {
      await noteWatchFailure(monitor, ready.message);
      await setNextDue(monitor.id, computeNextDue(monitor));
      return { ok: false, error: ready.message, skipped: ready.reason, source: 'l2', points: 0, alerts: 0 };
    }

    try {
      const result = await browser.collect(monitor);
      const at = isoNow();
      const points = Array.isArray(result?.points) ? result.points : [];
      await store.appendPoints(monitor.id, points);
      await store.writeFlightsSnapshot(monitor.id, {
        fetchedAt: at,
        flights: Array.isArray(result?.flights) ? result.flights : [],
        tax: result?.tax || null,
      });
      const state = store.getState();
      await store.saveState({
        l2LastRunBy: { ...(state.l2LastRunBy || {}), [monitor.id]: at },
        l2LastOk: { ...(state.l2LastOk || {}), [monitor.id]: true },
        l2LastError: null,
        lastCollectAt: startedAt,
        lastCollectBy: { ...(state.lastCollectBy || {}), [monitor.id]: startedAt },
        failures: { ...(state.failures || {}), [monitor.id]: 0 },
        lastError: { ...(state.lastError || {}), [monitor.id]: null },
      });
      await setNextDue(monitor.id, computeNextDue(monitor));
      const alerts = await evaluateAndNotify(monitor, points);
      return { ok: true, source: 'l2', points: points.length, alerts };
    } catch (error) {
      const message = String(error?.message || error);
      const state = store.getState();
      const patch = {
        l2LastOk: { ...(state.l2LastOk || {}), [monitor.id]: false },
        l2LastError: message,
      };
      // 登录失效要如实落到 auth 上（面板靠它提示重新登录），
      // 但这不是退避：下一次仍按用户选的节奏去试。
      if (error instanceof AuthError || error?.code === 'AUTH_REQUIRED') {
        patch.auth = { ...(state.auth || {}), status: 'expired', lastVerifiedAt: isoNow() };
      }
      await store.saveState(patch);
      await noteWatchFailure(monitor, message);
      const blocked = error instanceof BlockedError || error?.code === 'BLOCKED';
      if (blocked) logger.warn(`携程返回风控页，${monitor.title} 跳过一次采集`);
      // 唯一安全阀：风控页额外推后一个完整周期（跳过一轮）；其它失败按正常节奏。
      await setNextDue(monitor.id, blocked ? blockedNextDue(monitor) : computeNextDue(monitor));
      return { ok: false, error: message, source: 'l2', points: 0, alerts: 0 };
    }
  }

  /** Dispatch by mode; a failure never escapes into the scheduler. */
  async function collectOne(monitor) {
    try {
      if (monitor.mode === 'calendar') return await collectCalendarOne(monitor);
      return await collectWatchOne(monitor);
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
        // 同一 tick 内多个 monitor 之间也要错开，不要连发。
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

  /** L1 health for `/status`; cached for 30 min so the panel never costs a request. */
  async function probeL1Cached() {
    const now = Date.now();
    if (probeCache.value && now - probeCache.at < PROBE_TTL_MS) return probeCache.value;
    await paceL1();
    const value = await probeL1();
    probeCache = { at: Date.now(), value };
    return value;
  }

  const actions = {
    /**
     * Manual "collect now" (spec §5). No `{ l2: true }` distinction any more:
     * a calendar monitor runs L1, a watch monitor runs L2. The old parameter is
     * accepted and ignored so an old client keeps working.
     */
    refreshMonitor: async (id, options = {}) => {
      await store.init();
      const monitor = store.findMonitor(id);
      if (!monitor) return { ok: false, error: '监控不存在' };
      // 新建监控时后台补一次采集，HTTP 响应不等待它。
      if (options.immediate) {
        void (async () => {
          await sleep(50);
          await collectOne(monitor);
        })().catch(() => {});
        return { ok: true, queued: true };
      }
      return collectOne(monitor);
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
      return {
        available,
        ...(state.auth || { status: 'unknown' }),
        lastError: state.l2LastError || null,
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
      const probe = await probeL1Cached();
      const available = await browser.isAvailable();
      const monitors = store.listMonitors();
      const failures = Object.values(state.failures || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      return {
        version: '0.3.0',
        auth: { ...(state.auth || { status: 'unknown' }), available },
        lastCollectAt: state.lastCollectAt,
        monitorCount: monitors.length,
        passengerCount: store.listPassengers().length,
        failures,
        // 只留「最近一次探针结果」：预算、每日次数、最短间隔都随旧模型删掉了。
        l1: {
          ok: Boolean(probe.ok),
          days: Number.isFinite(Number(probe.days)) ? Number(probe.days) : null,
          ms: Number.isFinite(Number(probe.ms)) ? Number(probe.ms) : null,
          checkedAt: probe.checkedAt || null,
          ...(probe.ok ? {} : { error: probe.error || 'L1 不可用' }),
        },
        l2: {
          available,
          lastError: state.l2LastError || null,
          // 浏览器模块缺失时带上诊断原因，正常时不打扰客户端。
          ...(available ? {} : { loadError: browser.loadError?.() || null }),
        },
        cadence: config.cadence,
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

  logger.info('price-watch 已加载（频率模型 v2：行情=L1 / 监控=L2，统一频率档位）');
}
