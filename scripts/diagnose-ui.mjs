/**
 * 诊断前端交互：分栏切换、搜索过滤。
 * 用法: node scripts/diagnose-ui.mjs <url>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5178/';
const PORT = 9481;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-diag-ui',
  '--window-size=1440,950',
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
const api = await connectCdp(target.webSocketDebuggerUrl);
const errors = [];
api.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
api.send('Runtime.enable');
await sleep(6000);

const script = `(async () => {
  const out = { log: [] };
  const rec = (k,v) => out.log.push(k + ' => ' + v);
  const catItems = () => [...document.querySelectorAll('.cat-item')];
  const cards = () => [...document.querySelectorAll('.card')];

  rec('初始卡片数', cards().length);
  rec('栏目数', catItems().length);

  // ---- 1. 模拟点击一个分栏（如「教务选课」）----
  const target = catItems().find(e => e.textContent.includes('教务选课'));
  if (!target) { rec('分栏点击', '未找到教务选课'); }
  else {
    const before = cards().length;
    target.click();
    await new Promise(r => setTimeout(r, 1200));
    const after = cards().length;
    rec('点击教务选课', '卡片 ' + before + ' -> ' + after);
    rec('该分栏导航是否高亮', target.classList.contains('active'));
    // 检查卡片是否真属于该栏目
    const cats = [...new Set(cards().map(c => c.querySelector('.tag.cat')?.textContent).filter(Boolean))];
    rec('显示的卡片所属栏目', cats.join(','));
    rec('左侧导航中高亮的项', catItems().filter(e=>e.classList.contains('active')).map(e=>e.querySelector('.nm')?.textContent).join(','));
    rec('listMeta', document.getElementById('listMeta')?.textContent);
  }

  // ---- 2. 搜索测试 ----
  const tests = ['选课', '奖学金', '推免', '国家奖学金', '教务'];
  const input = document.getElementById('searchInput');
  for (const kw of tests) {
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const n = cards().length;
    const titles = cards().slice(0, 3).map(c => c.querySelector('.card-title')?.textContent?.slice(0, 26) || '');
    rec('搜索「' + kw + '」', n + ' 条 | ' + titles.join(' / '));
  }
  // 清空
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));

  // ---- 3. 检查数据里是否真有正文（搜索依赖它）----
  const m = await import('./store.js');
  const d = m.data;
  await d.loadItems();
  const items = d.items;
  rec('数据层条目数', items.length);
  const withExcerpt = items.filter(i => i.excerpt && i.excerpt.length > 30).length;
  rec('有摘要的条目', withExcerpt + '/' + items.length);
  const sample = items.find(i => i.title.includes('选课'));
  rec('样例(选课)', sample ? sample.title.slice(0,30) + ' | excerpt长度=' + (sample.excerpt||'').length + ' | bodyText=' + (sample.bodyText||'').length : '未找到');
  // 搜索用的字段实际是什么
  rec('条目字段', sample ? Object.keys(sample).join(',') : '-');
  out.ok = true;
  return JSON.stringify(out, null, 2);
})()`;

const id = api.send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 90000);
console.log('=== UI 诊断 ===');
console.log(res?.result?.value || JSON.stringify(res).slice(0, 800));
if (errors.length) { console.log('\n异常:'); errors.slice(0,5).forEach(e => console.log('  ' + String(e).slice(0, 200))); }
api.close();
process.exit(0);
