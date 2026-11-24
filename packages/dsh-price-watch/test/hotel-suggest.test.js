/**
 * 酒店 suggest（搜索联想）纯函数/纯 HTTP 测试。不联网、不开浏览器：网络层全部注入。
 *
 * 覆盖：响应解析过滤（只留 type==='hotel'）、城市过滤、最多 8 条、60 s 缓存命中、
 * keyword 校验、HTTP 错误原样抛、品牌词（hotelbrand）不出门店候选、confirmHotelId。
 * fixture 来自 2026-11-24 真实 suggest 响应脱敏瘦身（见 test/fixtures/hotel/）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  confirmHotelId,
  lookupHotel,
  parseSuggestHotels,
  resetSuggestCache,
  suggestHotels,
} from '../host/collect/hotel.js';

const fixture = (name) => readFile(new URL(`./fixtures/hotel/${name}`, import.meta.url), 'utf8').then(JSON.parse);

/** 构造一个计数的假 fetch，返回固定 payload。 */
function countingFetch(payload) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => payload };
  };
  impl.calls = () => calls;
  return impl;
}

test('parseSuggestHotels：只留 type=hotel、productId 数字，字段按契约映射', async () => {
  const payload = await fixture('suggest.json');
  const hotels = parseSuggestHotels(payload, { cityId: 2, cityName: '上海' });
  assert.equal(hotels.length, 1, 'sight/sightplay/hotellist 必须被丢弃');
  assert.deepEqual(Object.keys(hotels[0]).sort(), ['cityName', 'district', 'id', 'name', 'score', 'star'].sort());
  assert.equal(hotels[0].id, '1565886');
  assert.equal(hotels[0].name, '全季酒店(上海虹桥中山西路店)');
  assert.equal(hotels[0].cityName, '上海');
  assert.equal(hotels[0].star, '舒适型', 'starRating 是「舒适型」这类词，不是数字');
  assert.equal(hotels[0].score, null, '接口没有评分字段，不能编');
  assert.equal(hotels[0].district, '虹桥', '商圈取 zoneName 去掉城市前缀');
});

test('parseSuggestHotels：混杂类型只取 hotel；非数字 productId 丢弃', () => {
  const payload = {
    data: [
      { type: 'sight', productId: 1, word: '景点' },
      { type: 'poihotel', productId: 24640979, word: '某酒店附近的酒店' },
      { type: 'hotelbrand', productId: 49, word: '上海的全季酒店' },
      { type: 'hotel', productId: '1565886', word: '全季酒店(上海虹桥中山西路店)', cityId: 2, cityName: '上海' },
      { type: 'hotel', productId: 'abc', word: '坏 id 酒店', cityId: 2, cityName: '上海' },
      { type: 'hotel', productId: 12, word: '太短 id 酒店', cityId: 2, cityName: '上海' },
      { type: 'hotel', productId: 7270168, word: '上海外滩W酒店', cityId: 2, cityName: '上海' },
    ],
  };
  const hotels = parseSuggestHotels(payload, { cityId: 2, cityName: '上海' });
  assert.deepEqual(hotels.map((h) => h.id), ['1565886', '7270168']);
});

test('parseSuggestHotels：最多 8 条，保持携程排序', () => {
  const data = Array.from({ length: 12 }, (_, i) => ({
    type: 'hotel', productId: 1000000 + i, word: `测试酒店 ${i}`, cityId: 2, cityName: '上海',
  }));
  const hotels = parseSuggestHotels({ data }, { cityId: 2, cityName: '上海' });
  assert.equal(hotels.length, 8);
  assert.deepEqual(hotels.map((h) => h.name), Array.from({ length: 8 }, (_, i) => `测试酒店 ${i}`));
});

test('parseSuggestHotels：城市过滤（不同 cityId 丢弃；未知城市码不过滤）', async () => {
  const payload = await fixture('suggest.json');
  const shanghai = parseSuggestHotels(payload, { cityId: 2 });
  assert.equal(shanghai.length, 1);
  const beijing = parseSuggestHotels(payload, { cityId: 1 });
  assert.equal(beijing.length, 0, 'cityId 明确的异城结果必须被过滤');
  const unknown = parseSuggestHotels(payload, { cityId: 0 });
  assert.equal(unknown.length, 1, '拿不到 cityId 时不过滤，只带 cityName 返回');
});

test('suggestHotels：60 s 缓存命中不重复请求（同 key 第二次 0 次 fetch）', async () => {
  resetSuggestCache();
  const payload = await fixture('suggest.json');
  const fake = countingFetch(payload);
  const args = { cityName: '上海', keyword: '全季酒店(上海虹桥中山西路店)', cityId: 2, fetchImpl: fake };
  const first = await suggestHotels(args);
  assert.equal(fake.calls(), 1);
  assert.equal(first[0].id, '1565886');
  const second = await suggestHotels(args);
  assert.equal(fake.calls(), 1, '同 key 应命中缓存');
  assert.deepEqual(second, first);
  // 不同 keyword ⇒ 新请求
  await suggestHotels({ ...args, keyword: '上海外滩W酒店' });
  assert.equal(fake.calls(), 2);
  // 返回的是副本，调用方改不坏缓存
  second[0].name = '被改坏';
  const third = await suggestHotels(args);
  assert.equal(third[0].name, '全季酒店(上海虹桥中山西路店)');
});

test('suggestHotels：keyword 为空/超长直接抛错，不发请求', async () => {
  const fake = countingFetch({ data: [] });
  await assert.rejects(() => suggestHotels({ cityName: '上海', keyword: '   ', cityId: 2, fetchImpl: fake }), /关键词不能为空/);
  await assert.rejects(() => suggestHotels({ cityName: '上海', keyword: '酒'.repeat(41), cityId: 2, fetchImpl: fake }), /40/);
  assert.equal(fake.calls(), 0);
});

test('suggestHotels：HTTP 非 200 原样抛（上层映射 HOTEL_SUGGEST_NETWORK）', async () => {
  resetSuggestCache();
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => suggestHotels({ cityName: '上海', keyword: '全季酒店(上海虹桥中山西路店)', cityId: 2, fetchImpl: failing }),
    /HTTP 503/,
  );
});

test('suggestHotels：品牌词只回 hotelbrand ⇒ 门店列表为空（歧义信号，不伪造 id）', async () => {
  resetSuggestCache();
  const payload = await fixture('suggest-brand.json');
  const hotels = await suggestHotels({ cityName: '上海', keyword: '全季酒店', cityId: 2, fetchImpl: countingFetch(payload) });
  assert.deepEqual(hotels, [], '品牌 productId=49 不是酒店 id，不能当候选');
});

test('confirmHotelId：命中 true / 未命中 false / 品牌词 false', async () => {
  resetSuggestCache();
  const payload = await fixture('suggest.json');
  const fake = countingFetch(payload);
  const hit = await confirmHotelId({
    hotelId: '1565886', hotelName: '全季酒店(上海虹桥中山西路店)', cityName: '上海', cityId: 2, fetchImpl: fake,
  });
  assert.equal(hit, true);
  const miss = await confirmHotelId({
    hotelId: '1234567', hotelName: '全季酒店(上海虹桥中山西路店)', cityName: '上海', cityId: 2, fetchImpl: fake,
  });
  assert.equal(miss, false);
  const empty = await confirmHotelId({ hotelId: '1565886', hotelName: '', keyword: '', cityName: '上海', fetchImpl: fake });
  assert.equal(empty, false);
});

/** 一个按 URL 分流的假 fetch：suggest 返回 JSON，列表页返回 HTML fixture。 */
function routingFetch({ suggestPayload, listHtml, listStatus = 200 }) {
  let calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/soa2/30668/search')) {
      return { ok: true, status: 200, json: async () => suggestPayload };
    }
    if (!listHtml) return { ok: false, status: listStatus, text: async () => '' };
    return { ok: true, status: 200, text: async () => listHtml };
  };
  impl.calls = () => calls;
  return impl;
}

test('lookupHotel：裸品牌词 → 用列表页 SSR 补出可点选候选（≥2，含 1565886）', async () => {
  resetSuggestCache();
  const brand = await fixture('suggest-brand.json');
  const listHtml = await readFile(new URL('./fixtures/hotel/list-brand.html', import.meta.url), 'utf8');
  const fake = routingFetch({ suggestPayload: brand, listHtml });
  const result = await lookupHotel({
    city: 'SHA', cityName: '上海', keyword: '全季酒店', checkIn: '2026-12-05', checkOut: '2026-12-07',
    cityId: 2, fetchImpl: fake,
  });
  assert.equal(result.found, false);
  assert.equal(result.reason, 'ambiguous');
  assert.ok(result.candidates.length >= 2, `候选应 ≥2，实际 ${result.candidates.length}`);
  assert.ok(result.candidates.length <= 5, '最多 5 条');
  assert.ok(result.candidates.some((candidate) => candidate.id === '1565886'), '应含上海虹桥中山西路店');
  assert.deepEqual(Object.keys(result.candidates[0]).sort(), ['address', 'id', 'name', 'score']);
  assert.match(result.hint, /选择具体门店/);
  assert.ok(fake.calls().some((url) => url.includes('/hotels/list')), '品牌词应回退到列表页');
});

test('lookupHotel：品牌词列表页抓取失败 → 保持 ambiguous + 空候选，不抛错', async () => {
  resetSuggestCache();
  const brand = await fixture('suggest-brand.json');
  const fake = routingFetch({ suggestPayload: brand, listHtml: null, listStatus: 503 });
  const result = await lookupHotel({
    city: 'SHA', cityName: '上海', keyword: '全季酒店', checkIn: '2026-12-05', checkOut: '2026-12-07',
    cityId: 2, fetchImpl: fake,
  });
  assert.equal(result.reason, 'ambiguous');
  assert.deepEqual(result.candidates, []);
  assert.match(result.hint, /写得更完整/);
});

test('lookupHotel：「品牌 + 区域」多词输入 → 分词全命中且多家 ⇒ ambiguous（不粗暴 not-found）', async () => {
  resetSuggestCache();
  const payload = {
    data: [
      { type: 'hotel', productId: 21343772, word: '全季酒店(上海虹桥机场店)', cityId: 2, cityName: '上海' },
      { type: 'hotel', productId: 28725295, word: '全季酒店(上海虹桥中心店)', cityId: 2, cityName: '上海' },
      { type: 'hotel', productId: 374920, word: '上海金陵紫金山大酒店', cityId: 2, cityName: '上海' },
    ],
  };
  const fake = routingFetch({ suggestPayload: payload, listHtml: null });
  const result = await lookupHotel({
    city: 'SHA', cityName: '上海', keyword: '全季酒店 虹桥', checkIn: '2026-12-05', checkOut: '2026-12-07', fetchImpl: fake,
  });
  assert.equal(result.reason, 'ambiguous');
  assert.deepEqual(result.candidates.map((c) => c.id), ['21343772', '28725295']);
  assert.match(result.hint, /选择具体门店/);
});

test('lookupHotel：「品牌 + 区域」唯一命中 → 直接 found', async () => {
  resetSuggestCache();
  const payload = {
    data: [
      { type: 'hotel', productId: 28725295, word: '全季酒店(上海虹桥中心店)', cityId: 2, cityName: '上海' },
      { type: 'hotel', productId: 374920, word: '上海金陵紫金山大酒店', cityId: 2, cityName: '上海' },
    ],
  };
  const fake = routingFetch({ suggestPayload: payload, listHtml: null });
  const result = await lookupHotel({
    city: 'SHA', cityName: '上海', keyword: '全季酒店 虹桥', checkIn: '2026-12-05', checkOut: '2026-12-07', fetchImpl: fake,
  });
  assert.equal(result.found, true);
  assert.equal(result.hotel.id, '28725295');
});

/** 按 keyword 分流的假 fetch：brand 词走品牌响应，带城市的词走门店响应。 */
function keywordRoutingFetch({ brandPayload, cityPayload }) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const body = String(options.body || '');
    const keyword = decodeURIComponent(body.replace(/\+/g, ' ').match(/keyword=([^&]*)/)?.[1] || '');
    calls.push(keyword);
    if (!String(url).includes('/soa2/30668/search')) return { ok: false, status: 404, text: async () => '' };
    const payload = /上海/.test(keyword) ? cityPayload : brandPayload;
    return { ok: true, status: 200, json: async () => payload };
  };
  impl.calls = () => calls;
  return impl;
}

test('suggestHotels：裸品牌词 + 城市 → 自动补词「全季 上海」拿到具体门店（≥5，含 427795）', async () => {
  resetSuggestCache();
  const brand = await fixture('suggest-brand.json');
  const city = await fixture('suggest-brand-city.json');
  const fake = keywordRoutingFetch({ brandPayload: brand, cityPayload: city });
  const hotels = await suggestHotels({ city: 'SHA', cityName: '上海', keyword: '全季', cityId: 2, fetchImpl: fake });
  assert.ok(hotels.length >= 5, `应 ≥5 条，实际 ${hotels.length}`);
  assert.ok(hotels.length <= 8, '最多 8 条');
  assert.ok(hotels.some((hotel) => hotel.id === '427795'), '应含全季酒店(上海人民广场南京路店)');
  assert.ok(hotels.every((hotel) => /全季/.test(hotel.name)), '候选都应是全季门店');
  assert.deepEqual(fake.calls(), ['全季', '全季 上海'], '应发生两次请求：原词 + 补词');
});

test('suggestHotels：裸品牌词 + 城市 → 第二次结果进缓存（补词 key 也命中）', async () => {
  resetSuggestCache();
  const brand = await fixture('suggest-brand.json');
  const city = await fixture('suggest-brand-city.json');
  const fake = keywordRoutingFetch({ brandPayload: brand, cityPayload: city });
  await suggestHotels({ cityName: '上海', keyword: '全季', cityId: 2, fetchImpl: fake });
  assert.equal(fake.calls().length, 2);
  const again = await suggestHotels({ cityName: '上海', keyword: '全季', cityId: 2, fetchImpl: fake });
  assert.equal(fake.calls().length, 2, '同 key 应命中缓存');
  assert.ok(again.length >= 5);
  const direct = await suggestHotels({ cityName: '上海', keyword: '全季 上海', cityId: 2, fetchImpl: fake });
  assert.equal(fake.calls().length, 2, '补词请求的结果也应已缓存');
  assert.ok(direct.some((hotel) => hotel.id === '427795'));
});

test('suggestHotels：无城市名 → 不补词、不硬凑门店（返回 []）', async () => {
  resetSuggestCache();
  const brand = await fixture('suggest-brand.json');
  const fake = keywordRoutingFetch({ brandPayload: brand, cityPayload: null });
  const hotels = await suggestHotels({ keyword: '全季', fetchImpl: fake });
  assert.deepEqual(hotels, []);
  assert.deepEqual(fake.calls(), ['全季'], '没有城市就不该发第二次请求');
});

test('suggestHotels：关键词里已含城市名 → 不重复拼接', async () => {
  resetSuggestCache();
  const brand = await fixture('suggest-brand.json');
  const fake = keywordRoutingFetch({ brandPayload: brand, cityPayload: null });
  const hotels = await suggestHotels({ cityName: '上海', keyword: '全季 上海', cityId: 2, fetchImpl: fake });
  assert.deepEqual(hotels, [], '该词只回品牌/空结果时也不该再拼城市');
  assert.deepEqual(fake.calls(), ['全季 上海']);
});

test('lookupHotel：裸品牌词 + 城市 → ambiguous，候选 ≥5 条门店（来自补词结果）', async () => {
  resetSuggestCache();
  const brand = await fixture('suggest-brand.json');
  const city = await fixture('suggest-brand-city.json');
  const fake = keywordRoutingFetch({ brandPayload: brand, cityPayload: city });
  const result = await lookupHotel({
    city: 'SHA', cityName: '上海', keyword: '全季酒店', checkIn: '2026-12-05', checkOut: '2026-12-07',
    cityId: 2, fetchImpl: fake,
  });
  assert.equal(result.found, false);
  assert.equal(result.reason, 'ambiguous');
  assert.ok(result.candidates.length >= 5, `候选应 ≥5，实际 ${result.candidates.length}`);
  assert.ok(result.candidates.some((candidate) => candidate.id === '427795'));
  assert.match(result.hint, /选择具体门店/);
});

test('lookupHotel：裸品牌词但补词也没结果 → 退回列表页兜底（仍不抛错）', async () => {
  resetSuggestCache();
  const brand = await fixture('suggest-brand.json');
  const listHtml = await readFile(new URL('./fixtures/hotel/list-brand.html', import.meta.url), 'utf8');
  const calls = [];
  const fake = async (url, options = {}) => {
    if (String(url).includes('/soa2/30668/search')) {
      calls.push(String(options.body || ''));
      return { ok: true, status: 200, json: async () => brand };
    }
    return { ok: true, status: 200, text: async () => listHtml };
  };
  const result = await lookupHotel({
    city: 'SHA', cityName: '上海', keyword: '全季酒店', checkIn: '2026-12-05', checkOut: '2026-12-07',
    cityId: 2, fetchImpl: fake,
  });
  assert.equal(result.reason, 'ambiguous');
  assert.ok(result.candidates.length >= 2);
  assert.equal(calls.length, 2, '品牌词应尝试原词 + 补词两次');
});
