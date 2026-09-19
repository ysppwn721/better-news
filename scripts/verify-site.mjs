/**
 * 用真实浏览器打开站点，验证渲染结果与运行时错误（零依赖，基于 scripts/lib/cdp.mjs）。
 *
 * 用法:
 *   node scripts/verify-site.mjs <url>            桌面尺寸
 *   node scripts/verify-site.mjs <url> --mobile   手机尺寸
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const url = process.argv[2];
if (!url) {
  console.error('用法: node scripts/verify-site.mjs <url> [--mobile]');
  process.exit(1);
}
const mobile = process.argv.includes('--mobile');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shot = resolve(ROOT, `.dsh-vision-router/artifacts/verify-${mobile ? 'mobile' : 'desktop'}.png`);

const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = mobile ? 9451 : 9452;
const width = mobile ? 390 : 1440;
const height = mobile ? 844 : 950;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--window-size=${width},${height}`,
  '--user-data-dir=' + process.env.TEMP + `\\bn-verify-${PORT}`,
  'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} };
process.on('exit', cleanup);

await sleep(2500);

// 新建标签页指向目标地址
let target = null;
for (let i = 0; i < 24; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
if (!target) { console.error('无法连接 Chrome DevTools'); process.exit(1); }

const api = await connectCdp(target.webSocketDebuggerUrl);
const errors = [];
const netEvents = [];
const pending = new Map();

api.on('Runtime.exceptionThrown', (p) => {
  errors.push(`[异常] ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
});
api.on('Log.entryAdded', (p) => {
  if (p.entry?.level !== 'error') return;
  const u = p.entry.url || '';
  const t = p.entry.text || '';
  // 静态托管模式下探测 /api/meta 必然 404，属预期行为
  if (/\/api\/meta/.test(u) || /\/api\/meta/.test(t)) return;
  errors.push(`[log] ${t}`);
});
// 记录网络请求，便于定位卡在哪个请求上
api.on('Network.requestWillBeSent', (p) => {
  pending.set(p.requestId, { url: p.request.url, start: Date.now() });
});
api.on('Network.responseReceived', (p) => {
  const req = pending.get(p.requestId);
  if (req) netEvents.push({ url: req.url, status: p.response.status, ms: Date.now() - req.start });
});
api.on('Network.loadingFailed', (p) => {
  const req = pending.get(p.requestId);
  if (req) netEvents.push({ url: req.url, status: `失败:${p.errorText}`, ms: Date.now() - req.start });
});

api.send('Runtime.enable');
api.send('Log.enable');
api.send('Page.enable');
api.send('Network.enable');

await sleep(parseInt(process.env.WAIT_MS || '15000', 10));

const expr = `JSON.stringify({
  title: document.title,
  sub: document.getElementById('brandSub')?.textContent,
  cards: document.querySelectorAll('.card').length,
  cats: [...document.querySelectorAll('.cat-item')].map(e => e.querySelector('.nm')?.textContent),
  listMeta: document.getElementById('listMeta')?.textContent,
  firstCard: document.querySelector('.card-title')?.textContent?.slice(0, 44) || null,
  deadlineBadge: document.getElementById('deadlineBadge')?.textContent || null,
  manifestHref: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
  swSupported: 'serviceWorker' in navigator,
  mobileNavShown: (() => { const n = document.querySelector('.mobile-nav'); return n ? getComputedStyle(n).display !== 'none' : null; })(),
  bottomNavLabels: [...document.querySelectorAll('.mnav-btn')].map(e => e.textContent.trim()),
  bodyOverflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
})`;

const evalId = api.send('Runtime.evaluate', { expression: expr, returnByValue: true });
const res = await waitForResult(api, evalId, 8000);

console.log(`=== 站点验证 ===`);
console.log(`  URL: ${url}`);
console.log(`  视口: ${width}x${height}${mobile ? ' (手机)' : ' (桌面)'}\n`);
try { console.log(JSON.stringify(JSON.parse(res?.result?.value), null, 2)); } catch { console.log(res); }

console.log('\n=== 运行时错误 ===');
console.log(errors.length ? errors.map((e) => `  ${e}`).join('\n') : '  （无）');

if (netEvents.length) {
  console.log('\n=== 网络请求 ===');
  for (const e of netEvents.slice(0, 20)) {
    const u = e.url.replace(/^https?:\/\/[^/]+/, '');
    console.log(`  ${String(e.status).padEnd(18)} ${String(e.ms).padStart(6)}ms  ${u.slice(0, 60)}`);
  }
}

const shotId = api.send('Page.captureScreenshot', { format: 'png' });
const img = await waitForResult(api, shotId, 10000);
if (img?.data) {
  mkdirSync(dirname(shot), { recursive: true });
  writeFileSync(shot, Buffer.from(img.data, 'base64'));
  console.log(`\n截图: ${shot}`);
}

api.close();
cleanup();
await sleep(300);
process.exit(0);
