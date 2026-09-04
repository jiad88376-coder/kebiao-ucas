// Netlify Functions: Supabase 反代
// 浏览器请求本站 /.netlify/functions/supabase/* → 转发到 Supabase 项目 API
// 绕过 GFW 对 *.supabase.co 的 SNI 阻断；函数运行在 Netlify 边缘/服务器，无网络屏障
const TARGET_BASE = "https://vwltcmdewimpbpooufvh.supabase.co";
const FUNC_PREFIX = "/.netlify/functions/supabase";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-max-age": "86400",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  /* 诊断路由: /.netlify/functions/supabase/diag */
  if (event.path && event.path.endsWith("/diag")) {
    const results = {};
    for (const [name, url] of [
      ["example.com", "https://example.com"],
      ["supabase-co-main", "https://supabase.co"],
      ["supabase-project", TARGET_BASE + "/auth/v1/settings"],
    ]) {
      try {
        await fetch(url);
        results[name] = "ok";
      } catch (e) {
        results[name] = "FAIL: " + String(e && e.message || e);
      }
    }
    return { statusCode: 200, headers: { ...CORS_HEADERS, "content-type": "application/json" }, body: JSON.stringify(results) };
  }

  const path = (event.path || "").replace(new RegExp("^" + FUNC_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "");
  if (!path) return { statusCode: 404, headers: CORS_HEADERS, body: "not found" };
  const target = TARGET_BASE + path;

  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    const lk = k.toLowerCase();
    if (["host", "connection", "accept-encoding", "content-length", "via", "x-nf-client-connection-ip"].includes(lk)) continue;
    headers[k] = v;
  }
  headers["accept"] = headers["accept"] || "application/json";

  let body;
  if (!["GET", "HEAD"].includes(event.httpMethod)) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : event.body || "";
  }

  try {
    const resp = await fetch(target, {
      method: event.httpMethod,
      headers,
      body,
      redirect: "manual",
    });
    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: {
        ...CORS_HEADERS,
        "content-type": resp.headers.get("content-type") || "application/json",
      },
      body: text,
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "proxy failed", detail: String(e && e.message || e) }),
    };
  }
};