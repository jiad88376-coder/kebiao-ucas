/* 消息提醒投递 · Netlify 定时函数
 * 每 10 分钟扫一次到期任务（cron 为 UTC：23/11/12 点 = 北京时间 7/19/20 点窗口）。
 * 环境变量（Netlify → Site configuration → Environment variables）：
 *   SUPABASE_SERVICE_KEY / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
 * 手动测试：Netlify UI → Functions → push-sender → Run now
 */
import webpush from "web-push";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://vwtlcmdewimpbpooufvh.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@courseshell.cloud";
const STALE_MIN = 45; /* 过期超过这么久直接作废，避免早上收到昨晚的提醒 */

export const config = { schedule: "*/10 23,11,12 * * *" };

function headers() {
  return { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "content-type": "application/json" };
}
async function api(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: headers(), ...opts });
  if (!res.ok) throw new Error(path.split("?")[0] + " -> HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  return res;
}

export default async () => {
  if (!SERVICE_KEY || !VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.error("push-sender: 缺少环境变量（SUPABASE_SERVICE_KEY / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）");
    return new Response("missing env", { status: 500 });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const nowIso = new Date().toISOString();
  const jobsRes = await api(
    "push_jobs?select=id,due_at,title,body,url,tag,attempts,endpoint,push_subscriptions(p256dh,auth)" +
    "&due_at=lte." + encodeURIComponent(nowIso) + "&order=due_at.asc&limit=300"
  );
  const jobs = await jobsRes.json();

  /* 并发投递，最后按结果批量清理数据库（30 秒执行限制内足够） */
  const results = await Promise.allSettled(jobs.map(async (j) => {
    const sub = j.push_subscriptions;
    const ageMin = (Date.now() - Date.parse(j.due_at)) / 60000;
    if (!sub || ageMin > STALE_MIN) return { kind: "drop", id: j.id };
    try {
      await webpush.sendNotification(
        { endpoint: j.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: j.title, body: j.body, url: j.url, tag: j.tag })
      );
      return { kind: "sent", id: j.id };
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) return { kind: "dead", id: j.id, endpoint: j.endpoint };
      if ((j.attempts || 0) >= 4) return { kind: "drop", id: j.id };
      return { kind: "retry", id: j.id, attempts: (j.attempts || 0) + 1 };
    }
  }));

  const vals = results.map((r) => r.value).filter(Boolean);
  const doneIds = vals.filter((v) => v.kind === "sent" || v.kind === "drop").map((v) => v.id);
  if (doneIds.length) await api("push_jobs?id=in.(" + doneIds.join(",") + ")", { method: "DELETE" });

  const dead = vals.filter((v) => v.kind === "dead");
  for (const d of dead) {
    /* 订阅已失效（卸载/清数据）：删订阅，任务级联删除 */
    await api("push_subscriptions?endpoint=eq." + encodeURIComponent(d.endpoint), { method: "DELETE" });
  }
  const retry = vals.filter((v) => v.kind === "retry");
  for (const r of retry) {
    await api("push_jobs?id=eq." + r.id, { method: "PATCH", body: JSON.stringify({ attempts: r.attempts }) });
  }

  const sent = vals.filter((v) => v.kind === "sent").length;
  const stale = vals.filter((v) => v.kind === "drop").length;
  console.log(`[push] 到期 ${jobs.length} 条：成功 ${sent} · 失效订阅 ${dead.length} · 失败待重试 ${retry.length} · 过期作废 ${stale}`);
  return new Response(
    JSON.stringify({ ok: true, due: jobs.length, sent, dead: dead.length, retry: retry.length, stale }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
