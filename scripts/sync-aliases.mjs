/**
 * 生成 public/aliases.mjs（供网页版与 App 共用的搜索别名模块）。
 *
 * 源文件在 src/core/aliases.mjs；网页版直接以 ES module 引入，
 * 因此需要在构建时把它放到 public/ 下（App 端则由 esbuild 打包进 bundle）。
 *
 * 用法: node scripts/sync-aliases.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(ROOT, 'src/core/aliases.mjs');
const dst = resolve(ROOT, 'public/aliases.mjs');

const code = readFileSync(src, 'utf8');
mkdirSync(dirname(dst), { recursive: true });
writeFileSync(dst, code, 'utf8');

const rules = (code.match(/^\s*\['/gm) || []).length;
console.log(`已同步 aliases.mjs → public/（${(code.length / 1024).toFixed(1)} KB，约 ${rules} 条别名规则）`);
