/**
 * 调试「困难认定」为何搜不到：检查数据里该条目的实际文本，并逐步验证分词匹配。
 * 用法: node scripts/debug-search-kw.mjs [关键词]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';
import { ensureServer } from './lib/ensure-server.mjs';

const KW = process.argv[2] || '困难认定';
const PORT = 9505;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const srv = await ensureServer({ quiet: true });
if (!srv.ok) { console.error('服务不可用'); process.exit(2); }

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-kw',
  'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

await sleep(2800);
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
await sleep(6500);

// 在页面里复现 matchesQuery 的逻辑，逐步检查
const expr = `(async () => {
  const out = { steps: [] };
  const rec = (k, v) => out.steps.push(k + ' => ' + v);
  const mod = await import('./store.js');
  const items = mod.data.items;
  const KW = ${JSON.stringify(KW)};

  rec('条目总数', items.length);

  // 找出含「困难」的条目
  const hard = items.filter(i => i.title.includes('困难'));
  rec('标题含「困难」', hard.length);
  if (hard[0]) {
    const it = hard[0];
    rec('样例标题', it.title.slice(0, 46));
    rec('摘要长度', (it.excerpt || '').length);
    rec('摘要片段', (it.excerpt || '').slice(0, 70));
    const hay = [it.title, it.excerpt || '', it.sourceName || '', it.categoryName || '',
      (it.tags || []).join(' ')].join(' ').toLowerCase();
    rec('拼接文本含「困难认定」', hay.includes(KW));
    rec('拼接文本含「困难」', hay.includes('困难'));
    rec('拼接文本含「认定」', hay.includes('认定'));
  }

  // 复现 matchesQuery 的分词逻辑
  const q = KW.toLowerCase();
  const grams = [];
  for (let n = Math.min(3, q.length); n >= 2; n--) {
    for (let i = 0; i + n <= q.length; i++) grams.push(q.slice(i, i + n));
  }
  rec('分词结果', grams.join(' / '));

  const matchCount = items.filter(it => {
    const hay = [it.title, it.excerpt || '', it.sourceName || '', it.categoryName || '',
      (it.tags || []).join(' ')].join(' ').toLowerCase();
    if (hay.includes(q)) return true;
    if (q.length < 3) return false;
    let hit = 0;
    for (const g of grams) if (hay.includes(g)) hit++;
    return hit / grams.length >= 0.5;
  }).length;
  rec('按新逻辑命中', matchCount);

  // 检查每条 gram 在数据中的命中数
  out.gramHits = grams.map(g => g + '=' + items.filter(it => {
    const hay = [it.title, it.excerpt || '', it.sourceName || '', (it.tags || []).join(' ')].join(' ').toLowerCase();
    return hay.includes(g);
  }).length);

  // 实际界面搜索
  const input = document.getElementById('searchInput');
  input.value = KW;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  rec('界面搜索结果', document.getElementById('listMeta')?.textContent || '(空)');

  return JSON.stringify(out, null, 2);
})()`;

const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const res = await waitForResult(api, id, 60000);
console.log(res?.result?.value || JSON.stringify(res).slice(0, 900));
api.close();
process.exit(0);
