"""リスト（frontmatter list:）の保存の確認。TICK_DATA に一時フォルダを指定して実行"""
import os
import time

import store

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


store.init_git()
store.reindex()
a = store.create_note("A #メモ")["id"]
na = store.get_note(a)
check("最初はリストなし(空)", na["list"] == "")
u0 = na["updated"]
time.sleep(1.1)
seq0 = store.sync_pull(0)["seq"]

r = store.update_note(a, "A #メモ", list_="買い物")
check("リストを付けられる", r["list"] == "買い物", r)
check("リストを付けると更新日が変わる", r["updated"] != u0)
check("同期の差分に出る", any(n["id"] == a and n["list"] == "買い物" for n in store.sync_pull(seq0)["notes"]))
check("ファイルに list: が書かれる", "list: 買い物" in store._path_of(a).read_text(encoding="utf-8"))
check("本文は変わらない", r["body"].strip() == "A #メモ", r["body"])

seq1 = store.sync_pull(0)["seq"]
store.update_note(a, "A #メモ", list_="買い物")
check("同じ値なら何も変えない", store.sync_pull(0)["seq"] == seq1)

r = store.update_note(a, "A #メモ", list_=" 仕事 / 営業 ")
check("フォルダ/リスト に整えられる", r["list"] == "仕事/営業", r["list"])
r = store.update_note(a, "A #メモ（編集）")
check("本文を編集してもリストは保たれる", r["list"] == "仕事/営業", r["list"])
r = store.update_note(a, "A #メモ（編集）", list_="")
check("空にするとリストなしに戻る", r["list"] == "" and "list:" not in store._path_of(a).read_text(encoding="utf-8"))

for bad_v in ("a/b/c", "x#y", "x" * 101, "a\nb"):
    try:
        store.update_note(a, "A #メモ（編集）", list_=bad_v)
        check(f"不正は拒否: {bad_v!r}", False)
    except ValueError:
        check(f"不正は拒否: {bad_v!r}", True)

# ファイルに直接書かれた壊れた値は、リストなし扱い（落ちない）
p = store._path_of(a)
p.write_text(p.read_text(encoding="utf-8").replace("---\n", "---\nlist: a/b/c/d\n", 1), encoding="utf-8", newline="\n")
store._db = None
os.remove(store.DB_PATH)
store.reindex()
check("壊れた list: は空扱い", store.get_note(a)["list"] == "")

b = store.create_note("B")["id"]
store.update_note(b, "B", list_="Inbox")
store._db = None
os.remove(store.DB_PATH)
store.reindex()
check("索引を消しても、ファイルからリストが復元される", store.get_note(b)["list"] == "Inbox")
check("一覧にも出る", {n["id"]: n["list"] for n in store.list_notes()}.get(b) == "Inbox")
store.commit_now()
print("失敗", bad)
