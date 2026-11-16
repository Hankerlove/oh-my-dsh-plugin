/**
 * Host half of the flight price watch.
 *
 * Data plane: one JSONL series per monitored route under
 * `$DSH_HOME/price-watch/prices/`, plus `config.json` / `monitors.json` /
 * `state.json`. Nothing is written into the project directory.
 *
 * Two collectors, tried in this order:
 *   L1  `ctrip-calendar` — public lowest-price calendar, no login, one request
 *       covers 380 days. Always available; carries the trend.
 *   L2  `ctrip-browser`  — headed Chrome with a persistent profile. Reads the
 *       real fare products (age/student rules) and the tax breakdown on the
 *       booking page. Opt-in, budgeted per day, and skipped while blocked.
 *
 * Routes: `/price-watch/` serves a standalone read-only page, `/price-watch/api/*`
 * serves the JSON the panel and that page both use.
 *
 * Scheduling: a single 60s heartbeat scans the monitors that are due. The Host
 * `schedule` service is deliberately not used: it delivers prompts into Sessions
 * and would burn tokens for a job that only needs HTTP.
 *
 * Failure policy: this is a decorative plugin. Every registration and handler
 * degrades instead of throwing, so a broken collector or an unreachable HOME can
 * never stop the Web UI from opening.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { collectMonitor, probeL1 } from './host/collect/index.js';
import { BlockedError, AuthError, createBrowserCollector } from './host/collect/browser.js';
import { buildAlertCard, buildDigestCard, sendFeishu } from './host/notify.js';
import { evaluate } from './host/rules.js';
import { createRouter } from './host/routes.js';
import { createStore } from './host/store.js';
import { createLogger, isoDate, isoNow, sleep } from './host/util.js';

export const name = 'price-watch';

/** `webServer` carries the browser routes; everything else is optional. */
export const inject = ['webServer'];

/** Heartbeat period. Per-monitor cadence decides what each tick actually does. */
const TICK_MS = 60000;
/** Give the Host a moment to settle before the first catch-up collection. */
const BOOT_DELAY_MS = 8000;
/** Consecutive failures before an `anomaly` alert is raised. */
const FAILURE_THRESHOLD = 3;
/** How long L2 stays disabled after Ctrip answers with a bot check. */
const BLOCK_BACKOFF_MS = 2 * 60 * 60 * 1000;

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

  /** Is there L2 budget left today, and are we not backing off? */
  function l2Budget(state, config) {
    const perDay = Math.max(0, Number(config?.l2?.perDay ?? 1));
    const today = isoDate();
    const runs = state.l2Runs || { date: '', count: 0 };
    const used = runs.date === today ? Number(runs.count) || 0 : 0;
    const blockedUntil = Date.parse(state.l2BlockedUntil || '');
    const blocked = Number.isFinite(blockedUntil) && blockedUntil > Date.now();
    return { allowed: !blocked && used < perDay, used, perDay, blocked };
  }

  async function bumpL2Run() {
    const today = isoDate();
    const state = store.getState();
    const runs = state.l2Runs || { date: '', count: 0 };
    const count = runs.date === today ? Number(runs.count) || 0 : 0;
    await store.saveState({ l2Runs: { date: today, count: count + 1 } });
  }

  /**
   * Evaluate rules per passenger series. L1 points carry no passenger id and act
   * as one shared series; L2 points are per passenger so each passenger gets its
   * own thresholds.
   */
  async function evaluateAndNotify(monitor, points) {
    const config = store.getConfig();
    let state = store.getState();
    const grouped = new Map();
    for (const point of points) {
      const pid = point?.key?.passengerId || '';
      if (!grouped.has(pid)) grouped.set(pid, []);
      grouped.get(pid).push(point);
    }
    for (const [pid, fresh] of grouped) {
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
      }
    }
    await store.saveState(state);
    return fresh2count(points);
  }

  function fresh2count(points) {
    return Array.isArray(points) ? points.length : 0;
  }

  async function collectOne(monitor) {
    const startedAt = isoNow();
    const config = store.getConfig();
    let points = null;
    let source = 'l1';
    let lastError = null;

    try {
      const state = store.getState();
      const budget = l2Budget(state, config);
      if (config?.l2?.enabled && budget.allowed) {
        try {
          points = await browser.collect(monitor);
          source = 'l2';
          await bumpL2Run();
        } catch (error) {
          lastError = String(error?.message || error);
          if (error instanceof BlockedError || error?.code === 'BLOCKED') {
            await store.saveState({
              l2BlockedUntil: new Date(Date.now() + BLOCK_BACKOFF_MS).toISOString(),
              l2LastError: lastError,
            });
            logger.warn(`携程风控拦截，L2 暂停 ${BLOCK_BACKOFF_MS / 3600000} 小时`);
            await deliver(anomalyAlert(monitor, '携程返回风控/验证页面，精确采集已暂停，期间使用日历估算价'));
          } else if (error instanceof AuthError || error?.code === 'AUTH_REQUIRED') {
            await store.saveState({
              auth: { ...(state.auth || {}), status: 'expired', lastVerifiedAt: isoNow() },
              l2LastError: lastError,
            });
            await deliver(anomalyAlert(monitor, '携程登录态已失效，精确采集暂停，请在面板里重新登录'));
          } else {
            logger.warn(`L2 采集失败，回退 L1: ${lastError}`);
            await store.saveState({ l2LastError: lastError });
          }
        }
      }

      if (!points || points.length === 0) {
        points = await collectMonitor(monitor, { signal: undefined });
        source = 'l1';
      }

      await store.appendPoints(monitor.id, points);
      const current = store.getState();
      const failures = { ...(current.failures || {}) };
      failures[monitor.id] = 0;
      await store.saveState({
        lastCollectAt: startedAt,
        lastCollectBy: { ...(current.lastCollectBy || {}), [monitor.id]: startedAt },
        failures,
        lastError: { ...(current.lastError || {}), [monitor.id]: null },
      });

      const alertCount = await evaluateAndNotify(monitor, points);
      return { ok: true, source, points: points.length, alerts: alertCount };
    } catch (error) {
      const message = String(error?.message || error);
      const current = store.getState();
      const failures = { ...(current.failures || {}) };
      const count = Number(failures[monitor.id] || 0) + 1;
      failures[monitor.id] = count;
      await store.saveState({
        failures,
        lastError: { ...(current.lastError || {}), [monitor.id]: { at: isoNow(), message, count } },
      });
      logger.warn(`采集失败 ${monitor.title}: ${message}`);

      if (count >= FAILURE_THRESHOLD) {
        const key = `${monitor.id}:anomaly`;
        const today = isoDate();
        const dayFired = { ...(current.dayFired || {}) };
        if (dayFired[key] !== today) {
          dayFired[key] = today;
          await store.saveState({ dayFired });
          await deliver(anomalyAlert(monitor, message, count));
        }
      }
      return { ok: false, error: message };
    }
  }

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
      const config = store.getConfig();
      const state = store.getState();
      const monitorDefault = Number(config?.cadence?.l1Minutes) || 30;
      const now = Date.now();
      let collected = 0;
      const targets = force ? store.listMonitors() : store.listMonitors().filter((monitor) => monitor.enabled !== false);

      for (const monitor of targets) {
        if (disposed) break;
        if (!force) {
          const interval = (Number(monitor.cadence?.l1Minutes) || monitorDefault) * 60000;
          const last = Date.parse(state.lastCollectBy?.[monitor.id] || '');
          if (Number.isFinite(last) && now - last < interval) continue;
        }
        await collectOne(monitor);
        collected += 1;
        await sleep(1200 + Math.floor(Math.random() * 1800));
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

  const actions = {
    refreshMonitor: async (id, options = {}) => {
      await store.init();
      const monitor = store.findMonitor(id);
      if (!monitor) return { ok: false, error: '监控不存在' };
      if (options.immediate) {
        void (async () => {
          await sleep(50);
          await collectOne(monitor);
        })();
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
        blockedUntil: state.l2BlockedUntil,
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
      let probe = null;
      try {
        probe = await probeL1();
      } catch {
        probe = { id: 'l1', ok: false, error: '探测失败' };
      }
      const available = await browser.isAvailable();
      const budget = l2Budget(state, config);
      const failures = Object.values(state.failures || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      return {
        version: '0.1.0',
        auth: { ...(state.auth || { status: 'unknown' }), available, blockedUntil: state.l2BlockedUntil },
        lastCollectAt: state.lastCollectAt,
        monitorCount: store.listMonitors().length,
        passengerCount: store.listPassengers().length,
        failures,
        collectors: [
          probe,
          {
            id: 'l2',
            ok: available && !budget.blocked,
            enabled: Boolean(config?.l2?.enabled),
            used: budget.used,
            perDay: budget.perDay,
            blocked: budget.blocked,
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

  logger.info('price-watch 已加载（L1 日历 + L2 浏览器采集）');
}
