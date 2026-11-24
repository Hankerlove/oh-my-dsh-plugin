/**
 * 网络可用性判断：把「本机没网 / 刚休眠 / DNS 挂了」和「携程那边慢/风控」分开。
 *
 * 为什么需要这一层：笔记本合盖或空闲休眠时会周期性「维护唤醒（DarkWake）」几秒
 * 又睡回去，采集若正好在这个窗口里开始，`page.goto` 会因为进程被挂起而 60s 超时，
 * `fetch` 会直接 `fetch failed`。这不是站点故障，也不是用户的监控配错了，更不该
 * 每次唤醒都推一张「采集失败」卡片。
 *
 * 规则：
 *  - 只做**分类**，不重试：重试策略由调度器决定（网络类 → 15 分钟后重试）；
 *  - 不吞掉原始信息：`NetworkError` 里带上原始 error 文本，面板能看见真实原因。
 */

/** 网络类失败后的重试间隔：比用户设的节奏短得多，回来就补采。 */
export const NETWORK_RETRY_MS = 15 * 60 * 1000;

/** 明确的网络类错误（带 code，便于调度器分支判断）。 */
export class NetworkError extends Error {
  constructor(message = '本机网络不可用') {
    super(message);
    this.name = 'NetworkError';
    this.code = 'NETWORK';
  }
}

/**
 * 这些文本都代表「请求根本没跑通」：浏览器网络栈错误、Node undici 的
 * `fetch failed`、DNS 解析失败、连接被重置，以及超时（含 AbortSignal.timeout）。
 */
const NETWORK_PATTERNS = [
  /net::ERR_INTERNET_DISCONNECTED/i,
  /net::ERR_NAME_NOT_RESOLVED/i,
  /net::ERR_NAME_RESOLUTION_FAILED/i,
  /net::ERR_NETWORK_CHANGED/i,
  /net::ERR_CONNECTION_(?:REFUSED|RESET|CLOSED|ABORTED|TIMED_OUT|FAILED)/i,
  /net::ERR_ADDRESS_UNREACHABLE/i,
  /net::ERR_TIMED_OUT/i,
  /net::ERR_SOCKET_NOT_CONNECTED/i,
  /fetch failed/i,
  /EAI_AGAIN/,
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /socket hang up/i,
  /Timeout \d+ms exceeded/i,
  /aborted due to timeout/i,
  /The operation was aborted due to timeout/i,
];

/**
 * 这次失败算不算「网络不可用」。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNetworkError(error) {
  if (!error) return false;
  if (error.code === 'NETWORK' || error.name === 'NetworkError') return true;
  const texts = [error?.message, error?.cause?.message, error?.cause?.code, error?.code]
    .filter((value) => typeof value === 'string' && value.trim() !== '');
  return texts.some((text) => NETWORK_PATTERNS.some((pattern) => pattern.test(text)));
}

/**
 * 采集前探一下网络（6 秒）。
 *
 * 用 HEAD 请求首页：**只要能拿到 HTTP 响应就算通**（携程偶尔回 4xx/5xx 也无所谓，
 * 我们要判断的是"本机能不能出网"，不是"这个接口通不通"）。任何异常都当不可用。
 *
 * @param {{timeoutMs?:number, endpoint?:string}} [options]
 * @returns {Promise<boolean>}
 */
export async function probeNetwork({ timeoutMs = 6000, endpoint = 'https://www.ctrip.com/' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    await fetch(endpoint, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
