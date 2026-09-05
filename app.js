/* ================================================================
 * 课表 · 国科大课程表 (kebiao-ucas)
 * 数据: data/catalog.json  |  个人数据: localStorage(仅本机)
 * ================================================================ */
'use strict';

/* ---------------- 纯逻辑（可测试） ---------------- */
const PERIOD_TIMES = {
  1: "8:30-9:15", 2: "9:20-10:05", 3: "10:25-11:10", 4: "11:15-12:00",
  5: "13:30-14:15", 6: "14:20-15:05", 7: "15:25-16:10", 8: "16:15-17:00",
  9: "17:05-17:50", 10: "18:30-19:15", 11: "19:20-20:05", 12: "20:15-21:00", 13: "21:05-21:50"
};
const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const CAMPUS_NAME = { H: "怀柔", Y: "玉泉", Z: "中关村" };

function normalizeCode(raw) {
  if (raw == null) return "";
  let s = String(raw).trim().toUpperCase();
  s = s.replace(/[^\u4e00-\u9fa5A-Z0-9-]/g, ""); // 容忍全角/空格/标点
  return s;
}

function parseCodes(text) {
  const parts = String(text || "").split(/[\s,，;；、]+/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const c = normalizeCode(p);
    if (c && c.length >= 8 && !seen.has(c)) { seen.add(c); out.push(c); }
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
const SEMESTER_MONDAY = "2026-08-31"; // 第 1 周周一
const MAX_WEEK = 25;

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

function currentPeriod() {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  const t = { "1": [510, 555], "2": [560, 605], "3": [625, 670], "4": [675, 720],
              "5": [810, 855], "6": [860, 905], "7": [925, 970], "8": [975, 1020],
              "9": [1025, 1070], "10": [1110, 1155], "11": [1160, 1205], "12": [1215, 1260], "13": [1265, 1310] };
  for (const p of Object.keys(t)) {
    const [a, b] = t[p];
    if (hm >= a && hm <= b + 5) return Number(p);
  }
  return 0;
}

/* 剩余天数（负数=已过/逾期；0=今天） */
function daysLeft(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

/* ---------------- 应用状态 ---------------- */
const STORE_KEY = "kebiao:ucas:v1";
const CATALOG_URL = "./data/catalog.json";
let viewWeek = getSemesterWeek(new Date()); // 默认显示本周；null=全部周次

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
      .select("schedule,records").eq("user_id", authUser.id).maybeSingle();
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

/* 登录后的数据合并：两端都有数据时让用户选择方向 */
async function pullAndMerge() {
  const cloud = await pullFromCloud();
  const localHas = state.codes.length > 0;
  const cloudHas = !!(cloud && cloud.schedule && cloud.schedule.codes && cloud.schedule.codes.length);
  if (cloudHas && localHas) {
    showModal(`
      <h3>发现两端都有课表</h3>
      <p style="color:var(--muted);font-size:13px">
        本机：${state.codes.length} 门课 &nbsp;·&nbsp; 云端：${cloud.schedule.codes.length} 门课</p>
      <div class="modal-actions">
        <button class="ok" id="mgDownload">下载云端（覆盖本机）</button>
        <button class="cancel" id="mgUpload">上传本机（覆盖云端）</button>
      </div>`);
    $("mgDownload").addEventListener("click", async () => {
      hideModal();
      applyCloud(cloud);
      toast("已下载云端课表");
    });
    $("mgUpload").addEventListener("click", async () => {
      hideModal();
      await pushToCloud();
      toast("已上传到云端");
    });
  } else if (cloudHas) {
    applyCloud(cloud);
    toast("已载入云端课表");
  } else if (localHas) {
    await pushToCloud();
    toast("已上传课表到云端");
  }
}

function updateAuthUI() {
  $("btnLogin").textContent = authUser ? "☁ " + (authUser.email || "已登录").split("@")[0] : "☁ 登录";
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
        <input id="suCode" class="auth-input code" type="text" placeholder="6 位邮箱验证码" inputmode="numeric" maxlength="6" autocomplete="one-time-code" style="display:none">
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
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
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
  $("main").classList.remove("hidden");
}
function showWelcome() {
  $("main").classList.add("hidden");
  $("welcome").classList.remove("hidden");
}

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
}
function hideBanner() { $("banner").classList.add("hidden"); }

/* ---------------- 渲染：周课表 ---------------- */
function curWeek() { return getSemesterWeek(new Date()); }

function render() {
  const hasCourses = state.codes.length > 0;
  hasCourses ? showMain() : showWelcome();
  renderWeekbar();
  renderGrid();
  const total = state.codes.reduce((s, c) => {
    const x = courseMap[c];
    return s + (x ? (x.credit || 0) : 0);
  }, 0);
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

function renderGrid() {
  const grid = $("grid");
  const allCourses = state.codes.map(c => courseMap[c]).filter(Boolean);
  /* 本周视图: 仅保留命中该周次的时段 */
  const courses = viewWeek == null ? allCourses
    : allCourses
      .map(c => ({ ...c, sessions: (c.sessions || []).filter(s => inWeekSet(s.weekSet, viewWeek)) }))
      .filter(c => c.sessions.length);
  const conflicts = findConflicts(courses);
  const conflictCodes = new Set();
  for (const cf of conflicts) { conflictCodes.add(cf.a.code); conflictCodes.add(cf.b.code); }

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
  const starts = {};   // "row-col" -> [{course, session, span}]
  const covered = {};  // "row-col" -> true (被 rowspan 覆盖)
  const placed = new Set();
  for (const c of courses) {
    for (const s of c.sessions) {
      if (!(s.day >= 1 && s.day <= 7 && s.p1 >= 1 && s.p2 >= s.p1 && s.p2 <= 13)) continue;
      const key = `${c.code}|${s.day}|${s.p1}|${s.p2}|${s.weeks}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const span = s.p2 - s.p1 + 1;
      const sk = `${s.p1}-${s.day}`;
      (starts[sk] = starts[sk] || []).push({ course: c, session: s, span });
      for (let r = s.p1; r < s.p1 + span; r++) covered[`${r}-${s.day}`] = true;
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
  for (let p = 1; p <= 13; p++) {
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
  grid.appendChild(thead);
  grid.appendChild(tbody);

  /* 本周无任何课时给个提示 */
  const empty = $("gridEmpty");
  if (empty) {
    empty.classList.toggle("hidden", !(viewWeek != null && courses.length === 0 && allCourses.length > 0));
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
  dateIn.value = new Date().toISOString().slice(0, 10);
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
    <h3>粘贴课程代码</h3>
    <textarea id="codesText" spellcheck="false" placeholder="每行一个课程代码，如：&#10;180081070200P1001H-1"></textarea>
    <div class="modal-actions">
      <button class="ok" id="codesOk">添加到课表</button>
      <button class="cancel" id="codesCancel">取消</button>
    </div>`);
  $("codesOk").addEventListener("click", () => {
    const raw = parseCodes($("codesText").value);
    if (!raw.length) { toast("没有有效的课程代码"); return; }
    hideModal();
    addCodes(raw);
  });
  $("codesCancel").addEventListener("click", hideModal);
}

/* ---------------- 分享 ---------------- */
function shareLink() {
  if (!state.codes.length) { toast("课表还是空的"); return; }
  const url = `${location.origin}${location.pathname}?c=${state.codes.join(",")}`;
  const done = () => toast("分享链接已复制，发给同学即可");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
  } else fallbackCopy(url, done);
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
  const data = { app: "kebiao-ucas", version: 1, exportedAt: new Date().toISOString(), codes: state.codes, records: state.records };
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
        <h3>导入备份</h3>
        <p>将覆盖当前课表与笔记（当前 ${state.codes.length} 门课）。继续？</p>
        <div class="modal-actions">
          <button class="ok" id="impOk">覆盖导入</button>
          <button class="cancel" id="impCancel">取消</button>
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
  $("btnCodes").addEventListener("click", showCodesModal);
  $("btnShare").addEventListener("click", shareLink);
  $("btnLogin").addEventListener("click", showAuthModal);

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
  $("btnBackup").addEventListener("click", () => {
    showModal(`
      <h3>备份与恢复</h3>
      <p style="color:var(--muted);font-size:13px">课表与笔记仅保存在本机浏览器。换手机或清缓存前请先导出备份。</p>
      <div class="modal-actions">
        <button class="ok" id="bkpExport">导出备份</button>
        <button class="cancel" id="bkpImport">导入备份</button>
      </div>`);
    $("bkpExport").addEventListener("click", () => { hideModal(); exportBackup(); });
    $("bkpImport").addEventListener("click", () => { hideModal(); $("fileImport").click(); });
  });

  /* URL 分享参数 */
  const params = new URLSearchParams(location.search);
  const shared = parseCodes(params.get("c"));
  if (shared.length) {
    showModal(`
      <h3>来自分享的课程代码</h3>
      <p>识别到 ${shared.length} 个课程代码，导入到你的课表？</p>
      <div class="modal-actions">
        <button class="ok" id="shOk">导入</button>
        <button class="cancel" id="shCancel">取消</button>
      </div>`);
    $("shOk").addEventListener("click", () => { hideModal(); addCodes(shared); });
    $("shCancel").addEventListener("click", hideModal);
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
  if (supabaseClient) {
    supabaseClient.auth.getSession().then(({ data }) => {
      if (data.session) {
        authUser = data.session.user;
        updateAuthUI();
      }
    });
  }
  fetch(CATALOG_URL)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      catalog = data;
      courseMap = {};
      for (const c of catalog.courses) courseMap[c.code] = c;
      init();
      if (authUser) pullAndMerge();
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      }
    })
    .catch(err => {
      console.error(err);
      toast("课程库加载失败，请检查网络后刷新");
    });
}

/* 供 Node 单测 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeCode, parseCodes, weeksOverlap, sessionOverlap,
    conflictsBetween, findConflicts, fmtSession, daysLeft, DAY_NAMES, PERIOD_TIMES,
    getSemesterWeek, inWeekSet, fmtWeekRange, SEMESTER_MONDAY, MAX_WEEK
  };
}