/**
 * 端到端测试「我的关注」：
 *   关注/取关 → 关键词关注自动入清单 → 清掉自动项 → 日程导出（.ics 下载）
 *   以及「刷新按钮不会一直转」的回归。
 *
 * 在真实浏览器里走界面路径（点击、输入、下拉），不是只调模块。
 * 用法: node scripts/test-watch-ui.mjs [url]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5179/';
const OUT = resolve('data/logs');
const DL = resolve('data/logs/downloads');
mkdirSync(OUT, { recursive: true });
mkdirSync(DL, { recursive: true });
for (const f of ['bn-test.ics']) { try { rmSync(resolve(DL, f), { force: true }); } catch {} }

const PORT = 9497;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-watch-ui',
  '--window-size=390,844',
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
if (!target) { console.error('无法创建调试目标'); process.exit(1); }

const api = await connectCdp(target.webSocketDebuggerUrl);
const errors = [];
api.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 300)));
api.send('Runtime.enable');
api.send('Page.enable');
api.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
api.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
api.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch?.(() => {});

const evaluate = async (expr, timeout = 60000) => {
  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, timeout);
  if (res?.exceptionDetails) return { __error: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
  return res?.result?.value;
};
const shot = async (name) => {
  const id = api.send('Page.captureScreenshot', { format: 'png' });
  const res = await waitForResult(api, id, 20000);
  if (res?.data) { const p = resolve(OUT, `watch-${name}.png`); writeFileSync(p, Buffer.from(res.data, 'base64')); return p; }
};

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// 从干净状态开始（避免上一次测试的残留）
await evaluate(`(() => { for (const k of ['bn.watched','bn.watchKeywords','bn.watchPrefs','bn.watchLastSeen']) localStorage.removeItem(k); location.reload(); return 1; })()`);
await sleep(7000);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`document.querySelectorAll('.card').length > 0`)) break;
  await sleep(1000);
}
console.log('页面就绪\n');

console.log('=== 1. 卡片上的关注按钮 ===');
const r1 = await evaluate(`(async () => {
  const btn = document.querySelector('.card .watch-btn');
  if (!btn) return JSON.stringify({ error: '卡片上没有关注按钮' });
  const before = btn.textContent.trim();
  const rect = btn.getBoundingClientRect();
  btn.click();
  await new Promise(r => setTimeout(r, 600));
  const after = btn.textContent.trim();
  return JSON.stringify({
    before, after,
    onClass: btn.classList.contains('on'),
    cardWatched: btn.closest('.card').classList.contains('watched'),
    tapW: Math.round(rect.width), tapH: Math.round(rect.height),
    badge: document.getElementById('watchBadge').textContent,
    badgeHidden: document.getElementById('watchBadge').classList.contains('hidden'),
    navDotHidden: document.getElementById('mnavWatchDot').classList.contains('hidden'),
    stored: Object.keys(JSON.parse(localStorage.getItem('bn.watched') || '{}')).length
  });
})()`);
console.log('  ', r1);
try {
  const o = JSON.parse(r1);
  check('关注按钮存在', !o.error);
  check('点后变为「已关注」', /已关注/.test(o.after || ''), o.after);
  check('按钮进入 on 态', o.onClass === true);
  check('卡片显示已关注样式', o.cardWatched === true);
  check('落库 1 条', o.stored === 1, `stored=${o.stored}`);
  check('顶栏角标显示 1', o.badge === '1', `badge=${o.badge}`);
  check('底部导航小红点出现', o.navDotHidden === false);
  check('触控目标高度 ≥ 28px', o.tapH >= 28, `${o.tapW}x${o.tapH}`);
} catch { check('场景1 解析', false, String(r1).slice(0, 150)); }
await shot('1-card-watched');

console.log('\n=== 2. 顶部「关注」入口与底部导航 ===');
const r2 = await evaluate(`(async () => {
  document.querySelector('.mnav-btn[data-target="watch"]').click();
  await new Promise(r => setTimeout(r, 700));
  const panel = document.getElementById('watchPanel');
  return JSON.stringify({
    panelOpen: !panel.classList.contains('hidden'),
    title: panel.querySelector('.panel-head h2').textContent.trim(),
    hasKwInput: !!document.getElementById('kwInput'),
    hasExport: !!document.getElementById('btnExportIcs'),
    listRows: panel.querySelectorAll('.watch-row').length,
    count: document.getElementById('watchCount').textContent,
    hasLeadSelect: !!document.getElementById('setLeadDays')
  });
})()`);
console.log('  ', r2);
try {
  const o = JSON.parse(r2);
  check('面板已打开', o.panelOpen === true);
  check('面板标题为「我的关注」', /我的关注/.test(o.title || ''), o.title);
  check('有关键词输入框', o.hasKwInput === true);
  check('有日程导出按钮', o.hasExport === true);
  check('有提前天数下拉', o.hasLeadSelect === true);
  check('清单显示 1 行', o.listRows === 1, `rows=${o.listRows}`);
} catch { check('场景2 解析', false, String(r2).slice(0, 150)); }
await shot('2-panel');

console.log('\n=== 3. 关键词关注 → 自动进清单 ===');
const r3 = await evaluate(`(async () => {
  const inp = document.getElementById('kwInput');
  inp.value = '选课';
  document.getElementById('btnKwAdd').click();
  await new Promise(r => setTimeout(r, 1200));
  const chips = [...document.querySelectorAll('.kw-chip')].map(c => c.querySelector('.kw-word').textContent);
  const rows = [...document.querySelectorAll('.watch-row')];
  const whys = rows.map(r => r.querySelector('.watch-why')?.textContent || '');
  return JSON.stringify({
    chips,
    kwStored: JSON.parse(localStorage.getItem('bn.watchKeywords') || '[]').map(k => k.word),
    rowCount: rows.length,
    kwRows: whys.filter(w => w.includes('关键词')).length,
    count: document.getElementById('watchCount').textContent,
    toastText: document.getElementById('toast').textContent
  });
})()`);
console.log('  ', r3);
try {
  const o = JSON.parse(r3);
  check('关键词 chip 已出现', (o.chips || []).includes('选课'), (o.chips || []).join(','));
  check('关键词已持久化', (o.kwStored || []).includes('选课'));
  check('命中的条目自动进了清单', o.kwRows >= 1, `关键词行 ${o.kwRows} / 共 ${o.rowCount} 行`);
  check('提示里说明了命中数', /命中/.test(o.toastText || ''), o.toastText);
} catch { check('场景3 解析', false, String(r3).slice(0, 150)); }
await shot('3-keyword');

console.log('\n=== 4. 侧栏「已关注」快速筛选 ===');
const r4 = await evaluate(`(async () => {
  document.getElementById('btnWatchClose').click();
  await new Promise(r => setTimeout(r, 300));
  const qf = [...document.querySelectorAll('.qf')].find(b => b.dataset.filter === 'watched');
  qf.click();
  await new Promise(r => setTimeout(r, 900));
  const cards = [...document.querySelectorAll('.card')];
  const allWatched = cards.every(c => c.querySelector('.watch-btn')?.classList.contains('on'));
  return JSON.stringify({ qfExists: !!qf, n: cards.length, allWatched, meta: document.getElementById('listMeta').textContent });
})()`);
console.log('  ', r4);
try {
  const o = JSON.parse(r4);
  check('存在「已关注」快速筛选', o.qfExists === true);
  check('筛选后有结果', o.n > 0, `n=${o.n}`);
  check('结果确实都是已关注', o.allWatched === true);
} catch { check('场景4 解析', false, String(r4).slice(0, 150)); }

console.log('\n=== 5. 「清掉自动加入的」保留手动关注（无关的能去掉）===');
const r5 = await evaluate(`(async () => {
  document.querySelector('.mnav-btn[data-target="watch"]').click();
  await new Promise(r => setTimeout(r, 500));
  const before = JSON.parse(localStorage.getItem('bn.watched') || '{}');
  const beforeN = Object.keys(before).length;
  const manualN = Object.values(before).filter(v => v.reason === 'manual').length;
  document.getElementById('btnClearAuto').click();
  await new Promise(r => setTimeout(r, 700));
  const after = JSON.parse(localStorage.getItem('bn.watched') || '{}');
  return JSON.stringify({
    beforeN, manualN,
    afterN: Object.keys(after).length,
    afterManual: Object.values(after).filter(v => v.reason === 'manual').length,
    afterKw: Object.values(after).filter(v => String(v.reason).startsWith('kw:')).length,
    count: document.getElementById('watchCount').textContent
  });
})()`);
console.log('  ', r5);
try {
  const o = JSON.parse(r5);
  check('清理前有关键词自动项', o.beforeN - o.manualN >= 1, `共 ${o.beforeN}，手动 ${o.manualN}`);
  check('自动项已清掉', o.afterKw === 0, `残留 ${o.afterKw}`);
  check('手动关注保留', o.afterManual === o.manualN, `${o.afterManual} / ${o.manualN}`);
} catch { check('场景5 解析', false, String(r5).slice(0, 150)); }

console.log('\n=== 6. 日程导出（真下载 .ics）===');
const r6 = await evaluate(`(async () => {
  // 手动再关注一条有截止时间的，确保导出里有内容
  const rows = [...document.querySelectorAll('.watch-row')];
  document.getElementById('btnExportIcs').click();
  await new Promise(r => setTimeout(r, 3000));
  return JSON.stringify({ rowsBefore: rows.length, note: document.getElementById('icsNote').textContent });
})()`);
console.log('  ', r6);
const files = existsSync(DL) ? readFileSync ? null : null : null;
await sleep(500);
let icsText = null;
try {
  const list = (await import('node:fs')).readdirSync(DL);
  const f = list.find((x) => /\.ics$/.test(x));
  if (f) icsText = readFileSync(resolve(DL, f), 'utf8');
} catch {}
if (icsText) {
  check('下载的 .ics 是合法日历', icsText.startsWith('BEGIN:VCALENDAR') && icsText.includes('END:VCALENDAR'));
  check('.ics 含时区定义', icsText.includes('TZID:Asia/Shanghai'));
  check('.ics 含提醒闹钟', /BEGIN:VALARM/.test(icsText));
  check('.ics 行宽合规（≤75 字节）',
    icsText.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  console.log(`  （已读取下载文件，${icsText.length} 字节）`);
} else {
  check('下载的 .ics 文件存在', false, '未在下载目录找到 .ics（headless 下载行为可能受限）');
}

console.log('\n=== 7. 刷新按钮不会一直转（回归）===');
const r7 = await evaluate(`(async () => {
  const { data } = await import('./store.js');
  const btn = document.getElementById('btnFetch');
  // 模拟「已在抓取中」：不真跑抓取，只让状态返回 fetching
  const orig = data.fetchStatus.bind(data);
  const origTrigger = data.triggerFetch.bind(data);
  let phase = 0;
  data.triggerFetch = async () => { phase = 1; throw new Error('正在抓取中'); };
  data.fetchStatus = async () => ({ fetching: phase === 1, progress: { done: 3, total: 113, source: '测试' } });
  btn.classList.remove('spin');
  btn.click();
  await new Promise(r => setTimeout(r, 5200));   // 跨过若干次 2s 轮询
  const spinWhileFetching = btn.classList.contains('spin');
  phase = 2;                                     // 抓取结束
  await new Promise(r => setTimeout(r, 2600));
  const spinAfterDone = btn.classList.contains('spin');
  data.fetchStatus = orig; data.triggerFetch = origTrigger;
  return JSON.stringify({ spinWhileFetching, spinAfterDone });
})()`, 90000);
console.log('  ', r7);
try {
  const o = JSON.parse(r7);
  check('拒绝重复抓取时按钮仍反映真实状态（在抓→转）', o.spinWhileFetching === true);
  check('抓取结束后按钮停下（不一直转）', o.spinAfterDone === false);
} catch { check('场景7 解析', false, String(r7).slice(0, 150)); }

await shot('4-final');
console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
console.log('页面异常:', errors.length ? errors.slice(0, 4).join(' | ') : '（无）');
api.close();
process.exit(fail ? 1 : 0);
