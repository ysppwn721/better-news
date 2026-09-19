/**
 * 模拟 APK 环境（禁用 CORS + 本地抓取）跑一轮，统计条目数并测试搜索。
 * 用于回答「为什么 App 和网页版体验差距大」。
 * 用法: node scripts/simulate-app.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9551;
const WEB_PORT = 5181;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

// 托管 app/www，模拟 APK 内的本地资源加载
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
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--disable-web-security',                 // 模拟 CapacitorHttp 绕过 CORS
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-simapp',
  '--window-size=420,900',
  'about:blank',
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
api.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 200)));
api.send('Runtime.enable');
await sleep(5000);

// 第一步：清空库，完整模拟「首次启动」
const phase1 = `(async () => {
  const m = await import('./app-store.mjs');
  const { db, SOURCES, runScrape } = m.__internal;
  await db.clear();
  const t0 = Date.now();
  const r = await runScrape({ sources: SOURCES, concurrency: 6, onProgress: () => {} });
  const items = await db.allItems();
  return JSON.stringify({
    sources: SOURCES.length,
    scrapeMs: Date.now() - t0,
    result: r,
    stored: items.length,
    dated: items.filter(i => i.publishedAt).length,
    withTitle: items.filter(i => i.title).length,
  });
})()`;

const id1 = api.send('Runtime.evaluate', { expression: phase1, awaitPromise: true, returnByValue: true });
const res1 = await waitForResult(api, id1, 300000);
console.log('=== 首次启动（清空库后完整抓取）===');
try { console.log(JSON.stringify(JSON.parse(res1?.result?.value), null, 1)); }
catch { console.log(res1?.result?.value || JSON.stringify(res1).slice(0, 600)); }

// 第二步：通过界面搜索（模拟用户操作）
const phase2 = `(async () => {
  const out = { steps: [] };
  const rec = (k, v) => out.steps.push(k + ' => ' + v);
  const cards = () => [...document.querySelectorAll('.card')];
  const input = document.getElementById('searchInput');
  rec('界面卡片', cards().length);
  rec('副标题', document.getElementById('brandSub')?.textContent || '');

  for (const kw of ['奖学金', '选课', '推免', '考试', '国家奖学金']) {
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const meta = document.getElementById('listMeta')?.textContent || '';
    rec('搜索[' + kw + ']', meta || '(无结果)');
  }
  // 恢复
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));

  // 侧栏情况
  rec('侧栏栏目数', document.querySelectorAll('.cat-item').length);
  rec('置顶项', [...document.querySelectorAll('.cat-item')].slice(0,2)
    .map(e => (e.querySelector('.nm')?.textContent||'').trim()+'('+(e.querySelector('.ct')?.textContent||'').trim()+')').join(' '));
  return JSON.stringify(out, null, 1);
})()`;

const id2 = api.send('Runtime.evaluate', { expression: phase2, awaitPromise: true, returnByValue: true });
const res2 = await waitForResult(api, id2, 120000);
console.log('\n=== 界面搜索（模拟用户操作）===');
console.log(res2?.result?.value || JSON.stringify(res2).slice(0, 800));

if (errors.length) {
  console.log('\n=== 页面异常 ===');
  for (const e of errors.slice(0, 6)) console.log('  ' + e);
}

cleanup();
process.exit(0);
