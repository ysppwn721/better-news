/**
 * 核验 APK 内容：确认前端资源、信源清单、原生配置都真的打进包里。
 *
 * 为什么需要：APK 构建成功 ≠ 内容正确。曾出现「构建成功但装上去白屏」这类问题，
 * 根源往往是 assets 没同步进去。这道检查在发布前把关。
 *
 * 实现说明：zip 里的条目是压缩存储的，不能直接搜字节，
 * 必须按中央目录记录的 local header 偏移取出数据并 inflate 后再检查。
 *
 * 用法: node scripts/inspect-apk.mjs <apk路径>
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const apk = process.argv[2];
if (!apk || !existsSync(apk)) {
  console.error(`✗ 找不到 APK: ${apk}`);
  process.exit(1);
}

const buf = readFileSync(apk);
const size = (statSync(apk).size / 1024 / 1024).toFixed(2);
console.log(`APK: ${apk}  (${size} MB)\n`);

/** 解析中央目录，返回 {name, method, compSize, localOffset} */
function readCentralDirectory(b) {
  const out = [];
  for (let i = 0; i < b.length - 4; i++) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b || b[i + 2] !== 0x01 || b[i + 3] !== 0x02) continue;
    const method = b.readUInt16LE(i + 10);
    const compSize = b.readUInt32LE(i + 20);
    const nameLen = b.readUInt16LE(i + 28);
    const extraLen = b.readUInt16LE(i + 30);
    const commentLen = b.readUInt16LE(i + 32);
    const localOffset = b.readUInt32LE(i + 42);
    if (nameLen <= 0 || nameLen > 400) continue;
    const name = b.subarray(i + 46, i + 46 + nameLen).toString('utf8');
    out.push({ name, method, compSize, localOffset });
    i += 45 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 取某个条目的解压后内容；失败返回 null */
function readEntry(b, entry) {
  try {
    const lo = entry.localOffset;
    if (b[lo] !== 0x50 || b[lo + 1] !== 0x4b || b[lo + 2] !== 0x03 || b[lo + 3] !== 0x04) return null;
    const nameLen = b.readUInt16LE(lo + 26);
    const extraLen = b.readUInt16LE(lo + 28);
    const dataStart = lo + 30 + nameLen + extraLen;
    const raw = b.subarray(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return raw;              // stored
    if (entry.method === 8) return inflateRawSync(raw); // deflate
    return null;
  } catch {
    return null;
  }
}

const entries = readCentralDirectory(buf);
console.log(`zip 条目数: ${entries.length}\n`);

const byName = new Map(entries.map((e) => [e.name, e]));

// ---------------------------------------------------------------- 结构检查
//
// 注意：release APK 的资源名会被 AAPT2 混淆（mipmap-xxx/ic_launcher.png → res/-B.png），
// 因此不能按原始路径找图标。改判 resources.arsc 里是否含 launcher 图标引用。
// 另外 Capacitor 为纯 Java 实现，不打包 .so 原生库，缺失属正常。
const arscEntry = entries.find((e) => e.name === 'resources.arsc');
const arscData = arscEntry ? readEntry(buf, arscEntry) : null;
const arscText = arscData ? arscData.toString('utf8') + arscData.toString('latin1') : '';
const hasLauncherIconRef = /ic_launcher/.test(arscText);

const structure = [
  ['前端页面 index.html', (n) => n === 'assets/public/index.html', true],
  ['前端逻辑 app.js', (n) => n === 'assets/public/app.js', true],
  ['数据层 app-store.mjs', (n) => n === 'assets/public/app-store.mjs', true],
  ['解析模块 shared.mjs', (n) => n === 'assets/public/shared.mjs', true],
  ['样式 style.css', (n) => n === 'assets/public/style.css', true],
  ['Capacitor 配置', (n) => n === 'assets/capacitor.config.json', true],
  ['AndroidManifest', (n) => n === 'AndroidManifest.xml', true],
  ['资源表 resources.arsc', (n) => n === 'resources.arsc', true],
  ['DEX 字节码', (n) => /^classes.*\.dex$/.test(n), true],
  // 混淆后的图片资源：数量能反映图标等资源已打进去
  ['资源图片(混淆名)', (n) => /^res\/.*\.(png|webp)$/i.test(n) || /\.9\.png$/i.test(n), true],
  ['资源 XML(混淆名)', (n) => /^res\/.*\.xml$/i.test(n), true],
  ['签名文件 META-INF', (n) => n.startsWith('META-INF/'), true],
];

console.log('=== 结构 ===');
let missing = 0;
for (const [label, pred, required] of structure) {
  const hit = entries.filter((e) => pred(e.name));
  if (!hit.length && required) missing++;
  console.log(`  ${hit.length ? '✓' : (required ? '✗' : '·')} ${label.padEnd(20, '　')} ${hit.length ? `${hit.length} 项` : '无'}`);
  if (hit.length && hit.length <= 2) hit.forEach((e) => console.log(`      ${e.name}`));
}
console.log(`  ${hasLauncherIconRef ? '✓' : '✗'} ${'启动图标引用'.padEnd(19, '　')} ${hasLauncherIconRef ? 'resources.arsc 中存在 ic_launcher' : '未找到'}`);
if (!hasLauncherIconRef) missing++;

// ---------------------------------------------------------------- 内容检查
console.log('\n=== 关键内容（解压后校验）===');
const contentTargets = [
  ['assets/public/shared.mjs', [
    ['解析器 parseList', 'parseList'],
    ['日期解析 parseDate', 'parseDate'],
    ['关键词规则 analyze', 'analyze'],
    ['截止识别 extractDeadlines', 'extractDeadlines'],
    ['计算机学院信源', 'cst.nuc.edu.cn'],
    ['主站信源', 'nuc.edu.cn/index/tzgg'],
  ]],
  ['assets/public/app-store.mjs', [
    ['抓取引擎 runScrape', 'runScrape'],
    ['IndexedDB 存储', 'indexedDB'],
  ]],
  ['assets/public/index.html', [
    ['页面标题', '校园信息汇总'],
    ['入口脚本', 'app.js'],
  ]],
  ['assets/capacitor.config.json', [
    ['CapacitorHttp 已开启', '"enabled": true'],
    ['应用名（中文正确）', '中北通知'],
  ]],
];

for (const [name, checks] of contentTargets) {
  const entry = byName.get(name);
  if (!entry) { console.log(`  ✗ 缺少 ${name}`); missing += checks.length; continue; }
  const data = readEntry(buf, entry);
  if (!data) { console.log(`  ✗ 无法解压 ${name}`); missing += checks.length; continue; }
  console.log(`  ${name}:`);
  for (const [label, needle] of checks) {
    const found = data.includes(Buffer.from(needle, 'utf8'));
    if (!found) missing++;
    console.log(`    ${found ? '✓' : '✗'} ${label}`);
  }
}

console.log(`\n结论: ${missing === 0 ? '✓ 内容完整，可以发布' : `✗ 有 ${missing} 项缺失，不要发布`}`);
process.exit(missing === 0 ? 0 : 1);
