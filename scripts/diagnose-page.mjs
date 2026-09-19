/**
 * 在页面上下文里直接跑诊断：手动调用数据层，看哪一步失败。
 * 用法: node scripts/diagnose-page.mjs <url>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const url = process.argv[2];
const PORT = 9461;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-diag',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

await sleep(2500);
let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
const api = await connectCdp(target.webSocketDebuggerUrl);
api.send('Runtime.enable');
await sleep(9000);

// 逐步手动执行数据层逻辑，定位失败点
const script = `(async () => {
  const log = [];
  const rec = (step, val) => log.push(step + ' => ' + val);
  try {
    rec('mode', 'start');
    const mod = await import('./store.js');
    rec('import store.js', 'ok');
    const d = mod.data;
    await d.init();
    rec('data.init()', 'ok, mode=' + d.mode);
    rec('index.total', d.index?.total);
    rec('index.categories', (d.index?.categories || []).length);
    await d.loadItems();
    rec('loadItems()', 'ok, items=' + d.items.length);
    const first = d.items[0];
    rec('first item', first ? (first.title || '').slice(0, 30) : 'none');
    rec('stateStore.isRead', typeof mod.stateStore.isRead + ' / ' + mod.stateStore.isRead(first));
  } catch (e) {
    rec('EXCEPTION', e && (e.stack || e.message || String(e)));
  }
  return JSON.stringify(log, null, 2);
})()`;

const id = api.send('Runtime.evaluate', {
  expression: script,
  awaitPromise: true,
  returnByValue: true,
});
const res = await waitForResult(api, id, 60000);

console.log('=== 页面内诊断 ===');
console.log(res?.result?.value || JSON.stringify(res));
if (res?.exceptionDetails) console.log('异常:', JSON.stringify(res.exceptionDetails).slice(0, 800));

api.close();
process.exit(0);
