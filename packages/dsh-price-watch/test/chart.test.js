/**
 * 回归测试：走势图渲染（2026-11-23 起改为纯 JS 矢量光栅化）。
 *
 * 锁三件事：
 *  1. PNG 头正确、默认 2× 输出（1280×640）、尺寸可配且有安全 clamp；
 *  2. 内嵌字形子集覆盖画图需要的全部字符（少一个就会静默画成空格）；
 *  3. 退化数据（点太少 / 全同值 / 脏值 / 标签比数据短）不抛异常。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GLYPHS, UPEM } from '../host/chart-font.js';
import { groupDigits, niceStep, renderBlankPng, renderTrendPng, textWidth, tickSeries } from '../host/chart.js';

/** 从 PNG 字节里读 IHDR；不依赖 zlib。 */
function pngHeader(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '不是合法 PNG 签名');
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colourType: buffer[25],
  };
}

test('走势图：默认输出 1280×640（2× 设计基准），真彩色 8bit', () => {
  const header = pngHeader(renderTrendPng([1080, 1120, 1099], { labels: ['11-18', '11-19', '11-20'] }));
  assert.equal(header.width, 1280);
  assert.equal(header.height, 640);
  assert.equal(header.bitDepth, 8);
  assert.equal(header.colourType, 2);
});

test('内嵌字形子集覆盖画图用到的全部字符', () => {
  for (const char of '0123456789¥,.-: '.split('')) {
    assert.ok(Array.isArray(GLYPHS[char]), `字形缺失：${JSON.stringify(char)}`);
  }
  assert.equal(UPEM, 2048);
  // 数字按真实字宽排版（`1` 比 `8` 窄），不是等宽假字。
  assert.ok(textWidth('111', 20) < textWidth('888', 20));
});

test('带坐标轴刻度时比裸图更大（说明真的画了文字）', () => {
  const values = Array.from({ length: 20 }, (_, index) => 1080 + index * 5);
  const labels = values.map((_, index) => `11-${String(index + 1).padStart(2, '0')}`);
  assert.ok(renderTrendPng(values, { labels }).length > renderTrendPng(values).length);
});

test('尺寸可覆盖，且被 clamp 在安全范围内', () => {
  assert.equal(pngHeader(renderTrendPng([1, 2], { width: 640, height: 320 })).width, 640);
  assert.equal(pngHeader(renderTrendPng([1, 2], { width: 10, height: 10 })).width, 320);
  assert.equal(pngHeader(renderTrendPng([1, 2], { width: 99999, height: 99999 })).width, 2560);
});

test('退化数据：点不足 2 个走空白图，脏值/长度不齐都不抛', () => {
  assert.equal(pngHeader(renderTrendPng([1080], { labels: ['11-18'] })).width, 1280);
  for (const evil of [null, undefined, [], [Number.NaN], ['abc', null], [[1], [2]], [1, Infinity]]) {
    assert.doesNotThrow(() => renderTrendPng(evil));
  }
  assert.doesNotThrow(() => renderTrendPng([1, 2, 3], { labels: ['a'] }));
  assert.doesNotThrow(() => renderTrendPng([1, 2], { labels: ['a', 'b', 'c', 'd'] }));
  // 全同值（平坦序列）走单独分支：线居中、无面积、无极值标注
  assert.doesNotThrow(() => renderTrendPng(new Array(30).fill(2500), { labels: new Array(30).fill('11-20') }));
});

test('刻度与千分位：整数 step、标签不会和几何位置错位', () => {
  assert.equal(niceStep(1000, 4), 250); // 1,000 跨度 → 250 一档（4 条刻度）
  assert.equal(niceStep(120, 4), 50);   // 120 跨度 → 50 一档，而不是 25（那是 6 条）
  assert.equal(niceStep(7, 4), 2);      // 小跨度也只给整数步长
  const { ticks, step } = tickSeries(400, 900, 4);
  assert.ok(step >= 1 && Number.isInteger(step));
  assert.ok(ticks.length >= 3 && ticks.length <= 6);
  assert.ok(ticks.every((value) => Number.isInteger(value)));
  assert.equal(groupDigits(1785), '1,785');
  assert.equal(groupDigits(460), '460');
  assert.equal(groupDigits(-1200), '-1,200');
});

test('空白图：默认 1280×640', () => {
  const header = pngHeader(renderBlankPng());
  assert.equal(header.width, 1280);
  assert.equal(header.height, 640);
});
