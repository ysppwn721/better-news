/**
 * 关注面板的移动端体检：触控目标尺寸、横向溢出、toast 是否遮挡。
 * 用法: node scripts/check-watch-mobile.mjs [url]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5179/';
const OUT = resolve('data/logs');
mkdirSync(OUT, { recursive: true });
const PORT = 9499;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-watch-mobile',
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
await sleep(2800);

let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
const api = await connectCdp(target.webSocketDebuggerUrl);
const errors = [];
api.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 200)));
api.send('Runtime.enable');
api.send('Page.enable');
api.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
api.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

const evaluate = async (expr, timeout = 60000) => {
  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, timeout);
  if (res?.exceptionDetails) return { __error: res.exceptionDetails.exception?.description };
  return res?.result?.value;
};
const shot = async (name) => {
  const id = api.send('Page.captureScreenshot', { format: 'png' });
  const res = await waitForResult(api, id, 20000);
  if (res?.data) { const p = resolve(OUT, `wm-${name}.png`); writeFileSync(p, Buffer.from(res.data, 'base64')); return p; }
};

await evaluate(`(() => { for (const k of ['bn.watched','bn.watchKeywords','bn.watchPrefs']) localStorage.removeItem(k); location.reload(); return 1; })()`);
await sleep(8000);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`document.querySelectorAll('.card').length > 0`)) break;
  await sleep(1000);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`); ok ? pass++ : fail++; };

// 造点数据：关注一条 + 加关键词
await evaluate(`(async () => {
  document.querySelector('.card .watch-btn').click();
  await new Promise(r => setTimeout(r, 400));
  document.querySelector('.mnav-btn[data-target="watch"]').click();
  await new Promise(r => setTimeout(r, 400));
  document.getElementById('kwInput').value = '选课';
  document.getElementById('btnKwAdd').click();
  await new Promise(r => setTimeout(r, 1200));
  return 1;
})()`);

console.log('=== 关注面板：触控目标 ===');
const r = await evaluate(`(() => {
  const panel = document.getElementById('watchPanel');
  const targets = [];
  const sel = '#btnKwAdd, #btnExportIcs, #btnCopyIcs, #btnClearAuto, #btnClearAllWatch, #setLeadDays, #setReminderHour, .kw-del, .watch-acts .icon-btn, .watch-btn, .mnav-btn';
  for (const el of panel.querySelectorAll(sel.split(',').map(s => s.trim()).join(','))) {
    const b = el.getBoundingClientRect();
    if (b.width === 0) continue;
    targets.push({
      what: (el.id || el.className || el.tagName).toString().slice(0, 26),
      w: Math.round(b.width), h: Math.round(b.height)
    });
  }
  const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
  const inp = document.getElementById('kwInput').getBoundingClientRect();
  return JSON.stringify({
    targets,
    tooSmall: targets.filter(t => t.h < 30),
    scrollW: document.documentElement.scrollWidth,
    innerW: innerWidth,
    navRect: { top: Math.round(nav.top), bottom: Math.round(nav.bottom) },
    kwInput: { top: Math.round(inp.top), h: Math.round(inp.height) }
  });
})()`);
const o = JSON.parse(r);
console.log('  ', r.slice(0, 900));
check('无横向溢出', o.scrollW <= o.innerW + 1, `${o.scrollW} / ${o.innerW}`);
check('所有可见控件高度 ≥ 30px', o.tooSmall.length === 0,
  o.tooSmall.length ? o.tooSmall.map(t => `${t.what}=${t.w}×${t.h}`).join(', ') : `${o.targets.length} 个控件`);
await shot('1-panel');

console.log('\n=== toast 不遮挡底部导航 ===');
const t = await evaluate(`(async () => {
  // 触发一次 toast 并量它的位置
  document.getElementById('btnWatchClose').click();
  await new Promise(r => setTimeout(r, 200));
  const card = document.querySelector('.card .watch-btn');
  card.click();                        // 会弹「已加入关注」提示
  await new Promise(r => setTimeout(r, 400));
  const toast = document.getElementById('toast');
  const tb = toast.getBoundingClientRect();
  const nb = document.querySelector('.mobile-nav').getBoundingClientRect();
  return JSON.stringify({
    visible: !toast.classList.contains('hidden'),
    toast: { top: Math.round(tb.top), bottom: Math.round(tb.bottom), h: Math.round(tb.height) },
    navTop: Math.round(nb.top),
    overlapsNav: tb.bottom > nb.top,
    withinViewport: tb.top >= 0 && tb.bottom <= innerHeight
  });
})()`);
console.log('  ', t);
const to = JSON.parse(t);
check('toast 已弹出', to.visible === true);
check('toast 不压住底部导航', to.overlapsNav === false, `toast.bottom=${to.toast.bottom} navTop=${to.navTop}`);
check('toast 完全在可视区内', to.withinViewport === true);
await shot('2-toast');

console.log('\n=== 底部导航 5 个 tab ===');
const n = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('.mnav-btn')];
  return JSON.stringify({
    count: btns.length,
    labels: btns.map(b => b.textContent.replace(/\\s+/g, ' ').trim()),
    sizes: btns.map(b => { const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); }),
    overflow: document.documentElement.scrollWidth > innerWidth + 1
  });
})()`);
console.log('  ', n);
const no = JSON.parse(n);
check('底部导航有 5 个 tab', no.count === 5, no.labels.join(' | '));
check('含「关注」tab', no.labels.some(l => l.includes('关注')));
check('tab 未造成横向溢出', no.overflow === false);

console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
console.log('页面异常:', errors.length ? errors.slice(0, 3).join(' | ') : '（无）');
api.close();
process.exit(fail ? 1 : 0);
