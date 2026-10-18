self.__REPLYNEST_SW_VERSION__ = "pwa-shell-v1";
const SHELL_CACHE = "replynest-shell-v1";
const SHELL_ASSETS = [
  "/offline.html",
  "/replynest-icon.svg",
  "/pwa/icon-192.png",
  "/pwa/icon-512.png",
  "/pwa/maskable-512.png",
  "/pwa/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("replynest-shell-") && key !== SHELL_CACHE).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  const cacheableAsset = url.pathname.startsWith("/_next/static/") || SHELL_ASSETS.includes(url.pathname);
  if (!cacheableAsset) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok && response.type === "basic") caches.open(SHELL_CACHE).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});

self.addEventListener("push", event => {
  let payload = { title: "ReplyNest 提醒", body: "您有一条新的运营通知。", data: { url: "/notifications" } };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body, tag: payload.tag, icon: payload.icon || "/replynest-icon.svg",
    badge: payload.badge || "/replynest-icon.svg", data: payload.data || { url: "/notifications" }, renotify: Boolean(payload.tag),
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/notifications", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const existing = windows.find(client => client.url.startsWith(self.location.origin));
    if (existing) return existing.navigate(target).then(() => existing.focus());
    return clients.openWindow(target);
  }));
});
