/**
 * HTTP surface of price-watch, registered as one `webServer` prefix route.
 *
 * Everything is JSON under `/price-watch/api/*` except `/price-watch/`, which
 * serves the standalone read-only page. Handlers never throw: a failure becomes
 * `{ ok: false, error }` with a sensible status.
 *
 * The list view is deliberately light (contract §9): it never reads a whole
 * series, just the last points needed for `latest` / `spark`, plus the calendar
 * summary for date-less monitors. The detail endpoints (`/calendar`, `/flights`,
 * `/prices`) carry the heavy payloads.
 *
 * A2 additions: `/deliveries` (with `/alerts` as an alias) exposes the delivery
 * log, `/prices` gained the per-collection `min` series (the old L1 `reference`
 * line is gone), and every list item carries `delivery: { at, ok, error } | null`
 * plus `lastError` so the panel never has to join against `/status`.
 *
 * Write requests pass a same-origin check because plugin routes are not behind
 * the Host web token. Bodies are capped and destroyed when oversized.
 */
import { MAX_BODY_BYTES, minSeries } from './util.js';
import { renderPage } from './page.js';

const API = '/api';
/** Detail charts keep 90 days, capped at 2000 points (contract §9). */
const DETAIL_POINTS_MAX = 2000;
/** How many series points the light list view returns. */
const SPARK_POINTS = 60;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Same-origin guard for state-changing requests. */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetch may omit it; Host/proxy already accepted
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Ascending, validated `out` rows of a calendar snapshot. */
function calendarRows(doc) {
  return (Array.isArray(doc?.out) ? doc.out : [])
    .filter((row) => row && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number(row.total) > 0)
    .map((row) => ({ date: row.date, total: Number(row.total), bare: Number(row.bare) || Number(row.total) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The light summary the list view renders for a calendar monitor (contract §9). */
function calendarSummary(doc) {
  const rows = calendarRows(doc);
  if (rows.length === 0) return null;
  const byTotal = rows.slice().sort((a, b) => a.total - b.total);
  const cheapest = byTotal.slice(0, 3).sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({ date: row.date, total: row.total }));
  const min = byTotal[0];
  const max = byTotal[byTotal.length - 1];
  return {
    fetchedAt: doc?.fetchedAt || null,
    count: rows.length,
    min: { date: min.date, total: min.total },
    max: { date: max.date, total: max.total },
    cheapest,
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {object} deps.logger
 * @param {{ refreshMonitor:(id:string, options?:object)=>Promise<object>, refreshAll:()=>Promise<object>, status:()=>Promise<object>, panelUrl:()=>string }} deps.actions
 */
export function createRouter({ store, logger, actions }) {
  /** `l2: { lastAt, ok }` for the list item; `null` until the monitor ran L2. */
  function l2Summary(monitor) {
    const state = store.getState();
    const lastAt = state.l2LastRunBy?.[monitor.id] || null;
    if (!lastAt) return null;
    return { lastAt, ok: state.l2LastOk?.[monitor.id] !== false };
  }

  /**
   * Why this monitor's last collection failed, as one plain string (or null).
   *
   * The client reads exactly this field in the list and detail views, so it must
   * not leak the internal `{ at, message, count }` record: a success stores
   * `null` for the monitor, and every failure path (L1 calendar, L2 browser,
   * missing login) goes through the same `state.lastError[id]` slot.
   */
  function lastErrorOf(monitor) {
    const entry = store.getState().lastError?.[monitor.id];
    const message = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.message : null;
    return typeof message === 'string' && message ? message : null;
  }

  /**
   * Last delivery result for the list item (A2 §1.3): `{ at, ok, error }` or
   * null when nothing was ever pushed. Deliberately drops `hash` and `kind`:
   * the panel does not need the fingerprint, and leaking it invites a client to
   * compute its own idempotency.
   */
  function deliveryOf(monitor) {
    const entry = store.getState().delivery?.[monitor.id];
    if (!entry || typeof entry.at !== 'string') return null;
    return { at: entry.at, ok: entry.ok === true, error: entry.error || null };
  }

  /** One list item, exactly the fields spec §5 promises. */
  async function monitorListItem(monitor) {
    const item = {
      id: monitor.id,
      title: monitor.title,
      // `type` is the top-level product kind (flight / hotel). Hotel monitors are
      // not implemented yet, so every stored monitor reads back as a flight.
      type: monitor.type === 'hotel' ? 'hotel' : 'flight',
      mode: monitor.mode,
      enabled: monitor.enabled !== false,
      params: monitor.params,
      passengerIds: monitor.passengerIds || [],
      // 频率模型 v2：只有一种节奏写法 `{ minutes }`，两种模式同构；
      // 预算 / 退避 / 每日次数相关的字段一律不再出现在列表项里。
      cadence: monitor.cadence || {},
      nextDue: store.getState().nextDue?.[monitor.id] || null,
      // 客户端只读这一个字段：最近一次采集失败原因，成功后为 null。
      lastError: lastErrorOf(monitor),
      // A2 §1.3：最近一次「投递」结果（不是采集结果），未投递过为 null。
      delivery: deliveryOf(monitor),
      updatedAt: monitor.updatedAt,
      latest: null,
      spark: [],
      calendarSummary: null,
      hasFlights: false,
      l2: null,
    };

    if (monitor.mode === 'calendar') {
      const summary = calendarSummary(await store.readCalendarSnapshot(monitor.id));
      item.calendarSummary = summary;
      if (summary) item.latest = { total: summary.min.total, at: summary.fetchedAt, note: '380天最低' };
      return item;
    }

    const points = await store.readPoints(monitor.id, { limit: SPARK_POINTS });
    const latest = points.length ? points[points.length - 1] : null;
    if (latest) item.latest = { total: latest.price?.total ?? 0, at: latest.at };
    item.spark = points.map((point) => [point.at, point.price?.total ?? 0]);
    const flights = await store.readFlightsSnapshot(monitor.id);
    item.hasFlights = Boolean(flights && Array.isArray(flights.flights) && flights.flights.length > 0);
    item.l2 = l2Summary(monitor);
    return item;
  }

  async function listMonitors() {
    return Promise.all(store.listMonitors().map((monitor) => monitorListItem(monitor)));
  }

  /** Detail points: last 90 days, at most 2000, flattened as contract §9 asks. */
  async function detailPoints(monitor) {
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    const points = await store.readPoints(monitor.id, { since, limit: 5000 });
    return points.slice(-DETAIL_POINTS_MAX).map((point) => ({
      at: point.at,
      total: point.price?.total ?? 0,
      bare: point.price?.bare ?? 0,
      src: point.src,
      passengerId: point.key?.passengerId || null,
    }));
  }

  async function handleApi(req, res, method, segments, searchParams) {
    // /api/status
    if (segments[0] === 'status' && method === 'GET') {
      return sendJson(res, 200, { ok: true, data: await actions.status() });
    }

    // /api/monitors[...]
    if (segments[0] === 'monitors') {
      if (segments.length === 1) {
        if (method === 'GET') return sendJson(res, 200, { ok: true, data: { monitors: await listMonitors() } });
        if (method === 'POST') {
          const body = await readBody(req);
          const monitor = await store.createMonitor(body);
          logger.info(`新建监控 ${monitor.id} ${monitor.title}`);
          // 创建后立即异步触发一次采集，首次数据不用等心跳。
          void actions.refreshMonitor(monitor.id, { immediate: true });
          return sendJson(res, 201, { ok: true, data: { monitor: await monitorListItem(monitor) } });
        }
        return sendJson(res, 405, { ok: false, error: '方法不支持' });
      }

      const id = segments[1];
      if (!/^m_[0-9a-f]{8}$/.test(id)) return sendJson(res, 400, { ok: false, error: '监控 ID 不合法' });
      const monitor = store.findMonitor(id);
      if (!monitor) return sendJson(res, 404, { ok: false, error: '监控不存在' });

      if (segments[2] === 'refresh' && method === 'POST') {
        // 旧客户端仍会带 `{ l2: true }`：读掉请求体但忽略它。现在行情=立即跑
        // 一次 L1、监控=立即跑一次 L2，没有别的分支。
        await readBody(req).catch(() => ({}));
        const result = await actions.refreshMonitor(id);
        return sendJson(res, 200, { ok: true, data: result });
      }

      if (segments[2] === 'calendar' && method === 'GET') {
        const today = store.today();
        if (monitor.mode !== 'calendar') {
          return sendJson(res, 200, { ok: true, data: { fetchedAt: null, today, out: [], back: null } });
        }
        const doc = await store.readCalendarSnapshot(id);
        return sendJson(res, 200, {
          ok: true,
          data: {
            fetchedAt: doc?.fetchedAt || null,
            today,
            out: calendarRows(doc),
            back: Array.isArray(doc?.back) ? calendarRows({ out: doc.back }) : null,
          },
        });
      }

      if (segments[2] === 'flights' && method === 'GET') {
        // A2 §3.3 snapshot: fetchedAt + tax + lowest + the TOP10 flight array.
        const doc = await store.readFlightsSnapshot(id);
        return sendJson(res, 200, {
          ok: true,
          data: {
            fetchedAt: doc?.fetchedAt || null,
            tax: doc?.tax && typeof doc.tax === 'object' ? doc.tax : null,
            lowest: doc?.lowest && typeof doc.lowest === 'object' ? doc.lowest : null,
            flights: Array.isArray(doc?.flights) ? doc.flights : [],
          },
        });
      }

      if (segments[2] === 'prices' && method === 'GET') {
        const days = Math.max(1, Math.min(3650, Number(searchParams.get('days') || 90)));
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const points = await store.readPoints(id, { since, limit: 5000 });

        // 每位乘客一条序列（L2 点自带 passengerId）。旧的 `reference`（L1 参考价）
        // 已删除：A1 起监控模式完全不调 L1，那个字段只会永远为空。
        const grouped = new Map();
        for (const point of points) {
          const total = Number(point.price?.total);
          if (!Number.isFinite(total) || total <= 0) continue;
          const passengerId = point.key?.passengerId;
          if (!passengerId) continue;
          if (!grouped.has(passengerId)) grouped.set(passengerId, []);
          grouped.get(passengerId).push({
            at: point.at,
            total,
            bare: Number(point.price?.bare) || 0,
            taxSource: point.taxSource || 'estimate',
          });
        }
        const series = [...grouped.entries()].map(([passengerId, groupPoints]) => {
          const passenger = store.findPassenger(passengerId);
          return {
            passengerId,
            passenger: passenger
              ? { nickname: passenger.nickname, type: passenger.type }
              : { nickname: '乘客', type: 'adult' },
            points: groupPoints,
          };
        });

        // A2 §5 新增 `min`：每次采集的最低可订价。同一次采集的所有点共享 `at`，
        // 所以按 `at` 分组取最小值即是「这一轮的结论价」，详情页的趋势图用它。
        const min = minSeries(points);
        const last7 = min.filter((entry) => Date.parse(entry.at) > Date.now() - 7 * 86400000);
        return sendJson(res, 200, {
          ok: true,
          data: {
            min,
            series,
            stats: {
              min: min.length ? Math.min(...min.map((entry) => entry.total)) : null,
              max: min.length ? Math.max(...min.map((entry) => entry.total)) : null,
              avg7: last7.length ? Math.round(last7.reduce((sum, entry) => sum + entry.total, 0) / last7.length) : null,
            },
          },
        });
      }

      if (segments.length === 2) {
        if (method === 'PATCH') {
          const body = await readBody(req);
          const next = await store.updateMonitor(id, body);
          if (!next) return sendJson(res, 404, { ok: false, error: '监控不存在' });
          if (body.cadence !== undefined) {
            // A cadence edit has to take effect now: the scheduler only compares
            // `nextDue`, so a stale entry would keep the old rhythm until the
            // previous interval expired. Dropping it makes the next tick collect.
            const state = store.getState();
            const nextDue = { ...(state.nextDue || {}) };
            delete nextDue[id];
            await store.saveState({ nextDue });
          }
          return sendJson(res, 200, { ok: true, data: { monitor: await monitorListItem(next) } });
        }
        if (method === 'DELETE') {
          await store.removeMonitor(id);
          logger.info(`删除监控 ${id}`);
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            data: { ...(await monitorListItem(monitor)), points: await detailPoints(monitor) },
          });
        }
      }
      return sendJson(res, 405, { ok: false, error: '方法不支持' });
    }

    // /api/passengers[...]
    if (segments[0] === 'passengers') {
      if (segments.length === 1) {
        if (method === 'GET') return sendJson(res, 200, { ok: true, data: { passengers: store.listPassengers() } });
        if (method === 'POST') {
          const body = await readBody(req);
          const passenger = await store.addPassenger(body);
          return sendJson(res, 201, { ok: true, data: { passenger } });
        }
        return sendJson(res, 405, { ok: false, error: '方法不支持' });
      }
      const id = segments[1];
      if (!/^p_[0-9a-f]{6}$/.test(id)) return sendJson(res, 400, { ok: false, error: '乘客 ID 不合法' });
      if (method === 'PATCH') {
        const body = await readBody(req);
        const passenger = await store.updatePassenger(id, body);
        if (!passenger) return sendJson(res, 404, { ok: false, error: '乘客不存在' });
        return sendJson(res, 200, { ok: true, data: { passenger } });
      }
      if (method === 'DELETE') {
        try {
          await store.removePassenger(id);
          return sendJson(res, 200, { ok: true });
        } catch (error) {
          if (error?.code === 'PASSENGER_IN_USE') return sendJson(res, 409, { ok: false, error: error.message });
          throw error;
        }
      }
      return sendJson(res, 405, { ok: false, error: '方法不支持' });
    }

    // /api/login/* — first-time authorization for the browser collector
    if (segments[0] === 'login') {
      if (method === 'POST' && segments[1] === 'start') return sendJson(res, 200, { ok: true, data: await actions.loginStart() });
      if (method === 'POST' && segments[1] === 'probe') return sendJson(res, 200, { ok: true, data: await actions.loginProbe() });
      if (method === 'POST' && segments[1] === 'logout') return sendJson(res, 200, { ok: true, data: await actions.logout() });
      if (method === 'GET' && segments[1] === 'status') return sendJson(res, 200, { ok: true, data: await actions.loginStatus() });
      return sendJson(res, 405, { ok: false, error: '方法不支持' });
    }

    // /api/settings
    if (segments[0] === 'settings') {
      if (method === 'GET') {
        const config = store.getConfig();
        // 只回传还存在的配置：A2 之后 notify 里只剩 webhook（日报时间与冷却已删除）。
        return sendJson(res, 200, {
          ok: true,
          data: { cadence: config.cadence, notify: config.notify, panelBaseUrl: config.panelBaseUrl },
        });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        // A partial body must only touch the fields it actually carries.
        // 老客户端可能仍发 l1 / l2：直接丢弃，不让它们复活被删掉的预算模型。
        const next = await store.saveConfig({
          cadence: body.cadence,
          notify: body.notify,
          panelBaseUrl: typeof body.panelBaseUrl === 'string' ? body.panelBaseUrl : undefined,
        });
        return sendJson(res, 200, {
          ok: true,
          data: { cadence: next.cadence, notify: next.notify, panelBaseUrl: next.panelBaseUrl },
        });
      }
      return sendJson(res, 405, { ok: false, error: '方法不支持' });
    }

    // /api/deliveries — 投递日志，最新在前（A2 §1.3）。`/alerts` 保留为别名，
    // 因为老的面板页面和外部脚本可能还在拉它。
    if ((segments[0] === 'deliveries' || segments[0] === 'alerts') && method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(searchParams.get('limit') || 50)));
      return sendJson(res, 200, { ok: true, data: { deliveries: await store.readDeliveries(limit) } });
    }

    // /api/refresh — collect every monitor now (the panel's ↻ button)
    if (segments[0] === 'refresh' && method === 'POST') {
      return sendJson(res, 200, { ok: true, data: await actions.refreshAll() });
    }

    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  }

  return async function handler(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    try {
      const url = new URL(req.url || '/', 'http://placeholder');
      const rawPath = url.pathname.replace(/\/+$/, '') || '/price-watch';
      if (!rawPath.startsWith('/price-watch')) return sendJson(res, 404, { ok: false, error: 'not found' });

      const rest = rawPath.slice('/price-watch'.length) || '/';

      if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
        return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
      }

      if (rest === '/' || rest === '') {
        return sendHtml(res, 200, renderPage({ origin: '' }));
      }

      if (!rest.startsWith(API)) return sendJson(res, 404, { ok: false, error: '接口不存在' });
      // Every API call touches the cache: load (and migrate) the store first so
      // an early settings write cannot overwrite a config that was never read.
      await store.init();
      const segments = rest.slice(API.length).split('/').filter(Boolean);
      return await handleApi(req, res, method, segments, url.searchParams);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) logger.warn(`路由处理失败 ${method} ${req.url}`, error);
      else logger.info(`请求被拒绝 ${method} ${req.url}: ${error?.message}`);
      try {
        sendJson(res, status, { ok: false, error: String(error?.message || error || '服务异常') });
      } catch {
        /* the socket may already be gone */
      }
      return undefined;
    }
  };
}
