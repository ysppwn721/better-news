/**
 * 浏览器端打包入口。
 *
 * 为什么有这一层：抓取逻辑（列表/详情解析、关键词打标、截止时间识别）在
 * src/ 下已有一套经过实测的实现（覆盖主站拆分日期、学工部 mdy 日期、英文月份、
 * 文章页两种 URL 形式、受限页识别等一堆站点差异）。App 端直接复用，不重写。
 *
 * 与原模块的唯一差异：
 *   - 不 import Node 内置模块（path/fs/crypto），这些模块本身也没用到
 *   - 信源清单改为构建时生成，避免 App 里再跑一遍「栏目发现」
 *
 * 构建：node app/build.mjs
 */
export { parseList, parseDetail, parseDate, isRestrictedPage, articleIds, isArticleUrl } from '../../src/sources/cms.mjs';
export { analyze, makeSummary, inferSubcategory, TAG_RULES, AUDIENCE_RULES } from '../../src/core/keywords.mjs';
export { extractDeadlines, daysUntil, daysLeftText } from '../../src/core/deadline.mjs';
export { CATEGORIES, CATEGORY_MAP, COLLEGES, BUILTIN_SOURCES, collegeSourcesOnly, hintCategory } from '../../src/sources/registry.mjs';
export { default as SOURCES } from './generated/sources.json';
