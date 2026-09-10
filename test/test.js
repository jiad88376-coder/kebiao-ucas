/* 课表 App 纯逻辑单元测试 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const app = require(path.join(__dirname, "..", "app.js"));

let passed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { console.error("  ✗ FAIL:", name); process.exitCode = 1; }
}

console.log("== parseCodes / normalizeCode ==");
ok(JSON.stringify(app.parseCodes("180081070200P1001H-1, 180081070202P3007H\n180087120200MX016H")) ===
   JSON.stringify(["180081070200P1001H-1", "180081070202P3007H", "180087120200MX016H"]), "换行/逗号/空格分隔");
ok(JSON.stringify(app.parseCodes("a，b、c;d；e")) === JSON.stringify([]), "中文符号残留被过滤(非代码)");
ok(app.normalizeCode("180081070202p3007h ") === "180081070202P3007H", "小写转大写");

console.log("== weeksOverlap ==");
ok(app.weeksOverlap([[2, 20]], [[2, 5], [7, 18]]) === true, "第2-20周 vs 第2-5,7-18周 重叠");
ok(app.weeksOverlap([[8, 12]], [[6, 6]]) === false, "第8-12周 vs 第6周 不重叠");
ok(app.weeksOverlap([[6, 10]], [[3, 3]]) === false, "第6-10周 vs 第3周 不重叠");
ok(app.weeksOverlap([[14, 17]], [[3, 3]]) === false, "第14-17周 vs 第3周 不重叠");
ok(app.weeksOverlap([[2, 3], [7, 12]], [[6, 6]]) === false, "第2-3,7-12周 vs 第6周 不重叠");
ok(app.weeksOverlap([[2, 5], [7, 20]], [[3, 4]]) === true, "子区间重叠");
ok(app.weeksOverlap(null, [[2, 20]]) === true, "缺失周次保守视为冲突");

console.log("== sessionOverlap ==");
const s1 = { day: 5, p1: 5, p2: 7, weekSet: [[2, 18]] };   // 现代物理实验 周五5-7
const s2 = { day: 5, p1: 7, p2: 8, weekSet: [[11, 15]] };  // 学术道德环境 周五7-8
const s3 = { day: 5, p1: 1, p2: 3, weekSet: [[2, 20]] };   // 声表面波 周五1-3
const s4 = { day: 5, p1: 3, p2: 4, weekSet: [[7, 12]] };   // 学术道德分论 周五3-4
const s5 = { day: 1, p1: 3, p2: 4, weekSet: [[2, 20]] };   // 概率统计 周一3-4
const s6 = { day: 1, p1: 1, p2: 2, weekSet: [[2, 20]] };   // 高能物理大数据 周一1-2
const s7 = { day: 6, p1: 5, p2: 7, weekSet: [[2, 3], [7, 12]] }; // 时间频率 周六5-7
const s8 = { day: 6, p1: 5, p2: 8, weekSet: [[6, 6]] };    // 自辩13 周六5-8 第6周
ok(app.sessionOverlap(s1, s2) === true, "周五5-7 vs 周五7-8(第11-15周) 冲突");
ok(app.sessionOverlap(s3, s4) === true, "周五1-3 vs 周五3-4 冲突");
ok(app.sessionOverlap(s5, s6) === false, "周一3-4 vs 周一1-2 不冲突");
ok(app.sessionOverlap(s7, s8) === false, "周六5-7(2-3,7-12周) vs 周六5-8(仅第6周) 不冲突");
ok(app.sessionOverlap(s1, s3) === false, "周五5-7 vs 周五1-3 不冲突");

console.log("== 真实课程库回归 ==");
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "schools", "ucas-catalog.json"), "utf-8"));
const map = {};
for (const c of cat.courses) map[c.code] = c;
const userCodes = ["180081070200P1003H","180081070202P3007H","180081070206P3008H","180201070402P2003H",
  "180081070200P1001H-1","180081070202P2002H","180093085402P3003H","180087120200MX016H",
  "180088071200MX026H","180208082703P3003H","180081070206P3007H","1802110803X5M2002H",
  "180213010108MB001H-13","180213030500MB001H-14"];
const userCourses = userCodes.map(c => map[c]);
ok(userCourses.every(Boolean), "14 门课全部在课程库中");
const cf = app.findConflicts(userCourses);
ok(cf.length === 0, `14 门课零冲突 (实测冲突 ${cf.length} 处)`);

const friendCodes = ["180081070200P1003H","180081070203P2002H","180081070200P1001H-1",
  "180081070202P2002H","180081070202P3007H","180211085408P3025H","180201070402P2003H"];
ok(app.findConflicts(friendCodes.map(c => map[c])).length === 0, "同学 7 门课零冲突");

const conflictCodes = ["180081070200P1003H","180084083000PB001H"]; // 现代物理实验 vs 学术道德(环境)
ok(app.findConflicts(conflictCodes.map(c => map[c])).length === 1, "构造冲突对能检出");

console.log("== daysLeft ==");
/* 本地日期（toISOString 是 UTC，北京 0-8 点会差一天） */
function localDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const tomorrow = localDate(1);
const yesterday = localDate(-1);
ok(app.daysLeft(tomorrow) === 1, "明天=1天");
ok(app.daysLeft(yesterday) === -1, "昨天=-1天");

console.log("== 学期周次 ==");
ok(app.SEMESTER_MONDAY === "2026-08-31", "第1周周一=2026-08-31");
ok(app.getSemesterWeek(new Date(2026, 8, 5)) === 1, "2026-09-05(周六)=第1周");
ok(app.getSemesterWeek(new Date(2026, 8, 6)) === 1, "2026-09-06(周日)=第1周");
ok(app.getSemesterWeek(new Date(2026, 8, 7)) === 2, "2026-09-07(周一)=第2周");
ok(app.getSemesterWeek(new Date(2026, 7, 30)) === 1, "开学前(8-30)按第1周");
ok(app.getSemesterWeek(new Date(2026, 11, 31)) === 18, "2026-12-31=第18周");
ok(app.inWeekSet([[2, 5], [7, 12]], 1) === false, "第1周不在 2-5,7-12");
ok(app.inWeekSet([[2, 5], [7, 12]], 3) === true, "第3周在 2-5,7-12");
ok(app.inWeekSet([[2, 5], [7, 12]], 6) === false, "第6周不在(断档)");
ok(app.inWeekSet([[2, 5], [7, 12]], 8) === true, "第8周在 7-12");
ok(app.inWeekSet(null, 5) === true, "缺失周次保守显示");
ok(typeof app.fmtWeekRange(1) === "string" && /\./.test(app.fmtWeekRange(1)), "周区间格式化");

console.log("== nearestCourseDay（跳周后对焦最近有课日） ==");
const csMon = [{ sessions: [{ day: 1, p1: 1, p2: 2, weekSet: [[1, 18]] }] }];            // 只有周一有课
const csTueThu = [{ sessions: [{ day: 2, p1: 3, p2: 4, weekSet: [[2, 20]] }] },
                  { sessions: [{ day: 4, p1: 1, p2: 2, weekSet: [[2, 20]] }] }];
ok(app.nearestCourseDay(2, csMon, new Date(2026, 8, 6)) === 1, "周日(第1周末)看第2周 → 周一");
ok(app.nearestCourseDay(3, csMon, new Date(2026, 8, 13)) === 1, "第2周周日看第3周 → 周一");
ok(app.nearestCourseDay(1, csMon, new Date(2026, 8, 5)) === 1, "周六看本周 → 周一");
const monW2 = app.weekMonday(2); monW2.setDate(monW2.getDate() + 2); // 第2周周三
ok(app.nearestCourseDay(2, csTueThu, monW2) === 4, "第2周周三(周二/周四均差1天) → 平手取靠后(周四)");
ok(app.nearestCourseDay(5, [{ sessions: [{ day: 1, weekSet: [[1, 4]] }] }], new Date(2026, 8, 6)) === 0, "目标周全无课 → 0(不乱跳)");
ok(app.nearestCourseDay(2, [{ sessions: [{ day: 1, weekSet: [[3, 4]] }] }], new Date(2026, 8, 6)) === 0, "该日不在目标周次 → 0");

console.log("== effSlot（上课时间微调：学期/单日覆盖） ==");
const sessT = { day: 3, p1: 3, p2: 4, room: "教一楼207" };
app.__setRecords({});
let es = app.effSlot("C1", sessT, null);
ok(es.day === 3 && es.p1 === 3 && es.p2 === 4, "无微调 → 时段原样");
app.__setRecords({ C1: { tweaks: { "3-3-4": { day: 5, p1: 10, p2: 12 } } } });
es = app.effSlot("C1", sessT, null);
ok(es.day === 5 && es.p1 === 10 && es.p2 === 12, "学期级时间覆盖生效");
app.__setRecords({ C1: { tweaks: { "3-3-4": { room: "教二楼218" } } } });
es = app.effSlot("C1", sessT, null);
ok(es.day === 3 && es.p1 === 3 && es.p2 === 4, "旧版 room-only 微调不改时间");
app.__setRecords({ C1: {
  tweaks: { "3-3-4": { day: 5, p1: 10, p2: 12 } },
  tweaksByDate: { "2026-09-09": { "3-3-4": { day: 4 } } }
} });
es = app.effSlot("C1", sessT, "2026-09-09");
ok(es.day === 4 && es.p1 === 3 && es.p2 === 4, "单日级时间覆盖优先");
es = app.effSlot("C1", sessT, "2026-09-10");
ok(es.day === 5, "其他日期回落学期级");
app.__setRecords({ C1: { tweaks: { "3-3-4": { day: 6 } } } });
es = app.effSlot("C1", sessT, null);
ok(es.day === 6 && es.p1 === 3 && es.p2 === 4, "只改星期，节次保留");
app.__setRecords({});
es = app.effSlot("C1", sessT, null);
ok(es.day === 3 && es.p1 === 3 && es.p2 === 4, "清理后回落原始时段");

console.log("== ics（系统日历提醒导出） ==");
const sessI = { day: 3, p1: 1, p2: 2, room: "教1-103", weeks: "第1-2周", weekSet: [[1, 2]] };
const icsOut = app.buildICS([{ code: "TEST-1", name: "测试课程;A,B", teacher: "张三", sessions: [sessI] }], 10);
const icsText = icsOut.text;
ok(icsOut.events === 2, "第1-2周展开为 2 个事件");
ok(icsText.includes("DTSTART:20260902T083000"), "第1周周三=2026-09-02 8:30 开讲");
ok(icsText.includes("DTEND:20260902T100500"), "第2节下课=10:05");
ok(icsText.includes("TRIGGER:-PT10M"), "提前 10 分钟提醒");
ok(icsText.includes("SUMMARY:测试课程\\;A\\,B"), "SUMMARY 特殊字符转义");
ok(icsText.includes("LOCATION:教1-103"), "教室写入 LOCATION");
ok(icsText.includes("X-WR-TIMEZONE:Asia/Shanghai"), "时区声明");
const icsM5 = app.buildICS([{ code: "T2", name: "x", sessions: [sessI] }], 5);
ok(icsM5.text.includes("TRIGGER:-PT5M"), "提前量参数生效");
const dW2Wed = app.icsDateFor(2, 3);
ok(dW2Wed.getFullYear() === 2026 && dW2Wed.getMonth() === 8 && dW2Wed.getDate() === 9, "第2周周三=2026-09-09");
const icsCustom = app.buildICS([{ code: "T3", name: "y", sessions: [sessI] }], 10);
app.__setRecords({ T3: { tweaks: { "3-1-2": { room: "改到202" } } } });
const icsTweak = app.buildICS([{ code: "T3", name: "y", sessions: [sessI] }], 10);
ok(icsTweak.text.includes("LOCATION:改到202"), "导出尊重用户微调教室");
app.__setRecords({});

console.log("== 下节课 / 今日剩余（桌面快捷方式） ==");
/* 第2周: 9/7(一)-9/13(日)。周二节次: 1-2=8:30-10:05, 3-4=10:25-12:00, 5-6=13:30-15:05 */
const tue56 = { code: "A1", name: "下午课", sessions: [{ day: 2, p1: 5, p2: 6, weekSet: [[1, 18]], room: "R56" }] };
const wed12 = { code: "A2", name: "上午课", sessions: [{ day: 3, p1: 1, p2: 2, weekSet: [[1, 18]] }] };
const tue12 = { code: "A3", name: "早课", sessions: [{ day: 2, p1: 1, p2: 2, weekSet: [[1, 18]] }] };
const tue34w3 = { code: "A4", name: "第五周才有", sessions: [{ day: 2, p1: 3, p2: 4, weekSet: [[5, 6]] }] };
const noonTue = new Date(2026, 8, 8, 12, 0);
let nx = app.findNextClass([tue56], noonTue);
ok(nx && nx.course.code === "A1" && nx.slot.p1 === 5 && nx.room === "R56", "周二中午 → 周二5-6节");
ok(nx && nx.bounds.start.getHours() === 13 && nx.bounds.start.getMinutes() === 30, "下一节 13:30 开讲");
nx = app.findNextClass([wed12], noonTue);
ok(nx && nx.course.code === "A2" && nx.date.getDate() === 9, "周二中午无当日课 → 次日周三");
nx = app.findNextClass([wed12, tue56], noonTue);
ok(nx && nx.course.code === "A1", "多门课取最早");
ok(app.findNextClass([tue34w3], noonTue) === null, "仅第3周有课的课 → 7 天内找不到");
ok(app.findNextClass([], noonTue) === null, "空课表 → null");
const nineTue = new Date(2026, 8, 8, 9, 0);
nx = app.findNextClass([tue12, tue56], nineTue);
ok(nx && nx.course.code === "A3", "上课进行中(1-2节 8:30-10:05)也算下一节");
ok(app.todayRemainingClasses([tue12, tue56], nineTue) === 2, "周二9点：1-2进行中 + 5-6未上 = 2");
ok(app.todayRemainingClasses([tue12, tue56], noonTue) === 1, "周二12点：1-2已结束，剩 5-6 = 1");
ok(app.todayRemainingClasses([tue56, wed12], noonTue) === 1, "别天的课不计入今日");
app.__setRecords({ "A1": { tweaks: { "2-5-6": { day: 4, p1: 10, p2: 12 } } } });
nx = app.findNextClass([tue56], noonTue);
ok(nx && nx.slot.day === 4 && nx.slot.p1 === 10, "下节课尊重用户时间微调");
app.__setRecords({});

console.log("== 日期与转义工具（重构后公共出口） ==");
ok(app.dateStrOf(new Date(2026, 8, 9)) === "2026-09-09", "dateStrOf 补零成 YYYY-MM-DD");
ok(/^\d{4}-\d{2}-\d{2}$/.test(app.todayStr()), "todayStr 本地时区日期格式");
ok(app.esc('<b>&"\'') === "&lt;b&gt;&amp;&quot;&#39;", "esc HTML 特殊字符转义");
ok(app.esc(null) === "" && app.esc(undefined) === "", "esc 空值 → 空串");

console.log("== periodHM（节次时刻统一出口，ICS/下节课共用） ==");
ok(app.periodHM(1, false) === "8:30", "第1节上课 8:30");
ok(app.periodHM(2, true) === "10:05", "第2节下课 10:05");
ok(app.periodHM(13, true) === "21:50", "第13节下课 21:50");
ok(app.periodHM(99, false) === null, "无配置节次 → null");

console.log("== 天气码映射（WMO 单表驱动） ==");
ok(app.wmoIcon(0) === "☀️" && app.wmoShort(0) === "晴", "0 → 晴");
ok(app.wmoIcon(2) === "⛅" && app.wmoShort(2) === "多云", "2 → 多云（图标/短语区分）");
ok(app.wmoShort(3) === "阴" && app.wmoIcon(3) === "☁️", "3 → 阴");
ok(app.wmoShort(63) === "雨" && app.wmoShort(51) === "毛毛雨", "雨带细分");
ok(app.wmoIcon(95) === "⛈" && app.wmoShort(95) === "雷雨", "95 → 雷雨");
ok(app.wmoIcon(999) === "⛈" && app.wmoShort(999) === "雷雨", "95+ 一律按雷雨（保持原口径）");
ok(app.wmoIcon(88) === "⛈" && app.wmoShort(88) === "变天", "未覆盖码段 → 兜底");

console.log("== buildReminderJobs（Web Push 提醒任务） ==");
/* 2026-09-08 周二 12:00（第2周） */
const pushNow = new Date(2026, 8, 8, 12, 0);
const pCourses = [
  { code: "R1", name: "测试课一", sessions: [{ day: 2, p1: 5, p2: 6, room: "R56", weekSet: [[1, 18]] }] },
  { code: "R2", name: "测试课二", sessions: [{ day: 3, p1: 1, p2: 2, room: "R12", weekSet: [[1, 18]] }] }
];
const pRecords = {
  R1: {
    homework: [
      { id: "h1", title: "习题2", due: "2026-09-09", done: false },
      { id: "h2", title: "已完成的", due: "2026-09-09", done: true }
    ],
    exams: [{ id: "e1", type: "期中", date: "2026-09-09", time: "14:00" }]
  }
};
const pJobs = app.buildReminderJobs(pCourses, pRecords, pushNow, 30);
const byTag = (t) => pJobs.find(j => j.tag === t);
let jj = byTag("m-2026-09-09");
ok(!!jj && jj.title === "今天 1 节课" && jj.body.includes("8:30 测试课二（R12）"), "早间课表：次日有课生成");
ok(!byTag("m-2026-09-08"), "早间课表：当天 7:30 已过不生成");
jj = byTag("m-2026-09-15");
ok(!!jj && jj.body.includes("13:30 测试课一（R56）"), "早间课表：按课表时刻生成");
ok(jj && new Date(jj.due_at).getHours() === 7 && new Date(jj.due_at).getMinutes() === 30, "早间任务定在本地 7:30");
jj = byTag("d-2026-09-08");
ok(!!jj && jj.title === "明天有 2 个截止" && jj.body.includes("习题2") && jj.body.includes("期中 14:00"), "晚间 DDL：未完成作业+考试合并，已完成不计");
ok(jj && new Date(jj.due_at).getHours() === 20 && new Date(jj.due_at).getMinutes() === 0, "晚间任务定在本地 20:00");
jj = byTag("w-2026-09-13");
ok(!!jj && jj.title === "下周 2 节课" && jj.body.includes("首节：周二 13:30 测试课一（R56）"), "周日晚：下周预览");
ok(jj && new Date(jj.due_at).getHours() === 19 && new Date(jj.due_at).getMinutes() === 0, "周预览定在周日 19:00");
app.__setRecords({ R1: { tweaks: { "2-5-6": { room: "新教室" } } } });
jj = app.buildReminderJobs(pCourses, {}, pushNow, 30).find(j => j.tag === "m-2026-09-15");
ok(!!jj && jj.body.includes("新教室"), "早间课表尊重用户改教室");
app.__setRecords({});
const offJobs = app.buildReminderJobs(pCourses, pRecords, pushNow, 30, { morning: false, ddl: true, weekly: false });
ok(!offJobs.some(j => j.tag.startsWith("m-")) && !offJobs.some(j => j.tag.startsWith("w-")), "偏好关闭后不再生成对应任务");
ok(offJobs.some(j => j.tag.startsWith("d-")), "偏好保留的 DDL 任务仍在");
ok(app.buildReminderJobs([], {}, pushNow, 30).length === 0, "空课表不生成任务");

console.log(`\n通过 ${passed} 项测试`);
if (process.exitCode) { console.error("存在失败项"); process.exit(1); }