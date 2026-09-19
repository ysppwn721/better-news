/**
 * 界面交互回归测试：分栏切换、搜索、移动端侧栏、置顶学院聚合。
 *
 * 覆盖用户反馈过的问题：
 *   1) 点分栏后列表是否立刻变为该栏目内容；手机端抽屉是否自动收起
 *   2) 搜索是否按标题命中且结果相关
 *   3) 置顶的「★ 学院」是否聚合了该学院的**全部栏目**（曾只取一个信源，
 *      导致「学院新闻」等栏目看起来消失了）
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

async function runMode(mode) {
  const isMobile = mode === 'mobile';
  const port = isMobile ? 9531 : 9532;
  const width = isMobile ? 390 : 1440;
  const height = isMobile ? 844 : 950;

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    '--user-data-dir=' + process.env.TEMP + `\\bn-ui2-${mode}`,
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
  await sleep(7000);

  const expr = `(async () => {
  const out = { mode: ${JSON.stringify(mode)}, steps: [] };
  const rec = (k, v) => out.steps.push(k + ' => ' + v);
  const cards = () => [...document.querySelectorAll('.card')];
  const catItems = () => [...document.querySelectorAll('.cat-item')];
  const catOf = (card) => card.querySelector('.tag.cat')?.textContent || '(无)';
  const srcOf = (card) => (card.querySelector('.src')?.textContent || '').trim();
  const titleOf = (card) => card.querySelector('.card-title')?.textContent || '';

  const sidebar = document.getElementById('sidebar');
  const isMobile = ${isMobile};

  rec('视口', window.innerWidth + 'x' + window.innerHeight);
  rec('初始卡片', cards().length);

  // ---------- 1. 置顶学院聚合（关键回归：必须包含该学院的全部栏目）----------
  const star = catItems().find(e => (e.querySelector('.nm')?.textContent || '').includes('计算机'));
  if (star) {
    rec('置顶项文字', (star.querySelector('.nm')?.textContent || '').trim());
    rec('置顶项计数', (star.querySelector('.ct')?.textContent || '').trim());
    star.click();
    await new Promise(r => setTimeout(r, 1200));
    const srcs = [...new Set(cards().map(srcOf))];
    rec('置顶视图来源', srcs.join(' / '));
    rec('置顶视图条数', document.getElementById('listMeta')?.textContent || '');
    rec('置顶视图卡片数', cards().length);
  }

  // 回到全部（关键：如果停留在置顶视图，后续搜索会被限缩在该学院内，
  // 导致「搜不到」的假象——这是测试自身的缺陷，不是功能问题）
  const allBtn = catItems().find(e => (e.querySelector('.nm')?.textContent || '').trim() === '全部通知');
  if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 1000)); }
  rec('回到全部后卡片', cards().length + ' | ' + (document.getElementById('listMeta')?.textContent || ''));

  // ---------- 2. 分栏切换 ----------
  for (const name of ['教务选课', '学生工作', '党务工作']) {
    const btn = catItems().find(e => (e.querySelector('.nm')?.textContent || '').trim() === name);
    if (!btn) { rec('分栏[' + name + ']', '按钮不存在'); continue; }
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const cats = [...new Set(cards().map(catOf))];
    // 高亮项：用分隔符包裹，避免末尾空串被空格截断
    const active = catItems().filter(e => e.classList.contains('active'))
      .map(e => (e.querySelector('.nm')?.textContent || '').trim()).join('|');
    rec('分栏[' + name + ']', '卡片=' + cards().length + ' 栏目=' + cats.join('/') + ' 高亮=[' + active + ']');
  }
  if (allBtn) { allBtn.click(); await new Promise(r => setTimeout(r, 900)); }

  // ---------- 3. 手机端抽屉 ----------
  if (isMobile) {
    const menuBtn = document.querySelector('.mnav-btn[data-target="menu"]');
    if (menuBtn) {
      menuBtn.click();
      await new Promise(r => setTimeout(r, 500));
      const open = getComputedStyle(sidebar).transform === 'none';
      rec('点「栏目」后抽屉', open ? '已展开' : '未展开');
      const btn = catItems().find(e => (e.querySelector('.nm')?.textContent || '').trim() === '教务选课');
      if (btn) {
        btn.click();
        await new Promise(r => setTimeout(r, 700));
        const t = getComputedStyle(sidebar).transform;
        rec('选栏目后抽屉是否仍遮挡', (t === 'none') ? '是（需再点一次）' : '否（已收起）');
      }
    }
  }

  // ---------- 4. 搜索（按标题）----------
  // 关键前置：必须先回到「全部通知」。
  // 若停留在某个分栏（如前一步抽屉测试点选的「教务选课」），
  // 搜索会被限缩在该栏目内，出现「搜不到」的假象——这是测试流程缺陷，不是功能问题。
  const resetBtn = catItems().find(e => (e.querySelector('.nm')?.textContent || '').trim() === '全部通知');
  if (resetBtn) { resetBtn.click(); await new Promise(r => setTimeout(r, 1000)); }
  rec('搜索前状态', 'cat=' + (window.__bnState?.category || '?')
    + ' filters=[' + [...(window.__bnState?.filters || [])].join(',') + ']'
    + ' 卡片=' + cards().length);

  const input = document.getElementById('searchInput');
  // 用例说明：
  //   「困难 认定」用空格分隔两个独立的词——标题写的是「家庭经济困难学生认定」，
  //   连续写「困难认定」在标题里并不存在，按标题搜索本就该用分词。
  const cases = ['奖学金', '选课', '推免', '考试', '国家奖学金', '党课', '奖学金 公示', '困难 认定'];
  const shown = {};
  // 必须用与应用**完全相同**的匹配逻辑判定命中：
  // 应用会把「推免」扩展为「推荐免试」等同义词（校园口语），这是正确行为，
  // 测试若只用 title.includes(kw) 会把这些正确命中误判为不相关。
  const full = (await import('./store.js')).data.items;
  const aliases = await import('./aliases.mjs');
  for (const kw of cases) {
    input.value = kw;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const titles = cards().map(titleOf);
    shown[kw] = titles.slice(0, 8);
    // 卡片标题被 CSS 截断，用前缀匹配取回完整标题
    const shownFull = titles.map((t) => {
      const hit = full.find((x) => x.title === t || x.title.startsWith(t));
      return hit ? hit.title : t;
    });
    const titleHit = shownFull.filter((t) => aliases.titleMatches(t, kw)).length;
    const meta = document.getElementById('listMeta')?.textContent || '';
    const diag = 'cat=' + (window.__bnState?.category || '?')
      + ' filters=[' + [...(window.__bnState?.filters || [])].join(',') + ']';
    rec('搜索[' + kw + ']', cards().length + ' 张 | ' + meta
      + ' | 标题命中=' + titleHit + '/' + shownFull.length
      + ' | ' + diag
      + ' | ' + titles.slice(0, 3).map(t => t.slice(0, 18)).join(' / '));
  }
  out.shown = shown;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));

  // ---------- 5. 快速筛选 ----------
  for (const f of ['important', 'deadline', 'starred']) {
    const b = document.querySelector('.qf[data-filter="' + f + '"]');
    if (!b) continue;
    b.click();
    await new Promise(r => setTimeout(r, 800));
    rec('快速筛选[' + f + ']', '卡片=' + cards().length + ' ' + (document.getElementById('listMeta')?.textContent || ''));
    b.click();
    await new Promise(r => setTimeout(r, 500));
  }

  out.ok = true;
  return JSON.stringify(out, null, 2);
})()`;

  const id = api.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = await waitForResult(api, id, 180000);

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

for (const mode of modes) {
  console.log(`\n########## ${mode === 'mobile' ? '手机视口 390x844' : '桌面视口 1440x950'} ##########`);
  const { data, pageErrors } = await runMode(mode);

  if (!data) { console.log('  ✗ 未取到测试数据'); fail++; continue; }
  for (const s of data.steps) console.log('  ' + s);
  if (pageErrors.length) {
    console.log('  页面异常:');
    for (const e of pageErrors.slice(0, 5)) console.log('    ' + String(e).slice(0, 160));
    fail++;
  }

  const steps = Object.fromEntries(data.steps.map((s) => {
    const i = s.indexOf(' => ');
    return [s.slice(0, i), s.slice(i + 4)];
  }));

  console.log('');

  // 置顶学院必须聚合多个栏目
  const pinned = steps['置顶视图来源'] || '';
  const pinnedSources = pinned.split(' / ').filter(Boolean);
  check(`${mode} 置顶学院聚合多个栏目`, pinnedSources.length >= 3, `实际 ${pinnedSources.length} 个: ${pinned}`);
  const pinnedCount = parseInt((steps['置顶视图条数'] || '').match(/共 (\d+) 条/)?.[1] || '0', 10);
  check(`${mode} 置顶学院条目数 ≥ 40`, pinnedCount >= 40, `实际 ${pinnedCount} 条`);

  // 分栏切换
  for (const name of ['教务选课', '学生工作', '党务工作']) {
    const v = steps[`分栏[${name}]`];
    if (!v) { check(`${mode} 分栏「${name}」可点击`, false, '按钮不存在'); continue; }
    const cats = ((v.match(/栏目=([^ ]*)/) || [])[1] || '').split('/').filter(Boolean);
    check(`${mode} 分栏「${name}」仅显示该栏目`, cats.length === 1 && cats[0] === name, `实际: ${cats.join('/')}`);
    const active = (v.match(/高亮=\[([^\]]*)\]/) || [])[1] || '';
    check(`${mode} 分栏「${name}」导航高亮`, active === name, `高亮=[${active}]`);
  }

  if (mode === 'mobile') {
    const v = steps['选栏目后抽屉是否仍遮挡'] || '';
    check('手机端选择栏目后抽屉收起', v.includes('已收起'), v);
  }

  // 搜索：按标题匹配（含校园口语别名）。每个词都必须出现。
  for (const kw of ['奖学金', '选课', '推免', '考试', '国家奖学金', '党课', '奖学金 公示', '困难 认定']) {
    const v = steps[`搜索[${kw}]`] || '';
    const metaTotal = parseInt((v.match(/共 (\d+) 条/) || [])[1] || '0', 10);
    const hitPart = (v.match(/标题命中=(\d+)\/(\d+)/) || []);
    const hit = parseInt(hitPart[1] || '0', 10);
    const total = parseInt(hitPart[2] || '0', 10);
    check(`${mode} 搜索「${kw}」有结果`, metaTotal > 0, `命中 ${metaTotal} 条`);
    check(`${mode} 搜索「${kw}」全部为标题命中`, total > 0 && hit === total,
      `${hit}/${total} | ${v.slice(0, 110)}`);
  }

  // 快速筛选
  for (const f of ['important', 'deadline', 'starred']) {
    const v = steps[`快速筛选[${f}]`];
    if (!v) continue;
    check(`${mode} 快速筛选[${f}] 有结果`, !/卡片=0/.test(v) || f === 'starred', v);
  }
}

console.log(`\n${results.join('\n')}`);
console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
