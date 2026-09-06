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

/* ---------------- 云同步 (Supabase, 经 Netlify Function 反代) ---------------- */
/* 直连 *.supabase.co 在国内被 GFW 阻断，统一经 Netlify Function 转发。
   在 Netlify 站点打开时为同源；在 GitHub Pages 打开时跨域（Function 已带 CORS）。 */
const SUPABASE_FUNC_PATH = "/.netlify/functions/supabase";
const SUPABASE_URL = (typeof location !== "undefined" && location.hostname.endsWith("netlify.app"))
  ? location.origin + SUPABASE_FUNC_PATH
  : "https://kebiao-ucas.netlify.app" + SUPABASE_FUNC_PATH;
const SUPABASE_KEY = "sb_publishable_ONe5Ft1rxeRt-rcdruXYoQ_sM0jgwLn";

let supabaseClient = null;
let authUser = null;
let pushTimer = null;

function initSupabase() {
  if (typeof window !== "undefined" && window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
}

/* 本地修改后 800ms 内合并推送云端（登录状态下） */
function schedulePush() {
  if (!supabaseClient || !authUser) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushToCloud, 800);
}

async function pushToCloud() {
  if (!supabaseClient || !authUser) return;
  try {
    await supabaseClient.from("user_data").upsert({
      user_id: authUser.id,
      schedule: { codes: state.codes },
      records: state.records,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
  } catch (e) { console.warn("push failed", e); }
}

async function pullFromCloud() {
  if (!supabaseClient || !authUser) return null;
  try {
    const { data } = await supabaseClient.from("user_data")
      .select("schedule,records,updated_at").eq("user_id", authUser.id).maybeSingle();
    return data || null;
  } catch (e) { console.warn("pull failed", e); return null; }
}

function applyCloud(cloud) {
  const codes = (cloud && cloud.schedule && cloud.schedule.codes) || [];
  state.codes = codes.filter(c => courseMap[c]);
  state.records = cloud && cloud.records && typeof cloud.records === "object" ? cloud.records : {};
  saveState();
  render();
}

/* 登录后的数据合并：两端都有数据时按修改时间静默取舍（新的一方胜出），不再弹窗 */
async function pullAndMerge() {
  const cloud = await pullFromCloud();
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
      await pullAndMerge();
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
    await pullAndMerge();
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
        await pullAndMerge();
        return;
      }
      updateAuthUI();
      hideModal();
      toast("注册成功，正在同步…");
      await pullAndMerge();
    } catch (e) {
      toast("注册失败：" + (e.message || e));
    }
    $("suDone").disabled = false;
    $("suDone").textContent = "完成注册";
  });
  $("suBack").addEventListener("click", () => showAuthModal());
  $("suCancel").addEventListener("click", hideModal);
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
function showModal(html) { $("modal").innerHTML = html; $("modal").classList.remove("hidden"); }
function hideModal() { $("modal").classList.add("hidden"); }

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
    const conflicts = findConflicts(state.codes.map(c => courseMap[c]));
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
  $("welcome").classList.add("hidden");
  $("schoolPick").classList.add("hidden");
  $("main").classList.remove("hidden");
}
function showWelcome() {
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

  const conflicts = findConflicts(courses);
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
      if (!(s.day >= 1 && s.day <= 7 && s.p1 >= 1 && s.p2 >= s.p1 && s.p2 <= maxP)) continue;
      const key = `${c.code}|${s.day}|${s.p1}|${s.p2}|${s.weeks}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const span = s.p2 - s.p1 + 1;
      const sk = `${s.p1}-${s.day}`;
      (starts[sk] = starts[sk] || []).push({ course: c, session: s, span });
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
          const block = buildCourseBlock(gc.course, gc.session, conflictSess, viewWeek != null);
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
  am: ["上午没课，睡到自然醒 😴", "上午的空白，是赖床的许可 🛏️", "上午没课，去吃顿不慌不忙的早餐 🥣"],
  pm: ["下午没课，球场 / 图书馆 / 被窝三选一 🏸", "下午自由支配，来杯咖啡 ☕", "下午没课，去校园里走走 🍃"],
  eve: ["晚上没安排，追剧还是自习？📺", "晚风正好，去操场跑两圈 🏃", "晚上没课，早点睡 🌌"]
};
const DAY_FREE_EGGS = ["🎉 今天全天没课！来一场说走就走的……自习", "全天无课！这是本周最好的礼物 🎁", "今天零节课，快乐完全属于自己 🍰"];

function pickEgg(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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
  const wxDate = new Date(weekMonday(viewWeek));
  wxDate.setDate(wxDate.getDate() + viewDay - 1);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const dd = Math.round((wxDate - today0) / 86400000);
  if (dd < 0 || dd > 6) return null;

  const card = el("div", "day-sec day-wx");
  const head = el("div", "day-sec-head");
  head.appendChild(el("span", "day-sec-icon", "🌤"));
  const tt = el("div", "day-sec-title");
  tt.appendChild(el("span", "", dd === 0 ? "今日天气" : "当日天气"));
  const cc = weatherCampus();
  tt.appendChild(el("span", "day-sec-time", "逐小时" + (cc && CAMPUS_NAME[cc] ? " · " + CAMPUS_NAME[cc] : "")));
  head.appendChild(tt);
  card.appendChild(head);
  const strip = el("div", "wx-strip");
  strip.appendChild(el("div", "wx-none", "天气加载中…"));
  card.appendChild(strip);
  fillWeatherCard(strip, wxDate, dd);
  return card;
}

async function fillWeatherCard(strip, date, dd) {
  const coords = weatherCoords();
  if (!coords) { strip.innerHTML = ""; strip.appendChild(el("div", "wx-none", "暂无天气数据")); return; }
  try {
    const data = await getWeather(coords[0], coords[1]);
    if (!strip.isConnected) return; // 用户已切走视图
    const H = data.hourly;
    const ds = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    const nowH = new Date().getHours();
    strip.innerHTML = "";
    let centerEl = null;
    for (let i = 0; i < H.time.length; i++) {
      if (!H.time[i].startsWith(ds)) continue;
      const hh = Number(H.time[i].slice(11, 13));
      if (dd === 0 && hh < nowH) continue; // 今天只显示未过去的时段
      const isNow = dd === 0 && hh === nowH;
      const item = el("div", "wx-h" + (isNow ? " wx-now" : ""));
      item.appendChild(el("span", "wx-t", isNow ? "现在" : hh + "时"));
      item.appendChild(el("span", "wx-i", wmoIcon(H.weather_code[i])));
      item.appendChild(el("span", "wx-d", Math.round(H.temperature_2m[i]) + "°"));
      const p = H.precipitation_probability ? H.precipitation_probability[i] : null;
      item.appendChild(el("span", "wx-p", p != null && p >= 20 ? "💧" + p + "%" : ""));
      strip.appendChild(item);
      if (isNow) centerEl = item;                 // 今天: 当前小时居中
      else if (dd > 0 && hh === 12) centerEl = item; // 未来日: 中午居中
    }
    if (!strip.children.length) {
      strip.appendChild(el("div", "wx-none", "暂无预报"));
    } else if (centerEl) {
      /* 默认将目标小时滚动到条带中央 */
      requestAnimationFrame(() => {
        strip.scrollLeft = Math.max(0, centerEl.offsetLeft - (strip.clientWidth - centerEl.offsetWidth) / 2);
      });
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
      if (s.day !== day) continue;
      if (!(s.p1 >= 1 && s.p2 >= s.p1 && s.p2 <= maxP)) continue;
      const key = c.code + "|" + s.p1 + "|" + s.p2 + "|" + s.weeks;
      if (placed.has(key)) continue;
      placed.add(key);
      sess.push({ course: c, p1: s.p1, p2: s.p2, room: s.room });
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

  /* 全天空课: 大彩蛋 */
  if (!blocks.length) {
    const card = el("div", "day-sec");
    card.appendChild(el("div", "day-free", pickEgg(DAY_FREE_EGGS)));
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
      const eggs = DAY_EGGS[sec.id] || ["这段时间没课，自由安排 🌈", "空档期，适合发呆或冲刺 ✨"];
      card.appendChild(el("div", "day-empty", pickEgg(eggs)));
    } else {
      for (const b of list) {
        const blk = el("div", "day-block " + attrClass(b.course.attr));
        blk.appendChild(el("div", "cc-name", b.course.name));
        const t1 = (PERIOD_TIMES[b.p1] || "").split("-")[0];
        const t2 = (PERIOD_TIMES[b.p2] || "").split("-")[1];
        blk.appendChild(el("div", "db-time", "第" + b.p1 + (b.p2 > b.p1 ? "-" + b.p2 : "") + "节 · " + t1 + " – " + t2));
        const meta = [b.course.teacher, b.room].filter(Boolean).join(" · ");
        if (meta) blk.appendChild(el("div", "cc-meta", meta));
        blk.addEventListener("click", () => openDrawer(b.course.code));
        card.appendChild(blk);
      }
    }
    host.appendChild(card);
  }
}

/* 课程块：课程名 / 教师·教室 / 周次（对齐 Excel 版）；周视图下不重复显示周次 */
function buildCourseBlock(course, session, conflictSess, weekView) {
  const isConflict = conflictSess.has(`${session.day}-${session.p1}-${session.p2}`);
  const block = el("div", "course-cell " + attrClass(course.attr) + (isConflict ? " conflict" : ""));
  block.appendChild(el("div", "cc-name", course.name));
  const meta = [];
  if (course.teacher) meta.push(course.teacher);
  if (session.room) meta.push(session.room);
  if (meta.length) block.appendChild(el("div", "cc-meta", meta.join(" · ")));
  if (!weekView) block.appendChild(el("div", "cc-weeks", session.weeks));
  if (isConflict) block.appendChild(el("span", "cc-conflict-tag", "冲突"));
  return block;
}

/* ---------------- 搜索 ---------------- */
function bindSearch(inputEl, sugEl, onPick) {
  let timer = null;
  inputEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = inputEl.value.trim();
      if (!q) { sugEl.innerHTML = ""; return; }
      const ql = q.toLowerCase();
      const hits = [];
      for (const c of catalog.courses) {
        if (c.name.toLowerCase().includes(ql) || c.code.toLowerCase().includes(ql)) {
          hits.push(c);
          if (hits.length >= 12) break;
        }
      }
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
        meta.textContent = `${c.credit != null ? c.credit + "分" : ""} ${c.teacher || ""}${first ? " · " + fmtSession(first) : " · 时间待定"}`;
        item.appendChild(name);
        item.appendChild(meta);
        item.addEventListener("click", () => {
          sugEl.innerHTML = "";
          inputEl.value = "";
          addCodes([c.code]);
          if (onPick) onPick();
        });
        sugEl.appendChild(item);
      }
    }, 150);
  });
  document.addEventListener("click", (e) => {
    if (!sugEl.contains(e.target) && e.target !== inputEl) sugEl.innerHTML = "";
  });
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
if (typeof document !== "undefined") {
  $("overlay").addEventListener("click", closeDrawer);
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
      ss.appendChild(el("div", "s", `${fmtSession(s)} · ${s.weeks}${s.room ? " · " + s.room : ""}`));
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

  const forumBtn = el("button", "r-btn ghost", "💬 讨论与资料区");
  forumBtn.addEventListener("click", () => {
    closeDrawer();
    showForum("course", { courseCode: c.code });
  });
  d.appendChild(forumBtn);

  const delBtn = el("button", "r-btn danger", "从课表移除这门课");
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
  const saveBtn = el("button", "r-btn", "保存笔记");
  saveBtn.addEventListener("click", () => {
    const title = titleIn.value.trim() || "未命名笔记";
    const content = contentIn.value.trim();
    if (!content) { toast("笔记内容为空"); return; }
    if (noteEditing) {
      const n = rec.notes.find(x => x.id === noteEditing);
      if (n) { n.date = dateIn.value; n.title = title; n.content = content; }
      noteEditing = null;
    } else {
      rec.notes.push({ id: uid(), date: dateIn.value, title, content });
    }
    saveState();
    renderDrawer();
    toast("已保存");
  });
  form.appendChild(row2);
  form.appendChild(contentIn);
  form.appendChild(saveBtn);
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
      box.scrollIntoView({ block: "start" });
    });
    del.addEventListener("click", () => {
      rec.notes = rec.notes.filter(x => x.id !== n.id);
      saveState(); renderDrawer();
    });
    row.appendChild(edit);
    row.appendChild(del);
    item.appendChild(row);
    item.appendChild(el("div", "c", n.content));
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
    });
    del.addEventListener("click", () => {
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
    });
    del.addEventListener("click", () => {
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
  $("codesOk").addEventListener("click", () => {
    const raw = parseCodes($("codesText").value);
    if (!raw.length) { toast("没有有效的课程代码"); return; }
    hideModal();
    addCodes(raw);
  });
  $("codesCancel").addEventListener("click", hideModal);
}

/* ---------------- 更多菜单（论坛/代码/备份收纳于此） ---------------- */
function showMoreMenu() {
  showModal(`
    <div class="modal-card">
      <h3>更多</h3>
      <div class="menu-list">
        <button class="menu-item" id="mmCodes"><span class="mi-ico">⌨️</span><span>粘贴课程代码</span></button>
        <button class="menu-item" id="mmBackup"><span class="mi-ico">⤓</span><span>备份与恢复</span></button>
      </div>
    </div>`);
  $("mmCodes").addEventListener("click", () => { hideModal(); showCodesModal(); });
  $("mmBackup").addEventListener("click", () => { hideModal(); backupModal(); });
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
  "「课表」— 国科大人自己的课表工具",
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

function refTail() {
  if (!authUser) return "";
  const digits = String(authUser.email || "").split("@")[0].replace(/\D/g, "");
  return digits.slice(-4) || String(authUser.id || "").slice(-4);
}

function shareLink() {
  const tail = refTail();
  const url = SHARE_URL + (tail ? "?ref=" + tail : "");
  const full = SHARE_TEXT + "\n👉 " + url;
  showModal(`
    <div class="modal-card">
      <h3>推荐「课表」给同学</h3>
      <p class="share-hint">课表图片在群里最直观 · 文案已备好</p>
      <div class="share-text">${SHARE_TEXT}
👉 ${url}</div>
      <div class="share-actions">
        <button class="sa-main" id="shImg">📸 生成课表图片并分享</button>
        <button class="sa-alt" id="shText">发送文案 + 链接</button>
        <button class="sa-alt" id="shUrl">只复制链接</button>
      </div>
    </div>`);
  $("shImg").addEventListener("click", shareImage);
  $("shText").addEventListener("click", () => {
    if (typeof navigator.share === "function") {
      navigator.share({ title: "课表 · 国科大课程表", text: SHARE_TEXT, url }).catch(() => {});
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

/* ---------------- 课表图片（canvas 渲染 → 系统分享/保存） ---------------- */
const CANVAS_FONT = "'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif";
function attrFill(attr) {
  if (/核心/.test(attr || "")) return "#E3EFFC";
  if (/专业课/.test(attr || "")) return "#FCF1E3";
  if (/公共/.test(attr || "")) return "#FBEBF2";
  if (/研讨/.test(attr || "")) return "#E4F4F2";
  if (/实验|实践/.test(attr || "")) return "#F6F1DE";
  return "#EFF1F5";
}
function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapCanvasText(ctx, text, maxW, maxLines) {
  const lines = [];
  let cur = "";
  for (const ch of String(text)) {
    if (cur && ctx.measureText(cur + ch).width > maxW) {
      lines.push(cur);
      if (lines.length === maxLines) { lines[maxLines - 1] += "…"; return lines; }
      cur = ch;
    } else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

function drawShareImage() {
  if (!state.codes.length) { toast("先添加课程再生成图片"); return null; }
  const wk = viewWeek == null ? curWeek() : viewWeek;
  const courses = state.codes.map(c => courseMap[c]).filter(Boolean)
    .map(c => ({ ...c, sessions: (c.sessions || []).filter(s => inWeekSet(s.weekSet, wk)) }))
    .filter(c => c.sessions.length);
  if (!courses.length) { toast("本周没有课程，换一周再生成"); return null; }

  const maxP = Math.max.apply(null, Object.keys(PERIOD_TIMES).map(Number));
  const W = 1080, margin = 36, timeW = 92, headH = 56, brandH = 116, footH = 76;
  const cellW = (W - margin * 2 - timeW) / 7;
  const rowH = 88;
  const H = brandH + headH + rowH * maxP + footH;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");

  ctx.fillStyle = "#f6f7fb"; ctx.fillRect(0, 0, W, H);

  /* 品牌行 */
  ctx.fillStyle = "#2F6FED";
  roundRectPath(ctx, margin, 30, 56, 56, 14); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = "700 30px " + CANVAS_FONT;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("课", margin + 28, 60);
  ctx.textAlign = "left";
  ctx.fillStyle = "#1f2329"; ctx.font = "700 32px " + CANVAS_FONT;
  ctx.fillText("课表", margin + 70, 52);
  ctx.fillStyle = "#8a919c"; ctx.font = "400 20px " + CANVAS_FONT;
  const term = (catalog && catalog.meta && catalog.meta.term) || "";
  ctx.fillText((term ? term + " · " : "") + "第 " + wk + " 周", margin + 70, 84);

  const ox = margin + timeW, oy = brandH;
  const today = dayIndexOfToday();
  const isCur = wk === curWeek();

  /* 表头（本周时高亮今天列） */
  for (let d = 1; d <= 7; d++) {
    const cx = ox + cellW * (d - 1) + cellW / 2;
    if (isCur && d === today) {
      ctx.fillStyle = "#2F6FED";
      roundRectPath(ctx, ox + cellW * (d - 1) + 5, oy + 5, cellW - 10, headH - 10, 10); ctx.fill();
      ctx.fillStyle = "#fff";
    } else ctx.fillStyle = "#1f2329";
    ctx.font = "600 23px " + CANVAS_FONT;
    ctx.fillText(DAY_NAMES[d - 1], cx, oy + headH / 2);
  }

  /* 网格线 + 时间列 */
  ctx.fillStyle = "#fbfcfd"; ctx.fillRect(margin, oy, timeW, rowH * maxP);
  ctx.strokeStyle = "#e6e9f0"; ctx.lineWidth = 1;
  for (let p = 0; p <= maxP; p++) {
    const y = oy + headH + rowH * p;
    ctx.beginPath(); ctx.moveTo(margin, y); ctx.lineTo(W - margin, y); ctx.stroke();
  }
  for (let d = 0; d <= 7; d++) {
    const x = ox + cellW * d;
    ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy + headH + rowH * maxP); ctx.stroke();
  }
  for (let p = 1; p <= maxP; p++) {
    const cy = oy + headH + rowH * (p - 1) + rowH / 2;
    ctx.textAlign = "center";
    ctx.fillStyle = "#1f2329"; ctx.font = "600 22px " + CANVAS_FONT;
    ctx.fillText(String(p), margin + timeW / 2, cy - 11);
    ctx.fillStyle = "#8a919c"; ctx.font = "400 13px " + CANVAS_FONT;
    ctx.fillText((PERIOD_TIMES[p] || "").split("-")[0], margin + timeW / 2, cy + 15);
  }

  /* 放置课程块（列内截断，与网页逻辑一致） */
  const starts = {};
  for (const c of courses) {
    for (const s of c.sessions) {
      if (!(s.day >= 1 && s.day <= 7 && s.p1 >= 1 && s.p2 >= s.p1 && s.p2 <= maxP)) continue;
      (starts[s.p1 + "-" + s.day] = starts[s.p1 + "-" + s.day] || []).push({ c, s, span: s.p2 - s.p1 + 1 });
    }
  }
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
  for (const sk of Object.keys(starts)) {
    const [p, d] = sk.split("-").map(Number);
    const list = starts[sk];
    const n = list.length;
    const cw = (cellW - 8 - (n - 1) * 4) / n;
    for (let k = 0; k < n; k++) {
      const it = list[k];
      const x = ox + cellW * (d - 1) + 4 + k * (cw + 4);
      const y = oy + headH + rowH * (p - 1) + 4;
      const w = cw, h = it.span * rowH - 8;
      ctx.fillStyle = attrFill(it.c.attr);
      roundRectPath(ctx, x, y, w, h, 8); ctx.fill();

      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = "#243047"; ctx.font = "600 20px " + CANVAS_FONT;
      let ty = y + 7;
      for (const ln of wrapCanvasText(ctx, it.c.name, w - 14, 3)) {
        ctx.fillText(ln, x + 7, ty); ty += 25;
      }
      const meta = [it.c.teacher, it.s.room].filter(Boolean).join(" · ");
      if (meta && ty + 18 < y + h) {
        ctx.fillStyle = "#6d7686"; ctx.font = "400 14px " + CANVAS_FONT;
        ctx.fillText(wrapCanvasText(ctx, meta, w - 14, 1)[0] || "", x + 7, ty + 1);
      }
    }
  }

  /* 页脚水印 */
  ctx.fillStyle = "#8a919c"; ctx.font = "400 17px " + CANVAS_FONT;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("数据仅供参考，以教务系统为准 · 生成你的课表 👉 jiad88376-coder.github.io/kebiao-ucas", W / 2, oy + headH + rowH * maxP + footH / 2);

  return cv;
}

function shareImage() {
  const cv = drawShareImage();
  if (!cv) return;
  const wk = viewWeek == null ? curWeek() : viewWeek;
  cv.toBlob((blob) => {
    if (!blob) { toast("图片生成失败"); return; }
    const file = new File([blob], "kebiao.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: "我的课表" }).catch(() => {});
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "kebiao-week" + wk + ".png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("课表图片已保存，发群里安利同学吧");
    }
    hideModal();
  }, "image/png");
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
  opts = opts || {};
  forumCtx = Object.assign({ mode: mode || "list" }, opts);
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
  if (forumCtx.mode === "course") title = (courseMap[forumCtx.courseCode] || {}).name || forumCtx.courseCode;
  head.appendChild(el("span", "fb-title", title));
  if (forumCtx.mode === "list") {
    const nb = el("button", "fb-new", "✚ 发帖");
    nb.addEventListener("click", () => {
      if (!authUser) { promptLogin("登录后才能发帖"); return; }
      composeForumPost();
    });
    head.appendChild(nb);
  }
  $("forumBody").innerHTML = "";
  if (forumCtx.mode === "list") loadForumList();
  if (forumCtx.mode === "post") loadForumPost(forumCtx.postId);
  if (forumCtx.mode === "course") loadCourseForum(forumCtx.courseCode);
}

/* ---- 自由论坛：列表 ---- */
async function loadForumList() {
  const body = $("forumBody");
  if (!supabaseClient) { body.innerHTML = ""; body.appendChild(el("div", "f-empty", "云服务未就绪，请刷新页面后重试")); return; }
  body.appendChild(el("div", "f-loading", "加载中…"));
  let posts;
  try {
    const { data, error } = await supabaseClient.from("forum_posts")
      .select("id,user_id,author,title,content,created_at")
      .eq("is_deleted", false).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    posts = data || [];
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", "f-empty", "加载失败：" + (e.message || e)));
    return;
  }
  body.innerHTML = "";
  if (!posts.length) {
    body.appendChild(el("div", "f-empty", "还没有帖子，点右上角「✚ 发帖」抢个沙发～"));
    return;
  }
  for (const p of posts) {
    const card = el("div", "f-card");
    card.appendChild(el("div", "f-title", p.title));
    card.appendChild(el("div", "f-preview", p.content.length > 64 ? p.content.slice(0, 64) + "…" : p.content));
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

/* ---- 自由论坛：帖子详情 ---- */
async function loadForumPost(id) {
  const body = $("forumBody");
  if (!supabaseClient) { body.innerHTML = ""; body.appendChild(el("div", "f-empty", "云服务未就绪，请刷新页面后重试")); return; }
  body.appendChild(el("div", "f-loading", "加载中…"));
  let post, replies;
  try {
    const r1 = await supabaseClient.from("forum_posts").select("*").eq("id", id).single();
    if (r1.error) throw r1.error;
    post = r1.data;
    const r2 = await supabaseClient.from("forum_replies")
      .select("*").eq("post_id", id).eq("is_deleted", false)
      .order("created_at", { ascending: true }).limit(200);
    if (r2.error) throw r2.error;
    replies = r2.data || [];
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", "f-empty", "加载失败：" + (e.message || e)));
    return;
  }
  body.innerHTML = "";
  const main = el("div", "f-card f-main");
  main.appendChild(el("div", "f-title", post.title));
  main.appendChild(el("div", "f-content", post.content));
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
  ta.placeholder = "写下你的回复…";
  const btn = el("button", "f-send", "回复");
  btn.addEventListener("click", async () => {
    const t = ta.value.trim();
    if (!t) { toast("回复不能为空"); return; }
    if (t.length > 2000) { toast("回复过长（≤2000 字）"); return; }
    btn.disabled = true; btn.textContent = "发送中…";
    try {
      const { error } = await supabaseClient.from("forum_replies").insert({
        post_id: id, user_id: authUser.id, author: authUser.email, content: t
      });
      if (error) throw error;
      toast("回复成功");
      loadForumPost(id);
    } catch (e) {
      toast("发送失败：" + (e.message || e));
      btn.disabled = false; btn.textContent = "回复";
    }
  });
  form.appendChild(ta);
  form.appendChild(btn);
  body.appendChild(form);
}

/* ---- 自由论坛：发帖弹窗 ---- */
function composeForumPost() {
  showModal(`
    <div class="modal-card">
      <h3>发布新帖</h3>
      <div class="r-form">
        <input id="fpTitle" maxlength="80" placeholder="标题（1-80 字）">
        <textarea id="fpContent" placeholder="正文（1-4000 字）" style="min-height:130px"></textarea>
      </div>
      <div class="modal-actions">
        <button class="ok" id="fpOk">发布</button>
        <button class="cancel" id="fpCancel">取消</button>
      </div>
    </div>`);
  $("fpOk").addEventListener("click", async () => {
    const title = $("fpTitle").value.trim();
    const content = $("fpContent").value.trim();
    if (!title) { toast("请填写标题"); return; }
    if (!content) { toast("请填写正文"); return; }
    $("fpOk").disabled = true;
    try {
      const { error } = await supabaseClient.from("forum_posts").insert({
        user_id: authUser.id, author: authUser.email, title, content
      });
      if (error) throw error;
      hideModal();
      toast("发布成功");
      loadForumList();
    } catch (e) {
      toast("发布失败：" + (e.message || e));
      $("fpOk").disabled = false;
    }
  });
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

/* ---- 课程区：讨论与资料 ---- */
async function loadCourseForum(code) {
  const body = $("forumBody");
  if (!supabaseClient) { body.innerHTML = ""; body.appendChild(el("div", "f-empty", "云服务未就绪，请刷新页面后重试")); return; }
  body.appendChild(el("div", "f-loading", "加载中…"));
  let posts;
  try {
    const { data, error } = await supabaseClient.from("course_posts")
      .select("*").eq("course_code", code).eq("is_deleted", false)
      .order("created_at", { ascending: true }).limit(200);
    if (error) throw error;
    posts = data || [];
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", "f-empty", "加载失败：" + (e.message || e)));
    return;
  }
  body.innerHTML = "";
  body.appendChild(el("div", "f-tip", "课程交流与资料共享区 · 文件 ≤ 5MB · 请勿上传侵权或违规内容，违规将被移除"));
  if (!posts.length) body.appendChild(el("div", "f-empty", "还没有讨论或资料，来发第一条吧"));
  for (const p of posts) {
    const card = el("div", "f-card f-cp" + (mine(p.user_id) ? " mine" : ""));
    card.appendChild(el("div", "f-reply-head", authorShort(p.author) + " · " + fmtTime(p.created_at)));
    if (p.content) card.appendChild(el("div", "f-reply-content", p.content));
    if (p.file_path) {
      const fc = el(authUser ? "button" : "div", "f-file" + (authUser ? " f-file-btn" : ""));
      const nm = el("span", "f-file-name", p.file_name || "附件");
      const sz = el("span", "f-file-size", p.file_size ? " · " + fmtSize(p.file_size) : "");
      fc.appendChild(el("span", "", "📎"));
      fc.appendChild(nm); fc.appendChild(sz);
      if (authUser) {
        fc.addEventListener("click", () => downloadForumFile(p));
      } else {
        fc.style.cursor = "pointer";
        fc.addEventListener("click", () => promptLogin("登录后才能下载资料"));
      }
      card.appendChild(fc);
    }
    const meta = el("div", "f-meta");
    if (mine(p.user_id)) meta.appendChild(delBtn("删除这条内容？", () =>
      supabaseClient.from("course_posts").delete().eq("id", p.id), () => loadCourseForum(code)));
    card.appendChild(meta);
    body.appendChild(card);
  }

  if (!authUser) {
    body.appendChild(loginBar("登录后才能发言和上传/下载资料"));
    return;
  }
  const form = el("div", "f-compose");
  const ta = el("textarea");
  ta.placeholder = "说点什么，或分享资料…（可只发文件）";
  const row = el("div", "f-compose-row");
  const attach = el("button", "r-btn ghost", "📎 附件");
  const fileIn = el("input");
  fileIn.type = "file"; fileIn.hidden = true;
  attach.addEventListener("click", () => fileIn.click());
  fileIn.addEventListener("change", () => {
    const f = fileIn.files[0];
    attach.textContent = f ? "📎 " + (f.name.length > 10 ? f.name.slice(0, 10) + "…" : f.name) : "📎 附件";
  });
  const btn = el("button", "f-send", "发送");
  btn.addEventListener("click", async () => {
    const text = ta.value.trim();
    const f = fileIn.files[0];
    if (!text && !f) { toast("写点内容或选择附件"); return; }
    if (text.length > 2000) { toast("文字过长（≤2000 字）"); return; }
    if (f && f.size > FILE_MAX) { toast("附件不能超过 5MB"); return; }
    btn.disabled = true; attach.disabled = true;
    btn.textContent = f ? "上传中…" : "发送中…";
    try {
      let fileMeta = null;
      if (f) {
        const ext = (f.name.match(/\.[A-Za-z0-9]+$/) || [""])[0];
        const path = authUser.id + "/" + code + "-" + Date.now() + ext;
        const { error: uerr } = await supabaseClient.storage.from("forum-files").upload(path, f, { upsert: false });
        if (uerr) throw uerr;
        fileMeta = { file_path: path, file_name: f.name, file_size: f.size };
      }
      const { error } = await supabaseClient.from("course_posts").insert(Object.assign({
        course_code: code, user_id: authUser.id, author: authUser.email, content: text
      }, fileMeta));
      if (error) throw error;
      toast(f ? "资料已上传" : "已发送");
      loadCourseForum(code);
    } catch (e) {
      toast("发送失败：" + (e.message || e));
      btn.disabled = false; attach.disabled = false; btn.textContent = "发送";
    }
  });
  row.appendChild(attach);
  row.appendChild(btn);
  form.appendChild(ta);
  form.appendChild(row);
  body.appendChild(form);
  body.appendChild(fileIn);
}

/* ---------------- 初始化 ---------------- */
function init() {
  loadState();
  bindSearch($("searchInput"), $("suggestions"));
  bindSearch($("welcomeSearch"), $("welcomeSug"), () => {
    if (state.codes.length) showMain();
  });

  $("btnGenerate").addEventListener("click", () => {
    const raw = parseCodes($("codeInput").value);
    if (!raw.length) { toast("请先粘贴课程代码"); return; }
    addCodes(raw);
    if (state.codes.length) showMain();
  });
  $("btnShare").addEventListener("click", shareLink);
  $("btnLogin").addEventListener("click", showAuthModal);
  $("btnForum").addEventListener("click", () => showForum("list"));
  $("btnMore").addEventListener("click", showMoreMenu);
  $("btnTheme").addEventListener("click", cycleTheme);
  applyTheme(themePref());

  /* 周次切换条 */
  $("wkPrev").addEventListener("click", () => {
    if (viewWeek == null) viewWeek = curWeek();
    viewWeek = Math.max(1, viewWeek - 1);
    render();
  });
  $("wkNext").addEventListener("click", () => {
    if (viewWeek == null) viewWeek = curWeek();
    viewWeek = Math.min(MAX_WEEK, viewWeek + 1);
    render();
  });
  $("wkAll").addEventListener("click", () => {
    viewWeek = viewWeek == null ? curWeek() : null;
    render();
  });
  $("wkLabel").addEventListener("click", () => {
    viewWeek = curWeek();
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
          <h3>同学邀请你来用「课表」</h3>
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
      setTimeout(() => toast("第" + w0 + "周无课，已显示第" + w + "周"), 600);
    }
  }

  render();
}

if (typeof document !== "undefined") {
  initSupabase();
  const sessionReady = supabaseClient
    ? supabaseClient.auth.getSession().then(({ data }) => {
        if (data.session) { authUser = data.session.user; updateAuthUI(); }
      }).catch(() => {})
    : Promise.resolve();
  showWxGuide();
  boot(sessionReady);
}

/* ---------------- 微信内置浏览器引导（无法安装 PWA） ---------------- */
const IS_WECHAT = (typeof navigator !== "undefined") && /MicroMessenger/i.test(navigator.userAgent);
function showWxGuide() {
  if (!IS_WECHAT) return;
  try { if (sessionStorage.getItem("kebiao:wxguide") === "1") return; } catch (e) {}
  const g = el("div", "wx-guide");
  g.appendChild(el("span", "", "📲 微信内无法安装 App：点右上角 ⋯ 选「在浏览器打开」，即可装成手机应用"));
  const x = el("button", "wxg-x", "✕");
  x.addEventListener("click", () => {
    g.remove();
    try { sessionStorage.setItem("kebiao:wxguide", "1"); } catch (e) {}
  });
  g.appendChild(x);
  const tb = document.querySelector(".topbar");
  if (tb) tb.insertAdjacentElement("afterend", g);
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
    if (authUser) pullAndMerge();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  } catch (err) {
    console.error("loadSchool", err);
    toast("该校数据加载失败，请检查网络后刷新");
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
      if (k && !((s.name || "").toLowerCase().includes(k) || (s.short || "").toLowerCase().includes(k) || (s.id || "").includes(k))) continue;
      const item = el("button", "school-item");
      item.appendChild(el("span", "si-name", s.name));
      if (s.short && s.short !== s.name) item.appendChild(el("span", "si-short", s.short));
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
    getSemesterWeek, inWeekSet, fmtWeekRange, SEMESTER_MONDAY, MAX_WEEK
  };
}