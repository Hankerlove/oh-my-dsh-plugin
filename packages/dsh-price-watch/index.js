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
 * Hotel v1 (docs/design/price-watch-hotel.md): a third mode, `mode:'hotel'`.
 * Creating one first validates the body locally, then asks the (dynamically
 * imported) hotel collector whether the hotel exists — a 422 carries "not found"
 * / "ambiguous" without storing anything. A successful collection appends
 * exactly one price point (the whole-stay lowest total) and writes
 * `hotels/<id>.json`; failures are cards like every other mode, and a network
 * failure is a silent skip + 15-minute retry. Hotel collection never gates on
 * the flight browser login (the data source is anonymous).
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
import { buildCalendarCard, buildFailureCard, buildHotelCard, buildTestCard, buildWatchCard, sendFeishu } from './host/notify.js';
import { createRouter } from './host/routes.js';
import { clampCadence, createStore } from './host/store.js';
import { NETWORK_RETRY_MS, isNetworkError } from './host/net.js';
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

/**
 * 酒店采集器在另一个文件里（`host/collect/hotel.js`），可能还没落地（侦察/实现
 * 归其他人）。动态 import 保证它缺失时插件照样加载，只在新建/采集时降级成一条
 * 可读错误（面板与失败卡都能看到原因）。
 */
async function hotelModule() {
  try {
    return await import('./host/collect/hotel.js');
  } catch (error) {
    const wrapped = new Error(`酒店采集模块不可用：${String(error?.message || error)}`);
    wrapped.code = 'HOTEL_MODULE_UNAVAILABLE';
    throw wrapped;
  }
}

/** 酒店采集错误码 → 面板/失败卡上的中文说明（hotel spec §5）。 */
const HOTEL_ERROR_HINT = {
  HOTEL_NOT_FOUND: '这家酒店在携程上已下架或 id 失效',
  HOTEL_NO_ROOMS: '这段日期已经没有可订房型',
  HOTEL_BAD_RESPONSE: '酒店接口返回的结构变了，暂时解析不出房型',
  HOTEL_MODULE_UNAVAILABLE: '酒店采集模块不可用',
  HOTEL_LOGIN_REQUIRED: '酒店价格需要携程登录，请先在面板里登录后重试',
};

/** 失败文案带上 code 对应的中文说明；collector 自己写清楚时不重复前缀。 */
function hotelFailureMessage(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const hint = HOTEL_ERROR_HINT[code];
  const raw = String(error?.message || error || '酒店采集失败');
  if (!hint) return raw;
  return raw.includes(hint) ? raw : `${hint}（${code}）：${raw}`;
}

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
   *   监控  flights 的 航班号 + 时刻 + 机场 + 含税价 序列（D10 起再加最低价的买法
   *        与联程/两段对比数字，因为卡片上会显示它们）；
   *   失败  错误文本。
   */
  function deliveryKeyFor(report) {
    if (report.kind === 'failure') return hashOf(['failure', String(report.error || '')]);
    if (report.kind === 'hotel') {
      // hotel spec §7：房型（名字+整段价）+ 最低总价 + 入离日期；同一份数据不重复推。
      const rooms = (Array.isArray(report.snapshot?.rooms) ? report.snapshot.rooms : [])
        .map((room) => [room?.name || '', Number(room?.price?.total) || null]);
      return hashOf([
        'hotel',
        rooms,
        Number(report.snapshot?.lowest?.total) || null,
        report.snapshot?.checkIn || null,
        report.snapshot?.checkOut || null,
      ]);
    }
    if (report.kind === 'watch') {
      const flights = (Array.isArray(report.flights) ? report.flights : []).map((flight) => [
        flight?.no || '',
        flight?.depTime || '',
        flight?.arrTime || '',
        flight?.depAirport || '',
        flight?.arrAirport || '',
        Number.isFinite(flight?.taxIncluded) ? flight.taxIncluded : null,
      ]);
      // D10：往返卡片会打印联程/两段的数字与结论、以及「联程/两段单买」标签，
      // 这些变化必须改变幂等键，否则卡片内容变了却不推。
      const roundTrip = report.roundTrip && typeof report.roundTrip === 'object'
        ? [
          Number(report.roundTrip.round?.payable) || null,
          Number(report.roundTrip.oneway?.sum) || null,
          report.roundTrip.comparison?.cheaper || null,
          report.roundTrip.partial === true,
        ]
        : null;
      return hashOf(['watch', flights, report.lowest?.scheme || null, roundTrip]);
    }
    const rows = (list) => (Array.isArray(list) ? list.map((row) => [row?.date || '', Number(row?.total) || 0]) : null);
    return hashOf(['calendar', rows(report.snapshot?.out), rows(report.snapshot?.back)]);
  }

  /**
   * The card body for one collection report. `imageKey` is the `img_key` of the
   * freshly uploaded trend PNG (`null` for the webhook channel, for a failed
   * upload, or when there are not enough points to draw anything).
   */
  function buildCardFor(monitor, report, imageKey = null, trend = null) {
    // 页脚时间用「这次采集的时间」而不是投递那一刻：两者只差几秒，但报告要对得上
    // 面板里的「采集于 …」。
    const at = report.at || (report.snapshot && report.snapshot.fetchedAt) || undefined;
    if (report.kind === 'failure') return buildFailureCard({ monitor, error: report.error, at });
    if (report.kind === 'hotel') {
      return buildHotelCard({
        monitor,
        snapshot: report.snapshot || null,
        previous: report.previous ?? null,
        imageKey,
        at,
        trend,
      });
    }
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
        // D10：往返监控多两行对比（联程 / 两段单买 / 谁更便宜）；单程为 null。
        roundTrip: report.roundTrip || null,
        imageKey,
        at,
        trend,
      });
    }
    return buildCalendarCard({
      monitor,
      out: report.snapshot?.out || [],
      back: report.snapshot?.back || null,
      previous: report.previous,
      imageKey,
      at,
      trend,
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

  /** `11-18`：X 轴刻度（日期）。 */
  function shortDayLabel(value) {
    const parts = String(value || '').split('-');
    return parts.length === 3 ? `${parts[1]}-${parts[2]}` : '';
  }

  /** `11-18 10:53` 的本地时刻部分：同一天的多次采集靠时间区分。 */
  function clockLabel(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** 本地日期键，用来判断「这批点是不是同一天」。 */
  function dayKey(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /**
   * 走势图的数据：`{ values, labels }` 等长，labels 就是 X 轴刻度文字。
   *
   *  - 监控 / 酒店：最近 20 次采集的最低可订价（酒店是整段最低总价），刻度用
   *    采集日期（同一天内多次采集则退到时分，否则 20 个点全是同一个日期标签、
   *    刻度没有信息量）；
   *  - 行情模式：未来 30 天的日历最低价，刻度用日期。
   */
  function trendDataFor(report) {
    if (report?.kind === 'watch' || report?.kind === 'hotel') {
      const points = (Array.isArray(report.minSeries) ? report.minSeries : [])
        .map((entry) => ({
          total: Number(entry?.total ?? entry),
          at: typeof entry?.at === 'string' ? entry.at : '',
        }))
        .filter((point) => Number.isFinite(point.total) && point.total > 0)
        .slice(-20);
      const sameDay = new Set(points.map((point) => dayKey(point.at))).size <= 1;
      const labels = points.map((point) => (sameDay ? clockLabel(point.at) : shortDayLabel(dayKey(point.at) || point.at)));
      return { values: points.map((point) => Math.round(point.total)), labels };
    }
    const points = (Array.isArray(report?.snapshot?.out) ? report.snapshot.out.slice(0, 30) : [])
      .map((row) => ({ total: Number(row?.total), date: row?.date }))
      .filter((point) => Number.isFinite(point.total) && point.total > 0);
    return {
      values: points.map((point) => Math.round(point.total)),
      labels: points.map((point) => shortDayLabel(point.date)),
    };
  }

  /**
   * Render the trend PNG for a report, or null when the report has no chart.
   *
   *  - 失败卡永远不带图；
   *  - 点数不足 2 个（监控首次采集）不发图：一次采集没有走势可言，卡片照样有
   *    结论和明细，不塞一张空白占位图；
   *  - 渲染本身出错才降级为无图卡片（投递不能因此中断）。
   */
  function renderTrend(report, trend) {
    if (report.kind === 'failure') return null;
    try {
      const values = Array.isArray(trend?.values) ? trend.values : [];
      // A single point draws nothing worth looking at (the first collection of a
      // monitor). Send the card without an image instead of a blank placeholder.
      if (values.length < 2) return null;
      // 1280×640（设计基准的 2 倍）：飞书里按卡片宽 ~636px 显示，2 倍图在视网膜屏更锐。
      return renderTrendPng(values, { labels: trend?.labels || [] });
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

      // 走势数据只算一次：图（横/纵轴刻度）与卡片（区间统计）必须来自同一批点。
      const trend = trendDataFor(report);
      let result;
      if (channel.kind === 'app') {
        // 图先渲染好再交给 feishu.js：上传失败时它照样发正文（无图降级）。
        const png = renderTrend(report, trend);
        result = await deliverAppCard({
          appId: channel.appId,
          appSecret: channel.appSecret,
          chatId: channel.chatId,
          png,
          buildCard: (imageKey) => buildCardFor(monitor, report, imageKey, trend),
          logger,
        });
      } else {
        // 自定义机器人不能带图，正文照发。
        result = await sendFeishu(channel.webhook, buildCardFor(monitor, report, null, trend), { logger });
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

  /**
   * 网络类失败的补采时间：不按用户节奏等（可能是 6/12 小时），15 分钟后就试。
   * 典型场景是笔记本休眠：维护唤醒窗口里网络还没就绪，等机器醒着就会成功。
   */
  function retrySoon() {
    return new Date(Date.now() + NETWORK_RETRY_MS).toISOString();
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
        // 卡片只看「未来 30 天」窗口（见 host/notify.js 的 CARD_WINDOW_DAYS），
        // 上一轮也要按同一个窗口取最低价，否则涨跌幅会拿 30 天价去比一年最低价。
        previous: previousSnapshot
          ? {
            out: lowestOfRows((previousSnapshot.out || []).slice(0, 30)),
            back: lowestOfRows((previousSnapshot.back || []).slice(0, 30)),
          }
          : null,
      });
      return { ok: true, source: 'calendar', points: 0, delivery };
    } catch (error) {
      const message = String(error?.message || error);
      // 休眠/断网：不当成「采集失败」处理——不发失败卡（否则每次维护唤醒都推一张），
      // 只把原因写进面板，并在 15 分钟后补采。
      if (isNetworkError(error)) {
        const note = `网络不可用（可能刚休眠/断网），本轮跳过，${Math.round(NETWORK_RETRY_MS / 60000)} 分钟后重试：${message}`;
        logger.warn(`日历采集跳过 ${monitor.title}: ${note}`);
        await recordFailure(monitor, note);
        await setNextDue(monitor.id, retrySoon());
        return { ok: false, error: message, source: 'calendar', points: 0, delivery: { skipped: 'network' } };
      }
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
      // D10：往返监控带上「联程 vs 两段单买」的对比；单程监控这里是 undefined。
      const roundTrip = result?.roundTrip && typeof result.roundTrip === 'object' ? result.roundTrip : null;
      await store.appendPoints(monitor.id, points);
      await store.writeFlightsSnapshot(monitor.id, { fetchedAt: at, flights, tax: result?.tax || null, lowest, roundTrip });
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
      // 走势要画在时间轴上，所以保留 {at, total}，别只留价格数组。
      const minSeriesRows = minSeries(history).slice(-20);
      const delivery = await deliverReport(monitor, {
        kind: 'watch',
        at,
        flights,
        lowest,
        roundTrip,
        previous: Number.isFinite(previous) && previous > 0 ? previous : null,
        minSeries: minSeriesRows,
      });
      return { ok: true, source: 'l2', points: points.length, delivery };
    } catch (error) {
      const message = String(error?.message || error);
      const state = store.getState();
      if (isNetworkError(error)) {
        const note = `网络不可用（可能刚休眠/断网），本轮跳过，${Math.round(NETWORK_RETRY_MS / 60000)} 分钟后重试：${message}`;
        logger.warn(`监控采集跳过 ${monitor.title}: ${note}`);
        await store.saveState({
          l2LastRunBy: { ...(state.l2LastRunBy || {}), [monitor.id]: isoNow() },
          l2LastOk: { ...(state.l2LastOk || {}), [monitor.id]: false },
          l2LastError: note,
        });
        await recordFailure(monitor, note);
        await setNextDue(monitor.id, retrySoon());
        return { ok: false, error: message, source: 'l2', points: 0, delivery: { skipped: 'network' } };
      }
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

  /**
   * 酒店模式（hotel spec §4/§6.4）：每轮成功采集只追加 **1 个点** —— 该酒店这段
   * 日期的最低整段总价，快照落 `hotels/<id>.json`。
   *
   * 与机票监控的差别（有意为之）：
   *  - **不 gate 登录态**（`l2Ready()`）：酒店接口是匿名数据源，不该被携程登录态
   *    挡住；collector 万一抛 `AuthError` 就走下面的通用失败分支；
   *  - 网络类失败静默跳过（记 note + 15 分钟后补采，不发失败卡），其余失败
   *    （HOTEL_NOT_FOUND / HOTEL_NO_ROOMS / HOTEL_BAD_RESPONSE / 其它）都记
   *    failure + 正常节奏 + 一张失败卡，error 文案带 code 对应的中文说明。
   */
  async function collectHotelOne(monitor) {
    const startedAt = isoNow();
    try {
      // 先读旧快照：卡片的「比上次 ±x%」用上一轮的最低整段总价。
      const previousSnapshot = await store.readHotelSnapshot(monitor.id);
      const previousTotal = Number(previousSnapshot?.lowest?.total);
      const module = await hotelModule();
      // 房型价格在匿名态是隐藏的（「登录看低价」）：酒店采集复用机票那份已登录的
      // 持久化 profile —— 用 browser.withPage 在共享 context 里开一个临时页，
      // 与机票采集共用同一个串行队列，用完自动关页。仍然**不** gate l2Ready()：
      // 登录态缺失时 collector 抛 HOTEL_LOGIN_REQUIRED，走通用失败分支。
      const snapshot = await module.collectHotel(monitor, { logger, withPage: (fn) => browser.withPage(fn) });
      // 先落快照：writeHotelSnapshot 会把字段白名单规范化（数字取整、rooms 升序）。
      const doc = await store.writeHotelSnapshot(monitor.id, snapshot);
      const lowest = doc?.lowest && Number(doc.lowest.total) > 0 ? doc.lowest : null;
      if (!lowest) {
        // 契约 §3：一个可订房型都没有 ⇒ 按采集失败处理，不写价格点。
        const error = new Error('酒店采集结果里没有可订房型');
        error.code = 'HOTEL_NO_ROOMS';
        throw error;
      }
      const at = typeof doc.fetchedAt === 'string' ? doc.fetchedAt : startedAt;
      await store.appendPoints(monitor.id, [{
        at,
        key: { roomName: lowest.roomName },
        price: { total: lowest.total, bare: lowest.total },
        src: 'hotel',
      }]);
      const state = store.getState();
      await store.saveState({
        lastCollectAt: startedAt,
        lastCollectBy: { ...(state.lastCollectBy || {}), [monitor.id]: startedAt },
        failures: { ...(state.failures || {}), [monitor.id]: 0 },
        lastError: { ...(state.lastError || {}), [monitor.id]: null },
      });
      await setNextDue(monitor.id, computeNextDue(monitor));
      // 卡片的「最近 20 次采集走势」= 每轮最低整段总价（minSeries 天然如此）。
      const history = await store.readPoints(monitor.id, { limit: 600 });
      const delivery = await deliverReport(monitor, {
        kind: 'hotel',
        at,
        snapshot: doc,
        previous: Number.isFinite(previousTotal) && previousTotal > 0 ? previousTotal : null,
        minSeries: minSeries(history).slice(-20),
      });
      return { ok: true, source: 'hotel', points: 1, delivery };
    } catch (error) {
      const message = String(error?.message || error);
      if (isNetworkError(error)) {
        const note = `网络不可用（可能刚休眠/断网），本轮跳过，${Math.round(NETWORK_RETRY_MS / 60000)} 分钟后重试：${message}`;
        logger.warn(`酒店采集跳过 ${monitor.title}: ${note}`);
        await recordFailure(monitor, note);
        await setNextDue(monitor.id, retrySoon());
        return { ok: false, error: message, source: 'hotel', points: 0, delivery: { skipped: 'network' } };
      }
      const failureText = hotelFailureMessage(error);
      logger.warn(`酒店采集失败 ${monitor.title}: ${failureText}`);
      await recordFailure(monitor, failureText);
      await setNextDue(monitor.id, computeNextDue(monitor));
      const delivery = await deliverReport(monitor, { kind: 'failure', error: failureText });
      return { ok: false, error: failureText, source: 'hotel', points: 0, delivery };
    }
  }

  /** Dispatch by mode; a failure never escapes into the scheduler. */
  async function collectOne(monitor) {
    try {
      if (monitor.mode === 'calendar') return await collectCalendarOne(monitor);
      if (monitor.mode === 'hotel') return await collectHotelOne(monitor);
      return await collectWatchOne(monitor);
    } catch (error) {
      logger.warn(`采集流程异常 ${monitor?.title || monitor?.id}: ${String(error?.message || error)}`);
      return { ok: false, error: String(error?.message || error) };
    }
  }
  // #endregion

  // #region expired monitors (D1)
  /**
   * 这个监控的「最后一天」：单程看 departDate，往返看 returnDate，酒店看
   * checkOut（契约 §6.4：`checkOut < 今天` 即过期）。行情模式没有日期
   * （日期待定），永远返回 null —— 它不该因为时间流逝被删掉。
   */
  function expiryDateOf(monitor) {
    const params = monitor?.params || {};
    if (monitor?.mode === 'hotel') {
      return isDateString(params.checkOut) ? params.checkOut : null;
    }
    if (monitor?.mode !== 'watch') return null;
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
     * 新建酒店表单的联想下拉（hotel spec §6.5）：只读、不落库、不写日志。
     *
     * 纯 HTTP 数据源（60s 缓存由采集器负责），Host 这边只做参数校验与错误归类：
     *  - keyword 1–40 字，否则普通 Error ⇒ 路由 400；
     *  - 检索器未落地 / 没导出 suggestHotels ⇒ 502 `HOTEL_MODULE_UNAVAILABLE`；
     *  - 网络不可用 ⇒ 502 `HOTEL_SUGGEST_NETWORK`；
     *  - 成功原样透传（最多 8 条，字段一个不加）。
     */
    hotelSuggest: async (body) => {
      const input = body && typeof body === 'object' ? body : {};
      const keyword = String(input.keyword ?? '').trim();
      const keywordLength = [...keyword].length;
      if (keywordLength < 1 || keywordLength > 40) throw new Error('酒店名称需要 1–40 个字');

      const module = await hotelModule();
      if (typeof module.suggestHotels !== 'function') {
        const missing = new Error('酒店检索模块不可用：suggestHotels 未导出');
        missing.code = 'HOTEL_MODULE_UNAVAILABLE';
        throw missing;
      }

      let hotels;
      try {
        hotels = await module.suggestHotels({
          city: String(input.city ?? '').trim().toUpperCase(),
          cityName: String(input.cityName ?? '').trim(),
          keyword,
        });
      } catch (error) {
        if (isNetworkError(error)) {
          const network = new Error('检索酒店时网络不可用，请稍后再试');
          network.code = 'HOTEL_SUGGEST_NETWORK';
          throw network;
        }
        // 解析/结构异常等非网络问题：502，别把 500 堆栈丢给表单。
        const failure = new Error(`检索酒店失败：${String(error?.message || error)}`);
        failure.status = 502;
        throw failure;
      }
      return { hotels: (Array.isArray(hotels) ? hotels : []).slice(0, 8) };
    },
    /**
     * 新建酒店监控（hotel spec §6.1）：本地校验 → 远端校验酒店存在 → 落库 → 立即采集。
     * 路由只负责把这里抛出的 `code` 映射成 400/422/502，不做任何网络请求。
     *
     * 返回 store 里的 monitor 对象；列表项由 routes 用 `monitorListItem()` 组装。
     */
    createHotelMonitor: async (body) => {
      await store.init();
      // 1) 本地校验（普通 Error ⇒ 路由 400）。必须在远端校验之前，省一次请求。
      const params = store.validateHotelInput(body);
      const cadence = body && typeof body === 'object' ? body.cadence : undefined;

      // 2) 远端校验：这家酒店在携程上到底存不存在。
      const module = await hotelModule();

      // 2a) 联想下拉选中后带 hotelId（契约 §6.1）：confirmHotelId 确认这个 id 仍在
      //     候选里（纯 HTTP，不占浏览器），通过就直接用该 id 落库、**跳过名称匹配**，
      //     避免「全季酒店(上海虹桥中山西路店)」被错配到同品牌另一家门店。
      //     confirmHotelId 还没落地时退回下面的名称匹配流程（不因新接口缺失报错）。
      if (params.hotelId && typeof module.confirmHotelId === 'function') {
        let stillValid;
        try {
          stillValid = await module.confirmHotelId({
            hotelId: params.hotelId,
            hotelName: params.hotelName || params.keyword,
            cityName: params.cityName,
          });
        } catch (error) {
          if (isNetworkError(error)) {
            const network = new Error('校验酒店时网络不可用，请稍后再试');
            network.code = 'HOTEL_LOOKUP_NETWORK';
            throw network;
          }
          throw error;
        }
        if (stillValid !== true) {
          const stale = new Error('这家酒店在携程上已下架或名称有变化，请重新选择');
          stale.code = 'HOTEL_LOOKUP_STALE';
          throw stale;
        }
        const monitor = await store.createHotelMonitor({
          params: { ...params, hotelId: params.hotelId, hotelName: params.hotelName || params.keyword },
          cadence,
        });
        void actions.refreshMonitor(monitor.id, { immediate: true }).catch(() => {});
        return monitor;
      }

      // 2b) 名称匹配（不带 hotelId，或 confirmHotelId 尚未落地）：保持原流程。
      let lookup;
      try {
        lookup = await module.lookupHotel({
          city: params.city,
          cityName: params.cityName,
          keyword: params.keyword,
          // 列表页搜索结果强依赖用户真实日期（实测：用今天搜不到目标门店、还会错配
          // 到同品牌另一家店），所以必须把用户选的入住/离店日期透传给采集器。
          checkIn: params.checkIn,
          checkOut: params.checkOut,
          // 与采集同一份已登录 context；playwright 未装时它会自己抛错，走 502/错误映射。
          withPage: (fn) => browser.withPage(fn),
        });
      } catch (error) {
        if (isNetworkError(error)) {
          const network = new Error('校验酒店时网络不可用，请稍后再试');
          network.code = 'HOTEL_LOOKUP_NETWORK';
          throw network;
        }
        throw error;
      }

      if (!lookup || lookup.found !== true) {
        if (lookup && lookup.reason === 'ambiguous') {
          // 采集器可能给更具体的提示（品牌词 →「这是品牌名，请选择具体门店」），
          // 有就用它，没有退回通用文案。客户端把 error 原文显示在表单里。
          const hint = typeof lookup.hint === 'string' ? lookup.hint.trim() : '';
          const ambiguous = new Error(hint !== '' ? hint : '匹配到多家同名酒店，请把酒店名称写得更完整');
          ambiguous.code = 'HOTEL_AMBIGUOUS';
          ambiguous.candidates = (Array.isArray(lookup.candidates) ? lookup.candidates : [])
            .slice(0, 5)
            .map((candidate) => ({
              id: candidate && candidate.id !== undefined && candidate.id !== null ? String(candidate.id) : '',
              name: String(candidate?.name || ''),
              address: String(candidate?.address || ''),
              score: Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : null,
            }));
          throw ambiguous;
        }
        // 不存在就不落库：422 之后 monitors.json 不能多出任何东西。
        const notFound = new Error(`携程上没有找到「${params.keyword}」这家酒店，请检查城市和酒店名称`);
        notFound.code = 'HOTEL_NOT_FOUND';
        throw notFound;
      }

      const hotel = lookup.hotel && typeof lookup.hotel === 'object' ? lookup.hotel : {};
      const monitor = await store.createHotelMonitor({
        params: { ...params, hotelId: hotel.id, hotelName: hotel.name },
        cadence,
      });
      // 3) 落库成功 → 立即异步采集一次；HTTP 响应不等它。
      void actions.refreshMonitor(monitor.id, { immediate: true }).catch(() => {});
      return monitor;
    },
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
        version: '0.15.0',
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

  logger.info('price-watch 已加载（行情=L1 / 监控=L2 / 酒店=匿名接口，统一频率档位）');
}
