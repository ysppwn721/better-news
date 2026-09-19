/**
 * 搜索关键词别名（校园口语 ↔ 公文用词）。
 *
 * 为什么需要：学生用口语缩写搜，公文里写的是全称，两边对不上就一条都搜不到。
 * 实测：搜「综测」0 条，而标题里写的是「综合素质测评」。
 *
 * 原则：只用「确定同义」的映射，不做模糊联想——
 * 之前试过全文字符覆盖率等模糊匹配，结果是搜什么都出一大堆、条条对不上，
 * 被用户直接否掉。宁可少而准。
 *
 * 每条规则：[标准词, [别名...]]，任一别名出现即把标准词一并纳入检索。
 * 也支持反向：用标准词搜时把别名一并纳入（覆盖学生写全称、标题用缩写的情况）。
 */
export const SEARCH_ALIASES = [
  ['综合素质测评', ['综测', '综合测评', '综合素质评测', '素质测评']],
  ['选课', ['选课通知', '预选', '正选', '补退选', '退补选']],
  ['推免', ['推荐免试', '免试攻读', '保研', '预推免']],
  ['奖学金', ['评奖评优', '奖助学金']],
  ['助学金', ['助学', '资助']],
  ['困难认定', ['困难生', '家庭经济困难', '贫困认定']],
  ['四六级', ['英语四六级', 'CET', '大学英语四六级', '四、六级']],
  ['补考', ['重考', '不及格']],
  ['缓考', ['缓考申请']],
  ['体测', ['体质测试', '体质健康测试', '体能测试', '体质健康标准']],
  ['党课', ['党校', '入党积极分子', '发展对象']],
  ['发展党员', ['发展对象', '预备党员']],
  ['转专业', ['专业分流', '转专业申请']],
  ['学籍异动', ['休学', '复学', '退学', '保留学籍']],
  ['毕业设计', ['毕设', '毕业论文']],
  ['开题', ['开题报告']],
  ['答辩', ['毕业答辩']],
  ['放假', ['假期', '节假日']],
  ['调课', ['课程调整', '停课']],
  ['军训', ['军事训练']],
  ['辅导员', ['班主任']],
  ['招聘', ['校招', '宣讲会', '双选会']],
  ['实习', ['实习实训']],
  ['竞赛', ['大赛', '比赛']],
  ['大创', ['大学生创新创业', '创新创业训练计划']],
  ['讲座', ['学术报告', '论坛', '报告会']],
  ['宿舍', ['公寓', '寝室']],
  ['校园卡', ['一卡通']],
  ['成绩', ['成绩查询', '成绩单']],
  ['培养方案', ['培养计划']],
];

/** 预先建立 词 → 同义词集合 的映射（双向） */
const ALIAS_MAP = new Map();
for (const [canonical, aliases] of SEARCH_ALIASES) {
  const group = new Set([canonical, ...aliases]);
  for (const w of group) {
    if (!ALIAS_MAP.has(w)) ALIAS_MAP.set(w, new Set());
    for (const x of group) ALIAS_MAP.get(w).add(x);
  }
}

/**
 * 把查询词扩展为「原词 + 同义词」的候选集合。
 * 用空格分隔的多个词各自扩展。
 * @param {string} q 用户输入
 * @returns {string[]} 每个词的候选列表（去重，含原词）
 */
export function expandQuery(q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of terms) {
    const set = new Set([t]);
    // 直接命中别名表
    if (ALIAS_MAP.has(t)) for (const x of ALIAS_MAP.get(t)) set.add(x);
    // 子串命中：如用户输入「综测成绩」时也应命中「综测」
    for (const [word, group] of ALIAS_MAP) {
      if (word.length >= 2 && t.includes(word)) for (const x of group) set.add(x);
    }
    out.push([...set]);
  }
  return out;
}

/**
 * 归一化标题：去掉标点与空白。
 *
 * 为什么需要：学校标题里的标点会切断关键词——
 * 「全国大学英语四、六级考试」中的顿号让「四六级」搜不到。
 * 把标点统一剔除后再匹配即可解决。
 */
export function normalizeForSearch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[、，,。.；;：:！!？?（）()\[\]【】《》<>""''`~\-—_/\\|+*#·…]/g, '');
}

/** 判断标题是否匹配某个候选词（对标题与候选词都做归一化） */
function haystackHas(normTitle, candidate) {
  return normTitle.includes(normalizeForSearch(candidate));
}

/**
 * 判断标题是否匹配查询（含同义词扩展，且每个词都必须出现）。
 * @param {string} title
 * @param {string} q
 * @returns {boolean}
 */
export function titleMatches(title, q) {
  const normTitle = normalizeForSearch(title);
  const groups = expandQuery(q);
  if (!groups.length) return false;
  return groups.every((candidates) => candidates.some((c) => haystackHas(normTitle, c)));
}
