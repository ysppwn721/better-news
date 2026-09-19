#!/usr/bin/env node
/**
 * 命令行入口：
 *   node bin/bn.mjs fetch [信源id...]      抓取（缺省=全部启用的信源）
 *   node bin/bn.mjs discover [学院id...]   自动发现学院栏目并写回配置
 *   node bin/bn.mjs sources                查看信源状态
 *   node bin/bn.mjs list [--category=x]    查看已入库条目
 *   node bin/bn.mjs serve                  启动 Web 服务
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../src/store/db.mjs';
import { Fetcher } from '../src/core/fetcher.mjs';
import { HttpClient } from '../src/core/http.mjs';
import { discoverColumns, columnKey, pickColumns } from '../src/sources/discover.mjs';
import { CATEGORIES, COLLEGES } from '../src/sources/registry.mjs';
import { buildSources, registerAll, loadDiscovered, DISCOVERED_FILE } from '../src/core/sources.mjs';
import { log } from '../src/core/log.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }),
);
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));

const store = new Store(flags.db);
let running = false;

try {
  switch (cmd) {
    case 'fetch': {
      const all = buildSources();
      registerAll(store, all);
      let targets = all;
      if (positional.length) {
        const set = new Set(positional);
        targets = all.filter((s) => set.has(s.id) || set.has(s.categoryId));
        if (!targets.length) {
          console.error(`未找到匹配的信源: ${positional.join(', ')}`);
          console.error(`可用: ${all.map((s) => s.id).join(', ')}`);
          process.exit(1);
        }
      }
      // 不默认抓全部学院（请求量大），除非显式指定
      const includeCollege = flags.colleges === true || flags.colleges === '1' || flags.colleges === 'true';
      if (!positional.length && !includeCollege) {
        const before = targets.length;
        targets = targets.filter((s) => s.categoryId !== 'college');
        if (before !== targets.length) {
          log.info(`跳过 ${before - targets.length} 个学院信源（如需抓取请加 --colleges）`);
        }
      }
      log.info(`开始抓取 ${targets.length} 个信源…`);
      const fetcher = new Fetcher(store, {
        concurrency: Number(flags.concurrency || 4),
        enrichLimit: Number(flags.enrich || 40),
        onProgress: (p) => log.debug(`  [${p.source}] ${p.done}/${p.total} ${p.title.slice(0, 30)}`),
      });
      const res = await fetcher.fetchAll(targets, {
        pages: flags.pages ? Number(flags.pages) : undefined,
        sinceMonths: flags.months ? Number(flags.months) : undefined,
        enrichTotal: flags['enrich-total'] ? Number(flags['enrich-total']) : undefined,
      });
      console.log('');
      for (const r of res.results) {
        const mark = r.ok ? '✓' : '✗';
        console.log(` ${mark} ${(r.sourceName || r.sourceId).padEnd(18, '　')} 列表${String(r.fetched ?? 0).padStart(3)} 新增${String(r.inserted ?? 0).padStart(3)} 更新${String(r.updated ?? 0).padStart(2)}${r.error ? `  ${r.error}` : ''}`);
      }
      const c = store.counts();
      console.log(`\n库内合计 ${c.total} 条（未读 ${c.unread}），本次新增 ${res.inserted} 条，耗时 ${res.elapsed}s`);
      break;
    }

    case 'discover': {
      const client = new HttpClient({ timeoutMs: 20000 });
      const colleges = positional.length
        ? COLLEGES.filter((c) => positional.includes(c.id))
        : COLLEGES;
      if (!colleges.length) {
        console.error(`未匹配到学院。可用: ${COLLEGES.map((c) => c.id).join(', ')}`);
        process.exit(1);
      }
      const result = loadDiscovered();
      log.info(`开始发现 ${colleges.length} 个学院站的栏目…`);
      for (const c of colleges) {
        const site = `http://${c.host}/`;
        process.stdout.write(`  ${c.name} … `);
        try {
          const cols = await discoverColumns(client, site, { minItems: 3 });
          // 每个学院最多抓 8 个栏目。
          // 曾因上限为 2 而漏掉「最近才更新的栏目」，用户反馈过「学院最近发的通知没有」。
          // 通知类栏目现在会被优先纳入，这里的上限只用于约束请求量
          // （21 学院 × 最多 8 ≈ 170 个列表页）。
          const chosen = pickColumns(cols, 8);
          result[`col-${c.id}`] = {
            collegeId: c.id,
            collegeName: c.name,
            listUrl: chosen[0]?.url || null,
            columnName: chosen[0]?.name || null,
            columns: chosen.map((x) => ({
              url: x.url, name: x.name, columnKey: columnKey(x.name),
              items: x.itemCount, latest: x.latest,
              nameScore: x.score, contentScore: x.contentScore,
            })),
            discoveredAt: new Date().toISOString(),
            candidates: cols.slice(0, 8).map((x) => ({
              url: x.url, name: x.name, items: x.itemCount, latest: x.latest,
              nameScore: x.score, contentScore: x.contentScore,
              sample: x.sampleTitles?.[0]?.slice(0, 30),
            })),
          };
          console.log(chosen.length
            ? chosen.map((x) => `「${x.name}」内容分${x.contentScore}/最新${x.latest || '?'}`).join(' + ')
            : '未找到可用栏目');
        } catch (e) {
          console.log(`失败: ${e.message}`);
          result[`col-${c.id}`] = { collegeId: c.id, collegeName: c.name, error: e.message };
        }
      }
      mkdirSync(dirname(DISCOVERED_FILE), { recursive: true });
      writeFileSync(DISCOVERED_FILE, JSON.stringify(result, null, 2), 'utf8');
      log.info(`发现结果已写入 ${DISCOVERED_FILE.replace(ROOT, '.')}`);
      break;
    }

    case 'sources': {
      const all = buildSources();
      registerAll(store, all);
      const rows = store.sourceStats();
      const byCat = new Map();
      for (const r of rows) {
        if (!byCat.has(r.category_id)) byCat.set(r.category_id, []);
        byCat.get(r.category_id).push(r);
      }
      for (const cat of CATEGORIES) {
        const list = byCat.get(cat.id);
        if (!list?.length) continue;
        console.log(`\n【${cat.name}】${cat.desc}`);
        for (const r of list) {
          const status = (r.last_status || '未抓取').slice(0, 26);
          console.log(`  ${r.id.padEnd(16)} ${r.name.padEnd(20, '　')} 条目${String(r.item_count).padStart(4)} 未读${String(r.unread).padStart(3)}  ${status}`);
        }
      }
      break;
    }

    case 'list': {
      const { items, total } = store.listItems({
        category: flags.category, q: flags.q, limit: Number(flags.limit || 20),
      });
      console.log(`共 ${total} 条\n`);
      for (const it of items) {
        console.log(`${it.publishedAt || it.firstSeen.slice(0, 10)}  [${it.categoryName}] ${it.title.slice(0, 46)}`);
        if (it.tags.length) console.log(`            标签: ${it.tags.join(' ')}`);
      }
      break;
    }

    case 'categories': {
      for (const c of CATEGORIES) console.log(`  ${c.id.padEnd(10)} ${c.name.padEnd(8, '　')} ${c.desc}`);
      break;
    }

    case 'serve': {
      // 服务常驻：await lifetime（永不 resolve），由 startServer 内部处理信号与 db 关闭
      const { startServer } = await import('../src/api/server.mjs');
      const inst = await startServer({ store, port: Number(flags.port || process.env.PORT || 5178) });
      running = true;
      await inst.lifetime;
      break;
    }

    default:
      console.log(`中北大学信息汇总 · 命令行

  node bin/bn.mjs fetch [信源id|栏目id...]   抓取（默认不含学院，加 --colleges 包含）
  node bin/bn.mjs discover [学院id...]       自动发现学院栏目页
  node bin/bn.mjs sources                    信源与抓取状态
  node bin/bn.mjs list [--category=academic] 查看条目
  node bin/bn.mjs categories                 栏目列表
  node bin/bn.mjs serve [--port=5178]        启动 Web 界面

常用参数：--pages=12  --months=6  --enrich=40  --enrich-total=1200  --concurrency=4  --colleges  --db=路径`);
  }
} catch (e) {
  console.error('执行失败:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (!running) store.close();
}
