/**
 * 在真实浏览器里验证 App 的抓取链路。
 *
 * 用 --disable-web-security 模拟 Capacitor 的原生 HTTP：
 * 原生请求不受 CORS 约束，而浏览器默认会拦截对学校站点的跨域 fetch。
 * 这样能在打包成 APK 之前，先把「列表解析 → 打标 → 落库」整条链路跑通。
 *
 * 用法: node scripts/test-app-scrape.mjs [--full]
 *   默认只抓计算机学院的两个栏目（快）；--full 抓全部 49 个信源
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const PORT = 9471;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

// 静态服务：托管 app/www
const serverCode = `
const http=require('http'),fs=require('fs'),path=require('path');
const root=${JSON.stringify(resolve(ROOT, 'app/www').replace(/\\/g, '/'))};
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);
  if(p==='/')p='/index.html';
  const f=path.join(root,p);
  fs.readFile(f,(e,d)=>{
    if(e){res.writeHead(404);res.end('not found');return;}
    res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'});
    res.end(d);
  });
}).listen(5179);
`;
const server = spawn('node', ['-e', serverCode], { stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--disable-web-security',            // 模拟原生 HTTP：绕过 CORS
  '--user-data-dir=' + process.env.TEMP + '\\bn-apptest',
  `--remote-debugging-port=${PORT}`,
  '--window-size=420,900',
  'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { server.kill(); } catch {} try { chrome.kill(); } catch {} };
process.on('exit', cleanup);

await sleep(3200);

let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('http://127.0.0.1:5179/')}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
if (!target) { console.error('无法连接 Chrome'); process.exit(1); }

const api = await connectCdp(target.webSocketDebuggerUrl);
const errors = [];
api.on('Runtime.exceptionThrown', (p) => {
  errors.push(`[异常] ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
});
api.on('Log.entryAdded', (p) => {
  if (p.entry?.level === 'error') errors.push(`[log] ${(p.entry.text || '').slice(0, 200)}`);
});
api.send('Runtime.enable');
api.send('Log.enable');
api.send('Page.enable');

await sleep(3500);

const filterExpr = full
  ? 'm.__internal.SOURCES'
  : "m.__internal.SOURCES.filter(s => s.id.startsWith('col-cst'))";

const expr = `(async () => {
  const out = { steps: [] };
  const log = (k, v) => out.steps.push(k + ' => ' + v);
  try {
    const m = await import('./app-store.mjs');
    const { runScrape, db, SOURCES } = m.__internal;
    log('import', 'ok, sources=' + SOURCES.length);

    await m.data.init();
    log('init', 'ok, items=' + m.data.items.length);

    const targets = ${filterExpr};
    log('targets', targets.map(t => t.name).join(' , '));

    const t0 = Date.now();
    const res = await runScrape({ sources: targets, concurrency: 4, onProgress: () => {} });
    log('scrape', JSON.stringify(res));
    log('scrapeMs', Date.now() - t0);

    const items = await db.allItems();
    log('dbCount', items.length);
    log('datedRatio', items.filter(i => i.publishedAt).length + '/' + items.length);
    log('sample', items.slice(0, 6).map(i => (i.publishedAt || '无') + ' ' + i.title.slice(0, 34)).join('\\n     '));

    // 再抓一次，验证增量去重（第二次应该 inserted=0）
    const res2 = await runScrape({ sources: targets, concurrency: 4, onProgress: () => {} });
    log('secondRun', 'inserted=' + res2.inserted + ' （应为 0，验证去重）');
    out.ok = true;
  } catch (e) {
    log('EXCEPTION', e && (e.stack || e.message));
    out.ok = false;
  }
  return JSON.stringify(out, null, 2);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 240000);

console.log('=== App 抓取链路测试 ===');
console.log(res?.result?.value || JSON.stringify(res).slice(0, 1200));
if (res?.exceptionDetails) console.log('异常:', JSON.stringify(res.exceptionDetails).slice(0, 600));

if (errors.length) {
  console.log('\n=== 控制台错误 ===');
  for (const e of errors.slice(0, 10)) console.log('  ' + e);
}

cleanup();
process.exit(0);
