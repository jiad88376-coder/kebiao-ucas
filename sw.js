/* Service Worker: 离线缓存应用外壳 + 课程库 */
const CACHE = "kebiao-ucas-v39";
const ASSETS = [
  "./",
  "./index.html",
  "./dashboard.html",
  "./style.css",
  "./app.js",
  "./vendor/supabase.min.js",
  "./manifest.json",
  "./data/schools.json",
  "./data/schools/ucas.json",
  "./data/schools/ucas-catalog.json",
  "./data/schools/hias.json",
  "./data/schools/hias-catalog.json",
  "./data/schools/qingdao.json",
  "./data/schools/qingdao-catalog.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];
/* 核心代码走"网络优先"：在线必拿最新版，离线回落缓存 */
const CORE = ["index.html", "dashboard.html", "app.js", "style.css", "manifest.json"];

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

/* ---------------- 消息提醒（Web Push）：接收并展示通知 ---------------- */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "课壳", {
    body: d.body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "./" },
    renotify: false
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin)) {
          if ("navigate" in c && url !== "./") c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
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
    /* 页面/JS/样式：在线每次都拉最新（cache:"reload" 强制绕过浏览器 HTTP 缓存，杜绝 10 分钟旧样式窗口），离线才用缓存 */
    e.respondWith(
      fetch(req, { cache: "reload" }).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }
  /* 课程库：缓存优先 + 后台自愈更新（SWR）——网络抖动导致的坏缓存下次打开自动修复（所有学校的课程库通用） */
  if (name.endsWith("-catalog.json")) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => null);
        if (hit) return hit;
        return net.then((res) => res || caches.match("./index.html"));
      })
    );
    return;
  }
  /* 大文件（vendor / 图标）：缓存优先，保证打开速度与离线 */
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