/**
 * 移动端复现脚本：用 CDP 模拟一台手机（390x844, DPR 3, 触摸），
 * 打开页面 → 截图 → 依次验证「搜索」「点开文章加载正文」「学院专栏」。
 *
 * 用法: node scripts/mobile-repro.mjs [url] [outPrefix]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectCdp, waitForResult } from './lib/cdp.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5178/';
const prefix = process.argv[3] || 'mobile';
const OUT = resolve('data/logs');
mkdirSync(OUT, { recursive: true });

const PORT = 9491;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\bn-mobile-repro',
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
api.on('Runtime.exceptionThrown', (p) => {
  errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
});
api.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error' || p.type === 'warning') {
    errors.push(`console.${p.type}: ` + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});

api.send('Runtime.enable');
api.send('Page.enable');
api.send('Log.enable');
api.on('Log.entryAdded', (p) => {
  if (p.entry?.level === 'error') errors.push(`log: ${p.entry.text} ${p.entry.url || ''}`);
});

// ---- 手机仿真：390x844 (iPhone 14), DPR 3, 触摸 ----
api.send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  screenOrientation: { type: 'portraitPrimary', angle: 0 },
});
api.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
api.send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

api.send('Page.navigate', { url });
await sleep(9000);

const shot = async (name) => {
  const id = api.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const res = await waitForResult(api, id, 20000);
  if (res?.data) {
    const p = resolve(OUT, `${prefix}-${name}.png`);
    writeFileSync(p, Buffer.from(res.data, 'base64'));
    return p;
  }
  return null;
};

const evaluate = async (expr, timeout = 30000) => {
  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, timeout);
  if (res?.exceptionDetails) return { __error: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
  return res?.result?.value;
};

const out = { steps: [] };
const rec = (k, v) => { out.steps.push({ k, v }); console.log(`${k} => ${typeof v === 'string' ? v : JSON.stringify(v)}`); };

// ---------- 0. 基础环境 ----------
rec('viewport', await evaluate(`JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,mobile:matchMedia('(max-width:900px)').matches})`));
rec('启动状态', await evaluate(`(()=>{
  const t = document.getElementById('brandSub')?.textContent;
  return 'brandSub=' + t + ' | 卡片=' + document.querySelectorAll('.card').length + ' | 栏目=' + document.querySelectorAll('.cat-item').length;
})()`));
out.shot0 = await shot('0-load');

// ---------- 1. 底部导航「搜索」按钮 ----------
rec('--- 测试1：点底部「搜索」---', '');
rec('点击搜索前后', await evaluate(`(async()=>{
  const btn = [...document.querySelectorAll('.mnav-btn')].find(b=>b.dataset.target==='search');
  const beforeTop = document.getElementById('searchInput').getBoundingClientRect().top;
  btn.click();
  await new Promise(r=>setTimeout(r,600));
  const inp = document.getElementById('searchInput');
  const r = inp.getBoundingClientRect();
  const focused = document.activeElement === inp;
  // 输入框中心点上的真实元素（看是否被遮挡）
  const cx = r.left + r.width/2, cy = r.top + r.height/2;
  const topEl = document.elementFromPoint(cx, cy);
  const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
  return JSON.stringify({
    focused,
    inputRect:{top:Math.round(r.top),bottom:Math.round(r.bottom),h:Math.round(r.height)},
    inViewport: r.top >= 0 && r.bottom <= innerHeight,
    elementAtCenter: topEl ? (topEl.id || topEl.className || topEl.tagName) : null,
    mobileNavRect:{top:Math.round(nav.top),bottom:Math.round(nav.bottom)},
    overlaidByNav: r.bottom > nav.top,
    scrollY: Math.round(scrollY)
  });
})()`));
out.shot1 = await shot('1-search-focus');

// ---------- 2. 移动端搜索 ----------
rec('--- 测试2：移动端搜索 ---', '');
const keywords = ['选课', '奖学金', '综测', '推免', '四级'];
for (const kw of keywords) {
  const r = await evaluate(`(async()=>{
    const inp = document.getElementById('searchInput');
    inp.value = ${JSON.stringify(kw)};
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,900));
    const cards=[...document.querySelectorAll('.card')];
    const meta=document.getElementById('listMeta')?.textContent;
    const empty=document.querySelector('.empty')?.textContent||'';
    const titles=cards.slice(0,3).map(c=>c.querySelector('.card-title')?.textContent?.slice(0,24));
    return JSON.stringify({n:cards.length, meta, empty:empty.slice(0,60), titles});
  })()`, 30000);
  rec(`搜索「${kw}」`, r);
}
out.shot2 = await shot('2-search-result');

// 清空搜索
await evaluate(`(async()=>{const i=document.getElementById('searchInput');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,700));return 1})()`);

// ---------- 3. 点开文章，正文是否加载 ----------
rec('--- 测试3：点开文章加载正文 ---', '');
const detail = await evaluate(`(async()=>{
  const card = document.querySelector('.card');
  if(!card) return '无卡片';
  const title = card.querySelector('.card-title')?.textContent?.slice(0,30);
  card.click();
  await new Promise(r=>setTimeout(r,500));
  const drawer = document.getElementById('drawer');
  const loading = document.querySelector('.drawer-loading')?.textContent;
  await new Promise(r=>setTimeout(r,4000));
  const body = document.querySelector('.drawer-body .body');
  const contentLen = body ? body.textContent.trim().length : -1;
  const htmlLen = body ? body.innerHTML.length : -1;
  return JSON.stringify({
    title,
    drawerHidden: drawer.classList.contains('hidden'),
    drawerRect: (()=>{const r=drawer.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top)}})(),
    loadingText: loading || null,
    contentLen, htmlLen,
    first120: body ? body.textContent.trim().slice(0,120) : null
  });
})()`, 40000);
rec('详情', detail);
out.shot3 = await shot('3-detail');

rec('结束状态', await evaluate(`(()=>{
  const t=document.getElementById('brandSub')?.textContent;
  return 'brandSub=' + t;
})()`));

// ---------- 4. 学院专栏 ----------
rec('--- 测试4：计算机学院专栏 ---', '');
await evaluate(`(async()=>{document.getElementById('drawerMask').click();await new Promise(r=>setTimeout(r,400));return 1})()`);
const college = await evaluate(`(async()=>{
  const items=[...document.querySelectorAll('.cat-item')];
  const cst=items.find(e=>e.textContent.includes('计算机科学与技术学院'));
  if(!cst) return '未找到学院栏目';
  const before=document.querySelectorAll('.card').length;
  cst.click();
  await new Promise(r=>setTimeout(r,1200));
  const cards=[...document.querySelectorAll('.card')];
  return JSON.stringify({
    before,
    after: cards.length,
    meta: document.getElementById('listMeta')?.textContent,
    sources: [...new Set(cards.map(c=>c.querySelector('.card-foot .src')?.textContent))].slice(0,12),
    newest: cards.slice(0,5).map(c=>({
      t: c.querySelector('.card-title')?.textContent?.slice(0,30),
      d: c.querySelector('.card-foot')?.textContent?.slice(0,40)
    }))
  });
})()`, 30000);
rec('学院专栏', college);
out.shot4 = await shot('4-college');

// ---------- 5. 横向溢出检测 ----------
rec('--- 测试5：移动端布局体检 ---', '');
rec('溢出与遮挡', await evaluate(`(()=>{
  const de=document.documentElement;
  const over=[...document.querySelectorAll('body *')].filter(el=>{
    const r=el.getBoundingClientRect();
    return r.width>0 && (r.right > innerWidth+1 || r.left < -1);
  }).slice(0,10).map(el=>({
    tag:el.tagName, cls:(el.className||'').toString().slice(0,40),
    left:Math.round(el.getBoundingClientRect().left), right:Math.round(el.getBoundingClientRect().right)
  }));
  const nav=document.querySelector('.mobile-nav').getBoundingClientRect();
  // 列表最后一张卡片是否被底部导航遮住
  const cards=[...document.querySelectorAll('.card')];
  const last=cards.length?cards[cards.length-1].getBoundingClientRect():null;
  const lm=document.getElementById('loadMoreWrap')?.getBoundingClientRect();
  return JSON.stringify({
    scrollW: de.scrollWidth, innerW: innerWidth,
    horizontalOverflow: de.scrollWidth > innerWidth + 1,
    overflowEls: over,
    contentPaddingBottom: getComputedStyle(document.querySelector('.content')).paddingBottom,
    navTop: Math.round(nav.top),
    lastCardBottom: last?Math.round(last.bottom):null,
    loadMoreTop: lm?Math.round(lm.top):null,
    loadMoreHidden: document.getElementById('loadMoreWrap')?.classList.contains('hidden'),
    fontSizes: {
      cardTitle: getComputedStyle(document.querySelector('.card-title')||document.body).fontSize,
      body: getComputedStyle(document.body).fontSize
    },
    tapTargets: [...document.querySelectorAll('.icon-btn')].slice(0,3).map(b=>{const r=b.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height)})
  });
})()`));
out.shot5 = await shot('5-layout-bottom');

// 滚到底看「加载更多」与底部导航的关系
await evaluate(`window.scrollTo(0, document.body.scrollHeight); 1`);
await sleep(800);
out.shot6 = await shot('6-scrolled-bottom');

console.log('\n=== 页面异常 ===');
if (errors.length) errors.slice(0, 12).forEach((e) => console.log('  ' + String(e).slice(0, 300)));
else console.log('  （无）');

writeFileSync(resolve(OUT, `${prefix}-report.json`), JSON.stringify({ out, errors }, null, 2), 'utf8');
console.log(`\n截图与报告写入 ${OUT}\\${prefix}-*.png / ${prefix}-report.json`);
api.close();
process.exit(0);
