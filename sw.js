/* Service Worker: 离线缓存应用外壳 + 课程库 */
const CACHE = "kebiao-ucas-v15";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./vendor/supabase.min.js",
  "./manifest.json",
  "./data/catalog.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];
/* 核心代码走"网络优先"：在线必拿最新版，离线回落缓存 */
const CORE = ["index.html", "app.js", "style.css", "manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.url.includes("/.netlify/")) return; // 不缓存函数请求
  const name = url.pathname.split("/").pop();
  const isCore = CORE.includes(name) || req.mode === "navigate";
  if (isCore) {
    /* 页面/JS/样式：在线每次都拉最新（打开即新版），离线才用缓存 */
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }
  /* 大文件（catalog.json / vendor / 图标）：缓存优先，保证打开速度与离线 */
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});