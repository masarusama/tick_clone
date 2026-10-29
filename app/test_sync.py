"""同期まわりの確認（TICK_DATA に一時フォルダを指定して実行）"""
import store

store.init_git()
store.reindex()
bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


ep = store.epoch()
p0 = store.sync_pull(0)
check("空の状態の同期", p0["notes"] == [] and p0["deleted"] == [], p0)

a = store.create_note("最初のメモ #仕事")
p1 = store.sync_pull(p0["seq"])
check("作成が差分に出る", [n["id"] for n in p1["notes"]] == [a["id"]] and p1["seq"] > p0["seq"])
check("差分に本文・タグ・日付配列がある", p1["notes"][0]["body"].startswith("最初") and p1["notes"][0]["tags"] == ["仕事"] and "dates" in p1["notes"][0])

# 端末で先に作ったメモ（id・日時を指定）。再送しても重複しない
cid, cts = "20261007-090000-abcd", "2026-10-07T09:00:00+09:00"
b1 = store.create_note("オフライン作成", cid, cts)
b2 = store.create_note("オフライン作成(再送)", cid, cts)
check("id指定で作成・再送は同じメモ", b1["id"] == cid == b2["id"] and b2["body"] == "オフライン作成")
check("作成日は指定どおり", b1["created"] == cts)
try:
    store.create_note("x", "bad-id", cts)
    check("不正なidは拒否", False)
except ValueError:
    check("不正なidは拒否", True)

# 競合: 端末が U0 を元に編集 → その間にサーバーが更新
u0 = a["updated"]
import time
time.sleep(1.1)
srv = store.update_note(a["id"], "サーバー側で更新")
check("updated が進む", srv["updated"] != u0)
try:
    store.update_note(a["id"], "端末側の古い版からの編集", None, u0)
    check("競合を検出", False)
except store.Conflict as c:
    check("競合を検出", c.note["body"] == "サーバー側で更新")
ok = store.update_note(a["id"], "端末が最新を元に編集", None, srv["updated"])
check("最新のbaseなら通る", ok["body"] == "端末が最新を元に編集")
same = store.update_note(a["id"], "端末が最新を元に編集", None, "古いbase")
check("本文が同じなら競合にしない", same["body"] == "端末が最新を元に編集")

# 削除の通知
cur = store.sync_pull(0)["seq"]
store.delete_note(cid)
p2 = store.sync_pull(cur)
check("削除が差分に出る", p2["deleted"] == [cid] and all(n["id"] != cid for n in p2["notes"]))

# 日付
u = store.update_note(a["id"], "端末が最新を元に編集", "2026-10-20")
check("日付が差分に出る", store.sync_pull(cur)["notes"][-1]["due_set"] == "2026-10-20")
check("epochは安定", store.epoch() == ep)
store.commit_now()
print("失敗", bad)
