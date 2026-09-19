/**
 * 生成 PWA 图标（纯 Node 手写 PNG，不依赖 canvas/sharp）。
 *
 * 画一个蓝底圆角方块 + 白色「中北」风格符号：上方一条横杠（代表「中」的竖线穿越感），
 * 简单几何图形即可，重点是四种尺寸齐全且 maskable 版本留有安全边距。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/icons');

/** 创建 RGBA 像素缓冲 */
function createCanvas(size, bg) {
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = bg[0];
    px[i * 4 + 1] = bg[1];
    px[i * 4 + 2] = bg[2];
    px[i * 4 + 3] = bg[3];
  }
  return px;
}

const setPx = (px, size, x, y, c) => {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
};

/** 圆角矩形填充 */
function fillRoundRect(px, size, x0, y0, w, h, r, c) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.min(x - x0, x0 + w - 1 - x);
      const dy = Math.min(y - y0, y0 + h - 1 - y);
      if (dx < r && dy < r) {
        const d = Math.hypot(r - dx, r - dy);
        if (d > r) continue;
        // 边缘抗锯齿
        const a = Math.max(0, Math.min(1, r - d + 0.5));
        const i = (y * size + x) * 4;
        px[i] = Math.round(px[i] * (1 - a) + c[0] * a);
        px[i + 1] = Math.round(px[i + 1] * (1 - a) + c[1] * a);
        px[i + 2] = Math.round(px[i + 2] * (1 - a) + c[2] * a);
        px[i + 3] = Math.round(px[i + 3] * (1 - a) + (c[3] ?? 255) * a);
        continue;
      }
      setPx(px, size, x, y, c);
    }
  }
}

/** 生成图标：蓝底圆角 + 白色信封/铃铛组合符号（表示「通知」） */
function drawIcon(size, { maskable = false } = {}) {
  const BG = [26, 86, 196, 255];       // #1a56c4
  const FG = [255, 255, 255, 255];
  const px = createCanvas(size, maskable ? BG : [0, 0, 0, 0]);

  if (!maskable) {
    // 非 maskable：整图圆角
    fillRoundRect(px, size, 0, 0, size, size, Math.round(size * 0.22), BG);
  }

  // maskable 需留安全边距（内容限制在中心 80% 内，避免被系统裁切）
  const inset = Math.round(size * (maskable ? 0.22 : 0.16));
  const inner = size - inset * 2;

  // 信封主体
  const bodyTop = inset + Math.round(inner * 0.22);
  const bodyH = Math.round(inner * 0.52);
  const radius = Math.max(2, Math.round(size * 0.035));
  fillRoundRect(px, size, inset, bodyTop, inner, bodyH, radius, FG);

  // 信封折角：一条 V 形折线（用两条粗线近似）
  const stroke = Math.max(2, Math.round(size * 0.045));
  const cx = size / 2;
  const top = bodyTop + Math.round(bodyH * 0.14);
  const bot = bodyTop + Math.round(bodyH * 0.62);
  const halfSpan = Math.round(inner * 0.40);
  for (let t = 0; t <= 1; t += 0.002) {
    const x = Math.round(cx - halfSpan * (1 - t));
    const y = Math.round(top + (bot - top) * t);
    fillRoundRect(px, size, x, y, stroke, stroke, 1, BG);
    fillRoundRect(px, size, size - x - stroke, y, stroke, stroke, 1, BG);
  }

  // 底部横条：象征「汇总成一条列表」
  const barY = bodyTop + bodyH + Math.round(inner * 0.11);
  const barH = Math.max(2, Math.round(size * 0.04));
  fillRoundRect(px, size, inset + Math.round(inner * 0.06), barY, Math.round(inner * 0.88), barH, barH / 2, FG);

  return encodePng(px, size, size);
}

/** 最小 PNG 编码器（RGBA8，无滤波） */
function encodePng(px, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type: none
    px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** CRC32（PNG 校验用） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-192-maskable.png', 192, { maskable: true }],
  ['icon-512-maskable.png', 512, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  const png = drawIcon(size, opts);
  writeFileSync(resolve(OUT, name), png);
  console.log(`  ${name.padEnd(26)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log(`图标已生成到 ${OUT.replace(ROOT, '.')}`);
