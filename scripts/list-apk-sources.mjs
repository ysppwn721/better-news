/**
 * 从 APK 内嵌的信源清单里，按对象边界正确解析出每个信源。
 *
 * 说明：打包后的 bundle 是 JS 源码（形如 { id: "col-cst", name: "…", listUrl: "…" }），
 * 不是 JSON，中文字符被转义为 \uXXXX。这里按对象块切分后逐个解析，
 * 避免用正则跨对象匹配导致字段串位。
 *
 * 用法: node scripts/list-apk-sources.mjs <apk路径> [id前缀]
 */
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const apk = process.argv[2];
const prefix = process.argv[3] || 'col-cst';
if (!apk || !existsSync(apk)) { console.error(`✗ 找不到 ${apk}`); process.exit(1); }

const buf = readFileSync(apk);

function extractAsset(assetName) {
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x01 || buf[i + 3] !== 0x02) continue;
    const method = buf.readUInt16LE(i + 10);
    const compSize = buf.readUInt32LE(i + 20);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    const localOffset = buf.readUInt32LE(i + 42);
    if (nameLen <= 0 || nameLen > 400) continue;
    const name = buf.subarray(i + 46, i + 46 + nameLen).toString('utf8');
    if (name === assetName) {
      const lo = localOffset;
      const ln = buf.readUInt16LE(lo + 26);
      const ex = buf.readUInt16LE(lo + 28);
      const start = lo + 30 + ln + ex;
      const raw = buf.subarray(start, start + compSize);
      return method === 8 ? inflateRawSync(raw).toString('utf8') : raw.toString('utf8');
    }
    i += 45 + nameLen + extraLen + commentLen;
  }
  return null;
}

const text = extractAsset('assets/public/shared.mjs');
if (!text) { console.error('✗ 包内找不到 shared.mjs'); process.exit(1); }

/** 把 \uXXXX 转成真实字符 */
const unescape = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

// 按对象块切分：每个信源对象形如 {\n id: "...",\n name: "...",\n ... listUrl: "..." }
const blocks = text.split(/\{\s*\n?\s*id:\s*"/).slice(1);
const sources = [];
for (const b of blocks) {
  const id = (b.match(/^([^"]+)"/) || [])[1];
  const name = (b.match(/name:\s*"([^"]*)"/) || [])[1];
  const listUrl = (b.match(/listUrl:\s*"([^"]*)"/) || [])[1];
  const categoryId = (b.match(/categoryId:\s*"([^"]*)"/) || [])[1];
  if (id && listUrl) {
    sources.push({ id, name: unescape(name || ''), listUrl, categoryId });
  }
}

console.log(`包内共解析出 ${sources.length} 个信源\n`);

const target = sources.filter((s) => s.id.startsWith(prefix));
console.log(`=== 前缀「${prefix}」的信源（${target.length} 个）===`);
for (const s of target) {
  console.log(`  ${s.id.padEnd(16)} ${s.name.padEnd(26, '　')} ${s.listUrl.replace(/^https?:\/\//, '')}`);
}

const byCat = {};
for (const s of sources) byCat[s.categoryId] = (byCat[s.categoryId] || 0) + 1;
console.log('\n=== 信源按栏目分布 ===');
for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(k || '?').padEnd(12)} ${v}`);
}

const hosts = new Set(sources.map((s) => (s.listUrl.match(/^https?:\/\/([^/]+)/) || [])[1]).filter(Boolean));
console.log(`\n覆盖站点数: ${hosts.size}`);
