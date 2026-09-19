/**
 * Cloudflare Worker：Web Push 后台推送 + 定时检查。
 *
 * 为什么需要它：
 *   网页端的 Notification API 只在页面打开时能弹通知，页面一关就收不到。
 *   要做到「关掉网页也能收到提醒」，必须有服务端在后台主动推送——
 *   本 Worker 承担这个角色。
 *
 * 工作方式：
 *   1) 前端订阅后把订阅信息 POST 到这里，存进 KV；
 *   2) Cron Trigger 每 15 分钟读取线上数据快照（index.json），
 *      发现快照版本变化 → 对比出新增条目 → 逐个设备推送通知；
 *   3) 推送失败且返回 404/410（订阅已失效）时自动清理该订阅。
 *
 * 为什么不在 Worker 里抓取：Workers 有 CPU 时间与子请求限制，跑完整抓取不划算。
 * 抓取继续由 GitHub Actions 完成，Worker 只负责「读快照 + 推送」这一件轻活。
 *
 * 部署：
 *   npx wrangler kv namespace create PUSH_KV          # 建 KV，把 id 填进 wrangler.toml
 *   npx wrangler secret put VAPID_PRIVATE_KEY         # VAPID 私钥
 *   npx wrangler secret put VAPID_PUBLIC_KEY          # VAPID 公钥
 *   npx wrangler secret put VAPID_SUBJECT             # mailto:你的邮箱
 *   npx wrangler deploy
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

/** KV 里的键 */
const K_SUBS = 'subscriptions';        // 全部订阅（数组）
const K_LAST_VERSION = 'lastVersion';  // 上次已推送的快照版本
const K_PUSHED_IDS = 'pushedIds';      // 已推送过的条目 id（防止重复推送）

export default {
  /**
   * HTTP 接口
   *   GET  /vapid-public-key   取 VAPID 公钥（前端订阅时要用）
   *   POST /subscribe          保存订阅
   *   POST /unsubscribe        删除订阅
   *   GET  /status             查看订阅数量与上次推送版本
   *   POST /test               给自己的设备发一条测试通知
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: JSON_HEADERS });

    switch (url.pathname) {
      case '/vapid-public-key':
        return json({ publicKey: env.VAPID_PUBLIC_KEY || null });

      case '/subscribe':
        return handleSubscribe(request, env);

      case '/unsubscribe':
        return handleUnsubscribe(request, env);

      case '/status':
        return handleStatus(env);

      case '/test':
        return handleTest(env);

      default:
        return json({ error: '未知接口' }, 404);
    }
  },

  /** Cron Trigger：检查快照更新并推送 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndPush(env));
  },
};

// ---------------------------------------------------------------- 订阅管理

async function handleSubscribe(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法 JSON' }, 400); }

  const { subscription, categories, importantOnly } = body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return json({ error: '订阅信息不完整' }, 400);
  }

  const list = (await env.PUSH_KV.get(K_SUBS, 'json')) || [];
  const record = {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    // 用户可只订阅特定栏目、或只收重要通知
    categories: Array.isArray(categories) && categories.length ? categories : null,
    importantOnly: !!importantOnly,
    subscribedAt: new Date().toISOString(),
    ua: request.headers.get('User-Agent') || '',
  };
  const idx = list.findIndex((s) => s.endpoint === subscription.endpoint);
  if (idx >= 0) list[idx] = { ...list[idx], ...record };
  else list.push(record);

  await env.PUSH_KV.put(K_SUBS, JSON.stringify(list));
  return json({ ok: true, count: list.length });
}

async function handleUnsubscribe(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法 JSON' }, 400); }
  const endpoint = body?.endpoint;
  if (!endpoint) return json({ error: '缺少 endpoint' }, 400);

  const list = (await env.PUSH_KV.get(K_SUBS, 'json')) || [];
  const next = list.filter((s) => s.endpoint !== endpoint);
  await env.PUSH_KV.put(K_SUBS, JSON.stringify(next));
  return json({ ok: true, count: next.length });
}

async function handleStatus(env) {
  const list = (await env.PUSH_KV.get(K_SUBS, 'json')) || [];
  return json({
    subscribers: list.length,
    lastVersion: await env.PUSH_KV.get(K_LAST_VERSION),
    pushedCount: await env.PUSH_KV.get(K_PUSHED_IDS, 'json').then((x) => (x || []).length),
  });
}

async function handleTest(env) {
  const list = (await env.PUSH_KV.get(K_SUBS, 'json')) || [];
  if (!list.length) return json({ error: '还没有订阅设备' }, 400);
  const payload = {
    title: '中北通知｜测试推送',
    body: '推送通道正常，之后有新通知会像这样提醒你。',
    url: env.SITE_URL || 'https://better-news.pages.dev/',
    tag: 'bn-test',
  };
  const result = await pushToAll(env, list, payload);
  return json({ ok: true, ...result });
}

// ---------------------------------------------------------------- 定时检查

async function checkAndPush(env) {
  const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');
  if (!siteUrl) return;

  let index;
  try {
    const res = await fetch(`${siteUrl}/data/index.json`, { cf: { cacheTtl: 0 } });
    if (!res.ok) return;
    index = await res.json();
  } catch { return; }

  const lastVersion = await env.PUSH_KV.get(K_LAST_VERSION);
  // 首次运行只记录版本，不推送历史消息（否则用户会一次收到几百条）
  if (!lastVersion) {
    await env.PUSH_KV.put(K_LAST_VERSION, index.version);
    return;
  }
  if (lastVersion === index.version) return;

  const list = (await env.PUSH_KV.get(K_SUBS, 'json')) || [];
  if (!list.length) {
    await env.PUSH_KV.put(K_LAST_VERSION, index.version);
    return;
  }

  // 找出新增条目：已有推送记录里没有的 id 即为新增
  const pushedIds = new Set((await env.PUSH_KV.get(K_PUSHED_IDS, 'json')) || []);
  let items = [];
  try {
    const res = await fetch(`${siteUrl}/data/items.json`, { cf: { cacheTtl: 0 } });
    if (res.ok) items = await res.json();
  } catch { /* 拉不到条目就只更新版本，避免反复重试 */ }

  const fresh = items.filter((i) => !pushedIds.has(i.id));
  const isFirstRunWithIds = pushedIds.size === 0;

  if (!isFirstRunWithIds && fresh.length) {
    // 按设备偏好过滤后推送
    for (const sub of list) {
      const mine = fresh.filter((i) => {
        if (sub.importantOnly && !i.important) return false;
        if (sub.categories?.length && !sub.categories.includes(i.categoryId)) return false;
        return true;
      });
      if (!mine.length) continue;
      await pushOne(env, sub, buildPayload(mine, siteUrl, index));
    }
  }

  // 记录已推送 id（只保留最近 2000 个，避免 KV 值无限增长）
  const merged = [...pushedIds, ...items.map((i) => i.id)];
  const trimmed = merged.slice(-2000);
  await env.PUSH_KV.put(K_PUSHED_IDS, JSON.stringify(trimmed));
  await env.PUSH_KV.put(K_LAST_VERSION, index.version);
}

/** 组装通知内容：单条直接显示，多条汇总显示 */
function buildPayload(items, siteUrl, index) {
  const priority = index.priorityCollegeName;
  // 优先展示用户所在学院的通知
  const sorted = [...items].sort((a, b) => {
    const ap = a.sourceName?.includes(priority?.replace('学院', '') || '\u0000') ? 0 : 1;
    const bp = b.sourceName?.includes(priority?.replace('学院', '') || '\u0000') ? 0 : 1;
    return ap - bp || (b.important ? 1 : 0) - (a.important ? 1 : 0);
  });

  if (sorted.length === 1) {
    const it = sorted[0];
    return {
      title: `${it.important ? '❗ ' : ''}${it.categoryName}｜新通知`,
      body: it.title,
      url: it.url,
      tag: `bn-${it.id}`,
    };
  }
  const head = sorted[0];
  const rest = sorted.length - 1;
  return {
    title: `${sorted.length} 条新通知`,
    body: `${head.title}${rest > 0 ? `\n等 ${rest} 条（含${sorted.filter((i) => i.important).length}条重要）` : ''}`,
    url: `${siteUrl}/`,
    tag: 'bn-batch',
  };
}

async function pushToAll(env, list, payload) {
  let sent = 0, removed = 0;
  const alive = [];
  for (const sub of list) {
    const ok = await pushOne(env, sub, payload);
    if (ok) { sent++; alive.push(sub); } else removed++;
  }
  if (removed) await env.PUSH_KV.put(K_SUBS, JSON.stringify(alive));
  return { sent, removed };
}

/** 推送单条；订阅失效（404/410）返回 false 以便清理 */
async function pushOne(env, sub, payload) {
  try {
    const push = await buildPushPayload(
      { data: payload, options: { ttl: 86400, urgency: 'normal' } },
      {
        endpoint: sub.endpoint,
        keys: sub.keys,
        expirationTime: null,
      },
      {
        subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
    );
    const res = await fetch(sub.endpoint, push);
    return res.status < 300;
  } catch {
    // 加密或网络异常：保留订阅，下次再试
    return true;
  }
}
