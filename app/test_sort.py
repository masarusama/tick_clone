"""手動の並べ替えの保存の確認。TICK_DATA に一時フォルダを指定して実行"""
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
a = store.create_note("A")["id"]
b = store.create_note("B")["id"]
na = store.get_note(a)
check("最初は並び順が未設定(None)", na["sort"] is None)
u0 = na["updated"]
time.sleep(1.1)
seq0 = store.sync_pull(0)["seq"]
r = store.update_note(a, "A", sort=-123.5)
check("並び順を保存できる", r["sort"] == -123.5, r)
check("並べ替えだけでは、更新日が変わらない", r["updated"] == u0, (r["updated"], u0))
check("同期の差分に出る", any(n["id"] == a and n["sort"] == -123.5 for n in store.sync_pull(seq0)["notes"]))
check("ファイルに sort が書かれる", "sort: -123.5" in store._path_of(a).read_text(encoding="utf-8"))
seq1 = store.sync_pull(0)["seq"]
r2 = store.update_note(a, "A", sort=-123.5)
check("同じ値なら、何も変えない（変更番号も進まない）", store.sync_pull(0)["seq"] == seq1 and r2["sort"] == -123.5)
r3 = store.update_note(a, "A（本文を変えた）")
check("本文を変えたら、更新日は変わり、並び順は保たれる", r3["updated"] != u0 and r3["sort"] == -123.5, r3)
r4 = store.update_note(a, "A（本文を変えた）", sort=7)
check("整数も受け付ける", r4["sort"] == 7.0)
for bad_v in (float("nan"), float("inf"), 1e13, "abc"):
    try:
        store.update_note(a, "A（本文を変えた）", sort=bad_v)
        check(f"不正な値は拒否: {bad_v}", False)
    except ValueError:
        check(f"不正な値は拒否: {bad_v}", True)
check("拒否された後も、値は無事", store.get_note(a)["sort"] == 7.0)
# 索引を作り直しても、ファイルから復元される
store._db = None
import os
os.remove(store.DB_PATH)
store.reindex()
check("索引を消しても、ファイルから並び順が復元される", store.get_note(a)["sort"] == 7.0 and store.get_note(b)["sort"] is None)
# 並び順つきで作る（端末で先に並べてから作ったメモ）
c = store.create_note("C", sort=None)["id"] if False else store.create_note("C")["id"]
store.update_note(c, "C", None, None, None, None, None, None, -5.0)
check("作成後に並び順を付けられる", store.get_note(c)["sort"] == -5.0)
store.commit_now()
print("失敗", bad)
