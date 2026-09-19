/**
 * 深挖搜索失效的根因：对比「数据命中数」与「界面渲染数」，并给出逐步追踪。
 * 用法: node scripts/diagnose-search.mjs [url]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';
import { ensureServer } from './lib/ensure-server.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5178/';
const PORT = 9493;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

// 关键：先确认服务可用，否则测出来全是 0，会把「服务挂了」误判成「功能有 bug」
if (url.includes('127.0.0.1') || url.includes('localhost')) {
  const s = await ensureServer();
  if (!s.ok) {
    console.error('✗ 本地服务不可用，测试中止（避免把服务故障误判为功能缺陷）');
    process.exit(2);
  }
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-search2',
  '--window-size=1400,900',
  'about:blank',
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
if (!target) { console.error('无法连接 Chrome'); process.exit(1); }

const api = await connectCdp(target.webSocketDebuggerUrl);
const errors = [];
api.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
api.on('Log.entryAdded', (p) => { if (p.entry?.level === 'error') errors.push('log: ' + p.entry.text); });
api.send('Runtime.enable');
api.send('Log.enable');
await sleep(7000);

const expr = String.raw`(async () => {
  const out = { steps: [] };
  const rec = (k, v) => out.steps.push(k + ' => ' + v);
  try {
    const mod = await import('./store.js');
    const items = mod.data.items;
    const KW = '\u5956\u5b66\u91d1'; // 奖学金

    rec('数据层条目数', items.length);
    rec('标题命中', items.filter(i => i.title.includes(KW)).length);
    rec('摘要命中', items.filter(i => (i.excerpt || '').includes(KW)).length);
    rec('按前端条件命中', items.filter(i =>
      i.title.toLowerCase().includes(KW) ||
      (i.excerpt || '').toLowerCase().includes(KW) ||
      (i.sourceName || '').toLowerCase().includes(KW) ||
      (i.tags || []).some(t => t.toLowerCase().includes(KW))
    ).length);

    const input = document.getElementById('searchInput');
    rec('搜索框存在', !!input);
    if (!input) return JSON.stringify(out, null, 2);

    const snap = (tag) => tag + ': 值=' + JSON.stringify(input.value)
      + ' 卡片=' + document.querySelectorAll('.card').length
      + ' meta=' + (document.getElementById('listMeta')?.textContent || '');

    out.trace = [];
    out.trace.push(snap('初始'));

    input.value = KW;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    out.trace.push(snap('事件刚触发'));
    await new Promise(r => setTimeout(r, 400));
    out.trace.push(snap('400ms'));
    await new Promise(r => setTimeout(r, 800));
    out.trace.push(snap('1200ms'));

    // 用 Enter 再试一次（绕过防抖）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    out.trace.push(snap('Enter 后'));

    // 直接看当前渲染出来的卡片标题，确认是否相关
    out.渲染的标题 = [...document.querySelectorAll('.card-title')].slice(0, 5).map(e => e.textContent.slice(0, 30));
    // 检查已选筛选条件（可能叠加了别的过滤）
    out.当前筛选 = document.getElementById('activeFilters')?.textContent || '(无)';
    out.左侧高亮 = [...document.querySelectorAll('.cat-item.active')].map(e => e.querySelector('.nm')?.textContent).join(',');
    out.快速筛选激活 = [...document.querySelectorAll('.qf.active')].map(e => e.textContent).join(',');

    out.ok = true;
  } catch (e) {
    rec('EXCEPTION', e && (e.stack || e.message));
    out.ok = false;
  }
  return JSON.stringify(out, null, 2);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 90000);

console.log('=== 搜索结果诊断 ===');
if (res?.result?.value) {
  try { console.log(JSON.stringify(JSON.parse(res.result.value), null, 2)); }
  catch { console.log(res.result.value); }
} else {
  console.log('未取到结果:', JSON.stringify(res).slice(0, 800));
}
if (errors.length) {
  console.log('\n=== 页面异常 ===');
  for (const e of errors.slice(0, 8)) console.log('  ' + String(e).slice(0, 240));
}
api.close();
process.exit(0);
