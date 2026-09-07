# -*- coding: utf-8 -*-
"""国科大杭州高等研究院（HIAS）课表 xlsx -> data/schools/hias-catalog.json
表结构：每行一个时段；课程名称为空的行是同一门课的续行（第二个时段）。
列（1-based）：2开课院系 3课程编码 4课程名称 7课程类别 8培养类别 9适用学院/专业
             10学时/学分 13选课周次 14上课节次 15教室 16考核方式 20任课教师
"""
import json
import re
import io
import sys
import openpyxl

SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\ddd\Desktop\文件\入学\chat_file_1040g3c8324qlg4tg1u605p36pf4qa7rml50v0hg_2026年秋季学期课表.xlsx"
DST = r"C:\Users\ddd\Desktop\文件\入学\schedule-app\data\schools\hias-catalog.json"

DAY_ORDER = ["周一", "周二", "周三", "周四", "周五", "周六", "周日", "周天"]
DAY_MAP = {d: (i % 7) + 1 for i, d in enumerate(DAY_ORDER)}

PERIOD_RE = re.compile(r"\((?:第?)(\d+)-(\d+)\)")
WEEK_RE = re.compile(r"第(.*?)周")
CAMPUS = "HZ"


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
    m = PERIOD_RE.search(text or "")
    if not m:
        return None
    day = next((d for d in DAY_MAP if d in text), None)
    if not day:
        return None
    return DAY_MAP[day], int(m.group(1)), int(m.group(2))


def parse_credit(text):
    try:
        hours_s, credit_s = str(text or "0/0").split("/")
        return int(float(hours_s)), float(credit_s)
    except (ValueError, IndexError):
        return None, None


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    ws = wb["Sheet1"]
    courses = []
    cur = None
    problems = []
    for i, row in enumerate(ws.iter_rows(min_row=2, max_col=25), start=2):
        name = row[3].value
        if name is not None:
            if cur is not None:
                courses.append(cur)
            code = str(row[2].value or "").strip()
            if not code:
                problems.append("row %d: 有课程名但无编码: %s" % (i, name))
                continue
            hours, credit = parse_credit(row[9].value)
            cur = {
                "code": code,
                "name": str(name).strip(),
                "campus": CAMPUS,
                "dept": str(row[1].value or "").strip(),
                "attr": str(row[6].value or "").strip(),
                "level": str(row[7].value or "").strip(),
                "major": str(row[8].value or "").strip(),
                "hours": hours,
                "credit": credit,
                "exam": str(row[15].value or "").strip(),
                "teacher": str(row[19].value or row[17].value or "").strip(),
                "sessions": [],
            }
        elif cur is not None:
            code = str(row[2].value or "").strip()
            if code and code != cur["code"]:
                problems.append("row %d: 续行编码(%s)与当前(%s)不一致" % (i, code, cur["code"]))
        if cur is not None and row[13].value:
            parsed = parse_period(str(row[13].value))
            if not parsed:
                problems.append("row %d: 节次解析失败: %r" % (i, row[13].value))
                continue
            day, p1, p2 = parsed
            cur["sessions"].append({
                "day": day,
                "p1": p1,
                "p2": p2,
                "weeks": str(row[12].value or "").strip(),
                "weekSet": weeks_to_intervals(str(row[12].value or "")),
                "room": str(row[14].value or "").strip(),
            })
        elif cur is None and row[13].value:
            problems.append("row %d: 时段出现在任何课程之前" % i)
    if cur is not None:
        courses.append(cur)

    courses.sort(key=lambda c: c["code"])
    for c in courses:
        c["sessions"].sort(key=lambda s: (s["day"], s["p1"]))

    data = {
        "meta": {
            "term": "2026秋季学期",
            "updated": "2026-09-07",
            "count": len(courses),
            "campus": [CAMPUS],
        },
        "courses": courses,
    }
    with io.open(DST, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("courses=%d sessions=%d -> %s" % (len(courses), sum(len(c["sessions"]) for c in courses), DST))
    for p in problems:
        print("PROBLEM:", p)


if __name__ == "__main__":
    main()
