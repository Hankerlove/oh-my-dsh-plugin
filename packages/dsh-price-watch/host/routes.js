/**
 * HTTP surface of price-watch, registered as one `webServer` prefix route.
 *
 * Everything is JSON under `/price-watch/api/*` except `/price-watch/`, which
 * serves the standalone read-only page. Handlers never throw: a failure becomes
 * `{ ok: false, error }` with a sensible status.
 *
 * Write requests pass a same-origin check because plugin routes are not behind
 * the Host web token. Bodies are capped and destroyed when oversized.
 */
import { MAX_BODY_BYTES } from './util.js';
import { renderPage } from './page.js';

const API = '/api';

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

/**
 * @param {object} deps
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {object} deps.logger
 * @param {{ refreshMonitor:(id:string)=>Promise<object>, refreshAll:()=>Promise<object>, status:()=>Promise<object>, panelUrl:()=>string }} deps.actions
 */
export function createRouter({ store, logger, actions }) {
  async function collectMonitorView(monitor, limit = 60) {
    const points = await store.readPoints(monitor.id, { limit: 500 });
    const latest = points.length ? points[points.length - 1] : null;
    return {
      ...monitor,
      latest: latest ? { total: latest.price?.total ?? 0, at: latest.at } : null,
      points: points.slice(-limit).map((point) => [point.at, point.price?.total ?? 0]),
    };
  }

  async function listMonitors() {
    const monitors = store.listMonitors();
    return Promise.all(monitors.map((monitor) => collectMonitorView(monitor)));
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
          void actions.refreshMonitor(monitor.id, { immediate: true });
          return sendJson(res, 201, { ok: true, data: { monitor: await collectMonitorView(monitor) } });
        }
        return sendJson(res, 405, { ok: false, error: '方法不支持' });
      }

      const id = segments[1];
      if (!/^m_[0-9a-f]{8}$/.test(id)) return sendJson(res, 400, { ok: false, error: '监控 ID 不合法' });
      const monitor = store.findMonitor(id);
      if (!monitor) return sendJson(res, 404, { ok: false, error: '监控不存在' });

      if (segments[2] === 'refresh' && method === 'POST') {
        const result = await actions.refreshMonitor(id);
        return sendJson(res, 200, { ok: true, data: result });
      }

      if (segments[2] === 'prices' && method === 'GET') {
        const days = Math.max(1, Math.min(3650, Number(searchParams.get('days') || 90)));
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const points = await store.readPoints(id, { since, limit: 5000 });
        const totals = points.map((point) => Number(point.price?.total)).filter((value) => Number.isFinite(value) && value > 0);
        const target = (monitor.rules || []).find((rule) => rule.kind === 'target');
        const last7 = points.filter((point) => Date.parse(point.at) > Date.now() - 7 * 86400000).map((point) => Number(point.price?.total)).filter(Number.isFinite);
        return sendJson(res, 200, {
          ok: true,
          data: {
            points: points.map((point) => ({ at: point.at, total: point.price?.total ?? 0, bare: point.price?.bare ?? 0, src: point.src })),
            stats: {
              min: totals.length ? Math.min(...totals) : null,
              max: totals.length ? Math.max(...totals) : null,
              avg7: last7.length ? Math.round(last7.reduce((sum, value) => sum + value, 0) / last7.length) : null,
              target: target ? target.value : null,
            },
          },
        });
      }

      if (segments.length === 2) {
        if (method === 'PATCH') {
          const body = await readBody(req);
          const next = await store.updateMonitor(id, body);
          return sendJson(res, 200, { ok: true, data: { monitor: await collectMonitorView(next) } });
        }
        if (method === 'DELETE') {
          await store.removeMonitor(id);
          logger.info(`删除监控 ${id}`);
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'GET') return sendJson(res, 200, { ok: true, data: { monitor: await collectMonitorView(monitor) } });
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
        return sendJson(res, 200, {
          ok: true,
          data: { cadence: config.cadence, l2: config.l2, notify: config.notify, panelBaseUrl: config.panelBaseUrl },
        });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const next = await store.saveConfig({
          cadence: body.cadence,
          l2: body.l2,
          notify: body.notify,
          panelBaseUrl: typeof body.panelBaseUrl === 'string' ? body.panelBaseUrl : undefined,
        });
        return sendJson(res, 200, {
          ok: true,
          data: { cadence: next.cadence, l2: next.l2, notify: next.notify, panelBaseUrl: next.panelBaseUrl },
        });
      }
      return sendJson(res, 405, { ok: false, error: '方法不支持' });
    }

    // /api/alerts
    if (segments[0] === 'alerts' && method === 'GET') {
      const limit = Math.max(1, Math.min(200, Number(searchParams.get('limit') || 50)));
      return sendJson(res, 200, { ok: true, data: { alerts: await store.readAlerts(limit) } });
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
