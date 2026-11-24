/**
 * 走势图渲染：零依赖的**纯 JS 矢量**光栅器。
 *
 * 为什么不是「套一个图表库 / 起个无头浏览器画 SVG」：
 *  - 飞书卡片只认 PNG 字节（`img_key`），HTML/SVG 只是描述，必须有东西把它光栅化；
 *  - 起浏览器要多养一个 300–800ms 的进程和 720MB 内存，还会把「有没有装 Chrome」
 *    变成卡片能不能出图的隐式依赖；
 *  - 引 native 依赖（canvas/sharp）又违反「装饰性插件不拖原生物件」的定位。
 *
 * 所以：字形轮廓内嵌成数据（Inter，OFL，见 `chart-font.js`），在 JS 里自己做
 * 二次贝塞尔展开 + 非零环绕扫描线填充 + 超采样抗锯齿。输出 2×（1280×640），
 * 单张 20–70ms，天然可测。
 *
 * 视觉规则（用户 2026-11-23 拍板）：
 *  - 白底、无外框、只留极淡的横向网格，最高一条刻度带 `¥`；
 *  - 中性蓝折线 + 同色纵向渐变面积；monotone cubic 平滑（绝不过冲，不会画出
 *    数据里不存在的高低点）；
 *  - 最低点绿、最高点红，各带一枚数值标注（白底 halo，自动避让边界）；
 *  - **不画当前值胶囊**（飞书卡图是静态 PNG，没有 hover/滑动，只有末尾一个胶囊
 *    没有意义），当前值由卡片「结论区」的大号数字承担；
 *  - **不画均价虚线**；
 *  - 平坦序列（价格一直不变）单独处理：线放绘图区垂直中点、不填面积、不标极值。
 */
import { deflateSync } from 'node:zlib';

import { GLYPHS, UPEM } from './chart-font.js';

/** 超采样倍数：输出像素再放大 SS 倍绘制，降采样后得到抗锯齿边缘。 */
const SS = 2;
/** 设计分辨率：所有视觉常量都按这个尺寸写，实际尺寸按比例缩放。 */
const DESIGN_W = 1280;
const DESIGN_H = 640;

// #region PNG 编码
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode an RGB pixel buffer (width*height*3) as PNG bytes. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// #endregion

// #region 颜色与画布
function parseColor(value, fallback) {
  const text = String(value || '').trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  return fallback;
}

function createCanvas(width, height, background) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = background[0];
    pixels[i * 3 + 1] = background[1];
    pixels[i * 3 + 2] = background[2];
  }
  const set = (x, y, colour) => {
    const px = x | 0;
    const py = y | 0;
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 3;
    pixels[offset] = colour[0];
    pixels[offset + 1] = colour[1];
    pixels[offset + 2] = colour[2];
  };
  const blend = (x, y, colour, alpha) => {
    const px = x | 0;
    const py = y | 0;
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 3;
    pixels[offset] = Math.round(pixels[offset] * (1 - alpha) + colour[0] * alpha);
    pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - alpha) + colour[1] * alpha);
    pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - alpha) + colour[2] * alpha);
  };
  /** 非零环绕规则填充多边形组（字形、圆角矩形都走这里）。 */
  const fillPolygons = (polygons, colour) => {
    const edges = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const poly of polygons) {
      if (!poly || poly.length < 2) continue;
      for (let i = 0; i < poly.length; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (a.y === b.y) continue;
        edges.push(a.y < b.y
          ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: 1 }
          : { x0: b.x, y0: b.y, x1: a.x, y1: a.y, dir: -1 });
        if (a.y < minY) minY = a.y;
        if (a.y > maxY) maxY = a.y;
        if (b.y < minY) minY = b.y;
        if (b.y > maxY) maxY = b.y;
      }
    }
    if (edges.length === 0) return;
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(height - 1, Math.ceil(maxY));
    for (let y = yStart; y <= yEnd; y += 1) {
      const sampleY = y + 0.5;
      const hits = [];
      for (const edge of edges) {
        if (sampleY < edge.y0 || sampleY >= edge.y1) continue;
        hits.push({
          x: edge.x0 + ((sampleY - edge.y0) / (edge.y1 - edge.y0)) * (edge.x1 - edge.x0),
          dir: edge.dir,
        });
      }
      if (hits.length < 2) continue;
      hits.sort((left, right) => left.x - right.x);
      let winding = 0;
      for (let i = 0; i < hits.length - 1; i += 1) {
        winding += hits[i].dir;
        if (winding === 0) continue;
        const from = Math.max(0, Math.round(hits[i].x));
        const to = Math.min(width - 1, Math.round(hits[i + 1].x));
        for (let x = from; x <= to; x += 1) set(x, y, colour);
      }
    }
  };
  const rect = (x, y, w, h, colour, alpha = 1) => {
    for (let py = Math.round(y); py < Math.round(y + h); py += 1) {
      for (let px = Math.round(x); px < Math.round(x + w); px += 1) {
        if (alpha >= 1) set(px, py, colour);
        else blend(px, py, colour, alpha);
      }
    }
  };
  const hline = (x0, x1, y, colour, thickness = 1, alpha = 1) => {
    const rows = Math.max(1, Math.round(thickness));
    for (let offset = 0; offset < rows; offset += 1) {
      for (let x = Math.round(x0); x <= Math.round(x1); x += 1) {
        if (alpha >= 1) set(x, y + offset, colour);
        else blend(x, y + offset, colour, alpha);
      }
    }
  };
  const dot = (cx, cy, radius, colour, alpha = 1) => {
    const limit = Math.ceil(radius);
    for (let oy = -limit; oy <= limit; oy += 1) {
      for (let ox = -limit; ox <= limit; ox += 1) {
        if (ox * ox + oy * oy > radius * radius) continue;
        if (alpha >= 1) set(cx + ox, cy + oy, colour);
        else blend(cx + ox, cy + oy, colour, alpha);
      }
    }
  };
  /** 粗线：沿线段逐点 stamp 圆点，端点自然是圆的（round cap/join）。 */
  const stroke = (x0, y0, x1, y1, colour, thickness) => {
    const steps = Math.max(1, Math.round(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    const radius = thickness / 2;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, colour);
    }
  };
  return { width, height, pixels, set, blend, fillPolygons, rect, hline, dot, stroke };
}

/** Box-filter a supersampled canvas down to the requested size. */
function downsample(canvas, factor) {
  const width = Math.floor(canvas.width / factor);
  const height = Math.floor(canvas.height / factor);
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let oy = 0; oy < factor; oy += 1) {
        for (let ox = 0; ox < factor; ox += 1) {
          const offset = ((y * factor + oy) * canvas.width + (x * factor + ox)) * 3;
          r += canvas.pixels[offset];
          g += canvas.pixels[offset + 1];
          b += canvas.pixels[offset + 2];
        }
      }
      const count = factor * factor;
      const offset = (y * width + x) * 3;
      out[offset] = Math.round(r / count);
      out[offset + 1] = Math.round(g / count);
      out[offset + 2] = Math.round(b / count);
    }
  }
  return { width, height, pixels: out };
}
// #endregion

// #region 矢量文字
/**
 * TrueType 轮廓 → 折线。
 *
 * 二次曲线的控制点混在轮廓点里（`onCurve=false`），两个相邻控制点之间有一个
 * 隐式 on-curve 中点，必须先补出来再展开，否则字形会缺角。
 */
function contourToPolyline(points, originX, originY, scale) {
  const count = points.length;
  if (count === 0) return [];
  const mapped = points.map(([x, y, on]) => ({ x: originX + x * scale, y: originY - y * scale, on: on === 1 }));
  let start;
  let index = 0;
  if (!mapped[0].on) {
    const last = mapped[count - 1];
    start = last.on
      ? { x: last.x, y: last.y }
      : { x: (last.x + mapped[0].x) / 2, y: (last.y + mapped[0].y) / 2 };
  } else {
    start = { x: mapped[0].x, y: mapped[0].y };
    index = 1;
  }
  const out = [start];
  let current = start;
  let i = index;
  while (i < count) {
    const point = mapped[i];
    if (point.on) {
      out.push({ x: point.x, y: point.y });
      current = point;
      i += 1;
      continue;
    }
    const next = mapped[(i + 1) % count];
    const end = next.on ? next : { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
    for (let step = 1; step <= 8; step += 1) {
      const t = step / 8;
      const mt = 1 - t;
      out.push({
        x: mt * mt * current.x + 2 * mt * t * point.x + t * t * end.x,
        y: mt * mt * current.y + 2 * mt * t * point.y + t * t * end.y,
      });
    }
    current = end;
    i += 1;
  }
  return out;
}

/** 文本宽度（px）。字体里没有的字符按空格宽度算，不抛错。 */
export function textWidth(value, sizePx) {
  const scale = Number(sizePx) / UPEM;
  let total = 0;
  for (const char of String(value ?? '')) {
    const glyph = GLYPHS[char] || GLYPHS[' '];
    total += (glyph ? glyph[0] : UPEM / 2) * scale;
  }
  return total;
}

/**
 * 在 canvas 上画一行文本（左上角为 `(x, baselineY)` 的基线位置）。
 * 字形轮廓直接填充，配合超采样得到灰阶抗锯齿的数字 —— 这是这套渲染器
 * 能看起来"不像点阵"的关键。
 */
export function drawText(canvas, value, x, baselineY, sizePx, colour) {
  const scale = Number(sizePx) / UPEM;
  let cursor = Number(x) || 0;
  for (const char of String(value ?? '')) {
    const glyph = GLYPHS[char];
    const advance = (glyph ? glyph[0] : (GLYPHS[' ']?.[0] ?? UPEM / 2)) * scale;
    if (glyph && glyph.length > 1) {
      const polygons = glyph.slice(1).map((contour) => contourToPolyline(contour, cursor, Number(baselineY) || 0, scale));
      canvas.fillPolygons(polygons, colour);
    }
    cursor += advance;
  }
  return cursor - (Number(x) || 0);
}
// #endregion

// #region 几何
/** monotone cubic（Fritsch–Carlson）：平滑但**不过冲**。 */
export function monotonePath(values, steps = 10) {
  const count = values.length;
  if (count < 2) return values.map((value, index) => ({ index, value }));
  const delta = [];
  for (let i = 0; i < count - 1; i += 1) delta.push(values[i + 1] - values[i]);
  const tangent = new Array(count).fill(0);
  tangent[0] = delta[0];
  tangent[count - 1] = delta[count - 2];
  for (let i = 1; i < count - 1; i += 1) {
    tangent[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  for (let i = 0; i < count - 1; i += 1) {
    if (delta[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / delta[i];
    const b = tangent[i + 1] / delta[i];
    const sum = a * a + b * b;
    if (sum > 9) {
      const factor = 3 / Math.sqrt(sum);
      tangent[i] = factor * a * delta[i];
      tangent[i + 1] = factor * b * delta[i];
    }
  }
  const out = [];
  for (let i = 0; i < count - 1; i += 1) {
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        index: i + t,
        value: (2 * t3 - 3 * t2 + 1) * values[i]
          + (t3 - 2 * t2 + t) * tangent[i]
          + (-2 * t3 + 3 * t2) * values[i + 1]
          + (t3 - t2) * tangent[i + 1],
      });
    }
  }
  out.push({ index: count - 1, value: values[count - 1] });
  return out;
}

/**
 * 取一个"整"的刻度步长（1/2/2.5/5 × 10^k 的整数倍）。
 * 价格都是整数，所以最后取整 —— 否则会出现"几何位置在 617.5、标签写 618"的错位。
 */
export function niceStep(span, target = 4) {
  const safeSpan = Math.max(1, Number(span) || 0);
  const baseExponent = Math.floor(Math.log10(safeSpan / Math.max(1, target)));
  const candidates = new Set();
  // 只在 1/2/2.5/5 × 10^k 里挑，并且**只保留整数步长**：价格都是整数，
  // 非整数步长会让"刻度线的几何位置"和"标签写的数字"对不上。
  for (let exponent = baseExponent - 1; exponent <= baseExponent + 1; exponent += 1) {
    for (const multiplier of [1, 2, 2.5, 5]) {
      const step = multiplier * 10 ** exponent;
      if (!Number.isInteger(step) || step < 1) continue;
      candidates.add(step);
    }
  }
  let best = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const step of candidates) {
    const count = Math.ceil(safeSpan / step) + 1; // 大致会有几条刻度
    const score = Math.abs(count - target);
    if (score < bestScore || (score === bestScore && step < best)) {
      best = step;
      bestScore = score;
    }
  }
  return Math.max(1, best);
}

/** 整数刻度序列（含首尾），并把标签文字一起返回。 */
export function tickSeries(min, max, target = 4) {
  const pad = Math.max(1, Math.round((max - min) * 0.12));
  const low = min - pad;
  const high = max + pad;
  const step = niceStep(high - low, target);
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks = [];
  for (let value = start; value <= end + 1e-6; value += step) ticks.push(Math.round(value));
  return { ticks, step };
}

/** `1,234`（字体里有 `,`，所以直接手写千分位而不依赖 toLocaleString）。 */
export function groupDigits(value) {
  const text = String(Math.round(Number(value) || 0));
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}
// #endregion

/** 默认配色（用户 2026-11-23 拍板：中性蓝折线，红绿只留给极值语义）。 */
const PALETTE = {
  background: [255, 255, 255],
  grid: [233, 237, 243],
  axis: [221, 227, 236],
  label: [138, 148, 166],
  line: [47, 107, 255],
  fill: [47, 107, 255],
  low: [14, 159, 110],
  high: [224, 36, 36],
  halo: [255, 255, 255],
};

/**
 * 画一张价格走势图。
 *
 * @param {number[]} values  从旧到新，至少 2 个有限值；更少时返回空白占位图
 * @param {object} [options]
 * @param {string[]} [options.labels]  与 values 等长的 X 轴刻度文字（`11-23` / `17:40`）
 * @param {number}  [options.width]    输出像素宽，默认 1280（设计基准 1280，按比例缩放）
 * @param {number}  [options.height]   输出像素高，默认 640
 * @param {string}  [options.background] / grid / line / fill / lowlight / highlight
 * @returns {Buffer} PNG bytes
 */
export function renderTrendPng(values, options = {}) {
  const width = Math.max(320, Math.min(2560, Math.round(Number(options.width) || DESIGN_W)));
  const height = Math.max(160, Math.min(1280, Math.round(Number(options.height) || DESIGN_H)));
  const unit = width / DESIGN_W; // 设计单位 → 输出像素
  const background = parseColor(options.background, PALETTE.background);
  const gridColour = parseColor(options.grid, PALETTE.grid);
  const axisColour = parseColor(options.axis, PALETTE.axis);
  const labelColour = parseColor(options.label, PALETTE.label);
  const lineColour = parseColor(options.line, PALETTE.line);
  const fillColour = parseColor(options.fill, PALETTE.fill);
  const lowColour = parseColor(options.lowlight, PALETTE.low);
  const highColour = parseColor(options.highlight, PALETTE.high);
  const haloColour = background;

  const rawValues = Array.isArray(values) ? values : [];
  const rawLabels = Array.isArray(options.labels) ? options.labels : [];
  const numbers = [];
  const labels = [];
  rawValues.forEach((value, index) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    numbers.push(number);
    labels.push(rawLabels[index] === undefined || rawLabels[index] === null ? '' : String(rawLabels[index]));
  });
  if (numbers.length < 2) return renderBlankPng({ width, height, background, grid: gridColour });

  const canvas = createCanvas(width * SS, height * SS, background);
  const dev = (value) => value * SS;

  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const flat = Math.round(min) === Math.round(max);
  const { ticks } = flat
    ? { ticks: [Math.round(min) - 1, Math.round(min), Math.round(min) + 1] }
    : tickSeries(min, max, 4);
  const tickLow = ticks[0];
  const tickHigh = ticks[ticks.length - 1];

  const fontSize = { axis: 18 * unit, extreme: 19 * unit, month: 17 * unit };
  const tickTexts = ticks.map((value, index) => {
    const body = groupDigits(value);
    // 只有最高刻度带 `¥`：既点明币种，又不让每个标签都占一位宽度
    return index === ticks.length - 1 ? `¥${body}` : body;
  });
  const yTextWidth = Math.max(...tickTexts.map((text) => textWidth(text, fontSize.axis)));

  const padding = {
    top: 34 * unit,
    right: 26 * unit,
    bottom: 62 * unit,
    left: yTextWidth + 34 * unit,
  };
  const plot = {
    x: padding.left,
    y: padding.top,
    w: Math.max(1, width - padding.left - padding.right),
    h: Math.max(1, height - padding.top - padding.bottom),
  };
  const span = Math.max(1e-6, tickHigh - tickLow);
  const toY = (value) => plot.y + plot.h - ((value - tickLow) / span) * plot.h;
  // 末点稍稍内缩，避免和右边缘/标注打架
  const toX = (index) => plot.x + (index / Math.max(1, numbers.length - 1)) * plot.w;

  // ── 横向网格（不画外框、不画纵网格）
  for (let i = 0; i < ticks.length; i += 1) {
    const y = toY(ticks[i]);
    const isEdge = i === 0 || i === ticks.length - 1;
    canvas.hline(dev(plot.x), dev(plot.x + plot.w), Math.round(dev(y)), gridColour, dev(1), isEdge ? 0.55 : 1);
  }
  // 底线
  canvas.hline(dev(plot.x), dev(plot.x + plot.w), Math.round(dev(plot.y + plot.h)), axisColour, dev(1.5), 1);

  // ── Y 轴刻度文字（右对齐、垂直居中于刻度线）
  for (let i = 0; i < ticks.length; i += 1) {
    const text = tickTexts[i];
    const textWidthValue = textWidth(text, fontSize.axis);
    drawText(
      canvas,
      text,
      dev(plot.x - 12 * unit) - dev(textWidthValue),
      dev(toY(ticks[i]) + fontSize.axis * 0.35),
      dev(fontSize.axis),
      labelColour,
    );
  }

  const curve = (numbers.length < 4 ? numbers.map((value, index) => ({ index, value })) : monotonePath(numbers))
    .map((point) => ({ x: toX(point.index), y: toY(point.value) }));

  // ── 面积：按列从曲线填到底线，alpha 自上而下 0.22 → 0
  if (!flat) {
    for (let i = 0; i < curve.length - 1; i += 1) {
      const from = curve[i];
      const to = curve[i + 1];
      const steps = Math.max(1, Math.round(Math.abs(to.x - from.x) * SS));
      for (let step = 0; step < steps; step += 1) {
        const t = step / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        const bottom = plot.y + plot.h;
        for (let py = y; py < bottom; py += 1) {
          const ratio = (py - plot.y) / plot.h;
          const alpha = 0.22 * (1 - ratio);
          if (alpha < 0.005) continue;
          canvas.blend(dev(x), dev(py), fillColour, alpha);
        }
      }
    }
  }

  // ── 折线
  for (let i = 0; i < curve.length - 1; i += 1) {
    canvas.stroke(dev(curve[i].x), dev(curve[i].y), dev(curve[i + 1].x), dev(curve[i + 1].y), lineColour, dev(2.4));
  }

  /** 白底 halo 的小号金额标注，会自动翻到点上方/下方并夹在绘图区内。 */
  const extremeLabel = (text, cx, cy, above, colour) => {
    const boxW = textWidth(text, fontSize.extreme) + 12 * unit;
    const boxH = 24 * unit;
    let x = cx - boxW / 2;
    let y = above ? cy - boxH - 10 * unit : cy + 10 * unit;
    x = Math.min(Math.max(x, plot.x), plot.x + plot.w - boxW);
    y = Math.min(Math.max(y, plot.y), plot.y + plot.h - boxH);
    canvas.rect(dev(x), dev(y), dev(boxW), dev(boxH), haloColour, 1);
    drawText(canvas, text, dev(x + 6 * unit), dev(y + boxH * 0.72), dev(fontSize.extreme), colour);
  };

  // ── 极值：绿点/红点 + 金额；平坦序列没有"极值"可言，整块省略
  if (!flat) {
    const lowIndex = numbers.indexOf(min);
    const highIndex = numbers.indexOf(max);
    const lowX = toX(lowIndex);
    const lowY = toY(min);
    const highX = toX(highIndex);
    const highY = toY(max);
    canvas.dot(dev(lowX), dev(lowY), dev(7), haloColour);
    canvas.dot(dev(lowX), dev(lowY), dev(4.6), lowColour);
    canvas.dot(dev(highX), dev(highY), dev(7), haloColour);
    canvas.dot(dev(highX), dev(highY), dev(4.6), highColour);
    extremeLabel(`¥${groupDigits(min)}`, lowX, lowY, false, lowColour);
    extremeLabel(`¥${groupDigits(max)}`, highX, highY, true, highColour);
  }

  // ── 末点：画一个实心点 + 白圈收边（不再有数值胶囊，当前值由卡片大号数字承担）
  const lastX = toX(numbers.length - 1);
  const lastY = toY(numbers[numbers.length - 1]);
  canvas.dot(dev(lastX), dev(lastY), dev(9), haloColour);
  canvas.dot(dev(lastX), dev(lastY), dev(5.6), lineColour);

  // ── X 轴刻度：去重、首左末右、最多 5 个
  const target = numbers.length >= 20 ? 5 : numbers.length >= 10 ? 4 : Math.min(numbers.length, 3);
  const indices = [];
  for (let i = 0; i < target; i += 1) {
    const index = Math.round((i * (numbers.length - 1)) / Math.max(1, target - 1));
    if (indices[indices.length - 1] !== index) indices.push(index);
  }
  // 同一天多次采集时标签会重复（`11-20 11-20`），这里按文字去重，保留最后出现的位置
  const seen = new Set();
  for (let i = indices.length - 1; i >= 0; i -= 1) {
    const text = labels[indices[i]] || '';
    if (!text) {
      indices.splice(i, 1);
      continue;
    }
    if (seen.has(text)) indices.splice(i, 1);
    else seen.add(text);
  }
  for (const index of indices) {
    const text = labels[index] || '';
    const textWidthValue = textWidth(text, fontSize.month);
    let x = toX(index) - textWidthValue / 2;
    if (index === 0) x = plot.x; // 首个左对齐
    if (index === numbers.length - 1) x = plot.x + plot.w - textWidthValue; // 末个右对齐
    x = Math.min(Math.max(x, plot.x), Math.max(plot.x, width - textWidthValue - 4 * unit));
    drawText(canvas, text, dev(x), dev(plot.y + plot.h + 30 * unit), dev(fontSize.month), labelColour);
  }

  const small = downsample(canvas, SS);
  return encodePng(small.width, small.height, small.pixels);
}

/** Placeholder used when there is not enough data to draw a trend. */
export function renderBlankPng({ width = DESIGN_W, height = DESIGN_H, background, grid } = {}) {
  const outW = Math.max(160, Math.min(2560, Math.round(Number(width) || DESIGN_W)));
  const outH = Math.max(120, Math.min(1280, Math.round(Number(height) || DESIGN_H)));
  const bg = Array.isArray(background) ? background : PALETTE.background;
  const gridColour = Array.isArray(grid) ? grid : PALETTE.grid;
  const canvas = createCanvas(outW, outH, bg);
  const unit = outW / DESIGN_W;
  for (let i = 1; i <= 4; i += 1) {
    canvas.hline(0, outW - 1, Math.round((outH / 5) * i), gridColour, Math.max(1, Math.round(unit)), 0.5);
  }
  return encodePng(canvas.width, canvas.height, canvas.pixels);
}

export const __internals = {
  crc32,
  encodePng,
  createCanvas,
  downsample,
  contourToPolyline,
  measureText: textWidth,
  GLYPHS,
  UPEM,
};
