/**
 * 校验 APK 内的信源清单：确认学院栏目数量符合预期。
 * 用法: node scripts/check-apk-sources.mjs <apk路径>
 */
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const apk = process.argv[2];
if (!apk || !existsSync(apk)) { console.error(`✗ 找不到 ${apk}`); process.exit(1); }

const buf = readFileSync(apk);

function entries() {
  const out = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x01 || buf[i + 3] !== 0x02) continue;
    const method = buf.readUInt16LE(i + 10);
    const compSize = buf.readUInt32LE(i + 20);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    const localOffset = buf.readUInt32LE(i + 42);
    if (nameLen <= 0 || nameLen > 400) continue;
    out.push({
      name: buf.subarray(i + 46, i + 46 + nameLen).toString('utf8'),
      method, compSize, localOffset,
    });
    i += 45 + nameLen + extraLen + commentLen;
  }
  return out;
}

function read(e) {
  const lo = e.localOffset;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  return e.method === 8 ? inflateRawSync(raw) : raw;
}

const all = entries();

// 1) Capacitor 配置
const cfg = all.find((e) => e.name === 'assets/capacitor.config.json');
if (cfg) {
  const c = JSON.parse(read(cfg).toString('utf8'));
  console.log('=== Capacitor 配置 ===');
  console.log(`  应用名: ${c.appName}`);
  console.log(`  包名: ${c.appId}`);
  console.log(`  CapacitorHttp: ${c.plugins?.CapacitorHttp?.enabled ? '✓ 已开启（CORS 绕过生效）' : '✗ 未开启'}`);
}

// 2) 信源清单（打包进 shared.mjs 的 JSON）
const shared = all.find((e) => e.name === 'assets/public/shared.mjs');
if (shared) {
  const text = read(shared).toString('utf8');
  console.log('\n=== 信源清单 ===');
  // sources.json 被内联进 bundle，统计 URL 出现次数
  const urls = [...new Set(text.match(/https?:\/\/[a-z0-9.-]+\.nuc\.edu\.cn[^"\\\s]*/gi) || [])];
  const hosts = [...new Set(urls.map((u) => new URL(u).hostname))];
  console.log(`  内嵌 URL 数: ${urls.length}`);
  console.log(`  覆盖站点数: ${hosts.length}`);
  // 关键栏目抽查
  const checks = [
    ['计算机学院 通知公告', 'cst.nuc.edu.cn/xwzx/tzgg.htm'],
    ['计算机学院 学院新闻', 'xwzx/xwjx.htm'],
    ['学校通知公告', 'www.nuc.edu.cn/index/tzgg.htm'],
    ['学工部通知', 'xsgzb.nuc.edu.cn/index/tzgg.htm'],
    ['教务部通知', 'jwc.nuc.edu.cn/index/tzgg.htm'],
  ];
  for (const [label, needle] of checks) {
    const sub = needle.replace(/^www\./, '');
    console.log(`  ${text.includes(needle) || text.includes(sub) ? '✓' : '·'} ${label}`);
  }
  const cstCount = (text.match(/cst\.nuc\.edu\.cn/g) || []).length;
  console.log(`\n  计算机学院相关 URL 出现 ${cstCount} 次`);
}

// 3) 前端资源
console.log('\n=== 前端资源 ===');
for (const n of ['assets/public/app.js', 'assets/public/app-store.mjs', 'assets/public/index.html']) {
  const key = n.split('/').pop();
  const e = all.find((x) => x.name === n);
  if (!e) { console.log(`  ✗ ${key} 缺失`); continue; }
  const t = read(e).toString('utf8');
  console.log(`  ✓ ${key.padEnd(20)} ${(t.length / 1024).toFixed(0)} KB`);
}
