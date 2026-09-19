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
const indexHtml = extractAsset('assets/public/index.html') || '';
const appStore = extractAsset('assets/public/app-store.mjs') || '';

console.log('=== APK 内关键实现检查 ===');
console.log(`  app.js       ${(appJs.length / 1024).toFixed(0)} KB`);
console.log(`  app-store.mjs ${(appStore.length / 1024).toFixed(0)} KB`);
console.log(`  index.html   ${(indexHtml.length / 1024).toFixed(0)} KB`);

const checks = [
  ['置顶聚合 prioritySourceIds', /prioritySourceIds/, appJs],
  ['resetView 清空 filters', /function resetView[\s\S]{0,400}?filters\.clear\(\)/, appJs],
  ['纯标题搜索（terms.every + title.includes）', /terms\.every\(\(t\)\s*=>\s*title\.includes\(t\)\)/, appJs],
  ['搜索不再用摘要兜底', /const excerpt = \(item\.excerpt/, appJs, true],
  ['抓取完成通知界面（onChange 回调）', /onChange/, appStore],
  ['抓取进度提示', /正在抓取最新通知|正在更新/, appJs],
  ['刷新按钮图标为元素（只转图标）', /class="btn-icon"/, indexHtml],
];

let stale = 0;
for (const [label, re, target, shouldBeAbsent] of checks) {
  const present = re.test(target);
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
