// EdgeOne Pages 边缘函数: Supabase 反代（与 Netlify 版等价）
// 路由约定: functions/api/supabase/[[path]].js -> /api/supabase/*
const TARGET_BASE = "https://vwtlcmdewimpbpooufvh.supabase.co";
const FUNC_PREFIX = "/api/supabase";
const KEY = "sb_publishable_ONe5Ft1rxeRt-rcdruXYoQ_sM0jgwLn";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-max-age": "86400",
};

// 不透传的逐跳头（与 Netlify 版一致 + 边缘节点附加的头）
const DROP = new Set([
  "host", "connection", "accept-encoding", "content-length", "via",
  "cdn-loop", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
  "x-real-ip", "cf-connecting-ip", "eo-connecting-ip", "tencent-cloud",
]);

async function handle(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const url = new URL(request.url);
  const path = url.pathname.slice(FUNC_PREFIX.length);
  if (!path || path === "/") {
    return new Response("not found", { status: 404, headers: CORS_HEADERS });
  }
  /* 必须透传查询串: token 接口依赖 ?grant_type=password / refresh_token / pkce */
  const target = TARGET_BASE + path + url.search;

  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (DROP.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");

  let body = null;
  if (!["GET", "HEAD"].includes(request.method)) {
    body = await request.arrayBuffer();
  }

  try {
    const resp = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    const out = {
      ...CORS_HEADERS,
      "content-type": resp.headers.get("content-type") || "application/json",
    };
    return new Response(await resp.arrayBuffer(), { status: resp.status, headers: out });
  } catch (e) {
    return new Response(JSON.stringify({ error: "proxy failed", detail: String((e && e.message) || e) }), {
      status: 502,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  }
}

/* 兼容 EdgeOne Pages Functions (onRequest) 与 fetch 风格两种约定 */
export async function onRequest(context) {
  return handle(context.request);
}
export default {
  async fetch(request) {
    return handle(request);
  },
};
