/**
 * 信源装配：内置信源 + 学院信源（栏目地址来自自动发现结果）。
 * 独立成模块，避免 bin → api/server → bin 的循环依赖。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SOURCES, CATEGORIES, COLLEGES, collegeSourcesOnly } from '../sources/registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DISCOVERED_FILE = resolve(ROOT, 'config/discovered.json');
export const CURATED_FILE = resolve(ROOT, 'config/curated-columns.json');

/** 读取自动发现结果（由 `bn discover` 写入） */
export function loadDiscovered() {
  if (!existsSync(DISCOVERED_FILE)) return {};
  try { return JSON.parse(readFileSync(DISCOVERED_FILE, 'utf8')); } catch { return {}; }
}

/**
 * 读取人工精选栏目（叠加层）。
 *
 * 与 discovered.json 的分工：discover 负责「站点改版后能自己跟上」，
 * 但它的视野只有学院首页的直链（深度 1），且有 8 个栏目的上限，
 * 『学生工作 / 研究生培养 / 招生信息』下面的二级栏目永远选不进来。
 * 这些栏目恰恰是学生最需要的（团学动态、教育管理、学位管理、考试安排…），
 * 因此单列一份人工清单：按 URL 与自动发现结果去重后合并，互不覆盖。
 *
 * @returns {Record<string, Array<{name:string,url:string,maxPages?:number}>>} 学院信源 id → 栏目
 */
export function loadCurated() {
  if (!existsSync(CURATED_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(CURATED_FILE, 'utf8'));
    const out = {};
    for (const [id, cols] of Object.entries(raw)) {
      if (id.startsWith('_') || !Array.isArray(cols)) continue;   // 跳过 _comment 等说明字段
      const good = cols.filter((c) => c && typeof c.url === 'string' && c.url);
      if (good.length) out[id] = good;
    }
    return out;
  } catch { return {}; }
}

/**
 * 组装生效的信源列表
 * @param {{includeColleges?: boolean, onlyColleges?: string[]|null}} [opts]
 */
export function buildSources({ includeColleges = true, onlyColleges = null } = {}) {
  const discovered = loadDiscovered();
  const curated = loadCurated();
  const out = BUILTIN_SOURCES.map((s) => ({ ...s }));

  if (!includeColleges) return out;

  const colleges = onlyColleges
    ? COLLEGES.filter((c) => onlyColleges.includes(c.id))
    : COLLEGES;

  for (const s of collegeSourcesOnly(colleges)) {
    const d = discovered[s.id];

    // 新版发现结果：一个学院可含多个有效栏目（如「通知公告」+「学生工作」）
    const auto = d
      ? (d.columns?.length
        ? d.columns
        : (d.listUrl ? [{ url: d.listUrl, name: d.columnName || '通知公告' }]
          : (d.candidates?.length ? [{ url: d.candidates[0].url, name: d.candidates[0].name }] : [])))
      : [];

    // 自动发现 + 人工精选，按 URL 去重（自动发现优先级高，保留它已经验证过的名字）
    const seen = new Set();
    const merged = [];
    for (const col of [...auto, ...(curated[s.id] || [])]) {
      if (!col?.url) continue;
      const key = col.url.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(col);
    }

    merged.forEach((col, idx) => {
      if (!col?.url) return;
      const namePart = idx === 0 ? '' : `·${(col.columnKey || col.name || idx).slice(0, 6)}`;
      out.push({
        ...s,
        id: idx === 0 ? s.id : `${s.id}-${idx}`,
        name: `${s.name}${namePart}`,
        listUrl: col.url,
        columnName: col.name,
        // 学院栏目每页只有 10 条，只抓第 1 页会把两三个月前的通知全漏掉
        // （选课、综测、评奖公示都发在那个时间窗里）。默认 6 页且按发布时间
        // 截止自动停，低产栏目不会白翻。
        maxPages: col.maxPages ?? 6,
        sort: (s.sort ?? 200) + idx,
      });
    });
  }
  return out;
}

/** 把信源登记进数据库（UI 需要看到全部栏目，包括尚未抓取的学院） */
export function registerAll(store, sources) {
  for (const c of CATEGORIES) store.setMeta(`category:${c.id}`, JSON.stringify(c));

  for (const s of sources) {
    store.registerSource({
      id: s.id, name: s.name, categoryId: s.categoryId,
      listUrl: s.listUrl || '', builtin: true, sort: s.sort ?? 100,
    });
  }
  const discovered = loadDiscovered();
  for (const s of collegeSourcesOnly()) {
    if (sources.some((x) => x.id === s.id)) continue;
    store.registerSource({
      id: s.id, name: s.name, categoryId: 'college',
      listUrl: '', builtin: true, sort: s.sort,
    });
    const d = discovered[s.id];
    store.markSourceFetch(s.id, {
      status: d?.candidates?.length ? '已发现栏目待启用' : '待发现栏目',
      error: 0,
    });
  }
}
