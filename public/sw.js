/**
 * Service Worker：离线可用 + 添加到主屏幕。
 *
 * 缓存策略（按资源性质区分）：
 *   · 应用外壳（HTML/CSS/JS）：网络优先，失败回落缓存 —— 保证更新能及时生效，离线也能打开
 *   · 数据快照（data/items.json、detail/*.json）：stale-while-revalidate —— 先显示已有数据，
 *     后台悄悄更新，兼顾速度与新鲜度
 *   · 图标等静态资源：缓存优先
 *
 * 注意：SW 只做缓存，不做后台轮询推送（浏览器限制，静态托管无法在页面关闭后弹通知）。
 */

const VERSION = 'v1';
const SHELL_CACHE = `bn-shell-${VERSION}`;
const DATA_CACHE = `bn-data-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './store.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 外部链接交给浏览器

  // 数据快照：先给缓存，再后台更新（首屏快，数据也不会长期过期）
  if (url.pathname.includes('/data/')) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // 应用外壳与其余同源资源：网络优先，离线回落缓存
  event.respondWith(networkFirst(request, SHELL_CACHE));
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // 导航请求离线且无缓存 → 回落首页
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('离线且无缓存', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------- Web Push
// 事件由 Cloudflare Worker 通过推送服务投递（页面关闭时也能收到）。

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: '中北通知', body: event.data ? event.data.text() : '有新通知' };
  }

  const title = payload.title || '中北通知';
  const options = {
    body: payload.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: payload.tag || 'bn-push',
    renotify: true,
    data: { url: payload.url || './' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 已有窗口就聚焦到它，避免重复开标签页
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        // 应用内已打开时由页面自己处理跳转，这里不强制改地址
        if (client.navigate && target.startsWith(self.location.origin)) {
          try { await client.navigate(target); } catch {}
        }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/** 订阅被推送服务轮换时，浏览器会发这个事件；通知页面重新订阅 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) client.postMessage({ type: 'pushsubscriptionchange' });
  })());
});

