# -*- coding: utf-8 -*-
"""国科大课程库查缺补漏：以最新教务导出为准重建 ucas-catalog.json。
新表覆盖的课程用新数据（教室/教师/时段最新）；现库独有而新表缺的课（书院 B 编码等）
原样保留。表结构 24 列（0-based）：1院系 2编码 3名称 5属性 6层次 7学科/专业
8课时/学分 11开课周 12星期节次 13教室 15考核 16首席 18主讲教师。续行只有时段，教室为空则继承。"""
import io
import json
import re
import sys
import openpyxl

SRC = sys.argv[1]
DST = r"C:\Users\ddd\Desktop\文件\入学\schedule-app\data\schools\ucas-catalog.json"

DAY_ORDER = ["周一", "周二", "周三", "周四", "周五", "周六", "周日", "周天"]
DAY_MAP = {d: (i % 7) + 1 for i, d in enumerate(DAY_ORDER)}
PERIOD_RE = re.compile(r"\((?:第?)([0-9]+(?:-[0-9]+)?(?:[,，][0-9]+(?:-[0-9]+)?)*)\)")
WEEK_RE = re.compile(r"第(.*?)周")


def weeks_to_intervals(text):
    m = WEEK_RE.search(text or "")
    if not m:
        return None
    parts = []
    for seg in m.group(1).split(","):
        seg = seg.strip()
        if not seg:
            continue
        if "-" in seg:
            a, b = seg.split("-")
            parts.append((int(a), int(b)))
        else:
            parts.append((int(seg), int(seg)))
    parts.sort()
    merged = []
    for a, b in parts:
        if merged and a <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def parse_period(text):
    """返回 (day,p1,p2) 或同天多段的 [(day,p1,p2),...]，如 周六(1-3,5-7)"""
    m = PERIOD_RE.search(text or "")
    if not m:
        return None
    day = next((d for d in DAY_MAP if d in text), None)
    if not day:
        return None
    out = []
    for part in re.split(r"[,，]", m.group(1)):
        if "-" in part:
            a, b = part.split("-")
            out.append((DAY_MAP[day], int(a), int(b)))
        else:
            out.append((DAY_MAP[day], int(part), int(part)))
    return out if len(out) > 1 else out[0]


def parse_credit(text):
    try:
        hours_s, credit_s = str(text or "0/0").split("/")
        return int(float(hours_s)), float(credit_s)
    except (ValueError, IndexError):
        return None, None


def campus_of(code):
    for ch in reversed(code):
        if ch in ("H", "Y", "Z"):
            return ch
        if ch.isalpha() or ch in "）)":
            break
    return "H"


def main():
    ws = openpyxl.load_workbook(SRC, data_only=True)["sheet0"]
    fresh, problems = {}, []
    cur = None
    for i, row in enumerate(ws.iter_rows(min_row=2, max_col=24), start=2):
        name = row[3].value
        if name is not None:
            code = str(row[2].value or "").strip()
            if not code:
                problems.append("row %d: 有课程名但无编码: %s" % (i, name))
                cur = None
                continue
            hours, credit = parse_credit(row[8].value)
            cur = {
                "code": code,
                "name": str(name).strip(),
                "campus": campus_of(code),
                "dept": str(row[1].value or "").strip(),
                "attr": str(row[5].value or "").strip(),
                "level": str(row[6].value or "").strip(),
                "major": str(row[7].value or "").strip(),
                "hours": hours,
                "credit": credit,
                "exam": str(row[15].value or "").strip(),
                "teacher": str(row[18].value or row[16].value or "").strip(),
                "sessions": [],
            }
            fresh[code] = cur
        if cur is not None and row[12].value:
            parsed = parse_period(str(row[12].value))
            if not parsed:
                problems.append("row %d: 节次解析失败: %r" % (i, row[12].value))
                continue
            plist = parsed if isinstance(parsed, list) else [parsed]
            room = str(row[13].value or "").strip()
            if not room and cur["sessions"]:
                room = cur["sessions"][-1]["room"]
            for day, p1, p2 in plist:
                cur["sessions"].append({
                    "day": day,
                    "p1": p1,
                    "p2": p2,
                    "weeks": str(row[11].value or "").strip(),
                    "weekSet": weeks_to_intervals(str(row[11].value or "")),
                    "room": room,
                })

    old = json.load(io.open(DST, encoding="utf-8"))
    old_by_code = {c["code"]: c for c in old["courses"]}
    carried = [c for c in old["courses"] if c["code"] not in fresh]

    courses = list(fresh.values()) + carried
    courses.sort(key=lambda c: c["code"])
    for c in courses:
        seen, uniq = set(), []
        for s in c["sessions"]:
            k = (s["day"], s["p1"], s["p2"], s["weeks"])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(s)
        c["sessions"] = sorted(uniq, key=lambda s: (s["day"], s["p1"]))

    old_codes = set(old_by_code)
    new_codes = set(fresh)
    changed = sum(1 for c in courses
                  if c["code"] in old_codes and c["code"] in new_codes
                  and [(s["day"], s["p1"], s["p2"], s["weeks"], s["room"]) for s in c["sessions"]]
                  != [(s["day"], s["p1"], s["p2"], s["weeks"], s["room"]) for s in old_by_code[c["code"]]["sessions"]])

    old["courses"] = courses
    old["meta"]["count"] = len(courses)
    old["meta"]["updated"] = "2026-09-08"
    old["meta"]["campus"] = sorted({c["campus"] for c in courses})
    json.dump(old, io.open(DST, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    rep = io.open(r"C:\Users\ddd\AppData\Local\Temp\opencode\rebuild_report.txt", "w", encoding="utf-8")
    rep.write("新表 %d 门 + 保留现库独有 %d 门 = %d 门\n" % (len(fresh), len(carried), len(courses)))
    rep.write("纯新增 %d, 新表不再收录 %d, 共有课程中时段/教室有变化 %d\n\n" % (len(new_codes - old_codes), len(old_codes - new_codes), changed))
    rep.write("新增:\n")
    for c in sorted(new_codes - old_codes):
        rep.write("  + %s %s\n" % (c, fresh[c]["name"]))
    rep.write("\n保留(新表无):\n")
    for c in sorted(carried, key=lambda x: x["code"]):
        rep.write("  = %s %s\n" % (c["code"], c["name"]))
    rep.write("\n问题 %d:\n" % len(problems))
    for p in problems[:20]:
        rep.write("  ! %s\n" % p)
    rep.close()
    print("total=%d fresh=%d carried=%d" % (len(courses), len(fresh), len(carried)))
    for p in problems[:5]:
        print("PROBLEM:", p)


if __name__ == "__main__":
    main()
