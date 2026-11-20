/**
 * Minimal PNG chart renderer for Feishu cards.
 *
 * Why hand-rolled: a Feishu card image has to be uploaded as an `image_key`, so
 * the Host must produce real PNG bytes. Pulling in canvas/sharp would add a
 * native dependency to a decorative plugin, and this only ever needs a plain
 * trend line — so the encoder below writes the four PNG chunks itself and leans
 * on `node:zlib` for compression.
 *
 * 文字也是手写的：环境里没有 canvas/sharp，所以内置一套 5×7 点阵字形（数字、
 * `¥`、`,`、`-`、`.`、`:`、空格），在 2× 超采样空间里用 scale=4 画，缩下来就是
 * 10×14 的清晰字。坐标轴、网格、均价虚线和最高/最低点金额都在这里画。
 *
 * 卡片口径：每个采集点一个小圆点，**最低点绿、最高点红**（跌绿涨红），所以读者
 * 不用读数字就能看出这轮价格是创了新低还是新高。颜色都是 `options` 可覆盖的，
 * 旧的 `renderTrendPng(values)` 调用不用改。
 *
 * Rendering is supersampled (2×) and box-filtered down, which is the cheapest
 * way to get lines that do not look like stairs at 640px wide.
 */
import { deflateSync } from 'node:zlib';

const SS = 2; // supersampling factor

// #region PNG encoding
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
    rgb.copy ? rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride) : raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// #endregion

// #region colour + canvas
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
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 3;
    pixels[offset] = colour[0];
    pixels[offset + 1] = colour[1];
    pixels[offset + 2] = colour[2];
  };
  const blend = (x, y, colour, alpha) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 3;
    pixels[offset] = Math.round(pixels[offset] * (1 - alpha) + colour[0] * alpha);
    pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - alpha) + colour[1] * alpha);
    pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - alpha) + colour[2] * alpha);
  };
  const line = (x0, y0, x1, y1, colour, thickness = 1, alpha = 1) => {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let error = dx - dy;
    for (;;) {
      if (thickness <= 1) {
        if (alpha >= 1) set(ax, ay, colour);
        else blend(ax, ay, colour, alpha);
      } else {
        const r = Math.floor(thickness / 2);
        for (let oy = -r; oy <= r; oy += 1) {
          for (let ox = -r; ox <= r; ox += 1) {
            if (alpha >= 1) set(ax + ox, ay + oy, colour);
            else blend(ax + ox, ay + oy, colour, alpha);
          }
        }
      }
      if (ax === bx && ay === by) break;
      const e2 = error * 2;
      if (e2 > -dy) {
        error -= dy;
        ax += sx;
      }
      if (e2 < dx) {
        error += dx;
        ay += sy;
      }
    }
  };
  return { width, height, pixels, set, blend, line };
}

/** Filled axis-aligned rectangle (device px). */
function fillRect(canvas, x, y, width, height, colour) {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const x1 = Math.round(x + width);
  const y1 = Math.round(y + height);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) canvas.set(px, py, colour);
  }
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

// #region bitmap font
/**
 * 5×7 点阵字形。每个字形 7 行、每行 5 个字符，`'1'` 为实心。
 * 只收录卡片坐标轴/金额标注会用到的字符；未知字符按空格处理（仍占一位宽）。
 */
const FONT_ROWS = {
  '0': '01110/10001/10011/10101/11001/10001/01110',
  '1': '00100/01100/00100/00100/00100/00100/01110',
  '2': '01110/10001/00001/00110/01000/10000/11111',
  '3': '01110/10001/00001/00110/00001/10001/01110',
  '4': '00010/00110/01010/10010/11111/00010/00010',
  '5': '11111/10000/11110/00001/00001/10001/01110',
  '6': '00110/01000/10000/11110/10001/10001/01110',
  '7': '11111/00001/00010/00100/01000/01000/01000',
  '8': '01110/10001/10001/01110/10001/10001/01110',
  '9': '01110/10001/10001/01111/00001/00010/01100',
  '¥': '10101/10101/01110/11111/00100/11111/00100',
  ',': '00000/00000/00000/00000/00110/00100/01000',
  '-': '00000/00000/00000/11111/00000/00000/00000',
  '.': '00000/00000/00000/00000/00000/01100/01100',
  ':': '00000/01100/01100/00000/01100/01100/00000',
  ' ': '00000/00000/00000/00000/00000/00000/00000',
};

const FONT = Object.fromEntries(Object.entries(FONT_ROWS).map(([char, rows]) => [char, rows.split('/')]));
const FONT_WIDTH = 5;
const FONT_HEIGHT = 7;
const FONT_GAP = 1; // one blank dot column between glyphs
const FONT_SCALE = 4; // device px per font dot → 10×14 css px after downsampling
const FONT_ADVANCE = (FONT_WIDTH + FONT_GAP) * FONT_SCALE;

/** Width of `text` in device px (trailing inter-glyph gap excluded). */
function measureText(text, scale = FONT_SCALE) {
  const chars = String(text || '').length;
  if (!chars) return 0;
  return chars * (FONT_WIDTH + FONT_GAP) * scale - FONT_GAP * scale;
}

/**
 * Draw `text` with its top-left corner at device `(x, y)`.
 * The origin is snapped to the supersample grid so every glyph dot lands on a
 * whole final pixel and the text stays crisp after downsampling.
 */
function drawText(canvas, text, x, y, colour, scale = FONT_SCALE) {
  const originX = Math.round(x / SS) * SS;
  const originY = Math.round(y / SS) * SS;
  let cursor = originX;
  for (const char of String(text || '')) {
    const glyph = FONT[char] || FONT[' '];
    for (let row = 0; row < FONT_HEIGHT; row += 1) {
      const bits = glyph[row] || '00000';
      for (let col = 0; col < FONT_WIDTH; col += 1) {
        if (bits[col] !== '1') continue;
        const px = cursor + col * scale;
        const py = originY + row * scale;
        for (let oy = 0; oy < scale; oy += 1) {
          for (let ox = 0; ox < scale; ox += 1) canvas.set(px + ox, py + oy, colour);
        }
      }
    }
    cursor += FONT_ADVANCE;
  }
  return cursor - FONT_GAP * scale - originX;
}

/** `1080` → `1,080`; `-3.5` → `-3.5`. */
function formatNumber(value, decimals = 0) {
  const safeDecimals = Math.max(0, Math.min(4, decimals));
  const rounded = Number(value).toFixed(safeDecimals);
  const negative = rounded.startsWith('-');
  const [integerPart, decimalPart] = (negative ? rounded.slice(1) : rounded).split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${decimalPart ? `.${decimalPart}` : ''}`;
}

/**
 * Candidate tick steps. `1/2/2.5/5/10` is the classic "nice" set; `1.5/3/4/6/8`
 * are admitted with a small penalty because price ranges are often awkward
 * (e.g. ¥450–¥802) and forcing a purely classic step there wastes half the
 * canvas. Readability beats dogmatic niceness.
 */
const NICE_MULTIPLES = [
  [1, 0],
  [1.5, 0.05],
  [2, 0.02],
  [2.5, 0.06],
  [3, 0.12],
  [4, 0.25],
  [5, 0.04],
  [6, 0.3],
  [8, 0.35],
  [10, 0],
];

/** Nearest classic nice step (1/2/2.5/5/10 × 10^k) — used for flat series. */
function niceRound(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / base;
  let best = 1;
  let bestDiff = Infinity;
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    const diff = Math.abs(Math.log(fraction / multiple));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = multiple;
    }
  }
  return best * base;
}

function candidateSteps(ideal) {
  const out = [];
  const seen = new Set();
  const centre = Math.floor(Math.log10(ideal));
  for (let exponent = centre - 2; exponent <= centre + 1; exponent += 1) {
    const base = 10 ** exponent;
    for (const [multiple, penalty] of NICE_MULTIPLES) {
      const step = multiple * base;
      if (step < ideal / 20 || step > ideal * 1.5) continue;
      const key = step.toPrecision(12);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ step, penalty });
    }
  }
  return out.sort((a, b) => a.step - b.step);
}

/**
 * 5-tick axis range covering the data. Ideally the data keeps 12% (at least ¥6)
 * padding on both sides and the range is widened outward to whole tick steps.
 * When that would leave a lot of empty canvas, a tighter range (less padding,
 * but still no clipping) wins — hence the score instead of "first fit".
 */
function niceRange(min, max) {
  const span = max - min;
  if (span < 1e-9) {
    // Flat series: no span to pad, so centre a round range on the value.
    const magnitude = Math.max(Math.abs(max), 1);
    const step = Math.max(1, niceRound(Math.max(6, magnitude * 0.01)));
    const low = Math.floor((max - step * 2) / step) * step;
    return { low, high: low + step * 4, step };
  }

  const pad = Math.max(6, span * 0.12);
  const ideal = span + pad * 2;
  let best = null;
  for (const { step, penalty } of candidateSteps(ideal)) {
    const range = step * 4;
    // low + range must cover max, low must stay at/under min.
    const minLow = Math.ceil((max - range) / step - 1e-9) * step;
    const maxLow = Math.floor(min / step + 1e-9) * step;
    if (minLow > maxLow + 1e-9) continue;
    // 在能盖住数据的区间里挑一个让上下余量尽量对称的起点，而不是一味贴着
    // 下边界（那样近水平的序列会整条浮在画布上半部）。
    const balancedLow = min - (range - (max - min)) / 2;
    const low = Math.min(maxLow, Math.max(minLow, Math.round(balancedLow / step) * step));
    const padLow = (min - low) / range;
    const padHigh = (low + range - max) / range;
    const decimalPenalty = step < 1 && Math.max(Math.abs(min), Math.abs(max)) >= 100 ? 0.6 : 0;
    const score =
      range / ideal + penalty + 3 * Math.max(0, 0.12 - padLow) + 3 * Math.max(0, 0.12 - padHigh) + decimalPenalty;
    if (!best || score < best.score) best = { low, step, score };
  }
  if (!best) {
    // Fallback: just cover the data with four equal intervals.
    const step = (max - min) / 4 || 1;
    return { low: min, high: max, step };
  }
  return { low: best.low, high: best.low + best.step * 4, step: best.step };
}

/** Number of decimals needed to render a tick of the given step. */
function decimalsForStep(step) {
  for (let decimals = 0; decimals <= 4; decimals += 1) {
    if (Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) < 1e-9) return decimals;
  }
  return 4;
}
// #endregion

/** 默认标记色（`[r,g,b]`）：采集中性点 / 最低点绿 / 最高点红。 */
const LOW_COLOR = [26, 117, 38]; // 最低点：绿（跌绿，和卡片 header 的语义一致）
const HIGH_COLOR = [192, 42, 38]; // 最高点：红（涨红）
const DOT_COLOR = [47, 107, 255]; // 普通采集点：跟着折线的主色走
const AXIS_COLOR = [196, 203, 214]; // 轴线比网格深一点
const LABEL_COLOR = [89, 96, 112]; // 刻度文字
const AVG_COLOR = [125, 147, 184]; // 均价虚线：淡灰蓝
const ANNOTATION_COLOR = [32, 37, 48]; // 金额标注

/** Pick up to `max` evenly spaced indices (first and last always included). */
function pickEvenIndices(count, max) {
  const take = Math.max(2, Math.min(max, count));
  const indices = [];
  for (let i = 0; i < take; i += 1) {
    const index = Math.round((i * (count - 1)) / (take - 1));
    if (indices[indices.length - 1] !== index) indices.push(index);
  }
  return indices;
}

/**
 * Draw a trend line.
 *
 * 卡片口径（用户 2026-11-20 要求）：最低点绿、最高点红，并给每个采集点画小圆点。
 * 这些都是**默认值**，因此旧的 `renderTrendPng(values)` 调用（`host/index.js`）
 * 不用改就会得到新的标记；需要旧行为时传 `points:false` 或显式颜色即可。
 *
 * 坐标轴文字同样是默认打开的：`labels` 是 X 轴刻度（与 `values` 等长），缺省时
 * 只画网格；`avg` 控制均价虚线；`annotate` 控制最高/最低点金额标注。
 *
 * @param {number[]} values  oldest → newest, at least 2 finite numbers
 * @param {object}  [options]
 * @param {string[]} [options.labels]     X 轴刻度文字，例如 `['11-01','11-02',…]`
 * @param {string}  [options.yPrefix]     Y 轴最高刻度的前缀，默认 `'¥'`
 * @param {boolean|number} [options.avg]  均价虚线，默认 `true`（取 values 均值）
 * @param {boolean} [options.annotate]    最低/最高点金额标注，默认 `true`
 * @param {string}  [options.lowlight]   最低点颜色，默认绿
 * @param {string}  [options.highlight]  最高点颜色，默认红
 * @param {string}  [options.dot]        普通采集点颜色，默认同折线色
 * @param {boolean} [options.points]     是否画每个采集点的小圆点，默认 true
 * @param {number}  [options.pointRadius] 小圆点半径（css px），默认 1.9
 * @param {string}  [options.axis]       轴线/刻度颜色
 * @param {string}  [options.label]      刻度文字颜色
 * @param {string}  [options.avgLine]    均价虚线颜色
 * @returns {Buffer} PNG bytes
 */
export function renderTrendPng(values, options = {}) {
  const width = Math.max(120, Math.min(1200, Number(options.width) || 640));
  const height = Math.max(120, Math.min(900, Number(options.height) || 320));
  const background = parseColor(options.background, [255, 255, 255]);
  const grid = parseColor(options.grid, [232, 234, 238]);
  const stroke = parseColor(options.line, [47, 107, 255]);
  const fill = parseColor(options.fill, [47, 107, 255]);
  const low = parseColor(options.lowlight, LOW_COLOR);
  const high = parseColor(options.highlight, HIGH_COLOR);
  const point = parseColor(options.dot, DOT_COLOR);
  const axisColour = parseColor(options.axis, AXIS_COLOR);
  const labelColour = parseColor(options.label, LABEL_COLOR);
  const avgColour = parseColor(options.avgLine, AVG_COLOR);
  const showPoints = options.points !== false;
  const pointRadius = Math.min(6, Math.max(0.8, Number(options.pointRadius) || 1.9));
  const yPrefix = options.yPrefix === undefined ? '¥' : String(options.yPrefix);
  const showAnnotations = options.annotate !== false;

  const rawValues = Array.isArray(values) ? values : [];
  const rawLabels = Array.isArray(options.labels) ? options.labels : [];
  const numbers = [];
  const labelList = [];
  rawValues.forEach((value, index) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    numbers.push(number);
    labelList.push(rawLabels[index] === undefined || rawLabels[index] === null ? '' : String(rawLabels[index]));
  });
  if (numbers.length < 2) return renderBlankPng({ width, height, background, grid });

  const w = width * SS;
  const h = height * SS;

  const minValue = Math.min(...numbers);
  const maxValue = Math.max(...numbers);
  const range = niceRange(minValue, maxValue);
  const decimals = decimalsForStep(range.step);
  const tickValues = Array.from({ length: 5 }, (_, index) => {
    const value = range.low + range.step * index;
    return Math.round(value * 1e6) / 1e6;
  });
  // 只有最高刻度带 `¥`，其余只写数字：既点明币种，又不至于每条都占 6 位宽。
  const tickTexts = tickValues.map((value, index) => {
    const text = formatNumber(value, Number.isInteger(value) ? 0 : decimals);
    return `${index === 4 ? yPrefix : ''}${text}`;
  });
  const tickWidth = Math.max(...tickTexts.map((text) => measureText(text)));

  // 布局（css px → 设备 px）：左边文字槽按最长刻度实际宽度算，至少 52px。
  const ySlotWidth = Math.max(52 * SS, tickWidth);
  const padLeft = 4 * SS + ySlotWidth + 10 * SS;
  const padRight = 14 * SS;
  const padTop = 24 * SS;
  const padBottom = 38 * SS;
  const plotW = Math.max(1, w - padLeft - padRight);
  const plotH = Math.max(1, h - padTop - padBottom);
  const plotRight = padLeft + plotW;
  const plotBottom = padTop + plotH;

  const canvas = createCanvas(w, h, background);
  const span = range.high - range.low;
  const toY = (value) => padTop + plotH - ((value - range.low) / span) * plotH;
  const toX = (index) => padLeft + (index / (numbers.length - 1)) * plotW;

  // --- horizontal grid + Y axis labels -------------------------------------
  const yLabelCentreOffset = (FONT_HEIGHT * FONT_SCALE) / 2; // 14 device px
  // 矮图（如 120px 高）里 5 条刻度文字会挤在一起，隔一条标一次，网格线仍画满 5 条。
  const yLabelStride = plotH / 4 < 18 * SS ? 2 : 1;
  for (let i = 0; i < 5; i += 1) {
    const y = toY(tickValues[i]);
    canvas.line(padLeft, y, plotRight, y, grid, SS, 0.55);
    canvas.line(padLeft - 4 * SS, y, padLeft, y, axisColour, SS, 1);
    if (i % yLabelStride !== 0) continue;
    const text = tickTexts[i];
    drawText(canvas, text, padLeft - 10 * SS - measureText(text), y - yLabelCentreOffset, labelColour);
  }

  // --- X labels: choose 3–6 that fit without touching -----------------------
  const hasLabels = labelList.some((text) => text.length > 0);
  const xLabelWidth = hasLabels ? Math.max(...labelList.filter(Boolean).map((text) => measureText(text))) : 0;
  let xTickIndices = [];
  if (hasLabels) {
    const maxCount = Math.min(6, numbers.length);
    for (let count = maxCount; count >= 2; count -= 1) {
      const indices = pickEvenIndices(numbers.length, count);
      let fits = true;
      for (let i = 1; i < indices.length; i += 1) {
        const gap = toX(indices[i]) - toX(indices[i - 1]);
        if (gap < xLabelWidth + 8 * SS) {
          fits = false;
          break;
        }
      }
      if (fits) {
        xTickIndices = indices;
        break;
      }
    }
    if (!xTickIndices.length) xTickIndices = [0];
  }

  // 垂直网格线：有 labels 时对应刻度，没有 labels 时只留几条装饰网格。
  if (hasLabels) {
    for (const index of xTickIndices) {
      const x = toX(index);
      canvas.line(x, padTop, x, plotBottom, grid, SS, 0.18);
    }
  } else {
    for (let i = 1; i < 4; i += 1) {
      const x = padLeft + (plotW / 4) * i;
      canvas.line(x, padTop, x, plotBottom, grid, SS, 0.18);
    }
  }

  // --- area under the line -------------------------------------------------
  for (let x = 0; x <= plotW; x += 1) {
    const position = padLeft + x;
    const ratio = x / plotW;
    const index = ratio * (numbers.length - 1);
    const lower = Math.floor(index);
    const upper = Math.min(numbers.length - 1, lower + 1);
    const frac = index - lower;
    const value = numbers[lower] + (numbers[upper] - numbers[lower]) * frac;
    const top = Math.round(toY(value));
    for (let y = top; y < plotBottom; y += 1) canvas.blend(position, y, fill, 0.12);
  }

  // --- average dashed line (thin, below the trend line) --------------------
  let average = null;
  if (options.avg === false) average = null;
  else if (typeof options.avg === 'number' && Number.isFinite(options.avg)) average = options.avg;
  else average = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (average !== null) {
    const avgY = toY(average);
    if (avgY >= padTop - 0.5 && avgY <= plotBottom + 0.5) {
      const dash = 6 * SS;
      for (let x = 0; x < plotW; x += dash * 2) {
        const x0 = padLeft + x;
        const x1 = Math.min(plotRight, x0 + dash);
        canvas.line(x0, avgY, x1, avgY, avgColour, SS, 0.5);
      }
    }
  }

  // --- axes ----------------------------------------------------------------
  canvas.line(padLeft, padTop, padLeft, plotBottom, axisColour, SS, 1);
  canvas.line(padLeft, plotBottom, plotRight, plotBottom, axisColour, SS, 1);

  // X ticks + labels
  if (hasLabels && xLabelWidth <= plotW - 4 * SS) {
    const xLabelTop = plotBottom + 13 * SS;
    for (const index of xTickIndices) {
      const x = toX(index);
      canvas.line(x, plotBottom, x, plotBottom + 4 * SS, axisColour, SS, 1);
      const text = labelList[index];
      if (!text) continue;
      const textW = measureText(text);
      let left = Math.round((x - textW / 2) / SS) * SS;
      left = Math.max(padLeft, Math.min(plotRight - textW, left));
      drawText(canvas, text, left, xLabelTop, labelColour);
    }
  }

  // --- the line itself, 2 device pixels (≈1 css px after downsampling) -----
  for (let i = 1; i < numbers.length; i += 1) {
    canvas.line(toX(i - 1), toY(numbers[i - 1]), toX(i), toY(numbers[i]), stroke, 1.6 * SS, 1);
  }

  /**
   * Round dot with a background-coloured halo: without the halo a 2px dot on a
   * 1.6px line reads as a bulge; with it the collection point looks deliberate
   * and stays legible where the line is steep.
   */
  const dotAt = (x, y, radius, colour) => {
    const cx = Math.round(x);
    const cy = Math.round(y);
    const r = Math.max(1, Math.round(radius));
    const halo = r + Math.max(1, Math.round(0.8 * SS));
    for (let oy = -halo; oy <= halo; oy += 1) {
      for (let ox = -halo; ox <= halo; ox += 1) {
        if (ox * ox + oy * oy <= halo * halo) canvas.set(cx + ox, cy + oy, background);
      }
    }
    for (let oy = -r; oy <= r; oy += 1) {
      for (let ox = -r; ox <= r; ox += 1) {
        if (ox * ox + oy * oy <= r * r) canvas.set(cx + ox, cy + oy, colour);
      }
    }
  };

  // 每次采集一个小圆点；最低 / 最高点另用绿 / 红强调（最后画，保证在最上层）。
  // 全部数值相同（首几次采集常见）时没有「最低/最高」可言，只留中性色圆点，
  // 避免绿色被红色盖住、看起来像一处莫名其妙的红斑。
  const lowest = numbers.indexOf(minValue);
  const highest = numbers.indexOf(maxValue);
  const flat = lowest === highest;
  if (showPoints) {
    for (let i = 0; i < numbers.length; i += 1) {
      if (!flat && (i === lowest || i === highest)) continue;
      dotAt(toX(i), toY(numbers[i]), Math.round(pointRadius * SS), point);
    }
  }
  if (!flat) {
    const markR = Math.max(2 * SS, Math.round(pointRadius * SS) + SS);
    dotAt(toX(lowest), toY(numbers[lowest]), markR, low);
    dotAt(toX(highest), toY(numbers[highest]), markR, high);
  }

  // --- min / max amount annotations ---------------------------------------
  const annotationRects = [];
  const drawnAnnotations = new Set();
  // 留 2px 视觉间隙：两个框刚好挨着也会看起来像一行糊掉的字。
  const overlaps = (a, b) =>
    a.left - 2 < b.right && b.left - 2 < a.right && a.top - 2 < b.bottom && b.top - 2 < a.bottom;
  const annotate = (index, value, colour) => {
    // 金额标注按整元写（¥1,081），只有很小的数值才保留两位小数：点旁的标签贵在
    // 一眼读懂，精确数字在卡片的 markdown 里。
    const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
    const text = `¥${formatNumber(rounded, Number.isInteger(rounded) ? 0 : 2)}`;
    if (drawnAnnotations.has(text)) return; // 近似平坦的序列两边会取整成同一个数
    const textW = measureText(text);
    const haloPad = 2 * SS; // 2 css px of white around the glyphs
    const rectW = textW + haloPad * 2;
    const rectH = FONT_HEIGHT * FONT_SCALE + haloPad * 2;
    // 绘图区窄到放不下标签时宁可不标，也不要糊住整张图。
    if (rectW > plotW - 8 * SS || plotH < 60 * SS) return;
    const cx = toX(index);
    const cy = toY(value);
    let left = Math.round((cx - rectW / 2) / SS) * SS;
    left = Math.max(padLeft, Math.min(plotRight - rectW, left));
    const preferredBelow = cy - padTop < 26 * SS;
    // 最高/最低点挨得很近时两块标签会叠在一起：先按默认方向放，撞了就翻到
    // 点的另一侧；两边都撞就放弃这一块，避免糊成一团。
    for (const below of [preferredBelow, !preferredBelow]) {
      let top = below ? cy + 6 * SS : cy - 6 * SS - rectH;
      top = Math.max(2 * SS, Math.min(h - 2 * SS - rectH, top));
      const rect = { left, top, right: left + rectW, bottom: top + rectH };
      if (annotationRects.some((other) => overlaps(other, rect))) continue;
      fillRect(canvas, left, top, rectW, rectH, background);
      drawText(canvas, text, left + haloPad, top + haloPad, colour);
      annotationRects.push(rect);
      drawnAnnotations.add(text);
      return;
    }
  };
  if (showAnnotations) {
    if (flat) {
      annotate(Math.floor((numbers.length - 1) / 2), numbers[0], ANNOTATION_COLOR);
    } else {
      annotate(lowest, numbers[lowest], low);
      annotate(highest, numbers[highest], high);
    }
  }

  const small = downsample(canvas, SS);
  return encodePng(small.width, small.height, small.pixels);
}

/** Placeholder used when there is not enough data to draw a trend. */
export function renderBlankPng({ width = 640, height = 320, background = [255, 255, 255], grid = [232, 234, 238] } = {}) {
  const canvas = createCanvas(width, height, background);
  for (let i = 1; i < 4; i += 1) canvas.line(0, (height / 4) * i, width, (height / 4) * i, grid, 1, 0.55);
  return encodePng(canvas.width, canvas.height, canvas.pixels);
}

export const __internals = {
  crc32,
  encodePng,
  FONT,
  FONT_ROWS,
  FONT_SCALE,
  measureText,
  drawText,
  formatNumber,
  niceRange,
  pickEvenIndices,
};
