/**
 * 验证「详情正文取不到」时的兜底界面。
 *
 * 为什么要专门测这个：手机上抓不到正文是常态（校园网限制 / 校外抓取被拦 / 瞬时超时），
 * 而这正是用户口中「文章打不开」的地方。以前这种情况只渲染一行灰字
 * 「（未抓取到正文，请点击右上角「查看原文」）」，看起来就是功能坏了。
 *
 * 用 window.__bn.openDetail 直接构造三种条目，检查渲染结果与样式。
 * 用法: node scripts/test-detail-fallback.mjs [url]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5179/';
const OUT = resolve('data/logs');
mkdirSync(OUT, { recursive: true });
const PORT = 9493;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-fallback-test',
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
if (!target) { console.error('无法创建调试目标'); process.exit(1); }

const api = await connectCdp(target.webSocketDebuggerUrl);
const errors = [];
api.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).slice(0, 240)));
api.send('Runtime.enable');
api.send('Page.enable');
api.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
api.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

const shot = async (name) => {
  const id = api.send('Page.captureScreenshot', { format: 'png' });
  const res = await waitForResult(api, id, 20000);
  if (res?.data) { const p = resolve(OUT, `fallback-${name}.png`); writeFileSync(p, Buffer.from(res.data, 'base64')); return p; }
};
const evaluate = async (expr, timeout = 60000) => {
  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, timeout);
  if (res?.exceptionDetails) return { __error: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
  return res?.result?.value;
};

// 等界面初始化完成
for (let i = 0; i < 30; i++) {
  const ready = await evaluate(`!!(window.__bn && document.querySelectorAll('.card').length)`);
  if (ready === true) break;
  await sleep(1000);
}
console.log('页面就绪:', await evaluate(`JSON.stringify({bn: !!window.__bn, cards: document.querySelectorAll('.card').length})`));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** 场景 1：有摘要、无正文 */
const s1 = await evaluate(`(async () => {
  const { data } = await import('./store.js');
  const fake = { id: 990001, url: 'http://cst.nuc.edu.cn/info/1038/990001.htm',
    title: '【兜底测试1】有摘要无正文', excerpt: '这段摘要来自列表页，应该被渲染到兜底块里作为参考内容。',
    sourceName: '计算机科学与技术学院', categoryId: 'college', categoryName: '学院通知',
    publishedAt: '2026-09-01', tags: [] };
  window.__bn.items.push(fake);
  const orig = data.loadDetail.bind(data);
  data.loadDetail = async () => ({ id: fake.id, bodyHtml: '', bodyText: '', attachments: [] });
  window.__bn.openDetail(fake);
  await new Promise(r => setTimeout(r, 1200));
  const box = document.querySelector('.drawer-body .nocontent-box');
  const btn = box && box.querySelector('a.btn');
  const ex = box && box.querySelector('.nocontent-excerpt');
  data.loadDetail = orig;
  return JSON.stringify({
    boxShown: !!box,
    heading: box ? box.querySelector('h4').textContent : null,
    hasExcerpt: !!ex, excerptText: ex ? ex.textContent.slice(0, 30) : null,
    btnText: btn ? btn.textContent.trim() : null,
    btnHref: btn ? btn.getAttribute('href') : null,
    btnTarget: btn ? btn.getAttribute('target') : null,
    oldPlainText: document.querySelector('.drawer-body .body')?.textContent?.includes('未抓取到正文）') || false
  });
})()`);
console.log('\n=== 场景1：有摘要、无正文 ===');
console.log('  ', s1);
try {
  const o = JSON.parse(s1);
  check('渲染出兜底块', o.boxShown);
  check('标题为「未抓取到正文」', /未抓取到正文/.test(o.heading || ''), o.heading);
  check('显示了摘要', o.hasExcerpt && (o.excerptText || '').length > 5);
  check('有「查看官网原文」按钮', /查看官网原文/.test(o.btnText || ''), o.btnText);
  check('按钮指向原文 URL', (o.btnHref || '').includes('990001'), o.btnHref);
  check('不再出现旧的灰字占位', o.oldPlainText === false);
} catch (e) { check('场景1 解析', false, String(s1).slice(0, 120)); }
await shot('1-has-excerpt');

/** 场景 2：既无正文也无摘要 */
const s2 = await evaluate(`(async () => {
  const { data } = await import('./store.js');
  const fake = { id: 990002, url: 'http://cst.nuc.edu.cn/info/1038/990002.htm',
    title: '【兜底测试2】无正文无摘要', excerpt: '',
    sourceName: '计算机科学与技术学院', categoryId: 'college', categoryName: '学院通知',
    publishedAt: '2026-09-02', tags: [] };
  window.__bn.items.push(fake);
  const orig = data.loadDetail.bind(data);
  data.loadDetail = async () => ({ id: fake.id, bodyHtml: '', bodyText: '', attachments: [] });
  window.__bn.openDetail(fake);
  await new Promise(r => setTimeout(r, 1200));
  const box = document.querySelector('.drawer-body .nocontent-box');
  data.loadDetail = orig;
  return JSON.stringify({
    boxShown: !!box,
    text: box ? box.querySelector('p').textContent.slice(0, 50) : null,
    hasBtn: !!(box && box.querySelector('a.btn'))
  });
})()`);
console.log('\n=== 场景2：无正文无摘要 ===');
console.log('  ', s2);
try {
  const o = JSON.parse(s2);
  check('渲染出兜底块', o.boxShown);
  check('说明了可能原因', /超时|限制|校外/.test(o.text || ''), o.text);
  check('有原文按钮', o.hasBtn);
} catch { check('场景2 解析', false, String(s2).slice(0, 120)); }
await shot('2-no-content');

/** 场景 3：loadDetail 抛错 */
const s3 = await evaluate(`(async () => {
  const { data } = await import('./store.js');
  const fake = { id: 990003, url: 'http://cst.nuc.edu.cn/info/1038/990003.htm',
    title: '【兜底测试3】请求抛错', excerpt: '摘要', sourceName: '计算机科学与技术学院',
    categoryId: 'college', categoryName: '学院通知', publishedAt: '2026-09-03', tags: [] };
  window.__bn.items.push(fake);
  const orig = data.loadDetail.bind(data);
  data.loadDetail = async () => { throw new Error('Failed to fetch'); };
  window.__bn.openDetail(fake);
  await new Promise(r => setTimeout(r, 1200));
  const box = document.querySelector('.drawer-body .restricted-box');
  data.loadDetail = orig;
  return JSON.stringify({
    boxShown: !!box,
    heading: box ? box.querySelector('h4')?.textContent : null,
    text: box ? box.textContent.slice(0, 80) : null
  });
})()`);
console.log('\n=== 场景3：请求抛错 ===');
console.log('  ', s3);
try {
  const o = JSON.parse(s3);
  check('渲染出错误块', o.boxShown);
  check('标题明确是加载失败', /加载失败/.test(o.heading || ''), o.heading);
  check('给出了去向提示', /查看原文/.test(o.text || ''));
} catch { check('场景3 解析', false, String(s3).slice(0, 120)); }
await shot('3-error');

console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
console.log('页面异常:', errors.length ? errors.join(' | ') : '（无）');
api.close();
process.exit(fail ? 1 : 0);
