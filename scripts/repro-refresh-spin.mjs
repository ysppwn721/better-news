/**
 * 复现「点了刷新按钮后一直转」。
 *
 * 测的是 App 真实路径（app/www + app-store.mjs，走 IndexedDB 与本机抓取）：
 *   点 #btnFetch → 轮询 #btnFetch 是否还带 .spin 类 → 记录停下来的时刻与原因
 * 同时记录运行时状态的变化（fetching / background / lastResult），
 * 以判断是「抓取真的没结束」还是「界面没收到结束信号」。
 *
 * 用法: node scripts/repro-refresh-spin.mjs [url] [最多观察秒=240]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9553;
const WEB_PORT = 5183;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const OBSERVE_S = Number(process.argv[3] || 240);

// 用与 APK 相同的方式托管 app/www
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
  '--disable-web-security',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-spin-repro',
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

const evaluate = async (expr, timeout = 120000) => {
  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, timeout);
  if (res?.exceptionDetails) return { __error: res.exceptionDetails.exception?.description };
  return res?.result?.value;
};

console.log('等待首屏…');
for (let i = 0; i < 60; i++) {
  const ready = await evaluate(`!!(document.querySelectorAll('.card').length)`);
  if (ready === true) break;
  await sleep(1000);
}
console.log('首屏就绪，开始观测刷新按钮\n');

const out = await evaluate(`(async () => {
  const { data } = await import('./app-store.mjs');
  const btn = document.getElementById('btnFetch');
  const log = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);

  log.push({ t: at(), ev: '点击刷新前', spin: btn.classList.contains('spin'), fetching: (await data.fetchStatus()).fetching });

  btn.click();

  let stopped = null, lastFetching = null, lastBackground = null, samples = 0;
  const deadline = ${OBSERVE_S} * 1000;
  while (performance.now() - t0 < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const st = await data.fetchStatus();
    const spin = btn.classList.contains('spin');
    samples++;
    if (st.fetching !== lastFetching || st.background !== lastBackground) {
      lastFetching = st.fetching; lastBackground = st.background;
      log.push({ t: at(), ev: '状态变化', spin, fetching: st.fetching, background: st.background,
                 progress: st.progress ? st.progress.done + '/' + st.progress.total : null });
    }
    if (!spin && stopped === null) {
      stopped = at();
      log.push({ t: at(), ev: '按钮已停止转动', fetching: st.fetching, background: st.background,
                 lastResult: st.lastResult ? JSON.stringify(st.lastResult).slice(0, 120) : null });
      break;
    }
  }
  const st = await data.fetchStatus();
  return JSON.stringify({
    stoppedAtMs: stopped,
    samples,
    stillSpinning: btn.classList.contains('spin'),
    finalFetching: st.fetching,
    finalBackground: st.background,
    lastRun: st.lastRun,
    progress: st.progress,
    log
  }, null, 1);
})()`, (OBSERVE_S + 60) * 1000);

console.log(out);
if (errors.length) { console.log('\n页面异常:'); errors.slice(0, 5).forEach((e) => console.log('  ' + e)); }
cleanup();
process.exit(0);
