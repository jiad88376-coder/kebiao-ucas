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
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
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

console.log(`\n通过 ${passed} 项测试`);
if (process.exitCode) { console.error("存在失败项"); process.exit(1); }