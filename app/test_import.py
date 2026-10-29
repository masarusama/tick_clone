"""TickTick の CSV 取り込み（tools/import_ticktick.py）の確認。小さなサンプルの CSV を、一時フォルダへ取り込む。
使い方: python app/test_import.py   （実データには触れない。自分で一時フォルダを作る）"""
import csv
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


COLS = ["Folder Name", "List Name", "Title", "Kind", "Tags", "Content", "Is Check list", "Start Date", "Due Date", "Reminder", "Repeat",
        "Priority", "Status", "Created Time", "Completed Time", "Order", "Timezone", "Is All Day", "Is Floating", "Column Name",
        "Column Order", "View Mode", "taskId", "parentId", "projectKind"]


def row(**kw):
    r = {c: "" for c in COLS}
    r.update({"Kind": "TEXT", "Status": "0", "Order": "1", "Timezone": "Asia/Tokyo", "Is All Day": "false", "projectKind": "TASK"})
    r.update(kw)
    return r


rows = [
    row(**{"Folder Name": "仕事", "List Name": "営業", "Title": "見積もりを送る", "Tags": "急ぎ", "Due Date": "2026-10-20T00:00:00+0000", "Is All Day": "true",
           "Priority": "5", "Created Time": "2026-10-01T00:00:00+0000", "taskId": "t1"}),
    row(**{"List Name": "買い物", "Title": "牛乳", "Status": "2", "Created Time": "2026-10-02T00:00:00+0000",
           "Completed Time": "2026-10-03T01:30:00+0000", "taskId": "t2"}),
    row(**{"List Name": "買い物", "Title": "やめた買い物", "Status": "-1", "Created Time": "2026-10-02T01:00:00+0000",
           "Completed Time": "2026-10-04T02:00:00+0000", "taskId": "t3"}),
    row(**{"List Name": "資料", "Title": "読書メモ", "Content": "本文です", "projectKind": "NOTE", "Created Time": "2026-10-05T00:00:00+0000", "taskId": "t4"}),
    row(**{"Title": "リスト無しのメモ", "projectKind": "NOTE", "Created Time": "2026-10-06T00:00:00+0000", "taskId": "t5"}),
]

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:  # Windows では、開いたままの索引(index.db)があると消せないので、消せなくても失敗にしない
    csv_path = Path(td) / "export.csv"
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        f.write("Date: 2026-10-10\nVersion: 1\nStatus: 0 Normal 1 Completed 2 Archived\n")  # TickTick の書き出しは、先頭に説明の行がある
        w = csv.DictWriter(f, fieldnames=COLS, quoting=csv.QUOTE_ALL)
        w.writeheader()
        w.writerows(rows)
    data = Path(td) / "data"
    r = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "import_ticktick.py"), str(csv_path), "--data", str(data)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    check("取り込みが成功する", r.returncode == 0, r.stderr[-400:])
    sys.path.insert(0, str(ROOT / "app"))
    import os
    os.environ["TICK_DATA"] = str(data)
    import store
    store.init_git()
    store.reindex()
    notes = {n["title"]: n for n in store.list_notes()}
    check("5件が入る", len(notes) == 5, list(notes))
    a = store.get_note(notes["見積もりを送る"]["id"])
    check("フォルダ/リスト が list: になる", a["list"] == "仕事/営業", a["list"])
    check("タスク・優先度・日付・タグ", a["kind"] == "task" and a["priority"] == 5 and a["due"] == "2026-10-20" and "急ぎ" in a["tags"], a)
    check("本文に「リスト/」のタグが付かない", all(not t.startswith("リスト") for t in a["tags"]), a["tags"])
    b = store.get_note(notes["牛乳"]["id"])
    check("完了: 完了日が付く", b["done"] and not b["abandoned"] and b["completed"].startswith("2026-10-03"), b)
    c = store.get_note(notes["やめた買い物"]["id"])
    check("中止: 完了日は付かず、中止日が入る", c["abandoned"] and c["completed"] == "" and c["cancelled"].startswith("2026-10-04"), c)
    d = store.get_note(notes["読書メモ"]["id"])
    check("ノートは kind=note", d["kind"] == "note" and d["list"] == "資料", d)
    e = store.get_note(notes["リスト無しのメモ"]["id"])
    check("リストが無ければ受信箱（空）", e["list"] == "", e)
    r2 = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "import_ticktick.py"), str(csv_path), "--data", str(data)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    store._db = None
    store.reindex()
    check("もう一度取り込んでも、重複しない", r2.returncode == 0 and len(store.list_notes()) == 5, len(store.list_notes()))
    try:
        store._db.close()
    except Exception:
        pass
print("失敗", bad)
