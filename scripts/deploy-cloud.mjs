/**
 * 一键部署到 Cloudflare（Pages + 推送 Worker）。
 *
 * 前置条件（脚本会先自检，缺失即中止并提示）：
 *   1) 已执行 gh auth login
 *   2) 已执行 npx wrangler login
 *   3) worker/ 目录已 npm install
 *
 * 用法:
 *   node scripts/deploy-cloud.mjs            # 完整部署
 *   node scripts/deploy-cloud.mjs --worker   # 只重新部署 Worker
 *   node scripts/deploy-cloud.mjs --pages    # 只重新部署前端
 *
 * 幂等：KV namespace 已存在时复用；VAPID 密钥已存在时复用（不会重复生成导致老订阅失效）。
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = resolve(ROOT, 'worker');
const SECRETS_FILE = resolve(ROOT, 'config/.vapid.json'); // 本地保存，已在 .gitignore 覆盖 config/settings.json 之外需确认

const args = process.argv.slice(2);
const onlyWorker = args.includes('--worker');
const onlyPages = args.includes('--pages');

const log = (...a) => console.log(...a);
const step = (n, t) => console.log(`\n[${n}] ${t}`);
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

async function sh(cmd, cmdArgs, opts = {}) {
  const isWin = process.platform === 'win32';
  const bin = isWin && ['npx', 'npm'].includes(cmd) ? `${cmd}.cmd` : cmd;

  // 需要喂 stdin 的命令（如 wrangler secret put）用 spawn：execFile 不支持写 stdin
  if (opts.input !== undefined) {
    return new Promise((resolve) => {
      const child = spawn(bin, cmdArgs, {
        cwd: opts.cwd || ROOT,
        windowsHide: true,
        shell: isWin, // .cmd 在 Windows 上需要 shell
        env: process.env,
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('error', (e) => resolve({ ok: false, out: `${out}\n${e.message}` }));
      child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), code }));
      child.stdin.write(`${opts.input}\n`);
      child.stdin.end();
    });
  }

  try {
    const { stdout, stderr } = await run(bin, cmdArgs, {
      cwd: opts.cwd || ROOT,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      env: opts.env || process.env,
    });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}\n${e.stderr || ''}\n${e.message}`.trim(), code: e.code };
  }
}

// ---------------------------------------------------------------- 前置检查

step(1, '环境自检');
const ghAuth = await sh('gh', ['auth', 'status']);
if (!ghAuth.ok) fail('GitHub 未登录，请先执行：gh auth login');
log('  ✓ GitHub 已登录');

const cfAuth = await sh('npx', ['wrangler', 'whoami']);
if (!cfAuth.ok || /not authenticated/i.test(cfAuth.out)) fail('Cloudflare 未登录，请先执行：npx wrangler login');
const cfAccount = (cfAuth.out.match(/[0-9a-f]{32}/i) || [])[0] || '(已登录)';
log(`  ✓ Cloudflare 已登录 ${cfAccount !== '(已登录)' ? cfAccount : ''}`);

if (!existsSync(resolve(ROOT, 'public/data/items.json'))) fail('数据快照不存在，请先执行：npm run export');
log('  ✓ 数据快照存在');

if (!existsSync(resolve(WORKER_DIR, 'node_modules'))) {
  log('  · worker 依赖未安装，正在安装…');
  const inst = await sh('npm', ['install'], { cwd: WORKER_DIR });
  if (!inst.ok) fail(`worker 依赖安装失败：\n${inst.out}`);
  log('  ✓ worker 依赖已安装');
}

// ---------------------------------------------------------------- 前端部署

let pagesUrl = null;
if (!onlyWorker) {
  step(2, '部署前端到 Cloudflare Pages');
  const deploy = await sh('npx', [
    'wrangler', 'pages', 'deploy', 'public',
    '--project-name=better-news',
    '--branch=main',
    '--commit-dirty=true',
  ]);
  if (!deploy.ok) {
    if (/project not found|does not exist/i.test(deploy.out)) {
      log('  · Pages 项目不存在，先创建…');
      const create = await sh('npx', ['wrangler', 'pages', 'project', 'create', 'better-news', '--production-branch=main']);
      if (!create.ok && !/already exists/i.test(create.out)) fail(`创建 Pages 项目失败：\n${create.out}`);
      const retry = await sh('npx', [
        'wrangler', 'pages', 'deploy', 'public',
        '--project-name=better-news', '--branch=main', '--commit-dirty=true',
      ]);
      if (!retry.ok) fail(`前端部署失败：\n${retry.out}`);
      pagesUrl = extractUrl(retry.out);
    } else {
      fail(`前端部署失败：\n${deploy.out}`);
    }
  } else {
    pagesUrl = extractUrl(deploy.out);
  }
  log(`  ✓ 前端已部署${pagesUrl ? ` → ${pagesUrl}` : ''}`);
}

// ---------------------------------------------------------------- 推送 Worker

if (!onlyPages) {
  step(3, '配置推送 Worker');

  const tomlPath = resolve(WORKER_DIR, 'wrangler.toml');
  let toml = readFileSync(tomlPath, 'utf8');

  // 3.1 KV namespace（幂等：已填过就跳过）
  if (/REPLACE_WITH_KV_NAMESPACE_ID/.test(toml)) {
    log('  · 创建 KV namespace PUSH_KV…');
    const kv = await sh('npx', ['wrangler', 'kv', 'namespace', 'create', 'PUSH_KV'], { cwd: WORKER_DIR });
    let kvId = (kv.out.match(/id\s*=\s*"([0-9a-f]{32})"/i) || [])[1];
    if (!kvId && /already exists/i.test(kv.out)) {
      const list = await sh('npx', ['wrangler', 'kv', 'namespace', 'list'], { cwd: WORKER_DIR });
      kvId = (list.out.match(/PUSH_KV[\s\S]{0,200}?([0-9a-f]{32})/i) || [])[1];
    }
    if (!kvId) fail(`无法获取 KV namespace id，请手动创建后回填 wrangler.toml：\n${kv.out}`);
    toml = toml.replace('REPLACE_WITH_KV_NAMESPACE_ID', kvId);
    writeFileSync(tomlPath, toml, 'utf8');
    log(`  ✓ KV namespace 已创建并写入配置 (${kvId})`);
  } else {
    log('  · KV namespace 已配置，跳过');
  }

  // 3.2 SITE_URL 指向实际 Pages 域名
  if (pagesUrl) {
    toml = toml.replace(/SITE_URL\s*=\s*"[^"]*"/, `SITE_URL = "${pagesUrl}"`);
    writeFileSync(tomlPath, toml, 'utf8');
    log(`  ✓ SITE_URL 已设为 ${pagesUrl}`);
  }

  // 3.3 VAPID 密钥（幂等：已生成过就复用，避免老订阅失效）
  let vapid;
  if (existsSync(SECRETS_FILE)) {
    vapid = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
    log('  · 复用已保存的 VAPID 密钥');
  } else {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const priv = privateKey.export({ format: 'jwk' });
    const pub = publicKey.export({ format: 'jwk' });
    const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const raw = Buffer.concat([Buffer.from([0x04]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
    vapid = { publicKey: b64url(raw), privateKey: priv.d };
    mkdirSync(dirname(SECRETS_FILE), { recursive: true });
    writeFileSync(SECRETS_FILE, JSON.stringify(vapid, null, 2), 'utf8');
    log(`  ✓ 已生成 VAPID 密钥并保存到 config/.vapid.json（请勿外泄/提交）`);
  }

  // 3.4 写入 Worker 密钥（wrangler secret put 从 stdin 读取值）
  const subject = 'mailto:nuc-better-news@example.com';
  let secretsOk = true;
  for (const [key, value] of [
    ['VAPID_PUBLIC_KEY', vapid.publicKey],
    ['VAPID_PRIVATE_KEY', vapid.privateKey],
    ['VAPID_SUBJECT', subject],
  ]) {
    const res = await sh('npx', ['wrangler', 'secret', 'put', key], { cwd: WORKER_DIR, input: value });
    if (res.ok && /success/i.test(res.out)) {
      log(`  ✓ 密钥已写入 ${key}`);
    } else {
      secretsOk = false;
      log(`  ! 自动写入 ${key} 失败，请手动执行：cd worker && npx wrangler secret put ${key}`);
      log(`    （值见 config/.vapid.json${key === 'VAPID_SUBJECT' ? '，SUBJECT 自行填 mailto:你的邮箱' : ''}）`);
    }
  }
  if (!secretsOk) log('  · 提示：密钥未全部写入时 Worker 仍会部署，但推送会失败，请补齐后重新部署。');

  // 3.5 部署 Worker
  const wdeploy = await sh('npx', ['wrangler', 'deploy'], { cwd: WORKER_DIR });
  if (!wdeploy.ok) fail(`Worker 部署失败：\n${wdeploy.out}`);
  const workerUrl = extractUrl(wdeploy.out, /https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  log(`  ✓ Worker 已部署${workerUrl ? ` → ${workerUrl}` : ''}`);

  // 3.6 前端带上 Worker 地址重新导出并再部署一次
  if (workerUrl) {
    step(4, '把推送地址写入前端数据并重新部署');
    const exp = await sh('node', ['scripts/export-static.mjs'], {
      env: { ...process.env, BN_PUSH_WORKER: workerUrl },
    });
    if (!exp.ok) fail(`导出失败：\n${exp.out}`);
    log('  ✓ 快照已带上推送地址');

    const redeploy = await sh('npx', [
      'wrangler', 'pages', 'deploy', 'public',
      '--project-name=better-news', '--branch=main', '--commit-dirty=true',
    ]);
    if (!redeploy.ok) fail(`前端重新部署失败：\n${redeploy.out}`);
    log('  ✓ 前端已重新部署（设置面板会出现「后台推送」开关）');
  }
}

// ---------------------------------------------------------------- 收尾

step(5, '下一步');
log('  1) 用手机打开站点 → 添加到主屏幕 → 从图标进入 → ⚙ 设置 → 开启后台推送');
log('  2) 验证推送：curl -X POST <worker地址>/test');
log('  3) 到 GitHub 仓库 Actions 页启用「抓取校园通知并更新数据快照」工作流');
log(`\n提示：VAPID 私钥保存在 config/.vapid.json，请勿提交到仓库。`);

function extractUrl(text, re = /https:\/\/[a-z0-9.-]+\.pages\.dev/i) {
  return (text.match(re) || [])[0] || null;
}
