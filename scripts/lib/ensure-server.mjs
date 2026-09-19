/**
 * 启动本地服务并等待就绪（若已在跑则复用）。
 *
 * 为什么需要：多次出现「服务已挂但测试照跑」导致结果全是 0、被误判为功能缺陷。
 * 所有界面测试都应先经过这里确认服务可用。
 *
 * 用法（作为模块）:
 *   import { ensureServer } from './lib/ensure-server.mjs'
 *   const ok = await ensureServer()
 *
 * 用法（命令行）:
 *   node scripts/lib/ensure-server.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function ping(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * @param {{port?: number, timeoutMs?: number, quiet?: boolean}} opts
 * @returns {Promise<{ok: boolean, meta: object|null, started: boolean}>}
 */
export async function ensureServer({ port = 5178, timeoutMs = 30000, quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };

  const existing = await ping(port);
  if (existing) {
    // 服务在跑，但可能数据库里没数据——那也算不可用
    if (existing.counts?.total > 0) {
      log(`  ✓ 本地服务已在运行（${existing.counts.total} 条）`);
      return { ok: true, meta: existing, started: false };
    }
    log(`  ! 服务在运行但库内为 0 条`);
    return { ok: false, meta: existing, started: false };
  }

  log('  · 本地服务未运行，正在启动…');
  const child = spawn('node', ['bin/bn.mjs', 'serve', `--port=${port}`], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // 关掉服务自带的定时抓取（BN_CRON 为空即不注册 node-cron）。
    //
    // 为什么：服务默认每 30 分钟自动抓一轮，而本机还有每小时的 Windows 计划任务
    // （BetterNews-Scrape）在抓同一批站点——两个抓取器互相重叠，既白费请求、
    // 又给学校站点加压，而且测试进程会凭空产生「界面一直在抓取」的现象。
    // 测试用的服务只负责读数据，抓取交给计划任务。
    env: { ...process.env, BN_CRON: '' },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(700);
    const meta = await ping(port);
    if (meta) {
      if (meta.counts?.total > 0) {
        log(`  ✓ 服务已启动（${meta.counts.total} 条）`);
        return { ok: true, meta, started: true };
      }
      log(`  ! 服务已启动但库内为 0 条，请先运行 npm run fetch`);
      return { ok: false, meta, started: true };
    }
  }

  log('  ✗ 启动超时');
  return { ok: false, meta: null, started: true };
}

// 直接运行时作为命令行工具
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = await ensureServer();
  process.exit(r.ok ? 0 : 1);
}
