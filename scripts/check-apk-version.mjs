/**
 * 校验 APK 内 app.js 是否包含最新的关键实现。
 * 用于确认「用户装的 APK 是否已包含修复」。
 * 用法: node scripts/check-apk-version.mjs <apk路径>
 */
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const apk = process.argv[2];
if (!apk || !existsSync(apk)) { console.error(`✗ 找不到 ${apk}`); process.exit(1); }

const buf = readFileSync(apk);

function extractAsset(assetName) {
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x01 || buf[i + 3] !== 0x04) {
      // 中央目录
      if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x01 || buf[i + 3] !== 0x02) continue;
    }
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

const appJs = extractAsset('assets/public/app.js');
if (!appJs) { console.error('✗ 包内找不到 assets/public/app.js'); process.exit(1); }

console.log('=== APK 内 app.js 关键实现检查 ===');
console.log(`  文件大小: ${(appJs.length / 1024).toFixed(0)} KB`);

const checks = [
  ['置顶聚合 prioritySourceIds', /prioritySourceIds/],
  ['resetView 清空 filters', /function resetView[\s\S]{0,400}?filters\.clear\(\)/],
  ['纯标题搜索（terms.every + title.includes）', /terms\.every\(\(t\)\s*=>\s*title\.includes\(t\)\)/],
  ['搜索不再用 excerpt', /const excerpt = \(item\.excerpt/],
  ['搜索不再用 searchText', /item\.searchText/],
  ['加载中只转图标（.btn-icon）', /btn-icon/],
];

let stale = 0;
for (const [label, re] of checks) {
  const present = re.test(appJs);
  const shouldBeAbsent = label.includes('不再用');
  const ok = shouldBeAbsent ? !present : present;
  if (!ok) stale++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${shouldBeAbsent ? '（应为不存在）' : ''}`);
}

// 提取 search 函数片段，人工核对
const si = appJs.indexOf('function matchScore');
if (si >= 0) {
  console.log('\n=== 包内 matchScore 实现 ===');
  console.log(appJs.slice(si, si + 420).split('\n').map((l) => '  ' + l).join('\n'));
}

console.log(`\n结论: ${stale === 0 ? '✓ 已包含全部最新修复' : `✗ 有 ${stale} 项缺失（APK 是旧版或构建未同步）`}`);
process.exit(stale === 0 ? 0 : 1);
