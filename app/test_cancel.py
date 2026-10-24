"""中止（キャンセル。status: abandoned）の確認。TICK_DATA に空の一時フォルダを指定して実行"""
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
a = store.create_note("中止にする予定")["id"]
store.update_note(a, "中止にする予定", due="2026-12-01", event="1")
r = store.update_note(a, "中止にする予定", status="abandoned")
check("中止にできる（done も true）", r["done"] and r["abandoned"], r)
check("中止日が付く", len(r["cancelled"]) == 16, r["cancelled"])
check("完了日（実績）は付かない", r["completed"] == "", r["completed"])
text = store._path_of(a).read_text(encoding="utf-8")
check("ファイルに status: abandoned と cancelled: が書かれ、completed: は無い", "status: abandoned" in text and "cancelled: " in text and "completed:" not in text, text[:200])
check("日付（期日）は、そのまま残る", r["due"] == "2026-12-01", r["due"])
cal = store.calendar("2026-10", "completed", "all")
check("カレンダー（完了日）に出ない", all(x["id"] != a for v in cal.values() for x in v["items"]))
r2 = store.update_note(a, "中止にする予定", status="open")
check("中止を戻せる（中止日も消える）", not r2["done"] and not r2["abandoned"] and r2["cancelled"] == "" and "cancelled:" not in store._path_of(a).read_text(encoding="utf-8"), r2)

# 完了と中止は区別される
b = store.create_note("完了するもの")["id"]
rb = store.update_note(b, "完了するもの", status="done")
check("完了は abandoned ではない・完了日がある", rb["done"] and not rb["abandoned"] and rb["completed"] != "", rb)
check("完了にしたものを、中止にし直すのは、いったん戻してから（直接も可・完了日は消える）", store.update_note(b, "完了するもの", status="abandoned")["completed"] == "")

# 繰り返す予定: この回を中止 = 次の回へ進む。完了日は付かない
c = store.create_note("毎週の予定")["id"]
store.update_note(c, "毎週の予定", due="2026-10-01", repeat="FREQ=WEEKLY;BYDAY=TH", event="1")
rc = store.update_note(c, "毎週の予定", status="abandoned")
check("繰り返しは、中止にしても、終わらず、次の回へ進む", not rc["done"] and rc["due"] > "2026-10-01", rc)
ct = store._path_of(c).read_text(encoding="utf-8")
check("last_cancelled が付き、last_done・completed は付かない", "last_cancelled:" in ct and "last_done:" not in ct and "completed:" not in ct, ct[:300])

# 端末で「期日・繰り返しを決めてから、すぐ中止（完了）」した分が、1回の送信にまとまっても、次の回へ進む
e = store.create_note("まとめて届く予定")["id"]
re_ = store.update_note(e, "まとめて届く予定", due="2026-10-01", repeat="FREQ=WEEKLY;BYDAY=TH", event="1", status="abandoned")
check("期日・繰り返しと中止が同時に届いても、次の回へ進む", not re_["done"] and re_["due"] > "2026-10-01", re_)
f2 = store.create_note("まとめて届く完了")["id"]
rf = store.update_note(f2, "まとめて届く完了", due="2026-10-01", repeat="FREQ=WEEKLY;BYDAY=TH", status="done")
check("完了でも同じ（次の回へ進む）", not rf["done"] and rf["due"] > "2026-10-01", rf)

# 取り込み済みの中止（completed つき）は、中止として読み、完了日には数えない
d = store.create_note("取り込み風の中止")["id"]
p = store._path_of(d)
p.write_text(p.read_text(encoding="utf-8").replace("---\n", "---\nstatus: abandoned\ncompleted: 2021-12-23T10:49+09:00\n", 1), encoding="utf-8", newline="\n")
store._db = None
os.remove(store.DB_PATH)
store.reindex()
rd = store.get_note(d)
check("取り込み済みの中止を、中止として読む（完了日は空・中止日は元の日時）", rd["abandoned"] and rd["done"] and rd["completed"] == "" and rd["cancelled"] == "2021-12-23T10:49+09:00", rd)

# 不正な値
try:
    store.update_note(b, "完了するもの", status="cancelled")
    check("不正な status は拒否", False)
except ValueError:
    check("不正な status は拒否", True)
# 同期の差分に出る
seq0 = store.sync_pull(0)["seq"]
store.update_note(b, "完了するもの", status="open")
store.update_note(b, "完了するもの", status="abandoned")
check("同期の差分に、abandoned・cancelled が出る", any(n["id"] == b and n["abandoned"] and n["cancelled"] for n in store.sync_pull(seq0)["notes"]))
store.commit_now()
print("失敗", bad)
