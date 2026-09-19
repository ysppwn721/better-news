/**
 * 检查 App 存储后正文是否保留（关系到搜索与详情阅读）。
 * 用法: node scripts/check-app-body.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9581;
const WEB_PORT = 5184;
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
  '--user-data-dir=' + process.env.TEMP + '\\bn-body',
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
await sleep(3500);

const expr = `(async () => {
  const m = await import('./app-store.mjs');
  const { db, SOURCES, runScrape, fetchDetail } = m.__internal;
  const out = {};

  await db.clear();

  // 1) 只抓列表（App 的常规路径）
  await runScrape({ sources: SOURCES.filter(s => s.id.startsWith('col-cst')), concurrency: 4, onProgress: () => {} });
  let items = await db.allItems();
  out.afterListScrape = {
    count: items.length,
    withBody: items.filter(i => (i.bodyText || '').length > 30).length,
    withExcerpt: items.filter(i => (i.excerpt || '').length > 30).length,
    sampleFields: items[0] ? Object.keys(items[0]).join(',') : '-',
  };

  // 2) 抓一次详情，看正文是否写入
  const one = items[0];
  const detail = await fetchDetail(one.url, { title: one.title, date: one.publishedAt });
  out.detailFetch = {
    url: one.url.slice(0, 60),
    title: detail ? (detail.title || '').slice(0, 40) : null,
    bodyLen: detail ? (detail.bodyText || '').length : 0,
    htmlLen: detail ? (detail.bodyHtml || '').length : 0,
    restricted: detail ? !!detail.restricted : null,
    attachments: detail ? (detail.attachments || []).length : 0,
  };

  // 3) 带详情抓取（triggerFetch 的第二阶段）
  await db.clear();
  await runScrape({ sources: SOURCES.filter(s => s.id.startsWith('col-cst')), concurrency: 4, fetchDetails: true, detailLimit: 6, onProgress: () => {} });
  items = await db.allItems();
  out.afterDetailScrape = {
    count: items.length,
    withBody: items.filter(i => (i.bodyText || '').length > 30).length,
    withExcerpt: items.filter(i => (i.excerpt || '').length > 30).length,
    bodyLenMax: Math.max(0, ...items.map(i => (i.bodyText || '').length)),
  };

  // 4) 详情加载路径：loadDetail 能否拿到正文
  await m.data.init();
  const first = m.data.items[0];
  const d = await m.data.loadDetail(first.id);
  out.loadDetail = {
    id: first.id,
    title: first.title.slice(0, 36),
    bodyLen: (d.bodyText || '').length,
    htmlLen: (d.bodyHtml || '').length,
  };

  return JSON.stringify(out, null, 1);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 300000);
console.log(res?.result?.value || JSON.stringify(res).slice(0, 1200));
cleanup();
process.exit(0);
