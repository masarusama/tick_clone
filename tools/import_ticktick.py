"""TickTickのバックアップCSVを、1メモ1ファイルのMarkdownに取り込む。

使い方:  python tools/import_ticktick.py <CSV> --data <出力先データフォルダ>
同じCSVを何度流しても、同じメモは同じファイル名に上書きされる（重複しない）。

変換ルール
- 本文 = タイトル行 + 内容。サブタスクは親の本文末尾に「- [ ] 」の行として畳み込む
- タグ欄 → 本文末尾の #タグ 行 / 元のリスト（フォルダがあれば フォルダ/リスト）→ frontmatter の list:
- 作成日 → created（日本時間）。期日・完了などは frontmatter に残す
- 完了(2)・中止(-1)のタスクは status: done / abandoned（中止には完了日を付けず、cancelled: に入れる）
- TickTick のノート（projectKind=NOTE）は kind: note、タスクは kind: task
"""
import argparse
import csv
import hashlib
import io
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("csv")
ap.add_argument("--data", required=True)
args = ap.parse_args()
os.environ["TICK_DATA"] = args.data
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import store  # noqa: E402

JST = timezone(timedelta(hours=9))


def jst(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S%z").astimezone(JST)


def date_val(s, allday):
    if not s:
        return ""
    d = jst(s)
    return d.strftime("%Y-%m-%d") if allday else d.isoformat(timespec="minutes")


def tag_name(t):
    return re.sub(r"[\s#]+", "_", t.strip()).strip("_")


def list_name(folder, name):
    """TickTick のフォルダ・リスト名 → tick_clone のリスト名（"フォルダ/リスト"。区切りと # は使えないので置き換える）"""
    def clean(x):
        return re.sub(r"[\x00-\x1f#]", "", x).replace("/", "／").replace("\\", "／").strip()
    parts = [clean(x) for x in (folder, name) if clean(x)]
    return store.norm_list("/".join(parts)) if parts else ""


def one_line(s):
    return " / ".join(x.strip() for x in s.splitlines() if x.strip())


raw = open(args.csv, encoding="utf-8").read()
rows = list(csv.DictReader(io.StringIO(raw[raw.index('"Folder Name"'):])))
by_id = {r["taskId"]: r for r in rows}
children = defaultdict(list)
for r in rows:
    if r["parentId"] in by_id:
        children[r["parentId"]].append(r)
for v in children.values():
    v.sort(key=lambda r: int(r["Order"] or 0))


def checklist_lines(content):
    """TickTickのチェックリスト（▫=未 ▪=済）をMarkdownの箇条書きに"""
    out = []
    for line in content.split("\n"):
        if line.startswith("▫"):
            out.append("- [ ] " + line[1:].strip())
        elif line.startswith("▪"):
            out.append("- [x] " + line[1:].strip())
        else:
            out.append(line)
    return "\n".join(out)


def sub_lines(r, depth=0):
    ind = "  " * depth
    mark = "x" if r["Status"] == "2" else " "
    lines = [f"{ind}- [{mark}] {r['Title'].strip()}"]
    for ln in r["Content"].strip().splitlines():
        lines.append(f"{ind}  {ln}")
    for c in children.get(r["taskId"], []):
        lines += sub_lines(c, depth + 1)
    return lines


made, subs, tagcount, new_tags = 0, 0, Counter(), Counter()
orig_tags = set()
stat = Counter()

for r in rows:
    if r["parentId"] in by_id:  # サブタスクは親に畳み込み済み
        subs += 1
        continue
    if not (r["Title"] or r["Content"]):
        stat["空"] += 1
        continue

    is_note = r["projectKind"] == "NOTE"
    content = r["Content"].rstrip()
    if r["Kind"] == "CHECKLIST":
        content = checklist_lines(content)
    parts = [r["Title"].strip()] if r["Title"].strip() else []
    if content.strip():
        parts.append(content)
    sub = []
    for c in children.get(r["taskId"], []):
        sub += sub_lines(c)
    if sub:
        parts.append("\n".join(sub))

    tags = []
    for t in r["Tags"].split(","):
        t = tag_name(t)
        if t and t not in tags:
            tags.append(t)
            orig_tags.add(t)
    body = "\n".join(parts)
    existing = set(store.extract_tags(body))
    for t in existing - set(tags):
        new_tags[t] += 1  # 本文中に元からあった # のうちTickTickのタグ欄に無いもの
    line = " ".join("#" + t for t in tags if t not in existing)
    body = body + ("\n\n" + line if line else "") + "\n"
    for t in store.extract_tags(body):
        tagcount[t] += 1

    created = jst(r["Created Time"]) if r["Created Time"] else datetime.now(JST)
    allday = r["Is All Day"] == "true"
    meta = {"id": "", "created": created.isoformat(timespec="seconds"), "updated": ""}
    h = hashlib.sha1(r["taskId"].encode()).hexdigest()[:4]
    nid = created.strftime("%Y%m%d-%H%M%S-") + h
    meta["id"] = nid
    meta["updated"] = meta["created"]
    meta["source"] = "ticktick"
    meta["kind"] = "note" if is_note else "task"
    lst = list_name(r["Folder Name"], r["List Name"])
    if lst:
        meta["list"] = lst
        stat["リスト/" + lst] += 1
    if not is_note:
        meta["status"] = {"2": "done", "-1": "abandoned"}.get(r["Status"], "open")
        if r["Completed Time"]:
            when = jst(r["Completed Time"]).isoformat(timespec="minutes")
            if meta["status"] == "abandoned":
                meta["cancelled"] = when  # 中止は、実績（完了日）に数えない
            else:
                meta["completed"] = when
        stat["タスク/" + meta["status"]] += 1
    else:
        stat["メモ"] += 1
    if r["Start Date"]:
        meta["start"] = date_val(r["Start Date"], allday)
    if r["Due Date"]:
        meta["due"] = date_val(r["Due Date"], allday)
    if r["Start Date"] or r["Due Date"]:
        meta["allday"] = "yes" if allday else "no"
    if r["Repeat"]:
        meta["repeat"] = r["Repeat"]
    if r["Reminder"]:
        meta["reminder"] = one_line(r["Reminder"])
    if r["Priority"] not in ("", "0"):
        meta["priority"] = r["Priority"]

    d = store.NOTES / f"{created:%Y}" / f"{created:%m}"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{nid}.md").write_text(store.render_file(meta, body), encoding="utf-8", newline="\n")
    made += 1

print(f"書き出し {made}件 / サブタスクを親に畳み込み {subs}件")
print(dict(stat))
store.init_git()
store.reindex()
store.schedule_commit("TickTickから取り込み")
store.commit_now()
print("索引上のメモ数:", len(store.list_notes()), "/ タグ数:", len(store.all_tags()))
print("TickTickのタグ欄に無い本文中の#（確認用）:", len(new_tags), new_tags.most_common(25))
