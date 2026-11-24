/**
 * 回归测试：酒店监控飞书卡片（`buildHotelCard`，契约 §7 四区块）。
 *
 * 这些断言锁的是「用户能看到什么」的口径：
 *  - 主数字必须是**整段含税总价**，每晚价只做副标题；
 *  - 四区块（结论 / 走势 / 房型 / 本次采集）按内容自动出现，无图/无价/无房型时
 *    整块省略，**不产出空区块、不写占位**（房型表的「床型/面积」是唯一例外）；
 *  - 房型表按整段升序取前 6 行、最低价整行加粗、超出提示「另有 N 个房型未显示」；
 *  - 没有按钮/action、没有字符画、元素扁平（`cardShell` 里 `.flat(2)`）；
 *  - 任何脏数据都不抛（降级为纯文本卡片，不阻断投递）。
 *
 * 运行：node --test（零依赖）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHotelCard } from '../host/notify.js';

const flatten = (card) => JSON.stringify(card);
const elements = (card) => card.body?.elements || [];
const texts = (card) => elements(card).map((element) => flatten(element));
const hasText = (card, needle) => texts(card).some((text) => text.includes(needle));
const images = (card) => elements(card).filter((element) => element.tag === 'img');
const tables = (card) => elements(card).filter((element) => element.tag === 'markdown');
const sectionTitles = (card) => elements(card)
  .filter((element) => element.tag === 'div' && /^\*\*/.test(element.text?.content || ''))
  .map((element) => element.text.content);
const elementText = (element) => element?.text?.content ?? element?.content ?? element?.img_key ?? '';
/** 房型表（唯一一个 `markdown` 块就是它；没有房型时为空）。 */
const roomTable = (card) => tables(card).find((element) => /^\| 房型 \|/.test(element.content)) || null;

const monitor = {
  id: 'h_1a2b3c4d',
  type: 'hotel',
  mode: 'hotel',
  title: '全季酒店(上海虹桥店) · 12月05日–12月07日',
  params: {
    city: 'SHA',
    cityName: '上海',
    keyword: '全季 虹桥',
    hotelId: '436380',
    hotelName: '全季酒店(上海虹桥店)',
    checkIn: '2026-12-05',
    checkOut: '2026-12-07',
    adults: 2,
    rooms: 1,
  },
  passengerIds: [],
  cadence: { minutes: 360 },
};

const room = (overrides) => ({
  id: 'r1',
  name: '高级大床房',
  bed: '1张1.8米大床',
  area: '28㎡',
  window: true,
  breakfast: null,
  cancellable: null,
  left: 3,
  bookable: true,
  price: { nightly: 420, total: 840 },
  ...overrides,
});

/** 契约 §3 的完整快照：8 个房型（1 个不可订）、最低价是「标准间 ¥800」。 */
const snapshot = {
  fetchedAt: '2026-11-24T03:01:12.345Z',
  checkIn: '2026-12-05',
  checkOut: '2026-12-07',
  nights: 2,
  adults: 2,
  rooms: 1,
  source: 'ctrip',
  hotel: {
    id: '436380',
    name: '全季酒店(上海虹桥店)',
    star: 3,
    score: 4.7,
    scoreLabel: '很好',
    address: '长宁区虹桥路 1234 号',
    district: '虹桥地区',
    cityName: '上海',
  },
  rooms: [
    room({ id: 'r6', name: '标准间', bed: '2张1.2米', area: '25㎡', window: false, price: { nightly: 400, total: 800 } }),
    room(),
    room({ id: 'r7', name: '无障碍房', bed: null, area: null, price: { nightly: 440, total: 880 } }),
    room({ id: 'r2', name: '豪华双床房（含双早·高层景观）', bed: '2张1.2米单人床', area: null, price: { nightly: 480, total: 960 } }),
    room({ id: 'r3', name: '商务大床房', bed: null, area: '32㎡', price: { nightly: 520, total: 1040 } }),
    room({ id: 'r5', name: '家庭房', bed: '1张1.5米+1张1.2米', area: '40㎡', price: { nightly: 680, total: 1360 } }),
    room({ id: 'r4', name: '套房', bed: '1张2米大床', area: '55㎡', price: { nightly: 760, total: 1520 } }),
    room({ id: 'r8', name: '不可订房', bed: null, area: null, bookable: false, price: { nightly: 100, total: 200 } }),
  ],
  lowest: { roomId: 'r6', roomName: '标准间', nightly: 400, total: 800 },
};

const trend = { values: [760, 810, 800, 950, 830, 800], labels: ['11-18', '11-19', '11-20', '11-21', '11-22', '11-23'] };
const AT = '2026-11-24T03:01:12.345Z';

test('完整快照（有图）：四区块齐全、1 张走势图、涨跌行都在；口径行已删除', () => {
  const card = buildHotelCard({ monitor, snapshot, previous: 760, imageKey: 'img_v2_hotel', at: AT, trend });

  assert.equal(card.schema, '2.0');
  assert.equal(card.header.title.content, '价格监控 · 全季酒店(上海虹桥店)（12月05日–12月07日）');
  assert.deepEqual(card.header.text_tag_list.map((tag) => tag.text.content), ['酒店监控']);
  assert.match(card.config.summary.content, /整段 ¥800/);
  assert.match(card.config.summary.content, /比上次 \+5\.3%/);

  // 1. 结论：大号整段总价 + 每晚/房型副行 + 酒店身份 + 涨跌（不再有口径标签）
  assert.ok(hasText(card, '整段最低总价'));
  assert.ok(hasText(card, '**¥800**'));
  assert.ok(hasText(card, '2 晚 · 每晚约 ¥400 · 标准间'));
  assert.ok(hasText(card, '全季酒店(上海虹桥店) · 3 星 · 4.7 分 很好'));
  assert.ok(hasText(card, '比上次 +5.3%（上次 ¥760）'));
  assert.equal(hasText(card, '口径'), false, '口径行对用户无意义，不应再出现');

  // 2. 走势：只有 1 张图 + 区块标题写清横纵轴 + 统计行
  assert.equal(images(card).length, 1, '有 imageKey 时应恰好 1 张图');
  assert.ok(hasText(card, '价格走势'));
  assert.ok(hasText(card, '横轴 采集日期 · 纵轴 当日最低总价（元）'));
  assert.match(flatten(card), /最低 ¥760（11-18）/);
  assert.match(flatten(card), /最高 ¥950（11-21）/);
  assert.match(flatten(card), /均价 ¥825/);
  assert.match(flatten(card), /覆盖 6 次采集/);

  // 3. 房型：区块 + 表 + 最低行整行加粗
  assert.ok(hasText(card, '房型价格'));
  assert.ok(hasText(card, '按整段总价从低到高'));
  const table = roomTable(card);
  assert.ok(table, '应有房型表');
  const lines = table.content.split('\n');
  assert.equal(lines[0], '| 房型 | 床型 | 面积 | 每晚 | 整段 |');
  assert.match(lines[1], /^\| :--- \| :--- \| :--- \| :--- \| :--- \|$/);
  assert.match(lines[2], /^\| \*\*标准间\*\* \| \*\*2张1\.2米\*\* \| \*\*25㎡\*\* \| \*\*¥400\*\* \| \*\*¥800\*\* \|$/, '最低价行整行加粗');

  // 4. 本次采集：六字段（不再有末行口径）
  assert.ok(hasText(card, '本次采集'));
  for (const label of ['酒店', '入住–离店', '入住人数', '采集时间', '采集频率', '数据状态']) {
    assert.ok(hasText(card, label), `缺少采集信息字段：${label}`);
  }
  assert.ok(hasText(card, '12月05日 → 12月07日（2 晚）'));
  assert.ok(hasText(card, '2 人'));
  assert.ok(hasText(card, '已取到 7 个可订房型'));
  assert.equal(hasText(card, '间 ·'), false, '末行口径已删除，不应残留');

  // 不变式：没有按钮/action、没有字符画、元素扁平、可 JSON 序列化投递。
  const json = flatten(card);
  for (const gone of ['"tag":"button"', 'behaviors', '"action"', '暂无对比', 'N/A', '▁', '▂', '█']) {
    assert.equal(json.includes(gone), false, `酒店卡片不应包含 ${gone}`);
  }
  for (const element of elements(card)) {
    assert.equal(Array.isArray(element), false, 'body.elements 里不能嵌套数组');
    assert.equal(typeof element?.tag, 'string');
    assert.notEqual(JSON.stringify(element).length, 2, '不能出现空元素');
  }
  assert.doesNotThrow(() => JSON.stringify(card));
});

test('无图（webhook 通道 / 上传失败）：不出 img，但走势统计行仍保留', () => {
  const card = buildHotelCard({ monitor, snapshot, previous: 760, imageKey: null, at: AT, trend });
  assert.equal(images(card).length, 0);
  assert.ok(hasText(card, '价格走势'), '无图时走势区块仍要出现（因为还有统计行）');
  assert.ok(hasText(card, '覆盖 6 次采集'));
});

test('首次采集（previous=null）：省略涨跌行，不编造对比', () => {
  const card = buildHotelCard({ monitor, snapshot, previous: null, imageKey: null, at: AT, trend });
  assert.ok(hasText(card, '¥800'), '价格仍要在');
  assert.equal(hasText(card, '比上次'), false);
  assert.equal(hasText(card, '与上次持平'), false);
  assert.equal(hasText(card, '上次'), false, '不该出现任何「上次」字样');
  assert.doesNotMatch(card.config.summary.content, /比上次/);
});

test('单房型：表格只有一行数据，且没有「另有 N 个」', () => {
  const single = {
    ...snapshot,
    rooms: [room()],
    lowest: { roomId: 'r1', roomName: '高级大床房', nightly: 420, total: 840 },
  };
  const card = buildHotelCard({ monitor, snapshot: single, previous: null, imageKey: null, at: AT, trend: null });
  const table = roomTable(card);
  assert.ok(table);
  assert.equal(table.content.split('\n').length, 3, '表头 + 分隔行 + 1 行数据');
  assert.match(table.content, /高级大床房/);
  assert.equal(hasText(card, '另有'), false);
});

test('房型超过 6 个：只展示前 6 行 + 「另有 N 个房型未显示」', () => {
  const card = buildHotelCard({ monitor, snapshot, previous: null, imageKey: null, at: AT, trend: null });
  const table = roomTable(card);
  assert.equal(table.content.split('\n').length, 8, '表头 + 分隔行 + 6 行数据');
  assert.ok(hasText(card, '另有 1 个房型未显示'), '7 个可订房型 - 6 行 = 1');
  // 排序按整段升序：¥800 < ¥840 < ¥880 < ¥960 < ¥1,040 < ¥1,360
  const order = ['¥800', '¥840', '¥880', '¥960', '¥1,040', '¥1,360'].map((price) => table.content.indexOf(price));
  assert.ok(order.every((value, index) => index === 0 || value > order[index - 1]), `房型表应按整段升序：${order}`);
  // 不可订房型不出现（契约：只保留 bookable !== false 且 total > 0）。
  assert.equal(table.content.includes('不可订房'), false);
  // 超长房型名截断到 ~14 字并保留省略号。
  assert.match(table.content, /豪华双床房（含双早·高层景…/);
});

test('床型/面积缺失用破折号（房型表唯一允许占位的地方）', () => {
  const card = buildHotelCard({ monitor, snapshot, previous: null, imageKey: null, at: AT, trend: null });
  const table = roomTable(card);
  assert.match(table.content, /\| 无障碍房 \| — \| — \| ¥440 \| ¥880 \|/);
  // 破折号只允许出现在房型表里，其它区块一律不写占位。
  const nonTable = elements(card).filter((element) => element !== table).map((element) => JSON.stringify(element)).join('');
  assert.equal(nonTable.includes('—'), false, '房型表以外不应出现破折号');
  assert.equal(nonTable.includes('N/A'), false);
});

test('无房型（rooms=[]）：房型区块整块省略，价格主视觉与采集块仍在', () => {
  const emptyRooms = { ...snapshot, rooms: [] };
  const card = buildHotelCard({ monitor, snapshot: emptyRooms, previous: null, imageKey: null, at: AT, trend });
  assert.equal(roomTable(card), null);
  assert.equal(hasText(card, '房型价格'), false, '没有房型就整块省略，不留空标题');
  assert.equal(hasText(card, '另有'), false);
  assert.ok(hasText(card, '整段最低总价'), 'lowest 还在 → 结论块照常');
  assert.ok(hasText(card, '本轮未取到可订房型'));
  for (const element of elements(card)) {
    assert.notEqual(JSON.stringify(element).length, 2, '不产出空元素');
  }
});

test('snapshot=null：不抛错、不产出空区块，只有能写的块（走势 + 采集信息）', () => {
  const card = buildHotelCard({ monitor, snapshot: null, previous: null, imageKey: null, at: AT, trend: null });
  assert.equal(card.schema, '2.0');
  assert.equal(hasText(card, '整段最低总价'), false, '没有价就不出价格主视觉');
  assert.equal(hasText(card, '房型价格'), false);
  assert.equal(hasText(card, '价格走势'), false, '无图无统计时走势整块省略');
  assert.ok(hasText(card, '本次采集'));
  assert.ok(hasText(card, '本轮未取到房价'));
  // 每个 sectionTitle 后面都必须跟着内容，不能出现「标题 + 分隔线」的空块。
  const list = elements(card);
  list.forEach((element, index) => {
    const content = elementText(element);
    if (element.tag === 'div' && /^\*\*[^*]+\*\*/.test(content)) {
      const next = list[index + 1];
      assert.ok(next && (next.tag === 'img' || next.tag === 'markdown' || next.tag === 'column_set' || (next.tag === 'div' && elementText(next).replace(/<[^>]+>/g, '').trim() !== '')), `区块「${content}」后面缺少内容`);
    }
  });
});

test('无图 + 无统计（首次采集且 webhook 通道）：走势区块整块省略', () => {
  const card = buildHotelCard({ monitor, snapshot, previous: null, imageKey: null, at: AT, trend: null });
  assert.equal(hasText(card, '价格走势'), false);
  assert.equal(images(card).length, 0);
  assert.ok(hasText(card, '房型价格'), '房型不受影响');
  assert.equal(hasText(card, '覆盖'), false);
});

test('脏数据不抛：字段类型全错也返回可投递卡片', () => {
  const dirty = {
    nights: '两晚',
    adults: '2人',
    hotel: { name: 123, star: '三星', score: '4.7' },
    rooms: [
      null,
      { name: 42, bed: {}, area: [], bookable: true, price: { nightly: '420', total: '840' } },
      { name: '坏价格', bookable: true, price: { nightly: null, total: null } },
    ],
    lowest: { total: '840' },
  };
  assert.doesNotThrow(() => buildHotelCard({ monitor, snapshot: dirty, previous: '上次', imageKey: 0, at: null, trend: { values: ['x'], labels: null } }));
  const card = buildHotelCard({ monitor, snapshot: dirty, previous: '上次', imageKey: 0, at: null, trend: { values: ['x'], labels: null } });
  assert.equal(card.schema, '2.0');
  assert.ok(elements(card).length > 0);
  assert.doesNotThrow(() => JSON.stringify(card));
});

test('酒店名/日期缺失：标题退化但仍是合法卡片', () => {
  const bare = { ...monitor, params: {} };
  const card = buildHotelCard({ monitor: bare, snapshot: null, previous: null, imageKey: null, at: AT, trend: null });
  assert.equal(card.header.title.content, '价格监控');
  assert.equal(card.schema, '2.0');
  assert.ok(elements(card).length > 0);
  assert.equal(hasText(card, 'undefined'), false);
  assert.equal(hasText(card, 'null'), false);
});
