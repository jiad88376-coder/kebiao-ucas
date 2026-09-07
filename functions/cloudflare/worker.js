// Cloudflare Worker: Supabase 反代（主线路）
// 部署: CF Dashboard → Workers → Create Worker("kebiao-api") → 粘贴本文件全部内容 → Deploy
// 绑定: Worker Settings → Domains & Routes → Custom Domain → api.courseshell.cloud
const TARGET_BASE = "https://vwtlcmdewimpbpooufvh.supabase.co";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 健康检查: https://api.courseshell.cloud/ 浏览器直接访问应返回 {"ok":true,...}
    if (url.pathname === "/" && request.method === "GET") {
      let t0 = null;
      try {
        t0 = Date.now();
        const probe = await fetch(TARGET_BASE + "/auth/v1/settings", {
          headers: { accept: "application/json" },
        });
        return new Response(
          JSON.stringify({ ok: true, worker: "kebiao-api", upstream: probe.status, ms: Date.now() - t0 }),
          { status: 200, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ ok: true, worker: "kebiao-api", upstream: "unreachable", detail: String(e && e.message || e) }),
          { status: 200, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
        );
      }
    }

    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: CORS_HEADERS });
    }

    // 透传路径 + 查询串（token 接口依赖 grant_type / refresh_token / pkce）
    const target = TARGET_BASE + url.pathname + url.search;

    const headers = new Headers();
    for (const [k, v] of request.headers.entries()) {
      const lk = k.toLowerCase();
      if (["host", "connection", "accept-encoding", "content-length", "via", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"].includes(lk)) continue;
      headers.set(k, v);
    }
    if (!headers.has("accept")) headers.set("accept", "application/json");

    try {
      const resp = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual",
      });
      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: { ...CORS_HEADERS, "content-type": resp.headers.get("content-type") || "application/json" },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "proxy failed", detail: String(e && e.message || e) }),
        { status: 502, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
      );
    }
  },
};
