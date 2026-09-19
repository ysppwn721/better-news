/**
 * 上线前环境自检（只读，不改动任何东西）。
 *
 * 用法: node scripts/check-ready.mjs
 * 用途: 在跑 deploy-cloud.mjs 之前，确认认证与工具链是否就绪，缺什么就明确提示补什么。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const rows = [];
const add = (name, ok, detail = '') => rows.push({ name, ok, detail });

/** Windows 下 npx 是 .cmd，需要 shell；用 spawn 避免参数转义告警 */
async function cmd(file, args, opts = {}) {
  const isWin = process.platform === 'win32';
  const bin = isWin && (file === 'npx' || file === 'npm') ? `${file}.cmd` : file;
  try {
    const { stdout, stderr } = await run(bin, args, { cwd: ROOT, windowsHide: true, ...opts });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.message}`.trim() };
  }
}

// 1. 本地前置条件
add('Node 版本 ≥ 22.5', Number(process.versions.node.split('.')[0]) >= 22 && Number(process.versions.node.split('.')[1]) >= 5,
  `当前 ${process.versions.node}`);
add('数据快照已生成', existsSync(resolve(ROOT, 'public/data/items.json')),
  existsSync(resolve(ROOT, 'public/data/items.json')) ? '' : '先运行 npm run export');
add('PWA 图标已生成', existsSync(resolve(ROOT, 'public/icons/icon-512.png')),
  '缺失时运行 npm run icons');
add('git 仓库已初始化', existsSync(resolve(ROOT, '.git')));

// 2. git 远程
const remote = await cmd('git', ['remote', 'get-url', 'origin']);
add('已配置 git 远程 origin', remote.ok, remote.ok ? remote.out : '尚未添加，等 gh repo create 后会有');

// 3. GitHub CLI
const ghVer = await cmd('gh', ['--version']);
add('gh CLI 已安装', ghVer.ok, ghVer.ok ? ghVer.out.split('\n')[0] : '未安装');

const ghAuth = await cmd('gh', ['auth', 'status']);
add('GitHub 已登录', ghAuth.ok, ghAuth.ok ? '已认证' : '运行 gh auth login');

if (ghAuth.ok) {
  const who = await cmd('gh', ['api', 'user', '-q', '.login']);
  if (who.ok) add('  GitHub 账号', true, who.out);
}

// 4. wrangler / Cloudflare
const wrangler = await cmd('npx', ['wrangler', '--version']);
add('wrangler 可用', wrangler.ok, wrangler.ok ? wrangler.out.split('\n').pop() : '运行 npm i -g wrangler');

const cfAuth = await cmd('npx', ['wrangler', 'whoami']);
const cfOk = cfAuth.ok && !/not authenticated/i.test(cfAuth.out);
add('Cloudflare 已登录', cfOk, cfOk ? '已认证' : '运行 npx wrangler login');

// 5. Worker 配置
const tomlPath = resolve(ROOT, 'worker/wrangler.toml');
if (existsSync(tomlPath)) {
  const toml = readFileSync(tomlPath, 'utf8');
  const kvFilled = !/REPLACE_WITH_KV_NAMESPACE_ID/.test(toml);
  add('Worker: KV namespace 已配置', kvFilled, kvFilled ? '' : '运行 npx wrangler kv namespace create PUSH_KV 并回填 id');
  const siteUrl = (toml.match(/SITE_URL\s*=\s*"([^"]*)"/) || [])[1];
  add('Worker: SITE_URL 已设置', !!siteUrl && !siteUrl.includes('better-news.pages.dev'),
    siteUrl || '未设置');
  const workerDeps = existsSync(resolve(ROOT, 'worker/node_modules'));
  add('Worker: 依赖已安装', workerDeps, workerDeps ? '' : '在 worker/ 目录运行 npm install');
} else {
  add('Worker 配置文件存在', false, '缺少 worker/wrangler.toml');
}

// 6. Worker 密钥（只能确认登录后从 CF 侧查，这里只提示）
add('Worker 密钥（VAPID）', null, '无法本地校验；部署前需执行 wrangler secret put 三次');

// 输出
const pad = Math.max(...rows.map((r) => r.name.length)) + 2;
console.log('上线前环境自检\n');
for (const r of rows) {
  const mark = r.ok === true ? '✓' : r.ok === false ? '✗' : '·';
  console.log(`  ${mark} ${r.name.padEnd(pad)} ${r.detail}`);
}
const blockers = rows.filter((r) => r.ok === false);
console.log(`\n${blockers.length ? `还有 ${blockers.length} 项待处理` : '全部就绪，可以执行 node scripts/deploy-cloud.mjs'}`);
process.exit(0);
