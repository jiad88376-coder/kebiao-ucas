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
  "./data/sponsors.json",
  "./data/topics.json",
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
/* 核心代码走"协商缓存"：每次打开先向服务器发条件请求，文件没变则 CDN 返回 304、
   浏览器直接复用本地副本（零正文传输）；变了则立刻拿到新内容。发版依然即时生效。
   topics.json 必须列在这里：它不在下面的 SWR 分支、也非 -catalog.json 结尾，
   否则会落进"缓存优先"的兜底分支，作者补充的新话题将永远取不到。 */
const CORE = ["index.html", "dashboard.html", "app.js", "style.css", "manifest.json", "sponsors.json", "topics.json"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* 逐个补齐而非整批 addAll：① 已缓存的不重复下载（sw.js 更新时不再重拉约 1 MB）；
       ② 单个资源失败不再拖垮整次安装（旧写法 addAll 任一失败即安装失败） */
    await Promise.all(ASSETS.map(async (u) => {
      try {
        if (await c.match(u)) return;
        await c.add(u);
      } catch (err) { /* 单个资源拿不到不影响其余 */ }
    }));
    await self.skipWaiting();
  })());
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
    /* 页面/JS/样式：cache:"no-cache" 而非 "reload"。
       "reload" 会强制绕过 HTTP 缓存 → 每次打开都把核心文件重下一遍（约 220 KB，gzip 后约 64 KB）；
       "no-cache" 只是"用之前必须向服务器确认"：浏览器带上 If-Modified-Since，
       文件没变时 CDN 返回 304、正文为 0 字节，浏览器把本地副本交给页面；
       文件变了立刻返回新内容。实测 GitHub Pages（Fastly）支持 If-Modified-Since 304。
       因此"发版即时生效"这一特性完全保留，且决策权在服务器，不存在忘记改版本号导致不生效的风险。 */
    e.respondWith(
      fetch(req, { cache: "no-cache" }).then((res) => {
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