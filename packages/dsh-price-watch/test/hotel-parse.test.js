/**
 * 酒店采集器的纯函数测试（不联网、不开浏览器）。
 *
 * 覆盖面：价格解析、名称归一化/相似度、候选匹配（命中/歧义/查无）、
 * 房型响应解析（登录态/匿名/日期不一致）、地址清洗与 SSR 地址提取。
 * fixture 都来自 2026-11-24 的真实响应（脱敏瘦身），见 test/fixtures/hotel/。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assertRoomDates,
  cleanHotelAddress,
  matchCandidate,
  nameSimilarity,
  normalizeHotelName,
  parsePrice,
  parseRoomPayload,
  plausibleHotelAddress,
  readSsrAddress,
} from '../host/collect/hotel.js';

const fixture = (name) => readFile(new URL(`./fixtures/hotel/${name}`, import.meta.url), 'utf8').then(JSON.parse);

/** 契约第 3 节的必填参数。 */
const baseArgs = { hotelId: '1565886', checkIn: '2026-12-05', checkOut: '2026-12-07', nights: 2, adults: 2, rooms: 1 };

test('parsePrice：货币符号/千分位/小数/空值', () => {
  assert.equal(parsePrice('¥597.9'), 598);
  assert.equal(parsePrice('¥1,234'), 1234);
  assert.equal(parsePrice(299), 299);
  assert.equal(parsePrice(''), 0);
  assert.equal(parsePrice(null), 0);
});

test('normalizeHotelName：全半角括号、空格、分隔符一律抹平', () => {
  assert.equal(normalizeHotelName('全季酒店（上海虹桥中山西路店）'), normalizeHotelName('全季酒店(上海虹桥中山西路店)'));
  assert.equal(normalizeHotelName(' 全季 酒店 '), '全季酒店');
  assert.notEqual(normalizeHotelName('全季酒店(虹桥店)'), normalizeHotelName('全季酒店(徐泾店)'));
});

test('nameSimilarity：同名=1，不同门店明显更低', () => {
  assert.equal(nameSimilarity('全季酒店(上海虹桥中山西路店)', '全季酒店（上海虹桥中山西路店）'), 1);
  const sibling = nameSimilarity('全季酒店(上海虹桥中山西路店)', '全季酒店(上海虹桥枢纽徐泾店)');
  assert.ok(sibling > 0.5 && sibling < 0.92, `同品牌不同门店应落在中间区间，实际 ${sibling}`);
});

test('matchCandidate：完全同名 → found', () => {
  const candidates = [
    { id: '6435064', name: '全季酒店(上海虹桥枢纽徐泾店)' },
    { id: '1565886', name: '全季酒店(上海虹桥中山西路店)' },
  ];
  const result = matchCandidate(candidates, '全季酒店(上海虹桥中山西路店)');
  assert.equal(result.found, true);
  assert.equal(result.hotel.id, '1565886');
});

test('matchCandidate：只有相似门店 → 不猜，返回 not-found', () => {
  const candidates = [
    { id: '6435064', name: '全季酒店(上海虹桥枢纽徐泾店)' },
    { id: '98063418', name: '全季酒店(上海东靖路地铁站店)' },
  ];
  const result = matchCandidate(candidates, '全季酒店(上海虹桥中山西路店)');
  assert.equal(result.found, false);
  assert.notEqual(result.reason, 'ambiguous');
});

test('matchCandidate：品牌名对上多家 → ambiguous 并带候选', () => {
  const candidates = [
    { id: '1565886', name: '全季酒店(上海虹桥中山西路店)', score: 4.6 },
    { id: '6435064', name: '全季酒店(上海虹桥枢纽徐泾店)', score: 4.4 },
    { id: '98063418', name: '全季酒店(上海东靖路地铁站店)', score: 4.7 },
  ];
  const result = matchCandidate(candidates, '全季酒店');
  assert.equal(result.found, false);
  assert.equal(result.reason, 'ambiguous');
  assert.ok(Array.isArray(result.candidates) && result.candidates.length >= 2);
});

test('matchCandidate：空候选 → not-found', () => {
  assert.deepEqual(matchCandidate([], '任何酒店'), { found: false, reason: 'not-found' });
});

test('parseRoomPayload：真实登录态响应 → 4 个物理房型，最低整段 ¥598', async () => {
  const payload = await fixture('roomlist-logged-in.json');
  const snapshot = parseRoomPayload(payload, baseArgs);
  assert.equal(snapshot.nights, 2);
  assert.equal(snapshot.adults, 2);
  assert.equal(snapshot.rooms.length, 4, '同一物理房型的多条售卖房应合并');
  assert.equal(snapshot.lowest.nightly, 299);
  assert.equal(snapshot.lowest.total, 598);
  assert.equal(snapshot.lowest.roomName, '大床房（电视投屏）');
  // 每个房型都必须有可比较的整段总价，且按总价升序
  const totals = snapshot.rooms.map((room) => room.price.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => a - b));
  for (const room of snapshot.rooms) {
    assert.ok(room.price.total > 0 && room.price.nightly > 0);
    // 整段总价来自 totalPriceInfo（含促销/取整），与「每晚 × 晚数」允许几元误差。
    assert.ok(Math.abs(room.price.total - room.price.nightly * 2) <= 5, `整段与每晚×晚数相差过大：${room.name}`);
  }
});

test('parseRoomPayload：匿名响应（价格被隐藏）→ HOTEL_LOGIN_REQUIRED', async () => {
  const payload = await fixture('roomlist-anonymous.json');
  assert.throws(() => parseRoomPayload(payload, baseArgs), (error) => error.code === 'HOTEL_LOGIN_REQUIRED');
});

test('assertRoomDates：响应日期与监控日期不一致 → HOTEL_BAD_RESPONSE', async () => {
  const payload = await fixture('roomlist-logged-in.json');
  const sent = payload.data.searchBoxInfo;
  assert.doesNotThrow(() => assertRoomDates(sent, '2026-12-05', '2026-12-07'));
  assert.throws(
    () => assertRoomDates(sent, '2027-01-20', '2027-01-22'),
    (error) => error.code === 'HOTEL_BAD_RESPONSE' && /20270120/.test(error.message),
  );
  // 响应里没有日期时不做断言（老结构不误伤）
  assert.doesNotThrow(() => assertRoomDates({}, '2027-01-20', '2027-01-22'));
});

test('parseRoomPayload：结构坏掉 → HOTEL_BAD_RESPONSE（不返回半个快照）', () => {
  assert.throws(() => parseRoomPayload({ data: {} }, baseArgs), (error) => error.code === 'HOTEL_BAD_RESPONSE');
  assert.throws(() => parseRoomPayload(null, baseArgs), (error) => error.code === 'HOTEL_BAD_RESPONSE');
});

test('cleanHotelAddress：裁掉页面按钮文案', () => {
  assert.equal(cleanHotelAddress('上海长宁区中山西路908号显示地图'), '上海长宁区中山西路908号');
  assert.equal(cleanHotelAddress('酒店地址：上海黄浦区南京东路20号'), '上海黄浦区南京东路20号');
  assert.equal(cleanHotelAddress('  '), '');
});

test('plausibleHotelAddress：周边商户/距离文案不算地址', () => {
  assert.equal(plausibleHotelAddress('上海长宁区中山西路908号'), true);
  assert.equal(plausibleHotelAddress('寄畅兴·百年蟹黄面·万国建筑群（外滩27号店） 181米'), false);
  assert.equal(plausibleHotelAddress('距酒店直线1.9公里'), false);
  assert.equal(plausibleHotelAddress(''), false);
});

test('readSsrAddress：从详情页 SSR 的 hotelPositionInfo 取地址', () => {
  const html = 'x,\\"hotelPositionInfo\\":{\\"lng\\":\\"121.41\\",\\"address\\":\\"上海长宁区中山西路908号\\",\\"placeInfo\\":{}}';
  assert.equal(readSsrAddress(html), '上海长宁区中山西路908号');
  assert.equal(readSsrAddress('<html></html>'), null);
});

test('list-ssr fixture 可被候选匹配消费（真实 13 家上海酒店）', async () => {
  const fixtureList = await fixture('list-ssr.json');
  const candidates = fixtureList.hotelList.map((hotel) => ({
    id: hotel.hotelId,
    name: hotel.name,
    score: Number(hotel.score) || null,
    address: hotel.address || '',
  }));
  assert.ok(candidates.length >= 10);
  const exact = matchCandidate(candidates, '全季酒店(上海虹桥中山西路店)');
  assert.equal(exact.found, true);
  assert.equal(exact.hotel.id, '1565886');
});
