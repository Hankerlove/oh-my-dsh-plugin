/**
 * 回归测试：走势图 PNG 的尺寸与坐标轴能力（2026-11-20 V10）。
 *
 * 只校验能廉价验证的部分：PNG 头（尺寸/颜色类型）、有点/没点两种降级路径、
 * 以及「不会因为脏数据抛异常」。像素级外观由真实投递与预览图目视确认。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderBlankPng, renderTrendPng } from '../host/chart.js';

/** 从 PNG 字节里读 IHDR（宽、高、位深、颜色类型）；不依赖 zlib。 */
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

test('走势图：默认 640×320，真彩色 8bit', () => {
  const png = renderTrendPng([1080, 1120, 1099], { labels: ['11-18', '11-19', '11-20'] });
  const header = pngHeader(png);
  assert.equal(header.width, 640);
  assert.equal(header.height, 320);
  assert.equal(header.bitDepth, 8);
  assert.equal(header.colourType, 2);
});

test('走势图：带坐标轴刻度时（labels）比裸图更大，说明真的画了文字', () => {
  const values = Array.from({ length: 20 }, (_, index) => 1080 + index * 5);
  const labels = values.map((_, index) => `11-${String(index + 1).padStart(2, '0')}`);
  const bare = renderTrendPng(values);
  const withLabels = renderTrendPng(values, { labels });
  assert.ok(withLabels.length > bare.length, '带刻度的图应该多出文字像素');
});

test('走势图：尺寸可覆盖，且被 clamp 在安全范围内', () => {
  assert.equal(pngHeader(renderTrendPng([1, 2], { width: 320, height: 200 })).width, 320);
  assert.equal(pngHeader(renderTrendPng([1, 2], { width: 20, height: 20 })).width, 120);
  assert.equal(pngHeader(renderTrendPng([1, 2], { width: 5000, height: 5000 })).width, 1200);
});

test('走势图：点数不足 2 个走空白图，脏数据不抛异常', () => {
  const blank = renderTrendPng([1080], { labels: ['11-18'] });
  assert.equal(pngHeader(blank).width, 640);
  for (const evil of [null, undefined, [], [Number.NaN], ['abc', null], [[1], [2]]]) {
    assert.doesNotThrow(() => renderTrendPng(evil));
  }
  // labels 比 values 短/长都不能让 X 轴错位或抛错。
  assert.doesNotThrow(() => renderTrendPng([1, 2, 3], { labels: ['a'] }));
  assert.doesNotThrow(() => renderTrendPng([1, 2], { labels: ['a', 'b', 'c', 'd'] }));
});

test('空白图：默认 640×320', () => {
  assert.equal(pngHeader(renderBlankPng()).height, 320);
});
