/**
 * 回归测试：票价产品限制的解析与过滤。
 *
 * 这两条断言直接来自 2026-11-20 的真实事故：
 *  - 列表产品卡把「限至少3人(儿童不计)，55岁及以上乘客预订」写在隐藏文案里
 *    （`innerText` 没有，只有 `textContent` 有），漏读就会把「多人特惠」票当成
 *    单人最低价，最后在预订页读到 3 人总价（¥3246 vs 列表 ¥730）；
 *  - 限制文本里写的是「55岁及以上」，没有「周」字，旧正则只认「周岁」。
 *
 * 运行：node --test test/（零依赖，用 node:test）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fareFits, parseFareRules, parseRowText, parseSeatInfo } from '../host/collect/browser.js';

test('多人特惠：限至少3人 + 55岁及以上 都能解析出来', () => {
  const rules = parseFareRules('限至少3人(儿童不计)，55岁及以上乘客预订去经济舱2.2折 返经济舱1.5折 多人特惠');
  assert.equal(rules.minPax, 3);
  assert.equal(rules.ageMin, 55);
});

test('预订页文案：该产品限3-9人可订', () => {
  const rules = parseFareRules('该产品限3-9人可订(儿童不计)');
  assert.equal(rules.minPax, 3);
  assert.equal(rules.maxPax, 9);
});

test('学生专享票需要学生身份，普通价格文案不受影响', () => {
  assert.deepEqual(parseFareRules('学生专享 经济舱2.0折'), { requiresStudent: true });
  assert.deepEqual(parseFareRules('经济舱3.4折 托运行李额20KG'), {});
});

test('单人监控不会选中「3 人成团 / 55 岁及以上」的票', () => {
  const passenger = { id: 'p1', type: 'student', age: 22 };
  assert.equal(fareFits(parseFareRules('限至少3人(儿童不计)，55岁及以上乘客预订'), passenger, 1), false);
  assert.equal(fareFits(parseFareRules('该产品限3-9人可订(儿童不计)'), passenger, 1), false);
});

test('正常票种仍然可以选，学生票对非学生不可选', () => {
  const passenger = { id: 'p1', type: 'student', age: 22 };
  assert.equal(fareFits(parseFareRules('经济舱3.4折 托运行李额20KG'), passenger, 1), true);
  assert.equal(fareFits(parseFareRules('学生专享 经济舱2.0折'), passenger, 1), true);
  assert.equal(fareFits(parseFareRules('学生专享 经济舱2.0折'), { id: 'p2', type: 'adult', age: 30 }, 1), false);
  assert.equal(fareFits(parseFareRules('限2-9人可订'), passenger, 1), false);
  assert.equal(fareFits(parseFareRules('限2-9人可订'), passenger, 2), true);
});

test('余票解析：剩 N 张 / 售罄 / 未提及', () => {
  assert.deepEqual(parseSeatInfo('剩 3 张'), { seats: 3, soldOut: false });
  assert.deepEqual(parseSeatInfo('已售完'), { seats: null, soldOut: true });
  assert.deepEqual(parseSeatInfo('经济舱3.4折'), { seats: null, soldOut: false });
});

test('往返列表行：按列表价 + 往返总价解析', () => {
  const row = parseRowText(
    '吉祥航空 HO1254 空客320 21:20 大兴国际机场 23:30 浦东国际机场T2 '
    + '经济舱2.4折 ¥730起 往返总价 剩3张',
  );
  assert.equal(row.flightNo, 'HO1254');
  assert.equal(row.depTime, '21:20');
  assert.equal(row.listPrice, 730);
  assert.equal(row.isRoundRow, true);
});
