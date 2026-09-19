/**
 * 调试「点全部通知后筛选未清除」的问题。
 * 用法: node scripts/debug-reset.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';
import { ensureServer } from './lib/ensure-server.mjs';

const PORT = 9541;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

await ensureServer({ quiet: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-reset',
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

await sleep(3000);
let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('http://127.0.0.1:5178/')}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
const api = await connectCdp(target.webSocketDebuggerUrl);
api.send('Runtime.enable');
await sleep(7000);

const expr = `(async () => {
  const out = [];
  const rec = (k, v) => out.push(k + ' => ' + v);
  const meta = () => document.getElementById('listMeta')?.textContent || '(空)';
  const cards = () => document.querySelectorAll('.card').length;
  const catItems = () => [...document.querySelectorAll('.cat-item')];
  const star = () => catItems().find(e => (e.querySelector('.nm')?.textContent || '').includes('计算机'));
  const allBtn = () => catItems().find(e => (e.querySelector('.nm')?.textContent || '').trim() === '全部通知');

  rec('初始', meta() + ' 卡片=' + cards());

  // 点置顶
  star()?.click();
  await new Promise(r => setTimeout(r, 1200));
  rec('点置顶后', meta() + ' 卡片=' + cards());

  // 点全部通知
  const ab = allBtn();
  rec('找到全部通知按钮', !!ab);
  ab?.click();
  await new Promise(r => setTimeout(r, 1200));
  rec('点全部通知后', meta() + ' 卡片=' + cards());
  rec('高亮项', catItems().filter(e => e.classList.contains('active'))
    .map(e => (e.querySelector('.nm')?.textContent || '').trim()).join('|') || '(无)');
  rec('活动筛选标签', (document.getElementById('activeFilters')?.textContent || '').trim() || '(无)');

  // 直接看重新点一次的效果
  allBtn()?.click();
  await new Promise(r => setTimeout(r, 1200));
  rec('再点一次全部通知', meta() + ' 卡片=' + cards());
  rec('高亮项2', catItems().filter(e => e.classList.contains('active'))
    .map(e => (e.querySelector('.nm')?.textContent || '').trim()).join('|') || '(无)');

  return out.join('\\n');
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 60000);
console.log(res?.result?.value || JSON.stringify(res).slice(0, 900));
api.close();
process.exit(0);
