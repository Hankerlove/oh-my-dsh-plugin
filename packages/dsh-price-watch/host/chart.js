/**
 * Minimal PNG chart renderer for Feishu cards.
 *
 * Why hand-rolled: a Feishu card image has to be uploaded as an `image_key`, so
 * the Host must produce real PNG bytes. Pulling in canvas/sharp would add a
 * native dependency to a decorative plugin, and this only ever needs a plain
 * trend line — so the encoder below writes the four PNG chunks itself and leans
 * on `node:zlib` for compression. No text: every number the reader needs is in
 * the card's markdown, the image only has to show the shape.
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

/** 默认标记色（`[r,g,b]`）：采集中性点 / 最低点绿 / 最高点红。 */
const LOW_COLOR = [26, 117, 38]; // 最低点：绿（跌绿，和卡片 header 的语义一致）
const HIGH_COLOR = [192, 42, 38]; // 最高点：红（涨红）
const DOT_COLOR = [47, 107, 255]; // 普通采集点：跟着折线的主色走

/**
 * Draw a trend line.
 *
 * 卡片口径（用户 2026-11-20 要求）：最低点绿、最高点红，并给每个采集点画小圆点。
 * 这些都是**默认值**，因此旧的 `renderTrendPng(values)` 调用（`host/index.js`）
 * 不用改就会得到新的标记；需要旧行为时传 `points:false` 或显式颜色即可。
 *
 * @param {number[]} values  oldest → newest, at least 2 finite numbers
 * @param {object}  [options]
 * @param {string}  [options.lowlight]   最低点颜色，默认绿
 * @param {string}  [options.highlight]  最高点颜色，默认红
 * @param {string}  [options.dot]        普通采集点颜色，默认同折线色
 * @param {boolean} [options.points]     是否画每个采集点的小圆点，默认 true
 * @param {number}  [options.pointRadius] 小圆点半径（css px），默认 1.9
 * @returns {Buffer} PNG bytes
 */
export function renderTrendPng(values, options = {}) {
  const width = Math.max(120, Math.min(1200, Number(options.width) || 640));
  const height = Math.max(80, Math.min(600, Number(options.height) || 220));
  const background = parseColor(options.background, [255, 255, 255]);
  const grid = parseColor(options.grid, [232, 234, 238]);
  const stroke = parseColor(options.line, [47, 107, 255]);
  const fill = parseColor(options.fill, [47, 107, 255]);
  const low = parseColor(options.lowlight, LOW_COLOR);
  const high = parseColor(options.highlight, HIGH_COLOR);
  const point = parseColor(options.dot, DOT_COLOR);
  const showPoints = options.points !== false;
  const pointRadius = Math.min(6, Math.max(0.8, Number(options.pointRadius) || 1.9));

  const numbers = (Array.isArray(values) ? values : []).map(Number).filter((value) => Number.isFinite(value));
  if (numbers.length < 2) return renderBlankPng({ width, height, background, grid });

  const w = width * SS;
  const h = height * SS;
  const canvas = createCanvas(w, h, background);
  const padLeft = 10 * SS;
  const padRight = 10 * SS;
  const padTop = 14 * SS;
  const padBottom = 14 * SS;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  let min = Math.min(...numbers);
  let max = Math.max(...numbers);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const toY = (value) => padTop + plotH - ((value - min) / span) * plotH;
  const toX = (index) => padLeft + (index / (numbers.length - 1)) * plotW;

  // Horizontal guides: 4 bands, faint.
  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (plotH / 4) * i;
    canvas.line(padLeft, y, padLeft + plotW, y, grid, 1, 0.55);
  }

  // Area under the line.
  for (let x = 0; x <= plotW; x += 1) {
    const position = padLeft + x;
    const ratio = x / plotW;
    const index = ratio * (numbers.length - 1);
    const lower = Math.floor(index);
    const upper = Math.min(numbers.length - 1, lower + 1);
    const frac = index - lower;
    const value = numbers[lower] + (numbers[upper] - numbers[lower]) * frac;
    const top = Math.round(toY(value));
    for (let y = top; y < padTop + plotH; y += 1) canvas.blend(position, y, fill, 0.12);
  }

  // The line itself, 2 device pixels (≈1 css px after downsampling).
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
  const lowest = numbers.indexOf(Math.min(...numbers));
  const highest = numbers.indexOf(Math.max(...numbers));
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

  const small = downsample(canvas, SS);
  return encodePng(small.width, small.height, small.pixels);
}

/** Placeholder used when there is not enough data to draw a trend. */
export function renderBlankPng({ width = 640, height = 220, background = [255, 255, 255], grid = [232, 234, 238] } = {}) {
  const canvas = createCanvas(width, height, background);
  for (let i = 1; i < 4; i += 1) canvas.line(0, (height / 4) * i, width, (height / 4) * i, grid, 1, 0.55);
  return encodePng(canvas.width, canvas.height, canvas.pixels);
}

export const __internals = { crc32, encodePng };
