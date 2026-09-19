/**
 * 线上站点端到端检查（https://ysppwn721.github.io/better-news/）。
 *
 * 背景：本地测试全绿不代表线上可用——线上读的是 GitHub Pages 上的静态快照，
 * 快照可能是旧的、Pages 可能没重新发布。用户反馈「搜不到」时，先跑这个脚本
 * 确认「线上到底能不能搜到」，再去查代码。
 *
 * 用法: node scripts/check-live.mjs [--url=https://...]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const urlArg = process.argv.find((a) => a.startsWith('--url='));
const URL_ = urlArg ? urlArg.slice(6) : 'https://ysppwn721.github.io/better-news/';
const PORT = 9541;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=390,844',
  '--user-data-dir=' + process.env.TEMP + '\\bn-live',
  'about:blank',
], { stdio: 'ignore' });

await sleep(3200);
let target = null;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' });
    if (res.ok) { target = await res.json(); break; }
  } catch {}
  await sleep(500);
}
if (!target) { chrome.kill(); throw new Error('无法连接 Chrome'); }

const api = await connectCdp(target.webSocketDebuggerUrl);
const pageErrors = [];
api.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
api.send('Runtime.enable');
await sleep(9000);

const expr = `(async () => {
  const out = { url: location.href, steps: [] };
  const rec = (k, v) => out.steps.push(k + ' => ' + v);
  const cards = () => [...document.querySelectorAll('.card')];
  const titleOf = (c) => c.querySelector('.card-title')?.textContent || '';

  rec('视口', window.innerWidth + 'x' + window.innerHeight);
  rec('首屏卡片', cards().length);
  rec('列表统计', document.getElementById('listMeta')?.textContent || '(无)');

  const catNames = [...document.querySelectorAll('.cat-item .nm')].map(e => e.textContent.trim());
  rec('侧栏栏目数', catNames.length);
  rec('置顶学院项', catNames.filter(n => n.includes('计算机')).join(' | ') || '(无)');

  const star = [...document.querySelectorAll('.cat-item')].find(e => (e.querySelector('.nm')?.textContent || '').includes('计算机'));
  if (star) {
    star.click();
    await new Promise(r => setTimeout(r, 1500));
    const srcs = [...new Set(cards().map(c => (c.querySelector('.src')?.textContent || '').trim()))];
    rec('置顶视图', (document.getElementById('listMeta')?.textContent || '') + ' | 来源: ' + srcs.join(' / '));
  }
  const allBtn = [...document.querySelectorAll('.cat-item')].find(e => (e.querySelector('.nm')?.textContent || '').trim() === '全部通知');
  if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 1200)); }

  const input = document.getElementById('searchInput');
  for (const kw of ['综测', '选课', '推免', '四六级', '奖学金', '体测']) {
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1100));
    rec('搜索[' + kw + ']', (document.getElementById('listMeta')?.textContent || '(无结果)')
      + ' | ' + cards().map(titleOf).slice(0, 3).map(t => t.slice(0, 26)).join(' / '));
  }
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 800));
  out.ok = true;
  return JSON.stringify(out, null, 1);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 180000);
api.close();
chrome.kill();

let pass = 0, fail = 0;
try {
  const d = JSON.parse(res?.result?.value);
  console.log(`线上: ${d.url}\n`);
  for (const s of d.steps) console.log('  ' + s);

  const steps = Object.fromEntries(d.steps.map((s) => {
    const i = s.indexOf(' => ');
    return [s.slice(0, i), s.slice(i + 4)];
  }));
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}  → ${detail}`); }
  };
  const meta = (v) => parseInt((v.match(/共 (\d+) 条/) || [])[1] || '0', 10);

  ok('首屏有内容', parseInt(steps['首屏卡片'] || '0', 10) > 0, steps['首屏卡片']);
  ok('侧栏有栏目', parseInt(steps['侧栏栏目数'] || '0', 10) >= 5, steps['侧栏栏目数']);
  ok('置顶学院存在', steps['置顶学院项'] !== '(无)', steps['置顶学院项']);
  ok('置顶视图聚合多来源', (steps['置顶视图'] || '').split('来源: ')[1]?.split(' / ').length >= 3, steps['置顶视图']);
  for (const kw of ['综测', '选课', '推免', '四六级', '奖学金']) {
    ok(`线上搜「${kw}」有结果`, meta(steps[`搜索[${kw}]`] || '') > 0, steps[`搜索[${kw}]`]);
  }
} catch {
  console.log(res?.result?.value || JSON.stringify(res).slice(0, 800));
  fail++;
}

if (pageErrors.length) {
  console.log('\n页面异常:');
  for (const e of pageErrors.slice(0, 5)) console.log('  ' + String(e).slice(0, 160));
  fail++;
}
console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
