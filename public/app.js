/**
 * 中北大学信息汇总 · 前端
 *
 * 与旧版的关键差异：
 *  1) 数据来源经 store.js 抽象，同一份代码可跑在 Node API 或 Cloudflare 静态快照上；
 *  2) 筛选/搜索/排序全部在客户端完成（快照仅 553 KB，一次性载入即可），
 *     因此翻页、切栏目都是瞬时的，也不再依赖后端查询参数；
 *  3) 已读/收藏统一存 localStorage，两种模式行为一致；
 *  4) 正文来自外部网站，渲染前经 sanitizeHtml() 白名单清洗；
 *  5) 注册 service worker，支持离线打开与「添加到主屏幕」。
 */
import { data, stateStore, local } from './store.js';
import { titleMatches } from './aliases.mjs';
import {
  keyOf as watchKeyOf, isWatched, toggleWatched, loadWatched, resolveWatchList,
  clearAutoWatched, clearWatched, unwatch, watchMany,
  loadKeywords, addKeyword, removeKeyword, setKeywordEnabled, matchedKeywords,
  syncKeywordHits, loadPrefs, savePrefs, buildIcs, downloadIcs,
  loadAlerted, saveAlerted,
} from './watch.mjs';

const $ = (sel) => document.querySelector(sel);

/**
 * 取元素并保证后续赋值不炸。
 *
 * 背景：事件绑定处若某个元素在 HTML 里被改名/删除，`$('#x').onclick = ...` 会抛
 * TypeError，导致 bindEvents 中断、整页停在「正在载入」。这类错误只在浏览器里才暴露。
 * 用一个「惰性占位元素」兜住：名字写错时只打警告并跳过绑定，不影响其余功能。
 */
const $$ = (sel) => {
  const node = document.querySelector(sel);
  if (node) return node;
  if (!$._warned) $._warned = new Set();
  if (!$._warned.has(sel)) {
    $._warned.add(sel);
    console.warn(`[better-news] 页面上找不到元素 ${sel}，已跳过相关绑定`);
  }
  // 惰性占位：属性赋值、classList、append 等都不会抛错
  const stub = document.createElement('div');
  return new Proxy(stub, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v === 'function') return v.bind(target);
      return v;
    },
    set(target, prop, value) {
      try { target[prop] = value; } catch { /* 忽略只读属性 */ }
      return true;
    },
  });
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  category: 'all',
  source: null,
  tag: null,
  q: '',
  sort: 'date',
  filters: new Set(),      // unread / important / starred / deadline / college
  shown: 0,                // 已渲染条数（客户端分页）
  pageSize: 30,
  detailId: null,
  prioritySourceId: null,   // 计算机学院的主信源 id（用于信源列表标星）
  prioritySourceIds: [],    // 计算机学院的**全部**信源 id
  /**
   * 为什么需要 prioritySourceIds：
   * 一个学院在配置里对应多个信源（通知公告 / 学院新闻 / 教学科 / 教学动态…）。
   * 置顶项若只按单个信源过滤，学生看到的就只是其中一个栏目，
   * 其余栏目（尤其「学院新闻」）看起来像"消失了"——本项目踩过这个坑。
   */
};

// 暴露内部状态供自动化测试读取（定位「同样操作结果却不同」这类问题）。
// 仅诊断用途，界面逻辑不依赖它。
if (typeof window !== 'undefined') window.__bnState = state;

/**
 * 供自动化测试驱动详情抽屉。
 *
 * 为什么需要暴露：详情页是「抓不到正文」时观感最差的地方（用户会以为 App 坏了），
 * 而它只能由点击卡片触发。把入口挂出来，测试脚本才能直接构造
 * 「有摘要无正文 / 完全无正文 / 请求抛错」三种情况，验证兜底界面真的渲染出来，
 * 而不是等到用户手机上才发现。
 */
if (typeof window !== 'undefined') {
  window.__bn = {
    openDetail: (item) => openDetail(item),
    closeDetail: () => closeDetail(),
    get state() { return state; },
    get items() { return ITEMS; },
  };
}

let INDEX = null;
let ITEMS = [];

// ============================================================
// 通用工具
// ============================================================

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

/** 相对时间：天数用日历天差，20:00 发的通知次日看应显示「昨天」而非「13 小时前」 */
function relTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00+08:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  const diff = Date.now() - d.getTime();

  if (dayDiff <= 0) {
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
    return `${Math.floor(diff / 3600000)} 小时前`;
  }
  if (dayDiff === 1) return '昨天';
  if (dayDiff === 2) return '前天';
  if (dayDiff < 7) return `${dayDiff} 天前`;
  if (dayDiff < 30) return `${Math.floor(dayDiff / 7)} 周前`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return sameYear ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 清洗外部正文 HTML：只保留安全标签，去掉脚本、事件与危险协议。
 * 快照导出时已剥掉内联样式，这里是第二道防线（API 模式直接读库，未经导出器处理）。
 */
function sanitizeHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root');
  if (!root) return '';

  const ALLOWED = new Set(['P', 'DIV', 'SPAN', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'U', 'S',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
    'IMG', 'A', 'BLOCKQUOTE', 'PRE', 'CODE', 'SUB', 'SUP', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION']);
  const KEEP_ATTR = new Set(['colspan', 'rowspan']);

  root.querySelectorAll('script, style, iframe, object, embed, form, input, button, link, meta, svg, video, audio').forEach((n) => n.remove());

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const unwrap = [];
  let node = walker.currentNode;
  while (node) {
    if (!ALLOWED.has(node.tagName)) {
      unwrap.push(node);
    } else {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value || '';
        if (name.startsWith('on') || name === 'style' || name === 'srcset' || name === 'data-src') {
          node.removeAttribute(attr.name);
          continue;
        }
        if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(val)) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (!KEEP_ATTR.has(name) && name !== 'href' && name !== 'src' && name !== 'alt' && name !== 'title') {
          node.removeAttribute(attr.name);
        }
      }
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
      if (node.tagName === 'IMG') node.setAttribute('loading', 'lazy');
    }
    node = walker.nextNode();
  }
  for (const n of unwrap.reverse()) {
    const parent = n.parentNode;
    if (!parent) continue;
    while (n.firstChild) parent.insertBefore(n.firstChild, n);
    parent.removeChild(n);
  }
  return root.innerHTML;
}

const catById = (id) => INDEX?.categories.find((c) => c.id === id);

/**
 * 截止时间索引：按条目 id 建立映射。
 *
 * 注意与 INDEX.deadlines 的区别：那边是「条目 → 多个截止时间」的列表，
 * 这里取每个条目最紧迫的一个，供卡片与详情页快速显示。
 */
const deadlineByItem = new Map();
function buildDeadlineIndex() {
  deadlineByItem.clear();
  for (const d of INDEX.deadlines || []) {
    const cur = deadlineByItem.get(d.itemId);
    if (!cur || Math.abs(d.daysLeft) < Math.abs(cur.daysLeft)) {
      deadlineByItem.set(d.itemId, d);
    }
  }
}

// ============================================================
// 筛选（全部在客户端完成）
// ============================================================

function applyFilters() {
  const f = state.filters;
  const q = state.q.trim().toLowerCase();
  let list = ITEMS;

  if (state.category !== 'all') list = list.filter((i) => i.categoryId === state.category);
  if (state.source) list = list.filter((i) => i.sourceId === state.source);
  if (state.tag) list = list.filter((i) => (i.tags || []).includes(state.tag));
  if (f.has('unread')) list = list.filter((i) => !stateStore.isRead(i));
  if (f.has('important')) list = list.filter((i) => i.important);
  if (f.has('starred')) list = list.filter((i) => stateStore.isStarred(i));
  if (f.has('watched')) list = list.filter((i) => isWatched(i));
  if (f.has('college')) {
    const ids = state.prioritySourceIds.length ? state.prioritySourceIds : [state.prioritySourceId];
    list = list.filter((i) => ids.includes(i.sourceId));
  }
  if (f.has('deadline')) {
    // 按「截止日期」而非「条目」计数：一条通知可能有多个截止时间，
    // 这里对同一条只计一次（与卡片上的角标一致）
    const seenIds = new Set();
    list = list.filter((i) => {
      const d = deadlineByItem.get(i.id);
      if (!d || d.daysLeft < 0) return false;
      if (seenIds.has(i.id)) return false;
      seenIds.add(i.id);
      return true;
    });
  }
  if (f.has('today') || f.has('week')) {
    const days = f.has('today') ? 1 : 7;
    const cutoff = Date.now() - days * 86400000;
    list = list.filter((i) => {
      const t = i.publishedAt ? new Date(`${i.publishedAt}T23:59:59+08:00`).getTime() : 0;
      return t >= cutoff;
    });
  }
  // 搜索：过滤 + 记录相关度，供排序使用
  let searchScore = null;
  if (q) {
    searchScore = new Map();
    list = list.filter((i) => {
      const s = matchScore(i, q);
      if (s > 0) { searchScore.set(i, s); return true; }
      return false;
    });
  }

  if (state.sort === 'firstSeen') {
    list = [...list].sort((a, b) => b.id - a.id);
  } else {
    list = [...list].sort((a, b) =>
      String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) || b.id - a.id);
  }

  // 搜索时按相关度优先：整串命中排在分词命中之前，
  // 否则模糊命中会混在精确命中里，用户看到的第一条可能不是最相关的。
  if (searchScore) {
    list = [...list].sort((a, b) => (searchScore.get(b) || 0) - (searchScore.get(a) || 0));
  }

  return list;
}

/**
 * 搜索匹配（按标题搜索，含校园口语别名）。
 *
 * 语义：
 *   · 只看标题
 *   · 多个关键词以空格分隔，**每个词都要出现在标题里**（顺序不限）
 *   · 关键词会做同义词扩展：搜「综测」也能命中标题写着「综合素质测评」的通知
 *     （学生用口语缩写、学校写公文全称，这是最常见的搜不到原因）
 *
 * 为什么不做正文匹配：曾把整篇正文纳入并加模糊兜底，
 * 结果搜什么都出一大堆、条条对不上，被用户否掉。宁可少而准。
 *
 * 返回 1 表示命中（统一分值，排序仍按发布时间倒序）。
 */
function matchScore(item, q) {
  return titleMatches(item.title, q) ? 1 : 0;
}

// ============================================================
// 渲染：侧栏
// ============================================================

function renderCategories() {
  const nav = $('#catNav');
  nav.textContent = '';

  const addItem = (label, iconChar, color, count, unread, active, onclick, title) => {
    const b = el('button', `cat-item${active ? ' active' : ''}`);
    if (title) b.title = title;
    const ic = el('span', 'ic', iconChar);
    ic.style.background = color;
    b.append(ic);
    b.append(el('span', 'nm', label));
    b.append(el('span', `ct${unread ? ' fresh' : ''}`, unread ? String(unread) : (count ? String(count) : '')));
    // 选择后收起移动端抽屉，否则抽屉盖住列表，用户会以为「点了没反应」
    b.onclick = () => { onclick(); closeSidebar(); };
    nav.append(b);
  };
  const allUnread = ITEMS.filter((i) => !stateStore.isRead(i)).length;
  addItem('全部通知', '全', '#546e7a', ITEMS.length, allUnread,
    state.category === 'all' && !state.source && !state.filters.has('college'),
    () => { resetView(); render(); }, '全部来源的通知');

  // 优先展示用户所在学院：聚合该学院的**全部**栏目，
  // 只取一个信源会让其它栏目（如「学院新闻」）看起来不存在。
  const priorityIds = state.prioritySourceIds.length
    ? state.prioritySourceIds
    : (state.prioritySourceId ? [state.prioritySourceId] : []);
  if (priorityIds.length && INDEX.priorityCollegeName) {
    const myItems = ITEMS.filter((i) => priorityIds.includes(i.sourceId));
    const unread = myItems.filter((i) => !stateStore.isRead(i)).length;
    addItem(`★ ${INDEX.priorityCollegeName}`, '★', '#c2185b', myItems.length, unread,
      state.filters.has('college') && state.category === 'all',
      () => {
        resetView();
        state.filters.add('college');
        render();
      }, `${INDEX.priorityCollegeName}发布的全部通知（含各栏目）`);
  }

  for (const c of INDEX.categories) {
    if (!c.total) continue;
    const catItems = ITEMS.filter((i) => i.categoryId === c.id);
    const unread = catItems.filter((i) => !stateStore.isRead(i)).length;
    addItem(c.name, c.icon, c.color, c.total, unread,
      state.category === c.id && !state.filters.has('college'),
      () => { resetView(); state.category = c.id; render(); }, c.desc);
  }
}

function renderTags() {
  const cloud = $('#tagCloud');
  cloud.textContent = '';
  // 标签统计基于当前栏目的条目，避免出现点了没结果的标签
  const scope = state.category === 'all' ? ITEMS : ITEMS.filter((i) => i.categoryId === state.category);
  const counts = new Map();
  const AUDIENCE = new Set(['研究生', '新生', '党员', '团员', '教职工', '全体学生', '本科毕业班', '家庭经济困难学生']);
  for (const it of scope) {
    for (const t of it.tags || []) {
      if (AUDIENCE.has(t)) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  if (!sorted.length) { cloud.append(el('span', 'hint', '暂无标签')); return; }
  for (const [t, n] of sorted) {
    const b = el('button', `tag-chip${state.tag === t ? ' active' : ''}`, `${t} ${n}`);
    b.onclick = () => {
      state.tag = state.tag === t ? null : t;
      resetView(true);
      render();
      closeSidebar();
    };
    cloud.append(b);
  }
}

function renderSources() {
  const box = $('#sourceList');
  box.textContent = '';
  const rows = (INDEX.sources || []).filter((s) => s.itemCount > 0);
  // 当前栏目的信源排在前面，减少在长列表里找的动作
  const scope = state.category === 'all' ? rows : rows.filter((s) => s.categoryId === state.category);
  const list = (scope.length ? scope : rows).slice(0, 60);
  if (!list.length) { box.append(el('span', 'hint', '暂无信源')); return; }

  for (const s of list) {
    const unread = ITEMS.filter((i) => i.sourceId === s.id && !stateStore.isRead(i)).length;
    const b = el('button', `source-row${state.source === s.id ? ' active' : ''}`);
    const failed = /失败|异常/.test(s.lastStatus || '');
    b.append(el('span', `dot ${failed ? 'err' : (s.itemCount ? 'ok' : 'idle')}`));
    const isPriority = s.id === state.prioritySourceId;
    b.append(el('span', 'nm', (isPriority ? '★ ' : '') + s.name));
    b.append(el('span', 'ct', unread ? String(unread) : String(s.itemCount || '')));
    b.title = `${s.categoryName}｜${s.lastStatus || '未抓取'}`;
    b.onclick = () => {
      resetView(true);
      state.source = state.source === s.id ? null : s.id;
      render();
      closeSidebar();
    };
    box.append(b);
  }
}

function renderStats() {
  const box = $('#statChips');
  box.textContent = '';
  const unread = ITEMS.filter((i) => !stateStore.isRead(i)).length;
  const important = ITEMS.filter((i) => i.important).length;
  const watched = ITEMS.filter((i) => isWatched(i)).length;
  const soon = (INDEX.deadlines || []).filter((d) => d.daysLeft >= 0).length;
  const chips = [['库内', ITEMS.length, ''], ['未读', unread, unread ? 'alert' : ''], ['重要', important, '']];
  if (watched) chips.push(['关注', watched, '']);
  if (soon) chips.push(['即将截止', soon, 'alert']);
  for (const [label, val, cls] of chips) {
    const c = el('span', `chip ${cls}`.trim());
    c.append(el('span', '', label));
    c.append(el('b', '', String(val)));
    box.append(c);
  }
  // 独立的角标元素（移动端顶栏被隐藏时仍要能看到截止数）
  const badge = $('#deadlineBadge');
  badge.textContent = String(soon);
  badge.classList.toggle('hidden', soon === 0);
  renderWatchBadge();
}

// ============================================================
// 渲染：信息流
// ============================================================

function renderActiveFilters() {
  const box = $('#activeFilters');
  box.textContent = '';
  const add = (label, onClear) => {
    const s = el('span', 'af');
    s.append(el('span', '', label));
    const x = el('button', '', '×');
    x.onclick = () => { onClear(); resetView(true); render(); };
    s.append(x);
    box.append(s);
  };
  if (state.filters.has('college')) add(`★ ${INDEX.priorityCollegeName}`, () => state.filters.delete('college'));
  const cat = catById(state.category);
  if (cat && state.category !== 'all') add(`栏目：${cat.name}`, () => { state.category = 'all'; });
  if (state.source) {
    const s = (INDEX.sources || []).find((x) => x.id === state.source);
    add(`信源：${s?.name || state.source}`, () => { state.source = null; });
  }
  if (state.tag) add(`标签：${state.tag}`, () => { state.tag = null; });
  if (state.q) add(`搜索：${state.q}`, () => { state.q = ''; $('#searchInput').value = ''; });
  const names = { unread: '未读', important: '重要', starred: '收藏', today: '今日', week: '近 7 天', deadline: '有截止时间', watched: '已关注' };
  for (const f of state.filters) {
    if (f === 'college') continue;
    add(names[f] || f, () => state.filters.delete(f));
  }
}

function syncQuickFilters() {
  document.querySelectorAll('.qf').forEach((b) => {
    b.classList.toggle('active', state.filters.has(b.dataset.filter));
  });
}

function cardEl(it) {
  const read = stateStore.isRead(it);
  const starred = stateStore.isStarred(it);
  const card = el('div', `card${read ? '' : ' unread'}${it.important ? ' important' : ''}${starred ? ' starred' : ''}`);
  card.dataset.id = it.id;

  const head = el('div', 'card-head');
  head.append(el('h3', 'card-title', it.title));
  const tags = el('div', 'card-tags');
  const cat = catById(it.categoryId);
  if (cat) {
    const t = el('span', 'tag cat', cat.name);
    t.style.background = cat.color;
    tags.append(t);
  }
  if (it.important) tags.append(el('span', 'tag hot', '重要'));
  if (it.restricted) tags.append(el('span', 'tag restricted', '需校内网'));
  head.append(tags);
  card.append(head);

  if (it.excerpt) card.append(el('p', 'card-excerpt', it.excerpt));

  const foot = el('div', 'card-foot');
  const isPriority = it.sourceId === state.prioritySourceId;
  const src = el('span', 'src', (isPriority ? '★ ' : '') + (it.sourceName || it.categoryName));
  foot.append(src);
  foot.append(el('span', 'sep', '·'));
  foot.append(el('span', '', relTime(it.publishedAt)));

  const dl = deadlineByItem.get(it.id);
  if (dl) {
    const cls = dl.daysLeft < 0 ? '' : (dl.daysLeft <= 2 ? 'dl-tag soon' : 'dl-tag');
    const text = dl.daysLeft < 0 ? '已截止' : (dl.daysLeft === 0 ? '今天截止' : (dl.daysLeft === 1 ? '明天截止' : `剩 ${dl.daysLeft} 天`));
    foot.append(el('span', 'sep', '·'));
    foot.append(el('span', cls, `⏰ ${dl.date} ${text}`));
  }

  const AUD = new Set(['研究生', '新生', '党员', '团员', '教职工', '本科毕业班', '家庭经济困难学生']);
  for (const t of (it.tags || []).filter((x) => AUD.has(x)).slice(0, 2)) {
    foot.append(el('span', 'sep', '·'));
    foot.append(el('span', 'tag aud', t));
  }
  foot.append(el('span', 'spacer'));

  /*
    关注按钮：这是「提醒与我有关的事」的入口，因此放在卡片主体上（不是右下角小图标）。
    右下角那三个 icon-btn 在手机上只有 21×17，而且语义是「次要操作」；
    关注是这一版的核心动作，必须一眼看得到、手指点得中。
    已关注时显示勾选态，再点即取消（也满足「无关的可以去掉」）。
  */
  const watched = isWatched(it);
  const watchBtn = el('button', `watch-btn${watched ? ' on' : ''}`, watched ? '🔖 已关注' : '🔖 关注');
  watchBtn.title = watched ? '从关注清单移除（不再提醒）' : '加入关注清单，之后只提醒这些';
  watchBtn.onclick = (e) => {
    e.stopPropagation();
    const now = toggleWatched(it);
    watchBtn.textContent = now ? '🔖 已关注' : '🔖 关注';
    watchBtn.classList.toggle('on', now);
    card.classList.toggle('watched', now);
    renderWatchBadge();
    if (!$('#watchPanel').classList.contains('hidden')) renderWatchPanel();
    toast(now ? '已加入关注，可在「🔖 关注」里管理' : '已从关注清单移除');
  };
  foot.append(watchBtn);

  const actions = el('div', 'actions');
  const star = el('button', `icon-btn${starred ? ' on' : ''}`, starred ? '★' : '☆');
  star.title = '收藏（仅本机标记，不参与提醒）';
  star.onclick = (e) => {
    e.stopPropagation();
    const now = !stateStore.isStarred(it);
    stateStore.setStarred(it, now);
    star.textContent = now ? '★' : '☆';
    star.classList.toggle('on', now);
    card.classList.toggle('starred', now);
  };
  const readBtn = el('button', 'icon-btn', read ? '○' : '●');
  readBtn.title = read ? '标为未读' : '标为已读';
  readBtn.onclick = (e) => {
    e.stopPropagation();
    const now = !stateStore.isRead(it);
    stateStore.setRead(it, now);
    card.classList.toggle('unread', !now);
    readBtn.textContent = now ? '○' : '●';
    renderCategories();
    renderStats();
  };
  const open = el('a', 'icon-btn', '↗');
  open.href = it.url; open.target = '_blank'; open.rel = 'noopener';
  open.title = '打开官网原文';
  open.onclick = (e) => e.stopPropagation();
  actions.append(star, readBtn, open);
  foot.append(actions);

  card.append(foot);
  card.onclick = () => openDetail(it);
  return card;
}

function renderFeed() {
  const list = applyFilters();
  const feed = $('#feed');
  feed.textContent = '';

  if (!list.length) {
    const e = el('div', 'empty');
    e.append(el('div', 'big', '🗂'));
    e.append(el('p', '', state.q ? `没有找到包含「${state.q}」的通知` : '这里还没有内容'));
    if (!state.q) e.append(el('p', '', data.isApi ? '点击右上角「⟳ 刷新」抓取最新通知' : '数据由定时任务自动更新，稍后再来看看'));
    feed.append(e);
    $('#listMeta').textContent = '';
    $('#loadMoreWrap').classList.add('hidden');
    return;
  }

  const slice = list.slice(0, state.shown);
  const frag = document.createDocumentFragment();
  for (const it of slice) frag.append(cardEl(it));
  feed.append(frag);

  $('#listMeta').textContent = `共 ${list.length} 条，已显示 ${slice.length} 条`;
  $('#loadMoreWrap').classList.toggle('hidden', slice.length >= list.length);
}

// ============================================================
// 详情抽屉
// ============================================================

async function openDetail(it) {
  state.detailId = it.id;
  const drawer = $('#drawer');
  $('#drawerMask').classList.remove('hidden');
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');

  const body = $('#drawerBody');
  body.textContent = '';

  // 标记已读并立即更新卡片样式
  if (!stateStore.isRead(it)) {
    stateStore.setRead(it, true);
    document.querySelector(`.card[data-id="${it.id}"]`)?.classList.remove('unread');
    renderCategories();
    renderStats();
  }

  body.append(el('h1', '', it.title));

  const cat = catById(it.categoryId);
  const meta = el('div', 'drawer-meta');
  if (cat) {
    const t = el('span', 'tag cat', cat.name);
    t.style.background = cat.color;
    meta.append(t);
  }
  meta.append(el('span', '', `发布：${it.publishedAt || '未知'}`));
  meta.append(el('span', '', `来源：${it.sourceName}`));
  if (it.tags?.length) meta.append(el('span', '', `标签：${it.tags.join('、')}`));
  body.append(meta);

  const dl = deadlineByItem.get(it.id);
  if (dl) {
    const box = el('div', 'deadline-box');
    box.append(el('h4', '', '⏰ 注意截止时间'));
    const ul = el('ul');
    ul.append(el('li', '', `${dl.date}${dl.daysLeft < 0 ? '（已过）' : dl.daysLeft === 0 ? '（今天）' : `（还剩 ${dl.daysLeft} 天）`}`));
    box.append(ul);
    body.append(box);
  }

  const content = el('div', 'body');
  content.append(el('div', 'drawer-loading', '正在载入正文…'));
  body.append(content);

  // 附件区先占位，详情回来后填充
  const attachBox = el('div', 'attach-box hidden');
  body.append(attachBox);

  try {
    const detail = await data.loadDetail(it.id);
    content.textContent = '';
    if (it.restricted) {
      const box = el('div', 'restricted-box');
      box.append(el('h4', '', '🔒 该通知正文需在校园网内访问'));
      box.append(el('p', '', '学校部分栏目（如学院内部公示）限制校外访问，本工具只能取到标题与发布时间。请在校园网环境下点击右上角「查看原文」查看正文。'));
      content.append(box);
    } else if (detail.bodyHtml) {
      content.innerHTML = sanitizeHtml(detail.bodyHtml);
    } else if (detail.bodyText) {
      content.textContent = detail.bodyText;
    } else {
      // 没抓到正文：给出摘要 + 明确的「去看原文」出口。
      //
      // 为什么必须做成有样式的块而不是一行灰字：
      // 手机上抓不到正文是常见情况（校园网限制、校外抓取被拦、瞬时超时），
      // 而这里是 App 里最容易被当成「App 坏了 / 文章打不开」的地方——
      // 用户看到的如果是「（未抓取到正文…）」这种系统口吻的括号文本，
      // 只会以为功能失效。改成带按钮的提示，把去向讲清楚。
      const box = el('div', 'nocontent-box');
      box.append(el('h4', '', '📄 未抓取到正文'));
      box.append(el('p', '', it.excerpt
        ? '下面是从列表页取到的内容摘要。完整正文（含附件与报名表）请点「查看官网原文」。'
        : '这条通知的正文没能抓取到，可能原因是学校站点瞬时超时，或该栏目限制校外访问。请点「查看官网原文」查看完整内容。'));
      if (it.excerpt) {
        const ex = el('div', 'nocontent-excerpt');
        ex.textContent = it.excerpt;
        box.append(ex);
      }
      const go = el('a', 'btn primary small', '查看官网原文 ↗');
      go.href = it.url;
      go.target = '_blank';
      go.rel = 'noopener';
      box.append(go);
      content.append(box);
    }

    if (detail.attachments?.length) {
      attachBox.classList.remove('hidden');
      attachBox.append(el('h4', '', `📎 附件（${detail.attachments.length}）`));
      const ul = el('ul');
      for (const a of detail.attachments) {
        const li = el('li');
        const link = el('a', '', a.name);
        link.href = a.url; link.target = '_blank'; link.rel = 'noopener';
        li.append(link);
        ul.append(li);
      }
      attachBox.append(ul);
    }
  } catch (e) {
    content.textContent = '';
    const err = el('div', 'restricted-box');
    err.append(el('h4', '', '⚠ 正文加载失败'));
    err.append(el('p', '', `原因：${e.message}`));
    err.append(el('p', '', '多为网络不通或学校站点限制校外访问。可点右上角「查看原文」直接打开官网页面。'));
    content.append(err);
  }

  $('#btnOpenOrigin').href = it.url;
  const star = $('#btnStar');
  star.textContent = stateStore.isStarred(it) ? '★ 已收藏' : '☆ 收藏';
  star.onclick = () => {
    const now = !stateStore.isStarred(it);
    stateStore.setStarred(it, now);
    star.textContent = now ? '★ 已收藏' : '☆ 收藏';
    document.querySelector(`.card[data-id="${it.id}"]`)?.classList.toggle('starred', now);
    if (state.filters.has('starred')) renderFeed();
  };
}

function closeDetail() {
  state.detailId = null;
  $('#drawerMask').classList.add('hidden');
  $('#drawer').classList.add('hidden');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

// ============================================================
// 我的关注（关注清单 · 关键词关注 · 日程导出）
// ============================================================

/** 顶栏与底部导航的角标：关注条数 */
function renderWatchBadge() {
  const n = Object.keys(loadWatched()).length;
  const badge = $('#watchBadge');
  if (badge) {
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n === 0);
  }
  const dot = $('#mnavWatchDot');
  if (dot) dot.classList.toggle('hidden', n === 0);
}

/** 把条目列表渲染成关注清单的通用行（面板里与日程预览共用） */
function watchRow(row, opts = {}) {
  const { item, meta, deadline, daysLeft, stale, key } = row;
  const box = el('div', `watch-row${stale ? ' stale' : ''}`);

  const main = el('div', 'watch-main');
  const title = el('div', 'watch-title', item?.title || meta.title || '(该通知已不在当前数据里)');
  if (item) {
    title.onclick = () => { $('#watchPanel').classList.add('hidden'); openDetail(item); };
    title.style.cursor = 'pointer';
  }
  main.append(title);

  // 为什么在这条清单里 —— 用户必须能一眼分辨「我手动加的」还是「关键词带进来的」
  const why = [];
  if (String(meta.reason || '').startsWith('kw:')) why.push(`关键词「${meta.reason.slice(3)}」`);
  else why.push('手动关注');
  if (item?.sourceName) why.push(item.sourceName);
  if (item?.publishedAt) why.push(relTime(item.publishedAt));
  main.append(el('div', 'watch-why', why.join(' · ')));

  if (deadline) {
    const cls = daysLeft < 0 ? 'over' : (daysLeft <= 2 ? 'urgent' : 'soon');
    const txt = daysLeft < 0 ? '已截止' : (daysLeft === 0 ? '今天截止' : (daysLeft === 1 ? '明天截止' : `剩 ${daysLeft} 天`));
    main.append(el('div', `watch-dl ${cls}`, `⏰ ${deadline} ${txt}`));
  } else {
    main.append(el('div', 'watch-dl none', '未识别到截止时间（日程里按发布时间提醒一次）'));
  }
  box.append(main);

  const acts = el('div', 'watch-acts');
  if (item) {
    const b = el('button', 'icon-btn', '↗');
    b.title = '打开官网原文';
    b.onclick = (e) => { e.stopPropagation(); window.open(item.url, '_blank', 'noopener'); };
    acts.append(b);
  }
  const del = el('button', 'icon-btn', '×');
  del.title = '不再关注（从提醒里去掉）';
  del.onclick = (e) => {
    e.stopPropagation();
    unwatch(key);
    renderWatchBadge();
    renderWatchPanel();
    renderFeed();
  };
  acts.append(del);
  box.append(acts);
  return box;
}

function renderWatchPanel() {
  // ---- 关键词列表 ----
  const kwBox = $('#kwList');
  if (kwBox) {
    kwBox.textContent = '';
    const kws = loadKeywords();
    if (!kws.length) {
      kwBox.append(el('span', 'hint', '还没有关键词。添加后，标题命中的通知会自动进入下面的关注清单。'));
    }
    for (const k of kws) {
      const chip = el('span', `kw-chip${k.enabled ? '' : ' off'}`);
      const label = el('span', 'kw-word', k.word);
      label.title = k.enabled ? '点击暂停该关键词' : '点击恢复该关键词';
      label.onclick = () => { setKeywordEnabled(k.word, !k.enabled); renderWatchPanel(); };
      chip.append(label);
      const x = el('button', 'kw-del', '×');
      x.title = '删除关键词';
      x.onclick = () => {
        removeKeyword(k.word);
        // 顺带把它带进清单的条目也清掉，避免留下「已经没这个关键词了」的残留
        const map = loadWatched();
        let changed = false;
        for (const [key, v] of Object.entries(map)) {
          if (v.reason === `kw:${k.word}`) { delete map[key]; changed = true; }
        }
        if (changed) local.set('watched', map);
        renderWatchBadge();
        renderWatchPanel();
      };
      chip.append(x);
      kwBox.append(chip);
    }
  }

  // ---- 关注清单 ----
  const listBox = $('#watchList');
  if (!listBox) return;
  listBox.textContent = '';
  const rows = resolveWatchList(ITEMS, deadlineByItem);

  const countEl = $('#watchCount');
  if (countEl) countEl.textContent = String(rows.length);

  // 日程导出按钮的可用性提示
  const icsNote = $('#icsNote');
  const withDl = rows.filter((r) => r.deadline).length;
  if (icsNote) {
    icsNote.textContent = rows.length
      ? `将导出 ${rows.length} 个日程（其中 ${withDl} 个带截止日期，其余按发布时间提醒一次）。`
      : '关注清单是空的——先关注几条通知，再导出到手机日历。';
  }
  const expBtn = $('#btnExportIcs');
  if (expBtn) expBtn.disabled = rows.length === 0;

  if (!rows.length) {
    listBox.append(el('div', 'hint', '还没有关注任何通知。在列表里点卡片上的「🔖 关注」，或在上方添加关键词。'));
    return;
  }

  // 分组：未过期的截止项 → 其它
  const soon = rows.filter((r) => r.daysLeft != null && r.daysLeft >= 0);
  const rest = rows.filter((r) => !(r.daysLeft != null && r.daysLeft >= 0));

  if (soon.length) {
    listBox.append(el('div', 'watch-group', `⏰ 即将截止（${soon.length}）`));
    for (const r of soon) listBox.append(watchRow(r));
  }
  if (rest.length) {
    listBox.append(el('div', 'watch-group', `📌 其它关注（${rest.length}）`));
    for (const r of rest) listBox.append(watchRow(r));
  }
  return rows;
}

function openWatch() {
  fillWatchPrefs();
  renderWatchPanel();
  $('#watchPanel').classList.remove('hidden');
}

/** 把保存的日程提醒偏好回填到下拉框（面板每次打开时也会刷） */
function fillWatchPrefs() {
  const p = loadPrefs();
  const ld = $('#setLeadDays');
  const rh = $('#setReminderHour');
  if (ld) ld.value = String(p.leadDays);
  if (rh) rh.value = String(p.reminderHour);
}

/**
 * 关键词命中新条目时提醒。
 *
 * 与原来「新通知就弹」的区别：这里只针对**关注清单**里的新条目，
 * 因此不会因为别的部门发了个无关通知就打扰用户。
 * 用 alerted 集合去重，避免每次轮询都把同一批再弹一遍。
 *
 * ⚠ 为什么除系统通知外还要弹页面内 toast：
 *   Android WebView（App 内）**不支持 Notification API**，
 *   在 App 里 `Notification.permission` 拿不到、弹不出任何东西。
 *   而「关键词有更新就提醒我」主要就是在 App 里用（网页版你未必开着）。
 *   所以这里以页面内提示为保底（App/网页都能显示），
 *   系统通知作为锦上添花（支持时才有）。
 */
function notifyWatchedNew() {
  const rows = resolveWatchList(ITEMS, deadlineByItem);
  const alerted = loadAlerted();
  const fresh = rows.filter((r) => r.item && !alerted.has(r.key)
    && String(r.meta.reason || '').startsWith('kw:'));
  if (!fresh.length) return 0;
  for (const r of fresh) alerted.add(r.key);
  saveAlerted(alerted);

  const words = [...new Set(fresh.map((r) => String(r.meta.reason).slice(3)))];
  const label = words.length ? `「${words.slice(0, 3).join('、')}」` : '';
  const first = fresh[0].item;

  // 保底：页面内提示（App 与网页都有效）
  toast(fresh.length === 1
    ? `🔖 关注的关键词有新通知：${first.title.slice(0, 26)}`
    : `🔖 ${label}共有 ${fresh.length} 条新关注通知`, 5000);

  // 增强：系统通知（浏览器支持时才有；App 的 WebView 里通常不支持）
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      notifyNew(fresh.map((r) => r.item).slice(0, 5));
    }
  } catch { /* 不支持就只留页面内提示 */ }

  renderWatchBadge();
  return fresh.length;
}

// ============================================================
// 截止提醒面板
// ============================================================

function openDeadlines() {
  $('#deadlinePanel').classList.remove('hidden');
  const list = $('#deadlineList');
  list.textContent = '';
  const rows = (INDEX.deadlines || []).filter((d) => d.daysLeft >= -1);
  if (!rows.length) {
    list.append(el('div', 'hint', '近 45 天内没有识别到明确的截止时间。'));
    return;
  }
  for (const r of rows) {
    const row = el('div', 'dl-row');
    const cls = r.daysLeft < 0 ? 'over' : (r.daysLeft <= 2 ? 'urgent' : 'soon');
    row.append(el('div', `dl-days ${cls}`,
      r.daysLeft < 0 ? '已过' : (r.daysLeft === 0 ? '今天' : (r.daysLeft === 1 ? '明天' : `${r.daysLeft}天`))));
    const info = el('div', 'dl-info');
    info.append(el('div', 't', r.title));
    info.append(el('div', 'h', `${r.date}｜${r.sourceName}`));
    row.append(info);
    row.onclick = () => {
      $('#deadlinePanel').classList.add('hidden');
      const it = ITEMS.find((x) => x.id === r.itemId);
      if (it) openDetail(it);
      else window.open(r.url || '#', '_blank', 'noopener');
    };
    list.append(row);
  }
}

// ============================================================
// 浏览器通知
// ============================================================

async function requestNotifyPermission() {
  if (!('Notification' in window)) { toast('当前浏览器不支持桌面通知'); return false; }
  if (Notification.permission === 'granted') { toast('提醒已开启'); return true; }
  const p = await Notification.requestPermission();
  if (p === 'granted') { toast('提醒已开启，有新通知会弹窗'); return true; }
  toast('未授权，无法弹出提醒');
  return false;
}

function notifyNew(items) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const shown = items.slice(0, 3);
  for (const it of shown) {
    try {
      const n = new Notification(`${it.important ? '❗ ' : ''}${it.categoryName}｜新通知`, {
        body: it.title,
        tag: `bn-${it.id}`,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        data: { id: it.id },
      });
      n.onclick = () => {
        window.focus();
        const target = ITEMS.find((x) => x.id === it.id);
        if (target) openDetail(target);
      };
    } catch {}
  }
  if (items.length > shown.length) {
    try {
      new Notification('还有更多新通知', { body: `本次共 ${items.length} 条新通知`, tag: 'bn-more' });
    } catch {}
  }
}

/** 检查新通知；两种模式都是本地比对 id（静态模式下数据随快照更新） */
function checkNew({ silentIfFirst = false } = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const baseline = stateStore.notifiedId;
  const maxId = ITEMS.reduce((m, i) => Math.max(m, i.id), 0);
  if (!baseline) { stateStore.setNotified(maxId); return; }
  const fresh = ITEMS.filter((i) => i.id > baseline);
  if (fresh.length) {
    if (!silentIfFirst) notifyNew(fresh);
    stateStore.setNotified(maxId);
  }
}

// ============================================================
// 设置面板
// ============================================================

function fillSettingsForm() {
  const s = INDEX.settings;
  const apiMode = data.isApi;
  $('#settingsApiNote').classList.toggle('hidden', apiMode);
  document.querySelectorAll('.api-only').forEach((n) => n.classList.toggle('hidden', !apiMode));

  if (s) {
    $('#setAutoFetch').checked = !!s.autoFetch;
    $('#setCron').value = s.cron || '';
    $('#setFetchColleges').checked = !!s.fetchColleges;
    $('#setPages').value = s.pages ?? 2;
    $('#setEnrich').value = s.enrich ?? 25;
    $('#setImportantOnly').checked = !!s.notifyImportantOnly;
  } else {
    // 静态模式没有服务端设置，偏好存在本机
    $('#setImportantOnly').checked = !!local.get('importantOnly', false);
  }
  $('#setPollInterval').value = String(local.get('pollInterval', 300));
  renderPushRow();

  const grid = $('#setNotifyCats');
  grid.textContent = '';
  const enabled = new Set(s?.notifyCategories || INDEX.categories.map((c) => c.id));
  for (const c of INDEX.categories) {
    const label = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = enabled.has(c.id);
    cb.dataset.cat = c.id;
    label.append(cb, el('span', '', c.name));
    grid.append(label);
  }
  grid.onchange = () => {
    const cats = [...grid.querySelectorAll('input:checked')].map((i) => i.dataset.cat);
    data.saveSettings({ notifyCategories: cats }).catch(() => {});
  };

  const info = $('#settingsStatus');
  info.textContent = data.isApi
    ? `本地服务模式 · 快照 ${INDEX.version}`
    : `静态托管模式 · 快照 ${INDEX.version} · 生成于 ${new Date(INDEX.generatedAt).toLocaleString('zh-CN')}`;
}

function wireSettings() {
  $('#setPollInterval').onchange = (e) => {
    local.set('pollInterval', +e.target.value);
    startNotifyPolling();
    toast('提醒检查间隔已更新');
  };
  $('#setAutoFetch').onchange = (e) => data.saveSettings({ autoFetch: e.target.checked }).catch((x) => toast(x.message));
  $('#setCron').onchange = (e) => data.saveSettings({ cron: e.target.value.trim() }).catch((x) => toast(x.message));
  $('#setFetchColleges').onchange = (e) => data.saveSettings({ fetchColleges: e.target.checked }).catch((x) => toast(x.message));
  $('#setPages').onchange = (e) => data.saveSettings({ pages: +e.target.value }).catch((x) => toast(x.message));
  $('#setEnrich').onchange = (e) => data.saveSettings({ enrich: +e.target.value }).catch((x) => toast(x.message));
  $('#setImportantOnly').onchange = (e) => {
    local.set('importantOnly', e.target.checked);
    if (data.isApi) data.saveSettings({ notifyImportantOnly: e.target.checked }).catch(() => {});
  };
  $('#btnClearRead').onclick = () => {
    stateStore.clearRead();
    toast('已清除全部已读标记');
    render();
  };
}

// ============================================================
// 抓取（仅 API / App 模式）
// ============================================================

/**
 * 刷新按钮的转动状态只有一个来源：**服务端/本机真实的抓取状态**。
 *
 * 这是一个真实 bug 的修法。以前按钮的 spin 类由两处各自设置：
 *   · 点击处理里直接加 spin
 *   · updateSubtitle() 里「如果 st.fetching 就加 spin」
 * 两处互相打架，且都只看「有没有在抓」，不看「用户点的那次有没有被接受」。
 * 于是：进页面时首次抓取还在跑（手机上 1~2 分钟），用户点「刷新」→
 * triggerFetch 抛「正在抓取中」→ 点击处理 remove('spin') 并弹错误提示，
 * 但 2 秒后 updateSubtitle 又 add('spin') 回来 → **按钮一直转，还配一句
 * 「正在抓取中」的报错**，看起来就是彻底卡死（用户反馈的「点了刷新后一直转」）。
 *
 * 现在统一：spin 类只在 syncFetchButton() 里根据真实状态设置；
 * 点击只是「请求开始」，被拒绝时不再报错（那本来就不是错误，是已经在做了），
 * 而是把当前进度显示出来，让用户明白「它确实在干活」。
 */
let fetchWatchTimer = null;

/** 最近一次已知的抓取状态——syncFetchButton() 不传参时用它 */
let lastFetchStatus = null;

/**
 * 静态模式下「检查更新」是否正在进行。
 * 与 fetchWatchTimer 一样，这是一个**状态**，不是对按钮的直接操作——
 * 按钮的外观永远由 syncFetchButton() 从状态派生，避免多处各管一摊。
 */
let refreshingSnapshot = false;

function syncFetchButton(status) {
  const btn = $('#btnFetch');
  const btnDisabled = $('#btnFetchDisabled');
  // 两个按钮分别对应两种模式：抓取中 → 「刷新」转；检查快照中 → 「更新」转。
  // 传 status 时以它为准；不传（本地触发）时用最近一次已知状态。
  if (status) lastFetchStatus = status;
  const spinning = !!lastFetchStatus?.fetching;
  if (btn) btn.classList.toggle('spin', spinning);
  if (btnDisabled) btnDisabled.classList.toggle('spin', !!refreshingSnapshot);
}

/** 抓取过程中的进度文案（让「按钮在转」有解释，而不是让人干等） */
function fetchProgressText(st) {
  if (!st?.fetching) return null;
  const p = st.progress;
  const detail = p && p.total ? `（${p.done}/${p.total}${p.source ? ` · ${p.source}` : ''}）` : '';
  return ITEMS.length
    ? `正在更新${detail} · 已有 ${ITEMS.length} 条`
    : `正在抓取最新通知${detail}，首次约需 1-2 分钟`;
}

/**
 * 观察一次抓取直到结束。
 *
 * 相比原来的实现有三点不同：
 *   1) 不再依赖「抓取过程中拿到的 lastResult」——App 端后台补正文阶段结束时
 *      lastResult 可能为 null，早期实现据此显示「抓取结束」，信息量为零；
 *      改为对比「抓取前后的条目数」得出真正新增了多少。
 *   2) 轮询间隔从 1.5s 放宽到 2s，并在页面隐藏时暂停——手机上抓取时
 *      每秒一次的请求 + 重渲染会额外拖慢本来就吃力的首轮抓取。
 *   3) 超时（10 分钟）后**明确解除按钮转动**并提示，而不是一直转下去。
 */
async function startFetch({ reloadWhenDone = false } = {}) {
  const before = ITEMS.length;

  try {
    await data.triggerFetch();
  } catch (e) {
    // 「已有任务在运行」不是错误，是幂等情况：把当前进度告诉用户就好
    const st = await data.fetchStatus().catch(() => null);
    if (st?.fetching) {
      const txt = fetchProgressText(st);
      toast(txt ? `${txt}…已在抓取中，稍候即可` : '已在抓取中，稍候即可');
      watchFetch({ before, reloadWhenDone });
      return;
    }
    toast(e.message || '触发抓取失败');
    syncFetchButton(await data.fetchStatus().catch(() => null));
    return;
  }

  toast('已开始抓取最新通知…');
  watchFetch({ before, reloadWhenDone });
}

function watchFetch({ before = 0, reloadWhenDone = false } = {}) {
  clearInterval(fetchWatchTimer);
  const startedAt = Date.now();
  const MAX_MS = 10 * 60 * 1000;
  // 状态查询连续失败计数：放在外层，否则每次 tick 都被重置，永远到不了阈值
  let statusFails = 0;

  const tick = async () => {
    let st = null;
    try {
      st = await data.fetchStatus();
    } catch {
      // 状态查询失败不应让按钮永远卡住：连续失败就当作结束
      if (++statusFails >= 5) {
        clearInterval(fetchWatchTimer);
        fetchWatchTimer = null;
        syncFetchButton({ fetching: false });
        toast('抓取状态查询失败，请下拉/重新打开页面确认结果');
      }
      return;
    }
    statusFails = 0;
    syncFetchButton(st);

    // 抓取中：把进度写进副标题，用户能看见进展
    const txt = fetchProgressText(st);
    if (txt) $('#brandSub').textContent = txt;
    else if (st?.background) {
      $('#brandSub').textContent = `后台补齐正文…（可正常浏览，已有 ${ITEMS.length} 条）`;
    }

    if (st?.fetching) {
      if (Date.now() - startedAt > MAX_MS) {
        clearInterval(fetchWatchTimer);
        fetchWatchTimer = null;
        syncFetchButton({ fetching: false });
        toast('抓取时间超出预期，已停止等待。可稍后重新打开页面查看', 5000);
      }
      return;
    }

    // 结束了
    clearInterval(fetchWatchTimer);
    fetchWatchTimer = null;
    syncFetchButton({ fetching: false });

    // 重新取一次条目清单，好算出真实新增数（不依赖 lastResult：
    // App 端后台补正文结束时 lastResult 可能为 null）
    let after = ITEMS.length;
    if (typeof data.loadItems === 'function') {
      try {
        await data.loadItems();
        after = data.items?.length ?? ITEMS.length;
      } catch { /* 取不到就沿用旧值 */ }
    }
    const added = Math.max(0, after - before);
    toast(added > 0 ? `抓取完成，新增 ${added} 条` : `抓取完成，暂无新通知（库内 ${after} 条）`);

    if (reloadWhenDone) {
      // 本地服务（网页）模式：重新载入最干净，也顺带刷新统计
      setTimeout(() => location.reload(), 700);
    } else {
      // App 模式：不刷新页面，直接让界面吃下新数据
      await updateSubtitle();
      render();
    }
  };

  fetchWatchTimer = setInterval(tick, 2000);
  tick();

  // 页面进后台时暂停轮询（手机上尤其重要：抓取本身就吃网络）
  if (document.__bnVisHook !== true) {
    document.__bnVisHook = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && fetchWatchTimer) {
        clearInterval(fetchWatchTimer);
        fetchWatchTimer = null;
        watchFetch({ before: ITEMS.length });
      }
    });
  }
}

async function triggerFetch() {
  // 网页版走本地服务：抓完重载页面；App 端靠 onChange 回调增量刷新
  return startFetch({ reloadWhenDone: !!data.isApi && data.mode !== 'app' });
}

// ============================================================
// 主渲染
// ============================================================

/**
 * 重置视图。
 *
 * 注意必须一并清空快速筛选（state.filters）——否则「★ 我的学院」这类
 * 通过 filters 实现的筛选会残留：点「全部通知」后列表仍然只显示该学院，
 * 用户会被永久困在这个筛选里（本项目踩过这个坑：
 * 表现为点「全部通知」没反应、搜索也被限缩在该学院内）。
 *
 * @param {boolean} keepCategory 为 true 时保留当前栏目（切换标签/信源时用）
 */
function resetView(keepCategory = false) {
  if (!keepCategory) {
    state.category = 'all';
    state.source = null;
    state.tag = null;
    state.filters.clear();
  }
  state.shown = state.pageSize;
}

function render() {
  renderCategories();
  renderActiveFilters();
  syncQuickFilters();
  renderFeed();
  renderTags();
  renderSources();
  renderStats();
  renderWatchBadge();
}

async function updateSubtitle() {
  const st = await data.fetchStatus();
  const mode = $('#modeIndicator');

  // 抓取进行中：显示进度，避免用户面对空白界面不知所措
  // （App 首次启动要抓 113 个信源，约 1.5 分钟）
  //
  // 注意：按钮的转动状态**只**由 syncFetchButton 统一设置，这里不再各自
  // add/remove('spin')——两处同时管一个类，正是「点刷新后一直转」的成因。
  if (st?.fetching) {
    $('#brandSub').textContent = fetchProgressText(st);
  } else if (st?.background) {
    // 后台补正文：界面完全可用，不该让用户以为「还在抓取」而干等。
    // 阶段一（列表）早已结束、内容已全部入库，这一步只是补每条的正文，
    // 用于卡片摘要与截止提醒，能不能补到不影响浏览。
    $('#brandSub').textContent = `后台补齐正文…（可正常浏览，已有 ${ITEMS.length} 条）`;
  }
  syncFetchButton(st);

  if (data.isApi) {
    if (mode) mode.textContent = '本机数据';
    const unread = ITEMS.filter((i) => !stateStore.isRead(i)).length;
    if (!st?.fetching && !st?.background) {
      $('#brandSub').textContent = st?.lastRun
        ? `上次抓取 ${relTime(st.lastRun)} · 库内 ${ITEMS.length} 条 · 未读 ${unread}`
        : `库内 ${ITEMS.length} 条 · 未读 ${unread}`;
    }
    // 本地模式：显示「刷新」按钮（可触发抓取）
    $('#btnFetch').classList.remove('hidden');
    $('#btnFetchDisabled').classList.add('hidden');
  } else {
    if (mode) mode.textContent = '线上数据';
    $('#brandSub').textContent = `数据更新于 ${relTime(INDEX.generatedAt)} · 共 ${INDEX.total} 条`;
    // 静态模式：显示「更新」按钮（重新拉取快照）
    $('#btnFetch').classList.add('hidden');
    $('#btnFetchDisabled').classList.remove('hidden');
  }
}

// ============================================================
// Web Push（后台推送，页面关闭也能收到）
// ============================================================

/**
 * 把 base64url 的 VAPID 公钥转成 Uint8Array（浏览器订阅接口要求二进制）。
 * 直接传字符串在部分浏览器上会抛 InvalidCharacterError。
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pushState = {
  ready: false,
  subscribed: false,
  workerUrl: null,
};

/** 探测推送后端是否可用（Worker 地址来自快照配置，未配置则不可用） */
async function initPush() {
  const url = INDEX.pushWorkerUrl || local.get('pushWorkerUrl', null);
  if (!url) return;                       // 未部署 Worker
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  pushState.workerUrl = url.replace(/\/$/, '');
  try {
    const res = await fetch(`${pushState.workerUrl}/vapid-public-key`);
    const data = await res.json();
    if (!data.publicKey) return;
    pushState.publicKey = data.publicKey;
    pushState.ready = true;

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    pushState.subscribed = !!existing;
  } catch {
    pushState.ready = false;
  }
}

/** 订阅后台推送 */
async function subscribePush() {
  if (!pushState.ready) throw new Error('后台推送尚未部署（未配置推送服务地址）');
  if (Notification.permission !== 'granted') {
    const ok = await requestNotifyPermission();
    if (!ok) throw new Error('未授予通知权限');
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushState.publicKey),
    });
  }

  const cats = [...document.querySelectorAll('#setNotifyCats input:checked')].map((i) => i.dataset.cat);
  const importantOnly = !!$('#setImportantOnly')?.checked;

  const res = await fetch(`${pushState.workerUrl}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), categories: cats, importantOnly }),
  });
  if (!res.ok) throw new Error('订阅登记失败');
  pushState.subscribed = true;
  local.set('pushEnabled', true);
  return true;
}

/** 取消后台推送 */
async function unsubscribePush() {
  if (!pushState.workerUrl) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    try {
      await fetch(`${pushState.workerUrl}/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
    } catch {}
    await sub.unsubscribe();
  }
  pushState.subscribed = false;
  local.set('pushEnabled', false);
}

function renderPushRow() {
  const row = $('#pushRow');
  const btn = $('#btnPushToggle');
  const note = $('#pushNote');
  if (!row) return;

  // 只在支持推送且后端已部署时展示
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  if (!supported || !pushState.ready) {
    row.classList.add('hidden');
    if (note) {
      note.textContent = pushState.ready
        ? '当前浏览器不支持后台推送。'
        : '后台推送需要部署 Cloudflare Worker（见 README「开启手机后台推送」），未部署时只有页面打开时才能提醒。';
    }
    return;
  }
  row.classList.remove('hidden');
  btn.textContent = pushState.subscribed ? '已开启，点击关闭' : '开启后台推送';
  if (note) {
    note.textContent = pushState.subscribed
      ? '已开启：即使关掉网页，有新通知也会推送到这台设备。'
      : '开启后即使关掉网页也能收到新通知推送。';
  }
}

/**
 * 收起移动端侧栏。
 *
 * 手机端侧栏是覆盖在列表之上的抽屉（position: fixed），
 * 选中栏目后如果不收起，用户看不到列表更新，会以为「点了没反应」，
 * 需要再点一次「栏目」关闭抽屉才看到结果。
 */
function closeSidebar() {
  const sb = $('#sidebar');
  if (sb) sb.classList.remove('open');
}

function bindEvents() {
  let searchTimer = null;
  $('#searchInput').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    $('#btnSearchClear').classList.toggle('hidden', !v);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = v;
      state.shown = state.pageSize;
      renderActiveFilters();
      renderFeed();
    }, 260);
  });
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      state.q = e.target.value.trim();
      state.shown = state.pageSize;
      renderActiveFilters();
      renderFeed();
    }
  });
  $('#btnSearchClear').onclick = () => {
    $('#searchInput').value = '';
    state.q = '';
    $('#btnSearchClear').classList.add('hidden');
    renderActiveFilters();
    renderFeed();
  };

  document.querySelectorAll('.qf').forEach((b) => {
    b.onclick = () => {
      const f = b.dataset.filter;
      if (state.filters.has(f)) state.filters.delete(f); else state.filters.add(f);
      state.shown = state.pageSize;
      render();
    };
  });

  $('#sortSelect').onchange = (e) => { state.sort = e.target.value; renderFeed(); };
  $('#btnLoadMore').onclick = () => { state.shown += state.pageSize; renderFeed(); };
  $('#btnDrawerClose').onclick = closeDetail;
  $('#drawerMask').onclick = closeDetail;
  $('#btnDeadline').onclick = openDeadlines;
  $('#btnDeadlineClose').onclick = () => $('#deadlinePanel').classList.add('hidden');
  $('#btnSettings').onclick = () => { fillSettingsForm(); $('#settingsPanel').classList.remove('hidden'); };
  $('#btnSettingsClose').onclick = () => $('#settingsPanel').classList.add('hidden');

  // ---------- 我的关注 ----------
  $('#btnWatch').onclick = openWatch;
  $('#btnWatchClose').onclick = () => $('#watchPanel').classList.add('hidden');

  const addKw = () => {
    const inp = $('#kwInput');
    const w = inp.value.trim();
    if (!w) return;
    if (addKeyword(w)) {
      inp.value = '';
      // 立即在当前数据里跑一遍，让用户马上看到「命中了多少条」
      const { added, hits } = syncKeywordHits(ITEMS);
      renderWatchPanel();
      renderWatchBadge();
      renderFeed();
      toast(added
        ? `已关注「${w}」，命中 ${hits.length} 条，其中 ${added} 条已加入关注清单`
        : `已关注「${w}」，当前 ${hits.length} 条命中，暂无新条目`);
    } else {
      toast(`「${w}」已经在关注里了`);
    }
  };
  $('#btnKwAdd').onclick = addKw;
  $('#kwInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addKw(); }
  });

  $$('#btnExportIcs').onclick = () => {
    const rows = resolveWatchList(ITEMS, deadlineByItem);
    if (!rows.length) { toast('关注清单是空的，先关注几条通知'); return; }
    const text = downloadIcs(rows);
    toast(`已生成日历文件（${rows.length} 个日程），用手机日历打开即可导入`, 5000);
    return text;
  };

  $$('#btnCopyIcs').onclick = async () => {
    const rows = resolveWatchList(ITEMS, deadlineByItem);
    if (!rows.length) { toast('关注清单是空的'); return; }
    const text = buildIcs(rows);
    try {
      await navigator.clipboard.writeText(text);
      toast('日历内容已复制（可粘贴到日历 App 或保存为 .ics 文件）');
    } catch {
      toast('复制失败，请改用「导出到手机日历」');
    }
  };

  $('#setLeadDays').onchange = (e) => {
    savePrefs({ leadDays: Number(e.target.value) });
    renderWatchPanel();
    toast('已更新提前提醒天数');
  };
  $('#setReminderHour').onchange = (e) => {
    savePrefs({ reminderHour: Number(e.target.value) });
    renderWatchPanel();
    toast('已更新提醒时间');
  };
  $('#btnClearAuto').onclick = () => {
    const n = clearAutoWatched();
    renderWatchBadge();
    renderWatchPanel();
    renderFeed();
    toast(n ? `已移除 ${n} 条关键词自动加入的关注` : '没有关键词自动加入的关注项');
  };
  $('#btnClearAllWatch').onclick = () => {
    const n = Object.keys(loadWatched()).length;
    if (!n) { toast('关注清单已经是空的'); return; }
    // 清空是破坏性操作，且清单是用户一条条攒的，必须确认
    if (!window.confirm(`确定清空全部 ${n} 条关注吗？清空后提醒会回到「全部通知」。`)) return;
    clearWatched();
    renderWatchBadge();
    renderWatchPanel();
    renderFeed();
    toast('关注清单已清空');
  };

  $('#btnFetch').onclick = triggerFetch;
  // 静态模式：按钮改为「检查更新」——重新拉取快照（绕过本地缓存），而不是触发服务端抓取。
  //
  // ⚠ 这里也踩过同一个坑：按钮的 spin 类不能由点击处理自己 add/remove，
  //   否则 updateSubtitle() 里的 syncFetchButton 会在下一秒把它清掉，
  //   或者反过来把它加上（状态与操作不一致 → 按钮「一直转」或「点了没反应」）。
  //   统一做法：点击只改 refreshingSnapshot 这个**状态**，转动由 syncFetchButton 派生。
  $('#btnFetchDisabled').onclick = async () => {
    if (refreshingSnapshot) { toast('正在检查更新，请稍候'); return; }
    refreshingSnapshot = true;
    syncFetchButton();
    try {
      const res = await fetch('./data/index.json', { cache: 'no-store' });
      const fresh = await res.json();
      if (fresh.version === INDEX.version) {
        toast('已是最新数据');
        return;
      }
      await data.init();
      await data.loadItems({ force: true });
      INDEX = data.index;
      ITEMS = data.items;
      buildDeadlineIndex();
      render();
      await updateSubtitle();
      toast(`数据已更新至最新（共 ${INDEX.total} 条）`);
    } catch (e) {
      toast(`检查更新失败：${e.message}`);
    } finally {
      refreshingSnapshot = false;
      syncFetchButton();
    }
  };

  $('#btnMarkAllRead').onclick = () => {
    const list = applyFilters();
    stateStore.markAllRead(list);
    toast(`已将 ${list.length} 条标为已读`);
    render();
  };

  $('#btnNotify').onclick = async () => {
    const ok = await requestNotifyPermission();
    if (ok) {
      const maxId = ITEMS.reduce((m, i) => Math.max(m, i.id), 0);
      stateStore.setNotified(maxId);
      startNotifyPolling();
    }
  };
  $('#btnEnableNotify').onclick = $('#btnNotify').onclick;

  // 后台推送开关
  $$('#btnPushToggle').onclick = async () => {
    const btn = $('#btnPushToggle');
    if (btn) btn.disabled = true;
    try {
      if (pushState.subscribed) {
        await unsubscribePush();
        toast('已关闭后台推送');
      } else {
        await subscribePush();
        toast('后台推送已开启，关掉网页也能收到通知');
      }
      renderPushRow();
    } catch (e) {
      toast(e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  // Service Worker 通知订阅轮换 → 自动重新订阅
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'pushsubscriptionchange' && local.get('pushEnabled', false)) {
        subscribePush().catch(() => {});
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDetail();
      $('#deadlinePanel').classList.add('hidden');
      $('#settingsPanel').classList.add('hidden');
    }
    if (e.key === '/' && document.activeElement !== $('#searchInput')) {
      e.preventDefault();
      $('#searchInput').focus();
    }
  });

  // 移动端底部导航
  document.querySelectorAll('.mnav-btn').forEach((b) => {
    b.onclick = () => {
      const target = b.dataset.target;
      if (target === 'menu') {
        $('#sidebar').classList.toggle('open');
        return;
      }
      closeSidebar();
      if (target === 'deadlines') { openDeadlines(); return; }
      if (target === 'watch') { openWatch(); return; }
      if (target === 'search') { $('#searchInput').focus(); return; }
      if (target === 'fetch') {
        if (data.isApi) triggerFetch();
        else toast('静态托管模式：数据由服务器定时更新');
        return;
      }
      resetView();
      render();
    };
  });

  // 点击侧栏之外的区域也收起抽屉（移动端常见交互期待）
  document.addEventListener('click', (e) => {
    const sb = $('#sidebar');
    if (!sb?.classList.contains('open')) return;
    if (sb.contains(e.target)) return;
    if (e.target.closest?.('.mnav-btn[data-target="menu"]')) return;
    closeSidebar();
  });

  wireSettings();
}

let notifyTimer = null;
function startNotifyPolling() {
  clearInterval(notifyTimer);
  const interval = (local.get('pollInterval', 300)) * 1000;
  notifyTimer = setInterval(() => {
    // API 模式下拉取最新条目比对；静态模式数据固定，无需轮询
    if (data.isApi) {
      refreshItems()
        .then(() => {
          // 关键词语义：只要命中的是新条目就提醒（不必先看老的已读基线）
          syncKeywordHits(ITEMS);
          notifyWatchedNew();
          checkNew();
        })
        .catch(() => {});
    } else {
      syncKeywordHits(ITEMS);
      notifyWatchedNew();
      checkNew();
    }
  }, interval);
}

async function refreshItems() {
  await data.loadItems({ force: true });
  ITEMS = data.items.map((it) => ({
    ...it,
    isRead: stateStore.isRead(it),
    starred: stateStore.isStarred(it),
  }));
}

// ============================================================
// 启动
// ============================================================

async function init() {
  bindEvents();
  try {
    await data.init();
    await data.loadItems();
    INDEX = data.index;
    ITEMS = data.items;
    buildDeadlineIndex();

    if (!data.isApi) {
      $('#brandSub').textContent = `数据更新于 ${relTime(INDEX.generatedAt)} · 共 ${INDEX.total} 条`;
    }

    // 优先学院：聚合该学院在配置里的全部信源（通知公告 / 学院新闻 / 教学科 …）。
    // 信源 id 形如 col-cst、col-cst-1、col-cst-2，按前缀归组；
    // 只认一个信源会导致该学院其它栏目在界面上"消失"。
    const priorityName = INDEX.priorityCollegeName;
    if (priorityName) {
      const all = INDEX.sources || [];
      // 先按名字找出主信源，取出它的基础 id（去掉 -N 后缀），再收集同前缀的
      const primary = all.find((s) => (s.name || '').startsWith(priorityName) && s.categoryId === 'college')
        || all.find((s) => (s.name || '').includes('计算机') && s.categoryId === 'college')
        || all.find((s) => (s.name || '').startsWith(priorityName.replace('学院', '')) && s.categoryId === 'college');
      if (primary) {
        const base = primary.id.replace(/-\d+$/, '');
        state.prioritySourceId = primary.id;
        state.prioritySourceIds = all
          .filter((s) => s.id === base || s.id.startsWith(`${base}-`))
          .map((s) => s.id);
      }
    }

    resetView();
    render();
    renderPushRow();

    // 关注相关：先把已有关键词在当前数据上跑一遍（用户上次设的关键词，
    // 可能在这次快照里才首次出现），再校准角标与面板
    syncKeywordHits(ITEMS);
    renderWatchBadge();
    fillWatchPrefs();

    // App 模式下注册数据变化回调：
    // 首次启动时库是空的，界面先渲染 0 条，随后后台抓取完成——
    // 必须靠这个回调重新渲染，否则用户看到的永远是空 App（本项目踩过这个坑）。
    if (typeof data.onChange !== 'undefined') {
      data.onChange = (items) => {
        ITEMS = items;
        buildDeadlineIndex();
        // 新抓回来的数据里可能有命中关键词的条目：同步进关注清单并提醒
        syncKeywordHits(ITEMS);
        render();
        renderWatchBadge();
        if (!$('#watchPanel').classList.contains('hidden')) renderWatchPanel();
        updateSubtitle();
        notifyWatchedNew();
      };
    }

    // 首次进入校准提醒基线，避免把历史通知全部弹出来
    const maxId = ITEMS.reduce((m, i) => Math.max(m, i.id), 0);
    if (!stateStore.notifiedId) stateStore.setNotified(maxId);
    const fresh = stateStore.freshCount(ITEMS);
    if (fresh > 0) toast(`${fresh} 条新通知（上次访问后）`, 4000);
    stateStore.snapshotVisit(maxId);

    startNotifyPolling();
    await initPush();
    await updateSubtitle();

    // 抓取进行中时加快刷新频率，让进度动起来
    // （App 首次启动要抓 102 个信源，约 1-2 分钟，没有反馈会让人以为卡死）
    const fastTick = setInterval(async () => {
      const st = await data.fetchStatus();
      if (!st?.fetching) { clearInterval(fastTick); return; }
      await updateSubtitle();
    }, 2000);
    setTimeout(() => clearInterval(fastTick), 5 * 60 * 1000);

    // 定时刷新：API 模式重新拉取条目；两种模式都更新副标题
    setInterval(async () => {
      if (data.isApi) {
        await refreshItems();
        render();
      }
      await updateSubtitle();
    }, 60000);
  } catch (e) {
    $('#brandSub').textContent = `数据加载失败：${e.message}`;
    $('#feed').append(el('div', 'empty', `无法加载数据：${e.message}`));
    console.error(e);
  }

  // 注册 service worker：离线可打开、支持添加到主屏幕
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
