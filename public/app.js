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
 * 搜索匹配（按标题搜索）。
 *
 * 语义（按用户明确要求）：
 *   · 只看标题
 *   · 多个关键词以空格分隔，**每个词都要出现在标题里**（顺序不限）
 *     例：「奖学金 公示」= 标题同时含这两个词
 *
 * 为什么不做正文/摘要匹配：曾经把整篇正文纳入并加模糊兜底，
 * 结果是搜什么都出一大堆、看不出关联，用户直接反馈「搜索几乎没用」。
 * 纯标题匹配的结果集小但条条对得上，符合「按标题找通知」的实际用法。
 *
 * 返回 1 表示命中（统一分值，排序仍按发布时间倒序）。
 */
function matchScore(item, q) {
  const terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  const title = (item.title || '').toLowerCase();
  return terms.every((t) => title.includes(t)) ? 1 : 0;
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
  const soon = (INDEX.deadlines || []).filter((d) => d.daysLeft >= 0).length;
  const chips = [['库内', ITEMS.length, ''], ['未读', unread, unread ? 'alert' : ''], ['重要', important, '']];
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
  const names = { unread: '未读', important: '重要', starred: '收藏', today: '今日', week: '近 7 天', deadline: '有截止时间' };
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

  const actions = el('div', 'actions');
  const star = el('button', `icon-btn${starred ? ' on' : ''}`, starred ? '★' : '☆');
  star.title = '收藏';
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
      content.textContent = it.excerpt || '（未抓取到正文，请点击右上角「查看原文」）';
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
    err.append(el('p', '', `正文加载失败：${e.message}`));
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
// 抓取（仅本地服务模式）
// ============================================================

async function triggerFetch() {
  const btn = $('#btnFetch');
  btn.classList.add('spin');
  try {
    await data.triggerFetch();
    toast('已开始抓取最新通知…');
    const tick = setInterval(async () => {
      const st = await data.fetchStatus();
      if (!st.fetching) {
        clearInterval(tick);
        btn.classList.remove('spin');
        toast(st.lastResult ? `抓取完成，新增 ${st.lastResult.inserted} 条` : '抓取结束');
        location.reload();
      }
    }, 1500);
    setTimeout(() => { clearInterval(tick); btn.classList.remove('spin'); }, 15 * 60 * 1000);
  } catch (e) {
    btn.classList.remove('spin');
    toast(e.message);
  }
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
}

async function updateSubtitle() {
  const st = await data.fetchStatus();
  const mode = $('#modeIndicator');

  // 抓取进行中：显示进度，避免用户面对空白界面不知所措
  // （App 首次启动要抓 102 个信源，约 1.5 分钟）
  if (st?.fetching) {
    const p = st.progress;
    const detail = p && p.total
      ? `（${p.done}/${p.total}${p.source ? ` · ${p.source}` : ''}）`
      : '';
    $('#brandSub').textContent = ITEMS.length
      ? `正在更新${detail} · 已有 ${ITEMS.length} 条`
      : `正在抓取最新通知${detail}，首次约需 1-2 分钟`;
    $('#btnFetch').classList.add('spin');
    $('#btnFetchDisabled').classList.add('spin');
  } else if (data.isApi) {
    $('#btnFetch').classList.remove('spin');
  }

  if (data.isApi) {
    if (mode) mode.textContent = '本机数据';
    const unread = ITEMS.filter((i) => !stateStore.isRead(i)).length;
    if (!st?.fetching) {
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

  $('#btnFetch').onclick = triggerFetch;
  // 静态模式：按钮改为「检查更新」——重新拉取快照（绕过本地缓存），而不是触发服务端抓取
  $('#btnFetchDisabled').onclick = async () => {
    const btn = $('#btnFetchDisabled');
    btn.classList.add('spin');
    try {
      const res = await fetch('./data/index.json', { cache: 'no-store' });
      const fresh = await res.json();
      if (fresh.version === INDEX.version) {
        toast('已是最新数据');
        btn.classList.remove('spin');
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
      btn.classList.remove('spin');
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
    if (data.isApi) refreshItems().then(() => checkNew()).catch(() => {});
    else checkNew();
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

    // App 模式下注册数据变化回调：
    // 首次启动时库是空的，界面先渲染 0 条，随后后台抓取完成——
    // 必须靠这个回调重新渲染，否则用户看到的永远是空 App（本项目踩过这个坑）。
    if (typeof data.onChange !== 'undefined') {
      data.onChange = (items) => {
        ITEMS = items;
        buildDeadlineIndex();
        render();
        updateSubtitle();
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
