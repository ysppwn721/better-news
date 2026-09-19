/**
 * 对比 App 端与 Node 端对同一页面的解析结果。
 * 用于定位「App 抓到的条数比网页版少」这类问题。
 * 用法: node scripts/compare-parsers.mjs <url>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';
import { HttpClient } from '../src/core/http.mjs';
import { parseList } from '../src/sources/cms.mjs';

const url = process.argv[2] || 'http://cst.nuc.edu.cn/xwzx/tzgg.htm';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9571;
const WEB_PORT = 5183;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

// ---- Node 端解析 ----
console.log('=== Node 端解析 ===');
const client = new HttpClient({ timeoutMs: 25000 });
const { html: nodeHtml } = await client.fetchHtml(url);
const nodeItems = parseList(nodeHtml, url);
console.log(`  页面 ${nodeHtml.length} 字节 → ${nodeItems.length} 条`);
for (const it of nodeItems.slice(0, 6)) console.log(`    ${it.date || '无日期'}  ${it.title.slice(0, 42)}`);

// ---- App 端解析（同一份 HTML 交给 App 的解析器）----
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
  '--user-data-dir=' + process.env.TEMP + '\\bn-cmp',
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
  const s = await import('./shared.mjs');
  const res = await fetch(${JSON.stringify(url)});
  const html = await res.text();
  const items = s.parseList(html, ${JSON.stringify(url)});
  return JSON.stringify({
    htmlLen: html.length,
    count: items.length,
    items: items.slice(0, 20).map(i => ({ date: i.date, title: i.title.slice(0, 42), url: i.url })),
  }, null, 1);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 90000);
console.log('\n=== App 端解析（同一 URL）===');
try {
  const d = JSON.parse(res?.result?.value);
  console.log(`  页面 ${d.htmlLen} 字节 → ${d.count} 条`);
  for (const it of d.items.slice(0, 6)) console.log(`    ${it.date || '无日期'}  ${it.title}`);
} catch {
  console.log(res?.result?.value || JSON.stringify(res).slice(0, 600));
}

console.log(`\n=== 结论 ===`);
console.log(`  Node 端: ${nodeItems.length} 条`);
cleanup();
process.exit(0);
