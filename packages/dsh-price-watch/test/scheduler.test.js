/**
 * 调度相关的纯函数测试。
 *
 * 锁的是「休眠唤醒后不要立刻采集」这条规则（2026-11-25 用户拍板的 B 方案）：
 * 睡眠期间进程冻结、定时器不跑，醒来那一拍若立刻采集，会落在 2–3 秒的
 * 维护唤醒窗口（DarkWake）里必然被打断。判定逻辑必须留在纯函数里，方便回归。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isWakeUpGap } from '../host/util.js';

const TICK = 60_000;

test('正常心跳间隔（≈60 秒）不跳过采集', () => {
  for (const gap of [0, 1_000, 60_000, 90_000, 120_000]) {
    assert.equal(isWakeUpGap(gap, { tickMs: TICK }), false, `${gap}ms 不该被判定为刚睡醒`);
  }
});

test('大空档（睡过）跳过这一拍', () => {
  // macOS 电池模式的维护唤醒通常是 15–20 分钟一次，间隔必然远超 3 拍
  for (const gap of [TICK * 3 + 1, 5 * 60_000, 15 * 60_000, 8 * 3_600_000]) {
    assert.equal(isWakeUpGap(gap, { tickMs: TICK }), true, `${gap}ms 应判定为刚睡醒`);
  }
  // 边界：正好 3 拍不算（阈值用 >，不是 >=）
  assert.equal(isWakeUpGap(TICK * 3, { tickMs: TICK }), false);
});

test('第一拍（还没有上次心跳）也跳过，让冷启动走同一条保护路径', () => {
  assert.equal(isWakeUpGap(null, { tickMs: TICK }), true);
  assert.equal(isWakeUpGap(undefined, { tickMs: TICK }), true);
  // 异常输入不炸，按「刚睡醒」保守处理
  assert.equal(isWakeUpGap(Number.NaN, { tickMs: TICK }), true);
  assert.equal(isWakeUpGap(-1, { tickMs: TICK }), true);
});

test('阈值可调（factor），默认 3 拍', () => {
  assert.equal(isWakeUpGap(TICK * 2.5, { tickMs: TICK, factor: 2 }), true);
  assert.equal(isWakeUpGap(TICK * 2.5, { tickMs: TICK, factor: 3 }), false);
});
