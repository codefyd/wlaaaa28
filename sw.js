// sw.js — service worker بسيط: يخزّن قشرة التطبيق فقط.
// لا نخزّن استجابات الـ API (بيانات الولاء يجب أن تكون حيّة).
const CACHE = "loyalty-shell-v3";
const SHELL = ["./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // لا تتدخل في نداءات Supabase أبدًا
  if (url.hostname.includes("supabase") || url.pathname.includes("/functions/")) return;
  if (e.request.method !== "GET") return;

  // القشرة: cache-first مع تحديث بالخلفية
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
