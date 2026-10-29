"""予定の印（event）と、本文の日時の種類・範囲の確認。TICK_DATA に一時フォルダを指定して実行"""
import store

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


store.init_git()
store.reindex()

# --- 本文の日時: 範囲と種類が索引に入る ---
n = store.create_note("10/12 に小田切概替\n\n17:00-19:00 で以前の振替を消化", None, "2026-10-06T10:00:00+09:00")
g = store.get_note(n["id"])
texts = [x for x in g["dates"] if x[1] == "text"]
check("範囲つきの時刻が索引に入る", texts == [["2026-10-12", "text", "17:00-19:00", "event", ""]], texts)
m = store.create_note("10/20 18:00 締切", None, "2026-10-06T10:00:00+09:00")
tm = [x for x in store.get_note(m["id"])["dates"] if x[1] == "text"]
check("締切の種類が入る", tm == [["2026-10-20", "text", "18:00", "deadline", ""]], tm)

# --- event ---
a = store.create_note("予定のメモ")["id"]
check("最初は予定ではない", store.get_note(a)["event"] == "")
store.update_note(a, "予定のメモ", due="2020-01-05T17:00")
check("過去の日付は期限切れに出る", any(x["id"] == a for x in store.list_notes(view="overdue", today="2026-10-11")))
r = store.update_note(a, "予定のメモ", event="19:00")
check("終わりの時刻つきの予定にできる", r["event"] == "19:00", r)
check("ファイルに event が書かれる", "event: 19:00" in store._path_of(a).read_text(encoding="utf-8"))
check("予定は、過ぎても期限切れに出ない", not any(x["id"] == a for x in store.list_notes(view="overdue", today="2026-10-11")))
check("同期の差分に event が出る", any(x["id"] == a and x["event"] == "19:00" for x in store.sync_pull(0)["notes"]))
r = store.update_note(a, "予定のメモ", event="1")
check("終わりなしの予定", r["event"] == "1", r)
try:
    store.update_note(a, "予定のメモ", event="25:99")
    check("不正な event は拒否", False)
except ValueError:
    check("不正な event は拒否", True)
r = store.update_note(a, "予定のメモ", event="")
check("締切に戻せる", r["event"] == "" and any(x["id"] == a for x in store.list_notes(view="overdue", today="2026-10-11")), r)
store.update_note(a, "予定のメモ", event="1")
r = store.update_note(a, "予定のメモ", due="")
check("日付を消すと、予定の印も消える", r["event"] == "" and r["due"] is None, r)
store.reindex()
check("索引を作り直しても event は保たれる", store.get_note(a)["event"] == "")

# --- 複数日 ---
r = store.create_note("10/12〜10/14 出張", None, "2026-10-06T10:00:00+09:00")
tr = [x for x in store.get_note(r["id"])["dates"] if x[1] == "text"]
check("本文の日付の範囲が、全日の行になる", [x[0] for x in tr] == ["2026-10-12", "2026-10-13", "2026-10-14"] and all(x[4] == "2026-10-14" and x[3] == "event" for x in tr), tr)
b = store.create_note("出張")["id"]
store.update_note(b, "出張", due="2026-10-14")
r = store.update_note(b, "出張", start="2026-10-12")
check("複数日にできる（日付が終わりの日）", [x[0] for x in r["dates"] if x[1] == "due"] == ["2026-10-12", "2026-10-13", "2026-10-14"], r["dates"])
check("ファイルに start が書かれる", "start: 2026-10-12" in store._path_of(b).read_text(encoding="utf-8"))
r = store.update_note(b, "出張", due="2026-10-20")
check("日付だけを変えると、複数日は解除される", [x[0] for x in r["dates"] if x[1] == "due"] == ["2026-10-20"], r["dates"])
store.update_note(b, "出張", due="2026-10-20", start="2026-10-18")
check("日付と開始日を同時に設定できる", [x[0] for x in store.get_note(b)["dates"] if x[1] == "due"] == ["2026-10-18", "2026-10-19", "2026-10-20"])
for bad_start in ("2026-10-25", "abc"):
    try:
        store.update_note(b, "出張", start=bad_start)
        check("不正な開始日は拒否 " + bad_start, False)
    except ValueError:
        check("不正な開始日は拒否 " + bad_start, True)
r = store.update_note(b, "出張", start="")
check("複数日をやめられる", [x[0] for x in r["dates"] if x[1] == "due"] == ["2026-10-20"], r["dates"])
print("失敗", bad)
