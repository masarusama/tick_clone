"""繰り返しのメモの保存と、完了で次の回へ進む動きの確認。TICK_DATA に一時フォルダを指定して実行"""
import sys
from datetime import date, timedelta

import store

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


store.init_git()
store.reindex()
today = date.today()
iso = lambda d: d.isoformat()

# --- 設定 ---
a = store.create_note("ゴミ出し")["id"]
store.update_note(a, "ゴミ出し", due=iso(today) + "T08:00")
r = store.update_note(a, "ゴミ出し", repeat="FREQ=DAILY")
check("繰り返しを設定できる", r["repeat"] == "FREQ=DAILY", r)
check("ファイルに repeat が書かれる", "repeat: FREQ=DAILY" in store._path_of(a).read_text(encoding="utf-8"))
try:
    store.update_note(a, "ゴミ出し", repeat="FREQ=NEVER")
    check("不正な繰り返しは拒否", False)
except ValueError:
    check("不正な繰り返しは拒否", True)

# --- 完了 → 次の回へ ---
r = store.update_note(a, "ゴミ出し", status="done")
check("完了すると、日付が翌日の同じ時刻に進む", r["due"] == iso(today + timedelta(days=1)) and r["due_time"] == "08:00", r)
check("完了にはならない", r["done"] is False)
check("最後に完了した日時が残る", "last_done:" in store._path_of(a).read_text(encoding="utf-8"))
check("同じ時刻・リマインダーが保たれる", r["due_time"] == "08:00")
check("日付が今日より先なので、期限切れには出ない", not any(x["id"] == a for x in store.list_notes(view="overdue", today=iso(today))))

# --- 遅れて完了: 過ぎた回を飛ばす ---
b = store.create_note("毎日の薬")["id"]
store.update_note(b, "毎日の薬", due=iso(today - timedelta(days=5)))
store.update_note(b, "毎日の薬", repeat="FREQ=DAILY")
r = store.update_note(b, "毎日の薬", status="done")
check("遅れて完了すると、今日に進む", r["due"] == iso(today), r)

# --- 繰り返さないメモは、ふつうに完了 ---
c = store.create_note("ふつう")["id"]
store.update_note(c, "ふつう", due=iso(today))
r = store.update_note(c, "ふつう", status="done")
check("繰り返さないメモは、完了になる", r["done"] is True and r["due"] == iso(today), r)

# --- 日付が無い繰り返しは、ふつうに完了 ---
d = store.create_note("日付なし")["id"]
store.update_note(d, "日付なし", repeat="FREQ=WEEKLY")
r = store.update_note(d, "日付なし", status="done")
check("日付が無ければ、完了になる", r["done"] is True, r)

# --- UNTIL を過ぎたら、完了になる ---
e = store.create_note("期限つき")["id"]
store.update_note(e, "期限つき", due=iso(today))
store.update_note(e, "期限つき", repeat="FREQ=DAILY;UNTIL=" + today.strftime("%Y%m%d"))
r = store.update_note(e, "期限つき", status="done")
check("最後の回を完了すると、完了になる", r["done"] is True, r)

# --- 複数日の長さを保つ ---
f = store.create_note("出張")["id"]
store.update_note(f, "出張", due=iso(today + timedelta(days=2)))
store.update_note(f, "出張", start=iso(today))
store.update_note(f, "出張", repeat="FREQ=WEEKLY")
r = store.update_note(f, "出張", status="done")
want_end = today + timedelta(days=9)
check("複数日の長さ（3日）を保って、次の週へ", [x[0] for x in r["dates"] if x[1] == "due"] == [iso(want_end - timedelta(days=2)), iso(want_end - timedelta(days=1)), iso(want_end)], r["dates"])

# --- 毎月（取り込んだ形） ---
g = store.create_note("支払い")["id"]
store.update_note(g, "支払い", due="2026-10-10", repeat="FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=10")
check("取り込んだ形の決まりも読める", store.get_note(g)["repeat"] == "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=10")

# --- 繰り返しをやめる ---
r = store.update_note(a, "ゴミ出し", repeat="")
check("やめられる", r["repeat"] == "")

# --- 本文からの提案 ---
h = store.create_note("毎週火曜 10時にゴミ出し")["id"]
check("本文の「毎週火曜」が提案になる", store.get_note(h)["repeat_sug"] == "FREQ=WEEKLY;BYDAY=TU", store.get_note(h))
check("まだ繰り返しではない", store.get_note(h)["repeat"] == "")

# --- 索引を作り直しても保たれる / 同期の差分に出る ---
store.reindex()
check("索引を作り直しても repeat は保たれる", store.get_note(g)["repeat"] != "" and store.get_note(h)["repeat_sug"] != "")
check("同期の差分に repeat が出る", any(x["id"] == g and x["repeat"] for x in store.sync_pull(0)["notes"]))
print("失敗", bad)
sys.exit(1 if bad else 0)
