/* ================================================================
 * 课表 · 多校课程表 (kebiao)
 * 学校配置: data/schools.json + data/schools/<id>.json  |  个人数据: localStorage(仅本机)
 * ================================================================ */
'use strict';

/* ---------------- 纯逻辑（可测试） ---------------- */
/* ---------------- 校级配置（默认=国科大；启动时被 data/schools/<id>.json 覆盖） ---------------- */
let PERIOD_TIMES = {
  1: "8:30-9:15", 2: "9:20-10:05", 3: "10:25-11:10", 4: "11:15-12:00",
  5: "13:30-14:15", 6: "14:20-15:05", 7: "15:25-16:10", 8: "16:15-17:00",
  9: "17:05-17:50", 10: "18:30-19:15", 11: "19:20-20:05", 12: "20:15-21:00", 13: "21:05-21:50"
};
const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
let CAMPUS_NAME = { H: "怀柔", Y: "玉泉", Z: "中关村" };
let SCHOOL = null;          // 当前学校配置对象
let SCHOOL_SECTIONS = null; // 该校 上午/下午/晚上 分段（可选配置）

function normalizeCode(raw) {
  if (raw == null) return "";
  let s = String(raw).trim().toUpperCase();
  s = s.replace(/[^\u4e00-\u9fa5A-Z0-9-]/g, ""); // 容忍全角/空格/标点
  return s;
}

function parseCodes(text) {
  const minLen = (SCHOOL && SCHOOL.minCodeLen) || 8;
  const parts = String(text || "").split(/[\s,，;；、]+/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const c = normalizeCode(p);
    if (c && c.length >= minLen && !seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out;
}

function weeksOverlap(wa, wb) {
  if (!wa || !wb || !wa.length || !wb.length) return true; // 无法解析则保守视为重叠
  for (const [a1, a2] of wa) for (const [b1, b2] of wb) {
    if (a1 <= b2 && b1 <= a2) return true;
  }
  return false;
}

function sessionOverlap(sa, sb) {
  if (sa.day !== sb.day) return false;
  if (!(sa.p1 <= sb.p2 && sb.p1 <= sa.p2)) return false;
  return weeksOverlap(sa.weekSet, sb.weekSet);
}

/* 返回课程A/B之间的冲突时段对列表 */
function conflictsBetween(courseA, courseB) {
  const pairs = [];
  for (const sa of courseA.sessions) for (const sb of courseB.sessions) {
    if (sessionOverlap(sa, sb)) pairs.push({ sa, sb });
  }
  return pairs;
}

function findConflicts(courses) {
  const list = [];
  for (let i = 0; i < courses.length; i++) for (let j = i + 1; j < courses.length; j++) {
    const pairs = conflictsBetween(courses[i], courses[j]);
    if (pairs.length) list.push({ a: courses[i], b: courses[j], pairs });
  }
  return list;
}

/* 格式化星期+节次: (day,p1,p2) -> "周三 5-7节" */
function fmtSession(s) {
  return `${DAY_NAMES[s.day - 1]} ${s.p1}-${s.p2}节`;
}

function attrClass(attr) {
  if (/核心/.test(attr || "")) return "attr-core";
  if (/专业课/.test(attr || "")) return "attr-prof";
  if (/公共/.test(attr || "")) return "attr-public";
  if (/研讨/.test(attr || "")) return "attr-semi";
  if (/实验|实践/.test(attr || "")) return "attr-exp";
  return "attr-other";
}

function dayIndexOfToday() {
  return ((new Date().getDay() + 6) % 7) + 1; // 周一=1 ... 周日=7
}

/* ---------------- 学期周次 ---------------- */
let SEMESTER_MONDAY = "2026-08-31"; // 第 1 周周一（校级配置可覆盖）
let MAX_WEEK = 25;

function parseYMD(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}
/* 当前日期处于第几教学周（开学前按第 1 周，之后封顶 MAX_WEEK） */
function getSemesterWeek(date) {
  const mon = parseYMD(SEMESTER_MONDAY);
  const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.floor((d0 - mon) / 604800000);
  return Math.min(MAX_WEEK, Math.max(1, diff + 1));
}
/* 某 session 的 weekSet 是否包含周 w（缺失视为包含，保守显示） */
function inWeekSet(weekSet, w) {
  if (!Array.isArray(weekSet) || !weekSet.length) return true;
  return weekSet.some(r => w >= r[0] && w <= r[1]);
}
function weekMonday(week) {
  const d = parseYMD(SEMESTER_MONDAY);
  d.setDate(d.getDate() + 7 * (week - 1));
  return d;
}
function fmtWeekRange(week) {
  const a = weekMonday(week);
  const b = weekMonday(week); b.setDate(b.getDate() + 6);
  return (a.getMonth() + 1) + "." + a.getDate() + " - " + (b.getMonth() + 1) + "." + b.getDate();
}

/* 剩余天数（负数=已过/逾期；0=今天） */
function daysLeft(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}
/* 本地时区今天的 YYYY-MM-DD（toISOString 是 UTC，晚上会差一天） */
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* ---------------- 应用状态 ---------------- */
const STORE_KEY = "kebiao:ucas:v1";
const LAST_MODIFIED_KEY = "kebiao:ucas:v1:mtime";
const SCHOOL_KEY = "kebiao:school";
let viewWeek = 1; // 启动时由 applySchoolConfig 按校历设置（null=全部周次）
let viewDay = 0;  // 手机端默认聚焦今天(0=全周)；桌面端全周；同样在 applySchoolConfig 设置

/* ---------------- 云同步 (Supabase, 经反代) ---------------- */
/* supabase.co 在国内被 GFW 阻断，全部云端流量走免费反代。
   双源择优: CF Worker(自有域名 api.courseshell.cloud, 全球边缘) + Netlify(海外)。
   EdgeOne 备胎已下线（站点被回收），如重新部署加一行即可。
   启动时默认主线路；遇到网络类错误自动轮换备胎并保持，每次调用最多切换 2 次。 */
const SUPABASE_KEY = "sb_publishable_ONe5Ft1rxeRt-rcdruXYoQ_sM0jgwLn";
const PROXY_SOURCES = [
  { id: "cf", base: "https://api.courseshell.cloud", path: "" },
  { id: "netlify", base: "https://kebiao-ucas.netlify.app", path: "/.netlify/functions/supabase" }
];

let supabaseClient = null;
let authUser = null;
let pushTimer = null;
let proxyIdx = 0;
let failovers = 0;

/* 统一的 auth 存储键：让所有反代源共享登录态（supabase-js 默认按域名派生，双源会割裂） */
const AUTH_SK = "kebiao-auth-token-v1";
/* 一次性迁移：把旧版按域名派生的 key 搬到统一 key，避免老用户被登出 */
function migrateAuthKey() {
  try {
    if (localStorage.getItem(AUTH_SK)) return;
    const keys = Object.keys(localStorage).filter(k => /auth-token/.test(k) && k !== AUTH_SK);
    if (keys.length === 1) {
      const v = localStorage.getItem(keys[0]);
      if (v) localStorage.setItem(AUTH_SK, v);
    }
  } catch (e) {}
}

function setProxy(i) {
  proxyIdx = i;
  const s = PROXY_SOURCES[i];
  supabaseClient = (typeof window !== "undefined" && window.supabase)
    ? window.supabase.createClient(s.base + s.path, SUPABASE_KEY, { auth: { storageKey: AUTH_SK } })
    : null;
}

function initSupabase() {
  migrateAuthKey();
  setProxy(0);
}

/* 网络 类错误识别（GFW reset / 断网 / 反代挂） */
function looksNetworky(e) {
  const m = String((e && (e.message || e)) || "");
  return /failed to fetch|networkerror|network error|load failed|timed?\s?out|abort|502|503/i.test(m);
}

/* 惰性故障切换：调用失败才切源重试一次，不做主动探测（省额度） */
async function withFailover(fn) {
  try {
    return await fn(supabaseClient);
  } catch (e) {
    if (!looksNetworky(e) || failovers >= 2 || PROXY_SOURCES.length < 2) throw e;
    failovers++;
    setProxy((proxyIdx + 1) % PROXY_SOURCES.length);
    return await fn(supabaseClient);
  }
}

function online() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/* 本地修改后推送云端（登录状态下）：10 分钟节流合并 + 离开页面兜底推送；内容没变就不推 */
function schedulePush() {
  if (!supabaseClient || !authUser || !online()) return;
  clearTimeout(pushTimer);
  const wait = Math.max(800, lastPushAt + PUSH_MIN_MS - Date.now());
  pushTimer = setTimeout(pushToCloud, wait);
}
function flushPush() {
  if (!supabaseClient || !authUser || !online()) return;
  clearTimeout(pushTimer);
  if (stateHash() === lastPushedHash) return;
  try { pushToCloud(); } catch (e) {}
}

function stateHash() {
  return state.codes.join(",") + "|" + JSON.stringify(state.records);
}
let lastPushedHash = null;
const PUSH_MIN_MS = 10 * 60 * 1000;
let lastPushAt = 0;

async function pushToCloud() {
  if (!supabaseClient || !authUser || !online()) return;
  const h = stateHash();
  if (h === lastPushedHash) return; /* 无变化不推 */
  try {
    await withFailover((c) => c.from("user_data").upsert({
      user_id: authUser.id,
      schedule: { codes: state.codes },
      records: state.records,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" }));
    lastPushedHash = h;
    lastPushAt = Date.now();
  } catch (e) { console.warn("push failed", e); }
}

async function pullFromCloud() {
  if (!supabaseClient || !authUser || !online()) return null;
  try {
    const { data } = await withFailover((c) => c.from("user_data")
      .select("schedule,records,updated_at").eq("user_id", authUser.id).maybeSingle());
    return data || null;
  } catch (e) { console.warn("pull failed", e); return null; }
}

function applyCloud(cloud) {
  const codes = (cloud && cloud.schedule && cloud.schedule.codes) || [];
  state.codes = codes.filter(c => courseMap[c]);
  state.records = cloud && cloud.records && typeof cloud.records === "object" ? cloud.records : {};
  saveState();
  lastPushedHash = stateHash(); /* 刚下载的内容标记为已推送，防止回声推送 */
  render();
}

/* 登录后的数据合并：两端都有数据时按修改时间静默取舍（新的一方胜出），不再弹窗 */
/* 节流：课表一学期基本不变，24 小时只拉取一次（当天再打开零请求）；force=true 跳过节流（登录/手动同步） */
const SYNC_AT_KEY = "kebiao:syncat";
const SYNC_MIN_MS = 24 * 60 * 60 * 1000;
let lastSyncAt = 0;
try { lastSyncAt = Number(localStorage.getItem(SYNC_AT_KEY)) || 0; } catch (e) {}
function markSynced() {
  lastSyncAt = Date.now();
  try { localStorage.setItem(SYNC_AT_KEY, String(lastSyncAt)); } catch (e) {}
}
async function pullAndMerge(force) {
  if (!supabaseClient || !authUser) return;
  if (!force && Date.now() - lastSyncAt < SYNC_MIN_MS) return;
  const cloud = await pullFromCloud();
  markSynced();
  const localHas = state.codes.length > 0;
  const cloudHas = !!(cloud && cloud.schedule && Array.isArray(cloud.schedule.codes) && cloud.schedule.codes.length);
  if (!cloudHas && !localHas) return;
  if (!cloudHas) {           // 仅本机有 → 上传
    await pushToCloud();
    return;
  }
  if (!localHas) {           // 仅云端有 → 下载
    applyCloud(cloud);
    return;
  }
  /* 两端都有：比较修改时间，新者胜（静默，无提示） */
  let localT = 0, cloudT = 0;
  try { localT = Number(localStorage.getItem(LAST_MODIFIED_KEY)) || 0; } catch (e) {}
  try { cloudT = cloud.updated_at ? Date.parse(cloud.updated_at) : 0; } catch (e) {}
  if (localT > cloudT) {
    await pushToCloud();     // 本机更新（可能是离线时改的）→ 推上去
  } else {
    applyCloud(cloud);       // 云端更新 → 下载
  }
}

/* ---------------- 主题（跟随系统 + 手动三档） ---------------- */
const THEME_KEY = "kebiao:theme";

function themePref() {
  try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { return "auto"; }
}
function systemDark() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}
function resolvedTheme(pref) {
  if (pref === "dark" || pref === "light") return pref;
  return systemDark() ? "dark" : "light";
}
function applyThemeMeta(resolved) {
  let m = document.querySelector('meta[name="theme-color"][data-js]');
  if (resolved === "dark") {
    if (!m) { m = document.createElement("meta"); m.name = "theme-color"; m.setAttribute("data-js", "1"); document.head.appendChild(m); }
    m.content = "#12151c";
  } else if (resolved === "light") {
    if (!m) { m = document.createElement("meta"); m.name = "theme-color"; m.setAttribute("data-js", "1"); document.head.appendChild(m); }
    m.content = "#2F6FED";
  } else if (m) m.remove(); /* auto: 交给带 media 属性的静态 meta */
}
function applyTheme(pref) {
  const resolved = resolvedTheme(pref);
  document.documentElement.dataset.theme = resolved;
  applyThemeMeta(pref === "auto" ? null : resolved);
  const btn = $("btnTheme");
  if (btn) btn.textContent = pref === "dark" ? "🌙" : pref === "light" ? "☀️" : "🌗";
}
function cycleTheme() {
  const order = ["auto", "dark", "light"];
  const next = order[(order.indexOf(themePref()) + 1) % 3];
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme(next);
  toast(next === "auto" ? "深色模式：跟随系统" : next === "dark" ? "已强制深色模式" : "已强制浅色模式");
}
if (typeof document !== "undefined" && typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themePref() === "auto") applyTheme("auto");
  });
}

function updateAuthUI() {
  const lbl = document.querySelector("#btnLogin .ib-label");
  const txt = authUser ? (authUser.email || "已登录").split("@")[0] : "登录";
  if (lbl) lbl.textContent = txt;
  else $("btnLogin").textContent = "☁ " + txt;
}

function showAuthModal() {
  if (authUser) {
    showModal(`
      <div class="modal-card auth-card">
        <div class="auth-logo">✓</div>
        <div class="auth-head">已登录</div>
        <p class="auth-desc">${authUser.email}<br>课表与笔记云同步中，换设备登录同一账号即可互通</p>
        <div class="modal-actions">
          <button class="ok" id="authSync">立即同步</button>
          <button class="cancel" id="authOut">退出登录</button>
        </div>
      </div>`);
    $("authSync").addEventListener("click", async () => {
      hideModal();
      await pullAndMerge(true);
      toast("同步完成");
    });
    $("authOut").addEventListener("click", async () => {
      await supabaseClient.auth.signOut();
      authUser = null;
      updateAuthUI();
      hideModal();
      toast("已退出登录（本机数据保留）");
    });
    return;
  }
  showModal(`
    <div class="modal-card auth-card">
      <div class="auth-logo">课</div>
      <div class="auth-head">登录 · 云同步课表</div>
      <p class="auth-desc">课表 / 笔记 / 作业 / 考试 全端同步<br>手机与电脑登录同一账号即可互通</p>
      <div class="r-form">
        <input id="authEmail" class="auth-input" type="email" placeholder="邮箱地址" inputmode="email" autocomplete="email">
        <input id="authPass" class="auth-input" type="password" placeholder="密码（至少 8 位）" autocomplete="current-password">
      </div>
      <button class="auth-main" id="authLogin">登 录</button>
      <div class="auth-alt">
        <button class="auth-alt-btn auth-strong" id="authSignup">✚ 注册新账号</button>
        <button class="auth-alt-btn" id="authCancel">取消</button>
      </div>
    </div>`);
  const emailEl = $("authEmail");
  const passEl = $("authPass");
  $("authLogin").addEventListener("click", () => doPasswordLogin(emailEl, passEl));
  emailEl.addEventListener("keydown", (e) => { if (e.key === "Enter") passEl.focus(); });
  passEl.addEventListener("keydown", (e) => { if (e.key === "Enter") doPasswordLogin(emailEl, passEl); });
  $("authSignup").addEventListener("click", () => showAuthSignupUI(emailEl.value));
  $("authCancel").addEventListener("click", hideModal);
}

async function doPasswordLogin(emailEl, passEl, btnId = "authLogin") {
  const email = emailEl.value.trim();
  const pass = passEl.value;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("邮箱格式不正确"); return; }
  if (!pass) { toast("请输入密码"); return; }
  const btn = $(btnId);
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "登录中…";
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: pass });
    if (error) throw error;
    authUser = data.user;
    updateAuthUI();
    hideModal();
    toast("登录成功，正在同步…");
    await pullAndMerge(true);
  } catch (e) {
    const msg = e.message || e;
    toast(msg.includes("Invalid login") ? "邮箱或密码不正确" : "登录失败：" + msg);
  }
  btn.disabled = false;
  btn.textContent = old;
}

/* 注册流程：① 邮箱收 6 位验证码 ② 验证码 + 设密码 → 完成注册（忘记密码时同样走此流程重设） */
function showAuthSignupUI(email) {
  showModal(`
    <div class="modal-card auth-card">
      <div class="auth-logo">课</div>
      <div class="auth-head">注册新账号</div>
      <p class="auth-desc">发送验证码 → 填写验证码并设置密码</p>
      <div class="r-form">
        <div class="row2">
          <input id="suEmail" class="auth-input" type="email" placeholder="邮箱地址" inputmode="email" autocomplete="email" value="${email || ""}">
          <button class="r-btn ghost" id="suSend" style="white-space:nowrap">发送验证码</button>
        </div>
        <input id="suCode" class="auth-input code" type="text" placeholder="邮箱验证码（6-8 位）" inputmode="numeric" maxlength="8" autocomplete="one-time-code" style="display:none">
        <input id="suPass" class="auth-input" type="password" placeholder="设置密码（至少 8 位）" autocomplete="new-password" style="display:none">
      </div>
      <button class="auth-main" id="suDone">完成注册</button>
      <div class="auth-alt">
        <button class="auth-alt-btn" id="suBack">← 返回登录</button>
        <button class="auth-alt-btn" id="suCancel">取消</button>
      </div>
    </div>`);
  const emailEl = $("suEmail");
  const codeEl = $("suCode");
  const passEl = $("suPass");
  let sent = false;
  $("suSend").addEventListener("click", async () => {
    const email = emailEl.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("邮箱格式不正确"); return; }
    $("suSend").disabled = true;
    $("suSend").textContent = "发送中…";
    try {
      const { error } = await supabaseClient.auth.signInWithOtp({ email });
      if (error) throw error;
      sent = true;
      codeEl.style.display = "block";
      passEl.style.display = "block";
      codeEl.focus();
      $("suSend").textContent = "重新发送";
      toast("验证码已发送，请查收邮箱（留意垃圾箱）");
    } catch (e) {
      toast("发送失败：" + (e.message || e));
    }
    $("suSend").disabled = false;
  });
  $("suDone").addEventListener("click", async () => {
    const email = emailEl.value.trim();
    const token = codeEl.value.trim();
    const pass = passEl.value;
    if (!sent) { toast("请先发送验证码"); return; }
    if (!token) { toast("请输入验证码"); return; }
    if (pass.length < 8) { toast("密码至少 8 位"); return; }
    $("suDone").disabled = true;
    $("suDone").textContent = "注册中…";
    try {
      const { data, error } = await supabaseClient.auth.verifyOtp({ email, token, type: "email" });
      if (error) throw error;
      authUser = data.user;
      const { error: perr } = await supabaseClient.auth.updateUser({ password: pass });
      if (perr) {
        updateAuthUI();
        hideModal();
        toast("注册成功，但密码设置失败：" + (perr.message || perr));
        await pullAndMerge(true);
        return;
      }
      updateAuthUI();
      hideModal();
      toast("注册成功，正在同步…");
      await pullAndMerge(true);
    } catch (e) {
      toast("注册失败：" + (e.message || e));
    }
    $("suDone").disabled = false;
    $("suDone").textContent = "完成注册";
  });
  $("suBack").addEventListener("click", () => showAuthModal());
  $("suCancel").addEventListener("click", hideModal);
  emailEl.addEventListener("keydown", (e) => { if (e.key === "Enter") $("suSend").click(); });
  codeEl.addEventListener("keydown", (e) => { if (e.key === "Enter") passEl.focus(); });
  passEl.addEventListener("keydown", (e) => { if (e.key === "Enter") $("suDone").click(); });
}

let catalog = null;
let courseMap = {};
let state = { codes: [], records: {} };

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (Array.isArray(s.codes)) {
        state.codes = s.codes;
        state.records = s.records && typeof s.records === "object" ? s.records : {};
      }
    }
  } catch (e) { console.warn("loadState", e); }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    localStorage.setItem(LAST_MODIFIED_KEY, String(Date.now()));
  }
  catch (e) { toast("保存失败（存储空间不足？）"); }
  if (typeof document !== "undefined") schedulePush();
}

function recordsOf(code) {
  if (!state.records[code]) state.records[code] = { notes: [], homework: [], exams: [] };
  return state.records[code];
}

/* 个人课表微调：按"星期+节次"或"具体日期"覆盖地点/教师（只影响自己，随 records 云同步）。
   查找顺序：单日调整 > 全学期调整 > 课程库默认。 */
function sessKey(s) { return s.day + "-" + s.p1 + "-" + s.p2; }
function dateStrOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function nextDateStr(dayIdx) {
  const d = new Date();
  const cur = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() + (dayIdx - cur + 7) % 7);
  return dateStrOf(d);
}
function tweakOf(code, s) {
  const rec = state.records[code];
  return rec && rec.tweaks ? rec.tweaks[sessKey(s)] : null;
}
function dateTweakOf(code, dateStr, s) {
  const rec = state.records[code];
  if (!rec || !rec.tweaksByDate || !rec.tweaksByDate[dateStr]) return null;
  return rec.tweaksByDate[dateStr][sessKey(s)] || null;
}
function effTweak(code, s, dateStr) {
  if (dateStr) {
    const t = dateTweakOf(code, dateStr, s);
    if (t) return t;
  }
  return tweakOf(code, s);
}
function effRoom(course, s, dateStr) {
  const tw = effTweak(course.code, s, dateStr);
  return (tw && tw.room) || s.room;
}
function effTeacher(course, s, dateStr) {
  const tw = effTweak(course.code, s, dateStr);
  return (tw && tw.teacher) || course.teacher;
}
/* 时间覆盖（星期/节次）：单日 > 学期，只影响本地自己的显示 */
function effSlot(code, s, dateStr) {
  const tw = effTweak(code, s, dateStr) || {};
  return {
    day: Number.isInteger(tw.day) ? tw.day : s.day,
    p1: Number.isInteger(tw.p1) ? tw.p1 : s.p1,
    p2: Number.isInteger(tw.p2) ? tw.p2 : s.p2
  };
}

/* ---------------- DOM 工具 ---------------- */
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
function showModal(htmlOrNode) {
  const m = $("modal");
  if (typeof htmlOrNode === "string") m.innerHTML = htmlOrNode;
  else { m.innerHTML = ""; m.appendChild(htmlOrNode); }
  m.classList.remove("hidden");
}
function hideModal() { $("modal").classList.add("hidden"); }

/* ---------------- 输入体验工具 ---------------- */
/* 输入时自动增高（上限 maxH px），避免在小框里滚动 */
function autoGrow(ta, maxH) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, maxH || 260) + "px";
}
function bindAutoGrow(ta, maxH) {
  ta.addEventListener("input", () => autoGrow(ta, maxH));
  autoGrow(ta, maxH);
}
/* 字数计数器：接近上限变橙，超限变红 */
function attachCount(ta, max) {
  const c = el("div", "input-count");
  const upd = () => {
    const n = ta.value.length;
    c.textContent = n + "/" + max;
    c.style.display = n ? "block" : "none";
    c.classList.toggle("near", n > max * 0.85 && n <= max);
    c.classList.toggle("over", n > max);
  };
  ta.addEventListener("input", upd);
  upd();
  ta.insertAdjacentElement("afterend", c);
  return c;
}
/* Ctrl/Cmd + Enter 快捷发送 */
function ctrlEnter(ta, onSend) {
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onSend(); }
  });
}

/* ---------------- 课程解析与添加 ---------------- */
function resolveCodes(rawCodes) {
  const found = [], unknown = [], dupes = [];
  const has = new Set(state.codes);
  for (const c of rawCodes) {
    if (!courseMap[c]) { unknown.push(c); continue; }
    if (has.has(c)) { dupes.push(c); continue; }
    found.push(courseMap[c]);
  }
  return { found, unknown, dupes };
}

function addCodes(rawCodes, { silent = false } = {}) {
  const { found, unknown, dupes } = resolveCodes(rawCodes);
  if (found.length) {
    for (const c of found) state.codes.push(c.code);
    saveState();
    render();
  }
  if (silent) return { found, unknown, dupes };
  const lines = [];
  if (found.length) lines.push(`已添加 ${found.length} 门课程`);
  if (dupes.length) lines.push(`已存在 ${dupes.length} 门，跳过`);
  if (unknown.length) {
    lines.push(`以下代码未识别（${unknown.length}）：${unknown.join("，")}`);
    showBanner(lines.join("\n"), true);
  } else if (found.length || dupes.length) {
    const conflicts = findConflicts(state.codes.map(c => courseMap[c]).map((c0) => {
      if (!c0) return c0;
      return Object.assign({}, c0, { sessions: c0.sessions.map(s => Object.assign({}, s, effSlot(c0.code, s, null))) });
    }));
    if (conflicts.length) {
      lines.push(`⚠ 检测到 ${conflicts.length} 处时间冲突：`);
      for (const cf of conflicts) {
        const p = cf.pairs[0];
        lines.push(`· ${cf.a.name}(${fmtSession(p.sa)}) ↔ ${cf.b.name}(${fmtSession(p.sb)})`);
      }
      showBanner(lines.join("\n"), true);
    } else {
      showBanner(lines.join("\n"), false);
    }
  }
  return { found, unknown, dupes };
}

function removeCourse(code) {
  state.codes = state.codes.filter(c => c !== code);
  saveState();
  render();
  toast("已从课表移除");
}

/* ---------------- 渲染：主界面切换 ---------------- */
function showMain() {
  maybeShowInstallBar();
  $("welcome").classList.add("hidden");
  $("schoolPick").classList.add("hidden");
  $("main").classList.remove("hidden");
}
function showWelcome() {
  renderIdentity();
  $("main").classList.add("hidden");
  $("schoolPick").classList.add("hidden");
  $("welcome").classList.remove("hidden");
}

let bannerTimer = null;
function showBanner(text, warn) {
  const b = $("banner");
  b.classList.toggle("warn", !!warn);
  const ul = el("ul");
  for (const line of String(text).split("\n")) {
    const li = el("li", "", line);
    ul.appendChild(li);
  }
  b.innerHTML = "";
  b.appendChild(ul);
  b.classList.remove("hidden");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add("hidden"), 12000);
}
/* ---------------- 渲染：周课表 ---------------- */
function curWeek() { return getSemesterWeek(new Date()); }

function render() {
  const hasCourses = state.codes.length > 0;
  hasCourses ? showMain() : showWelcome();
  renderWeekbar();
  renderDayTabs();
  renderGrid();
  $("termBadge").textContent = catalog && catalog.meta && catalog.meta.term
    ? catalog.meta.term : "";
  updateAppBadge();
}

/* ---------------- 桌面快捷方式与角标：下节课 / 今日剩余 ----------------
   真·系统小组件（iOS WidgetKit / Android AppWidget）只有原生 App 能做；
   PWA 的近似方案：manifest shortcuts 长按图标直达 + App 角标计数。 */
function dayIndexOfDate(d) { return d.getDay() === 0 ? 7 : d.getDay(); }
function hmToDate(base, hm) {
  const a = String(hm).split(":");
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), +a[0], +a[1], 0, 0);
}
function periodBounds(date, p1, p2) {
  const t1 = (PERIOD_TIMES[p1] || "").split("-")[0];
  const t2 = (PERIOD_TIMES[p2] || "").split("-")[1];
  if (!t1 || !t2) return null;
  return { start: hmToDate(date, t1), end: hmToDate(date, t2) };
}
/* 未来 7 天内的下一节课（进行中的课也算；尊重用户微调） */
function findNextClass(courses, now) {
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cands = [];
  for (let off = 0; off <= 7; off++) {
    const date = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate() + off);
    const ds = dateStrOf(date);
    const wk = getSemesterWeek(date);
    const dayIdx = dayIndexOfDate(date);
    for (const c of courses) {
      if (!c) continue;
      for (const s of (c.sessions || [])) {
        const es = effSlot(c.code, s, ds);
        if (es.day !== dayIdx) continue;
        if (s.weekSet && !inWeekSet(s.weekSet, wk)) continue;
        const b = periodBounds(date, es.p1, es.p2);
        if (!b || b.end <= now) continue;
        cands.push({ course: c, session: s, slot: es, bounds: b, date, room: effRoom(c, s, ds) });
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.bounds.start - b.bounds.start);
  return cands[0];
}
/* 今天还没下课的节次个数（角标用，去重同码同段） */
function todayRemainingClasses(courses, now) {
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ds = dateStrOf(today0);
  const wk = getSemesterWeek(today0);
  const dayIdx = dayIndexOfDate(today0);
  const seen = new Set();
  let n = 0;
  for (const c of courses) {
    if (!c) continue;
    for (const s of (c.sessions || [])) {
      const k = c.code + "|" + sessKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      const es = effSlot(c.code, s, ds);
      if (es.day !== dayIdx) continue;
      if (s.weekSet && !inWeekSet(s.weekSet, wk)) continue;
      const b = periodBounds(today0, es.p1, es.p2);
      if (!b || b.end <= now) continue;
      n++;
    }
  }
  return n;
}
function showNextClassModal(nx) {
  const c = nx.course;
  const now = new Date();
  const mins = Math.round((nx.bounds.start - now) / 60000);
  const card = el("div", "modal-card");
  card.appendChild(el("div", "auth-logo", "⏰"));
  card.appendChild(el("h3", "", "下一节：" + c.name));
  const st = nx.bounds.start, en = nx.bounds.end;
  card.appendChild(el("p", "share-hint",
    DAY_NAMES[nx.slot.day - 1] + " 第" + nx.slot.p1 + (nx.slot.p2 > nx.slot.p1 ? "-" + nx.slot.p2 : "") + "节 · " +
    (st.getMonth() + 1) + "月" + st.getDate() + "日 " + pad2(st.getHours()) + ":" + pad2(st.getMinutes()) +
    " – " + pad2(en.getHours()) + ":" + pad2(en.getMinutes())));
  card.appendChild(el("p", "share-hint", (nx.room || "教室未定") + (c.teacher ? " · " + c.teacher : "")));
  card.appendChild(el("p", "share-hint", mins > 0
    ? (mins >= 60 ? Math.floor(mins / 60) + " 小时 " + (mins % 60) + " 分钟后开讲" : mins + " 分钟后开讲")
    : "正在上课中"));
  const row = el("div", "modal-actions");
  const go = el("button", "ok", "查看当日课表");
  go.addEventListener("click", () => {
    hideModal();
    viewWeek = getSemesterWeek(nx.date);
    if (window.innerWidth <= 640) viewDay = dayIndexOfDate(nx.date);
    render();
  });
  const cancel = el("button", "cancel", "关闭");
  cancel.addEventListener("click", hideModal);
  row.appendChild(go);
  row.appendChild(cancel);
  card.appendChild(row);
  showModal(card);
}
/* 应用角标：今天还剩几节课（Chromium 系支持；iOS 不支持则静默跳过） */
function updateAppBadge() {
  try {
    if (!navigator.setAppBadge) return;
    const list = state.codes.map(c => courseMap[c]).filter(Boolean);
    const n = todayRemainingClasses(list, new Date());
    if (n > 0) navigator.setAppBadge(n);
    else navigator.clearAppBadge();
  } catch (e) {}
}

/* 周次切换条 */
function renderWeekbar() {
  const label = $("wkLabel");
  label.innerHTML = "";
  if (viewWeek == null) {
    label.appendChild(el("span", "", "全部周次"));
  } else {
    label.appendChild(el("span", "", "第 " + viewWeek + " 周"));
    label.appendChild(el("span", "wk-range", fmtWeekRange(viewWeek)));
    if (viewWeek === curWeek()) label.appendChild(el("span", "wk-now", "本周"));
  }
  $("wkAll").textContent = viewWeek == null ? "回到本周" : "全部周次";
  $("wkPrev").disabled = viewWeek != null && viewWeek <= 1;
  $("wkNext").disabled = viewWeek != null && viewWeek >= MAX_WEEK;
}

/* 本周是否有课；没有则顺延到最近的有课周（默认视图用） */
function hasSessionsInWeek(w) {
  return state.codes.some(code => {
    const c = courseMap[code];
    return c && (c.sessions || []).some(s => inWeekSet(s.weekSet, w));
  });
}
function smartDefaultWeek() {
  const w0 = curWeek();
  if (hasSessionsInWeek(w0)) return w0;
  for (let w = w0 + 1; w <= MAX_WEEK; w++) {
    if (hasSessionsInWeek(w)) return w;
  }
  return w0;
}

/* 周 w 内离参考日期（默认今天）最近的有课的星期几（1-7）；全周无课返回 0。
   平手（如周三看周二/周四都差一天）优先选更靠后的（向前看）。 */
function nearestCourseDay(w, courses, ref) {
  const byDay = new Array(8).fill(false);
  for (const c of courses || []) {
    for (const s of (c.sessions || [])) {
      const es = effSlot(c.code, s, null); /* 学期级时间调整后的星期 */
      const d = Number(es.day);
      if (d >= 1 && d <= 7 && inWeekSet(s.weekSet, w)) byDay[d] = true;
    }
  }
  if (!byDay.some(Boolean)) return 0;
  const n = ref || new Date();
  const base = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  let best = 0, bestDist = Infinity;
  for (let d = 1; d <= 7; d++) {
    if (!byDay[d]) continue;
    const dt = weekMonday(w);
    dt.setDate(dt.getDate() + d - 1);
    const dist = Math.abs(dt - base) / 86400000;
    if (dist < bestDist - 1e-6 || (Math.abs(dist - bestDist) <= 1e-6 && d > best)) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/* 切换周次后：当前聚焦的日子在新周次没课（且不是"今天"本身），
   自动跳到该周离今天最近的有课日；有课则保持，方便跨周对比同一节课。 */
function smartRealignDay() {
  if (viewWeek == null || !viewDay) return;
  if (viewWeek === curWeek() && viewDay === dayIndexOfToday()) return;
  const courses = state.codes.map(code => courseMap[code]).filter(Boolean);
  const has = courses.some(c => (c.sessions || []).some(s => Number(effSlot(c.code, s, null).day) === viewDay && inWeekSet(s.weekSet, viewWeek)));
  if (has) return;
  const nd = nearestCourseDay(viewWeek, courses, new Date());
  if (nd) viewDay = nd;
}

/* 星期聚焦条（仅手机端显示）：全周 / 一 / 二 / ... / 日 */
function renderDayTabs() {
  const box = $("daytabs");
  box.innerHTML = "";
  const t = dayIndexOfToday();
  const all = el("button", "day-chip" + (viewDay === 0 ? " active" : ""));
  all.textContent = "全周";
  all.addEventListener("click", () => { viewDay = 0; render(); });
  box.appendChild(all);
  for (let d = 1; d <= 7; d++) {
    const b = el("button", "day-chip" + (viewDay === d ? " active" : ""));
    b.appendChild(el("span", "", DAY_NAMES[d - 1].slice(1)));
    if (d === t && viewDay !== d) b.appendChild(el("span", "dot"));
    b.addEventListener("click", () => { viewDay = d; render(); });
    box.appendChild(b);
  }
}

function renderGrid() {
  const grid = $("grid");
  const allCourses = state.codes.map(c => courseMap[c]).filter(Boolean);
  /* 本周视图: 仅保留命中该周次的时段 */
  const courses = viewWeek == null ? allCourses
    : allCourses
      .map(c => ({ ...c, sessions: (c.sessions || []).filter(s => inWeekSet(s.weekSet, viewWeek)) }))
      .filter(c => c.sessions.length);

  /* 单日视图: 模块化 上午/下午/晚上 三卡片 */
  if (viewDay) { renderDayView(courses); return; }

  /* 完整日期（周一..周日，供单日级微调查找；全部周次模式无日期 → 只用学期级） */
  let fullDates = null;
  if (viewWeek != null) {
    fullDates = [];
    for (let i = 0; i < 7; i++) {
      const d = weekMonday(viewWeek); d.setDate(d.getDate() + i);
      fullDates.push(dateStrOf(d));
    }
  }
  const slotDate = (s) => (fullDates ? fullDates[s.day - 1] : null);
  /* 冲突按「调整后」的时段计算（时间微调后不再误报） */
  const conflicts = findConflicts(courses.map(c => ({ ...c, sessions: c.sessions.map(s => Object.assign({}, s, effSlot(c.code, s, slotDate(s)))) })));
  /* 冲突时段映射: "day-p1-p2" -> true */
  const conflictSess = new Set();
  for (const cf of conflicts) for (const p of cf.pairs) {
    conflictSess.add(`${p.sa.day}-${p.sa.p1}-${p.sa.p2}`);
    conflictSess.add(`${p.sb.day}-${p.sb.p1}-${p.sb.p2}`);
  }

  const today = dayIndexOfToday();
  const showToday = viewWeek == null || viewWeek === curWeek();
  /* 本周视图下表头附带日期 */
  let weekDates = null;
  if (viewWeek != null) {
    weekDates = [];
    for (let i = 0; i < 7; i++) {
      const d = weekMonday(viewWeek); d.setDate(d.getDate() + i);
      weekDates.push((d.getMonth() + 1) + "/" + d.getDate());
    }
  }

  /* 计算每节课的放置：起点(row,col) + 跨节 span；同格冲突则叠加 */
  const maxP = Math.max.apply(null, Object.keys(PERIOD_TIMES).map(Number));
  const starts = {};   // "row-col" -> [{course, session, span}]
  const placed = new Set();
  for (const c of courses) {
    for (const s of c.sessions) {
      const es = effSlot(c.code, s, slotDate(s));
      if (!(es.day >= 1 && es.day <= 7 && es.p1 >= 1 && es.p2 >= es.p1 && es.p2 <= maxP)) continue;
      const key = `${c.code}|${s.day}|${s.p1}|${s.p2}|${es.day}|${es.p1}|${es.p2}|${s.weeks}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const span = es.p2 - es.p1 + 1;
      const sk = `${es.p1}-${es.day}`;
      (starts[sk] = starts[sk] || []).push({ course: c, session: es, orig: s, span });
    }
  }
  /* 列内防重叠：同一列后开始的块截断前面块的跨行数，避免表格错位 */
  const colStarts = {};
  for (const sk of Object.keys(starts)) {
    const [p, d] = sk.split("-").map(Number);
    (colStarts[d] = colStarts[d] || []).push({ p, items: starts[sk] });
  }
  for (const d of Object.keys(colStarts)) {
    const arr = colStarts[d].sort((a, b) => a.p - b.p);
    for (let i = 0; i < arr.length; i++) {
      const end = i + 1 < arr.length ? arr[i + 1].p : maxP + 1;
      const span = Math.max(1, Math.min(arr[i].items[0].span, end - arr[i].p));
      for (const it of arr[i].items) it.span = span;
    }
  }
  const covered = {};  // "row-col" -> true (被 rowspan 覆盖)
  for (const sk of Object.keys(starts)) {
    const d = sk.split("-")[1];
    for (const it of starts[sk]) {
      for (let r = it.session.p1; r < it.session.p1 + it.span; r++) covered[r + "-" + d] = true;
    }
  }

  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", "time-col", ""));
  for (let d = 1; d <= 7; d++) {
    const th = el("th", showToday && d === today ? "today" : "");
    th.appendChild(el("span", "th-day", DAY_NAMES[d - 1]));
    if (weekDates) th.appendChild(el("span", "th-date", weekDates[d - 1]));
    if (showToday && d === today) th.appendChild(el("span", "th-today", "今日"));
    hr.appendChild(th);
  }
  thead.appendChild(hr);

  const tbody = el("tbody");
  for (let p = 1; p <= maxP; p++) {
    const tr = el("tr");
    const tc = el("td", "time-col");
    tc.appendChild(el("div", "tp-num", String(p)));
    tc.appendChild(el("div", "tp-time", (PERIOD_TIMES[p] || "").split("-").join("–")));
    tr.appendChild(tc);
    for (let d = 1; d <= 7; d++) {
      const sk = `${p}-${d}`;
      if (covered[sk] && !starts[sk]) continue; // 由跨节行占位
      const td = el("td", "day-cell" + (showToday && d === today ? " today-col" : ""));
      const list = starts[sk];
      if (list && list.length) {
        td.rowSpan = list[0].span;
        for (const gc of list) {
          const block = buildCourseBlock(gc.course, gc.session, conflictSess, viewWeek != null, weekDates ? weekDates[d - 1] : null, gc.orig);
          block.addEventListener("click", () => openDrawer(gc.course.code));
          td.appendChild(block);
        }
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  grid.innerHTML = "";
  grid.classList.remove("hidden");
  const dv = $("dayview");
  if (dv) dv.classList.add("hidden");
  grid.appendChild(thead);
  grid.appendChild(tbody);

  /* 空周提示 */
  const empty = $("gridEmpty");
  if (empty) {
    const weekEmpty = viewWeek != null && courses.length === 0 && allCourses.length > 0;
    if (weekEmpty) empty.innerHTML = "本周没有安排课程<br><span>点上方「全部周次」可查看整学期课表</span>";
    empty.classList.toggle("hidden", !weekEmpty);
  }
}

/* 单日模块化视图：☀️上午(1-4节) / 🌤下午(5-9节) / 🌙晚上(10-13节)，空段出彩蛋 */
const DAY_SECTIONS = [
  { id: "am", icon: "☀️", label: "上午", from: 1, to: 4, time: "8:30 – 12:00" },
  { id: "pm", icon: "🌤", label: "下午", from: 5, to: 9, time: "13:30 – 17:50" },
  { id: "eve", icon: "🌙", label: "晚上", from: 10, to: 13, time: "18:30 – 21:50" }
];
function activeSections() {
  return (SCHOOL_SECTIONS && SCHOOL_SECTIONS.length) ? SCHOOL_SECTIONS : DAY_SECTIONS;
}
const DAY_EGGS = {
  am: [
    "上午没课，睡到自然醒 😴",
    "上午的空白，是赖床的许可 🛏️",
    "上午没课，去吃顿不慌不忙的早餐 🥣",
    "上午空档：背 20 个单词再玩 📖",
    "上午自由，把上周欠的觉还了 💤",
    "阳光很好，去图书馆占个窗边位 ☀️",
    "上午没课还自然醒了？你已经赢麻了 🏆"
  ],
  pm: [
    "下午没课，球场 / 图书馆 / 被窝三选一 🏸",
    "下午自由支配，来杯咖啡 ☕",
    "下午没课，去校园里走走 🍃",
    "下午空档，适合把实验报告先写了 📝",
    "下午没课，给家里打个电话 📞",
    "阳光正好，去操场晒晒太阳 🌤",
    "下午自由，健身卡别浪费了 🏋️"
  ],
  eve: [
    "晚上没安排，追剧还是自习？📺",
    "晚风正好，去操场跑两圈 🏃",
    "晚上没课，早点睡 🌌",
    "晚上自由，和朋友约顿晚饭 🍜",
    "晚自习氛围拉满，去教学楼蹭个座 📚",
    "晚上没课，把明天的自己照顾好 🌙",
    "夜里亮着灯的图书馆，要不要去坐坐？💡"
  ]
};
const DAY_FREE_EGGS = [
  "🎉 今天全天没课！来一场说走就走的……自习",
  "全天无课！这是本周最好的礼物 🎁",
  "今天零节课，快乐完全属于自己 🍰",
  "全天空课，把想做的事排个队吧 📋",
  "神仙空课日：实验室 / 球场 / 短途旅行 任选 🎢"
];
const EGG_SEC_END = { am: 12, pm: 18, eve: 22 };
function shortEggName(n) { n = String(n || ""); return n.length > 9 ? n.slice(0, 9) + "…" : n; }

/* 上下文：日期差/当前小时/星期/当天节数/明天第一节 → 让彩蛋"认识"你的课表 */
function buildEggCtx(viewWeek, viewDay, blocks, courses) {
  const ctx = {
    dd: null,
    hour: new Date().getHours(),
    wd: viewDay % 7,
    count: blocks.reduce((n, b) => n + (b.p2 - b.p1 + 1), 0),
    tmrFirst: null
  };
  if (viewWeek != null) {
    const d0 = weekMonday(viewWeek);
    d0.setDate(d0.getDate() + viewDay - 1);
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    ctx.dd = Math.round((d0 - t0) / 86400000);
  }
  if (viewDay < 7) {
    const list = [];
    for (const c of courses) {
      for (const s of (c.sessions || [])) {
        if (s.day !== viewDay + 1) continue;
        if (!(s.p1 >= 1 && s.p2 >= s.p1)) continue;
        list.push({ p1: s.p1, name: c.name });
      }
    }
    list.sort((a, b) => a.p1 - b.p1);
    ctx.tmrFirst = list[0] || null;
  }
  return ctx;
}

/* 动态彩蛋：按上下文现做，与静态池混合抽取 */
function dynamicEggs(secId, ctx, blocks) {
  const out = [];
  const isToday = ctx.dd === 0, weekend = ctx.wd === 0 || ctx.wd === 6;
  const hasAm = blocks.some(b => b.p1 <= 4);
  const hasPm = blocks.some(b => b.p1 >= 5 && b.p1 <= 9);
  if (secId === "am") {
    if (hasPm) out.push("课都排在下午，上午睡到自然醒 😴", "上午的空白，是给下午充电的 🛏️");
    if (weekend) out.push("周末上午没课，快乐自己安排 🎮");
    if (ctx.wd === 1) out.push("周一上午没课，运气不错 🍀");
    if (isToday && ctx.hour >= EGG_SEC_END.am && ctx.hour < EGG_SEC_END.pm) out.push("上午已收官，专注眼前 ✅");
    if (isToday && ctx.hour < 8) out.push("趁早八没来，再睡一会儿 😴");
    if (ctx.dd > 0) out.push("这一天空档，提前规划点什么？📅");
  } else if (secId === "pm") {
    if (hasAm) out.push("课都挤在上午了，下午彻底自由 🎉", "上午满课，下午就当奖励自己 🍦");
    if (weekend) out.push("周末下午，球场 / 图书馆 / 被窝三选一 🏸");
    if (ctx.wd === 5) out.push("周五下午没课，提前进入周末模式 🎉");
    if (isToday && ctx.hour >= EGG_SEC_END.pm && ctx.hour < EGG_SEC_END.eve) out.push("下午已收官，晚上见 ✅");
    if (ctx.dd > 0) out.push("下午留白，提前安排点什么？📅");
  } else if (secId === "eve") {
    if (isToday && ctx.hour >= EGG_SEC_END.eve) out.push("今天 " + ctx.count + " 节课都上完了，晚上是自己的 🍰");
    if (isToday && ctx.hour >= 23) out.push("这个点了？把精力存给明天 🌙");
    if (ctx.tmrFirst) out.push("明天第一节是《" + shortEggName(ctx.tmrFirst.name) + "》，今晚别浪太晚 🌙");
    if (ctx.tmrFirst && ctx.tmrFirst.p1 === 1) out.push("明天有早八，晚饭后就把手机放远点 📵");
    if (ctx.wd === 0) out.push("周日晚，给新一周充个电 🔋");
    if (ctx.wd === 5) out.push("周五晚上，一周最后的狂欢 🎉");
    if (ctx.dd > 0) out.push("晚上留白，提前安排点什么？📅");
  } else if (secId === "free") {
    if (weekend) out.push("周末全天没课？这是双倍的快乐 🎉");
    if (ctx.wd === 5) out.push("周五全天无课，提前过节 🎉");
    if (ctx.tmrFirst) out.push("明天《" + shortEggName(ctx.tmrFirst.name) + "》见，今天好好逍遥 🍃");
    if (ctx.dd > 0) out.push("空的一天，留给自己喜欢的事 📋");
  }
  return out;
}

function pickEgg(secId, ctx, blocks) {
  const base = secId === "free"
    ? DAY_FREE_EGGS.slice()
    : (DAY_EGGS[secId] ? DAY_EGGS[secId].slice() : ["这段时间没课，自由安排 🌈", "空档期，适合发呆或冲刺 ✨"]);
  const pool = base.concat(dynamicEggs(secId, ctx, blocks || []));
  const key = "kebiao:egg:" + secId;
  let last = null;
  try { last = localStorage.getItem(key); } catch (e) {}
  let pick = pool[Math.floor(Math.random() * pool.length)];
  for (let i = 0; i < 3 && pick === last && pool.length > 1; i++) {
    pick = pool[Math.floor(Math.random() * pool.length)];
  }
  try { localStorage.setItem(key, pick); } catch (e) {}
  return pick;
}

/* 天气码 → 一句话短语（摘要条用） */
function wmoShort(code) {
  if (code === 0) return "晴";
  if (code === 1 || code === 2) return "多云";
  if (code === 3) return "阴";
  if (code === 45 || code === 48) return "雾";
  if (code >= 51 && code <= 57) return "毛毛雨";
  if (code >= 61 && code <= 67) return "雨";
  if (code >= 71 && code <= 77) return "雪";
  if (code >= 80 && code <= 82) return "阵雨";
  if (code === 85 || code === 86) return "阵雪";
  if (code >= 95) return "雷雨";
  return "变天";
}

/* ---------------- 逐小时天气（Open-Meteo, 免密钥; 按当天课程所在校区取坐标） ---------------- */
const WX_CACHE_KEY = "kebiao:wx:v1";
let wxMem = null;

function wmoIcon(code) {
  if (code === 0) return "☀️";
  if (code === 1) return "🌤";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫";
  if (code >= 51 && code <= 57) return "🌦";
  if (code >= 61 && code <= 67) return "🌧";
  if (code >= 71 && code <= 77) return "🌨";
  if (code >= 80 && code <= 82) return "🌦";
  if (code === 85 || code === 86) return "🌨";
  return "⛈";
}

function weatherCampus() {
  const counts = {};
  for (const code of state.codes) {
    const c = courseMap[code];
    if (c && c.campus) counts[c.campus] = (counts[c.campus] || 0) + 1;
  }
  let best = null, n = -1;
  for (const k of Object.keys(counts)) if (counts[k] > n) { best = k; n = counts[k]; }
  return best;
}

function weatherCoords() {
  const geo = (SCHOOL && SCHOOL.campusGeo) || {};
  const prefer = weatherCampus();
  if (prefer && geo[prefer]) return [geo[prefer].lat, geo[prefer].lon];
  const keys = Object.keys(geo);
  return keys.length ? [geo[keys[0]].lat, geo[keys[0]].lon] : null;
}

async function getWeather(lat, lon) {
  const now = Date.now();
  let cache = wxMem;
  if (!cache) { try { cache = JSON.parse(localStorage.getItem(WX_CACHE_KEY)); } catch (e) {} }
  const match = cache && cache.lat === lat && cache.lon === lon && cache.data;
  if (match && now - cache.ts < 30 * 60 * 1000) return cache.data; // 30 分钟内直接用
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
      "&hourly=temperature_2m,weather_code,precipitation_probability&timezone=auto&forecast_days=7";
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    wxMem = cache = { lat, lon, ts: now, data };
    try { localStorage.setItem(WX_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
    return data;
  } catch (e) {
    if (match && now - cache.ts < 6 * 3600 * 1000) return cache.data; // 离线/接口故障: 6h 内缓存兜底
    throw e;
  }
}

/* 构建天气卡片（含异步填充）; 不在预报范围/无坐标时返回 null */
function buildWeatherCard() {
  const coords = weatherCoords();
  if (!coords) return null;
  const wk = viewWeek == null ? curWeek() : viewWeek; // 全部周次视图按本周取天气
  const wxDate = new Date(weekMonday(wk));
  wxDate.setDate(wxDate.getDate() + viewDay - 1);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const dd = Math.round((wxDate - today0) / 86400000);
  if (dd < 0 || dd > 6) return null;

  /* 默认收起为单行摘要（课程优先），点击展开逐小时；偏好记忆 */
  let open = false;
  try { open = localStorage.getItem("kebiao:wxopen") === "1"; } catch (e) {}
  const card = el("div", "day-sec day-wx" + (open ? "" : " closed"));
  const head = el("div", "day-sec-head");
  head.appendChild(el("span", "day-sec-icon", "🌤"));
  const tt = el("div", "day-sec-title");
  tt.appendChild(el("span", "", dd === 0 ? "今日天气" : "当日天气"));
  const cc = weatherCampus();
  tt.appendChild(el("span", "day-sec-time", "逐小时" + (cc && CAMPUS_NAME[cc] ? " · " + CAMPUS_NAME[cc] : "")));
  head.appendChild(tt);
  card.appendChild(head);
  const mini = el("div", "wx-mini");
  mini.appendChild(el("span", "wxm-i", "🌤"));
  mini.appendChild(el("span", "wxm-t", "天气加载中…"));
  const mx = el("span", "wxm-x", open ? "收起 ▴" : "展开 ▾");
  mini.appendChild(mx);
  /* 展开态：摘要条隐藏，「收起」挪到标题行右侧 */
  const hx = el("span", "wx-head-x", open ? "收起 ▴" : "展开 ▾");
  head.appendChild(hx);
  const toggleWx = () => {
    const nowClosed = card.classList.toggle("closed");
    const label = nowClosed ? "展开 ▾" : "收起 ▴";
    mx.textContent = label;
    hx.textContent = label;
    try { localStorage.setItem("kebiao:wxopen", nowClosed ? "0" : "1"); } catch (e) {}
  };
  mini.addEventListener("click", toggleWx);
  hx.addEventListener("click", toggleWx);
  card.appendChild(mini);
  const strip = el("div", "wx-strip");
  strip.appendChild(el("div", "wx-none", "天气加载中…"));
  card.appendChild(strip);
  fillWeatherCard(strip, mini, card, wxDate, dd);
  return card;
}

async function fillWeatherCard(strip, mini, card, date, dd) {
  const coords = weatherCoords();
  if (!coords) { strip.innerHTML = ""; strip.appendChild(el("div", "wx-none", "暂无天气数据")); return; }
  try {
    const data = await getWeather(coords[0], coords[1]);
    if (!strip.isConnected) return; // 用户已切走视图
    const H = data.hourly;
    const ds = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    const nowH = new Date().getHours();
    const items = [];
    for (let i = 0; i < H.time.length; i++) {
      if (!H.time[i].startsWith(ds)) continue;
      const hh = Number(H.time[i].slice(11, 13));
      if (dd === 0 && hh < nowH) continue; // 今天只显示未过去的时段
      items.push({ hh, code: H.weather_code[i], temp: Math.round(H.temperature_2m[i]), pop: H.precipitation_probability ? H.precipitation_probability[i] : null });
    }
    /* 摘要条：当前温度 + 第一处显著变化 */
    mini.innerHTML = "";
    if (items.length) {
      const now = items[0];
      mini.appendChild(el("span", "wxm-i", wmoIcon(now.code)));
      mini.appendChild(el("span", "wxm-t", now.temp + "°"));
      let chg = "全天天气稳定";
      for (const it of items.slice(1)) {
        if (it.code !== now.code) { chg = it.hh + "时起" + wmoShort(it.code) + "（→" + it.temp + "°）"; break; }
      }
      mini.appendChild(el("span", "wxm-chg", chg));
      mini.appendChild(el("span", "wxm-x", card.classList.contains("closed") ? "展开 ▾" : "收起 ▴"));
    } else {
      mini.appendChild(el("span", "wxm-i", "🌤"));
      mini.appendChild(el("span", "wxm-t", "暂无预报"));
    }
    strip.innerHTML = "";
    let centerEl = null;
    for (const it of items) {
      const isNow = it.hh === nowH; // 任意天都标出当前小时
      const item = el("div", "wx-h" + (isNow ? " wx-now" : ""));
      item.appendChild(el("span", "wx-t", isNow && dd === 0 ? "现在" : it.hh + "时"));
      item.appendChild(el("span", "wx-i", wmoIcon(it.code)));
      item.appendChild(el("span", "wx-d", it.temp + "°"));
      item.appendChild(el("span", "wx-p", it.pop != null && it.pop >= 20 ? "💧" + it.pop + "%" : ""));
      strip.appendChild(item);
      if (isNow) centerEl = item;                    // 当前小时始终居中
      else if (!centerEl && dd > 0 && it.hh === 12) centerEl = item; // 兜底: 未来日中午
    }
    if (!strip.children.length) {
      strip.appendChild(el("div", "wx-none", "暂无预报"));
    } else if (centerEl && !card.classList.contains("closed")) {
      /* 双 rAF 确保布局就绪后再居中; scrollIntoView 失败退回手动计算 */
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try {
          centerEl.scrollIntoView({ inline: "center", block: "nearest" });
        } catch (e) {
          strip.scrollLeft = Math.max(0, centerEl.offsetLeft - (strip.clientWidth - centerEl.offsetWidth) / 2);
        }
        /* scrollIntoView 兜底校准（个别内核 block/inline 行为不一致） */
        const want = centerEl.offsetLeft - (strip.clientWidth - centerEl.offsetWidth) / 2;
        if (Math.abs(strip.scrollLeft - Math.max(0, want)) > 24) {
          strip.scrollLeft = Math.max(0, want);
        }
      }));
    }
  } catch (e) {
    if (!strip.isConnected) return;
    strip.innerHTML = "";
    strip.appendChild(el("div", "wx-none", "天气暂不可用"));
  }
}

function renderDayView(courses) {
  const grid = $("grid");
  grid.classList.add("hidden");
  grid.innerHTML = "";
  /* 本视图周的周一（全部周次模式为 null → 只应用学期级调整） */
  const wkMon = viewWeek != null ? weekMonday(viewWeek) : null;
  let host = $("dayview");
  if (!host) {
    host = el("div");
    host.id = "dayview";
    host.className = "dayview";
    $("gridwrap").appendChild(host);
  }
  host.classList.remove("hidden");
  host.innerHTML = "";

  const day = viewDay;
  const maxP = Math.max.apply(null, Object.keys(PERIOD_TIMES).map(Number));
  const placed = new Set();
  const sess = [];
  for (const c of courses) {
    for (const s of (c.sessions || [])) {
      /* 该时段在本视图周的"自然日期"（单日级微调按这个日期查找） */
      let sDate = null;
      if (wkMon) { const d = new Date(wkMon); d.setDate(d.getDate() + s.day - 1); sDate = dateStrOf(d); }
      const es = effSlot(c.code, s, sDate);
      if (es.day !== day) continue;
      if (!(es.p1 >= 1 && es.p2 >= es.p1 && es.p2 <= maxP)) continue;
      const key = c.code + "|" + s.day + "|" + s.p1 + "|" + s.p2 + "|" + es.p1 + "|" + es.p2 + "|" + s.weeks;
      if (placed.has(key)) continue;
      placed.add(key);
      sess.push({ course: c, p1: es.p1, p2: es.p2, room: effRoom(c, s, sDate), teacher: effTeacher(c, s, sDate), tw: !!effTweak(c.code, s, sDate) });
    }
  }
  sess.sort((a, b) => a.p1 - b.p1 || a.p2 - b.p2);

  /* 合并相邻同课程同时段块（如 1-2 节连排） */
  const blocks = [];
  for (const s of sess) {
    const last = blocks[blocks.length - 1];
    if (last && last.course.code === s.course.code && last.room === s.room && last.p2 + 1 === s.p1) {
      last.p2 = s.p2;
    } else {
      blocks.push({ course: s.course, p1: s.p1, p2: s.p2, room: s.room });
    }
  }

  /* 天气卡片置顶（当天且在预报范围内才出现，空课日也显示） */
  const wxCard = buildWeatherCard();
  if (wxCard) host.appendChild(wxCard);

  /* 彩蛋上下文：日期/时段/星期/节数/明天第一节 */
  const eggCtx = buildEggCtx(viewWeek, viewDay, blocks, courses);

  /* 全天空课: 大彩蛋 */
  if (!blocks.length) {
    const card = el("div", "day-sec");
    card.appendChild(el("div", "day-free", pickEgg("free", eggCtx, blocks)));
    host.appendChild(card);
    return;
  }

  for (const sec of activeSections()) {
    const list = blocks.filter(b => b.p1 >= sec.from && b.p1 <= sec.to);
    const card = el("div", "day-sec");
    const head = el("div", "day-sec-head");
    head.appendChild(el("span", "day-sec-icon", sec.icon));
    const tt = el("div", "day-sec-title");
    tt.appendChild(el("span", "", sec.label));
    tt.appendChild(el("span", "day-sec-time", sec.time));
    head.appendChild(tt);
    card.appendChild(head);
    if (!list.length) {
      card.appendChild(el("div", "day-empty", pickEgg(sec.id, eggCtx, blocks)));
    } else {
      for (const b of list) {
        const blk = el("div", "day-block " + attrClass(b.course.attr));
        blk.appendChild(el("div", "cc-name", b.course.name));
        const t1 = (PERIOD_TIMES[b.p1] || "").split("-")[0];
        const t2 = (PERIOD_TIMES[b.p2] || "").split("-")[1];
        blk.appendChild(el("div", "db-time", "第" + b.p1 + (b.p2 > b.p1 ? "-" + b.p2 : "") + "节 · " + t1 + " – " + t2));
        const meta = [b.teacher, b.room].filter(Boolean).join(" · ") + (b.tw ? " ✎" : "");
        if (meta) blk.appendChild(el("div", "cc-meta", meta));
        blk.addEventListener("click", () => openDrawer(b.course.code));
        card.appendChild(blk);
      }
    }
    host.appendChild(card);
  }
}

/* 课程块：课程名 / 教师·教室 / 周次（对齐 Excel 版）；周视图下不重复显示周次 */
function buildCourseBlock(course, session, conflictSess, weekView, dateStr, orig) {
  orig = orig || session; /* 微调查找键用原始时段，day/p1/p2 用生效时段 */
  const isConflict = conflictSess.has(`${session.day}-${session.p1}-${session.p2}`);
  const block = el("div", "course-cell " + attrClass(course.attr) + (isConflict ? " conflict" : ""));
  block.appendChild(el("div", "cc-name", course.name));
  const tw = effTweak(course.code, orig, dateStr);
  const meta = [];
  const teacher = effTeacher(course, orig, dateStr);
  const room = effRoom(course, orig, dateStr);
  if (teacher) meta.push(teacher);
  if (room) meta.push(room);
  if (meta.length) block.appendChild(el("div", "cc-meta", meta.join(" · ") + (tw ? " ✎" : "")));
  if (!weekView) block.appendChild(el("div", "cc-weeks", session.weeks));
  if (isConflict) block.appendChild(el("span", "cc-conflict-tag", "冲突"));
  return block;
}

/* ---------------- 搜索 ---------------- */
function bindSearch(inputEl, sugEl, onPick) {
  let timer = null;
  let lastHits = [];
  const pick = (c) => {
    sugEl.innerHTML = "";
    inputEl.value = "";
    lastHits = [];
    addCodes([c.code]);
    if (onPick) onPick();
  };
  const search = () => {
    const q = inputEl.value.trim();
    if (!q) { sugEl.innerHTML = ""; lastHits = []; return; }
    const ql = q.toLowerCase();
    const hits = [];
    for (const c of catalog.courses) {
      if (c.name.toLowerCase().includes(ql) || c.code.toLowerCase().includes(ql)) {
        hits.push(c);
        if (hits.length >= 12) break;
      }
    }
    lastHits = hits;
    sugEl.innerHTML = "";
    if (!hits.length) {
      const d = el("div", "sug-item", "未找到，试试课程代码？");
      sugEl.appendChild(d);
      return;
    }
    for (const c of hits) {
      const item = el("div", "sug-item");
      const name = el("div", "sug-name", c.name);
      name.appendChild(el("span", "campus campus-" + c.campus, CAMPUS_NAME[c.campus] || c.campus));
      name.appendChild(el("span", "sug-code", c.code));
      const meta = el("div", "sug-meta");
      const first = c.sessions[0];
      meta.textContent = `${c.credit != null ? c.credit + "分" : ""} ${c.teacher || ""}${first ? " · " + fmtSession(effSlot(c.code, first, null)) : " · 时间待定"}`;
      item.appendChild(name);
      item.appendChild(meta);
      item.addEventListener("click", () => pick(c));
      sugEl.appendChild(item);
    }
  };
  inputEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, 150);
  });
  /* 回车 = 选中第一个建议 */
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && lastHits.length) { e.preventDefault(); pick(lastHits[0]); }
  });
  document.addEventListener("click", (e) => {
    if (!sugEl.contains(e.target) && e.target !== inputEl) sugEl.innerHTML = "";
  });
}

/* ---------------- 上课提醒：导出系统日历（.ics，含提前提醒） ----------------
   浏览器无法直接写系统闹钟；改走系统日历通道：
   生成 .ics → 系统日历打开 → 课次全部写入系统日历并自带提醒，由系统按日程提醒。 */
function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function icsStamp() {
  const d = new Date();
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + "T" +
    pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + "Z";
}
function icsPeriodTime(p, end) {
  const s = PERIOD_TIMES[p] || "";
  if (!s) return null;
  const seg = s.split("-")[end ? 1 : 0];
  return seg || null;
}
function icsDateFor(week, day) {
  const d = parseYMD(SEMESTER_MONDAY);
  d.setDate(d.getDate() + (week - 1) * 7 + (day - 1));
  return d;
}
function icsDT(y, m, d, hm) {
  const a = String(hm).split(":");
  return "" + y + pad2(m) + pad2(d) + "T" + pad2(+a[0]) + pad2(+a[1]) + "00";
}
function escICS(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
/* 按周展开成独立 VEVENT（兼容任意不连续周次）；教室/时间尊重用户微调（单日 > 学期 > 默认） */
function buildICS(courses, warnMin) {
  const stamp = icsStamp();
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kebiao//courseshell//CN",
    "CALSCALE:GREGORIAN", "X-WR-TIMEZONE:Asia/Shanghai"];
  let n = 0;
  for (const c of courses) {
    if (!c) continue;
    const seen = new Set();
    for (const s of (c.sessions || [])) {
      const k = sessKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      for (const iv of (s.weekSet || [])) {
        for (let w = iv[0]; w <= iv[1]; w++) {
          if (w < 1 || (MAX_WEEK && w > MAX_WEEK)) continue;
          const d = icsDateFor(w, s.day);
          const ds = dateStrOf(d);
          const es = effSlot(c.code, s, ds);
          const room = effRoom(c, s, ds);
          const t1 = icsPeriodTime(es.p1, false), t2 = icsPeriodTime(es.p2, true);
          if (!t1 || !t2) continue;
          L.push("BEGIN:VEVENT");
          L.push("UID:" + c.code + "-" + w + "-" + es.day + "-" + es.p1 + "@courseshell.cloud");
          L.push("DTSTAMP:" + stamp);
          L.push("DTSTART:" + icsDT(d.getFullYear(), d.getMonth() + 1, d.getDate(), t1));
          L.push("DTEND:" + icsDT(d.getFullYear(), d.getMonth() + 1, d.getDate(), t2));
          L.push("SUMMARY:" + escICS(c.name));
          if (room) L.push("LOCATION:" + escICS(room));
          L.push("DESCRIPTION:" + escICS("教师：" + (c.teacher || "未定") + " · 课程编码：" + c.code));
          L.push("BEGIN:VALARM");
          L.push("TRIGGER:-PT" + warnMin + "M");
          L.push("ACTION:DISPLAY");
          L.push("DESCRIPTION:" + escICS(warnMin + " 分钟后上课：" + c.name));
          L.push("END:VALARM");
          L.push("END:VEVENT");
          n++;
        }
      }
    }
  }
  L.push("END:VCALENDAR");
  return { text: L.join("\r\n"), events: n };
}
function downloadICS(courses, warnMin, filename) {
  const r = buildICS(courses, warnMin);
  if (!r.events) { toast("没有可导出的上课时段"); return; }
  const blob = new Blob([r.text], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  toast(`已生成 ${r.events} 条提醒事件，用系统日历打开即可`);
}
function showAlarmModal(code) {
  const c = courseMap[code];
  if (!c) return;
  let scope = "term"; /* term=全学期 | next=仅下一节 */
  let lead = 10;
  const card = el("div", "modal-card");
  card.appendChild(el("h3", "", "🔔 上课提醒（系统日历）"));
  card.appendChild(el("p", "share-hint", "生成 .ics → 用系统「日历」打开 → 课次连同提醒一次性写入日历，之后由系统按时提醒，iOS/安卓/电脑通用。"));
  card.appendChild(el("p", "al-sec", "提醒范围"));
  const scopeRow = el("div", "alarm-row");
  const bNext = el("button", "r-btn ghost al-chip", "⏭ 仅下一节");
  const bTerm = el("button", "r-btn ghost al-chip", "📅 全学期");
  bNext.addEventListener("click", () => { scope = "next"; paint(); });
  bTerm.addEventListener("click", () => { scope = "term"; paint(); });
  scopeRow.appendChild(bNext);
  scopeRow.appendChild(bTerm);
  card.appendChild(scopeRow);
  card.appendChild(el("p", "al-sec", "提前多久提醒"));
  const leadRow = el("div", "alarm-row");
  for (const m of [5, 10, 15, 30]) {
    const b = el("button", "r-btn ghost al-chip", m + " 分钟前");
    b.dataset.lead = m;
    b.addEventListener("click", () => { lead = m; paint(); });
    leadRow.appendChild(b);
  }
  card.appendChild(leadRow);
  function paint() {
    bNext.classList.toggle("active", scope === "next");
    bTerm.classList.toggle("active", scope === "term");
    leadRow.querySelectorAll(".al-chip").forEach(b => b.classList.toggle("active", Number(b.dataset.lead) === lead));
  }
  paint();
  const go = el("button", "r-btn", "🔔 生成日历提醒");
  go.addEventListener("click", () => {
    hideModal();
    if (scope === "next") {
      const nx = findNextClass([c], new Date());
      if (!nx) { toast("该课未来 7 天没有课次，可改用「全学期」"); return; }
      const w = getSemesterWeek(nx.date);
      /* 只保留命中那一周：buildICS 会按时段+微调展开该周这一次课 */
      const one = Object.assign({}, c, {
        sessions: [Object.assign({}, nx.session, { weekSet: [[w, w]], weeks: "第" + w + "周" })]
      });
      downloadICS([one], lead, "课壳提醒-下一节-" + c.name + ".ics");
    } else {
      downloadICS([c], lead, "课壳提醒-" + c.name + ".ics");
    }
  });
  card.appendChild(go);
  const all = el("button", "r-btn ghost", "📋 导出课表全部课程（提前 10 分钟）");
  all.addEventListener("click", () => {
    hideModal();
    downloadICS(state.codes.map(x => courseMap[x]).filter(Boolean), 10, "课壳提醒-全部课程.ics");
  });
  card.appendChild(all);
  const close = el("button", "r-btn ghost", "取消");
  close.addEventListener("click", hideModal);
  card.appendChild(close);
  showModal(card);
}

/* ---------------- 课程详情抽屉 ---------------- */
let drawerCourse = null;
let drawerTab = "notes";
let noteEditing = null, hwEditing = null, examEditing = null;

function openDrawer(code) {
  drawerCourse = courseMap[code];
  if (!drawerCourse) return;
  drawerTab = "notes";
  noteEditing = hwEditing = examEditing = null;
  $("overlay").classList.remove("hidden");
  $("drawer").classList.remove("hidden");
  renderDrawer();
}
function closeDrawer() {
  $("drawer").classList.add("hidden");
  $("overlay").classList.add("hidden");
  drawerCourse = null;
}

function renderDrawer() {
  const c = drawerCourse;
  if (!c) return;
  const d = $("drawer");
  d.innerHTML = "";
  d.appendChild(el("div", "drawer-grip"));

  const head = el("div", "dr-head");
  const titleBox = el("div");
  titleBox.appendChild(el("h2", "dr-title", c.name));
  const sub = el("div", "dr-sub", c.code);
  sub.appendChild(el("span", "campus campus-" + c.campus, CAMPUS_NAME[c.campus] || c.campus));
  titleBox.appendChild(sub);
  const close = el("button", "dr-close", "✕");
  close.addEventListener("click", closeDrawer);
  head.appendChild(titleBox);
  head.appendChild(close);
  d.appendChild(head);

  const info = el("div", "dr-info");
  info.appendChild(kv("教师", c.teacher || "—"));
  info.appendChild(kv("院系", c.dept || "—"));
  info.appendChild(kv("学分", c.credit != null ? c.credit + " 分" : "—"));
  info.appendChild(kv("学时", c.hours != null ? c.hours + " 学时" : "—"));
  info.appendChild(kv("考核", c.exam || "—"));
  info.appendChild(kv("属性", c.attr || "—"));
  d.appendChild(info);

  if (c.sessions.length) {
    const ss = el("div", "dr-sessions");
    ss.appendChild(el("div", "", "上课时间："));
    for (const s of c.sessions) {
      const es = effSlot(c.code, s, null);
      const room = effRoom(c, s, null);
      ss.appendChild(el("div", "s", `${DAY_NAMES[es.day - 1]} 第${es.p1}${es.p2 > es.p1 ? "-" + es.p2 : ""}节 · ${s.weeks}${room ? " · " + room : ""}`));
    }
    d.appendChild(ss);
  } else {
    d.appendChild(el("div", "empty-tip", "该课程暂无排课信息"));
  }

  const tabs = el("div", "tabs");
  for (const [k, label] of [["notes", "笔记"], ["homework", "作业"], ["exams", "考试"]]) {
    const t = el("div", "tab" + (drawerTab === k ? " active" : ""), label);
    t.addEventListener("click", () => { drawerTab = k; renderDrawer(); });
    tabs.appendChild(t);
  }
  d.appendChild(tabs);

  const body = el("div");
  if (drawerTab === "notes") body.appendChild(notesView());
  if (drawerTab === "homework") body.appendChild(homeworkView());
  if (drawerTab === "exams") body.appendChild(examsView());
  d.appendChild(body);

  /* 底部操作区：三等分主操作 + 通栏危险操作 */
  const actions = el("div", "dr-actions");
  const alarmBtn = el("button", "r-btn", "🔔 上课提醒");
  alarmBtn.addEventListener("click", () => showAlarmModal(c.code));
  const tweakBtn = el("button", "r-btn ghost", "📍 调整信息");
  tweakBtn.addEventListener("click", () => {
    closeDrawer();
    showTweakModal(c.code);
  });
  const forumBtn = el("button", "r-btn ghost", "💬 讨论区");
  forumBtn.addEventListener("click", () => {
    closeDrawer();
    showForum("list", { course: c.code });
  });
  actions.appendChild(alarmBtn);
  actions.appendChild(tweakBtn);
  actions.appendChild(forumBtn);
  d.appendChild(actions);

  const delBtn = el("button", "r-btn danger dr-danger", "从课表移除这门课");
  delBtn.addEventListener("click", () => { closeDrawer(); removeCourse(c.code); });
  d.appendChild(delBtn);
}

function kv(k, v) {
  const row = el("div");
  row.appendChild(el("span", "k", k + "："));
  row.appendChild(el("span", "v", v));
  return row;
}

/* ---------------- 笔记 ---------------- */
/* 调整上课信息：按节次覆盖地点/教师，仅存自己的 records（他人不受影响，随云同步） */
function showTweakModal(code) {
  const c = courseMap[code];
  if (!c) return;
  const seen = new Set();
  const slots = [];
  for (const s of (c.sessions || [])) {
    const k = sessKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    slots.push(s);
  }
  const modalCard = el("div", "modal-card");
  modalCard.appendChild(el("h3", "", "📍 调整上课信息"));
  modalCard.appendChild(el("p", "share-hint", "仅修改你课表里的显示，不影响任何人。可调整地点 / 教师 / 上课时间（星期与节次），可选「整个学期」或「仅某一天」。"));
  const list = el("div", "tk-list");
  for (const s of slots) {
    const tw = tweakOf(code, s);
    let slotLabel = DAY_NAMES[s.day - 1] + " 第" + s.p1 + (s.p2 > s.p1 ? "-" + s.p2 : "") + "节";
    if (tw && (Number.isInteger(tw.day) || Number.isInteger(tw.p1))) {
      const d = Number.isInteger(tw.day) ? tw.day : s.day;
      const a = Number.isInteger(tw.p1) ? tw.p1 : s.p1;
      const b = Number.isInteger(tw.p2) ? tw.p2 : s.p2;
      slotLabel += " → " + DAY_NAMES[d - 1] + " 第" + a + (b > a ? "-" + b : "") + "节";
    }
    const row = el("div", "tk-row");
    row.appendChild(el("span", "tk-slot", slotLabel));
    row.appendChild(el("span", "tk-room", (effRoom(c, s) || "（无地点）") + (tw ? " ✎" : "")));
    const b = el("button", "r-btn small", "修改");
    b.addEventListener("click", () => editTweakSlot(code, s));
    row.appendChild(b);
    list.appendChild(row);
  }
  modalCard.appendChild(list);

  /* 已有的单日调整（可单独删除） */
  const rec = state.records[code];
  if (rec && rec.tweaksByDate) {
    const dates = Object.keys(rec.tweaksByDate).sort();
    if (dates.length) {
      const sub = el("div", "tk-sub");
      sub.appendChild(el("div", "tk-sub-title", "单日临时调整"));
      for (const ds of dates) {
        for (const k of Object.keys(rec.tweaksByDate[ds])) {
          const parts = k.split("-");
          const dayIdx = Number(parts[0]);
          const row = el("div", "tk-row");
          row.appendChild(el("span", "tk-slot", ds.slice(5) + " " + DAY_NAMES[dayIdx - 1].slice(1)));
          const twd = rec.tweaksByDate[ds][k] || {};
          let lbl = twd.room || "（恢复默认地点）";
          if (Number.isInteger(twd.day) || Number.isInteger(twd.p1)) {
            const d = Number.isInteger(twd.day) ? twd.day : dayIdx;
            const a = Number.isInteger(twd.p1) ? twd.p1 : "";
            const b = Number.isInteger(twd.p2) ? twd.p2 : "";
            lbl = "时间 → " + DAY_NAMES[d - 1] + " 第" + a + (b && b > a ? "-" + b : "") + "节" + (twd.room ? " · " + twd.room : "");
          }
          row.appendChild(el("span", "tk-room", lbl + " ✎"));
          const x = el("button", "r-btn small danger", "删除");
          x.addEventListener("click", () => {
            delete rec.tweaksByDate[ds][k];
            if (!Object.keys(rec.tweaksByDate[ds]).length) delete rec.tweaksByDate[ds];
            saveState();
            render();
            toast("已删除该单日调整");
            showTweakModal(code);
          });
          row.appendChild(x);
          sub.appendChild(row);
        }
      }
      modalCard.appendChild(sub);
    }
  }

  const actions = el("div", "modal-actions");
  const close = el("button", "cancel", "关闭");
  close.addEventListener("click", hideModal);
  actions.appendChild(close);
  modalCard.appendChild(actions);
  showModal(modalCard);
}
function editTweakSlot(code, s) {
  const c = courseMap[code];
  const tw = tweakOf(code, s) || {};
  const defDate = nextDateStr(s.day);
  const dtw = dateTweakOf(code, defDate, s) || {};
  showModal(`
    <div class="modal-card">
      <h3>${DAY_NAMES[s.day - 1]} 第${s.p1}${s.p2 > s.p1 ? "-" + s.p2 : ""}节</h3>
      <div class="r-form">
        <select id="twDay"></select>
        <select id="twP1"></select>
        <select id="twP2"></select>
        <input id="twRoom" maxlength="30" placeholder="上课地点（如：教一楼 302）">
        <input id="twTeacher" maxlength="30" placeholder="教师（可选，留空用默认）">
        <select id="twScope">
          <option value="slot">生效范围：整个学期（该时段全部课）</option>
          <option value="date">生效范围：仅某一天（临时调整）</option>
        </select>
        <input id="twDate" type="date" class="hidden">
      </div>
      <div class="modal-actions">
        <button class="ok" id="twSave">保存</button>
        <button class="cancel" id="twReset">恢复默认</button>
        <button class="cancel" id="twCancel">取消</button>
      </div>
    </div>`);
  $("twRoom").value = tw.room || dtw.room || "";
  $("twTeacher").value = tw.teacher || dtw.teacher || "";
  /* 时间下拉：星期 + 起止节（"不变"=不调整） */
  const maxP = Math.max.apply(null, Object.keys(PERIOD_TIMES).map(Number));
  const daySel = $("twDay"), p1Sel = $("twP1"), p2Sel = $("twP2");
  daySel.appendChild(new Option("星期不变", ""));
  for (let i = 1; i <= 7; i++) daySel.appendChild(new Option(DAY_NAMES[i - 1], String(i)));
  p1Sel.appendChild(new Option("开始节不变", ""));
  p2Sel.appendChild(new Option("结束节不变", ""));
  for (let p = 1; p <= maxP; p++) {
    p1Sel.appendChild(new Option("第" + p + "节", String(p)));
    p2Sel.appendChild(new Option("第" + p + "节", String(p)));
  }
  const cur = {};
  for (const src of [tw, dtw]) {
    if (Number.isInteger(src.day)) cur.day = src.day;
    if (Number.isInteger(src.p1)) cur.p1 = src.p1;
    if (Number.isInteger(src.p2)) cur.p2 = src.p2;
  }
  if (Number.isInteger(cur.day)) daySel.value = String(cur.day);
  if (Number.isInteger(cur.p1)) p1Sel.value = String(cur.p1);
  if (Number.isInteger(cur.p2)) p2Sel.value = String(cur.p2);
  const dateIn = $("twDate");
  dateIn.value = defDate;
  $("twScope").addEventListener("change", () => {
    const isDate = $("twScope").value === "date";
    dateIn.classList.toggle("hidden", !isDate);
  });
  $("twSave").addEventListener("click", () => {
    const room = $("twRoom").value.trim();
    const teacher = $("twTeacher").value.trim();
    const isDate = $("twScope").value === "date";
    const dateStr = isDate ? $("twDate").value : null;
    if (isDate && !dateStr) { toast("请选择日期"); return; }
    const dayV = daySel.value === "" ? null : parseInt(daySel.value, 10);
    const p1v = p1Sel.value === "" ? null : parseInt(p1Sel.value, 10);
    const p2v = p2Sel.value === "" ? null : parseInt(p2Sel.value, 10);
    if ((p1v == null) !== (p2v == null)) { toast("开始节和结束节要一起设置"); return; }
    if (p1v != null && p1v > p2v) { toast("结束节不能早于开始节"); return; }
    if (dayV != null && !(dayV >= 1 && dayV <= 7)) { toast("星期不合法"); return; }
    const rec = recordsOf(code);
    const k = sessKey(s);
    const time = {};
    if (dayV != null) time.day = dayV;
    if (p1v != null) { time.p1 = p1v; time.p2 = p2v; }
    const val = Object.assign({}, room ? { room } : {}, teacher ? { teacher } : {}, time);
    const noTime = !time.day && !time.p1;
    const same = room === (s.room || "") && teacher === (c.teacher || "") && noTime;
    if (isDate) {
      if (!rec.tweaksByDate) rec.tweaksByDate = {};
      if (!rec.tweaksByDate[dateStr]) rec.tweaksByDate[dateStr] = {};
      if (same) delete rec.tweaksByDate[dateStr][k];
      else rec.tweaksByDate[dateStr][k] = val;
      if (!Object.keys(rec.tweaksByDate[dateStr]).length) delete rec.tweaksByDate[dateStr];
    } else {
      if (!rec.tweaks) rec.tweaks = {};
      if (same) delete rec.tweaks[k];
      else rec.tweaks[k] = val;
    }
    saveState();
    hideModal();
    render();
    toast(same ? "已恢复该节默认信息"
      : !noTime ? (isDate ? "时间已调整（仅 " + dateStr.slice(5) + " 生效）" : "时间已调整，全学期生效")
      : (isDate ? "已保存（仅 " + dateStr.slice(5) + " 生效）" : "已保存，全学期生效"));
    showTweakModal(code);
  });
  $("twReset").addEventListener("click", () => {
    const rec = recordsOf(code);
    const isDate = $("twScope").value === "date";
    const k = sessKey(s);
    if (isDate) {
      const dateStr = $("twDate").value;
      if (rec.tweaksByDate && rec.tweaksByDate[dateStr]) {
        delete rec.tweaksByDate[dateStr][k];
        if (!Object.keys(rec.tweaksByDate[dateStr]).length) delete rec.tweaksByDate[dateStr];
      }
    } else if (rec.tweaks) {
      delete rec.tweaks[k];
    }
    saveState();
    hideModal();
    render();
    toast("已恢复默认");
    showTweakModal(code);
  });
  $("twCancel").addEventListener("click", hideModal);
}

/* 笔记图片：浏览器本地 canvas 压缩（长边<=1024, JPEG 75%），零网络调用 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const MAX = 1024;
        let w = img.naturalWidth || 1, h = img.naturalHeight || 1;
        const s = Math.min(1, MAX / Math.max(w, h));
        w = Math.max(1, Math.round(w * s));
        h = Math.max(1, Math.round(h * s));
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); /* 透明PNG转JPEG不发黑 */
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.75));
      } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片读取失败")); };
    img.src = url;
  });
}
function viewNoteImage(src) {
  showModal('<div class="modal-card"><img id="nvImg" alt="笔记图片"><div class="modal-actions"><button class="cancel" id="nvClose">关闭</button></div></div>');
  $("nvImg").src = src;
  $("nvClose").addEventListener("click", hideModal);
}

function notesView() {
  const rec = recordsOf(drawerCourse.code);
  const box = el("div");

  const form = el("div", "r-form");
  const row2 = el("div", "row2");
  const dateIn = el("input"); dateIn.type = "date";
  dateIn.value = todayStr();
  const titleIn = el("input"); titleIn.placeholder = "标题（如：第3周 希尔伯特空间）";
  row2.appendChild(dateIn);
  row2.appendChild(titleIn);
  const contentIn = el("textarea"); contentIn.placeholder = "记笔记…";
  bindAutoGrow(contentIn, 300);
  const pendingImgs = [];
  const imgRow = el("div", "np-strip hidden");
  const refreshStrip = () => {
    imgRow.innerHTML = "";
    imgRow.classList.toggle("hidden", !pendingImgs.length);
    for (const d of pendingImgs) {
      const w = el("div", "np-thumb");
      const th = el("img"); th.src = d; th.alt = "";
      w.appendChild(th);
      const x = el("button", "np-x", "×");
      x.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const i = pendingImgs.indexOf(d);
        if (i >= 0) pendingImgs.splice(i, 1);
        refreshStrip();
      });
      w.appendChild(x);
      imgRow.appendChild(w);
    }
  };
  const fileIn = el("input");
  fileIn.type = "file"; fileIn.accept = "image/*"; fileIn.multiple = true; fileIn.hidden = true;
  const picBtn = el("button", "r-btn small ghost", "📷 图片");
  picBtn.addEventListener("click", () => fileIn.click());
  fileIn.addEventListener("change", async () => {
    const room = 6 - pendingImgs.length;
    const files = Array.from(fileIn.files || []).slice(0, Math.max(0, room));
    if (!files.length) { toast("每条笔记最多 6 张图片"); fileIn.value = ""; return; }
    picBtn.disabled = true; picBtn.textContent = "处理中…";
    for (const f of files) {
      try { pendingImgs.push(await compressImage(f)); }
      catch (e) { toast("有图片处理失败，已跳过"); }
    }
    picBtn.disabled = false; picBtn.textContent = "📷 图片";
    fileIn.value = "";
    refreshStrip();
  });
  const saveBtn = el("button", "r-btn", "保存笔记");
  const btnRow = el("div", "f-compose-row");
  btnRow.appendChild(picBtn);
  btnRow.appendChild(saveBtn);
  const setEditing = (on) => {
    form.classList.toggle("editing", !!on);
    saveBtn.textContent = on ? "保存修改" : "保存笔记";
  };
  saveBtn.addEventListener("click", () => {
    const title = titleIn.value.trim() || "未命名笔记";
    const content = contentIn.value.trim();
    if (!content) { toast("笔记内容为空"); return; }
    if (noteEditing) {
      const n = rec.notes.find(x => x.id === noteEditing);
      if (n) { n.date = dateIn.value; n.title = title; n.content = content; n.images = pendingImgs.length ? pendingImgs.slice() : undefined; }
      noteEditing = null;
    } else {
      rec.notes.push({ id: uid(), date: dateIn.value, title, content, images: pendingImgs.length ? pendingImgs.slice() : undefined });
    }
    saveState();
    setEditing(false);
    dateIn.value = todayStr(); titleIn.value = ""; contentIn.value = "";
    pendingImgs.length = 0; refreshStrip();
    autoGrow(contentIn, 300);
    renderDrawer();
    toast("已保存");
  });
  form.appendChild(row2);
  form.appendChild(contentIn);
  form.appendChild(imgRow);
  form.appendChild(btnRow);
  form.appendChild(fileIn);
  box.appendChild(form);

  const sorted = [...rec.notes].sort((a, b) => b.date.localeCompare(a.date));
  if (!sorted.length) box.appendChild(el("div", "empty-tip", "还没有笔记，记录第一笔吧"));
  for (const n of sorted) {
    const item = el("div", "r-item");
    const row = el("div", "row");
    const g = el("div", "grow");
    g.appendChild(el("div", "t", n.title));
    g.appendChild(el("div", "m", n.date));
    row.appendChild(g);
    const edit = el("button", "r-btn small", "编辑");
    const del = el("button", "r-btn small danger", "删");
    edit.addEventListener("click", () => {
      noteEditing = n.id;
      dateIn.value = n.date; titleIn.value = n.title; contentIn.value = n.content;
      pendingImgs.length = 0;
      for (const d of (n.images || [])) pendingImgs.push(d);
      refreshStrip();
      setEditing(true);
      autoGrow(contentIn, 300);
      box.scrollIntoView({ block: "start" });
      contentIn.focus();
    });
    del.addEventListener("click", () => {
      if (noteEditing === n.id) noteEditing = null;
      rec.notes = rec.notes.filter(x => x.id !== n.id);
      saveState(); renderDrawer();
    });
    row.appendChild(edit);
    row.appendChild(del);
    item.appendChild(row);
    item.appendChild(el("div", "c", n.content));
    if (n.images && n.images.length) {
      const strip = el("div", "note-imgs");
      for (const d of n.images) {
        const th = el("img", "note-th");
        th.src = d; th.alt = "";
        th.addEventListener("click", () => viewNoteImage(d));
        strip.appendChild(th);
      }
      item.appendChild(strip);
    }
    box.appendChild(item);
  }
  return box;
}

/* ---------------- 作业 ---------------- */
function homeworkView() {
  const rec = recordsOf(drawerCourse.code);
  const box = el("div");

  const form = el("div", "r-form");
  const titleIn = el("input"); titleIn.placeholder = "作业内容（如：习题 2.1-2.8）";
  const dueIn = el("input"); dueIn.type = "date";
  const row2 = el("div", "row2");
  row2.appendChild(titleIn);
  row2.appendChild(dueIn);
  const saveBtn = el("button", "r-btn", hwEditing ? "保存修改" : "添加作业");
  const setHwEditing = (on) => {
    form.classList.toggle("editing", !!on);
    saveBtn.textContent = on ? "保存修改" : "添加作业";
  };
  saveBtn.addEventListener("click", () => {
    const title = titleIn.value.trim();
    if (!title) { toast("请填写作业内容"); return; }
    if (hwEditing) {
      const h = rec.homework.find(x => x.id === hwEditing);
      if (h) { h.title = title; h.due = dueIn.value; }
      hwEditing = null;
    } else {
      rec.homework.push({ id: uid(), title, due: dueIn.value, done: false });
    }
    saveState();
    setHwEditing(false);
    titleIn.value = ""; dueIn.value = "";
    renderDrawer();
  });
  form.appendChild(row2);
  form.appendChild(saveBtn);
  box.appendChild(form);

  const undone = rec.homework.filter(h => !h.done).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const done = rec.homework.filter(h => h.done);
  for (const h of [...undone, ...done]) {
    const item = el("div", "r-item" + (h.done ? " done" : ""));
    const row = el("div", "row");
    const chk = el("input"); chk.type = "checkbox"; chk.checked = !!h.done;
    chk.addEventListener("change", () => { h.done = chk.checked; saveState(); renderDrawer(); });
    const g = el("div", "grow");
    g.appendChild(el("div", "t", h.title));
    g.appendChild(el("div", "m", h.due ? "截止 " + h.due : "无截止日期"));
    const badge = badgeFor(daysLeft(h.due), h.done);
    if (badge) g.appendChild(badge);
    const edit = el("button", "r-btn small", "改");
    const del = el("button", "r-btn small danger", "删");
    edit.addEventListener("click", () => {
      hwEditing = h.id;
      titleIn.value = h.title; dueIn.value = h.due || "";
      setHwEditing(true);
      titleIn.focus();
    });
    del.addEventListener("click", () => {
      if (hwEditing === h.id) hwEditing = null;
      rec.homework = rec.homework.filter(x => x.id !== h.id);
      saveState(); renderDrawer();
    });
    row.appendChild(chk);
    row.appendChild(g);
    row.appendChild(edit);
    row.appendChild(del);
    item.appendChild(row);
    box.appendChild(item);
  }
  if (!rec.homework.length) box.appendChild(el("div", "empty-tip", "暂无作业"));
  return box;
}

function badgeFor(days, done) {
  if (done) return el("span", "badge gray", "已完成");
  if (days == null) return null;
  if (days < 0) return el("span", "badge danger", `已逾期 ${-days} 天`);
  if (days <= 3) return el("span", "badge warn", `剩 ${days} 天`);
  return el("span", "badge ok", `剩 ${days} 天`);
}

/* ---------------- 考试 ---------------- */
function examsView() {
  const rec = recordsOf(drawerCourse.code);
  const box = el("div");

  const form = el("div", "r-form");
  const typeIn = el("select");
  for (const t of ["期末", "期中", "课堂测验", "读书报告", "论文", "其它"]) {
    typeIn.appendChild(new Option(t, t));
  }
  const dateIn = el("input"); dateIn.type = "date";
  const timeIn = el("input"); timeIn.type = "time";
  const locIn = el("input"); locIn.placeholder = "地点（可选）";
  const row2 = el("div", "row2"); row2.appendChild(typeIn); row2.appendChild(dateIn);
  const row3 = el("div", "row2"); row3.appendChild(timeIn); row3.appendChild(locIn);
  const saveBtn = el("button", "r-btn", examEditing ? "保存修改" : "添加考试");
  const setExamEditing = (on) => {
    form.classList.toggle("editing", !!on);
    saveBtn.textContent = on ? "保存修改" : "添加考试";
  };
  saveBtn.addEventListener("click", () => {
    if (!dateIn.value) { toast("请选择考试日期"); return; }
    if (examEditing) {
      const e = rec.exams.find(x => x.id === examEditing);
      if (e) { e.type = typeIn.value; e.date = dateIn.value; e.time = timeIn.value; e.location = locIn.value.trim(); }
      examEditing = null;
    } else {
      rec.exams.push({ id: uid(), type: typeIn.value, date: dateIn.value, time: timeIn.value, location: locIn.value.trim() });
    }
    saveState();
    setExamEditing(false);
    dateIn.value = ""; timeIn.value = ""; locIn.value = "";
    renderDrawer();
  });
  form.appendChild(row2);
  form.appendChild(row3);
  form.appendChild(saveBtn);
  box.appendChild(form);

  const sorted = [...rec.exams].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  if (!sorted.length) box.appendChild(el("div", "empty-tip", "暂无考试信息"));
  for (const e of sorted) {
    const item = el("div", "r-item");
    const row = el("div", "row");
    const g = el("div", "grow");
    g.appendChild(el("div", "t", e.type));
    const meta = `${e.date || ""}${e.time ? " " + e.time : ""}${e.location ? " · " + e.location : ""}`;
    g.appendChild(el("div", "m", meta));
    const days = daysLeft(e.date);
    if (days != null) {
      g.appendChild(days >= 0
        ? el("span", "badge " + (days <= 7 ? "warn" : "blue"), `还有 ${days} 天`)
        : el("span", "badge gray", "已结束"));
    }
    const edit = el("button", "r-btn small", "改");
    const del = el("button", "r-btn small danger", "删");
    edit.addEventListener("click", () => {
      examEditing = e.id;
      typeIn.value = e.type; dateIn.value = e.date; timeIn.value = e.time || ""; locIn.value = e.location || "";
      setExamEditing(true);
      dateIn.focus();
    });
    del.addEventListener("click", () => {
      if (examEditing === e.id) examEditing = null;
      rec.exams = rec.exams.filter(x => x.id !== e.id);
      saveState(); renderDrawer();
    });
    row.appendChild(g);
    row.appendChild(edit);
    row.appendChild(del);
    item.appendChild(row);
    box.appendChild(item);
  }
  return box;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------------- 代码输入弹窗 ---------------- */
function showCodesModal() {
  showModal(`
    <div class="modal-card">
      <h3>粘贴课程代码</h3>
      <textarea id="codesText" spellcheck="false" placeholder="每行一个课程代码，如：&#10;180081070200P1001H-1"></textarea>
      <div class="modal-actions">
        <button class="ok" id="codesOk">添加到课表</button>
        <button class="cancel" id="codesCancel">取消</button>
      </div>
    </div>`);
  const ta = $("codesText");
  bindAutoGrow(ta, 300);
  ta.focus();
  const submit = () => {
    const raw = parseCodes(ta.value);
    if (!raw.length) { toast("没有有效的课程代码"); return; }
    hideModal();
    addCodes(raw);
  };
  $("codesOk").addEventListener("click", submit);
  ctrlEnter(ta, submit);
  $("codesCancel").addEventListener("click", hideModal);
}

/* 搜索添加课程（弹窗式）：主界面撤掉常驻搜索条后从这里进，绑定随弹窗重建 */
function showSearchModal() {
  showModal(`
    <div class="modal-card">
      <h3>🔍 添加课程</h3>
      <div class="searchbox" style="margin:0 0 6px">
        <input id="msInput" placeholder="搜索课程名称 / 课程代码…" autocomplete="off">
        <div id="msSug" class="suggestions"></div>
      </div>
      <p class="share-hint">也可在「更多 → 粘贴课程代码」批量导入</p>
      <div class="modal-actions"><button class="cancel" id="msClose">关闭</button></div>
    </div>`);
  bindSearch($("msInput"), $("msSug"), () => { hideModal(); toast("已添加到课表"); });
  $("msInput").focus();
  $("msClose").addEventListener("click", hideModal);
}

/* 赞赏：点页脚"请作者喝杯奶茶"弹码（低调，不打扰任何人） */
function showSupport() {
  supportPing();
  showModal(`
    <div class="modal-card support-card">
      <h3>☕ 请作者喝杯奶茶</h3>
      <p class="sp-note">课壳永久免费，你的支持是更新的动力</p>
      <img class="sp-qr" src="./support-qr.jpg" alt="微信赞赏码">
      <p class="sp-tip">微信扫一扫 · 金额随意 · 留言必回</p>
      <div class="modal-actions"><button class="cancel" id="spClose">关闭</button></div>
    </div>`);
  const c = $("spClose");
  if (c) c.addEventListener("click", hideModal);
}

/* 奶茶页打开计数（匿名：只记 did+day，每设备每天 1 次；表无 select 权限，数据只进不出） */
function supportPing() {
  try {
    if (!supabaseClient || !online()) return;
    let did = "";
    try { did = localStorage.getItem(DID_KEY) || ""; } catch (e) {}
    supabaseClient.from("support_opens")
      .upsert(
        { did: did || "anon", day: new Date().toISOString().slice(0, 10) },
        { ignoreDuplicates: true, onConflict: "did,day" }
      )
      .then(() => {}, () => {});
  } catch (e) {}
}

/* 感谢名单：微信赞赏码没有查询接口，作者在微信里核对记录后手动维护 THANKS 数组 */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

const THANKS = [
  { name: "09081202", amount: "¥1", date: "2026-09-08" },
  { name: "09081534", amount: "¥5", date: "2026-09-08" },
  // { name: "昵称", amount: "¥10", date: "2026-09-08", msg: "留言（可省略）" },
];

function showThanks() {
  const rows = THANKS.map((t) =>
    '<div class="thx-row"><span class="n">' + esc(t.name) + '</span>' +
    (t.msg ? '<span class="m">' + esc(t.msg) + '</span>' : '') +
    (t.amount ? '<span class="a">' + esc(t.amount) + '</span>' : '') +
    (t.date ? '<span class="d">' + esc(t.date) + '</span>' : '') +
    '</div>').join("");
  const body = rows ||
    '<div class="thx-empty">名单虚位以待<br>赞赏时留言你的昵称，就会出现在这里</div>';
  showModal(`
    <div class="modal-card thanks-card">
      <h3>🙏 感谢名单</h3>
      <div class="thx-list">${body}</div>
      <p class="thx-foot">名单由作者定期在微信核对赞赏记录后更新 · 打赏不留名也可以</p>
      <div class="modal-actions"><button class="cancel" id="thClose">关闭</button></div>
    </div>`);
  const c = $("thClose");
  if (c) c.addEventListener("click", hideModal);
}

/* ---------------- 更多菜单（论坛/代码/备份收纳于此） ---------------- */
function showMoreMenu() {
  showModal(`
    <div class="modal-card">
      <h3>更多</h3>
      <div class="menu-list">
        <button class="menu-item" id="mmSearch"><span class="mi-ico">🔍</span><span>添加课程（搜索）</span></button>
        <button class="menu-item" id="mmSync"><span class="mi-ico">☁</span><span>立即云备份</span></button>
        <button class="menu-item" id="mmInstall"><span class="mi-ico">📲</span><span>安装成手机 App</span></button>
        <button class="menu-item" id="mmWidget"><span class="mi-ico">⏰</span><span>桌面快捷方式 / 下节课直达</span></button>
        <button class="menu-item" id="mmCodes"><span class="mi-ico">⌨️</span><span>粘贴课程代码</span></button>
        <button class="menu-item" id="mmBackup"><span class="mi-ico">⤓</span><span>备份与恢复</span></button>
      </div>
    </div>`);
  $("mmSearch").addEventListener("click", () => { hideModal(); showSearchModal(); });
  $("mmInstall").addEventListener("click", () => {
    if (isStandalone()) { toast("已经安装过啦，桌面就能找到 📲"); return; }
    hideModal();
    showInstallGuide();
  });
  $("mmSync").addEventListener("click", () => {
    hideModal();
    if (!supabaseClient) { toast("云服务未就绪"); return; }
    if (!authUser) { showCloudPitch(); return; }
    if (stateHash() === lastPushedHash) { toast("云端已是最新 ☁"); return; }
    pushToCloud().then(() => {
      toast(stateHash() === lastPushedHash ? "已备份到云端 ☁" : "备份失败，请稍后重试");
    });
  });
  $("mmCodes").addEventListener("click", () => { hideModal(); showCodesModal(); });
  $("mmBackup").addEventListener("click", () => { hideModal(); backupModal(); });
  $("mmWidget").addEventListener("click", () => { hideModal(); showWidgetGuide(); });
}

/* 桌面小组件/快捷方式指南：真小组件是原生 App 专属；安卓给长按菜单，iOS 给「快捷指令」替代路径 */
function showWidgetGuide() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && "ontouchend" in document);
  const secAnd = `
    <div class="wg-sec">🤖 安卓（Chrome）</div>
    <p class="share-hint">先「添加到主屏幕」装成应用，然后<b>长按课壳图标</b> → 弹出「今日课程」「下节课」，点击直达。</p>`;
  const secIos = `
    <div class="wg-sec">🍎 iPhone / iPad</div>
    <p class="share-hint">iOS 把长按菜单和小组件留给原生 App，网页应用加不了。官方替代：用「快捷指令」做一个直达图标，约 1 分钟：</p>
    <p class="share-hint">① 打开「快捷指令」App → 右上角 ＋ 新建<br>② 添加操作 → 搜索「URL」→ 选「打开 URL」<br>③ 填入下面的链接：<code class="wg-url">https://jiad88376-coder.github.io/kebiao-ucas/?view=next</code><br>④ 点顶部名字改成「下节课」→ 底部分享 ⤴ →「添加到主屏幕」</p>
    <p class="share-hint">之后桌面多一个「下节课」图标，点一下直接弹出下一节课的卡片。想加「今日课程」就把链接结尾换成 <code>?view=today</code> 再做一条。</p>`;
  showModal(`
    <div class="modal-card">
      <h3>⏰ 桌面快捷方式</h3>
      <p class="share-hint">小组件（Widget）是原生 App 专属，网页应用做不到；能做到的最接近形态如下。</p>
      ${ios ? secIos + secAnd : secAnd + secIos}
      <div class="modal-actions"><button class="ok" id="wgOk">知道了</button></div>
    </div>`);
  $("wgOk").addEventListener("click", hideModal);
}

/* 云备份注册引导：未登录点"立即云备份"时展示（讲清楚价值，注册优先） */
function showCloudPitch() {
  showModal(`
    <div class="modal-card auth-card">
      <div class="auth-logo">☁</div>
      <div class="auth-head">云备份需要免费注册</div>
      <p class="auth-desc">注册后课表 / 笔记 / 作业 / 考试自动备份云端<br>换手机、清缓存都不怕丢</p>
      <div class="modal-actions">
        <button class="ok" id="cpSignup">立即注册</button>
        <button class="cancel" id="cpLogin">已有账号，登录</button>
      </div>
    </div>`);
  $("cpSignup").addEventListener("click", () => showAuthSignupUI(""));
  $("cpLogin").addEventListener("click", () => showAuthModal());
}

/* ---------------- 上传资料 ---------------- */
function filesUploadModal() {
  showModal(`
    <div class="modal-card">
      <h3>上传资料</h3>
      <div class="r-form">
        <input id="fuFile" type="file" hidden>
        <button class="r-btn ghost" id="fuPick" type="button" style="width:100%">📎 选择文件（≤5MB）</button>
        <span class="f-file-size" id="fuTip" style="display:block;text-align:center"></span>
        <select id="fuCourse"></select>
        <textarea id="fuNote" placeholder="补充说明（可选，如适用章节）" style="min-height:60px"></textarea>
      </div>
      <div class="modal-actions">
        <button class="ok" id="fuOk">上传</button>
        <button class="cancel" id="fuCancel">取消</button>
      </div>
    </div>`);
  const fileIn = $("fuFile");
  const pick = $("fuPick");
  const tip = $("fuTip");
  const sel = $("fuCourse");
  const o0 = el("option"); o0.value = ""; o0.textContent = "不关联课程（全校共享）";
  sel.appendChild(o0);
  for (const code of state.codes) {
    const c = courseMap[code];
    if (!c) continue;
    const o = el("option");
    o.value = c.code;
    o.textContent = "@ " + (c.name.length > 18 ? c.name.slice(0, 18) + "…" : c.name);
    sel.appendChild(o);
  }
  if (forumCtx.course) sel.value = forumCtx.course;
  pick.addEventListener("click", () => fileIn.click());
  fileIn.addEventListener("change", () => {
    const f = fileIn.files[0];
    tip.textContent = f ? (f.name.length > 16 ? f.name.slice(0, 16) + "…" : f.name) + " · " + fmtSize(f.size) : "";
    pick.textContent = f ? "📎 已选，点击可更换" : "📎 选择文件（≤5MB）";
  });
  $("fuOk").addEventListener("click", async () => {
    const f = fileIn.files[0];
    if (!f) { toast("请选择文件"); return; }
    if (f.size > FILE_MAX) { toast("附件不能超过 5MB"); return; }
    const note = $("fuNote").value.trim();
    const code = sel.value || null;
    const ok = $("fuOk");
    ok.disabled = true; ok.textContent = "上传中…";
    try {
      const ext = (f.name.match(/\.[A-Za-z0-9]+$/) || [""])[0];
      const path = authUser.id + "/" + Date.now() + ext;
      const { error: uerr } = await supabaseClient.storage.from("forum-files").upload(path, f, { upsert: false });
      if (uerr) throw uerr;
      const name = f.name.length > 60 ? f.name.slice(0, 60) : f.name;
      const { error } = await supabaseClient.from("forum_posts").insert({
        user_id: authUser.id, author: authorShort(authUser.email),
        title: "📎 " + name, content: note, course_code: code,
        file_path: path, file_name: f.name, file_size: f.size
      });
      if (error) throw error;
      hideModal();
      toast("资料已上传 📎");
      forumCacheClear();
      forumCtx.filesOnly = true;
      loadForumList();
    } catch (e) {
      toast("上传失败：" + (e.message || e));
      ok.disabled = false; ok.textContent = "上传";
    }
  });
  $("fuCancel").addEventListener("click", hideModal);
  ctrlEnter($("fuNote"), () => $("fuOk").click());
}

function backupModal() {
  showModal(`
    <div class="modal-card">
      <h3>备份与恢复</h3>
      <p style="color:var(--muted);font-size:13px">课表与笔记仅保存在本机浏览器。换手机或清缓存前请先导出备份。</p>
      <div class="modal-actions">
        <button class="ok" id="bkpExport">导出备份</button>
        <button class="cancel" id="bkpImport">导入备份</button>
      </div>
    </div>`);
  $("bkpExport").addEventListener("click", () => { hideModal(); exportBackup(); });
  $("bkpImport").addEventListener("click", () => { hideModal(); $("fileImport").click(); });
}

/* ---------------- 分享（推荐应用给同学） ---------------- */
const SHARE_URL = "https://jiad88376-coder.github.io/kebiao-ucas/";
const SHARE_TEXT = [
  "「课壳」— 国科大人自己的课表工具",
  "✓ 粘贴课程代码，3 秒生成整学期课表",
  "✓ 笔记 / 作业 DDL / 考试安排一站式管理",
  "✓ 云同步，手机电脑互通，还能装成手机 App",
  "✓ 每门课自带讨论区，资料共享"
].join("\n");

function copyShare(text, tip) {
  const done = () => toast(tip);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}

/* ---------------- 安装提醒（PWA）：Android 原生弹窗 / iOS 手动指引，已装不显示，7 天免打扰 ---------------- */
const INSTALL_KEY = "kebiao:installbar";
let deferredPrompt = null;
function isStandalone() {
  try { return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true; } catch (e) { return false; }
}
function installDismissed() {
  try { const t = Number(localStorage.getItem(INSTALL_KEY)) || 0; return t && Date.now() - t < 7 * 86400e3; } catch (e) { return false; }
}
function installHintText() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    ? "Safari 底部「分享 ⬆️」→ 添加到主屏幕"
    : "浏览器菜单 →「安装应用 / 添加到主屏幕」";
}
function maybeShowInstallBar() {
  if (typeof document === "undefined") return;
  if (isStandalone() || installDismissed() || !state.codes.length) return;
  const bar = $("installBar");
  if (!bar) return;
  $("installHow").textContent = installHintText();
  bar.classList.remove("hidden");
}
function showInstallGuide() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  showModal(`
    <div class="modal-card">
      <h3>📲 把课壳装成 App</h3>
      <div class="inst-steps">
        <p>${ios
          ? "① 用 <b>Safari</b> 打开本页<br>② 点底部中间的「分享 ⬆️」<br>③ 选「<b>添加到主屏幕</b>」→ 添加"
          : "① 点浏览器右上角「⋮」菜单<br>② 选「<b>安装应用</b>」或「添加到主屏幕」"}</p>
        <p class="share-hint">${IS_WECHAT
          ? "微信 / QQ 内无法安装：先点右上角「…」→「在浏览器打开」"
          : "装好后桌面直达 · 离线也能看课表 · 通知类功能更强"}</p>
      </div>
      <div class="modal-actions"><button class="ok" id="igOk">知道了</button></div>
    </div>`);
  $("igOk").addEventListener("click", hideModal);
}
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    maybeShowInstallBar();
  });
  window.addEventListener("appinstalled", () => {
    try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch (e) {}
    const bar = $("installBar");
    if (bar) bar.classList.add("hidden");
    toast("安装成功，桌面见 📲");
  });
}

function shareLink() {
  const personal = userNo > 0 ? "我是第 " + userNo + " 位课壳人，邀你也来 ✨" : null;
  const text = (personal ? personal + "\n" : "") + SHARE_TEXT;
  const url = SHARE_URL; /* 纯净链接: QQ/微信卡片缓存复用, 无需重新抓取 */
  const full = text + "\n👉 " + url;
  showModal(`
    <div class="modal-card">
      <h3>推荐「课壳」给同学</h3>
      <p class="share-hint">微信 / QQ 里会显示卡片 · 文案已备好${personal ? " · 你是第 " + userNo + " 位课壳人" : ""}</p>
      <div class="share-text">${text}
👉 ${url}</div>
      <div class="share-actions">
        <button class="sa-main" id="shText">发送文案 + 链接</button>
        <button class="sa-alt" id="shUrl">只复制链接</button>
      </div>
    </div>`);
  $("shText").addEventListener("click", () => {
    if (typeof navigator.share === "function") {
      navigator.share({ title: "课壳 · 国科大课程表", text: text, url }).catch(() => {});
    } else copyShare(full, "文案已复制，发给同学吧");
  });
  $("shUrl").addEventListener("click", () => copyShare(url, "链接已复制"));
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { prompt("复制链接：", text); }
  ta.remove();
}


/* ---------------- 备份 / 恢复 ---------------- */
function exportBackup() {
  const data = { app: "kebiao-ucas", version: 1, exportedAt: new Date().toISOString(), school: SCHOOL ? SCHOOL.id : null, codes: state.codes, records: state.records };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "kebiao-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("备份已导出");
}
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.codes)) throw new Error("bad format");
      showModal(`
        <div class="modal-card">
          <h3>导入备份</h3>
          <p>将覆盖当前课表与笔记（当前 ${state.codes.length} 门课）。继续？</p>
          <div class="modal-actions">
            <button class="ok" id="impOk">覆盖导入</button>
            <button class="cancel" id="impCancel">取消</button>
          </div>
        </div>`);
      $("impOk").addEventListener("click", () => {
        state.codes = data.codes.filter(c => courseMap[c]);
        state.records = data.records && typeof data.records === "object" ? data.records : {};
        saveState();
        hideModal();
        render();
        toast("导入成功");
      });
      $("impCancel").addEventListener("click", hideModal);
    } catch (e) {
      toast("备份文件格式不正确");
    }
  };
  reader.readAsText(file);
}
if (typeof document !== "undefined") {
  $("fileImport").addEventListener("change", (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = "";
  });
  /* 点遮罩关闭弹窗（所有弹窗通用兜底，防止被困住） */
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) hideModal();
  });
  /* 点遮罩关闭课程抽屉 */
  $("overlay").addEventListener("click", closeDrawer);
  /* 页脚赞赏/感谢名单 → 对应弹窗 */
  const sp = $("support-link");
  if (sp) sp.addEventListener("click", (e) => { e.preventDefault(); showSupport(); });
  const thl = $("thanks-link");
  if (thl) thl.addEventListener("click", (e) => { e.preventDefault(); showThanks(); });
  /* 会话结束兜底推送（关标签页/切后台时把未推送的改动合并上云） */
  window.addEventListener("pagehide", flushPush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPush();
  });
}

/* ---------------- 论坛 ---------------- */
const FILE_MAX = 5 * 1024 * 1024; // 走 Netlify 代理的单文件上限
let forumCtx = { mode: "list" };

/* 匿名可浏览；发言/下载需要登录，弹出登录框 */
function promptLogin(msg) {
  toast(msg || "请先登录");
  showAuthModal();
}
function authorShort(s) { return String(s || "").split("@")[0] || "同学"; }
function mine(uid) { return !!(authUser && uid === authUser.id); }
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  const hm = d.toTimeString().slice(0, 5);
  if (same(d, now)) return "今天 " + hm;
  if (same(d, yest)) return "昨天 " + hm;
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
}
function fmtSize(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
}

function showForum(mode, opts) {
  if (!authUser) { promptLogin("登录后才能浏览论坛"); return; }
  clearReplyBadge(); /* 进论坛即视为已查看，红点消失 */
  opts = opts || {};
  forumCtx = Object.assign({ mode: mode || "list", filesOnly: false }, opts);
  $("welcome").classList.add("hidden");
  $("main").classList.add("hidden");
  $("schoolPick").classList.add("hidden");
  $("forum").classList.remove("hidden");
  window.scrollTo(0, 0);
  renderForum();
}
function closeForum() {
  $("forum").classList.add("hidden");
  $("forumBody").innerHTML = "";
  state.codes.length ? showMain() : showWelcome();
}

function renderForum() {
  const head = $("forumHead");
  head.innerHTML = "";
  const back = el("button", "fb-back", "←");
  back.addEventListener("click", closeForum);
  head.appendChild(back);
  let title = "自由论坛";
  if (forumCtx.mode === "post") title = "帖子详情";
  if (forumCtx.mode === "list" && forumCtx.course) {
    title = "🏷 " + ((courseMap[forumCtx.course] || {}).name || forumCtx.course);
  }
  head.appendChild(el("span", "fb-title", title));
  if (forumCtx.mode === "list") {
    const nb = el("button", "fb-new", "✚ 发帖");
    nb.addEventListener("click", () => {
      if (!authUser) { promptLogin("登录后才能发帖"); return; }
      composeForumPost(forumCtx.course || null);
    });
    head.appendChild(nb);
    const ub = el("button", "fb-new", "📎 上传");
    ub.addEventListener("click", () => {
      if (!authUser) { promptLogin("登录后才能上传资料"); return; }
      filesUploadModal();
    });
    head.appendChild(ub);
  }
  $("forumBody").innerHTML = "";
  if (forumCtx.mode === "list") loadForumList();
  if (forumCtx.mode === "post") loadForumPost(forumCtx.postId);
}

/* ---- 自由论坛：列表 ---- */
/* ---- 自由论坛：列表（SWR：5 分钟内用本地缓存秒显，完全省掉请求） ---- */
const FORUM_CACHE_KEY = "kebiao:forum:v2";
const FORUM_CACHE_MS = 5 * 60 * 1000;
let forumListCache = null;
function forumCacheGet() {
  if (forumListCache && Date.now() - forumListCache.ts < FORUM_CACHE_MS) return forumListCache.posts;
  try {
    const c = JSON.parse(localStorage.getItem(FORUM_CACHE_KEY));
    if (c && c.ts && Date.now() - c.ts < FORUM_CACHE_MS && Array.isArray(c.posts)) {
      forumListCache = c;
      return c.posts;
    }
  } catch (e) {}
  return null;
}
function forumCacheSave(posts) {
  forumListCache = { ts: Date.now(), posts: posts };
  try { localStorage.setItem(FORUM_CACHE_KEY, JSON.stringify(forumListCache)); } catch (e) {}
}
function forumCacheClear() {
  forumListCache = null;
  forumDetailMem.clear();
  try { localStorage.removeItem(FORUM_CACHE_KEY); } catch (e) {}
}

async function loadForumList() {
  const body = $("forumBody");
  if (!supabaseClient) { body.innerHTML = ""; body.appendChild(el("div", "f-empty", "云服务未就绪，请刷新页面后重试")); return; }
  const cached = forumCacheGet();
  if (cached) { renderForumPosts(cached); return; }
  body.appendChild(el("div", "f-loading", "加载中…"));
  let posts;
  try {
    const { data, error } = await supabaseClient.from("forum_posts")
      .select("id,user_id,author,title,content,created_at,course_code,file_path,file_name,file_size")
      .eq("is_deleted", false).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    posts = data || [];
  } catch (e) {
    if (!body.isConnected) return;
    body.innerHTML = "";
    body.appendChild(el("div", "f-empty", "加载失败：" + (e.message || e)));
    return;
  }
  forumCacheSave(posts);
  renderForumPosts(posts);
}

function renderForumPosts(posts) {
  const body = $("forumBody");
  if (!body || !body.isConnected) return;
  body.innerHTML = "";
  /* 类型筛选片：全部 / 含资料 */
  if (!forumCtx.course) {
    const chips = el("div", "f-chips");
    const bAll = el("button", "f-chip" + (forumCtx.filesOnly ? "" : " on"), "全部帖子");
    bAll.addEventListener("click", () => { forumCtx.filesOnly = false; loadForumList(); });
    const bFiles = el("button", "f-chip" + (forumCtx.filesOnly ? " on" : ""), "📎 含资料");
    bFiles.addEventListener("click", () => { forumCtx.filesOnly = true; loadForumList(); });
    chips.appendChild(bAll);
    chips.appendChild(bFiles);
    body.appendChild(chips);
  }
  /* 课程过滤：从课程页进入时只看该课程的帖子 */
  let shown = forumCtx.course ? posts.filter(p => p.course_code === forumCtx.course) : posts;
  if (forumCtx.filesOnly) shown = shown.filter(p => p.file_path);
  if (forumCtx.course) {
    const bar = el("div", "f-tip");
    bar.appendChild(el("span", "", "只看该课程的讨论与资料 · "));
    const all = el("button", "f-linkbtn", "查看全部");
    all.addEventListener("click", () => showForum("list"));
    bar.appendChild(all);
    body.appendChild(bar);
  }
  if (!shown.length) {
    body.appendChild(el("div", "f-empty", (forumCtx.course ? "这门课还没有帖子，" : (forumCtx.filesOnly ? "还没有带资料的帖子，" : "还没有帖子，")) + "点右上角「✚ 发帖」抢个沙发～"));
    return;
  }
  for (const p of shown) {
    const card = el("div", "f-card");
    const titleRow = el("div", "f-title");
    titleRow.appendChild(el("span", "", p.title));
    /* 课程标签 + 附件角标 */
    if (p.course_code && courseMap[p.course_code]) {
      const tag = el("span", "f-tag", courseMap[p.course_code].name);
      tag.title = courseMap[p.course_code].name;
      tag.addEventListener("click", (ev) => {
        ev.stopPropagation();
        showForum("list", { course: p.course_code });
      });
      titleRow.appendChild(tag);
    }
    if (p.file_path) titleRow.appendChild(el("span", "f-tag f-tag-file", "📎 附件"));
    card.appendChild(titleRow);
    card.appendChild(el("div", "f-preview", (p.content || "").length > 64 ? p.content.slice(0, 64) + "…" : (p.content || "")));
    const meta = el("div", "f-meta");
    meta.appendChild(el("span", "", authorShort(p.author)));
    meta.appendChild(el("span", "", fmtTime(p.created_at)));
    if (mine(p.user_id)) meta.appendChild(delBtn("删除这条帖子？", () =>
      supabaseClient.from("forum_posts").delete().eq("id", p.id), () => loadForumList()));
    card.appendChild(meta);
    card.addEventListener("click", () => showForum("post", { postId: p.id }));
    body.appendChild(card);
  }
}

function delBtn(tip, doDelete, refresh) {
  const b = el("button", "f-del", "删除");
  b.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (!confirm(tip)) return;
    b.disabled = true;
    try {
      const { error } = await doDelete();
      if (error) throw error;
      toast("已删除");
      forumCacheClear();
      refresh();
    } catch (e) {
      toast("删除失败：" + (e.message || e));
      b.disabled = false;
    }
  });
  return b;
}

function loginBar(text) {
  const wrap = el("div", "f-compose");
  const bar = el("div", "f-loginbar");
  bar.appendChild(el("span", "", text));
  const b = el("button", "f-login-go", "去登录");
  b.addEventListener("click", () => showAuthModal());
  bar.appendChild(b);
  wrap.appendChild(bar);
  return wrap;
}

/* ---- 自由论坛：帖子详情（5 分钟内存缓存，进出详情页零请求） ---- */
const FORUM_DETAIL_MS = 5 * 60 * 1000;
const forumDetailMem = new Map();

async function loadForumPost(id) {
  const body = $("forumBody");
  if (!supabaseClient) { body.innerHTML = ""; body.appendChild(el("div", "f-empty", "云服务未就绪，请刷新页面后重试")); return; }
  const ck = "p:" + id;
  const hit = forumDetailMem.get(ck);
  if (hit && Date.now() - hit.ts < FORUM_DETAIL_MS) {
    renderForumPost(id, hit.post, hit.replies);
    return;
  }
  body.appendChild(el("div", "f-loading", "加载中…"));
  let post, replies;
  try {
    const r1 = await withFailover((c) => c.from("forum_posts").select("*").eq("id", id).single());
    if (r1.error) throw r1.error;
    post = r1.data;
    const r2 = await withFailover((c) => c.from("forum_replies")
      .select("*").eq("post_id", id).eq("is_deleted", false)
      .order("created_at", { ascending: true }).limit(200));
    if (r2.error) throw r2.error;
    replies = r2.data || [];
  } catch (e) {
    if (!body.isConnected) return;
    body.innerHTML = "";
    body.appendChild(el("div", "f-empty", "加载失败：" + (e.message || e)));
    return;
  }
  forumDetailMem.set(ck, { ts: Date.now(), post, replies });
  renderForumPost(id, post, replies);
}

function renderForumPost(id, post, replies) {
  const body = $("forumBody");
  if (!body || !body.isConnected) return;
  body.innerHTML = "";
  const main = el("div", "f-card f-main");
  main.appendChild(el("div", "f-title", post.title));
  if (post.course_code && courseMap[post.course_code]) {
    const tag = el("span", "f-tag", "🏷 " + courseMap[post.course_code].name);
    tag.title = courseMap[post.course_code].name;
    tag.addEventListener("click", () => showForum("list", { course: post.course_code }));
    main.appendChild(tag);
  }
  if (post.content) main.appendChild(el("div", "f-content", post.content));
  if (post.file_path) {
    const fc = el("button", "f-file f-file-btn");
    fc.appendChild(el("span", "", "📎"));
    fc.appendChild(el("span", "f-file-name", post.file_name || "附件"));
    fc.appendChild(el("span", "f-file-size", post.file_size ? " · " + fmtSize(post.file_size) : ""));
    fc.addEventListener("click", () => downloadForumFile(post));
    main.appendChild(fc);
  }
  const meta = el("div", "f-meta");
  meta.appendChild(el("span", "", authorShort(post.author)));
  meta.appendChild(el("span", "", fmtTime(post.created_at)));
  if (mine(post.user_id)) meta.appendChild(delBtn("删除这条帖子？", () =>
    supabaseClient.from("forum_posts").delete().eq("id", post.id), closeForum));
  main.appendChild(meta);
  body.appendChild(main);

  body.appendChild(el("div", "f-sep", replies.length ? "全部回复（" + replies.length + "）" : "还没有回复，来抢沙发～"));
  for (const r of replies) {
    const rc = el("div", "f-reply");
    rc.appendChild(el("div", "f-reply-head", authorShort(r.author) + " · " + fmtTime(r.created_at)));
    rc.appendChild(el("div", "f-reply-content", r.content));
    if (mine(r.user_id)) rc.appendChild(delBtn("删除这条回复？", () =>
      supabaseClient.from("forum_replies").delete().eq("id", r.id), () => loadForumPost(id)));
    body.appendChild(rc);
  }

  if (!authUser) {
    body.appendChild(loginBar("登录后即可回复"));
    return;
  }
  const form = el("div", "f-compose");
  const ta = el("textarea");
  ta.placeholder = "写下你的回复…（Ctrl+Enter 发送）";
  const btn = el("button", "f-send", "回复");
  bindAutoGrow(ta, 200);
  attachCount(ta, 2000);
  const send = async () => {
    const t = ta.value.trim();
    if (!t) { toast("回复不能为空"); return; }
    if (t.length > 2000) { toast("回复过长（≤2000 字）"); return; }
    btn.disabled = true; btn.textContent = "发送中…";
    try {
      const { error } = await supabaseClient.from("forum_replies").insert({
        post_id: id, user_id: authUser.id, author: authorShort(authUser.email), content: t
      });
      if (error) throw error;
      toast("回复成功");
      forumDetailMem.delete("p:" + id);
      loadForumPost(id);
    } catch (e) {
      toast("发送失败：" + (e.message || e));
      btn.disabled = false; btn.textContent = "回复";
    }
  };
  btn.addEventListener("click", send);
  ctrlEnter(ta, send);
  form.appendChild(ta);
  form.appendChild(btn);
  body.appendChild(form);
}

/* ---- 发帖弹窗：标题 + 可选关联课程 + 正文（纯文字；文件请去「资料共享」） ---- */
function composeForumPost(presetCourse) {
  showModal(`
    <div class="modal-card">
      <h3>发布新帖</h3>
      <div class="r-form">
        <input id="fpTitle" maxlength="80" placeholder="标题（1-80 字）">
        <select id="fpCourse"></select>
        <textarea id="fpContent" placeholder="正文（可留空，但需关联资料）" style="min-height:110px"></textarea>
      </div>
      <div class="f-compose-row" id="fpRow" style="margin-top:10px">
        <button class="r-btn ghost" id="fpAttach" type="button">📎 关联资料</button>
        <input id="fpFile" type="file" hidden>
        <span class="f-file-size" id="fpFileTip"></span>
      </div>
      <div class="modal-actions">
        <button class="ok" id="fpOk">发布</button>
        <button class="cancel" id="fpCancel">取消</button>
      </div>
    </div>`);
  const title = $("fpTitle");
  const content = $("fpContent");
  const sel = $("fpCourse");
  const attach = $("fpAttach");
  const fileIn = $("fpFile");
  const fileTip = $("fpFileTip");
  const o0 = el("option");
  o0.value = "";
  o0.textContent = "@ 不关联课程";
  sel.appendChild(o0);
  for (const code of state.codes) {
    const c = courseMap[code];
    if (!c) continue;
    const o = el("option");
    o.value = c.code;
    o.textContent = "@ " + (c.name.length > 18 ? c.name.slice(0, 18) + "…" : c.name);
    sel.appendChild(o);
  }
  if (presetCourse) sel.value = presetCourse;
  attach.addEventListener("click", () => fileIn.click());
  fileIn.addEventListener("change", () => {
    const f = fileIn.files[0];
    fileTip.textContent = f ? (f.name.length > 12 ? f.name.slice(0, 12) + "…" : f.name) + " · " + fmtSize(f.size) : "";
    attach.textContent = f ? "📎 已选资料" : "📎 关联资料";
  });
  attachCount(title, 80);
  attachCount(content, 4000);
  bindAutoGrow(content, 300);
  title.focus();
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sel.focus(); }
  });
  const publish = async () => {
    const t = title.value.trim();
    const c = content.value.trim();
    const code = sel.value || null;
    const f = fileIn.files[0];
    if (!t) { toast("请填写标题"); title.focus(); return; }
    if (!c && !f) { toast("写点正文，或关联一份资料"); content.focus(); return; }
    if (c.length > 4000) { toast("正文过长（≤4000 字）"); return; }
    if (f && f.size > FILE_MAX) { toast("资料不能超过 5MB"); return; }
    const ok = $("fpOk");
    ok.disabled = true;
    ok.textContent = f ? "上传中…" : "发布中…";
    try {
      let fileMeta = null;
      if (f) {
        const ext = (f.name.match(/\.[A-Za-z0-9]+$/) || [""])[0];
        const path = authUser.id + "/" + Date.now() + ext;
        const { error: uerr } = await supabaseClient.storage.from("forum-files").upload(path, f, { upsert: false });
        if (uerr) throw uerr;
        fileMeta = { file_path: path, file_name: f.name, file_size: f.size };
      }
      const { error } = await supabaseClient.from("forum_posts").insert(Object.assign({
        user_id: authUser.id, author: authorShort(authUser.email), title: t, content: c, course_code: code
      }, fileMeta));
      if (error) throw error;
      hideModal();
      toast("发布成功");
      forumCacheClear();
      loadForumList();
    } catch (e) {
      toast("发布失败：" + (e.message || e));
      ok.disabled = false;
      ok.textContent = "发布";
    }
  };
  $("fpOk").addEventListener("click", publish);
  ctrlEnter(content, publish);
  $("fpCancel").addEventListener("click", hideModal);
}

/* 登录态下载：带 token 走代理取回文件（私有桶，未登录被服务端拒绝） */
async function downloadForumFile(p) {
  try {
    toast("开始下载…");
    const { data, error } = await supabaseClient.storage.from("forum-files").download(p.file_path);
    if (error) throw error;
    const url = URL.createObjectURL(data);
    const a = el("a");
    a.href = url;
    a.download = p.file_name || "attachment";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("已下载");
  } catch (e) {
    toast("下载失败：" + (e.message || e));
  }
}

/* ---------------- 初始化 ---------------- */
function init() {
  loadState();
  const generate = () => {
    const raw = parseCodes($("codeInput").value);
    if (!raw.length) { toast("请先粘贴课程代码"); return; }
    addCodes(raw);
    if (state.codes.length) showMain();
  };
  bindSearch($("welcomeSearch"), $("welcomeSug"), () => {
    if (state.codes.length) showMain();
  });

  $("btnGenerate").addEventListener("click", generate);
  bindAutoGrow($("codeInput"), 300);
  ctrlEnter($("codeInput"), generate);
  $("btnShare").addEventListener("click", shareLink);
  $("btnLogin").addEventListener("click", showAuthModal);
  $("btnForum").addEventListener("click", () => {
    if (!authUser) { promptLogin("登录后才能浏览论坛"); return; }
    showForum("list");
  });
  $("btnMore").addEventListener("click", showMoreMenu);
  $("btnTheme").addEventListener("click", cycleTheme);
  applyTheme(themePref());
  /* 回到前台时刷新角标（今天剩余课程数） */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateAppBadge();
  });
  renderReplyBadge(); /* 启动时恢复未读红点（数据随心跳更新） */
  /* 安装提醒条按钮 */
  $("installGo").addEventListener("click", () => {
    try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch (e) {}
    $("installBar").classList.add("hidden");
    if (deferredPrompt) {
      try { deferredPrompt.prompt(); } catch (e) {}
      deferredPrompt = null;
      return;
    }
    showInstallGuide();
  });
  $("installX").addEventListener("click", () => {
    try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch (e) {}
    $("installBar").classList.add("hidden");
    toast("7 天内不再提醒，可在「更多」里随时安装");
  });

  /* 周次切换条 */
  $("wkPrev").addEventListener("click", () => {
    if (viewWeek == null) viewWeek = curWeek();
    viewWeek = Math.max(1, viewWeek - 1);
    smartRealignDay();
    render();
  });
  $("wkNext").addEventListener("click", () => {
    if (viewWeek == null) viewWeek = curWeek();
    viewWeek = Math.min(MAX_WEEK, viewWeek + 1);
    smartRealignDay();
    render();
  });
  $("wkAll").addEventListener("click", () => {
    viewWeek = viewWeek == null ? curWeek() : null;
    render();
  });
  $("wkLabel").addEventListener("click", () => {
    viewWeek = curWeek();
    smartRealignDay();
    render();
  });

  /* URL 分享参数 */
  const params = new URLSearchParams(location.search);
  const shared = parseCodes(params.get("c"));
  if (shared.length) {
    showModal(`
      <div class="modal-card">
        <h3>来自分享的课程代码</h3>
        <p>识别到 ${shared.length} 个课程代码，导入到你的课表？</p>
        <div class="modal-actions">
          <button class="ok" id="shOk">导入</button>
          <button class="cancel" id="shCancel">取消</button>
        </div>
      </div>`);
    $("shOk").addEventListener("click", () => { hideModal(); addCodes(shared); });
    $("shCancel").addEventListener("click", hideModal);
  } else {
    /* 邀请链接落地（?ref=尾号） */
    const ref = String(params.get("ref") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
    if (ref && !state.codes.length) {
      showModal(`
        <div class="modal-card">
          <div class="auth-logo">🎁</div>
          <h3>同学邀请你来用「课壳」</h3>
          <p class="share-hint">邀请码尾号 ${ref}<br>粘贴课程代码，3 秒生成整学期课表</p>
          <div class="modal-actions">
            <button class="ok" id="refGo">开始生成课表</button>
          </div>
        </div>`);
      $("refGo").addEventListener("click", hideModal);
    }
  }

  /* 默认视图: 本周；本周无课则顺延到最近有课的周 */
  if (state.codes.length) {
    const w0 = curWeek();
    const w = smartDefaultWeek();
    if (w !== w0) {
      viewWeek = w;
      /* 手机单日视图: 顺延后聚焦该周离今天最近的有课日（否则会停在"今天"的星期几上，常是空课日） */
      if (window.innerWidth <= 640) {
        const nd = nearestCourseDay(w, state.codes.map(code => courseMap[code]).filter(Boolean), new Date());
        if (nd) viewDay = nd;
      }
      setTimeout(() => toast("第" + w0 + "周无课，已显示第" + w + "周"), 600);
    }
  }

  /* 快捷方式深链（manifest shortcuts：长按图标 → 今日课程/下节课） */
  const jump = params.get("view");
  if ((jump === "today" || jump === "next") && state.codes.length) {
    viewWeek = curWeek();
    if (window.innerWidth <= 640) viewDay = dayIndexOfToday();
    if (jump === "next") {
      setTimeout(() => {
        const nx = findNextClass(state.codes.map(c => courseMap[c]).filter(Boolean), new Date());
        if (nx) showNextClassModal(nx);
        else toast("接下来 7 天没有课了 🎉");
      }, 400); /* 等首屏渲染完成 */
    }
  }

  render();
}

/* ---------------- 微信/QQ 内置浏览器引导（无法安装 PWA） ---------------- */
const IS_WECHAT = (typeof navigator !== "undefined") && /MicroMessenger|QQ\//i.test(navigator.userAgent);
function showWxGuide() {
  if (!IS_WECHAT) return;
  try { if (sessionStorage.getItem("kebiao:wxguide") === "1") return; } catch (e) {}
  const g = el("div", "wx-guide");
  g.appendChild(el("span", "", "📲 微信/QQ 内无法安装 App：点右上角 ⋯ 选「在浏览器打开」，即可装成手机应用"));
  const x = el("button", "wxg-x", "✕");
  x.addEventListener("click", () => {
    g.remove();
    try { sessionStorage.setItem("kebiao:wxguide", "1"); } catch (e) {}
  });
  g.appendChild(x);
  const tb = document.querySelector(".topbar");
  if (tb) tb.insertAdjacentElement("afterend", g);
}

if (typeof document !== "undefined") {
  initSupabase();
  const sessionReady = supabaseClient
    ? supabaseClient.auth.getSession().then(({ data }) => {
        if (data.session) { authUser = data.session.user; updateAuthUI(); }
      }).catch(() => {})
    : Promise.resolve();
  try { showWxGuide(); } catch (e) {} /* 纯装饰功能，绝不阻塞启动 */
  boot(sessionReady);
}

/* ---------------- 学校选择与启动 ---------------- */
function applySchoolConfig(cfg) {
  SCHOOL = cfg;
  if (cfg.periods) PERIOD_TIMES = cfg.periods;
  if (cfg.semesterMonday) SEMESTER_MONDAY = cfg.semesterMonday;
  if (cfg.maxWeek) MAX_WEEK = cfg.maxWeek;
  CAMPUS_NAME = {};
  for (const c of (cfg.campuses || [])) CAMPUS_NAME[c.code] = c.name;
  SCHOOL_SECTIONS = cfg.sections || null;
  if (cfg.name) document.title = "课表 · " + cfg.name;
  viewWeek = getSemesterWeek(new Date());
  viewDay = window.innerWidth <= 640 ? dayIndexOfToday() : 0;
}

async function loadSchoolAndStart(sid) {
  try {
    const cfgRes = await fetch("./data/schools/" + sid + ".json");
    if (!cfgRes.ok) throw new Error(cfgRes.status);
    const cfg = await cfgRes.json();
    applySchoolConfig(cfg);

    const catRes = await fetch(cfg.catalogUrl || ("./data/schools/" + sid + "-catalog.json"));
    if (!catRes.ok) throw new Error(catRes.status);
    const data = await catRes.json();
    catalog = data;
    courseMap = {};
    for (const c of catalog.courses) courseMap[c.code] = c;

    init();
    statsPing();
    if (authUser) pullAndMerge();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  } catch (err) {
    console.error("loadSchool", err);
    toast("该校数据加载失败，请检查网络后刷新");
    state.codes.length ? showMain() : showWelcome(); // 别白屏
  }
}

function showSchoolPicker(registry) {
  $("welcome").classList.add("hidden");
  $("main").classList.add("hidden");
  $("schoolPick").classList.remove("hidden");
  const list = $("schoolList");
  const renderList = (kw) => {
    list.innerHTML = "";
    const k = String(kw || "").trim().toLowerCase();
    for (const s of registry) {
      const hay = [s.name, s.short, s.alias, s.id].filter(Boolean).join(" ").toLowerCase();
      if (k && !hay.includes(k)) continue;
      const item = el("button", "school-item");
      item.appendChild(el("span", "si-name", s.name));
      if (s.short && s.short !== s.name) item.appendChild(el("span", "si-short", s.short));
      if (s.note) item.appendChild(el("span", "si-short", " · " + s.note));
      item.addEventListener("click", () => chooseSchool(s.id));
      list.appendChild(item);
    }
    if (!list.children.length) list.appendChild(el("div", "school-none", "未找到匹配的学校"));
  };
  renderList("");
  $("schoolSearch").addEventListener("input", () => renderList($("schoolSearch").value));
}

function chooseSchool(id) {
  try { localStorage.setItem(SCHOOL_KEY, id); } catch (e) {}
  $("schoolPick").classList.add("hidden");
  loadSchoolAndStart(id);
}

/* ---------------- 日活统计（零个人信息：随机设备ID + 会话去重 + 服务端按天聚合） ---------------- */
/* 心跳同时带回"我的帖子有新回复"计数（顺风车，零额外调用），驱动顶栏论坛按钮红点 */
const DID_KEY = "kebiao:did";
const REPLY_SEEN_KEY = "kebiao:replyseen";
const REPLY_BADGE_KEY = "kebiao:replybadge";
const REPLY_LATEST_KEY = "kebiao:replylatest";
let replyBadge = 0;
try { replyBadge = Number(localStorage.getItem(REPLY_BADGE_KEY)) || 0; } catch (e) {}
let replyLatest = null; /* 服务端时间戳：未读回复里最新一条的时间，用作已读游标（免疫本机时钟偏差） */
try { replyLatest = localStorage.getItem(REPLY_LATEST_KEY); } catch (e) {}
/* 身份编号：你是第 N 位课壳人（累计设备数，随心跳更新） */
let userNo = 0;
try { userNo = Number(localStorage.getItem("kebiao:userno")) || 0; } catch (e) {}
function renderIdentity() {
  if (typeof document === "undefined" || !userNo) return;
  const box = $("welcomeIdentity");
  if (!box) return;
  $("idNum").textContent = String(userNo);
  box.classList.remove("hidden");
}

function renderReplyBadge() {
  if (typeof document === "undefined") return;
  const b = $("btnForum");
  if (!b) return;
  let dot = b.querySelector(".n-dot");
  if (replyBadge > 0) {
    if (!dot) { dot = el("span", "n-dot"); b.appendChild(dot); }
    dot.textContent = replyBadge > 9 ? "9+" : String(replyBadge);
  } else if (dot) dot.remove();
}
function clearReplyBadge() {
  replyBadge = 0;
  try { localStorage.setItem(REPLY_BADGE_KEY, "0"); } catch (e) {}
  try { localStorage.setItem(REPLY_SEEN_KEY, replyLatest || new Date().toISOString()); } catch (e) {}
  renderReplyBadge();
}
function statsPing() {
  if (!supabaseClient || !online()) return;
  try {
    if (sessionStorage.getItem("kebiao:pinged") === "1") return;
    sessionStorage.setItem("kebiao:pinged", "1");
    let did = null;
    try { did = localStorage.getItem(DID_KEY); } catch (e) {}
    if (!did) {
      did = uid();
      try { localStorage.setItem(DID_KEY, did); } catch (e) {}
    }
    let since = null;
    try { since = localStorage.getItem(REPLY_SEEN_KEY); } catch (e) {}
    withFailover((c) => c.rpc("stats_ping", { p_device: did, p_since: since }))
      .then((res) => {
        const d = res && res.data;
        if (d && typeof d.n === "number") {
          replyBadge = d.n;
          try { localStorage.setItem(REPLY_BADGE_KEY, String(d.n)); } catch (e) {}
          if (d.latest) {
            replyLatest = d.latest;
            try { localStorage.setItem(REPLY_LATEST_KEY, String(d.latest)); } catch (e) {}
          }
          renderReplyBadge();
        }
        /* 身份编号：累计设备数（搭心跳车，零额外调用） */
        if (d && typeof d.devices === "number" && d.devices > 0) {
          userNo = d.devices;
          try { localStorage.setItem("kebiao:userno", String(d.devices)); } catch (e) {}
          renderIdentity();
        }
      }, () => {});
  } catch (e) {}
}

async function boot(sessionReady) {
  try {
    await sessionReady; /* 先等登录态就绪：避免已登录用户误见选校页/漏拉云端 */
    const res = await fetch("./data/schools.json");
    if (!res.ok) throw new Error(res.status);
    const registry = await res.json();

    let sid = null;
    try { sid = localStorage.getItem(SCHOOL_KEY); } catch (e) {}
    if (!sid) {
      /* 老用户（本地已有课表）或已登录用户 → 自动选默认学校(国科大)，不弹选择页 */
      let hasLocal = false;
      try { hasLocal = !!localStorage.getItem(STORE_KEY); } catch (e) {}
      const def = registry.find(s => s.default) || registry[0];
      if (hasLocal || authUser) {
        if (def) {
          sid = def.id;
          try { localStorage.setItem(SCHOOL_KEY, sid); } catch (e) {}
        }
      }
    }
    if (sid) await loadSchoolAndStart(sid);
    else showSchoolPicker(registry);
  } catch (err) {
    /* schools.json 不可用时兜底：走旧路径加载课程库 */
    console.error("boot", err);
    await legacyStart();
  }
}

async function legacyStart() {
  /* 兜底：schools.json 不可用时，按内置默认配置(国科大)直接加载课程库 */
  try {
    const r = await fetch("./data/schools/ucas-catalog.json");
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    catalog = data;
    courseMap = {};
    for (const c of catalog.courses) courseMap[c.code] = c;
    if (!SCHOOL) {
      SCHOOL = { id: "ucas", name: "中国科学院大学", short: "国科大" };
      viewWeek = getSemesterWeek(new Date());
      viewDay = window.innerWidth <= 640 ? dayIndexOfToday() : 0;
    }
    init();
    statsPing();
    if (authUser) pullAndMerge();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  } catch (e) {
    toast("课程库加载失败，请检查网络后刷新");
  }
}

/* 供 Node 单测 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeCode, parseCodes, weeksOverlap, sessionOverlap,
    conflictsBetween, findConflicts, fmtSession, daysLeft, DAY_NAMES, PERIOD_TIMES,
    getSemesterWeek, inWeekSet, fmtWeekRange, SEMESTER_MONDAY, MAX_WEEK,
    weekMonday, nearestCourseDay,
    effSlot,
    buildICS, icsDateFor,
    findNextClass, todayRemainingClasses,
    __setRecords: (o) => { state.records = o || {}; } /* 仅供测试注入微调数据 */
  };
}