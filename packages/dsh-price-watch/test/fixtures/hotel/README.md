# 酒店 fixtures

2026-11-24 侦察/联调采集的真实响应，已脱敏（删除图片 URL、追踪串、cookie、登录标识、取消罚金明细）。

| 文件 | 来源 | 说明 |
|---|---|---|
| `list-ssr.json` | `GET hotels.ctrip.com/hotels/list?city=2&keyword=全季 虹桥&checkin=2026-12-05&checkout=2026-12-07` 的 `initListData` 片段 | 13 家酒店，只保留 id/name/star/score/address。**keyword 只影响排序，不做过滤**；且结果强依赖 checkIn/checkOut |
| `roomlist-anonymous.json` | `POST m.ctrip.com/restapi/soa2/33278/getHotelRoomListInland`（匿名） | 1565886 / 12-05→12-07：4 物理房型 / 12 售卖房型，`isLogin=false`、`isHidePrice=true`、`displayPrice=""` → 解析器应抛 `HOTEL_LOGIN_REQUIRED` |
| `roomlist-logged-in.json` | 同一接口的**真实登录态响应**（lead 联调抓取，442KB 原始文件瘦身） | `isLogin=true`，12/12 `isHidePrice=false`；`priceInfo.price=299`（每晚均价）、`totalPriceInfo.total.content="¥597.9"`（整段实付含税）、`quantityDays.content="¥650.9"`（优惠前） |

口径：`nightly = Math.round(priceInfo.price)`；`total = parse(totalPriceInfo.total.content)`（缺则退回 `quantityDays.content`，再缺才 `nightly*nights`）。
字段路径与 4030 反爬结论见 `docs/design/price-watch-hotel-recon.md`。
| `suggest.json` | `POST m.ctrip.com/restapi/soa2/30668/search`（纯 HTTP，keyword=全季酒店(上海虹桥中山西路店)） | 真实响应瘦身：1 条 `hotel`（1565886）+ `sight`/`sightplay`/`hotellist` 干扰项，用于测试「只留 type=hotel」过滤与字段映射（`zoneName`→district、`starRating`→star 是「舒适型」这类词） |
| `suggest-brand.json` | 同上（keyword=全季酒店） | 6 条 `hotelbrand`（productId=49 是品牌 id 不是酒店 id）→ 测试品牌词不产生门店候选 |
| `list-brand.html` | 真实列表页 SSR 片段的离线封装（单条 `self.__next_f.push` chunk，含 13 家酒店） | 供 `lookupHotel` 品牌词兜底测试：suggest 只回 `hotelbrand` 时纯 HTTP 抓列表页 → 解析 `initListData` → 取前 5 家门店 |
| `suggest-brand-city.json` | 同上（keyword=全季 上海） | 10 条 `hotel`（上海全季门店，含 427795 人民广场南京路店）+ food/sight 干扰项 → 测试「裸品牌词+城市」补词重试与候选召回 |

