/**
 * 栏目定义。
 *
 * 设计取舍：栏目按「发布主体」划分（党委/学工部/教务部/研究生院/校团委/学校主页/学院），
 * 因为学生的真实心智是「哪个部门发的通知」。跨部门的同类内容（如党务信息散落在
 * 主站、教务部、研究生院）由 keywords.mjs 的标签规则聚合，二者互补。
 */
export const CATEGORIES = [
  { id: 'party',      name: '党务工作',   icon: '旗',  color: '#c62828', desc: '党委、组织、纪检监察、党建' },
  { id: 'student',    name: '学生工作',   icon: '学',  color: '#1565c0', desc: '学生工作部：奖助、管理、心理、国防' },
  { id: 'academic',   name: '教务选课',   icon: '课',  color: '#2e7d32', desc: '教务部：选课、考试、学籍、培养' },
  { id: 'graduate',   name: '研究生',     icon: '研',  color: '#6a1b9a', desc: '研究生院：招生、培养、学位' },
  { id: 'youth',      name: '团学活动',   icon: '团',  color: '#ef6c00', desc: '校团委：社会实践、学生会、第二课堂' },
  { id: 'school',     name: '学校主页',   icon: '校',  color: '#37474f', desc: '学校层面通知公告与新闻' },
  { id: 'college',    name: '学院通知',   icon: '院',  color: '#00838f', desc: '各二级学院发布的通知' },
  { id: 'other',      name: '其他',       icon: '·',  color: '#757575', desc: '未归类内容' },
];

export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/** 中北大学二级学院（域名来自学校「教学机构」页，2026 年核对） */
export const COLLEGES = [
  { id: 'bdtywlxy', name: '半导体与物理学院', host: 'bdtywlxy.nuc.edu.cn' },
  { id: 'cly',      name: '材料科学与工程学院', host: '3y.nuc.edu.cn' },
  { id: 'cxcy',     name: '创新创业学院', host: 'cxcy.nuc.edu.cn' },
  { id: 'ece',      name: '电气与控制工程学院', host: 'ece.nuc.edu.cn' },
  { id: 'hkyh',     name: '航空宇航学院', host: 'hkyh.nuc.edu.cn' },
  { id: 'hgxy',     name: '化学与化工学院', host: 'hgxy.nuc.edu.cn' },
  { id: 'hjaq',     name: '环境与安全工程学院', host: 'hjaq.nuc.edu.cn' },
  { id: 'jdgc',     name: '机电工程学院', host: 'jdgc.nuc.edu.cn' },
  { id: 'jxdl',     name: '机械工程学院', host: 'jxdl.nuc.edu.cn' },
  { id: 'cst',      name: '计算机科学与技术学院', host: 'cst.nuc.edu.cn' },
  { id: 'jgy',      name: '经济与管理学院', host: 'jgy.nuc.edu.cn' },
  { id: 'mkszyxy',  name: '马克思主义学院', host: 'mkszyxy.nuc.edu.cn' },
  { id: 'epe',      name: '能源与动力工程学院', host: 'epe.nuc.edu.cn' },
  { id: 'shss',     name: '人文社会科学学院', host: 'shss.nuc.edu.cn' },
  { id: 'ss',       name: '软件学院', host: 'ss.nuc.edu.cn' },
  { id: 'math',     name: '数学学院', host: 'math.nuc.edu.cn' },
  { id: 'tyxy',     name: '体育学院', host: 'tyxy.nuc.edu.cn' },
  { id: 'wtdx',     name: '信息与通信工程学院', host: '5y.nuc.edu.cn' },
  { id: 'yqdz',     name: '仪器与电子学院', host: '6y.nuc.edu.cn' },
  { id: 'art',      name: '艺术学院', host: 'art.nuc.edu.cn' },
  { id: 'zgxy',     name: '卓越工程师学院', host: 'zgxy.nuc.edu.cn' },
];

/**
 * 内置核心信源。
 * listUrl 为数组时表示多栏目合并抓取；分页模板用 {page} 占位。
 */
export const BUILTIN_SOURCES = [
  {
    id: 'www-tzgg', name: '学校通知公告', categoryId: 'school', sort: 10,
    listUrl: 'https://www.nuc.edu.cn/index/tzgg.htm', pageTemplate: 'https://www.nuc.edu.cn/index/tzgg/{page}.htm',
    maxPages: 3,
  },
  // 注：学校党办/组织部无独立网站，党务类通知发布在主站通知公告、教务部党建、
  // 研究生院党建与各学院「党群工作」栏中，由 keywords.mjs 的党务关键词规则聚合到「党务工作」栏目。
  {
    id: 'xsgzb-tzgg', name: '学生工作部通知', categoryId: 'student', sort: 20,
    listUrl: 'https://xsgzb.nuc.edu.cn/index/tzgg.htm',
    pageTemplate: 'https://xsgzb.nuc.edu.cn/index/tzgg/{page}.htm', maxPages: 4,
  },
  {
    id: 'xsgzb-xsjz', name: '学生奖助', categoryId: 'student', sort: 21,
    listUrl: 'https://xsgzb.nuc.edu.cn/xsjz.htm', maxPages: 3,
  },
  {
    id: 'xsgzb-szjy', name: '思政教育', categoryId: 'student', sort: 22,
    listUrl: 'https://xsgzb.nuc.edu.cn/szjy.htm', maxPages: 2,
  },
  {
    id: 'jwc-tzgg', name: '教务部通知', categoryId: 'academic', sort: 30,
    listUrl: 'http://jwc.nuc.edu.cn/index/tzgg.htm',
    pageTemplate: 'http://jwc.nuc.edu.cn/index/tzgg/{page}.htm', maxPages: 4,
  },
  {
    id: 'jwc-djgz', name: '教务部党建', categoryId: 'party', sort: 31,
    listUrl: 'http://jwc.nuc.edu.cn/djgz.htm', maxPages: 2,
  },
  {
    id: 'grs-tzgg', name: '研究生院通知', categoryId: 'graduate', sort: 40,
    listUrl: 'http://grs.nuc.edu.cn/index/tzgg.htm',
    pageTemplate: 'http://grs.nuc.edu.cn/index/tzgg/{page}.htm', maxPages: 4,
  },
  {
    id: 'grs-djgz', name: '研究生院党建', categoryId: 'party', sort: 41,
    listUrl: 'http://grs.nuc.edu.cn/djgz.htm', maxPages: 2,
  },
  {
    id: 'tw-zytz', name: '校团委重要通知', categoryId: 'youth', sort: 50,
    listUrl: 'https://tw.nuc.edu.cn/xwzx/zytz.htm', maxPages: 4,
  },
  {
    id: 'tw-tqkx', name: '校团委团情快讯', categoryId: 'youth', sort: 51,
    listUrl: 'https://tw.nuc.edu.cn/xwzx/tqkx.htm', maxPages: 3,
  },
];

/** 由学院配置生成信源（栏目页由 discover 自动发现后回填 listUrl） */
export function collegeSourcesOnly(colleges = COLLEGES) {
  return colleges.map((c, i) => ({
    id: `col-${c.id}`,
    name: c.name,
    categoryId: 'college',
    sort: 200 + i,
    listUrl: null, // 待自动发现
    discoverFrom: `http://${c.host}/`,
    maxPages: 2,
  }));
}

/** 关键词 → 栏目 的兜底归类（用于学院站等未标注栏目的信源） */
export const CATEGORY_HINTS = [
  { categoryId: 'party',    re: /党委|党总支|党支部|党建|党员|党课|党风廉政|纪检监察|意识形态/ },
  { categoryId: 'student',  re: /奖学金|助学金|资助|勤工助学|困难认定|学生管理|心理健康|国防教育|辅导员|军训/ },
  { categoryId: 'academic', re: /选课|考试|补考|学籍|培养方案|教学|课程|教材|毕业设计|论文答辩|推免/ },
  { categoryId: 'graduate', re: /研究生|硕士|博士|学位点|导师/ },
  { categoryId: 'youth',    re: /团委|团员|学生会|研究生会|社会实践|志愿服务|第二课堂|社团/ },
];

/** 根据标题/正文推断栏目（仅当信源本身没有明确栏目归属时使用） */
export function hintCategory(text, fallback = 'other') {
  for (const { categoryId, re } of CATEGORY_HINTS) {
    if (re.test(text)) return categoryId;
  }
  return fallback;
}
