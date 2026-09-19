/**
 * 验证「打开 App 多久能看到第一条内容」。
 *
 * 背景：用户反馈「为什么还在抓取」。除了把「后台补正文」阶段从界面的
 * 「正在抓取」里摘出来，更关键的是——抓列表的阶段一以前是「102 个信源全抓完
 * 才一次性入库」，手机上要等 1~3 分钟界面才有内容。现在改成每完成约 10 个信源
 * 就落库一次，这个脚本就是量这件事：首条内容出现在第几秒。
 *
 * 用法: node scripts/check-app-progressive.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9603;
const WEB_PORT = 5187;
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
  '--user-data-dir=' + process.env.TEMP + '\\bn-progressive',
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
if (!target) { cleanup(); throw new Error('无法连接 Chrome'); }

const api = await connectCdp(target.webSocketDebuggerUrl);
api.send('Runtime.enable');
await sleep(4000);

// 清库并启动抓取（不等待），同时轮询库内条数与界面卡片数
const expr = `(async () => {
  const m = await import('./app-store.mjs');
  const { db, SOURCES, runScrape } = m.__internal;
  await db.clear();

  const t0 = Date.now();
  const marks = [];
  let firstItemAt = null;
  let firstCardAt = null;

  const scraping = runScrape({
    sources: SOURCES, concurrency: 6, sinceMonths: 6, maxPages: 16, bodyBudget: 0, onProgress: () => {},
  }).then((r) => { marks.push({ t: Math.round((Date.now() - t0) / 1000), note: '阶段一完成', n: r.total, failed: r.failed.length }); });

  const poll = setInterval(async () => {
    const n = await db.count();
    const cards = document.querySelectorAll('.card').length;
    const sec = Math.round((Date.now() - t0) / 1000);
    if (n > 0 && firstItemAt === null) firstItemAt = sec;
    if (cards > 0 && firstCardAt === null) firstCardAt = sec;
    marks.push({ t: sec, n, cards });
  }, 3000);

  await scraping;
  clearInterval(poll);
  return JSON.stringify({ firstItemAt, firstCardAt, elapsed: Math.round((Date.now() - t0) / 1000), marks }, null, 1);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 900000);
api.close();
cleanup();

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}  → ${detail}`); }
};

try {
  const d = JSON.parse(res?.result?.value);
  console.log('\n时间线（每 3 秒采样：库内条数 / 界面卡片数）');
  for (const m of d.marks) {
    if (m.note) console.log(`  ${String(m.t).padStart(3)}s  阶段一完成，共 ${m.n} 条，失败 ${m.failed} 个信源`);
    else console.log(`  ${String(m.t).padStart(3)}s  库内 ${String(m.n).padStart(4)} 条 · 卡片 ${m.cards}`);
  }
  console.log(`\n首个条目落库: ${d.firstItemAt ?? '未出现'} 秒`);
  console.log(`界面出现首张卡片: ${d.firstCardAt ?? '未出现'} 秒（界面靠刷新按钮触发重载，不代表抓取进度）`);
  console.log(`阶段一总耗时: ${d.elapsed} 秒`);

  ok('首条内容在 30 秒内落库', d.firstItemAt !== null && d.firstItemAt <= 30, `${d.firstItemAt}s`);
} catch {
  console.log(res?.result?.value || JSON.stringify(res).slice(0, 800));
  fail++;
}

console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
