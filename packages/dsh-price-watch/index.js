/**
 * Host half of the flight price watch.
 *
 * Data plane: one JSONL series per monitored route under
 * `$DSH_HOME/price-watch/prices/`, plus `config.json` / `monitors.json` /
 * `state.json`. Nothing is written into the project directory.
 *
 * Sources: M1 ships the L1 collector only — Ctrip's public lowest-price calendar
 * (one request yields 380 days, no cookie, no signature). The browser collector
 * that reads per-fare prices and tax breakdowns lands in M2 behind the same
 * `collectMonitor` interface.
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

  async function collectOne(monitor) {
    const startedAt = isoNow();
    try {
      const points = await collectMonitor(monitor, { signal: undefined });
      await store.appendPoints(monitor.id, points);

      const history = await store.readPoints(monitor.id, { limit: 2000 });
      const config = store.getConfig();
      const current = store.getState();
      const outcome = evaluate(monitor, history, { state: current, config });
      const failures = { ...(current.failures || {}) };
      failures[monitor.id] = 0;

      await store.saveState({
        ...outcome.state,
        lastCollectAt: startedAt,
        lastCollectBy: { ...(current.lastCollectBy || {}), [monitor.id]: startedAt },
        failures,
        lastError: { ...(current.lastError || {}), [monitor.id]: null },
      });

      for (const alert of outcome.alerts) {
        logger.info(`触发提醒 ${alert.rule} ${monitor.title} ${alert.total}`);
        await deliver(alert);
      }
      return { ok: true, points: points.length, alerts: outcome.alerts.length };
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
          await deliver({
            id: `a_${Math.random().toString(16).slice(2, 10)}`,
            monitorId: monitor.id,
            monitorTitle: monitor.title,
            rule: 'anomaly',
            level: 'critical',
            firedAt: isoNow(),
            total: 0,
            ref: count,
            params: monitor.params,
            error: message,
          });
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
        // Space requests out: the calendar endpoint is cheap but should not burst.
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
        // Fire and forget so the HTTP response stays quick.
        void (async () => {
          await sleep(50);
          await collectOne(monitor);
        })();
        return { ok: true, queued: true };
      }
      return collectOne(monitor);
    },
    refreshAll: async () => tick({ force: true }),
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
      const failures = Object.values(state.failures || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      return {
        version: '0.1.0',
        auth: { status: 'unknown', lastVerifiedAt: null },
        lastCollectAt: state.lastCollectAt,
        monitorCount: store.listMonitors().length,
        passengerCount: store.listPassengers().length,
        failures,
        collectors: [probe],
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
      };
    }, 'price-watch scheduler');
  } catch (error) {
    logger.warn('price-watch 定时器注册失败，只能手动刷新', error);
  }

  logger.info('price-watch 已加载（L1 采集器 + 侧栏面板）');
}
