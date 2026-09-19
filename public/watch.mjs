/**
 * 关注事项 · 关键词关注 · 手机日程导出
 *
 * 为什么需要这一层：原来的「提醒」是**全量**的——所有新通知都提醒、所有截止时间都列出来。
 * 但学生真正的需求是「筛出跟我有关的那几条」：
 *   · 「这个评奖跟我没关系，别再提醒我了」
 *   · 「国家奖学金这条我要跟到底」
 *   · 「凡标题带『选课』『开题』的都告诉我」
 * 所以需要一份**显式的关注清单**，提醒只围绕它展开，而不是围绕全库。
 *
 * 三种来源都会进同一个清单，并各自记住「为什么在这」（reason）：
 *   1) 手动关注某条通知           reason = 'manual'
 *   2) 关键词命中某条通知（自动）  reason = 'kw:<关键词>'
 *   3) 手动关注的关键词本身会随时匹配新条目（见 matchWatchedKeywords）
 *
 * 存储：localStorage（与已读/收藏同样的理由——静态托管没有后端可写，
 * 且「我关注什么」属于隐私，留在本机最合适）。
 */
import { titleMatches, expandQuery } from './aliases.mjs';

const LS_PREFIX = 'bn.';
const local = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch {}
  },
};

/** 与 store.js 完全一致的 URL 哈希（同一套键，避免两处算出不同结果） */
export function keyOf(item) {
  const url = typeof item === 'string' ? item : item?.url;
  if (!url) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const KEY_WATCHED = 'watched';        // { [key]: {url,title,reason,name,addedAt,publishedAt,deadline} }
const KEY_KEYWORDS = 'watchKeywords'; // [{ word, alert, enabled, addedAt }]
const KEY_LAST_SEEN = 'watchLastSeen';// { [key]: 已就通知过的条目 key 集合（避免重复弹）
const KEY_PREFS = 'watchPrefs';       // { leadDays, reminderHour, onlyWatchedAlerts, calendarTitle }

// ---------------------------------------------------------------- 关注清单

export function loadWatched() {
  const raw = local.get(KEY_WATCHED, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function saveWatched(map) {
  local.set(KEY_WATCHED, map);
}

export const isWatched = (item) => !!loadWatched()[keyOf(item)];

/**
 * 关注 / 取消关注一条通知。
 * @param {object} item 条目
 * @param {{reason?: string, name?: string}} [opts] reason 默认 'manual'；name 可选备注（如「我的」）
 * @returns {boolean} 关注后的状态（true = 已关注）
 */
export function toggleWatched(item, opts = {}) {
  const k = keyOf(item);
  if (!k) return false;
  const map = loadWatched();
  if (map[k]) {
    delete map[k];
    saveWatched(map);
    return false;
  }
  const dl = (item.__deadlines || []).map((d) => d.date).sort()[0] || null;
  map[k] = {
    url: item.url,
    title: item.title || '',
    reason: opts.reason || 'manual',
    name: opts.name || '',
    publishedAt: item.publishedAt || null,
    deadline: dl,
    addedAt: new Date().toISOString(),
  };
  saveWatched(map);
  return true;
}

/** 批量关注（用于「把当前搜索结果全部关注」） */
export function watchMany(items, opts = {}) {
  const map = loadWatched();
  let n = 0;
  for (const it of items) {
    const k = keyOf(it);
    if (!k || map[k]) continue;
    const dl = (it.__deadlines || []).map((d) => d.date).sort()[0] || null;
    map[k] = {
      url: it.url, title: it.title || '', reason: opts.reason || 'manual',
      name: opts.name || '', publishedAt: it.publishedAt || null,
      deadline: dl, addedAt: new Date().toISOString(),
    };
    n++;
  }
  saveWatched(map);
  return n;
}

export function unwatch(key) {
  const map = loadWatched();
  if (map[key]) { delete map[key]; saveWatched(map); return true; }
  return false;
}

export function clearWatched() {
  saveWatched({});
}

/**
 * 关注清单 + 实时条目信息合并后返回。
 *
 * 为什么要合并：清单里存的是「关注那一刻的快照」，而条目本身还会随抓取更新
 * （标题被修正、正文补齐后才有截止日期）。只读快照会让清单长期显示旧标题、
 * 并且永远看不到后来才识别出的截止时间。
 *
 * @param {Array} items 当前全量条目
 * @returns {Array<{key,item,meta,deadline,daysLeft,stale}>} stale = 该条目已不在当前数据里
 */
export function resolveWatchList(items, deadlineByItem = new Map()) {
  const map = loadWatched();
  const byKey = new Map();
  for (const it of items) byKey.set(keyOf(it), it);
  const out = [];
  for (const [key, meta] of Object.entries(map)) {
    const item = byKey.get(key) || null;
    const dl = item ? deadlineByItem.get(item.id) : null;
    out.push({
      key,
      item,
      meta,
      deadline: dl ? dl.date : meta.deadline || null,
      daysLeft: dl ? dl.daysLeft : null,
      stale: !item,
    });
  }
  // 排序：有截止且未过的排最前（按紧迫度），其余按发布时间倒序
  out.sort((a, b) => {
    const av = a.daysLeft, bv = b.daysLeft;
    const aHas = av !== null && av !== undefined && av >= 0;
    const bHas = bv !== null && bv !== undefined && bv >= 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas && av !== bv) return av - bv;
    return String(b.item?.publishedAt || b.meta.publishedAt || '')
      .localeCompare(String(a.item?.publishedAt || a.meta.publishedAt || ''));
  });
  return out;
}

// ---------------------------------------------------------------- 关键词关注

export function loadKeywords() {
  const raw = local.get(KEY_KEYWORDS, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x) => x && typeof x.word === 'string' && x.word.trim())
    .map((x) => ({
      word: x.word.trim(),
      alert: x.alert !== false,           // 是否在发现新条目时弹提醒
      enabled: x.enabled !== false,
      addedAt: x.addedAt || null,
    }));
}

function saveKeywords(list) {
  local.set(KEY_KEYWORDS, list);
}

/** 添加关键词；已存在则返回 false（不重复添加） */
export function addKeyword(word) {
  const w = String(word || '').trim();
  if (!w) return false;
  const list = loadKeywords();
  if (list.some((x) => x.word === w)) return false;
  list.push({ word: w, alert: true, enabled: true, addedAt: new Date().toISOString() });
  saveKeywords(list);
  return true;
}

export function removeKeyword(word) {
  const list = loadKeywords().filter((x) => x.word !== word);
  saveKeywords(list);
}

export function setKeywordEnabled(word, enabled) {
  const list = loadKeywords();
  const k = list.find((x) => x.word === word);
  if (k) { k.enabled = !!enabled; saveKeywords(list); }
}

/** 判断标题命中了哪些已启用关键词（复用搜索的别名/标点归一化，语义与搜索一致） */
export function matchedKeywords(title, keywords = loadKeywords()) {
  const out = [];
  for (const k of keywords) {
    if (!k.enabled) continue;
    if (titleMatches(title, k.word)) out.push(k.word);
  }
  return out;
}

/**
 * 找出「命中了关键词、但还没进过关注清单」的条目 → 自动加入清单。
 *
 * 为什么要自动加入：用户设「选课」是希望**以后**发选课通知能及时知道，
 * 而不是每次自己去搜。所以关键词命中即进清单，清单就成了「跟我有关的通知」总入口。
 *
 * @param {Array} items
 * @returns {{added: number, hits: Array<{item, reasons: string[]}>}}
 */
export function syncKeywordHits(items) {
  const kws = loadKeywords();
  const hits = [];
  if (!kws.length) return { added: 0, hits };
  const map = loadWatched();
  let added = 0;
  for (const it of items) {
    const reasons = matchedKeywords(it.title, kws);
    if (!reasons.length) continue;
    hits.push({ item: it, reasons });
    const k = keyOf(it);
    if (k && !map[k]) {
      const dl = (it.__deadlines || []).map((d) => d.date).sort()[0] || null;
      map[k] = {
        url: it.url, title: it.title || '',
        reason: `kw:${reasons[0]}`, name: '',
        publishedAt: it.publishedAt || null, deadline: dl,
        addedAt: new Date().toISOString(),
      };
      added++;
    }
  }
  if (added) saveWatched(map);
  return { added, hits };
}

/** 清掉所有「由关键词自动加入」的条目，保留手动关注的（用户说「无关的也要能去掉」） */
export function clearAutoWatched() {
  const map = loadWatched();
  let n = 0;
  for (const [k, v] of Object.entries(map)) {
    if (String(v.reason || '').startsWith('kw:')) { delete map[k]; n++; }
  }
  if (n) saveWatched(map);
  return n;
}

// ---------------------------------------------------------------- 提醒偏好

export function loadPrefs() {
  return {
    leadDays: 3,          // 提前几天提醒
    reminderHour: 9,      // 日程提醒落在几点
    keywordAlert: true,   // 关键词命中新条目时弹浏览器通知
    calendarTitle: '中北通知',  // 导出日程的事件前缀
    ...local.get(KEY_PREFS, {}),
  };
}

export function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  local.set(KEY_PREFS, next);
  return next;
}

// ---------------------------------------------------------------- 日程导出（.ics）

/** 生成日历事件需要的稳定 UID（同一条通知永远对应同一事件，重复导入即更新） */
const uidOf = (key, kind) => `bn-${key}-${kind}@better-news`;

function fmtDateTime(date, hour) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}T${p(hour)}0000`;
}

function fmtDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

/** ICS 文本转义：反斜杠、分号、逗号、换行都必须转义，否则日历会解析失败 */
function esc(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 要求每行不超过 75 字节，超出要折行（续行以空格开头） */
function fold(line) {
  const enc = new TextEncoder();
  let out = '';
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = enc.encode(ch).length;
    if (curLen + len > 72) { out += cur + '\r\n '; cur = ''; curLen = 0; }
    cur += ch; curLen += len;
  }
  return out + cur;
}

/** 时间戳：YYYYMMDDTHHMMSS（本地时间 + Z 表示 UTC；这里用当前 UTC 时间） */
function fmtStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * 把关注清单导出成 .ics（iCalendar）。
 *
 * 为什么用 .ics 而不是直接写手机日历：网页/WebView 无法直接写入系统日历。
 * 而 .ics 是所有手机日历都认的标准格式——下载后点击即可导入，
 * 之后由**系统日历**负责到点提醒。这样即使 App 没打开、网页关着，
 * 提醒依然会响（这正是用户要的「通过手机的日程表进行提醒」）。
 *
 * 事件时间：
 *   · 有识别到截止日期 → 在「截止日 - leadDays」当天 reminderHour 点提醒，全天事件标截止日
 *   · 没有截止日期     → 用发布时间当天提醒一次，避免清单里的事件在日历上凭空消失
 *
 * @param {ReturnType<typeof resolveWatchList>} list
 * @param {{leadDays?:number, reminderHour?:number, titlePrefix?:string, now?:Date}} [opts]
 * @returns {string} ICS 文本
 */
export function buildIcs(list, opts = {}) {
  const prefs = loadPrefs();
  const leadDays = opts.leadDays ?? prefs.leadDays;
  const hour = opts.reminderHour ?? prefs.reminderHour;
  const prefix = opts.titlePrefix ?? prefs.calendarTitle;
  const now = opts.now || new Date();
  const stamp = fmtStamp(now);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BetterNews//NUC Notice//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(prefix)} 关注事项`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    // 中国没有夏令时，固定 +08:00，避免各日历对 VTIMEZONE 支持不一导致时间漂移
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  for (const row of list) {
    const it = row.item;
    const title = it?.title || row.meta.title || '(已失效的关注项)';
    const source = it?.sourceName || '';
    const url = it?.url || row.meta.url || '';

    // 事件当天：优先「截止日 - leadDays」
    let day;
    let kind;
    if (row.deadline) {
      const d = new Date(`${row.deadline}T00:00:00+08:00`);
      d.setDate(d.getDate() - leadDays);
      day = d; kind = 'remind';
    } else {
      const base = it?.publishedAt || row.meta.publishedAt;
      day = base ? new Date(`${base}T00:00:00+08:00`) : new Date(now);
      kind = 'pub';
    }

    const descParts = [];
    if (row.deadline) descParts.push(`截止日期：${row.deadline}${row.daysLeft != null ? `（剩 ${row.daysLeft} 天）` : ''}`);
    if (row.meta.reason?.startsWith('kw:')) descParts.push(`来源：关键词关注「${row.meta.reason.slice(3)}」`);
    else if (row.meta.reason === 'manual') descParts.push('来源：手动关注');
    if (source) descParts.push(`发布：${source}`);
    if (url) descParts.push(`原文：${url}`);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uidOf(row.key, kind)}`);
    lines.push(`DTSTAMP:${stamp}`);
    // 定时提醒：截止前 leadDays 天的 hour 点，持续 30 分钟
    lines.push(`DTSTART;TZID=Asia/Shanghai:${fmtDateTime(day, hour)}`);
    lines.push(`DTEND;TZID=Asia/Shanghai:${fmtDateTime(day, hour + 1)}`);
    lines.push(`SUMMARY:${esc(prefix + '·' + title)}`);
    lines.push(`DESCRIPTION:${esc(descParts.join('\\n'))}`);
    if (url) lines.push(`URL:${esc(url)}`);
    // 到点弹系统提醒
    lines.push('BEGIN:VALARM');
    lines.push('TRIGGER:PT0M');
    lines.push('ACTION:DISPLAY');
    lines.push(`DESCRIPTION:${esc(title)}`);
    lines.push('END:VALARM');
    // 有截止的事再补一条「当天早上」的提醒
    if (row.deadline) {
      const dd = new Date(`${row.deadline}T00:00:00+08:00`);
      lines.push('BEGIN:VALARM');
      lines.push(`TRIGGER;VALUE=DATE-TIME:${fmtDateTime(dd, Math.min(hour, 8))}`);
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${esc(`今天截止：${title}`)}`);
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** 触发浏览器下载 .ics（App 内 WebView 会交给系统「日历」应用处理） */
export function downloadIcs(list, filename) {
  const text = buildIcs(list);
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `better-news-${fmtDate(new Date())}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return text;
}

// ---------------------------------------------------------------- 新命中提醒去重

/** 已经就某条目弹过提醒的集合（避免每次轮询重复弹） */
export function loadAlerted() {
  const raw = local.get(KEY_LAST_SEEN, []);
  return new Set(Array.isArray(raw) ? raw : []);
}

export function saveAlerted(set) {
  local.set(KEY_LAST_SEEN, [...set].slice(-2000));
}

export { expandQuery };
