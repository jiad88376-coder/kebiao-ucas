# -*- coding: utf-8 -*-
"""把教务课表 xlsx 导出为课程表 App 使用的 catalog.json（全校区全课程）。"""
import json
import re
import io
import openpyxl

SRC = r"D:\xwechat_files\wxid_bab3kzmnjg1g22_db19\msg\file\2026-08\2026年秋季学期课表 (1)(1).xlsx"
DST = r"C:\Users\ddd\Desktop\文件\入学\schedule-app\data\catalog.json"

DAY_ORDER = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
DAY_MAP = {d: i + 1 for i, d in enumerate(DAY_ORDER)}

PERIOD_RE = re.compile(r"\((?:第?)(\d+)-(\d+)\)")
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


def campus_of(code):
    head = code.partition("-")[0]
    return head[-1] if head and head[-1] in "HYZ" else "?"


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    ws = wb["sheet0"]
    courses = []
    cur = None
    for row in ws.iter_rows(min_row=2, max_col=24):
        name = row[3].value
        if name is not None:
            if cur is not None:
                courses.append(cur)
            code = str(row[2].value or "").strip()
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
                "_room": str(row[13].value or "").strip(),
            }
        if cur is not None and row[11].value:
            parsed = parse_period(str(row[12].value))
            if parsed:
                day, p1, p2 = parsed
                room = str(row[13].value or "").strip() or cur["_room"]
                cur["sessions"].append({
                    "day": day,
                    "p1": p1,
                    "p2": p2,
                    "weeks": str(row[11].value).strip(),
                    "weekSet": weeks_to_intervals(str(row[11].value)),
                    "room": room,
                })
    if cur is not None:
        courses.append(cur)

    courses.sort(key=lambda c: c["code"])
    for c in courses:
        c.pop("_room", None)
        c["sessions"].sort(key=lambda s: (s["day"], s["p1"]))

    data = {
        "meta": {
            "term": "2026秋季学期",
            "updated": "2026-09-04",
            "count": len(courses),
            "campus": ["H", "Y", "Z"],
        },
        "courses": courses,
    }
    with io.open(DST, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"courses={len(courses)} sessions={sum(len(c['sessions']) for c in courses)} -> {DST}")


if __name__ == "__main__":
    main()