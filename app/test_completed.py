"""完了日（frontmatter completed:）の確認。TICK_DATA に空の一時フォルダを指定して実行"""
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
a = store.create_note("完了日のテスト")["id"]
check("未完了は、完了日が空", store.get_note(a)["completed"] == "")
seq0 = store.sync_pull(0)["seq"]
r = store.update_note(a, "完了日のテスト", status="done")
check("完了にすると、完了日が付く（YYYY-MM-DDTHH:MM）", len(r["completed"]) == 16 and r["completed"][10] == "T", r["completed"])
check("同期の差分に、完了日が出る", any(n["id"] == a and n["completed"] == r["completed"] for n in store.sync_pull(seq0)["notes"]))
check("ファイルに completed: が書かれる", "completed: " + r["completed"] in store._path_of(a).read_text(encoding="utf-8"))
r2 = store.update_note(a, "完了日のテスト", status="open")
check("完了を戻すと、完了日が消える", r2["completed"] == "" and "completed:" not in store._path_of(a).read_text(encoding="utf-8"), r2["completed"])

# 取り込み済みの完了メモ（completed が +09:00 つき）は、そのまま読める
b = store.create_note("取り込み風")["id"]
p = store._path_of(b)
p.write_text(p.read_text(encoding="utf-8").replace("---\n", "---\nstatus: done\ncompleted: 2021-03-16T10:29+09:00\n", 1), encoding="utf-8", newline="\n")
store._db = None
os.remove(store.DB_PATH)
store.reindex()
check("取り込み済みの完了日を読める", store.get_note(b)["completed"] == "2021-03-16T10:29+09:00", store.get_note(b)["completed"])

# 未完了なのに completed: が残っているメモ（古い残り）は、完了日を出さない
c = store.create_note("残り")["id"]
p = store._path_of(c)
p.write_text(p.read_text(encoding="utf-8").replace("---\n", "---\nstatus: open\ncompleted: 2020-01-01T00:00\n", 1), encoding="utf-8", newline="\n")
store._db = None
os.remove(store.DB_PATH)
store.reindex()
check("未完了のメモは、completed: が残っていても、完了日を出さない", store.get_note(c)["completed"] == "")
# カレンダー: 完了日で見る
d = store.create_note("完了日のカレンダー")["id"]
r = store.update_note(d, "完了日のカレンダー", status="done")
day = r["completed"][:10]
cal = store.calendar(day[:7], "completed", "all")
check("カレンダー（完了日）: 完了した日に出る", day in cal and any(x["id"] == d for x in cal[day]["items"]), cal.get(day))
check("カレンダー（完了日）: 未完了のメモは出ない", all(x["id"] != a for v in cal.values() for x in v["items"]))
check("日付での絞り込み（完了日）", any(x["id"] == d for x in store.list_notes(date_=day, src="completed")) and not any(x["id"] == a for x in store.list_notes(date_=day, src="completed")))

# 完了日を、実際に終わった日にする（あとから完了ボタンを押したとき）
z = store.create_note("運動会（あとから完了）")["id"]
store.update_note(z, "運動会（あとから完了）", due="2026-10-17", event="1")
store.update_note(z, "運動会（あとから完了）", status="done", completed="2026-10-17")
check("完了と同時に、完了日を指定できる", store.get_note(z)["completed"] == "2026-10-17", store.get_note(z))
store.update_note(z, "運動会（あとから完了）", completed="2026-10-18")
check("完了済みの、完了日だけを変えられる", store.get_note(z)["completed"] == "2026-10-18")
cal2 = store.calendar_full("2026-10-01", "2026-11-01", "completed") if hasattr(store, "calendar_full") else None
y = store.create_note("未完了に日付指定")["id"]
store.update_note(y, "未完了に日付指定", completed="2026-10-01")
check("未完了のメモには、完了日が付かない", store.get_note(y)["completed"] == "")
try:
    store.update_note(z, "運動会（あとから完了）", completed="2026-13-45")
    check("不正な完了日は、エラー", False)
except ValueError:
    check("不正な完了日は、エラー", True)
store.commit_now()
print("失敗", bad)

