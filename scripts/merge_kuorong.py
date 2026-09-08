# -*- coding: utf-8 -*-
"""国科大课表扩容合并：扩容1/2/3.xlsx -> ucas-catalog.json
扩容表 9 列：序号/开课院系/课程编码/校区/课程名称/课程类别/已选/容量/备注。
时段信息全部在备注里，支持三种句式：
  1) 第X,Y周，周D(a-b)
  2) 第X周，周A、周B、周C（a-b）          —— 多天同时段
  3) 第X周，周D(a-b，c-d)                 —— 同天多时段
教师/教室扩容表未提供：新增班级 teacher="", room=""。
"""
import io
import json
import re
import sys
import openpyxl

CAT = r"C:\Users\ddd\Desktop\文件\入学\schedule-app\data\schools\ucas-catalog.json"
FILES = [
    r"C:\Users\ddd\Desktop\文件\入学\扩容1.xlsx",
    r"C:\Users\ddd\Desktop\文件\入学\扩容2.xlsx",
    r"C:\Users\ddd\Desktop\文件\入学\扩容3.xlsx",
]
CAMPUS_MAP = {"雁栖湖": "H", "中关村": "Z", "玉泉路": "Y"}
DAY_MAP = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7}

WEEK_RE = re.compile(r"第([\d,\-]+)周")
MULTI_DAY_RE = re.compile(r"((?:周[一二三四五六日天],)+周[一二三四五六日天])\((\d+)-(\d+)\)")
SEGDAY_RE = re.compile(r"周([一二三四五六日天])\(([\d,\-]+)\)")


def weeks_to_intervals(text):
    parts = []
    for seg in text.split(","):
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


def parse_remark(rm):
    """备注 -> [{day,p1,p2,weeks,weekSet,room}]（去重后）"""
    norm = rm.replace("（", "(").replace("）", ")").replace("，", ",").replace("、", ",")
    out = []
    for line in norm.split("\n"):
        line = line.strip()
        if not line:
            continue
        wm = WEEK_RE.search(line)
        weeks = "第%s周" % wm.group(1) if wm else None
        if not weeks:
            continue
        multi = MULTI_DAY_RE.search(line)
        if multi:
            for d in multi.group(1).split(","):
                out.append((int(DAY_MAP[d[1]]), int(multi.group(2)), int(multi.group(3)), weeks))
            continue
        for m in SEGDAY_RE.finditer(line):
            day = int(DAY_MAP[m.group(1)])
            for rng in m.group(2).split(","):
                a, b = rng.split("-")
                out.append((day, int(a), int(b), weeks))
    seen, res = set(), []
    for day, p1, p2, weeks in out:
        key = (day, p1, p2, weeks)
        if key in seen:
            continue
        seen.add(key)
        res.append({
            "day": day, "p1": p1, "p2": p2, "weeks": weeks,
            "weekSet": weeks_to_intervals(wm_norm(weeks)), "room": "",
        })
    return res


def wm_norm(weeks):
    return WEEK_RE.search(weeks).group(1)


def main():
    cat = json.load(io.open(CAT, encoding="utf-8"))
    courses = cat["courses"]
    by_code = {c["code"]: c for c in courses}

    rows, seen_key = [], set()
    for p in FILES:
        ws = openpyxl.load_workbook(p, data_only=True)["Sheet1"]
        for r in ws.iter_rows(min_row=2, max_col=9, values_only=True):
            code = str(r[2] or "").strip()
            if not code or (code, str(r[8] or "").strip()) in seen_key:
                continue
            seen_key.add((code, str(r[8] or "").strip()))
            rows.append({
                "code": code,
                "dept": str(r[1] or "").strip(),
                "campus_row": str(r[3] or "").strip(),
                "name": str(r[4] or "").strip(),
                "attr": str(r[5] or "").strip(),
                "remark": str(r[8] or "").strip(),
            })

    added_courses, added_sessions, skipped = [], [], []
    for row in rows:
        rm = row["remark"]
        if not rm:
            continue
        if "同步视频" in rm:
            skipped.append((row["code"], "同步视频（无地面时段，不改动）"))
            continue
        sess = parse_remark(rm)
        if row["code"] in by_code:
            c = by_code[row["code"]]
            have = {(s["day"], s["p1"], s["p2"], s["weeks"]) for s in c["sessions"]}
            n = 0
            for s in sess:
                if (s["day"], s["p1"], s["p2"], s["weeks"]) in have:
                    continue
                c["sessions"].append(s)
                n += 1
            if n:
                added_sessions.append((row["code"], c["name"], n))
            else:
                skipped.append((row["code"], "已有课时的重复项"))
            continue
        base = row["code"].rsplit("-", 1)[0]
        parent = by_code.get(base)
        if not parent:
            kids = [c for c in courses if c["code"].startswith(base + "-")]
            parent = kids[0] if kids else None
        csfx = row["code"][-1]
        campus = csfx if csfx in ("H", "Y", "Z") else (CAMPUS_MAP.get(row["campus_row"]) or (parent or {}).get("campus") or "H")
        nc = {
            "code": row["code"],
            "name": row["name"] or (parent or {}).get("name", ""),
            "campus": campus,
            "dept": row["dept"] or (parent or {}).get("dept", ""),
            "attr": row["attr"] or (parent or {}).get("attr", ""),
            "level": (parent or {}).get("level", ""),
            "major": (parent or {}).get("major", ""),
            "hours": (parent or {}).get("hours"),
            "credit": (parent or {}).get("credit"),
            "exam": (parent or {}).get("exam", ""),
            "teacher": "",
            "sessions": sess,
        }
        courses.append(nc)
        by_code[row["code"]] = nc
        added_courses.append((row["code"], nc["name"], len(sess)))

    courses.sort(key=lambda c: c["code"])
    for c in courses:
        c["sessions"].sort(key=lambda s: (s["day"], s["p1"]))

    cat["meta"]["count"] = len(courses)
    cat["meta"]["updated"] = "2026-09-08"
    json.dump(cat, io.open(CAT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    rep = io.open(r"C:\Users\ddd\AppData\Local\Temp\opencode\merge_report.txt", "w", encoding="utf-8")
    rep.write("原 %d 门 -> 现 %d 门\n\n== 新增课程 %d ==\n" % (len(courses) - len(added_courses), len(courses), len(added_courses)))
    for code, name, n in sorted(added_courses):
        rep.write("+ %s %s (%d 时段)\n" % (code, name, n))
    rep.write("\n== 既有课程追加时段 %d ==\n" % len(added_sessions))
    for code, name, n in sorted(added_sessions):
        rep.write("+ %s %s (+%d)\n" % (code, name, n))
    rep.write("\n== 跳过 %d ==\n" % len(skipped))
    for code, why in skipped:
        rep.write("- %s: %s\n" % (code, why))
    no_sess = [r for r in rows if not r["remark"] and r["code"] not in by_code]
    rep.write("\n== 库外且无备注（未合并，等时段信息）%d ==\n" % len(no_sess))
    for r in no_sess:
        rep.write("? %s %s\n" % (r["code"], r["name"]))
    rep.close()
    print("added=%d, sessions+= %d, skipped=%d" % (len(added_courses), len(added_sessions), len(skipped)))


if __name__ == "__main__":
    main()
