"""ノート/タスクの区別（frontmatter kind:）の確認。TICK_DATA に空の一時フォルダを指定して実行"""
import os

import store

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


store.init_git()
store.reindex()

# 種類の自動判定: kind: が無ければ、status: があるものはタスク、無いものはノート
n = store.create_note("普通のメモ")["id"]
check("status も kind も無ければ、ノート", store.get_note(n)["kind"] == "note")
t = store.create_note("取り込み風のタスク")["id"]
p = store._path_of(t)
p.write_text(p.read_text(encoding="utf-8").replace("---\n", "---\nstatus: open\n", 1), encoding="utf-8", newline="\n")
store._db = None
os.remove(store.DB_PATH)
store.reindex()
check("status: があれば、タスク", store.get_note(t)["kind"] == "task")

# 種類を設定する
r = store.update_note(n, "普通のメモ", kind="task")
check("kind=task にできる", r["kind"] == "task", r)
check("ファイルに kind: が書かれる", "kind: task" in store._path_of(n).read_text(encoding="utf-8"))
r = store.update_note(n, "普通のメモ", kind="note")
check("kind=note に戻せる", r["kind"] == "note")
try:
    store.update_note(n, "普通のメモ", kind="memo")
    check("不正な種類は拒否", False)
except ValueError:
    check("不正な種類は拒否", True)

# ノートを完了にしても、タスクに変わらない
m = store.create_note("完了にするノート")["id"]
r = store.update_note(m, "完了にするノート", status="done")
check("ノートを完了にしても、ノートのまま", r["kind"] == "note" and r["done"], r)
check("このとき kind: note が書き留められる", "kind: note" in store._path_of(m).read_text(encoding="utf-8"))
r = store.update_note(t, "取り込み風のタスク", status="done")
check("タスクを完了にしても、タスクのまま", r["kind"] == "task" and r["done"])
# 同じ状態を送り直しても、何も変わらない（余計な書き込みをしない）
seq = store.sync_pull(0)["seq"]
store.update_note(t, "取り込み風のタスク", status="done")
check("同じ完了を送り直しても、変更番号が進まない", store.sync_pull(0)["seq"] == seq)

# 壊れた kind: は、自動判定にもどる
q = store.create_note("壊れた種類")["id"]
p = store._path_of(q)
p.write_text(p.read_text(encoding="utf-8").replace("---\n", "---\nkind: ???\nstatus: open\n", 1), encoding="utf-8", newline="\n")
store._db = None
os.remove(store.DB_PATH)
store.reindex()
check("壊れた kind: は、自動判定（status があるのでタスク）", store.get_note(q)["kind"] == "task")

d0 = store.create_note("あとで期日を付けるメモ")["id"]
check("期日が無ければ、ノート", store.get_note(d0)["kind"] == "note")
store.update_note(d0, "あとで期日を付けるメモ", due="2026-12-01")
check("kind が無いノートに期日を付けると、タスクになる", store.get_note(d0)["kind"] == "task")
e0 = store.create_note("ノートのまま期日を付ける")["id"]
store.update_note(e0, "ノートのまま期日を付ける", due="2026-12-01", kind="note")
check("kind=note と一緒なら、期日つきでもノートのまま", store.get_note(e0)["kind"] == "note")
store.update_note(d0, "あとで期日を付けるメモ", due="")
check("期日を消しても、タスクのまま", store.get_note(d0)["kind"] == "task")
# 古いメモ（kind: が無く、期日がある）は、タスクとして読まれ、期日を変えてもタスクのまま
o = store.create_note("古い期日つきメモ")["id"]
p = store._path_of(o)
p.write_text(p.read_text(encoding="utf-8").replace("---\n", "---\ndue: 2020-01-01\nallday: yes\n", 1), encoding="utf-8", newline="\n")
store._db = None
os.remove(store.DB_PATH)
store.reindex()
check("kind: が無く期日があれば、タスク", store.get_note(o)["kind"] == "task")
store.update_note(o, "古い期日つきメモ", due="")
check("期日を消しても、タスクのまま（種類が書き留められる）", store.get_note(o)["kind"] == "task")

# 絞り込み: ノート一覧・期限切れにノートは出ない
a = store.create_note("期日つきノート")["id"]
store.update_note(a, "期日つきノート", due="2020-01-01", kind="note")
b = store.create_note("期日つきタスク")["id"]
store.update_note(b, "期日つきタスク", due="2020-01-01", kind="task")
ids = lambda **kw: {x["id"] for x in store.list_notes(**kw)}
check("期限切れに、タスクは出る", b in ids(view="overdue", today="2026-10-11"))
check("期限切れに、ノートは出ない", a not in ids(view="overdue", today="2026-10-11"))
check("ノート一覧にノートが出る", a in ids(view="notes") and b not in ids(view="notes"))
c = store.counts("all", "2026-10-11")
check("件数に notes がある", c["notes"] == len(ids(view="notes")), c)
store.commit_now()
print("失敗", bad)
