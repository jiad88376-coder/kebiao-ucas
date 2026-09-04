// Netlify Functions: Supabase 反代
const TARGET_BASE = "https://vwltcmdewimpbpooufvh.supabase.co";
const FUNC_PREFIX = "/.netlify/functions/supabase";
const KEY = "sb_publishable_ONe5Ft1rxeRt-rcdruXYoQ_sM0jgwLn";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-max-age": "86400",
};

const dns = require("dns").promises;
const https = require("https");

function httpsGet(url, family) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const opts = {
      host: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      timeout: 15000,
      headers: { "User-Agent": "kebiao-diag", apikey: KEY, Authorization: "Bearer " + KEY },
    };
    if (family) opts.family = family;
    const req = https.request(opts, (res) => {
      resolve("HTTP " + res.statusCode);
      res.resume();
    });
    req.on("error", (e) => resolve("FAIL " + e.message));
    req.on("timeout", () => { req.destroy(); resolve("FAIL timeout(15s)"); });
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  /* 分层诊断: /.netlify/functions/supabase/diag */
  if (event.path && event.path.endsWith("/diag")) {
    const host = "vwltcmdewimpbpooufvh.supabase.co";
    const results = {};
    try {
      const addrs = await dns.lookup(host, { all: true });
      results.dns = addrs.map((x) => `v${x.family}:${x.address}`).join(" ");
    } catch (e) {
      results.dns = "FAIL " + e.message;
    }
    results.https_default = await httpsGet(TARGET_BASE + "/auth/v1/settings");
    results.https_ipv4 = await httpsGet(TARGET_BASE + "/auth/v1/settings", 4);
    results.https_ipv6 = await httpsGet(TARGET_BASE + "/auth/v1/settings", 6);
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(results),
    };
  }

  const path = (event.path || "").replace(new RegExp("^" + FUNC_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "");
  if (!path) return { statusCode: 404, headers: CORS_HEADERS, body: "not found" };
  const target = TARGET_BASE + path;

  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    const lk = k.toLowerCase();
    if (["host", "connection", "accept-encoding", "content-length", "via"].includes(lk)) continue;
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
      headers: { ...CORS_HEADERS, "content-type": resp.headers.get("content-type") || "application/json" },
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