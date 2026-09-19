/**
 * 在 App 真实环境（app/www + app-store.mjs + IndexedDB）里验证「我的关注」。
 *
 * 为什么要单独测这一份：网页版走 localStorage + 静态快照，App 走 IndexedDB +
 * 本机抓取，data.onChange 回调会在抓取过程中反复重渲染。关注按钮的状态、
 * 关键词自动入清单、刷新按钮的转动都必须在这条路径上同样成立。
 *
 * 用法: node scripts/test-watch-app.mjs [观察秒=200]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/logs');
mkdirSync(OUT, { recursive: true });
const PORT = 9555;
const WEB_PORT = 5185;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const serverCode = `
const http=require('http'),fs=require('fs'),path=require('path');
const root=${JSON.stringify(resolve(ROOT, 'app/www').replace(/\\/g, '/'))};
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);
  if(p==='/')p='/index.html';
  const f=path.join(root,p);
  fs.readFile(f,(e,d)=>{
    if(e){res.writeHead(404);res.end('x');return;}
    res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'});
    res.end(d);
  });
}).listen(${WEB_PORT});`;

const server = spawn('node', ['-e', serverCode], { stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-web-security',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-watch-app',
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { server.kill(); } catch {} try { chrome.kill(); } catch {} };
process.on('exit', cleanup);
await sleep(3200);

let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${WEB_PORT}/`)}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
if (!target) { console.error('无法连接 Chrome'); process.exit(1); }

const api = await connectCdp(target.webSocketDebuggerUrl);
const errors = [];
api.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 300)));
api.send('Runtime.enable');
api.send('Page.enable');
api.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
api.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

const evaluate = async (expr, timeout = 180000) => {
  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, timeout);
  if (res?.exceptionDetails) return { __error: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
  return res?.result?.value;
};
const shot = async (name) => {
  const id = api.send('Page.captureScreenshot', { format: 'png' });
  const res = await waitForResult(api, id, 20000);
  if (res?.data) { const p = resolve(OUT, `watchapp-${name}.png`); writeFileSync(p, Buffer.from(res.data, 'base64')); return p; }
};

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// 干净开始
await evaluate(`(async () => {
  for (const k of ['bn.watched','bn.watchKeywords','bn.watchPrefs','bn.watchLastSeen']) localStorage.removeItem(k);
  const m = await import('./app-store.mjs');
  await m.__internal.db.clear();
  return 1;
})()`).catch(() => {});
await evaluate(`location.reload()`);
console.log('已清空本地库，等待首次抓取出现内容…');

// App 首轮抓取要 1~2 分钟，等到有卡片为止
let ready = false;
for (let i = 0; i < 150; i++) {
  const n = await evaluate(`document.querySelectorAll('.card').length`);
  if (typeof n === 'number' && n > 0) { ready = true; break; }
  await sleep(2000);
}
check('App 首次抓取后有内容', ready);
console.log('  页面状态:', await evaluate(`document.getElementById('brandSub').textContent`));

console.log('\n=== 1. App 里的关注按钮 ===');
const r1 = await evaluate(`(async () => {
  const btn = document.querySelector('.card .watch-btn');
  if (!btn) return JSON.stringify({ error: '无关注按钮' });
  btn.click();
  await new Promise(r => setTimeout(r, 700));
  return JSON.stringify({
    text: btn.textContent.trim(),
    on: btn.classList.contains('on'),
    stored: Object.keys(JSON.parse(localStorage.getItem('bn.watched') || '{}')).length,
    badge: document.getElementById('watchBadge').textContent
  });
})()`);
console.log('  ', r1);
try {
  const o = JSON.parse(r1);
  check('关注按钮在 App 里可用', !o.error);
  check('点击后变为已关注', /已关注/.test(o.text || ''), o.text);
  check('本地清单 +1', o.stored === 1, `stored=${o.stored}`);
} catch { check('场景1', false, String(r1).slice(0, 140)); }
await shot('1-watched');

console.log('\n=== 2. App 里关键词关注 ===');
const r2 = await evaluate(`(async () => {
  document.querySelector('.mnav-btn[data-target="watch"]').click();
  await new Promise(r => setTimeout(r, 500));
  document.getElementById('kwInput').value = '奖学金';
  document.getElementById('btnKwAdd').click();
  await new Promise(r => setTimeout(r, 1500));
  return JSON.stringify({
    rows: document.querySelectorAll('.watch-row').length,
    kwRows: [...document.querySelectorAll('.watch-why')].filter(w => w.textContent.includes('关键词')).length,
    chips: [...document.querySelectorAll('.kw-word')].map(x => x.textContent)
  });
})()`);
console.log('  ', r2);
try {
  const o = JSON.parse(r2);
  check('关键词 chip 已添加', (o.chips || []).includes('奖学金'));
  check('命中条目自动进清单', o.kwRows >= 1, `关键词行 ${o.kwRows} / ${o.rows} 行`);
} catch { check('场景2', false, String(r2).slice(0, 140)); }
await shot('2-keyword');

console.log('\n=== 3. 刷新按钮：抓取中会转，结束后停下 ===');
const r3 = await evaluate(`(async () => {
  document.getElementById('btnWatchClose').click();
  const { data } = await import('./app-store.mjs');
  const btn = document.getElementById('btnFetch');
  const log = [];
  const t0 = Date.now();
  btn.click();                       // 此时首轮抓取多半仍在跑 → 命中「已在抓取中」分支
  // 一直观察到抓取真正结束
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const st = await data.fetchStatus();
    log.push({ t: Math.round((Date.now() - t0) / 1000), spin: btn.classList.contains('spin'), fetching: st.fetching });
    if (!st.fetching) break;
  }
  // 结束后再多观察 6 秒，确认不会「又转起来」
  await new Promise(r => setTimeout(r, 6000));
  const finalSpin = btn.classList.contains('spin');
  const st = await data.fetchStatus();
  return JSON.stringify({
    sawSpinningWhileFetching: log.some(x => x.fetching && x.spin),
    finalSpin,
    finalFetching: st.fetching,
    seconds: log.length ? log[log.length - 1].t : null,
    samples: log.length
  });
})()`, 420000);
console.log('  ', r3);
try {
  const o = JSON.parse(r3);
  check('抓取中按钮确实在转（状态真实反映）', o.sawSpinningWhileFetching === true);
  check('抓取结束后按钮停下', o.finalSpin === false, `finalSpin=${o.finalSpin}`);
  check('结束后状态为未抓取', o.finalFetching === false);
} catch { check('场景3', false, String(r3).slice(0, 140)); }
await shot('3-refresh');

console.log('\n=== 4. 重新载入后关注仍在（持久化）===');
await evaluate(`location.reload()`);
await sleep(9000);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`document.querySelectorAll('.card').length > 0`)) break;
  await sleep(1500);
}
const r4 = await evaluate(`(async () => {
  const stored = Object.keys(JSON.parse(localStorage.getItem('bn.watched') || '{}')).length;
  return JSON.stringify({
    stored,
    badge: document.getElementById('watchBadge').textContent,
    badgeHidden: document.getElementById('watchBadge').classList.contains('hidden'),
    kw: JSON.parse(localStorage.getItem('bn.watchKeywords') || '[]').map(k => k.word)
  });
})()`);
console.log('  ', r4);
try {
  const o = JSON.parse(r4);
  check('关注清单仍在', o.stored >= 1, `stored=${o.stored}`);
  check('角标正确显示', o.badgeHidden === false);
  check('关键词仍在', (o.kw || []).includes('奖学金'));
} catch { check('场景4', false, String(r4).slice(0, 140)); }

console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
console.log('页面异常:', errors.length ? errors.slice(0, 4).join(' | ') : '（无）');
cleanup();
process.exit(fail ? 1 : 0);
