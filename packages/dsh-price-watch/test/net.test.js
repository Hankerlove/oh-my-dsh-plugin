/**
 * 回归测试：网络失败分类。
 *
 * 这一层的意义是把「本机断网/刚休眠」和「站点慢/风控」分开：
 * 前者不该推失败卡、不该按 6 小时节奏等下一轮，而应该 15 分钟后补采。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserSessionError, NETWORK_RETRY_MS, NetworkError, isBrowserSessionError, isNetworkError, isTransientFailure } from '../host/net.js';

test('浏览器网络栈错误算网络问题', () => {
  for (const message of [
    'page.goto: net::ERR_INTERNET_DISCONNECTED at https://flights.ctrip.com/',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_TIMED_OUT',
  ]) {
    assert.equal(isNetworkError(new Error(message)), true, message);
  }
});

test('Node fetch / DNS / 超时算网络问题', () => {
  for (const message of [
    'fetch failed',
    'getaddrinfo EAI_AGAIN flights.ctrip.com',
    'getaddrinfo ENOTFOUND open.feishu.cn',
    'connect ECONNREFUSED 127.0.0.1:443',
    'This operation was aborted due to timeout',
    'page.goto: Timeout 60000ms exceeded.',
    'socket hang up',
  ]) {
    assert.equal(isNetworkError(new Error(message)), true, message);
  }
});

test('站点风控 / 业务错误不算网络问题', () => {
  for (const message of [
    '携程返回验证/风控页：whaleguard block',
    '航班列表被限频（页面壳正常、日期条有价、航班行为空）: 1641 字',
    '回程行没有解析到可订的票价产品',
    '机票日历接口返回空列表',
  ]) {
    assert.equal(isNetworkError(new Error(message)), false, message);
  }
  assert.equal(isNetworkError(null), false);
  assert.equal(isNetworkError(undefined), false);
});

test('NetworkError 的类型与 code 可直接判', () => {
  const error = new NetworkError('本机网络不可用');
  assert.equal(error.name, 'NetworkError');
  assert.equal(error.code, 'NETWORK');
  assert.equal(isNetworkError(error), true);
  // 带 cause 的情况也要认（undici 的 fetch failed 常把真实原因塞在 cause 里）
  const wrapped = new Error('fetch failed');
  wrapped.cause = new Error('connect ECONNRESET');
  assert.equal(isNetworkError(wrapped), true);
});

test('补采间隔是 15 分钟', () => {
  assert.equal(NETWORK_RETRY_MS, 15 * 60 * 1000);
});

test('浏览器会话失效（休眠后）算可恢复错误', () => {
  // 2026-11-25 02:18 真实报错：笔记本休眠后 Chrome 被回收，Playwright 仍拿着旧 context
  for (const message of [
    'browserContext.newPage: Protocol error (Target.createTarget): Failed to open a new tab',
    'Target page, context or browser has been closed',
    'Browser has been closed',
    'Protocol error (Target.createTarget): Failed to open a new tab',
  ]) {
    assert.equal(isBrowserSessionError(new Error(message)), true, message);
  }
  const error = new BrowserSessionError();
  assert.equal(error.name, 'BrowserSessionError');
  assert.equal(error.code, 'BROWSER_SESSION');
  assert.equal(isBrowserSessionError(error), true);
  assert.equal(isBrowserSessionError(null), false);
});

test('浏览器会话错误不算网络错误，但都算「可恢复」', () => {
  const browserGone = new Error('Target page, context or browser has been closed');
  assert.equal(isNetworkError(browserGone), false);
  assert.equal(isTransientFailure(browserGone), true);
  assert.equal(isTransientFailure(new Error('fetch failed')), true);
  // 站点风控 / 解析失败仍然不算可恢复，必须让用户看到失败卡
  assert.equal(isTransientFailure(new Error('航班列表被限频（重载后仍为空，页面壳正常、日期条有价）: 2626 字')), false);
  assert.equal(isTransientFailure(new Error('携程返回验证/风控页：whaleguard block')), false);
});
