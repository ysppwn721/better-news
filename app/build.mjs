/**
 * App 构建脚本：打包共享解析模块 + 复用网页前端 → 产出 www/ → 同步到 Capacitor。
 *
 * 设计取舍：
 *   1) 解析/打标逻辑从仓库根目录的 src/ 复用（那套代码经过大量真实站点实测），
 *      不复制一份到 app/ 里，避免两处维护产生分歧。
 *   2) 网页前端（public/ 下的 html/css/js）也复用：构建时拷进来，
 *      只替换数据层入口。这样网页与 App 的界面、筛选、提醒行为完全一致。
 *   3) 信源清单在构建时从 config/discovered.json 生成一份快照，
 *      App 端不需要（也无法）跑栏目发现。
 *
 * 用法：node app/build.mjs
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)));
const ROOT = resolve(APP, '..');
const WWW = resolve(APP, 'www');

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- 1. 生成信源清单

log('[1/4] 生成信源清单…');
const { buildSources } = await import(`file://${resolve(ROOT, 'src/core/sources.mjs').replace(/\\/g, '/')}`);
const sources = buildSources().map((s) => ({
  id: s.id,
  name: s.name,
  categoryId: s.categoryId,
  listUrl: s.listUrl,
  pageTemplate: s.pageTemplate || null,
  maxPages: s.maxPages ?? 1,
  // App 端抓详情受流量与电量限制，每信源限制条数
  detailLimit: s.id.startsWith('col-') ? 8 : 15,
}));

mkdirSync(resolve(APP, 'shared/generated'), { recursive: true });
writeFileSync(
  resolve(APP, 'shared/generated/sources.json'),
  JSON.stringify(sources, null, 2),
  'utf8',
);
const byCat = new Map();
for (const s of sources) byCat.set(s.categoryId, (byCat.get(s.categoryId) || 0) + 1);
log(`      信源 ${sources.length} 个：${[...byCat.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);

// ---------------------------------------------------------------- 2. 打包共享模块

log('[2/4] 打包解析模块…');
rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });

await build({
  entryPoints: [resolve(APP, 'shared/entry.mjs')],
  outfile: resolve(WWW, 'shared.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  loader: { '.json': 'json' },
  minify: false, // 保留可读性，便于真机排查
  logLevel: 'warning',
});
log(`      shared.mjs ${(readFileSync(resolve(WWW, 'shared.mjs')).length / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- 3. 打包 App 数据层

log('[3/4] 打包 App 数据层…');
await build({
  entryPoints: [resolve(APP, 'src/app-store.mjs')],
  outfile: resolve(WWW, 'app-store.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  external: ['@capacitor/core', '@capacitor/preferences'],
  logLevel: 'warning',
});
log(`      app-store.mjs ${(readFileSync(resolve(WWW, 'app-store.mjs')).length / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- 4. 复用网页前端

log('[4/4] 复制网页前端…');
const PUBLIC = resolve(ROOT, 'public');
for (const f of ['style.css', 'sw.js', 'manifest.webmanifest']) {
  cpSync(resolve(PUBLIC, f), resolve(WWW, f));
}
for (const d of ['icons']) {
  if (existsSync(resolve(PUBLIC, d))) cpSync(resolve(PUBLIC, d), resolve(WWW, d), { recursive: true });
}

// index.html：把入口脚本换成 App 版本，并加上移动端特有的 meta
let html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
html = html
  .replace('<script src="./app.js" type="module"></script>', '<script src="./app.js" type="module"></script>')
  .replace('<title>中北大学信息汇总</title>', '<title>中北通知</title>')
  .replace(
    '<link rel="manifest" href="./manifest.webmanifest">',
    '<link rel="manifest" href="./manifest.webmanifest">\n<meta name="format-detection" content="telephone=no">',
  );
writeFileSync(resolve(WWW, 'index.html'), html, 'utf8');

// app.js：数据层入口从 ./store.js 换成 ./app-store.mjs
let appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
const before = appJs;
appJs = appJs.replace(/from '\.\/store\.js'/, "from './app-store.mjs'");
if (appJs === before) {
  console.error('✗ 未能替换 app.js 的数据层入口（找不到 from \'./store.js\'），构建中止');
  process.exit(1);
}
writeFileSync(resolve(WWW, 'app.js'), appJs, 'utf8');

log(`      www/ 产出完成（${sources.length} 个信源已内嵌）`);
