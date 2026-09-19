/**
 * 检查界面侧栏各栏目的名称与计数，确认「计算机学院」置顶项显示什么。
 * 用法: node scripts/check-sidebar.mjs [url]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';
import { ensureServer } from './lib/ensure-server.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5178/';
const PORT = 9522;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

if (url.includes('127.0.0.1')) {
  const s = await ensureServer({ quiet: true });
  if (!s.ok) { console.error('服务不可用'); process.exit(2); }
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-sidebar',
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

await sleep(3000);
let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
if (!target) { console.error('无法连接 Chrome'); process.exit(1); }

const api = await connectCdp(target.webSocketDebuggerUrl);
api.send('Runtime.enable');
await sleep(8000);

const expr = `(async () => {
  const out = {};
  // 侧栏栏目
  out.categories = [...document.querySelectorAll('.cat-item')].map(e => ({
    name: (e.querySelector('.nm')?.textContent || '').trim(),
    count: (e.querySelector('.ct')?.textContent || '').trim(),
    active: e.classList.contains('active'),
  }));
  // 信源列表
  out.sources = [...document.querySelectorAll('.source-row')].slice(0, 12).map(e => ({
    name: (e.querySelector('.nm')?.textContent || '').trim(),
    count: (e.querySelector('.ct')?.textContent || '').trim(),
  }));
  // 副标题
  out.sub = document.getElementById('brandSub')?.textContent || '';
  // 点击置顶项看结果
  const star = [...document.querySelectorAll('.cat-item')].find(e => (e.querySelector('.nm')?.textContent || '').includes('计算机'));
  if (star) {
    star.click();
    await new Promise(r => setTimeout(r, 1500));
    out.afterClick = {
      meta: document.getElementById('listMeta')?.textContent || '',
      cards: [...document.querySelectorAll('.card')].slice(0, 6).map(c => ({
        title: (c.querySelector('.card-title')?.textContent || '').slice(0, 34),
        src: (c.querySelector('.src')?.textContent || '').trim(),
      })),
    };
  }
  return JSON.stringify(out, null, 1);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 60000);
console.log(res?.result?.value || JSON.stringify(res).slice(0, 900));
api.close();
process.exit(0);
