#!/usr/bin/env node
/**
 * 通过 GitHub Desktop 已登录的凭据（Git Credential Manager）创建并推送仓库，无需 gh 认证。
 *
 * 做法：
 *   1) 用 `git credential fill` 向凭据管理器索取 github.com 的账号与令牌（纯本地读取）
 *   2) 用令牌调 GitHub API 创建仓库（已存在则复用）
 *   3) 配置 remote 并推送 main 分支
 *
 * 用法:
 *   node scripts/push-github.mjs [仓库名] [--public]
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const repoName = positional[0] || 'better-news';
const isPublic = process.argv.includes('--public');

const sh = async (cmd, args, opts = {}) => {
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd: ROOT, windowsHide: true, maxBuffer: 10 * 1024 * 1024, ...opts,
    });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.message}`.trim() };
  }
};

/** 从凭据管理器读取 github.com 凭据（只读，不触发弹窗） */
function readCredential() {
  return new Promise((resolve) => {
    const child = spawn('git', ['credential', 'fill'], { cwd: ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve({}));
    child.on('close', () => {
      resolve({
        username: (out.match(/^username=(.+)$/m) || [])[1]?.trim(),
        password: (out.match(/^password=(.+)$/m) || [])[1]?.trim(),
      });
    });
    child.stdin.write('protocol=https\nhost=github.com\n\n');
    child.stdin.end();
  });
}

console.log('① 读取 GitHub 凭据（来自 GitHub Desktop 的登录）…');
const cred = await readCredential();
if (!cred.username || !cred.password) {
  console.error('✗ 未能从凭据管理器取到 GitHub 凭据。');
  console.error('  请在 GitHub Desktop 里确认已登录，或执行 gh auth login。');
  process.exit(1);
}
console.log(`  ✓ 账号：${cred.username}（令牌长度 ${cred.password.length}）`);

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cred.password}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'better-news-deploy',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body };
};

console.log('② 检查/创建 GitHub 仓库…');
let repoInfo = await api(`/repos/${cred.username}/${repoName}`);
if (repoInfo.ok) {
  console.log(`  · 仓库已存在：${repoInfo.body.html_url}`);
} else if (repoInfo.status === 404) {
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: repoName,
      description: '中北大学校园信息汇总：抓取全校通知并按栏目汇总，支持 PWA 与后台推送',
      private: !isPublic,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    }),
  });
  if (!created.ok) {
    console.error(`✗ 创建仓库失败（HTTP ${created.status}）：${JSON.stringify(created.body).slice(0, 300)}`);
    console.error('  若令牌缺少 repo 权限，请在 GitHub Desktop 退出并重新登录后重试。');
    process.exit(1);
  }
  repoInfo = created;
  console.log(`  ✓ 已创建：${created.body.html_url}（${isPublic ? '公开' : '私有'}）`);
} else {
  console.error(`✗ 查询仓库失败（HTTP ${repoInfo.status}）：${JSON.stringify(repoInfo.body).slice(0, 200)}`);
  process.exit(1);
}

const owner = repoInfo.body.owner?.login || cred.username;
const remoteUrl = `https://github.com/${owner}/${repoName}.git`;

console.log('③ 配置 remote 并推送…');
const existing = await sh('git', ['remote', 'get-url', 'origin']);
if (existing.ok) {
  await sh('git', ['remote', 'set-url', 'origin', remoteUrl]);
  console.log(`  · 已更新 origin → ${remoteUrl}`);
} else {
  await sh('git', ['remote', 'add', 'origin', remoteUrl]);
  console.log(`  ✓ 已添加 origin → ${remoteUrl}`);
}

const branch = (await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main';
const push = await sh('git', ['push', '-u', 'origin', branch]);
if (push.ok) {
  console.log(`  ✓ 已推送 ${branch} 分支`);
  console.log(`\n仓库地址：${repoInfo.body.html_url}`);
} else {
  console.error(`✗ 推送失败：\n${push.out.slice(0, 500)}`);
  process.exit(1);
}
