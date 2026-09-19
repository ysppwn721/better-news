/**
 * 验证 App 端跨运行去重：连续抓取两次，检查第二条是否被正确识别为已存在。
 *
 * 背景：学院把同一通知发在多个栏目下会产生多个 URL。
 * 第一轮抓取时 A、B 栏目都收录该通知，标题去重保留一个（如 A）；
 * 第二轮若抓取顺序变化或某个栏目下架，可能留下 B，于是判定为「新条目」，
 * 库里最终出现同标题的两条记录 —— 用户看到重复。
 *
 * 用法: node scripts/test-app-dedupe.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9511;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

// 托管 app/www
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
}).listen(5180);`;
const server = spawn('node', ['-e', serverCode], { stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-web-security',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-dedupe',
  'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { server.kill(); } catch {} try { chrome.kill(); } catch {} };
process.on('exit', cleanup);

await sleep(3200);
let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('http://127.0.0.1:5180/')}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
const api = await connectCdp(target.webSocketDebuggerUrl);
api.send('Runtime.enable');
await sleep(3500);

// 只抓计算机学院（快），连续抓两次，检查第二轮是否新增
const expr = `(async () => {
  const out = { steps: [] };
  const rec = (k, v) => out.steps.push(k + ' => ' + v);
  const m = await import('./app-store.mjs');
  const { runScrape, db, SOURCES } = m.__internal;
  const targets = SOURCES.filter(s => s.id.startsWith('col-cst'));
  rec('目标信源', targets.length + ' 个');

  await db.clear();
  rec('清空后条目', await db.count());

  const r1 = await runScrape({ sources: targets, concurrency: 5, onProgress: () => {} });
  rec('第1轮', JSON.stringify(r1));
  rec('第1轮后库内', await db.count());

  // 统计库内同标题重复
  const items1 = await db.allItems();
  const dup1 = items1.length - new Set(items1.map(i => i.title.replace(/\\s+/g,''))).size;
  rec('第1轮后同标题重复数', dup1);

  const r2 = await runScrape({ sources: targets, concurrency: 5, onProgress: () => {} });
  rec('第2轮（应为 inserted=0）', JSON.stringify(r2));
  const items2 = await db.allItems();
  rec('第2轮后库内', items2.length);
  const dup2 = items2.length - new Set(items2.map(i => i.title.replace(/\\s+/g,''))).size;
  rec('第2轮后同标题重复数', dup2);

  const r3 = await runScrape({ sources: targets, concurrency: 5, onProgress: () => {} });
  rec('第3轮（应为 inserted=0）', JSON.stringify(r3));
  const items3 = await db.allItems();
  rec('第3轮后库内', items3.length);

  // 若仍有重复，列出示例
  const seen = new Map();
  for (const it of items3) {
    const k = it.title.replace(/\\s+/g, '');
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(it);
  }
  const dups = [...seen.entries()].filter(([, v]) => v.length > 1);
  out.dups = dups.slice(0, 5).map(([t, v]) => t.slice(0, 30) + ' × ' + v.length);
  rec('重复组数', dups.length);
  return JSON.stringify(out, null, 2);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 180000);
console.log(res?.result?.value || JSON.stringify(res).slice(0, 900));
if (res?.exceptionDetails) console.log('异常:', JSON.stringify(res.exceptionDetails).slice(0, 400));
api.close();
process.exit(0);
