/**
 * 检查 App 抓取详情时正文为何为空。
 * 对比 Node 端与 App 端对同一详情页的解析结果。
 * 用法: node scripts/check-detail-parse.mjs [url]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';
import { HttpClient } from '../src/core/http.mjs';
import { parseDetail } from '../src/sources/cms.mjs';

const url = process.argv[2] || 'http://cst.nuc.edu.cn/info/1035/12783.htm';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9591;
const WEB_PORT = 5185;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

// Node 端解析
const client = new HttpClient({ timeoutMs: 25000 });
const { html } = await client.fetchHtml(url);
const nodeDetail = parseDetail(html, url);
console.log('=== Node 端解析详情 ===');
console.log(`  页面 ${html.length} 字节`);
console.log(`  标题: ${nodeDetail.title}`);
console.log(`  正文长度: ${(nodeDetail.bodyText || '').length}`);
console.log(`  HTML 长度: ${(nodeDetail.bodyHtml || '').length}`);
console.log(`  受限: ${nodeDetail.restricted}`);
console.log(`  正文片段: ${(nodeDetail.bodyText || '').slice(0, 80).replace(/\n/g, ' ')}`);

// App 端解析同一页面
const serverCode = `
const http=require('http'),fs=require('fs'),path=require('path');
const root=${JSON.stringify(resolve(ROOT, 'app/www').replace(/\\/g, '/'))};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);
  if(p==='/')p='/index.html';
  const f=path.join(root,p);
  fs.readFile(f,(e,d)=>{
    if(e){res.writeHead(404);res.end('x');return;}
    res.writeHead(200,{'Content-Type':p.endsWith('.mjs')||p.endsWith('.js')?'text/javascript':'text/html'});
    res.end(d);
  });
}).listen(${WEB_PORT});`;

const server = spawn('node', ['-e', serverCode], { stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-web-security',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-detail',
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
  const d = s.parseDetail(html, ${JSON.stringify(url)}, {});
  return JSON.stringify({
    htmlLen: html.length,
    title: d.title,
    bodyLen: (d.bodyText || '').length,
    bodyHtmlLen: (d.bodyHtml || '').length,
    restricted: !!d.restricted,
    bodyHead: (d.bodyText || '').slice(0, 80),
  }, null, 1);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 90000);
console.log('\n=== App 端解析同一详情页 ===');
console.log(res?.result?.value || JSON.stringify(res).slice(0, 700));

cleanup();
process.exit(0);
