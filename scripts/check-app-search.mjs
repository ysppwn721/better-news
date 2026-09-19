/**
 * 验证 App 端关键搜索词能否命中（含校园口语别名）。
 * 用法: node scripts/check-app-search.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9601;
const WEB_PORT = 5186;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const serverCode = `
const http=require('http'),fs=require('fs'),path=require('path');
const root=${JSON.stringify(resolve(ROOT, 'app/www').replace(/\\/g, '/'))};
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json'};
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
  '--user-data-dir=' + process.env.TEMP + '\\bn-appsearch',
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
const api = await connectCdp(target.webSocketDebuggerUrl);
api.send('Runtime.enable');
await sleep(4000);

// 先把数据抓齐（列表阶段，覆盖 6 个月，翻页上限与应用里一致）
const seed = `(async () => {
  const m = await import('./app-store.mjs');
  const { db, SOURCES, runScrape } = m.__internal;
  await db.clear();
  const r = await runScrape({ sources: SOURCES, concurrency: 6, sinceMonths: 6, maxPages: 16, bodyBudget: 0, onProgress: () => {} });
  const items = await db.allItems();
  return JSON.stringify({ total: items.length, cst: items.filter(i => i.sourceId?.startsWith('col-cst')).length, failed: r.failed.length });
})()`;
const id0 = api.send('Runtime.evaluate', { expression: seed, awaitPromise: true, returnByValue: true });
const r0 = await waitForResult(api, id0, 600000);
console.log('=== 抓取结果 ===');
console.log('  ' + (r0?.result?.value || '(失败)'));

// 再通过界面搜索
const expr = `(async () => {
  const out = {};
  const input = document.getElementById('searchInput');
  const cards = () => [...document.querySelectorAll('.card')];
  const titleOf = (c) => c.querySelector('.card-title')?.textContent || '';
  const cases = ['综测', '选课', '综合素质测评', '奖学金', '推免', '保研', '四六级', '体测', '考试', '公示'];
  for (const kw of cases) {
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const titles = cards().map(titleOf);
    out[kw] = {
      总数: (document.getElementById('listMeta')?.textContent || '(无)'),
      示例: titles.slice(0, 3).map(t => t.slice(0, 30)),
    };
  }
  return JSON.stringify(out, null, 1);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 120000);
console.log('\n=== 界面搜索（按标题 + 别名）===');
try {
  const d = JSON.parse(res?.result?.value);
  for (const [kw, v] of Object.entries(d)) {
    console.log(`  「${kw}」 ${v.总数}`);
    for (const t of v.示例) console.log(`      · ${t}`);
  }
} catch {
  console.log(res?.result?.value || JSON.stringify(res).slice(0, 800));
}

cleanup();
process.exit(0);
