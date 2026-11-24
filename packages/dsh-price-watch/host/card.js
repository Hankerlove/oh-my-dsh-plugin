/**
 * 飞书互动卡片（Card JSON **2.0**）的底层积木，只做「拼 JSON」，不碰网络/磁盘。
 *
 * 为什么单独一个文件：`notify.js` 负责「这次采集该说什么」（行情/监控/失败/测试
 * 四套语义），一个价格主视觉 + 联程对比 + 航班表 + 页脚如果全挤在里面，字段噪音
 * 会盖掉业务逻辑。这里只留可复用的形状，`notify.js` 负责往形状里填内容。
 *
 * 三条硬约束（都来自 spec 与用户口径，改这个文件时别破）：
 *  - **没有按钮 / action**：卡片是报表，不是导航入口；`column_set.action`、
 *    `column.action`、`card_link`、`button` 一律不出现。
 *  - **没有字符画**：走势只走 `renderTrendPng` 的真 PNG（`image()`），没图就整块省略。
 *  - **不写占位符**：拿不到的数字/航班号/机场就整项省略，绝不写 `—`、`N/A`、
 *    `未填写` 之类占位；`money()` 因此返回空串而不是破折号。
 *
 * 颜色语义沿用 `templateFor`：跌绿、涨红、平蓝（中性文案用 grey / grey-900）。
 */

/** 卡片 header 的主题色：跌绿、涨红、平蓝、失败橙、测试蓝。 */
export const TEMPLATE = { down: 'green', up: 'red', flat: 'blue', failure: 'orange', test: 'blue' };

/** 文字颜色 token（飞书颜色枚举，深浅色模式由客户端自己切）。 */
export const INK = {
  up: 'red',
  down: 'green',
  flat: 'blue',
  neutral: 'grey-900',
  muted: 'grey',
  warn: 'orange',
  good: 'green',
};

/** 相邻块之间的分隔线；卡片里所有区块切换都用它，不用空 div 撑间距。 */
const RULE = { tag: 'hr' };

/** 区块分隔线（卡片分块展示：结论 / 走势 / 明细 / 采集信息）。 */
export function rule() {
  return RULE;
}

/** `¥1,234`，拿不到正数时返回空串（调用方据此省略整块，而不是打印破折号）。 */
export function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `¥${Math.round(n).toLocaleString('zh-CN')}` : '';
}

/** 把任意文本压成一行、去掉会破坏 Markdown 表格的竖线。 */
export function inline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}

/** 按字符（而不是 UTF-16 码元）截断，中文/emoji 不会被切坏。 */
function clampChars(value, max) {
  const chars = [...String(value ?? '')];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/**
 * 消息列表里唯一可见的一行（`config.summary.content`）：8–60 字，写「谁 + 结论」。
 * 太短会被客户端当空摘要，太长会在列表里被截断。
 */
export function summaryText(value) {
  const text = inline(value) || '价格监控 · 价格已更新';
  const chars = [...text];
  if (chars.length < 8) return `${text} · 价格监控`;
  return clampChars(text, 60);
}

/**
 * `div` + `lark_md`：卡片里唯一能同时控制颜色和字号的文本形状。
 *
 * 颜色用 `<font color='...'>` 而不是 `text_color`：实测渲染器只对 `plain_text`
 * 认 `text_color`，`lark_md` 上它会被忽略（价格和涨跌就都是黑的）。`<font>` 标签
 * 在 `div > lark_md` 和 `markdown` 里都生效，也能包住 `**加粗**`。
 */
export function divText(content, { color, size, align = 'left' } = {}) {
  const body = String(content ?? '').replace(/[<>]/g, '');
  const text = {
    tag: 'lark_md',
    content: color ? `<font color='${color}'>${body}</font>` : body,
    text_align: align,
  };
  if (size) text.text_size = size;
  return { tag: 'div', text };
}

/** 普通富文本块（表格、多行说明）；不带颜色/字号。 */
export function markdown(content) {
  return { tag: 'markdown', content: String(content ?? ''), text_align: 'left' };
}

/** 走势图元素；`key` 为空时返回 null，调用方据此整块省略。 */
export function image(key, alt, { cornerRadius = '8px' } = {}) {
  const imgKey = String(key || '').trim();
  if (!imgKey) return null;
  return {
    tag: 'img',
    img_key: imgKey,
    alt: { tag: 'plain_text', content: clampChars(alt || '价格走势', 100) },
    mode: 'fit_horizontal',
    preview: false,
    corner_radius: cornerRadius,
  };
}

/** 一个指标的竖排三行：小标签 / 金额 / 可选备注。 */
function metricParts(label, value, { color, size = 'large', note } = {}) {
  const parts = [
    divText(label, { color: INK.muted, size: 'notation' }),
    divText(`**${value}**`, { color, size }),
  ];
  if (note) parts.push(divText(note, { color: INK.muted, size: 'notation' }));
  return parts;
}

/** 等分两列（house rule：内容列一律 `weighted` + `weight: 1`）。 */
function twoColumns(left, right) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '16px',
    columns: [left, right],
  };
}

/**
 * 价格主视觉：左列「标签 + 大号价格」，右列「涨跌幅 + 上次价格」。
 *
 * 两列都从同一行开始排（小标签/涨跌幅在上，金额在下），所以读者一眼看到的是
 * 价格和涨跌这一对，而不是一堆等宽的字段。
 *
 * 一律返回**元素数组**（有涨跌时是一个 `column_set`，没有时是两行文本），
 * 调用方用 `elements.push(...priceHero(...))`——返回裸对象会让 push 出嵌套数组、
 * 卡片 JSON 校验直接失败。
 *
 * @param {{label:string, price:string, priceColor?:string, delta?:string,
 *          deltaColor?:string, previous?:string}} input
 * @returns {Array<object>}
 */
export function priceHero({ label, price, priceColor, delta, deltaColor, previous }) {
  const leftElements = [
    divText(label, { color: INK.muted, size: 'notation' }),
    divText(`**${price}**`, { color: priceColor || INK.neutral, size: 'xxxx-large' }),
  ];
  const rightElements = [];
  if (delta) rightElements.push(divText(`**${delta}**`, { color: deltaColor || INK.muted, size: 'large' }));
  if (previous) rightElements.push(divText(previous, { color: INK.muted, size: 'notation' }));
  // 没有上一轮价格（首次采集 / 上次失败）时右侧整列省掉：不写「暂无对比」
  // 这种占位，价格主视觉独占一行更大更清楚。
  if (rightElements.length === 0) return leftElements;
  const right = { tag: 'column', width: 'weighted', weight: 1, elements: rightElements };
  return [twoColumns({ tag: 'column', width: 'weighted', weight: 1, elements: leftElements }, right)];
}

/**
 * 往返监控的买法对比：联程组合 vs 两段单买。
 *
 * 用户要的是「两个数字同屏 + 谁更便宜 + 省多少」，所以结论必须由这里算出来写进
 * 文案，而不是让读者自己减。赢的一侧金额用绿色，另一侧保持中性。
 *
 * @param {{roundPayable?:number, onewaySum?:number, cheaper?:string, diff?:number,
 *          partial?:boolean, missing?:string[]}|null} scheme
 * @returns {Array<object>} 可 push 进 body 的元素（可能为空数组）
 */
export function schemeCompare(scheme) {
  if (!scheme || typeof scheme !== 'object') return [];
  const roundPayable = money(scheme.roundPayable);
  const onewaySum = money(scheme.onewaySum);
  if (!roundPayable && !onewaySum) return [];

  const elements = [];
  const both = Boolean(roundPayable && onewaySum);
  const cheaper = scheme.cheaper === 'round' || scheme.cheaper === 'oneway' ? scheme.cheaper : null;
  const diff = Number(scheme.diff);
  const roundColor = both && cheaper === 'round' ? INK.good : INK.neutral;
  const onewayColor = both && cheaper === 'oneway' ? INK.good : INK.neutral;
  const roundParts = { color: roundColor, note: '一次下单走完两段' };
  const onewayParts = { color: onewayColor, note: '去程 + 回程分开买' };

  if (both) {
    elements.push(twoColumns(
      { tag: 'column', width: 'weighted', weight: 1, elements: metricParts('联程组合', roundPayable, roundParts) },
      { tag: 'column', width: 'weighted', weight: 1, elements: metricParts('两段单买', onewaySum, onewayParts) },
    ));
  } else if (roundPayable) {
    // 只有一侧有数：不补「未采到」占位，直接单列展示 + 下面的部分数据提示。
    elements.push(...metricParts('联程组合', roundPayable, roundParts));
  } else {
    elements.push(...metricParts('两段单买', onewaySum, onewayParts));
  }

  if (both) {
    if (cheaper === 'round' && Number.isFinite(diff) && diff > 0) {
      elements.push(divText(`联程更便宜，省 ${money(diff)}`, { color: INK.good, size: 'normal' }));
    } else if (cheaper === 'oneway' && Number.isFinite(diff) && diff > 0) {
      elements.push(divText(`两段单买更便宜，省 ${money(diff)}`, { color: INK.good, size: 'normal' }));
    } else {
      elements.push(divText('两种买法价格相同', { color: INK.muted, size: 'normal' }));
    }
  }

  if (scheme.partial === true) {
    const missing = (Array.isArray(scheme.missing) ? scheme.missing : []).filter(Boolean);
    elements.push(divText(missing.length ? `部分数据：缺 ${missing.join('、')}` : '部分数据：仍有组合没跑到实价', {
      color: INK.warn,
      size: 'notation',
    }));
  }
  return elements;
}

/**
 * 航班简写：`东方 MU5332` / `春秋`（航班号缺失时只有航司）/ `07:30→10:10`。
 *
 * 真实快照里「去程」常常没有航班号（`no: ""`），天真的模板会打印出
 * `" MU5332"` 或 `"东方航空 ·  → "` 这种空洞；这里逐级退到航司名、时刻、
 * 机场，保证每一段非空。
 */
export function flightName(flight) {
  const airline = airlineShort(flight?.airline);
  const no = flightNo(flight);
  const name = [airline, no].filter(Boolean).join(' ');
  if (name) return name;
  const airports = airportPair(flight);
  return airports || '';
}

/**
 * 航班号字段有两种写法：航班表里是 `no`，联程腿（`roundTrip.round` /
 * `oneway.out`）里是 `flightNo`。两个都认，否则联程行会丢掉航班号。
 */
export function flightNo(flight) {
  return inline(flight?.no || flight?.flightNo);
}

/** `07:30→10:10`；只有一侧时刻时只打一侧，都没有就是空串。 */
export function flightWindow(flight) {
  const dep = inline(flight?.depTime);
  const arr = inline(flight?.arrTime);
  if (dep && arr) return `${dep}→${arr}`;
  return dep || arr || '';
}

/** `虹桥国际机场T1→宝安国际机场T3`，用于既没有航司也没有航班号的行。 */
function airportPair(flight) {
  const dep = inline(flight?.depAirport);
  const arr = inline(flight?.arrAirport);
  if (dep && arr) return `${dep}→${arr}`;
  return dep || arr || '';
}

/**
 * `东方航空` → `东方`、`南方航空` → `南航`、`中国国航` → `国航`；未知航司去掉
 * 「航空」后缀。这张表与 `host/collect/browser.js` 的 `shortAirline` 保持同一套
 * 简称（面板和卡片必须叫得一样），只是复制一份——采集模块带着 playwright 的一堆
 * 逻辑，卡片构造不该为了一个字符串映射去依赖它。
 */
export function airlineShort(name) {
  const raw = inline(name);
  if (!raw) return '';
  return AIRLINE_SHORT[raw] || raw.replace(/航空$/, '').slice(0, 4) || raw.slice(0, 4);
}

/** 常见航司的二字简称（同 `browser.js` 的 `AIRLINE_SHORT_NAMES`）。 */
const AIRLINE_SHORT = {
  中国国航: '国航',
  中国东航: '东航',
  中国南航: '南航',
  中国联航: '联航',
  东方航空: '东方',
  南方航空: '南航',
  海南航空: '海航',
  厦门航空: '厦航',
  四川航空: '川航',
  深圳航空: '深航',
  山东航空: '山航',
  上海航空: '上航',
  吉祥航空: '吉祥',
  春秋航空: '春秋',
  天津航空: '天津',
  首都航空: '首都',
  成都航空: '成都',
  华夏航空: '华夏',
  长龙航空: '长龙',
  昆明航空: '昆明',
  青岛航空: '青岛',
  西藏航空: '西藏',
  河北航空: '河北',
  奥凯航空: '奥凯',
  东海航空: '东海',
  瑞丽航空: '瑞丽',
  西部航空: '西部',
  祥鹏航空: '祥鹏',
  长安航空: '长安',
  湖南航空: '湖南',
  桂林航空: '桂林',
  龙江航空: '龙江',
};

/**
 * 卡片分块用的「区块标题」：`**价格走势**` + 右侧灰色小字说明（横轴/纵轴口径、
 * 时间范围等）。两块之间由调用方插 `rule()`，标题自身不加分隔线。
 *
 * 为什么不用 markdown 组件：`div > lark_md` 才能同时给出「加粗标题 + 灰色小字」
 * 的混排（markdown 组件的字号/颜色由客户端统一，不能混）。
 */
export function sectionTitle(title, sub) {
  const head = `**${inline(title)}**`;
  const tail = inline(sub) ? `　<font color='grey'>${inline(sub)}</font>` : '';
  return { tag: 'div', text: { tag: 'lark_md', content: `${head}${tail}`, text_align: 'left' } };
}

/** 一行灰色小字：统计结论（区间最低/最高/均价）、补充说明。 */
export function statLine(content) {
  const text = inline(content);
  return text ? divText(text, { color: INK.muted, size: 'notation' }) : null;
}

/**
 * 字段网格：两列等分，每格「小标签 + 值」。
 *
 * 用来做「采集信息」这种成对出现的元数据（采集时间 / 采集频率 / 覆盖范围 /
 * 数据状态）。house rule 要求内容列一律 `weighted` + `weight: 1`，所以不做
 * 1:2 之类的主次分栏；奇数个字段时最后一列独占一行。
 *
 * @param {Array<{label:string, value:string, color?:string}>} pairs
 * @returns {Array<object>}
 */
export function fieldGrid(pairs) {
  const items = (Array.isArray(pairs) ? pairs : [])
    .filter((pair) => pair && inline(pair.label) && inline(pair.value))
    .map((pair) => ({ label: inline(pair.label), value: inline(pair.value), color: pair.color }));
  if (items.length === 0) return [];
  const elements = [];
  for (let index = 0; index < items.length; index += 2) {
    const columns = items.slice(index, index + 2).map((item) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        divText(item.label, { color: INK.muted, size: 'notation' }),
        divText(`**${item.value}**`, { color: item.color || INK.neutral, size: 'normal' }),
      ],
    }));
    elements.push({ tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '16px', columns });
  }
  return elements;
}

/** 表格里的航班简写：`南航 CZ8882 14:00`（逐级省略缺失字段，绝不空着）。 */
export function flightCell(flight) {
  const name = flightName(flight);
  const dep = inline(flight?.depTime);
  if (name && dep) return `${name} ${dep}`;
  return name || dep || '';
}

/** `¥1,234` / 估算时 `≈¥1,234`；没有数字就是空串。 */
function priceCell(payable, fallback) {
  const exact = money(payable);
  if (exact) return exact;
  const estimate = money(fallback);
  return estimate ? `≈${estimate}` : '';
}

/**
 * 联程组合表（往返监控）：去程 / 返程 / 待支付实价，按实价升序。
 *
 * 实价拿不到的降级组合用 `≈` 标注（那是「列表价 + 两段实测税费」的估算），
 * 和卡片页脚的口径说明对得上；连估算价都没有的行直接不出现。
 *
 * @param {Array<object>} combos 快照里的 `roundTrip.combos`
 * @param {{limit?:number}} [options]
 * @returns {object|null} markdown 元素
 */
export function comboTable(combos, { limit = 3 } = {}) {
  const rows = (Array.isArray(combos) ? combos : [])
    .map((combo) => ({
      out: flightCell(combo?.out),
      ret: flightCell(combo?.ret),
      price: priceCell(combo?.payable, combo?.listTotal),
      estimate: !money(combo?.payable),
    }))
    // 组合必须两侧都有航班：缺一侧的行整行省略（本仓库不留「—」「N/A」占位）。
    .filter((row) => row.price && row.out && row.ret)
    .slice(0, limit);
  if (rows.length === 0) return null;
  const lines = [
    '| 去程 | 返程 | 待支付 |',
    '| :--- | :--- | :--- |',
    ...rows.map((row) => `| ${row.out} | ${row.ret} | ${row.price} |`),
  ];
  return markdown(lines.join('\n'));
}

/** `11-25 周二`；日期坏掉时返回空串（调用方据此省略整列）。 */
export function dateCell(dateString) {
  const parts = String(dateString || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return '';
  const day = new Date(parts[0], parts[1] - 1, parts[2]);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day.getDay()] || '';
  return `${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')} ${weekday}`;
}

/**
 * 日历模式的「最低价日期」表：日期（含星期）/ 最低含税价 / 相对均价。
 * `relative` 传均价时算百分比，方便一眼看出便宜的幅度。
 *
 * @param {Array<{date:string,total:number}>} days 已按价格升序
 * @param {{limit?:number, average?:number}} [options]
 * @returns {object|null}
 */
export function dayTable(days, { limit = 4, average } = {}) {
  const avg = Number(average);
  const sorted = (Array.isArray(days) ? days : []).filter((day) => money(day?.total));
  // 同价位只保留最早出现的那一天：连续四天都是 ¥460 时，列四行一样的价格
  // 不如把位置留给「第二便宜的价位是哪天」。
  const seenPrices = new Set();
  const picked = [];
  for (const day of sorted) {
    const price = Math.round(Number(day.total));
    if (seenPrices.has(price)) continue;
    seenPrices.add(price);
    picked.push(day);
    if (picked.length >= limit) break;
  }
  const rows = picked
    .map((day) => {
      const when = dateCell(day.date);
      const price = money(day.total);
      const total = Number(day.total);
      const relative = Number.isFinite(avg) && avg > 0 && Number.isFinite(total)
        ? `${total < avg ? '-' : '+'}${Math.abs(((total - avg) / avg) * 100).toFixed(0)}%`
        : '';
      return { when, price, relative };
    });
  if (rows.length === 0) return null;
  const useRelative = rows.some((row) => row.relative);
  const header = ['日期', '最低含税价', ...(useRelative ? ['相对均价'] : [])];
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => ':---').join(' | ')} |`,
    ...rows.map((row) => `| ${[row.when, row.price, ...(useRelative ? [row.relative] : [])].join(' | ')} |`),
  ];
  return markdown(lines.join('\n'));
}

/**
 * 航班表（Markdown 表格，不用原生 `table`：原生表格只能放在 body 顶层，
 * 而这张表将来可能被挪进分栏/折叠面板里，Markdown 表格在哪都能用）。
 * 所有列显式左对齐，符合仓库的表格规范。
 *
 * @param {Array<object>} flights 已按实价升序
 * @returns {object|null} markdown 元素
 */
export function flightTable(flights) {
  const rows = (Array.isArray(flights) ? flights : []).filter((flight) => money(flight?.taxIncluded));
  if (rows.length === 0) return null;
  // 只有整列都有值时才出这一列：缺航班号的快照宁可少一列，也不留空格子。
  const useName = rows.every((flight) => flightName(flight));
  const useTime = rows.every((flight) => flightWindow(flight));
  const useSeats = rows.every((flight) => seatCell(flight));
  const header = [
    ...(useName ? ['航班'] : []),
    ...(useTime ? ['时间'] : []),
    ...(useSeats ? ['余票'] : []),
    '实价',
  ];
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => ':---').join(' | ')} |`,
  ];
  for (const flight of rows) {
    const cells = [
      ...(useName ? [flightName(flight)] : []),
      ...(useTime ? [flightWindow(flight)] : []),
      ...(useSeats ? [seatCell(flight)] : []),
      money(flight.taxIncluded),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return markdown(lines.join('\n'));
}

/** 余票列：`剩 3 张` / `售罄`；快照没给余票时返回空串（整列就不出现）。 */
function seatCell(flight) {
  if (flight?.soldOut === true) return '售罄';
  const seats = Number(flight?.seats);
  return Number.isInteger(seats) && seats > 0 ? `剩 ${seats} 张` : '';
}

/**
 * 整张卡片的骨架：schema 2.0 + 主题色 header（可带模式标签）+ 摘要 + body。
 *
 * @param {{template?:string, title:string, summary:string, tags?:Array<{text:string,color?:string}>,
 *          elements:Array<object|null|undefined>}} input
 */
export function cardShell({ template, title, summary, tags, elements }) {
  const header = {
    template: template || TEMPLATE.flat,
    title: { tag: 'plain_text', content: clampChars(inline(title) || '价格监控', 100) },
  };
  const tagList = (Array.isArray(tags) ? tags : [])
    .filter((tag) => tag && inline(tag.text))
    .slice(0, 3)
    .map((tag) => ({
      tag: 'text_tag',
      color: tag.color || 'blue',
      text: { tag: 'plain_text', content: clampChars(inline(tag.text), 20) },
    }));
  if (tagList.length > 0) header.text_tag_list = tagList;

  return {
    schema: '2.0',
    config: {
      compact_width: false,
      width_mode: 'fill',
      summary: { content: summaryText(summary) },
    },
    header,
    // flat(2)：某个 builder 不小心把数组 push 进来时也不产出非法嵌套结构
    // （元素本身最多两层：column_set > columns，所以 2 足够且不会破坏结构）。
    body: { elements: (Array.isArray(elements) ? elements : []).flat(2).filter(Boolean) },
  };
}

export const __internals = { clampChars, twoColumns, airportPair };
