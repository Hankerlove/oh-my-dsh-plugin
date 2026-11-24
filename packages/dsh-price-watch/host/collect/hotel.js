/**
 * 酒店采集器：城市 + 酒店名 → 校验；酒店 id + 入离日期 → 房型价格。
 *
 * 数据源（真实请求验证，2026-11-24）：
 *  - 城市表：`POST https://m.ctrip.com/restapi/soa2/34951/getCityList`（纯 HTTP、匿名，
 *    `requestType:"1"`，返回 `data.inlandCityModel/globalCityModel.cityModelGroups[].regionModels[]`
 *    里 `displayCityModel.cityName` + `basicCityModel.cityId`）。进程内缓存一次。
 *  - 搜索：`https://hotels.ctrip.com/hotels/list?city=<cityId>&keyword=<kw>&checkin=&checkout=`。
 *    SSR 里内嵌 `initListData`（`self.__next_f.push` 转义 JSON），但 keyword 只影响部分排序，
 *    所以**候选一律由我们自己按名称归一化匹配**，不信"第一条"。
 *  - 房型：`POST https://m.ctrip.com/restapi/soa2/33278/getHotelRoomListInland`
 *    （详情页 `/hotels/<hotelId>.html?checkin=&checkout=&adult=&children=0&crn=1` 自动发出）。
 *    **必须让页面自己发这个请求**：body 里带绑定日期区间的 antiSpider token，任何重放
 *    （改日期/换 header，甚至在同一页面上下文里 fetch）都会被判 `htlSpiderActionErrorCode: 4030`。
 *
 * 匿名态：接口 200 且房型结构完整，但 `bookingStatusInfo.isHidePrice === true`、
 * `priceInfo.displayPrice === ""`、`buttonText: "登录看低价"` ⇒ 抛 HOTEL_LOGIN_REQUIRED。
 * 这正是本采集器走共享登录上下文（withPage）的原因：不自己 launch 浏览器。
 */

import { addDays, isDateString, isoDate, isoNow, nightsBetween, numberOr } from '../util.js';

const LIST_BASE = 'https://hotels.ctrip.com';
const CITY_API = 'https://m.ctrip.com/restapi/soa2/34951/getCityList';
/** suggest（搜索联想）：主搜索路径，登录态页面内 fetch，日期无关。 */
const SUGGEST_API = 'https://m.ctrip.com/restapi/soa2/30668/search';
/** 房型接口：PC/H5 同名，必须由页面发出。 */
const ROOM_API_RE = /getHotelRoomListInland/;
const BLOCK_RE = /whaleguard|访问验证|安全验证|请完成验证|滑动验证|访问异常|禁止访问/;
const LOGIN_HOST_RE = /passport\.ctrip\.com|accounts\.ctrip\.com/;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 带 code 的业务错误；网络类错误不要用它包。 */
function hotelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** `"¥420"` / `"420.5"` / `""` → number（空/非数字返回 0）。 */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').replace(/[,，\s]/g, '');
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Math.round(Number(match[0])) : 0;
}

/** 名称归一化：全/半角、括号、分隔符、空格一律抹平。 */
export function normalizeHotelName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s()（）【】\[\]{}<>·•\-—_/\\|,，.。:：'"]/g, '');
}

/** 二元组 Dice 相似度，0..1。 */
export function nameSimilarity(a, b) {
  const x = normalizeHotelName(a);
  const y = normalizeHotelName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i += 1) set.set(s.slice(i, i + 2), (set.get(s.slice(i, i + 2)) || 0) + 1);
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  let total = 0;
  for (const [gram, count] of gx) {
    total += count;
    const other = gy.get(gram) || 0;
    hit += Math.min(count, other);
  }
  for (const count of gy.values()) total += count;
  return total === 0 ? 0 : (2 * hit) / total;
}

/** 城市名 → 携程数字 cityId（纯 HTTP，进程内缓存）。 */
let cityTablePromise = null;
async function cityTable(signal) {
  if (!cityTablePromise) {
    cityTablePromise = (async () => {
      const response = await fetch(CITY_API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': UA,
          origin: LIST_BASE,
          referer: `${LIST_BASE}/`,
          accept: 'application/json, text/plain, */*',
        },
        body: JSON.stringify({
          requestType: '1',
          head: {
            platform: 'PC', cver: '0', cid: '', bu: 'HBU', group: 'ctrip', aid: '', sid: '', ouid: '',
            locale: 'zh-CN', region: 'CN', timezone: '8', currency: 'CNY', pageId: '', vid: '', guid: '',
            isSSR: false, extension: [],
          },
        }),
        signal,
      });
      if (!response.ok) throw new Error(`携程城市表接口 HTTP ${response.status}`);
      const payload = await response.json();
      const table = new Map();
      for (const model of [payload?.data?.inlandCityModel, payload?.data?.globalCityModel]) {
        for (const group of model?.cityModelGroups || []) {
          for (const region of group?.regionModels || []) {
            const name = String(region?.displayCityModel?.cityName || '').trim();
            const id = numberOr(region?.basicCityModel?.cityId, 0);
            if (name && id > 0) table.set(normalizeHotelName(name), id);
          }
        }
      }
      if (table.size === 0) throw new Error('携程城市表为空（接口结构可能已变）');
      return table;
    })().catch((error) => {
      cityTablePromise = null;
      throw error;
    });
  }
  return cityTablePromise;
}

/** 中文城市名（「上海」/「上海市」）→ cityId；找不到返回 0。 */
export async function resolveCityId(cityName, signal) {
  const table = await cityTable(signal);
  const key = normalizeHotelName(cityName);
  if (table.has(key)) return table.get(key);
  const trimmed = key.replace(/市$/, '');
  if (table.has(trimmed)) return table.get(trimmed);
  for (const [name, id] of table) if (name.startsWith(trimmed) || trimmed.startsWith(name)) return id;
  return 0;
}

/** 从 Next.js RSC 转义 JSON 里抠出 `initListData`（SSR 默认列表）。 */
export function extractInitListData(html) {
  const chunks = [...String(html ?? '').matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)];
  if (chunks.length === 0) return null;
  let payload = '';
  for (const chunk of chunks) {
    try {
      payload += JSON.parse(`"${chunk[1]}"`);
    } catch {
      /* 跳过坏块 */
    }
  }
  const at = payload.indexOf('"initListData"');
  if (at < 0) return null;
  const start = payload.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < payload.length; i += 1) {
    const ch = payload[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(payload.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** SSR 酒店列表 → 候选 [{ id, name, star, score, scoreLabel, address, district }] */
export function candidatesFromInitListData(data) {
  const out = [];
  for (const item of data?.hotelList || []) {
    const info = item?.hotelInfo || {};
    const id = String(info?.summary?.hotelId || '').trim();
    const name = String(info?.nameInfo?.name || '').trim();
    if (!id || !name) continue;
    const position = info?.positionInfo || {};
    out.push({
      cityId: numberOr(position?.cityId ?? info?.cityId, 0),
      id,
      name,
      star: numberOr(info?.hotelStar?.star, null),
      score: numberOr(info?.commentInfo?.commentScore ?? info?.commentInfo?.score, null),
      scoreLabel: String(info?.commentInfo?.commentDescription || '').trim() || null,
      address: String(position?.address || position?.positionDesc || '').trim(),
      district: String(position?.zoneName || position?.districtName || '').trim() || null,
    });
  }
  return out;
}

/** 关键词 → 归一化分词（≥2 字），用于「品牌+区域」这类组合输入的关联判断。 */
function keywordTokens(keyword) {
  return String(keyword ?? '')
    .split(/[\s·•,，/|]+/)
    .map((token) => normalizeHotelName(token))
    .filter((token) => token.length >= 2);
}

/** 名称匹配：完全相等 > 包含 > 相似度；前两名接近且不同名 → ambiguous。 */
export function matchCandidate(candidates, keyword) {
  const wanted = normalizeHotelName(keyword);
  if (!wanted) return { found: false, reason: 'not-found' };
  const scored = (candidates || [])
    .map((candidate) => {
      const name = normalizeHotelName(candidate.name);
      if (!name) return null;
      let score = nameSimilarity(candidate.name, keyword);
      if (name === wanted) {
        score = 1; // 归一化后完全相等
      } else if (name.includes(wanted) || wanted.includes(name)) {
        // 一方包含另一方：多出来的部分 ≤2 字才算命中；差距大会是「品牌名 vs 具体分店」
        const extra = Math.abs(name.length - wanted.length);
        if (extra <= 2) score = Math.max(score, 0.95);
        else if (name.startsWith(wanted) && wanted.length >= 2) score = Math.max(score, 0.8);
      } else if (wanted.length >= 2 && name.startsWith(wanted)) {
        // 品牌级前缀（如「全季酒店」）：只作为候选，不直接命中，≥2 家时判 ambiguous
        score = Math.max(score, 0.8);
      }
      return { ...candidate, match: Math.round(score * 100) / 100 };
    })
    .filter(Boolean)
    .sort((a, b) => b.match - a.match);

  // 同名去重（连锁分店同名时只保留一条）
  const seen = new Set();
  const distinct = scored.filter((candidate) => {
    const name = normalizeHotelName(candidate.name);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  if (distinct.length === 0) return { found: false, reason: 'not-found' };

  const [best, second] = distinct;
  // 命中线：完全相等(1.0) / 包含且差异 ≤2 字(0.95) / 相似度 ≥0.92
  if (best.match >= 0.92) {
    if (second && second.match >= 0.92 && best.match - second.match < 0.02) {
      return {
        found: false,
        reason: 'ambiguous',
        candidates: [best, second].map((c) => ({ id: c.id, name: c.name, address: c.address, score: c.score })),
      };
    }
    return { found: true, hotel: strip(best) };
  }
  // 未过命中线：≥0.75 的候选 ≥2 个 ⇒ ambiguous（让用户写完整），否则 not-found
  const close = distinct.filter((candidate) => candidate.match >= 0.75);
  if (close.length >= 2) {
    return {
      found: false,
      reason: 'ambiguous',
      candidates: close.slice(0, 5).map((c) => ({ id: c.id, name: c.name, address: c.address, score: c.score })),
    };
  }
  return { found: false, reason: 'not-found' };
}

function strip(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    star: candidate.star ?? null,
    score: candidate.score ?? null,
    scoreLabel: candidate.scoreLabel ?? null,
    address: candidate.address || '',
    district: candidate.district ?? null,
    cityName: candidate.cityName ?? null,
  };
}

/**
 * 房型响应里的日期必须和监控的入住/离店一致。
 *
 * 为什么是硬校验：详情页可能因为日期参数没生效而按默认日期出价，那种价格
 * 属于别的日期段，写进序列会画出一条假的走势。宁可报错也不存错数。
 */
export function assertRoomDates(searchBoxInfo, checkIn, checkOut) {
  const sent = searchBoxInfo || {};
  const wantIn = String(checkIn || '').replaceAll('-', '');
  const wantOut = String(checkOut || '').replaceAll('-', '');
  const gotIn = String(sent.checkIn || '');
  const gotOut = String(sent.checkOut || '');
  if (gotIn && gotOut && (gotIn !== wantIn || gotOut !== wantOut)) {
    throw hotelError(
      'HOTEL_BAD_RESPONSE',
      `携程返回的日期与监控日期不一致（期望 ${wantIn}→${wantOut}，实际 ${gotIn}→${gotOut}）`,
    );
  }
}

/** 单行房型价格解析（PC 详情页 getHotelRoomListInland 响应）。 */
export function parseRoomPayload(payload, { hotelId, checkIn, checkOut, nights, adults = 2, rooms = 1 }) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') {
    throw hotelError('HOTEL_BAD_RESPONSE', '携程房型接口结构异常（缺少 data）');
  }
  const saleRooms = data.saleRoomMap || data.saleRooms || null;
  if (!saleRooms) throw hotelError('HOTEL_BAD_RESPONSE', '携程房型接口结构异常（缺少 saleRoomMap）');
  const physicRooms = data.physicRoomMap || {};
  const isLogin = data.isLogin === true;

  const byPhysical = new Map();
  let hiddenCount = 0;
  let totalSaleRooms = 0;
  for (const [key, entry] of Object.entries(saleRooms)) {
    totalSaleRooms += 1;
    const physicalId = String(entry?.physicalRoomId ?? key.split('_')[0] ?? '');
    const status = entry?.bookingStatusInfo || {};
    // 口径（实测）：price / displayPrice 是「每晚价」，整段含税总价在 totalPriceInfo.total.content。
    const nightly = parsePrice(entry?.priceInfo?.price ?? entry?.priceInfo?.displayPrice);
    const totalRaw = parsePrice(entry?.totalPriceInfo?.total?.content) || parsePrice(entry?.totalPriceInfo?.quantityDays?.content);
    const total = totalRaw > 0 ? totalRaw : nightly * Math.max(1, nights);
    const hidden = status.isHidePrice === true || (nightly <= 0 && total <= 0);
    if (hidden) { hiddenCount += 1; continue; }
    if (status.isFullRoom === true || status.isBooking === false) continue;
    const physical = physicRooms[physicalId] || {};
    const name = String(physical?.name || entry?.name || '').trim() || `房型 ${physicalId}`;
    const room = {
      id: String(entry?.id ?? physicalId),
      name,
      bed: String(physical?.bedInfo?.title || physical?.bedInfo?.desc || '').trim() || null,
      area: String(physical?.areaInfo?.desc || physical?.areaInfo?.title || '').trim() || null,
      window: typeof physical?.window === 'boolean' ? physical.window : null,
      breakfast: null,
      cancellable: null,
      left: numberOr(status?.remainRoomQuantity, null),
      bookable: status.isHidePrice !== true && total > 0,
      price: { nightly, total },
      meal: String(entry?.mealInfo?.title || '').trim() || null,
      currency: String(entry?.priceInfo?.currency || 'CNY'),
    };
    const current = byPhysical.get(physicalId);
    if (!current || room.price.total < current.price.total) byPhysical.set(physicalId, room);
  }

  const list = [...byPhysical.values()]
    .filter((room) => room.bookable && room.price.total > 0)
    .sort((a, b) => a.price.total - b.price.total);

  if (list.length === 0) {
    if (hiddenCount > 0 && hiddenCount >= totalSaleRooms) {
      throw hotelError('HOTEL_LOGIN_REQUIRED', '酒店价格需要携程登录，请先在面板里登录');
    }
    throw hotelError('HOTEL_NO_ROOMS', '这家酒店在该日期段没有可订房型');
  }

  const hotelBasic = data.hotelBasicInfo || {};
  const first = list[0];
  return {
    fetchedAt: isoNow(),
    checkIn,
    checkOut,
    nights: Math.max(1, nights),
    adults,
    source: 'ctrip',
    hotel: {
      id: String(hotelId),
      name: String(hotelBasic?.hotelName || hotelBasic?.name || '').trim() || null,
      star: numberOr(hotelBasic?.star, null),
      score: numberOr(hotelBasic?.commentScore, null),
      scoreLabel: String(hotelBasic?.commentDescription || '').trim() || null,
      address: String(hotelBasic?.address || '').trim(),
      district: null,
      cityName: String(hotelBasic?.cityName || '').trim() || null,
    },
    rooms: list,
    lowest: { roomId: first.id, roomName: first.name, nightly: first.price.nightly, total: first.price.total },
  };
}

/** 地址清洗：裁掉详情页按钮/距离等噪声文案。 */
export function cleanHotelAddress(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const noisy = /(显示地图|查看地图|地图导航|地图|复制地址|查看详情|查看大图|导航|周边交通|距离[^ ]{0,12})[:：]?$/;
  text = text.replace(/^酒店地址[:：]\s*/, '').replace(/^地址[:：]\s*/, '');
  for (let i = 0; i < 6 && noisy.test(text); i += 1) text = text.replace(noisy, '').trim();
  return text.replace(/[·\-—\s]+$/g, '').trim();
}

/**
 * DOM 兜底地址的合理性检查：酒店地址应该是「…路/街/道/镇 + 门牌号」。
 * 周边商户文案（「寄畅兴·百年蟹黄面（外滩27号店） 181米」）会被拒成 null——
 * 面板里宁可没有地址，也不能显示隔壁面馆的地址。
 */
export function plausibleHotelAddress(value) {
  const text = String(value ?? '').trim();
  if (text.length < 4 || text.length > 60) return false;
  if (/\d+(\.\d+)?\s*(米|公里|km)\s*$/i.test(text)) return false;
  if (/^(距|周边|附近)/.test(text)) return false;
  return /[号弄]/.test(text) || (/[路街巷道]/.test(text) && /\d/.test(text));
}

/** 详情页 DOM 尽力补酒店元信息（读不到返回 null，绝不抛错）。 */
/**
 * 从详情页 SSR 内嵌 JSON 里取**权威**地址（`hotelPositionInfo.address`）。
 *
 * 为什么不用 DOM 文本：页面上「地址」附近全是「寄畅兴·百年蟹黄面 181米」这类
 * 周边商户/距离文案，按选择器挑「最像地址的一条」会挑到商户名（真实踩过：
 * 和平饭店拿到了隔壁面馆）。`hotelPositionInfo.address` 是酒店自身坐标块里的
 * 地址字段，唯一且不会被推荐位污染。
 */
export function readSsrAddress(html) {
  const text = String(html ?? '').replace(/\\+"/g, '"');
  const match = text.match(/"hotelPositionInfo"\s*:\s*\{[^{}]*?"address"\s*:\s*"([^"]{2,100})"/);
  return match ? cleanHotelAddress(match[1]) : null;
}

async function readHotelHeader(page) {
  const empty = { name: null, star: null, score: null, scoreLabel: null, address: null };
  try {
    // 先拿 SSR 权威地址；拿不到再退回 DOM（DOM 结果必须过 cleanHotelAddress，
    // 里面会拒掉「…米」「·」这类周边商户文案）。
    const ssrAddress = readSsrAddress(await page.content().catch(() => ''));
    const result = await page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 6000);
      const title = document.title || '';
      const pick = (selectors) => {
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            const value = (element.textContent || '').replace(/\s+/g, ' ').trim();
            if (value && value.length <= 60) return value;
          }
        }
        return null;
      };
      const name = title.split('预订')[0].trim() || pick(['h1', '[class*="hotelName"]', '[class*="hotel-name"]']) || null;
      const labelMatch = text.match(/(\d(?:\.\d)?)\s*(超棒|很好|不错|极好|好|棒|推荐)/);
      const anyScore = text.match(/(\d\.\d)\s*(?:分|\/5|超棒|很好|不错)/);
      const score = labelMatch ? Number(labelMatch[1]) : anyScore ? Number(anyScore[1]) : null;
      const starMatch = text.match(/([1-5])\s*星级/);
      // 地址：在候选文本里挑「最像完整地址」的一条（含 号/路/>6 字），再兜底正则
      const addressParts = [];
      for (const selector of ['[class*="AddressDesc"]', '[class*="addressDesc"]', '[aria-label*="号"]', '[class*="address"]', '[class*="Address"]', '[class*="position"]', '[class*="location"]']) {
        for (const element of document.querySelectorAll(selector)) {
          for (const raw of [element.getAttribute('aria-label'), element.textContent]) {
            const value = (raw || '').replace(/\s+/g, ' ').trim();
            if (value && value.length <= 80) addressParts.push(value);
          }
        }
      }
      const addressText = addressParts.sort((a, b) => {
        const scoreOf = (v) => (/(号|路|街|道|镇|弄)/.test(v) ? 2 : 0) + (v.length >= 8 ? 1 : 0) + Math.min(v.length, 40) / 100;
        return scoreOf(b) - scoreOf(a);
      })[0] || null;
      const address = addressText
        || (text.match(/([\u4e00-\u9fa5]{2,}(?:路|街|道|镇|弄)[^\n，,。]{0,20}\d+号[^\n，,。]{0,12})/) || [])[1]
        || null;
      return {
        name,
        star: starMatch ? Number(starMatch[1]) : null,
        score: Number.isFinite(score) && score > 0 && score <= 5 ? score : null,
        scoreLabel: labelMatch ? labelMatch[2] : null,
        address,
      };
    });
    const merged = { ...empty, ...(result || {}) };
    // SSR 的 hotelPositionInfo.address 是酒店自身的地址；DOM 只做兜底，
    // 且必须过 cleanHotelAddress（会拒掉周边商户/距离文案）。
    const domAddress = cleanHotelAddress(merged.address);
    merged.address = ssrAddress || (plausibleHotelAddress(domAddress) ? domAddress : null);
    return merged;
  } catch {
    return empty;
  }
}

function hotelDetailUrl(hotelId, params) {
  const query = new URLSearchParams({
    checkin: params.checkIn,
    checkout: params.checkOut,
    adult: String(params.adults ?? 2),
    children: '0',
    crn: String(params.rooms ?? 1),
  });
  return `${LIST_BASE}/hotels/${encodeURIComponent(hotelId)}.html?${query.toString()}`;
}

function hotelListUrl(cityId, keyword, params, cityName) {
  const query = new URLSearchParams({ checkin: params.checkIn, checkout: params.checkOut, adult: '2', crn: '1' });
  if (cityId > 0) query.set('city', String(cityId));
  if (keyword) query.set('keyword', keyword);
  else if (cityName) query.set('keyword', cityName);
  return `${LIST_BASE}/hotels/list?${query.toString()}`;
}

function isNavigationError(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  return /net::ERR_|chrome-error|NS_ERROR|ECONNRESET|ETIMEDOUT|Timeout .* exceeded/i.test(text);
}

/**
 * 校验酒店存在性（纯 HTTP）：suggest → 名称严格匹配 → 详情页 SSR 补元信息。
 *
 * 主路径不碰浏览器（2026-11-24 实测 suggest 纯 HTTP 0.27–0.30 s、无需登录）；
 * `withPage` 变成**可选**兜底：只有 suggest 完全拿不到条目（结构变化/接口异常）且
 * 调用方提供 withPage 时，才退回旧的列表页解析（那段逻辑依赖登录态，成本高）。
 */
export async function lookupHotel({ city, cityName, keyword, checkIn, checkOut, withPage, signal, fetchImpl }) {
  const text = String(keyword ?? '').trim();
  if (!text) return { found: false, reason: 'not-found' };
  const visible = String(cityName ?? '').trim();
  const today = isoDate();
  const range = normalizeRange(checkIn, checkOut, today);

  const bundle = await suggestBundle({ city, cityName: visible, keyword: text, signal, fetchImpl });
  const resolvedCityId = visible ? await resolveCityId(visible, signal).catch(() => 0) : 0;
  if (bundle) {
    // 裸品牌词 + 城市：suggest 用「品牌 + 城市名」补词拿到了具体门店 ⇒ 直接给可点选候选，
    // 不要拿「全季酒店」去和「全季酒店(上海人民广场南京路店)」做 0.92 硬匹配。
    if (bundle.cityFallback && bundle.brands.length > 0 && bundle.hotels.length > 0) {
      return {
        found: false,
        reason: 'ambiguous',
        candidates: bundle.hotels.slice(0, 8).map((hotel) => ({
          id: hotel.id,
          name: hotel.name,
          address: hotel.address || '',
          score: hotel.score ?? null,
        })),
        brands: bundle.brands.slice(0, 5).map((brand) => ({ id: null, name: brand.name, address: '', score: null })),
        hint: '这是品牌名，请选择具体门店',
      };
    }
    const result = matchCandidate(bundle.hotels, text);
    if (result.found) {
      result.hotel.cityName = result.hotel.cityName || visible || null;
      await enrichLookupHotel(result.hotel, range, signal);
      return result;
    }
    if (result.reason === 'ambiguous') return result;
    // 只有品牌项（如「全季酒店」）：suggest 给不出 hotelId，但列表页 SSR 里有具体门店，
    // 用纯 HTTP 抓一次列表页把候选补上（失败就退回空候选，绝不抛错）。
    if (bundle.brands.length > 0 && bundle.hotels.length === 0) {
      const candidates = await brandCandidates(text, visible, resolvedCityId, range, signal, fetchImpl);
      return {
        found: false,
        reason: 'ambiguous',
        candidates,
        brands: bundle.brands.slice(0, 5).map((brand) => ({ id: null, name: brand.name, address: '', score: null })),
        hint: candidates.length > 0 ? '这是品牌名，请选择具体门店' : '这是品牌名，不是具体门店，请把酒店名称写得更完整',
      };
    }
    if (bundle.hotels.length > 0) {
      // 「全季酒店 虹桥」这类「品牌 + 区域」输入：单个名称都过不了 0.92，但所有分词都能对上 ⇒
      // 让用户从门店里选（唯一命中时直接采用），不要粗暴 not-found。
      const tokens = keywordTokens(text);
      const related = tokens.length >= 2
        ? bundle.hotels.filter((hotel) => tokens.every((token) => normalizeHotelName(hotel.name).includes(token)))
        : [];
      if (related.length === 1) {
        const hotel = { ...related[0] };
        await enrichLookupHotel(hotel, range, signal);
        return { found: true, hotel };
      }
      if (related.length >= 2) {
        return {
          found: false,
          reason: 'ambiguous',
          candidates: related.slice(0, 5).map((hotel) => ({ id: hotel.id, name: hotel.name, address: hotel.address || '', score: hotel.score ?? null })),
          hint: '匹配到多家门店，请选择具体门店',
        };
      }
      return result; // 有候选但都不同名 ⇒ 直接 not-found
    }
  }

  // 兜底：suggest 不可用且调用方给了浏览器上下文时，才走列表页（旧逻辑，保留）。
  if (typeof withPage !== 'function') return { found: false, reason: 'not-found' };
  const cityId = visible ? await resolveCityId(visible, signal).catch(() => 0) : 0;
  const absorbList = (candidates, list) => {
    for (const item of list) if (item?.id && !candidates.has(item.id)) candidates.set(item.id, item);
  };
  return withPage(async (page) => {
    const listLookup = async (searchRange) => {
      const url = hotelListUrl(cityId, text, { checkIn: searchRange.checkIn, checkOut: searchRange.checkOut, adults: 2, rooms: 1 }, visible);
      const candidates = new Map();
      page.waitForResponse((response) => /fetchHotel(List|Seo)|getHotelList/i.test(response.url()), { timeout: 20000 }).catch(() => null);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4500);
      if (LOGIN_HOST_RE.test(page.url())) {
        absorbList(candidates, candidatesFromInitListData(extractInitListData(await fetchListHtml(url, signal, fetchImpl))));
      } else {
        absorbList(candidates, candidatesFromInitListData(extractInitListData(await page.content())));
      }
      const result = matchCandidate([...candidates.values()], text);
      if (result.found) result.hotel.cityName = visible || null;
      return result;
    };
    const first = await listLookup(range);
    if (first.found || first.reason === 'ambiguous') return first;
    const retry = { checkIn: addDays(today, 7), checkOut: addDays(today, 9) };
    if (retry.checkIn !== range.checkIn) {
      const again = await listLookup(retry);
      if (again.found || again.reason === 'ambiguous') return again;
    }
    return first;
  });
}

/**
 * 品牌词 → 具体门店候选（纯 HTTP，最多 5 条）。
 * 列表页 SSR 自带 `initListData.hotelList`；城市过滤只对带 cityId 的条目生效，抓取失败返回空数组。
 */
async function brandCandidates(keyword, cityName, cityId, range, signal, fetchImpl) {
  try {
    const url = hotelListUrl(cityId, keyword, { checkIn: range.checkIn, checkOut: range.checkOut, adults: 2, rooms: 1 }, cityName);
    const html = await fetchListHtml(url, signal, fetchImpl);
    const list = candidatesFromInitListData(extractInitListData(html)) || [];
    const tokens = keywordTokens(keyword);
    const related = tokens.length > 0
      ? list.filter((candidate) => tokens.every((token) => normalizeHotelName(candidate.name).includes(token)))
      : [];
    // 列表页 keyword 只影响排序（会混进无关酒店），优先只留名字真含关键词的门店
    const pool = related.length > 0 ? related : list;
    const filtered = cityId > 0 ? pool.filter((candidate) => !candidate.cityId || candidate.cityId === cityId) : pool;
    return filtered.slice(0, 5).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      address: candidate.address || '',
      score: candidate.score ?? null,
    }));
  } catch {
    return [];
  }
}

/** 详情页 SSR 补元信息（纯 HTTP：`hotelPositionInfo.address` / `hotelName` / 评分 / 星级）。 */
async function enrichLookupHotel(hotel, range, signal) {
  try {
    const html = await fetchDetailHtml(hotel.id, range, signal);
    if (!html) return hotel;
    const address = readSsrAddress(html);
    if (address && plausibleHotelAddress(address)) hotel.address = address;
    const plain = html.replace(/\\+"/g, '"');
    const name = (plain.match(/"hotelName"\s*:\s*"([^"]{2,60})"/) || [])[1];
    if (name) hotel.name = name;
    const scoreText = (plain.match(/"commentScore"\s*:\s*"?([\d.]+)"?/) || plain.match(/"score"\s*:\s*"?([\d.]+)"?/) || [])[1];
    const score = Number(scoreText);
    if (Number.isFinite(score) && score > 0 && score <= 5) hotel.score = score;
    // 评分词实测在 aria-label 里：`aria-label="4.6 很好 显示所有4,872条点评"`
    const labelMatch = plain.match(/([0-9]\.[0-9])\s+(超棒|很好|不错|极好|好|棒)\s+显示所有/)
      || plain.match(/"commentDescription"\s*:\s*"([^"]{1,8})"/);
    if (labelMatch) {
      if (labelMatch[2]) hotel.scoreLabel = labelMatch[2];
      if (!hotel.score && Number(labelMatch[1]) > 0) hotel.score = Number(labelMatch[1]);
    }
    const star = (plain.match(/"star"\s*:\s*([1-5])\b/) || [])[1];
    if (star) hotel.star = Number(star);
  } catch {
    /* 元信息补全失败不影响主流程（地址/评分为 null） */
  }
  return hotel;
}

/** 详情页 HTML（纯 HTTP，匿名可读；失败返回 null）。 */
async function fetchDetailHtml(hotelId, range, signal) {
  try {
    return await fetchListHtml(hotelDetailUrl(hotelId, { checkIn: range.checkIn, checkOut: range.checkOut, adults: 2, rooms: 1 }), signal);
  } catch {
    return null;
  }
}

/** 入离日期兜底：非法/缺失时退回今天+明天。 */
function normalizeRange(checkIn, checkOut, today) {
  const validIn = isDateString(checkIn) ? checkIn : null;
  const validOut = isDateString(checkOut) ? checkOut : null;
  if (validIn && validOut && validOut > validIn) return { checkIn: validIn, checkOut: validOut };
  return { checkIn: today, checkOut: addDays(today, 1) };
}

/** suggest 缓存：60 s、最多 200 条（key = 归一化城市名 + 归一化 keyword）。 */
const SUGGEST_TTL_MS = 60 * 1000;
const SUGGEST_CACHE_MAX = 200;
const suggestCache = new Map();

/** 测试用：清空 suggest 缓存。 */
export function resetSuggestCache() {
  suggestCache.clear();
}

/** 只留 `type === 'hotel'`、`productId` 是数字的条目，最多 8 条，保持携程排序。 */
export function parseSuggestHotels(payload, { cityId = 0, cityName = '' } = {}) {
  const list = payload?.data;
  if (!Array.isArray(list)) return [];
  const hotels = [];
  const seen = new Set();
  for (const item of list) {
    if (hotels.length >= 8) break;
    if (String(item?.type || '') !== 'hotel') continue;
    const rawId = item?.productId;
    if (!/^\d{4,12}$/.test(String(rawId ?? ''))) continue;
    const id = String(rawId);
    if (seen.has(id)) continue;
    const name = String(item?.word || '').trim();
    if (!name) continue;
    const itemCityId = numberOr(item?.cityId, 0);
    const itemCityName = String(item?.cityName || '').trim() || null;
    // 有城市上下文时按 cityId 过滤（拿不到 cityId 就不过滤）
    if (cityId > 0 && itemCityId > 0 && itemCityId !== cityId) continue;
    seen.add(id);
    const zone = String(item?.zoneName || '').trim().replace(/^[^-]*-/, '');
    const districtName = String(item?.districtName || '').trim();
    hotels.push({
      id,
      name,
      cityName: itemCityName || String(cityName || '').trim() || null,
      district: zone || (districtName && districtName !== itemCityName ? districtName : null) || null,
      star: String(item?.starRating || '').trim() || null,
      score: null,
    });
  }
  return hotels;
}

/** 从 suggest 原始响应里同时拿门店与品牌项（品牌项只用于判断歧义，不进候选）。 */
function splitSuggestPayload(payload, context) {
  const list = payload?.data;
  if (!Array.isArray(list)) return null;
  const brands = [];
  for (const item of list) {
    if (String(item?.type || '') !== 'hotelbrand') continue;
    const name = String(item?.word || '').trim();
    if (name) brands.push({ id: String(item?.productId ?? ''), name, cityId: numberOr(item?.cityId, 0) });
  }
  return { hotels: parseSuggestHotels(payload, context), brands };
}

/**
 * suggest 接口（纯 HTTP，无需登录/浏览器）：`POST m.ctrip.com/restapi/soa2/30668/search`。
 *
 * - 60 s 进程内缓存（key = 归一化 cityName + 归一化 keyword，最多 200 条，超出丢最旧）；
 * - 网络/HTTP 错误原样抛（上层用 `isNetworkError` 映射成 HOTEL_SUGGEST_NETWORK）；
 * - `fetchImpl` / `cityId` 仅用于测试注入，Host 不必传。
 */
export async function suggestHotels({ city, cityName, keyword, signal, fetchImpl, cityId } = {}) {
  const bundle = await suggestBundle({ city, cityName, keyword, signal, fetchImpl, cityId });
  return bundle ? bundle.hotels : [];
}

/** suggest 的完整结果 `{ hotels, brands }`（lookupHotel/confirmHotelId 共用缓存）。 */
function cloneBundle(bundle) {
  return {
    hotels: (bundle.hotels || []).map((hotel) => ({ ...hotel })),
    brands: (bundle.brands || []).map((brand) => ({ ...brand })),
    cityFallback: Boolean(bundle.cityFallback),
  };
}

/** 一次 suggest HTTP 请求 + 解析 + 城市过滤（不做缓存、不做城市补词）。 */
async function requestSuggest(text, { resolvedCityId, visible, signal, fetchImpl }) {
  const request = fetchImpl || fetch;
  const body = new URLSearchParams({ action: 'online', source: 'globalonline', keyword: text });
  const response = await request(SUGGEST_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
      origin: LIST_BASE,
      referer: `${LIST_BASE}/`,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    body: body.toString(),
    signal,
  });
  if (!response.ok) throw new Error(`携程 suggest 接口 HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    return null; // 被风控/结构变化：交给调用方兜底（lookupHotel 有列表页 fallback）
  }
  if (payload?.ResponseStatus?.Ack && payload.ResponseStatus.Ack !== 'Success') return null;
  return splitSuggestPayload(payload, { cityId: resolvedCityId, cityName: visible });
}

/**
 * suggest 的完整结果 `{ hotels, brands, cityFallback }`（suggestHotels/lookupHotel/confirmHotelId 共用缓存）。
 *
 * **城市补词重试**：裸品牌词（「全季」「汉庭」）携程只回 `hotelbrand`，拿不到具体门店；
 * 首次结果为空且给了 cityName 时，用「keyword + 城市名」再请求一次（关键词已含城市名则不重复拼）。
 */
async function suggestBundle({ city, cityName, keyword, signal, fetchImpl, cityId } = {}) {
  const text = String(keyword ?? '').trim();
  if (!text) throw new Error('关键词不能为空');
  if (text.length > 40) throw new Error('关键词不能超过 40 个字');
  const visible = String(cityName ?? '').trim();

  const resolvedCityId =
    Number.isInteger(cityId) && cityId > 0
      ? cityId
      : visible
        ? await resolveCityId(visible, signal).catch(() => 0)
        : 0;

  const key = `${normalizeHotelName(visible)}|${normalizeHotelName(text)}`;
  const cached = suggestCache.get(key);
  if (cached && Date.now() - cached.at < SUGGEST_TTL_MS) {
    suggestCache.delete(key); // LRU：命中后移到队尾
    suggestCache.set(key, cached);
    return cloneBundle(cached);
  }

  const remember = (cacheKey, bundle) => {
    suggestCache.set(cacheKey, { at: Date.now(), ...bundle });
    while (suggestCache.size > SUGGEST_CACHE_MAX) {
      const oldest = suggestCache.keys().next();
      if (oldest.done) break;
      suggestCache.delete(oldest.value);
    }
  };

  const context = { resolvedCityId, visible, signal, fetchImpl };
  const first = await requestSuggest(text, context);
  if (!first) return null;

  let result = { hotels: first.hotels, brands: first.brands, cityFallback: false };
  const cityNorm = normalizeHotelName(visible);
  const alreadyHasCity = Boolean(cityNorm) && normalizeHotelName(text).includes(cityNorm);
  if (result.hotels.length === 0 && visible && !alreadyHasCity) {
    const retryText = `${text} ${visible}`;
    const second = await requestSuggest(retryText, context);
    if (second && second.hotels.length > 0) {
      // 补词结果通常没有 brand 项：保留首次的品牌信号，lookupHotel 靠它判断「这是品牌词」
      result = { hotels: second.hotels, brands: second.brands.length > 0 ? second.brands : first.brands, cityFallback: true };
      // 补词请求的结果也进缓存（用户下次直接输入「全季 上海」时命中）
      remember(`${cityNorm}|${normalizeHotelName(retryText)}`, result);
    }
  }

  remember(key, result);
  return cloneBundle(result);
}

/**
 * 确认联想选中的 hotelId 仍在 suggest 结果里（Host 用于「带 hotelId 的创建」校验）。
 * 城市不匹配 / id 不在列表 → false。
 */
export async function confirmHotelId({ hotelId, hotelName, keyword, cityName, signal, fetchImpl, cityId } = {}) {
  const text = String(hotelName || keyword || '').trim();
  const wanted = String(hotelId ?? '').trim();
  if (!text || !wanted) return false;
  const hotels = await suggestHotels({ cityName, keyword: text, signal, fetchImpl, cityId });
  return hotels.some((hotel) => String(hotel.id) === wanted);
}

async function fetchListHtml(url, signal, fetchImpl) {
  const request = fetchImpl || fetch;
  const response = await request(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    signal,
  });
  if (!response.ok) throw new Error(`携程酒店列表 HTTP ${response.status}`);
  return response.text();
}

/** 采集一次房型价格快照（契约第 3 节）。 */
export async function collectHotel(monitor, { logger, withPage, signal } = {}) {
  if (typeof withPage !== 'function') throw new Error('collectHotel 需要注入 withPage');
  const params = monitor?.params || {};
  const hotelId = String(params.hotelId ?? '').trim();
  const checkIn = String(params.checkIn ?? '');
  const checkOut = String(params.checkOut ?? '');
  const nights = nightsBetween(checkIn, checkOut) || 1;
  const adults = numberOr(params.adults, 2);
  const rooms = numberOr(params.rooms, 1);
  if (!hotelId) throw hotelError('HOTEL_NOT_FOUND', '缺少携程酒店 id');

  const url = hotelDetailUrl(hotelId, { checkIn, checkOut, adults, rooms });

  return withPage(async (page) => {
    const startedAt = Date.now();
    const waitRoom = page.waitForResponse((response) => ROOM_API_RE.test(response.url()), { timeout: 45000 });
    let response;
    try {
      const navigation = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
      if (navigation && navigation.status() === 404) throw hotelError('HOTEL_NOT_FOUND', `携程酒店 ${hotelId} 不存在或已下架`);
      response = await waitRoom;
    } catch (error) {
      if (error?.code) throw error;
      if (isNavigationError(error)) throw error;
      throw hotelError('HOTEL_BAD_RESPONSE', `打开携程酒店详情页失败：${error?.message || error}`);
    }
    if (LOGIN_HOST_RE.test(page.url())) {
      throw hotelError('HOTEL_LOGIN_REQUIRED', '酒店价格需要携程登录，请先在面板里登录');
    }
    const html = await page.content().catch(() => '');
    if (BLOCK_RE.test(html)) throw hotelError('BLOCKED', '携程返回风控/验证页面');

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw hotelError('HOTEL_BAD_RESPONSE', '携程房型接口返回的不是 JSON');
    }
    // 硬校验：页面实际发出的房型请求日期必须与监控参数一致，否则价格属于别的日期段。
    assertRoomDates(payload?.data?.searchBoxInfo, checkIn, checkOut);
    const snapshot = parseRoomPayload(payload, { hotelId, checkIn, checkOut, nights, adults, rooms });
    // getHotelRoomListInland 的 data.hotelBasicInfo 不含名称/星级/评分/地址（实测只有 isOneRoom* 两个布尔），
    // 所以：名称一律用新建监控时 lookup 写下的携程规范名，其余字段尽力从详情页 DOM 补，读不到就 null。
    const header = await readHotelHeader(page);
    snapshot.hotel = {
      id: String(hotelId),
      name: String(params.hotelName || header.name || snapshot.hotel.name || '').trim() || null,
      star: snapshot.hotel.star ?? header.star ?? null,
      score: snapshot.hotel.score ?? header.score ?? null,
      scoreLabel: snapshot.hotel.scoreLabel ?? header.scoreLabel ?? null,
      address: snapshot.hotel.address || header.address || '',
      district: snapshot.hotel.district ?? null,
      cityName: String(params.cityName || snapshot.hotel.cityName || '').trim() || null,
    };
    logger?.info?.(`酒店 ${hotelId} 房型 ${snapshot.rooms.length} 个，最低整段 ¥${snapshot.lowest.total}，${Date.now() - startedAt}ms`);
    return snapshot;
  });
}

/** /status 健康探针：只验证平台可达，永不 throw。 */
export async function probeHotel({ signal } = {}) {
  const checkedAt = isoNow();
  const startedAt = Date.now();
  try {
    const response = await fetch(`${LIST_BASE}/hotels/list?city=2`, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      signal,
    });
    const ok = response.status >= 200 && response.status < 400;
    if (!ok) return { id: 'hotel', ok: false, ms: Date.now() - startedAt, checkedAt, error: `携程酒店 HTTP ${response.status}` };
    await response.text().catch(() => '');
    return { id: 'hotel', ok: true, ms: Date.now() - startedAt, checkedAt };
  } catch (error) {
    return { id: 'hotel', ok: false, ms: Date.now() - startedAt, checkedAt, error: String(error?.message || error) };
  }
}
