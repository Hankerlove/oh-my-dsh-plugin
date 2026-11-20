/**
 * 回归测试：飞书卡片的积木与卡片结构（2026-11-20 分块改版）。
 *
 * 这些断言锁的是「用户能看到什么」的口径：
 *  - 走势统计必须写清 最低 / 最高 / 均价，并用对单位（次采集 / 天）；
 *  - 日历卡片的窗口是「未来 30 天」，主视觉、走势、低价日表必须同源；
 *  - 没有上一轮价格时不能出现「暂无对比」这种占位，也不许出现按钮/动作；
 *  - 同价位的连续日期在低价日表里只占一行。
 *
 * 运行：node --test（零依赖）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCalendarCard,
  buildFailureCard,
  buildWatchCard,
  deltaParts,
  trendStats,
  trendSummary,
} from '../host/notify.js';
import { comboTable, dateCell, dayTable, fieldGrid, flightTable, priceHero, sectionTitle } from '../host/card.js';

const flatten = (card) => JSON.stringify(card);
const texts = (card) => (card.body?.elements || []).map((element) => flatten(element));
const hasText = (card, needle) => texts(card).some((text) => text.includes(needle));

const monitor = {
  id: 'm_1',
  title: '北京 → 上海 · 11月30日',
  mode: 'watch',
  params: { trip: 'oneway', dep: 'BJS', arr: 'SHA', departDate: '2026-11-30', cabin: 'y_s' },
  passengerIds: ['p_1'],
  cadence: { minutes: 360 },
};

test('trendStats：算出最低/最高/均价与对应刻度标签，少于 2 点返回 null', () => {
  const stats = trendStats({ values: [1100, 1080, 1160], labels: ['11-18', '11-19', '11-20'] });
  assert.equal(stats.min.value, 1080);
  assert.equal(stats.min.label, '11-19');
  assert.equal(stats.max.value, 1160);
  assert.equal(stats.max.label, '11-20');
  assert.equal(stats.avg, 1113);
  assert.equal(stats.flat, false);
  assert.equal(trendStats({ values: [1100], labels: ['11-18'] }), null);
  assert.equal(trendStats(null), null);
});

test('trendSummary：写全最低/最高/均价，单位可切「次采集 / 天」', () => {
  const trend = { values: [1100, 1080, 1160], labels: ['11-18', '11-19', '11-20'] };
  const watch = trendSummary(trend);
  assert.match(watch, /最低 ¥1,080（11-19）/);
  assert.match(watch, /最高 ¥1,160（11-20）/);
  assert.match(watch, /均价 ¥1,113/);
  assert.match(watch, /覆盖 3 次采集/);

  const calendar = trendSummary(trend, { unit: '天' });
  assert.match(calendar, /覆盖 3 天/);

  // 价格全平时不硬凑「最高/最低」区间。
  const flat = trendSummary({ values: [2500, 2500, 2500], labels: ['11-18', '11-19', '11-20'] });
  assert.match(flat, /近 3 次采集始终 ¥2,500/);
  assert.doesNotMatch(flat, /最高/);
});

test('priceHero：一律返回元素数组；没有上一轮价格时不写「暂无对比」', () => {
  const bare = priceHero({ label: '当前最低实价', price: '¥1,099' });
  assert.ok(Array.isArray(bare), 'priceHero 必须返回数组，调用方会 push(...)');
  assert.equal(flatten(bare).includes('暂无对比'), false);
  assert.equal(bare[0].tag, 'div');

  const withDelta = priceHero({ label: '当前最低实价', price: '¥1,099', delta: '比上次 -3.7%', previous: '上次 ¥1,141' });
  assert.ok(Array.isArray(withDelta));
  assert.equal(withDelta.length, 1);
  const columns = withDelta[0];
  assert.equal(columns.tag, 'column_set');
  assert.equal(columns.columns.length, 2);
  assert.equal(columns.columns[0].weight, 1);
});

test('卡片骨架不允许出现嵌套数组（否则飞书 JSON 校验失败）', () => {
  const card = buildWatchCard({
    monitor,
    lowest: { flightNo: 'CZ8882', total: 1099 },
    flights: [],
    previous: null, // 没有上一轮 → priceHero 走「无对比」分支
    imageKey: null,
    at: '2026-11-20T10:50:00.000Z',
    trend: null,
  });
  for (const element of card.body.elements) {
    assert.equal(Array.isArray(element), false, 'body.elements 里不能有数组');
    assert.equal(typeof element?.tag, 'string');
  }
});

test('fieldGrid：两列等分，奇数个字段时最后一列独占一行', () => {
  const even = fieldGrid([{ label: '采集时间', value: '2026-11-20 18:50' }, { label: '采集频率', value: '每 6 小时' }]);
  assert.equal(even.length, 1);
  assert.equal(even[0].tag, 'column_set');
  assert.deepEqual(even[0].columns.map((column) => column.weight), [1, 1]);

  const odd = fieldGrid([{ label: 'a', value: '1' }, { label: 'b', value: '2' }, { label: 'c', value: '3' }]);
  assert.equal(odd.length, 2);
  assert.equal(odd[1].columns.length, 1);
  assert.deepEqual(fieldGrid([]), []);
  // 缺值的字段整项省略，不写占位。
  assert.deepEqual(fieldGrid([{ label: '采集时间', value: '' }]), []);
});

test('dayTable：同价位只留最早一天，按 Markdown 左对齐', () => {
  const rows = [
    { date: '2026-12-01', total: 540 },
    { date: '2026-12-02', total: 540 },
    { date: '2026-12-03', total: 540 },
    { date: '2026-11-26', total: 550 },
  ];
  const table = dayTable(rows, { limit: 4, average: 604 });
  const content = table.content;
  assert.match(content, /\| :--- \| :--- \| :--- \|/);
  assert.equal(content.match(/¥540/g).length, 1, '同价位的重复日期应合并成一行');
  assert.match(content, /12-01 周二/);
  assert.match(content, /11-26 周四/);
  assert.match(content, /-11%/);
});

test('dateCell：带上星期，坏日期返回空串', () => {
  assert.equal(dateCell('2026-12-01'), '12-01 周二');
  assert.equal(dateCell('2026-12-08'), '12-08 周二');
  assert.equal(dateCell(''), '');
  assert.equal(dateCell('bad'), '');
});

test('comboTable：只列两侧都有航班的组合，估算价加 ≈', () => {
  const combos = [
    { out: { flightNo: 'CZ8882', depTime: '14:00', airline: '南方航空' }, ret: { flightNo: 'CZ8890', depTime: '08:10', airline: '南方航空' }, payable: 1080, listTotal: 719 },
    { out: { flightNo: 'HO1254', depTime: '21:20', airline: '吉祥航空' }, ret: { flightNo: 'MU5185', depTime: '21:05', airline: '东方航空' }, payable: null, listTotal: 730 },
    { out: { flightNo: 'X1' }, ret: null, payable: 999 },
  ];
  const table = comboTable(combos, { limit: 3 });
  const content = table.content;
  assert.match(content, /\| :--- \| :--- \| :--- \|/);
  assert.match(content, /¥1,080/);
  assert.match(content, /≈¥730/);
  assert.equal(content.includes('X1'), false, '缺返程的组合整行省略');
  assert.equal(content.includes('—'), false, '不写破折号占位');
});

test('flightTable：只有整列都有余票时才出「余票」列', () => {
  const withSeats = flightTable([
    { no: 'CZ8882', depTime: '14:00', arrTime: '16:20', taxIncluded: 1099, seats: 3, soldOut: false },
    { no: 'CZ8889', depTime: '20:30', arrTime: '22:40', taxIncluded: 1180, seats: null, soldOut: true },
  ]);
  assert.match(withSeats.content, /余票/);
  assert.match(withSeats.content, /剩 3 张/);
  assert.match(withSeats.content, /售罄/);

  const withoutSeats = flightTable([
    { no: 'CZ8882', depTime: '14:00', arrTime: '16:20', taxIncluded: 1099 },
    { no: 'CZ8889', depTime: '20:30', arrTime: '22:40', taxIncluded: 1180 },
  ]);
  assert.equal(withoutSeats.content.includes('余票'), false);
});

test('分块卡片：四块齐全、无按钮、无字符画、无占位', () => {
  const card = buildWatchCard({
    monitor,
    lowest: { flightNo: 'CZ8882', total: 1099 },
    flights: [
      { no: 'CZ8882', depTime: '14:00', arrTime: '16:20', taxIncluded: 1099, seats: 3, soldOut: false },
      { no: 'CZ8889', depTime: '20:30', arrTime: '22:40', taxIncluded: 1180, seats: 2, soldOut: false },
    ],
    previous: 1141,
    imageKey: null,
    at: '2026-11-20T10:50:00.000Z',
    trend: { values: [1141, 1150, 1099], labels: ['11-18', '11-19', '11-20'] },
  });
  assert.equal(card.schema, '2.0');
  for (const title of ['价格走势', '可订航班', '本次采集']) {
    assert.ok(hasText(card, title), `缺少区块：${title}`);
  }
  // 走势区块要写明横轴/纵轴口径。
  assert.ok(hasText(card, '横轴 采集日期'));
  assert.ok(hasText(card, '纵轴 待支付实价'));
  // 区间统计要有最低/最高/均价。
  assert.ok(hasText(card, '最低 ¥1,099'));
  assert.ok(hasText(card, '均价'));
  // 采集信息四个字段。
  for (const label of ['采集时间', '采集频率', '乘客', '数据状态']) {
    assert.ok(hasText(card, label), `缺少采集信息字段：${label}`);
  }
  // 口径必须可见。
  assert.ok(hasText(card, '实价=待支付价'));
  // 不变式：没有按钮/动作、没有占位、没有字符画。
  const json = flatten(card);
  for (const gone of ['"tag":"button"', '"behaviors"', 'action', '暂无对比', 'N/A', '—']) {
    assert.equal(json.includes(gone), false, `卡片不应包含 ${gone}`);
  }
});

test('日历卡片：最低价与低价日表都落在未来 30 天窗口内', () => {
  const out = [];
  for (let day = 1; day <= 40; day += 1) {
    // 第 35 天给一个更低的价：它在窗口外，卡片不能把它当成「未来 30 天最低价」。
    out.push({ date: `2026-12-${String(day).padStart(2, '0')}`, total: day === 35 ? 300 : 500 + day });
  }
  const card = buildCalendarCard({
    monitor: { ...monitor, mode: 'calendar', params: { trip: 'oneway', dep: 'BJS', arr: 'SHA', cabin: 'y_s' } },
    out,
    previous: null,
    imageKey: null,
    at: '2026-11-20T10:50:00.000Z',
    trend: { values: out.slice(0, 30).map((row) => row.total), labels: out.slice(0, 30).map((row) => row.date.slice(5)) },
  });
  const json = flatten(card);
  assert.equal(json.includes('¥300'), false, '30 天窗口外的低价不能出现在卡片上');
  assert.ok(hasText(card, '未来 30 天最低价'));
  assert.equal(json.includes('暂无对比'), false);
  assert.ok(hasText(card, '天'), '走势统计要用「天」作单位');
});

test('失败卡片：给出原因与采集信息，不写价格字段', () => {
  const card = buildFailureCard({ monitor, error: '携程返回风控页', at: '2026-11-20T10:50:00.000Z' });
  assert.ok(hasText(card, '失败原因'));
  assert.ok(hasText(card, '携程返回风控页'));
  assert.ok(hasText(card, '本次采集'));
  assert.equal(flatten(card).includes('当前最低实价'), false);
});

test('deltaParts：涨跌文案与方向', () => {
  assert.equal(deltaParts(1100, 1141).text, '比上次 -3.6%');
  assert.equal(deltaParts(1100, 1100).text, '与上次持平');
  assert.equal(deltaParts(1100, null), null);
});

test('sectionTitle：标题加粗 + 说明灰色，且不引入 < > 破坏的标签', () => {
  const title = sectionTitle('价格走势', '横轴 日期');
  assert.equal(title.tag, 'div');
  assert.match(title.text.content, /^\*\*价格走势\*\*/);
  assert.match(title.text.content, /<font color='grey'>横轴 日期<\/font>/);
});
