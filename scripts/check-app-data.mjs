/**
 * 检查 App 端数据完整性与关键词可搜性。
 *
 * 用法: node scripts/check-app-data.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9561;
const WEB_PORT = 5182;
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
  '--user-data-dir=' + process.env.TEMP + '\\bn-appdata',
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
api.send('Runtime.enable');
await sleep(4000);

// 1) 完整抓取一次，逐信源统计条目数
const expr = `(async () => {
  const m = await import('./app-store.mjs');
  const { db, SOURCES, runScrape } = m.__internal;
  await db.clear();
  const r = await runScrape({ sources: SOURCES, concurrency: 6, onProgress: () => {} });
  const items = await db.allItems();

  const out = { scrape: r, total: items.length };

  // 计算机学院的各栏目条数
  const cst = items.filter(i => i.sourceId && i.sourceId.startsWith('col-cst'));
  const bySrc = {};
  for (const i of cst) bySrc[i.sourceName] = (bySrc[i.sourceName] || 0) + 1;
  out.cstBySource = bySrc;
  out.cstTotal = cst.length;

  // 配置里计算机学院有几个信源、各自抓到多少
  const cstSources = SOURCES.filter(s => s.id.startsWith('col-cst'));
  out.cstConfigured = cstSources.map(s => ({
    id: s.id, name: s.name, url: s.listUrl,
    stored: items.filter(i => i.sourceId === s.id).length,
  }));

  // 关键关键词在标题中的命中数
  const kws = ['综测', '综合素质测评', '选课', '奖学金', '推免', '考试', '体测', '德育', '公示'];
  out.keywordHits = {};
  for (const kw of kws) {
    out.keywordHits[kw] = {
      title: items.filter(i => (i.title || '').includes(kw)).length,
      excerpt: items.filter(i => (i.excerpt || '').includes(kw)).length,
    };
  }

  // 计算机学院里含「选课」「综测」的条目
  out.cstSamples = {
    选课: cst.filter(i => (i.title || '').includes('选课')).map(i => i.title.slice(0, 40)).slice(0, 5),
    综测: cst.filter(i => (i.title || '').includes('综测')).map(i => i.title.slice(0, 40)).slice(0, 5),
    综合素质: cst.filter(i => (i.title || '').includes('综合素质')).map(i => i.title.slice(0, 40)).slice(0, 5),
  };

  return JSON.stringify(out, null, 1);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 300000);
console.log(res?.result?.value || JSON.stringify(res).slice(0, 1200));

cleanup();
process.exit(0);
