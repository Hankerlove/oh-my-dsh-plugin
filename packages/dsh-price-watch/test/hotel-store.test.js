/**
 * 回归测试：酒店监控的存储层与派生值（docs/design/price-watch-hotel.md）。
 *
 * 锁住的是「Host 侧最容易悄悄坏掉」的几条口径：
 *  - 酒店监控的 id / type / mode / title 与参数校验（晚数、人数、日期边界）；
 *  - 老数据 / 坏数据必须能加载（绝不 throw），且 `init()` 迁移是幂等的；
 *  - `hotels/<id>.json` 的快照白名单：数字转整数、未知房型丢弃、按整段总价升序、
 *    `rooms` 只作为房型数组（契约 §3 示例里那个同名数字 key 是笔误）；
 *  - 删除监控时要连带清理 `hotels/` 快照与价格序列，存储统计/清理要认这个目录。
 *
 * 运行：node --test（零依赖、零网络；每个用例一个临时目录）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStore } from '../host/store.js';
import { addDays, hotelMonitorId, isoDate, monitorMode, monitorTitle, nightsBetween } from '../host/util.js';

/** 一个用完即删的临时 store（每个用例独立，互不影响）。 */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'pw-hotel-store-'));
  const store = createStore(dir);
  await store.init();
  return { dir, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 相对「今天」的合法酒店参数，避免把测试写死在某一天。 */
function hotelParams(overrides = {}) {
  const checkIn = overrides.checkIn ?? addDays(isoDate(), 10);
  const checkOut = overrides.checkOut ?? addDays(checkIn, 2);
  return {
    city: 'SHA',
    cityName: '上海',
    keyword: '全季 虹桥',
    hotelId: '436380',
    hotelName: '全季酒店(上海虹桥店)',
    checkIn,
    checkOut,
    adults: 2,
    ...overrides,
  };
}

test('monitorMode / monitorTitle / nightsBetween：酒店的三条派生口径', () => {
  const params = { hotelName: '全季酒店(上海虹桥店)', checkIn: '2026-12-05', checkOut: '2026-12-07' };
  assert.equal(nightsBetween('2026-12-05', '2026-12-07'), 2);
  assert.equal(nightsBetween('2026-12-05', '2026-12-05'), 0);
  assert.equal(nightsBetween('2026-12-07', '2026-12-05'), -2);
  assert.equal(nightsBetween('not-a-date', '2026-12-07'), null);
  assert.equal(nightsBetween('2026-12-05', null), null);

  // title 就是契约 §2 的示例格式（日期保留前导零、用 en dash）。
  assert.equal(monitorTitle(params), '全季酒店(上海虹桥店) · 12月05日–12月07日');
  // checkIn 是酒店标记，优先于 departDate；机票参数不受影响。
  assert.equal(monitorMode({ checkIn: '2026-12-05' }), 'hotel');
  assert.equal(monitorMode({ departDate: '2026-12-05' }), 'watch');
  assert.equal(monitorMode({}), 'calendar');
  assert.match(hotelMonitorId(), /^h_[0-9a-f]{8}$/);
});

test('createHotelMonitor：合法输入落库成 mode=hotel、无乘客、固定 1 间', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const monitor = await store.createHotelMonitor({ params: hotelParams(), cadence: { minutes: 50 } });
  assert.match(monitor.id, /^h_[0-9a-f]{8}$/);
  assert.equal(monitor.type, 'hotel');
  assert.equal(monitor.mode, 'hotel');
  assert.equal(monitor.enabled, true);
  assert.deepEqual(monitor.passengerIds, []);
  assert.equal(monitor.params.rooms, 1);
  assert.equal(monitor.params.hotelId, '436380');
  assert.equal(monitor.params.hotelName, '全季酒店(上海虹桥店)');
  // 50 分钟会向上夹到 60 分钟档位（共享节奏阶梯）。
  assert.deepEqual(monitor.cadence, { minutes: 60 });
  assert.equal(monitor.title, `全季酒店(上海虹桥店) · ${monitor.params.checkIn.slice(5, 7)}月${monitor.params.checkIn.slice(8, 10)}日–${monitor.params.checkOut.slice(5, 7)}月${monitor.params.checkOut.slice(8, 10)}日`);
  // 落盘后能按 id 读回同一个对象（read 会再跑一遍白名单）。
  const again = store.findMonitor(monitor.id);
  assert.equal(again.mode, 'hotel');
  assert.equal(again.params.checkIn, monitor.params.checkIn);
});

test('createHotelMonitor：参数校验（三字码 / 关键词 / 日期 / 晚数 / 人数 / 酒店身份）', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const today = isoDate();
  const cases = [
    [{ city: 'SH' }, /城市需要是 3 位城市三字码/],
    [{ keyword: '' }, /酒店名称不能为空/],
    [{ keyword: 'x'.repeat(41) }, /酒店名称最多 40 个字/],
    [{ checkIn: '2026-13-01' }, /入住日期格式/],
    [{ checkIn: addDays(today, -1) }, /入住日期不能早于今天/],
    [{ checkIn: addDays(today, 5), checkOut: addDays(today, 5) }, /离店日期必须晚于入住日期/],
    [{ checkIn: addDays(today, 5), checkOut: addDays(today, 36) }, /入住晚数不能超过 30 晚/],
    [{ adults: 0 }, /入住人数需要是 1–6 之间的整数/],
    [{ adults: 7 }, /入住人数需要是 1–6 之间的整数/],
    [{ adults: 2.5 }, /入住人数需要是 1–6 之间的整数/],
    [{ hotelId: '' }, /酒店信息不完整/],
    [{ hotelName: '' }, /酒店信息不完整/],
  ];
  for (const [overrides, pattern] of cases) {
    await assert.rejects(
      () => store.createHotelMonitor({ params: hotelParams(overrides) }),
      pattern,
      JSON.stringify(overrides),
    );
  }
  // 边界值要能过：今天入住、1 晚、6 人、不传 adults 默认 2 人。
  const oneNight = await store.createHotelMonitor({
    params: hotelParams({ checkIn: addDays(today, 1), checkOut: addDays(today, 2), adults: 6 }),
  });
  assert.equal(oneNight.mode, 'hotel');
  const defaulted = await store.createHotelMonitor({ params: hotelParams({ adults: undefined }) });
  assert.equal(defaulted.params.adults, 2);
});

test('validateHotelInput：新建前只做本地校验，返回规范化参数（不改库）', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const params = store.validateHotelInput({ params: hotelParams({ city: 'sha', keyword: '  全季 虹桥  ' }) });
  assert.equal(params.city, 'SHA');
  assert.equal(params.keyword, '全季 虹桥');
  assert.equal(params.rooms, 1);
  // 校验函数绝不落库。
  assert.deepEqual(store.listMonitors(), []);
  assert.throws(() => store.validateHotelInput({ params: hotelParams({ city: 'SHA', keyword: '' }) }), /酒店名称不能为空/);
});

test('updateMonitor：酒店改日期/人数只重算 title 与 nights，不重新校验酒店；mode 仍是 hotel', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const monitor = await store.createHotelMonitor({ params: hotelParams() });
  const nextCheckOut = addDays(monitor.params.checkIn, 4);
  const updated = await store.updateMonitor(monitor.id, {
    enabled: false,
    cadence: { minutes: 1440 },
    params: { checkOut: nextCheckOut, adults: 3 },
  });
  assert.equal(updated.type, 'hotel');
  assert.equal(updated.mode, 'hotel');
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.cadence, { minutes: 1440 });
  assert.equal(updated.params.checkOut, nextCheckOut);
  assert.equal(updated.params.adults, 3);
  // 酒店身份是既有字段，不是这一次 PATCH 提供：改日期不能要求重新校验酒店。
  assert.equal(updated.params.hotelId, monitor.params.hotelId);
  assert.notEqual(updated.title, monitor.title);
  // 非法日期仍然要拒绝（本地校验不因是 PATCH 而消失）。
  await assert.rejects(
    () => store.updateMonitor(monitor.id, { params: { checkOut: monitor.params.checkIn } }),
    /离店日期必须晚于入住日期/,
  );
});

test('writeHotelSnapshot：白名单 + 数字转整数 + 未知房型丢弃 + 整段总价升序', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const doc = await store.writeHotelSnapshot('h_1a2b3c4d', {
    fetchedAt: '2026-11-24T03:01:12.345Z',
    checkIn: '2026-12-05',
    checkOut: '2026-12-07',
    adults: '2',
    // 未知字段必须被丢弃。
    foo: 'bar',
    hotel: {
      id: 436380,
      name: '全季酒店(上海虹桥店)',
      star: '3',
      score: 4.66,
      scoreLabel: '很好',
      address: '长宁区虹桥路 1234 号',
      district: '虹桥地区',
      cityName: '上海',
    },
    rooms: [
      { name: '高级双床房', bed: '2张1.2米床', area: '30㎡', window: true, left: '2', bookable: true, price: { total: 900.4, nightly: 450.2 } },
      { name: '高级大床房', bed: '1张1.8米大床', area: '28㎡', window: false, bookable: true, price: { total: 840 } },
      { name: '', price: { total: 500 } }, // 未知房型：丢弃
      { name: '已满房', bookable: false, price: { total: 300 } }, // 不可订：丢弃
      { name: '零价房', bookable: true, price: { total: 0 } }, // 无效价：丢弃
      null,
    ],
    lowest: null, // 缺省时用 rooms[0] 补齐
  });

  assert.equal(doc.nights, 2);
  assert.equal(doc.adults, 2);
  assert.equal(doc.source, 'ctrip');
  assert.equal(doc.foo, undefined);
  // hotel 字段类型收敛：id 字符串、star 整数、score 一位小数。
  assert.deepEqual(doc.hotel, {
    id: '436380',
    name: '全季酒店(上海虹桥店)',
    star: 3,
    score: 4.7,
    scoreLabel: '很好',
    address: '长宁区虹桥路 1234 号',
    district: '虹桥地区',
    cityName: '上海',
  });
  // 只剩两个有效房型，按整段总价升序；nightly 缺省用 total/nights 取整。
  assert.equal(doc.rooms.length, 2);
  assert.deepEqual(doc.rooms.map((room) => room.price.total), [840, 900]);
  assert.deepEqual(doc.rooms[0].price, { nightly: 420, total: 840 }, 'nightly 缺省 = total / nights');
  assert.equal(doc.rooms[1].price.nightly, 450);
  // v1 不区分含早/可取消：恒为 null；left 数字字符串 → 整数。
  assert.equal(doc.rooms[0].breakfast, null);
  assert.equal(doc.rooms[0].cancellable, null);
  assert.equal(doc.rooms[1].left, 2);
  assert.equal(doc.rooms[0].left, null);
  // lowest 由 rooms[0] 补齐（契约 §3：lowest.total == rooms[0].price.total）。
  assert.deepEqual(doc.lowest, { roomId: '', roomName: '高级大床房', nightly: 420, total: 840 });
  // `rooms` 只能是房型数组，不允许出现数字型同名 key / 额外字段。
  assert.ok(Array.isArray(doc.rooms));
  assert.deepEqual(Object.keys(doc).sort(), [
    'adults', 'checkIn', 'checkOut', 'fetchedAt', 'hotel', 'lowest', 'nights', 'rooms', 'source',
  ].sort());
});

test('readHotelSnapshot：缺文件 / 坏数据都降级成 null，绝不 throw', async (t) => {
  const { dir, store, cleanup } = await makeStore();
  t.after(cleanup);
  assert.equal(await store.readHotelSnapshot('h_00000000'), null);
  await store.writeHotelSnapshot('h_00000001', { checkIn: '2026-12-05', checkOut: '2026-12-07', rooms: [] });
  const empty = await store.readHotelSnapshot('h_00000001');
  assert.deepEqual(empty.rooms, []);
  assert.equal(empty.lowest, null);
  // 半截/坏 JSON：读到 null（文件被移到 .bak 或忽略），调用方降级。
  await writeFile(join(dir, 'hotels', 'h_00000002.json'), '{ broken json', 'utf8');
  assert.equal(await store.readHotelSnapshot('h_00000002'), null);
});

test('init：老 monitors.json 里的酒店记录按 type 或 checkIn 识别，重复 init 不再改写', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-hotel-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = {
    monitors: [
      {
        id: 'm_aaaaaaaa',
        type: 'flight',
        title: '旧机票',
        enabled: true,
        params: { trip: 'oneway', dep: 'BJS', arr: 'SHA', departDate: '2026-12-03', cabin: 'y_s' },
        passengerIds: ['p_4c506d'],
        cadence: { l1Minutes: 15 },
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        // 老酒店记录：只有 checkIn，没有 type/mode，必须仍被识别成酒店。
        id: 'h_bbbbbbbb',
        title: '旧酒店',
        enabled: true,
        params: {
          city: 'SHA', cityName: '上海', keyword: '全季 虹桥',
          hotelId: '436380', hotelName: '全季酒店(上海虹桥店)',
          checkIn: '2026-12-05', checkOut: '2026-12-07', adults: 2, rooms: 1,
        },
        passengerIds: ['p_4c506d'],
        cadence: { hours: 6 },
        createdAt: 'x',
        updatedAt: 'x',
      },
      {
        // 坏酒店数据：日期非法、人数越界，仍必须能加载。
        id: 'h_cccccccc',
        type: 'hotel',
        params: { city: 'SHA', hotelName: '坏数据酒店', checkIn: 'nope', checkOut: '2026-12-07', adults: 99 },
        cadence: {},
      },
    ],
  };
  await writeFile(join(dir, 'monitors.json'), JSON.stringify(legacy), 'utf8');

  const first = createStore(dir);
  await first.init();
  const [flight, hotel, broken] = first.listMonitors();
  assert.equal(flight.type, 'flight');
  assert.deepEqual(flight.cadence, { minutes: 30 }, '机票 l1Minutes 15 → 专班 30 分钟');
  assert.equal(hotel.type, 'hotel');
  assert.equal(hotel.mode, 'hotel');
  assert.deepEqual(hotel.passengerIds, [], '酒店监控不要乘客');
  assert.deepEqual(hotel.cadence, { minutes: 360 }, 'hours 6 → 360 分钟');
  assert.equal(hotel.title, '全季酒店(上海虹桥店) · 12月05日–12月07日');
  assert.equal(broken.mode, 'hotel');
  assert.equal(broken.params.adults, 6, '坏人数收进 1–6');
  assert.equal(broken.params.checkIn, '');

  const migratedRaw = await readFile(join(dir, 'monitors.json'), 'utf8');
  const second = createStore(dir);
  await second.init();
  const secondRaw = await readFile(join(dir, 'monitors.json'), 'utf8');
  assert.equal(secondRaw, migratedRaw, '第二次 init 必须不再改写文件（幂等）');
  assert.deepEqual(second.listMonitors(), first.listMonitors());
});

test('removeMonitor：连带清理 hotels/<id>.json 与价格序列，并丢掉 state 残留', async (t) => {
  const { dir, store, cleanup } = await makeStore();
  t.after(cleanup);
  const monitor = await store.createHotelMonitor({ params: hotelParams() });
  await store.writeHotelSnapshot(monitor.id, {
    checkIn: monitor.params.checkIn,
    checkOut: monitor.params.checkOut,
    rooms: [{ name: '大床房', bookable: true, price: { total: 840 } }],
  });
  await store.appendPoints(monitor.id, [{
    at: '2026-11-24T03:01:12.345Z',
    key: { roomName: '大床房' },
    price: { total: 840, bare: 840 },
    src: 'hotel',
  }]);
  await store.saveState({ nextDue: { [monitor.id]: '2026-11-25T00:00:00.000Z' } });

  assert.equal(await store.removeMonitor(monitor.id), true);
  assert.equal(store.findMonitor(monitor.id), undefined);
  // 删除是「移到 .removed」而不是硬删（误删还能捞回来）。
  assert.ok((await readdir(join(dir, 'hotels'))).includes(`${monitor.id}.json.removed`));
  assert.ok((await readdir(join(dir, 'prices'))).includes(`${monitor.id}.jsonl.removed`));
  assert.equal(store.getState().nextDue[monitor.id], undefined);
});

test('storageReport / cleanupStorage：认 hotels 桶与 hotels/*.removed（additive，不动老字段）', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const monitor = await store.createHotelMonitor({ params: hotelParams() });
  await store.writeHotelSnapshot(monitor.id, {
    checkIn: monitor.params.checkIn,
    checkOut: monitor.params.checkOut,
    rooms: [{ name: '大床房', bookable: true, price: { total: 840 } }],
  });

  const report = await store.storageReport();
  // 老字段必须还在（向后兼容），新桶是 additive 的。
  for (const key of ['dataDir', 'totalBytes', 'totalFiles', 'removed', 'prices', 'calendar', 'flights', 'profileBytes']) {
    assert.ok(key in report, key);
  }
  assert.equal(report.hotels.files, 1);
  assert.ok(report.hotels.bytes > 0);
  assert.ok(report.totalBytes >= report.hotels.bytes);

  await store.removeMonitor(monitor.id);
  const afterRemove = await store.storageReport();
  assert.equal(afterRemove.hotels.files, 0, '快照已改名 .removed，不再算进 hotels 桶');
  assert.ok(afterRemove.removed.files >= 1);
  const cleaned = await store.cleanupStorage();
  assert.ok(cleaned.removed >= 1);
  assert.equal((await store.storageReport()).removed.files, 0, 'hotels/*.removed 也要被清掉');
});

test('投递日志：hotel 是一种合法 kind（不再被规范化成 calendar）', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  await store.appendDelivery({ monitorId: 'h_1a2b3c4d', title: '全季酒店(上海虹桥店)', kind: 'hotel', at: '2026-11-24T03:01:12.345Z', ok: true });
  const [entry] = await store.readDeliveries(5);
  assert.equal(entry.kind, 'hotel');
  assert.equal(entry.ok, true);
  await store.saveState({
    delivery: { h_1a2b3c4d: { hash: 'abc', at: '2026-11-24T03:01:12.345Z', ok: true, error: null, kind: 'hotel' } },
  });
  assert.equal(store.getState().delivery.h_1a2b3c4d.kind, 'hotel');
});

test('validateHotelInput：可选 hotelId / hotelName（联想下拉直通）的校验与透传', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const withId = store.validateHotelInput({
    params: { ...hotelParams(), hotelId: '1565886', hotelName: '全季酒店(上海虹桥中山西路店)' },
  });
  assert.equal(withId.hotelId, '1565886');
  assert.equal(withId.hotelName, '全季酒店(上海虹桥中山西路店)');
  // 数字形式的 productId 也要字符串化（携程 suggest 有时给 number）。
  assert.equal(store.validateHotelInput({ params: { ...hotelParams(), hotelId: 1565886 } }).hotelId, '1565886');
  // 两个字段都是可选的：不传就是空串，不影响原有校验。
  const without = store.validateHotelInput({ params: { ...hotelParams(), hotelId: undefined, hotelName: undefined } });
  assert.equal(without.hotelId, '');
  assert.equal(without.hotelName, '');
  // 非法 id（非数字 / 太短 / 太长 / 夹字母）一律 400。
  for (const bad of ['abc', '123', '1234567890123', '12a45', '1565886x']) {
    assert.throws(() => store.validateHotelInput({ params: { ...hotelParams(), hotelId: bad } }), /酒店 ID 格式不正确/, bad);
  }
  // hotelName 给了就必须 1–60 字。
  assert.throws(
    () => store.validateHotelInput({ params: { ...hotelParams(), hotelName: 'x'.repeat(61) } }),
    /酒店名称需要 1–60 个字/,
  );
});

test('createHotelMonitor：带 hotelId 直通落库；title/mode 正确，非法 id 不落库', async (t) => {
  const { store, cleanup } = await makeStore();
  t.after(cleanup);
  const monitor = await store.createHotelMonitor({
    params: hotelParams({ hotelId: '1565886', hotelName: '全季酒店(上海虹桥中山西路店)' }),
  });
  assert.equal(monitor.type, 'hotel');
  assert.equal(monitor.mode, 'hotel');
  assert.equal(monitor.params.hotelId, '1565886');
  assert.equal(monitor.params.hotelName, '全季酒店(上海虹桥中山西路店)');
  // 标题用「已确认的规范名」而不是用户关键词。
  assert.ok(monitor.title.startsWith('全季酒店(上海虹桥中山西路店) · '), monitor.title);
  // 后续 PATCH 不得把 mode 改成 calendar/watch，也不丢 hotelId。
  const patched = await store.updateMonitor(monitor.id, { params: { adults: 3 } });
  assert.equal(patched.mode, 'hotel');
  assert.equal(patched.params.hotelId, '1565886');
  assert.equal(patched.params.adults, 3);

  const before = store.listMonitors().length;
  await assert.rejects(
    () => store.createHotelMonitor({ params: hotelParams({ hotelId: 'abc' }) }),
    /酒店 ID 格式不正确/,
  );
  assert.equal(store.listMonitors().length, before, '非法 hotelId 不能落库');
});

test('init：坏 hotelId 的酒店记录仍能加载（宽松回落，绝不 throw）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-hotel-badid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'monitors.json'), JSON.stringify({
    monitors: [{
      id: 'h_dddddddd',
      type: 'hotel',
      params: {
        city: 'SHA', cityName: '上海', keyword: '全季 虹桥',
        hotelId: 'not-a-number', hotelName: '全季酒店(上海虹桥中山西路店)',
        checkIn: '2026-12-05', checkOut: '2026-12-07', adults: 2, rooms: 1,
      },
      cadence: { minutes: 360 },
    }],
  }), 'utf8');
  const store = createStore(dir);
  await store.init();
  const [hotel] = store.listMonitors();
  assert.equal(hotel.mode, 'hotel');
  assert.equal(hotel.params.hotelId, 'not-a-number', '坏 id 原样保留以便排查，但监控照样能加载');
});
