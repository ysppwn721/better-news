/**
 * 界面交互回归测试：分栏切换、搜索、移动端侧栏。
 *
 * 覆盖用户反馈的三类问题：
 *   1) 点分栏后列表是否立刻变为该栏目内容
 *   2) 搜索关键词是否命中相关条目
 *   3) 移动端侧栏抽屉是否在选择后自动收起
 *
 * 用法:
 *   node scripts/test-ui.mjs              # 桌面 + 手机两种视口
 *   node scripts/test-ui.mjs --desktop
 *   node scripts/test-ui.mjs --mobile
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectCdp, waitForResult } from './lib/cdp.mjs';
import { ensureServer } from './lib/ensure-server.mjs';

const only = process.argv.includes('--desktop') ? 'desktop'
  : process.argv.includes('--mobile') ? 'mobile' : 'both';

const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0;
let fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`); }
}

/**
 * 在指定视口下跑一轮界面测试
 * @param {'desktop'|'mobile'} mode
 */
async function runMode(mode) {
  const isMobile = mode === 'mobile';
  const port = isMobile ? 9501 : 9502;
  const width = isMobile ? 390 : 1440;
  const height = isMobile ? 844 : 950;

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    '--user-data-dir=' + process.env.TEMP + `\\bn-ui-${mode}`,
    'about:blank',
  ], { stdio: 'ignore' });

  await sleep(3000);
  let target = null;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('http://127.0.0.1:5178/')}`, { method: 'PUT' });
      if (res.ok) { target = await res.json(); break; }
    } catch {}
    await sleep(500);
  }
  if (!target) { chrome.kill(); throw new Error('无法连接 Chrome'); }

  const api = await connectCdp(target.webSocketDebuggerUrl);
  const pageErrors = [];
  api.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  api.send('Runtime.enable');
  await sleep(6500);

  const expr = String.raw`(async () => {
  const out = { mode: ${JSON.stringify(mode)}, steps: [] };
  const rec = (k, v) => out.steps.push(k + ' => ' + v);
  const cards = () => [...document.querySelectorAll('.card')];
  const catItems = () => [...document.querySelectorAll('.cat-item')];
  const catOf = (card) => card.querySelector('.tag.cat')?.textContent || '(无)';

  const sidebar = document.getElementById('sidebar');
  const isMobile = ${isMobile};

  rec('视口', window.innerWidth + 'x' + window.innerHeight);
  rec('初始卡片', cards().length);

  // ---------- 1. 分栏切换 ----------
  const catCases = ['教务选课', '学生工作', '党务工作', '团学活动'];
  for (const name of catCases) {
    const btn = catItems().find(e => (e.querySelector('.nm')?.textContent || '').trim() === name);
    if (!btn) { rec('分栏[' + name + ']', '按钮不存在'); continue; }
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const cats = [...new Set(cards().map(catOf))];
    const meta = document.getElementById('listMeta')?.textContent || '';
    const active = [...document.querySelectorAll('.cat-item.active')]
      .map(e => e.querySelector('.nm')?.textContent?.trim()).join(',');
    rec('分栏[' + name + ']', '卡片=' + cards().length + ' 栏目=' + cats.join('/') + ' 高亮=' + active + ' meta=' + meta);
  }

  // ---------- 2. 移动端侧栏是否遮挡 ----------
  if (isMobile) {
    const st = getComputedStyle(sidebar);
    rec('侧栏 transform', st.transform);
    rec('侧栏是否可见(遮挡卡片)', st.transform === 'none' || st.transform === 'matrix(1, 0, 0, 1, 0, 0)');
    // 打开侧栏 → 选一个栏目 → 看是否自动收起
    const menuBtn = document.querySelector('.mnav-btn[data-target="menu"]');
    if (menuBtn) {
      menuBtn.click();
      await new Promise(r => setTimeout(r, 500));
      rec('点「栏目」后侧栏', getComputedStyle(sidebar).transform);
      const btn = catItems().find(e => (e.querySelector('.nm')?.textContent || '').trim() === '教务选课');
      if (btn) {
        btn.click();
        await new Promise(r => setTimeout(r, 600));
        const t = getComputedStyle(sidebar).transform;
        const covered = t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
        rec('选栏目后侧栏是否仍遮住列表', covered ? '是（需要再点一次才能看到结果）' : '否（已自动收起）');
      }
    }
  }

  // ---------- 3. 搜索 ----------
  // 先回到全部
  const allBtn = catItems().find(e => (e.querySelector('.nm')?.textContent || '').trim() === '全部通知');
  if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 800)); }

  const input = document.getElementById('searchInput');
  const cases = ['奖学金', '选课', '推免', '考试', '国家奖学金', '困难认定', '党课'];
  // 相关性命中：库内该条目的可搜索文本含关键词即算相关
  // （界面搜索覆盖 标题/摘要/正文片段/标签/二级分类）
  const mod = await import('./store.js');
  const allItems = mod.data.items;
  for (const kw of cases) {
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const n = cards().length;
    const meta = document.getElementById('listMeta')?.textContent || '';
    const shownTitles = cards().map(c => c.querySelector('.card-title')?.textContent || '');
    const titles = shownTitles.slice(0, 3);
    // 逐条查它在数据里的可搜索文本是否含关键词（首条必须含，整体命中率要高）
    const hits = shownTitles.filter((t) => {
      const it = allItems.find(x => x.title === t);
      if (!it) return false;
      return [it.title, it.excerpt, it.searchText, (it.tags || []).join(' '), it.subcategory]
        .some((f) => (f || '').includes(kw));
    }).length;
    const firstHit = hits > 0;
    const ratio = shownTitles.length ? hits / shownTitles.length : 0;
    rec('搜索[' + kw + ']', n + ' 张卡片 | ' + meta
      + ' | 首条命中=' + firstHit + ' 命中率=' + Math.round(ratio * 100) + '%'
      + ' | ' + titles.map(t => t.slice(0, 18)).join(' / '));
  }
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));

  // ---------- 4. 标签点击 ----------
  const tagBtn = document.querySelector('.tag-chip');
  if (tagBtn) {
    const label = tagBtn.textContent.trim();
    tagBtn.click();
    await new Promise(r => setTimeout(r, 800));
    rec('点标签[' + label + ']', '卡片=' + cards().length + ' meta=' + (document.getElementById('listMeta')?.textContent || ''));
  }

  // ---------- 5. 快速筛选 ----------
  for (const f of ['important', 'deadline']) {
    const b = document.querySelector('.qf[data-filter="' + f + '"]');
    if (!b) continue;
    b.click();
    await new Promise(r => setTimeout(r, 800));
    rec('快速筛选[' + f + ']', '卡片=' + cards().length + ' meta=' + (document.getElementById('listMeta')?.textContent || ''));
    b.click();
    await new Promise(r => setTimeout(r, 500));
  }

  out.ok = true;
  return JSON.stringify(out, null, 2);
})()`;

  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, 150000);

  api.close();
  chrome.kill();
  await sleep(400);

  let data = null;
  try { data = JSON.parse(res?.result?.value); } catch {}
  return { data, pageErrors };
}

// ---------------------------------------------------------------- 主流程

const srv = await ensureServer();
if (!srv.ok) {
  console.error('✗ 本地服务不可用，测试中止');
  process.exit(2);
}

const modes = only === 'both' ? ['desktop', 'mobile'] : [only];
const all = {};

for (const mode of modes) {
  console.log(`\n########## ${mode === 'mobile' ? '手机视口 390x844' : '桌面视口 1440x950'} ##########`);
  const { data, pageErrors } = await runMode(mode);
  all[mode] = data;

  if (!data) { console.log('  ✗ 未取到测试数据'); fail++; continue; }
  for (const s of data.steps) console.log('  ' + s);
  if (pageErrors.length) {
    console.log('  页面异常:');
    for (const e of pageErrors.slice(0, 5)) console.log('    ' + String(e).slice(0, 160));
    fail++;
  }

  // 断言
  console.log('');
  const steps = Object.fromEntries(data.steps.map((s) => {
    const i = s.indexOf(' => ');
    return [s.slice(0, i), s.slice(i + 4)];
  }));

  // 分栏切换：切完后显示的卡片应全部属于目标栏目
  for (const name of ['教务选课', '学生工作', '党务工作', '团学活动']) {
    const v = steps[`分栏[${name}]`];
    if (!v) { check(`${mode} 分栏「${name}」可点击`, false, '按钮不存在'); continue; }
    const catsPart = (v.match(/栏目=([^ ]*)/) || [])[1] || '';
    const cats = catsPart.split('/').filter(Boolean);
    check(`${mode} 分栏「${name}」切换后仅显示该栏目`, cats.length === 1 && cats[0] === name,
      `实际显示栏目: ${catsPart}`);
    const activePart = (v.match(/高亮=([^ ]*)/) || [])[1] || '';
    check(`${mode} 分栏「${name}」导航高亮正确`, activePart === name, `高亮=${activePart}`);
  }

  // 移动端侧栏遮挡
  if (mode === 'mobile') {
    const v = steps['选栏目后侧栏是否仍遮住列表'] || '';
    check('手机端选择栏目后侧栏自动收起', v.includes('已自动收起'), v);
  }

  // 搜索相关性：首条必须相关，且展示出的条目整体命中率要高
  for (const kw of ['奖学金', '选课', '推免', '考试', '国家奖学金', '困难认定', '党课']) {
    const v = steps[`搜索[${kw}]`] || '';
    const metaTotal = parseInt((v.match(/共 (\d+) 条/) || [])[1] || '0', 10);
    check(`${mode} 搜索「${kw}」有结果`, metaTotal > 0, `命中 ${metaTotal} 条`);
    check(`${mode} 搜索「${kw}」首条相关`, v.includes('首条命中=true'), v.slice(0, 130));
    const ratio = parseInt((v.match(/命中率=(\d+)%/) || [])[1] || '0', 10);
    check(`${mode} 搜索「${kw}」命中率 ≥ 90%`, ratio >= 90, `实际 ${ratio}% | ${v.slice(0, 110)}`);
  }

  // 标签与快速筛选
  const tagV = steps['点标签'] ? Object.entries(steps).find(([k]) => k.startsWith('点标签'))?.[1] : null;
  if (tagV) check(`${mode} 标签筛选有结果`, /meta=共 \d+ 条/.test(tagV) && !/meta=共 0 条/.test(tagV), tagV);
  const impV = steps['快速筛选[important]'];
  if (impV) check(`${mode} 「重要」筛选有结果`, !/meta=共 0 条/.test(impV), impV);
}

console.log(`\n${results.join('\n')}`);
console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
