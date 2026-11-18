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
 *             Snapshot only — never writes a price series.
 *   watch     the user picked a date. L2 only: the logged-in browser reads the
 *             real fare products and every one of the ten cheapest flights gets
 *             its payable price. L1 is never called from this path; when L2 fails
 *             the chart keeps a hole rather than being back-filled with a
 *             different kind of price.
 *
 * Delivery model A2 (spec §1): after **every** collection attempt one card is
 * built — the mode's success card, or a failure card carrying the reason. The
 * card is fingerprinted (sha1 over the data it shows: calendar rows / flight
 * rows / the error text); an identical fingerprint to the last delivered card
 * means "do not push, but do store the data". A push is attempted exactly once
 * (no retry); the outcome lands in `state.delivery[id]` and `alerts.jsonl`.
 * Alert rules, cooldowns and the daily digest were deleted with rules.js.
 *
 * Delivery channels A2.2 (spec §1/§5): the default is a self-built Feishu app
 * (`channel:'app'`): the trend is rendered locally to a PNG (`host/chart.js`),
 * uploaded for an `img_key`, and the card is sent to a group chat with the
 * tenant token (`host/feishu.js`). `channel:'webhook'` keeps the custom-bot
 * webhook and is text-only. Missing channel config ⇒ `skipped:'no-config'`
 * (no state entry, no log line). A failed render/upload degrades to a text-only
 * card instead of blocking the delivery.
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
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { renderTrendPng } from './host/chart.js';
import { collectCalendar, probeL1 } from './host/collect/index.js';
import { AuthError, BlockedError, createBrowserCollector } from './host/collect/browser.js';
import { deliverAppCard } from './host/feishu.js';
import { buildCalendarCard, buildFailureCard, buildTestCard, buildWatchCard, sendFeishu } from './host/notify.js';
import { createRouter } from './host/routes.js';
import { clampCadence, createStore } from './host/store.js';
import { createLogger, isDateString, isoDate, isoNow, minSeries, sleep } from './host/util.js';

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

  // #region delivery
  /** sha1 of a stable JSON payload; this is the idempotency key of one card. */
  function hashOf(value) {
    return createHash('sha1').update(JSON.stringify(value)).digest('hex');
  }

  /**
   * The idempotency key (spec §1.1). Only the fields the card actually shows are
   * hashed, so an unrelated change (a new flight outside the TOP10, a different
   * `fetchedAt`, a re-ordered array the card does not print) must not re-push:
   *   行情  calendar.out / calendar.back 的 (date,total) 序列；
   *   监控  flights 的 航班号 + 时刻 + 机场 + 含税价 序列；
   *   失败  错误文本。
   */
  function deliveryKeyFor(report) {
    if (report.kind === 'failure') return hashOf(['failure', String(report.error || '')]);
    if (report.kind === 'watch') {
      const flights = (Array.isArray(report.flights) ? report.flights : []).map((flight) => [
        flight?.no || '',
        flight?.depTime || '',
        flight?.arrTime || '',
        flight?.depAirport || '',
        flight?.arrAirport || '',
        Number.isFinite(flight?.taxIncluded) ? flight.taxIncluded : null,
      ]);
      return hashOf(['watch', flights]);
    }
    const rows = (list) => (Array.isArray(list) ? list.map((row) => [row?.date || '', Number(row?.total) || 0]) : null);
    return hashOf(['calendar', rows(report.snapshot?.out), rows(report.snapshot?.back)]);
  }

  /**
   * The card body for one collection report. `imageKey` is the `img_key` of the
   * freshly uploaded trend PNG (`null` for the webhook channel, for a failed
   * upload, or when there are not enough points to draw anything).
   */
  function buildCardFor(monitor, report, imageKey = null) {
    if (report.kind === 'failure') return buildFailureCard({ monitor, error: report.error });
    if (report.kind === 'watch') {
      const lowest = report.lowest || null;
      const lowestFlight = (Array.isArray(report.flights) ? report.flights : [])
        .find((flight) => flight?.no && flight.no === lowest?.flightNo) || null;
      return buildWatchCard({
        monitor,
        lowest,
        lowestFlight,
        previous: report.previous,
        flights: report.flights,
        imageKey,
      });
    }
    return buildCalendarCard({
      monitor,
      out: report.snapshot?.out || [],
      back: report.snapshot?.back || null,
      previous: report.previous,
      imageKey,
    });
  }

  /**
   * Which delivery channel the current config resolves to (spec §5).
   *
   * No cross-fallback on purpose: if the user picked `app` but the app fields are
   * incomplete we report `no-config` instead of silently pushing through a
   * leftover webhook — a message appearing in the wrong place is worse than a
   * missing one, and the panel already shows the delivery state.
   */
  function resolveChannel(config) {
    const notifyConfig = config?.notify && typeof config.notify === 'object' ? config.notify : {};
    const webhook = String(notifyConfig.feishuWebhook || '').trim();
    const appId = String(notifyConfig.appId || '').trim();
    const appSecret = String(notifyConfig.appSecret || '');
    const chatId = String(notifyConfig.chatId || '').trim();
    if (notifyConfig.channel === 'webhook') {
      return /^https:\/\//i.test(webhook) ? { kind: 'webhook', webhook } : { kind: 'none' };
    }
    if (appId && appSecret && chatId) return { kind: 'app', appId, appSecret, chatId };
    return { kind: 'none' };
  }

  /**
   * The numbers the trend PNG shows: the watch card plots the last 20 per-collection
   * lowest payable prices, the calendar card the next 30 daily totals (the forward
   * leg for a round trip).
   */
  function trendValuesFor(report) {
    const values = report.kind === 'watch'
      ? (Array.isArray(report.minSeries) ? report.minSeries.slice(-20) : [])
      : (Array.isArray(report.snapshot?.out) ? report.snapshot.out.slice(0, 30).map((row) => row?.total) : []);
    return values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  }

  /**
   * Render the trend PNG for a report, or null when the report has no chart.
   *
   *  - 失败卡永远不带图；
   *  - 点数不足 2 个（监控首次采集）交给 `renderTrendPng` 出空白占位图：保持卡片
   *    版式一致，也让「第一次采集」看起来是正常的而不是像挂了；
   *  - 渲染本身出错才降级为无图卡片（投递不能因此中断）。
   */
  function renderTrend(report) {
    if (report.kind === 'failure') return null;
    try {
      const values = trendValuesFor(report);
      // A single point draws nothing worth looking at (the first collection of a
      // monitor). Send the card without an image instead of a blank placeholder.
      if (!Array.isArray(values) || values.length < 2) return null;
      return renderTrendPng(values);
    } catch (error) {
      logger.warn(`走势图渲染失败，降级为无图卡片: ${String(error?.message || error)}`);
      return null;
    }
  }

  /**
   * Push at most one card for one collection attempt (spec §1.1 + A2.2 §5).
   *
   *  - no usable channel config → `skipped:'no-config'`: no state entry and no
   *    log line, so a panel with notifications off never shows a red failure;
   *  - same key as the last delivered card → `skipped:'duplicate'` (data is
   *    already stored by the caller), keep the previous delivery record;
   *  - otherwise deliver exactly once:
   *      app      render PNG → upload for `img_key` → send card to the chat
   *               (a failed render/upload sends the same card without an image);
   *      webhook  custom bot, text-only by nature;
   *    then record `{hash, at, ok, error, kind}` in `state.delivery` plus one
   *    line in the delivery log.
   *
   * Never throws: a delivery problem must not affect data collection.
   */
  async function deliverReport(monitor, report) {
    try {
      const channel = resolveChannel(store.getConfig());
      if (channel.kind === 'none') return { skipped: 'no-config' };
      const hash = deliveryKeyFor(report);
      const previous = store.getState().delivery?.[monitor.id];
      if (previous && previous.hash === hash) return { skipped: 'duplicate' };

      let result;
      if (channel.kind === 'app') {
        // 图先渲染好再交给 feishu.js：上传失败时它照样发正文（无图降级）。
        const png = renderTrend(report);
        result = await deliverAppCard({
          appId: channel.appId,
          appSecret: channel.appSecret,
          chatId: channel.chatId,
          png,
          buildCard: (imageKey) => buildCardFor(monitor, report, imageKey),
          logger,
        });
      } else {
        // 自定义机器人不能带图，正文照发。
        result = await sendFeishu(channel.webhook, buildCardFor(monitor, report, null), { logger });
      }
      const at = isoNow();
      const entry = {
        hash,
        at,
        ok: result.ok === true,
        error: result.ok === true ? null : String(result.error || '投递失败'),
        kind: report.kind,
      };
      const state = store.getState();
      await store.saveState({ delivery: { ...(state.delivery || {}), [monitor.id]: entry } });
      await store.appendDelivery({
        monitorId: monitor.id,
        title: monitor.title,
        kind: entry.kind,
        at,
        ok: entry.ok,
        error: entry.error,
      });
      if (!entry.ok) logger.warn(`飞书投递失败（不重试） ${monitor.title}: ${entry.error}`);
      return {
        delivered: entry.ok,
        error: entry.error,
        channel: channel.kind,
        image: channel.kind === 'app' ? Boolean(result.imageKey) : false,
      };
    } catch (error) {
      logger.warn(`投递流程异常 ${monitor?.title || monitor?.id}: ${String(error?.message || error)}`);
      return { error: String(error?.message || error) };
    }
  }

  /** Newest delivery attempt across all monitors, for `/status.notify`. */
  function lastDeliveryOf(state) {
    let last = null;
    for (const entry of Object.values(state?.delivery || {})) {
      if (!entry || typeof entry.at !== 'string') continue;
      if (!last || Date.parse(entry.at) > Date.parse(last.at)) last = entry;
    }
    if (!last) return null;
    return { at: last.at, ok: last.ok === true, error: last.error || null, kind: last.kind || 'calendar' };
  }
  // #endregion

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

  // #region failure bookkeeping
  /** Lowest positive total of a calendar row list (null when the leg has no price). */
  function lowestOfRows(rows) {
    if (!Array.isArray(rows)) return null;
    let best = null;
    for (const row of rows) {
      const total = Number(row?.total);
      if (Number.isFinite(total) && total > 0 && (best === null || total < best)) best = total;
    }
    return best;
  }

  /**
   * 记一次失败的采集：累加失败次数 + 最近一次原因。面板的「上次采集失败原因」
   * 与 `/status.failures` 都读这里；投递失败卡片由 `deliverReport` 单独负责。
   */
  async function recordFailure(monitor, message) {
    const state = store.getState();
    const failures = { ...(state.failures || {}) };
    const count = Number(failures[monitor.id] || 0) + 1;
    failures[monitor.id] = count;
    await store.saveState({
      failures,
      lastError: { ...(state.lastError || {}), [monitor.id]: { at: isoNow(), message, count } },
    });
  }

  /** 采集成功后清掉该监控的失败计数与原因。 */
  async function clearFailure(monitor) {
    const state = store.getState();
    await store.saveState({
      failures: { ...(state.failures || {}), [monitor.id]: 0 },
      lastError: { ...(state.lastError || {}), [monitor.id]: null },
    });
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

  /**
   * 行情模式（spec §4.1）：只写日历快照，不写价格序列。成功/失败都会投递一张
   * 卡片（A2 §1.1：每次采集尝试后一条），失败卡片同样受幂等约束。
   */
  async function collectCalendarOne(monitor) {
    const startedAt = isoNow();
    try {
      // 先读旧快照：卡片上的「比上次 ±x%」需要上一轮的最低值。
      const previousSnapshot = await store.readCalendarSnapshot(monitor.id);
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
      const delivery = await deliverReport(monitor, {
        kind: 'calendar',
        snapshot,
        previous: previousSnapshot
          ? { out: lowestOfRows(previousSnapshot.out), back: lowestOfRows(previousSnapshot.back) }
          : null,
      });
      return { ok: true, source: 'calendar', points: 0, delivery };
    } catch (error) {
      const message = String(error?.message || error);
      logger.warn(`日历采集失败 ${monitor.title}: ${message}`);
      await recordFailure(monitor, message);
      await setNextDue(monitor.id, computeNextDue(monitor));
      const delivery = await deliverReport(monitor, { kind: 'failure', error: message });
      return { ok: false, error: message, source: 'calendar', points: 0, delivery };
    }
  }

  /**
   * 监控模式（spec §4.2）：只走 L2，绝不调 L1。
   *
   * 前置条件只有两个；任一不满足就只记错误、不写点。风控页 / 登录失效 / 其它
   * 异常同样只记错误、不写点，图表因此留空洞 —— 这是故意的：L1 参考价与乘客
   * 实付价不是同一种数，混写会画出假曲线。无论成功还是失败，最后都投递一张卡片。
   */
  async function collectWatchOne(monitor) {
    const startedAt = isoNow();
    const ready = await l2Ready();
    if (!ready.ok) {
      await recordFailure(monitor, ready.message);
      await setNextDue(monitor.id, computeNextDue(monitor));
      const delivery = await deliverReport(monitor, { kind: 'failure', error: ready.message });
      return { ok: false, error: ready.message, skipped: ready.reason, source: 'l2', points: 0, delivery };
    }

    try {
      // 先读旧快照：卡片要「比上次 ±x%」，用它上一次的最低价。
      const previousSnapshot = await store.readFlightsSnapshot(monitor.id);
      const previous = Number(previousSnapshot?.lowest?.total);
      const result = await browser.collect(monitor);
      const at = isoNow();
      const points = Array.isArray(result?.points) ? result.points : [];
      const flights = Array.isArray(result?.flights) ? result.flights : [];
      const lowest = result?.lowest || null;
      await store.appendPoints(monitor.id, points);
      await store.writeFlightsSnapshot(monitor.id, { fetchedAt: at, flights, tax: result?.tax || null, lowest });
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
      // 卡片的「最近 20 次采集走势」取每次采集的最低可订价（同一次采集共享 at）。
      const history = await store.readPoints(monitor.id, { limit: 600 });
      const minSeriesTotals = minSeries(history).slice(-20).map((entry) => entry.total);
      const delivery = await deliverReport(monitor, {
        kind: 'watch',
        flights,
        lowest,
        previous: Number.isFinite(previous) && previous > 0 ? previous : null,
        minSeries: minSeriesTotals,
      });
      return { ok: true, source: 'l2', points: points.length, delivery };
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
      await recordFailure(monitor, message);
      const blocked = error instanceof BlockedError || error?.code === 'BLOCKED';
      if (blocked) logger.warn(`携程返回风控页，${monitor.title} 跳过一次采集`);
      // 唯一安全阀：风控页额外推后一个完整周期（跳过一轮）；其它失败按正常节奏。
      await setNextDue(monitor.id, blocked ? blockedNextDue(monitor) : computeNextDue(monitor));
      const delivery = await deliverReport(monitor, { kind: 'failure', error: message });
      return { ok: false, error: message, source: 'l2', points: 0, delivery };
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

  // #region expired monitors (D1)
  /**
   * 这个监控的「最后一天」：单程看 departDate，往返看 returnDate。行情模式没有
   * 日期（日期待定），永远返回 null —— 它不该因为时间流逝被删掉。
   */
  function expiryDateOf(monitor) {
    if (monitor?.mode !== 'watch') return null;
    const params = monitor?.params || {};
    const date = params.trip === 'round' ? params.returnDate || params.departDate : params.departDate;
    return isDateString(date) ? date : null;
  }

  /**
   * `date < 本地今天` 才算过期：今天出发（或今天返程）的监控仍然有效，
   * 只有整趟行程都已经过去才该退订。`isoDate()` 用的是 Host 本地时区，
   * 与用户看到的日期一致。
   */
  function isExpired(monitor, today = isoDate()) {
    const date = expiryDateOf(monitor);
    return Boolean(date) && date < today;
  }

  /**
   * 删除过期监控（D1，用户明确要求「直接自动清除」而不是停用）。
   *
   * 两点是有意的：
   *  - 在**任何采集之前**执行：让过期监控再跑一次 L2 是白费一次浏览器采集；
   *  - **不投递任何卡片**：行程结束了就不该再收到「新低价 / 采集失败」的消息，
   *    幂等键和投递日志也不必为一条已消失的监控留痕。
   * `store.removeMonitor` 负责清掉快照/序列文件与 state 里的残留条目。
   */
  async function purgeExpiredMonitors() {
    let removed = 0;
    const today = isoDate();
    for (const monitor of store.listMonitors()) {
      if (!isExpired(monitor, today)) continue;
      try {
        if (!(await store.removeMonitor(monitor.id))) continue;
        removed += 1;
        logger.info(`监控已过期（${expiryDateOf(monitor)} 早于 ${today}），已自动删除：${monitor.title} (${monitor.id})`);
      } catch (error) {
        logger.warn(`自动删除过期监控失败 ${monitor.id}: ${String(error?.message || error)}`);
      }
    }
    return removed;
  }
  // #endregion

  async function tick() {
    if (running || disposed) return { ok: true, skipped: 'busy' };
    running = true;
    try {
      await store.init();
      // D1：先清过期监控，再决定采集目标（删除必须早于任何一次采集）。
      const removed = await purgeExpiredMonitors();
      let collected = 0;
      const targets = store.listMonitors().filter((monitor) => monitor.enabled !== false);
      for (const monitor of targets) {
        if (disposed) break;
        const due = Date.parse(store.getState().nextDue?.[monitor.id] || '');
        if (Number.isFinite(due) && due > Date.now()) continue;
        await collectOne(monitor);
        collected += 1;
        // 同一 tick 内多个 monitor 之间也要错开，不要连发。
        await sleep(1500 + Math.floor(Math.random() * 2500));
      }
      return { ok: true, collected, removed };
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
    /**
     * `POST /notify/test`（spec §4）：用当前通道发一张测试卡，成功/失败都原样回给
     * 设置页就地展示。测试消息不参与 per-monitor 幂等，也不写投递日志。
     */
    notifyTest: async () => {
      try {
        await store.init();
        const channel = resolveChannel(store.getConfig());
        if (channel.kind === 'none') {
          return { ok: false, error: '未配置投递通道：请填写 App ID / App Secret / 群 chat_id，或改用手动机器人并填写 webhook' };
        }
        const card = buildTestCard({
          channel: channel.kind,
          chatId: channel.chatId,
          webhook: channel.webhook,
          at: isoNow(),
        });
        const result = channel.kind === 'app'
          ? await deliverAppCard({
            appId: channel.appId,
            appSecret: channel.appSecret,
            chatId: channel.chatId,
            png: null,
            buildCard: () => card,
            logger,
          })
          : await sendFeishu(channel.webhook, card, { logger });
        logger.info(`测试消息投递（${channel.kind}）: ${result.ok ? '成功' : `失败 ${result.error}`}`);
        return { ok: result.ok === true, error: result.ok ? null : String(result.error || '投递失败') };
      } catch (error) {
        logger.warn(`测试消息投递异常: ${String(error?.message || error)}`);
        return { ok: false, error: String(error?.message || error) };
      }
    },
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
        version: '0.6.0',
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
        // A2 §1.3 + A2.2：has-channel 表示当前通道（app / webhook）配置齐全，
        // 不再是「有 webhook 就 true」；lastDelivery 是最近一次真实投递结果。
        notify: { feishu: resolveChannel(config).kind !== 'none', lastDelivery: lastDeliveryOf(state) },
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
