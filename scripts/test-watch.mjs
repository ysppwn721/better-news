/**
 * 自测 watch.mjs：关注清单、关键词命中、ICS 日历导出。
 *
 * 重点是 ICS——手机日历对格式很挑（折行、转义、UID、时区），
 * 格式错了会「导入了但一条都没有」，而在手机上很难查。
 *
 * 用法: node scripts/test-watch.mjs
 */
import { readFileSync } from 'node:fs';

// 用最小 localStorage 垫片在 Node 里加载浏览器模块
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const m = await import('../public/watch.mjs');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const mkItem = (i, title, extra = {}) => ({
  id: i,
  url: `http://cst.nuc.edu.cn/info/1038/${1000 + i}.htm`,
  title,
  publishedAt: '2026-09-01',
  sourceId: 'col-cst',
  sourceName: '计算机科学与技术学院',
  categoryId: 'college',
  categoryName: '学院通知',
  tags: [],
  important: false,
  ...extra,
});

console.log('=== 1. 关注 / 取消关注 ===');
const a = mkItem(1, '关于开展2026年国家奖学金评审工作的通知');
check('初始未关注', m.isWatched(a) === false);
check('关注成功', m.toggleWatched(a) === true);
check('再查已在清单', m.isWatched(a) === true);
check('清单里有 1 条', Object.keys(m.loadWatched()).length === 1);
check('取消关注', m.toggleWatched(a) === false);
check('清单已空', Object.keys(m.loadWatched()).length === 0);

console.log('\n=== 2. 关键词关注 + 自动进清单 ===');
m.addKeyword('选课');
m.addKeyword('综测');
check('重复添加返回 false', m.addKeyword('选课') === false);
check('关键词数 = 2', m.loadKeywords().length === 2);

const items = [
  mkItem(1, '关于2026-2027学年第一学期选课工作的通知'),
  mkItem(2, '机械工程学院本科生综合素质测评成绩排名公示'),
  mkItem(3, '关于举办秋季运动会的通知'),
  mkItem(4, '2026年国家奖学金评审工作安排'),
];
const sync = m.syncKeywordHits(items);
check('命中 2 条', sync.hits.length === 2, `实际 ${sync.hits.length}`);
check('自动加入清单 2 条', sync.added === 2);
check('「综测」命中全称标题', sync.hits.some((h) => h.item.title.includes('综合素质测评')));
check('无关条目未进清单', !m.isWatched(items[2]));
check('无关的奖学金条目也未进清单', !m.isWatched(items[3]));

console.log('\n=== 3. 手动关注 + 清除自动项（「无关的也要能去掉」）===');
m.toggleWatched(items[3]);   // 手动关注奖学金那条
check('手动关注生效', m.isWatched(items[3]) === true);
const beforeCount = Object.keys(m.loadWatched()).length;
check('清单共 3 条', beforeCount === 3, `实际 ${beforeCount}`);
const removed = m.clearAutoWatched();
check('清除自动项 2 条', removed === 2);
check('手动关注的保留', m.isWatched(items[3]) === true);
check('自动项的已移除', m.isWatched(items[0]) === false);

console.log('\n=== 4. 关注清单解析（合并实时数据）===');
const dl = new Map([[4, { itemId: 4, date: '2026-09-30', daysLeft: 11 }]]);
const resolved = m.resolveWatchList(items, dl);
check('清单 1 条', resolved.length === 1);
check('取到实时条目', resolved[0].item?.title === items[3].title);
check('取到截止时间', resolved[0].deadline === '2026-09-30');
check('取到剩余天数', resolved[0].daysLeft === 11);
check('标记为未失效', resolved[0].stale === false);

console.log('\n=== 5. ICS 日历导出 ===');
const ics = m.buildIcs(resolved, { leadDays: 3, reminderHour: 9, titlePrefix: '中北通知', now: new Date('2026-09-19T02:00:00Z') });
const lines = ics.split('\r\n');

check('以 BEGIN:VCALENDAR 开头', lines[0] === 'BEGIN:VCALENDAR');
check('以 END:VCALENDAR 结尾', ics.trimEnd().endsWith('END:VCALENDAR'));
check('含 VERSION:2.0', ics.includes('VERSION:2.0'));
check('含 PRODID', /PRODID:/.test(ics));
check('含 VTIMEZONE + Asia/Shanghai', ics.includes('BEGIN:VTIMEZONE') && ics.includes('TZID:Asia/Shanghai'));
check('含 1 个 VEVENT', (ics.match(/BEGIN:VEVENT/g) || []).length === 1);
check('BEGIN/END VEVENT 配对', (ics.match(/BEGIN:VEVENT/g) || []).length === (ics.match(/END:VEVENT/g) || []).length);
check('BEGIN/END VALARM 配对', (ics.match(/BEGIN:VALARM/g) || []).length === (ics.match(/END:VALARM/g) || []).length);
check('含 UID 且带域名', /UID:bn-[a-z0-9]+-remind@better-news/.test(ics));
check('含 DTSTAMP（UTC Z 结尾）', /DTSTAMP:\d{8}T\d{6}Z/.test(ics));

// 截止 2026-09-30 提前 3 天 9 点 → 2026-09-27 09:00
// 注意：VTIMEZONE 段里也有一行 DTSTART，必须只取 VEVENT 段内那行，否则会被假通过。
const veventOf = (s) => (s.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/) || [''])[0];
const evStart = (s) => (veventOf(s).match(/DTSTART[^\r\n]*/) || [''])[0];
check('提醒时间 = 截止前 3 天 9 点', evStart(ics) === 'DTSTART;TZID=Asia/Shanghai:20260927T090000', evStart(ics));
check('事件标题带前缀', /SUMMARY:中北通知·/.test(ics));
check('描述含截止日期', /DESCRIPTION:.*2026-09-30/.test(ics));
check('含原文链接 URL', /URL:http/.test(ics));
check('有 VALARM 到点提醒', /TRIGGER:PT0M/.test(ics));
check('有「当天截止」的二次提醒', /今天截止/.test(ics));

console.log('\n=== 6. ICS 折行与转义（手机日历最容易在这里失败）===');
const longTitle = '关于' + '很长的标题'.repeat(30) + '的通知';
const ics2 = m.buildIcs([{
  key: 'abc', item: { ...items[3], title: longTitle, sourceName: '计算机科学与技术学院' },
  meta: { url: items[3].url, title: longTitle, reason: 'manual' }, deadline: null, daysLeft: null,
}], { now: new Date('2026-09-19T02:00:00Z') });
const overlong = ics2.split('\r\n').filter((l) => new TextEncoder().encode(l).length > 75);
check('无超过 75 字节的行', overlong.length === 0, overlong.length ? `最长 ${Math.max(...overlong.map((l) => new TextEncoder().encode(l).length))}` : '');
check('折行续行以空格开头', /\r\n /.test(ics2));
check('折行后标题仍可还原', ics2.replace(/\r\n /g, '').includes('很长的标题'.repeat(3)));

const ics3 = m.buildIcs([{
  key: 'esc', item: { ...items[3], title: 'A;B,C\\D\n第二行' },
  meta: { url: 'http://x/', title: 't', reason: 'manual' }, deadline: null, daysLeft: null,
}], { now: new Date('2026-09-19T02:00:00Z') });
check('分号已转义', ics3.includes('A\\;B'));
check('逗号已转义', ics3.includes('B\\,C'));
check('反斜杠已转义', ics3.includes('C\\\\D'));
check('换行转成 \\n', ics3.includes('D\\n第二行'));

console.log('\n=== 7. 无截止时间的条目也要进日历 ===');
const icsNoDl = m.buildIcs([{
  key: 'nodl', item: items[3], meta: { url: items[3].url, title: items[3].title, reason: 'kw:选课' }, deadline: null, daysLeft: null,
}], { now: new Date('2026-09-19T02:00:00Z') });
check('仍生成 1 个 VEVENT', (icsNoDl.match(/BEGIN:VEVENT/g) || []).length === 1);
check('事件日期落到发布时间', evStart(icsNoDl) === 'DTSTART;TZID=Asia/Shanghai:20260901T090000', evStart(icsNoDl));
check('描述标明关键词来源', /关键词关注/.test(icsNoDl));

console.log('\n=== 8. 关键词匹配与搜索语义一致 ===');
m.addKeyword('推免');
check('别名命中：推免 → 推荐免试', m.matchedKeywords('关于2027年推荐免试攻读硕士研究生的名单公示').includes('推免'));
check('标点归一化：四、六级', (() => { m.addKeyword('四六级'); return m.matchedKeywords('全国大学英语四、六级考试').includes('四六级'); })());
check('禁用后不再命中', (() => { m.setKeywordEnabled('推免', false); const r = m.matchedKeywords('推荐免试名单'); m.setKeywordEnabled('推免', true); return !r.includes('推免'); })());

console.log('\n=== 9. 提醒偏好持久化 ===');
m.savePrefs({ leadDays: 7, reminderHour: 20 });
check('leadDays 已保存', m.loadPrefs().leadDays === 7);
check('reminderHour 已保存', m.loadPrefs().reminderHour === 20);
check('未传的字段保持默认', m.loadPrefs().keywordAlert === true);

console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
process.exit(fail ? 1 : 0);
