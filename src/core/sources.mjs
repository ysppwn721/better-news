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

/** 读取自动发现结果（由 `bn discover` 写入） */
export function loadDiscovered() {
  if (!existsSync(DISCOVERED_FILE)) return {};
  try { return JSON.parse(readFileSync(DISCOVERED_FILE, 'utf8')); } catch { return {}; }
}

/**
 * 组装生效的信源列表
 * @param {{includeColleges?: boolean, onlyColleges?: string[]|null}} [opts]
 */
export function buildSources({ includeColleges = true, onlyColleges = null } = {}) {
  const discovered = loadDiscovered();
  const out = BUILTIN_SOURCES.map((s) => ({ ...s }));

  if (!includeColleges) return out;

  const colleges = onlyColleges
    ? COLLEGES.filter((c) => onlyColleges.includes(c.id))
    : COLLEGES;

  for (const s of collegeSourcesOnly(colleges)) {
    const d = discovered[s.id];
    if (!d) continue;

    // 新版发现结果：一个学院可含多个有效栏目（如「通知公告」+「学生工作」）
    const columns = d.columns?.length
      ? d.columns
      : (d.listUrl ? [{ url: d.listUrl, name: d.columnName || '通知公告' }]
        : (d.candidates?.length ? [{ url: d.candidates[0].url, name: d.candidates[0].name }] : []));

    columns.forEach((col, idx) => {
      if (!col?.url) return;
      const namePart = idx === 0 ? '' : `·${(col.columnKey || col.name || idx).slice(0, 6)}`;
      out.push({
        ...s,
        id: idx === 0 ? s.id : `${s.id}-${idx}`,
        name: `${s.name}${namePart}`,
        listUrl: col.url,
        columnName: col.name,
        maxPages: 1,
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
