// sw.js — service worker بسيط: يخزّن قشرة التطبيق فقط.
// لا نخزّن استجابات الـ API (بيانات الولاء يجب أن تكون حيّة).
const CACHE = "loyalty-shell-v11";
const SHELL = ["./index.html", "./order.html", "./cashier.html", "./dashboard.html", "./reset-password.html", "./app.js", "./config.js", "./manifest.webmanifest", "./icon.svg", "./foda.ttf"];

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

  // الشبكة أولًا لصفحات وملفات الواجهة حتى لا تعرض أجهزة مختلفة نسخًا قديمة؛
  // وعند انقطاع الشبكة نعود للنسخة المحلية المخزنة.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && url.origin === location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
