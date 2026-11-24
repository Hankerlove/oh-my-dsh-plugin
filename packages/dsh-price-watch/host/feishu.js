/**
 * Feishu **self-built app** (企业自建应用) delivery: tenant token → image upload →
 * card message.
 *
 * Why this exists next to the custom-bot webhook in `notify.js`: a custom bot
 * webhook cannot attach an image (an `img_key` requires an app token to upload
 * one), while a self-built app can upload a PNG and then send an interactive
 * card that references it. That is the whole point of A2.2 — the card shows a
 * real rendered trend instead of a text sparkline.
 *
 * Rules baked in (spec §2/§5):
 *  - every request goes to `https://open.feishu.cn` with `Authorization: Bearer`;
 *  - the tenant token is cached in memory until `expire - 120s`, so a burst of
 *    collections costs one token request, not one per card;
 *  - a request that reports an expired/invalid token (401 or code 99991663)
 *    refreshes the token **once** and replays that one request; there is no
 *    loop and no general retry (delivery is still a single attempt overall);
 *  - every failure is reported as `{ ok:false, error }` with Feishu's
 *    `code + msg` folded in so the settings page can show it verbatim.
 */
const BASE = 'https://open.feishu.cn/open-apis';
/** Feishu codes that mean "this token is not usable any more". */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991668]);
/** Refresh the tenant token this long before Feishu says it expires. */
const TOKEN_SAFETY_MS = 120 * 1000;
/** Per-request timeout; a hung Feishu call must not stall the scheduler. */
const REQUEST_TIMEOUT_MS = 20000;

/** `appId → { token, expiresAt }`; module-level so one Host process reuses it. */
const tokenCache = new Map();

/** Test/reset hook: forget every cached token (also used after an auth failure). */
export function resetTenantTokenCache() {
  tokenCache.clear();
}

/** Combine the caller's abort signal with a timeout without requiring new APIs. */
function requestSignal(signal) {
  try {
    if (typeof AbortSignal?.timeout === 'function' && typeof AbortSignal?.any === 'function') {
      return signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    }
  } catch {
    /* older runtime: fall through to the caller signal */
  }
  return signal;
}

/** Parse a Feishu JSON reply defensively; a non-JSON body is a failure too. */
async function readPayload(response) {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** `code=99991 msg=...` — the shape the panel shows verbatim. */
function describeFailure(payload, response) {
  const code = payload?.code ?? payload?.StatusCode;
  const msg = payload?.msg ?? payload?.message ?? '';
  const parts = [];
  if (code !== undefined && code !== null) parts.push(`code=${code}`);
  if (msg) parts.push(String(msg).slice(0, 160));
  if (response && response.ok === false) parts.unshift(`HTTP ${response.status}`);
  return parts.join(' ') || '飞书接口调用失败';
}

function isTokenInvalid(payload, response) {
  if (response && response.status === 401) return true;
  const code = Number(payload?.code ?? payload?.StatusCode);
  return Number.isFinite(code) && TOKEN_INVALID_CODES.has(code);
}

// #region tenant token
/**
 * Get (and cache) a tenant_access_token for a self-built app.
 *
 * @returns {Promise<{ok:true, token:string, expiresAt:number}|{ok:false, error:string}>}
 */
export async function getTenantToken(appId, appSecret, { logger, signal, force = false } = {}) {
  const id = String(appId || '').trim();
  const secret = String(appSecret || '');
  if (!id || !secret) return { ok: false, error: '缺少 App ID 或 App Secret' };

  const cached = tokenCache.get(id);
  if (!force && cached && cached.token && cached.expiresAt > Date.now()) {
    return { ok: true, token: cached.token, expiresAt: cached.expiresAt };
  }

  try {
    const response = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: id, app_secret: secret }),
      signal: requestSignal(signal),
    });
    const payload = await readPayload(response);
    const token = payload?.tenant_access_token;
    if (!response.ok || !token || Number(payload?.code ?? 0) !== 0) {
      const error = describeFailure(payload, response);
      logger?.warn?.(`飞书 tenant_access_token 获取失败: ${error}`);
      return { ok: false, error };
    }
    // `expire` is the field Feishu actually returns; `expires_in` is accepted
    // too because some gateways mirror OAuth naming.
    const lifetime = Number(payload?.expire ?? payload?.expires_in);
    const ttlMs = Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1000 : 3600 * 1000;
    const expiresAt = Date.now() + Math.max(60 * 1000, ttlMs - TOKEN_SAFETY_MS);
    tokenCache.set(id, { token, expiresAt });
    return { ok: true, token, expiresAt };
  } catch (error) {
    const message = String(error?.message || error);
    logger?.warn?.(`飞书 tenant_access_token 请求异常: ${message}`);
    return { ok: false, error: message };
  }
}
// #endregion

// #region image upload
/**
 * Upload a PNG as a message image and return its `image_key`.
 *
 * @returns {Promise<{ok:true, imageKey:string}|{ok:false, error:string, authFailed:boolean}>}
 */
export async function uploadImage(token, png, { logger, signal } = {}) {
  if (!token) return { ok: false, error: '缺少 tenant_access_token', authFailed: false };
  if (!png || !Buffer.isBuffer(png) || png.length === 0) return { ok: false, error: '图片内容为空', authFailed: false };
  try {
    // Node's global FormData/Blob: no dependency, and fetch sets the multipart
    // boundary itself (a hand-written content-type would break the upload).
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', new Blob([png], { type: 'image/png' }), 'price-trend.png');
    const response = await fetch(`${BASE}/im/v1/images`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: requestSignal(signal),
    });
    const payload = await readPayload(response);
    const imageKey = payload?.data?.image_key;
    if (!response.ok || !imageKey) {
      const error = describeFailure(payload, response);
      logger?.warn?.(`飞书图片上传失败: ${error}`);
      return { ok: false, error, authFailed: isTokenInvalid(payload, response) };
    }
    return { ok: true, imageKey };
  } catch (error) {
    const message = String(error?.message || error);
    logger?.warn?.(`飞书图片上传异常: ${message}`);
    return { ok: false, error: message, authFailed: false };
  }
}
// #endregion

// #region card message
/**
 * Send an interactive card body to a group chat.
 *
 * `content` must be a **string** holding the card JSON for msg_type
 * `interactive` — Feishu rejects an object here, so it is stringified once.
 *
 * @returns {Promise<{ok:true, messageId:string|null}|{ok:false, error:string, authFailed:boolean}>}
 */
export async function sendCardToChat(token, chatId, card, { logger, signal } = {}) {
  if (!token) return { ok: false, error: '缺少 tenant_access_token', authFailed: false };
  const id = String(chatId || '').trim();
  if (!id) return { ok: false, error: '缺少群 chat_id', authFailed: false };
  try {
    const response = await fetch(`${BASE}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: id, msg_type: 'interactive', content: JSON.stringify(card) }),
      signal: requestSignal(signal),
    });
    const payload = await readPayload(response);
    if (!response.ok || Number(payload?.code ?? 0) !== 0) {
      const error = describeFailure(payload, response);
      logger?.warn?.(`飞书发卡失败: ${error}`);
      return { ok: false, error, authFailed: isTokenInvalid(payload, response) };
    }
    return { ok: true, messageId: payload?.data?.message_id ?? null };
  } catch (error) {
    const message = String(error?.message || error);
    logger?.warn?.(`飞书发卡异常: ${message}`);
    return { ok: false, error: message, authFailed: false };
  }
}
// #endregion

// #region orchestration
/**
 * Deliver one card through a self-built app: token → (optional) image upload →
 * card message. This is the single call site the scheduler uses.
 *
 * `buildCard(imageKey)` is a callback instead of a prebuilt card because only
 * the uploader knows the `image_key`, and because a failed upload must degrade
 * to the same card **without** an `img` element instead of aborting.
 *
 * Failed upload ≠ failed delivery: the card is still sent, just text-only. A
 * token-invalid reply refreshes the token once and replays both steps; any other
 * failure is reported immediately (no retry loop, spec §2).
 *
 * @returns {Promise<{ok:boolean, error?:string, imageKey?:string|null}>}
 */
export async function deliverAppCard({ appId, appSecret, chatId, png, buildCard, logger, signal }) {
  const tokenResult = await getTenantToken(appId, appSecret, { logger, signal });
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error };
  let token = tokenResult.token;

  const attempt = async (bearer) => {
    let imageKey = null;
    if (png) {
      const upload = await uploadImage(bearer, png, { logger, signal });
      if (upload.ok) {
        imageKey = upload.imageKey;
      } else if (upload.authFailed) {
        return { authFailed: true };
      } else {
        // 图挂了也要把正文发出去：降级为无图卡片。
        logger?.warn?.(`走势图上传失败，降级为无图卡片: ${upload.error}`);
      }
    }
    const card = buildCard(imageKey);
    const sent = await sendCardToChat(bearer, chatId, card, { logger, signal });
    if (sent.ok) return { ok: true, imageKey };
    return { ok: false, error: sent.error, authFailed: sent.authFailed === true };
  };

  let result = await attempt(token);
  if (result.authFailed) {
    // Token 过期：清缓存重取一次，再试一次；仍失败就报错（不循环重试）。
    logger?.warn?.('飞书 token 失效，重新获取一次后重试本次投递');
    resetTenantTokenCache();
    const fresh = await getTenantToken(appId, appSecret, { logger, signal, force: true });
    if (!fresh.ok) return { ok: false, error: fresh.error };
    token = fresh.token;
    result = await attempt(token);
    if (result.authFailed) return { ok: false, error: '飞书鉴权失败（已重新获取 token 一次）' };
  }
  return result.ok ? { ok: true, imageKey: result.imageKey ?? null } : { ok: false, error: result.error };
}
// #endregion
