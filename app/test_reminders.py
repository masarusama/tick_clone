"""日付・リマインダーの通知の確認（TICK_DATA に一時フォルダを指定して実行。実際の通知は送らない）"""
from datetime import datetime, timedelta

import reminders as R
import store

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


J = R.JST
dt = lambda s: datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=J)

# --- 長さの読み書き ---
check("-PT10M → 10分前", R.parse_duration("-PT10M") == 10)
check("PT0S → 日付の時刻", R.parse_duration("PT0S") == 0)
check("-P6DT15H0M0S（TickTickの取り込み値）→ 9540分前", R.parse_duration("-P6DT15H0M0S") == 9540)
check("PT540M → 540分後（-540）", R.parse_duration("PT540M") == -540)
check("TRIGGER:-PT5M も読める", R.parse_duration("TRIGGER:-PT5M") == 5)
check("壊れた値は None", R.parse_duration("abc") is None and R.parse_duration("") is None and R.parse_duration("P") is None)
check("書き戻し", R.fmt_duration(10) == "-PT10M" and R.fmt_duration(0) == "PT0S" and R.fmt_duration(-540) == "PT540M")
check("parse_reminders: 未設定/none/列", R.parse_reminders("") is None and R.parse_reminders("none") == [] and R.parse_reminders("-PT10M / PT0S") == [10, 0])
check("parse_reminders: 壊れていたら未設定扱い", R.parse_reminders("xxx / yyy") is None)
check("raw_from_minutes", R.raw_from_minutes([0, 10]) == "-PT10M / PT0S" and R.raw_from_minutes([]) == "none")

# --- 通知の時刻 ---
ft = lambda due, raw="": [(w.strftime("%m-%d %H:%M"), b) for w, b in R.fire_times(due, raw)]
check("終日の既定 = 当日の朝9:00", ft("2026-10-12") == [("10-12 09:00", -540)], ft("2026-10-12"))
check("時刻つきの既定 = 日付の時刻", ft("2026-10-12T15:30") == [("10-12 15:30", 0)])
check("10分前と日付の時刻", ft("2026-10-12T15:30", "-PT10M / PT0S") == [("10-12 15:20", 10), ("10-12 15:30", 0)])
check("通知しない(none)", ft("2026-10-12T15:30", "none") == [])
check("取り込み値 +09:00 付きの時刻つき日付", ft("2024-12-24T12:00+09:00") == [("12-24 12:00", 0)])
check("終日の前日朝9時 = 900分前", ft("2026-10-12", "-PT900M") == [("10-11 09:00", 900)])
check("日付が壊れていたら通知なし", ft("2026-13-45") == [] and ft("") == [])
check("ラベル: 終日の長い前（9540分前=7日前の朝9:00）", R.label(9540, True) == "7日前の朝9:00" and R.label(3780, True) == "3日前の朝9:00" and R.label(900, True) == "前日の朝9:00" and R.label(2340, True) == "2日前の朝9:00", (R.label(9540, True), R.label(3780, True)))
check("ラベル: 時刻つきの長い前（6日15時間前・1時間30分前・1時間30分後）", R.label(9540, False) == "6日15時間前" and R.label(90, False) == "1時間30分前" and R.label(-90, False) == "1時間30分後" and R.label(2880, False) == "2日前", (R.label(9540, False), R.label(90, False)))
check("ラベル", R.label(-540, True) == "当日の朝9:00" and R.label(10, False) == "10分前" and R.label(60, False) == "1時間前" and R.label(1440, False) == "前日の同じ時刻" and R.label(0, False) == "予定の時刻に")

# --- 保存（store）---
store.init_git()
store.reindex()
mk = lambda body: store.create_note(body)["id"]
A, B, C, D, E, F = (mk(x) for x in ("A終日", "B時刻つき", "C完了済み", "D過去", "E停止中", "F古すぎる"))
store.update_note(A, "A終日", "2026-10-12")
store.update_note(B, "B時刻つき", "2026-10-12T15:30", reminder="-PT10M")
store.update_note(C, "C完了済み", "2026-10-12", status="done")
store.update_note(D, "D過去", "2026-09-01")
store.update_note(E, "E停止中", "2026-10-12T20:00")
store.update_note(F, "F古すぎる", "2026-10-10T10:00")
g = lambda i: store.get_note(i)
check("時刻つき日付の保存", g(B)["due_set"] == "2026-10-12" and g(B)["due_time"] == "15:30" and g(B)["remind"] == "-PT10M", g(B))
check("終日の日付は時刻なし", g(A)["due_time"] == "" and g(A)["due_set"] == "2026-10-12")
try:
    store.update_note(A, "A終日", "2026-10-12T25:99")
    check("不正な時刻は拒否", False)
except ValueError:
    check("不正な時刻は拒否", True)
try:
    store.update_note(A, "A終日", reminder="xxx")
    check("不正なリマインダーは拒否", False)
except ValueError:
    check("不正なリマインダーは拒否", True)
store.update_note(A, "A終日", reminder="none")
check("none を保存", g(A)["remind"] == "none")
store.update_note(A, "A終日", reminder="")
check("空で既定に戻す", g(A)["remind"] == "")
store.update_note(A, "A終日", due="")
check("日付を消すとリマインダーも消える", g(A)["due_set"] == "" and g(A)["remind"] == "")
store.update_note(A, "A終日", "2026-10-12")
store.update_note(A, "A終日", "2026-10-12T10:00", reminder="-PT10M / PT0S")
check("時刻つきにして、リマインダーを設定", g(A)["remind"] == "-PT10M / PT0S")
store.update_note(A, "A終日", "2026-10-13T11:00")
check("時刻つきのまま日時を変えても、リマインダーは保つ", g(A)["remind"] == "-PT10M / PT0S")
store.update_note(A, "A終日", "2026-10-13")
check("終日に切り替えたら、リマインダーは既定に戻る", g(A)["remind"] == "" and g(A)["due_time"] == "")
store.update_note(A, "A終日", "2026-10-12")

# 本文の「!日付」も通知の対象
G = mk("G本文の日付 !10/14")
nd = store.db().execute("SELECT ndue FROM notes WHERE id=?", (G,)).fetchone()[0]
check("本文の !10/14 が通知用の日付になる", nd.endswith("-10-14"), nd)


# --- 時刻係 ---
class FakePush:
    def __init__(self, n=1):
        self.n, self.sent = n, []

    def count(self):
        return self.n

    def send(self, title, body, url, tag, urgency, note_id, actions):
        self.sent.append((title, body, url, tag, note_id, actions))


fp = FakePush(0)
k = R.Keeper(store, fp)
check("登録端末が0なら何もしない・記録も付けない", k.tick(dt("2026-10-12 09:00"), fp.send) == 0 and not k._path().exists())
fp.n = 1
check("初回は基準づくりだけで、過ぎたものは送らない", k.tick(dt("2026-10-01 00:00"), fp.send) == 0)
fp.sent.clear()
check("09:00前は送らない", k.tick(dt("2026-10-12 08:59"), fp.send) == 0)
check("A: 09:00 を過ぎたら1件", k.tick(dt("2026-10-12 09:00"), fp.send) == 1 and fp.sent[-1][0] == "A終日")
check("通知の中身: 終日・ボタン付き・メモを開くURL", fp.sent[-1][1].startswith("日付: 10/12（終日）") and fp.sent[-1][5] is True and fp.sent[-1][2] == f"/?note={A}", fp.sent[-1])
check("同じ通知を二重に送らない", k.tick(dt("2026-10-12 09:01"), fp.send) == 0)
check("B: 10分前（15:20）", k.tick(dt("2026-10-12 15:20"), fp.send) == 1 and "10分前" in fp.sent[-1][1], fp.sent[-1])
check("B: 設定が10分前だけなので、15:30は鳴らさない", k.tick(dt("2026-10-12 15:30"), fp.send) == 0)
n_before = len(fp.sent)
check("C: 完了済みは送らない", all(s[0] != "C完了済み" for s in fp.sent))
# PC停止中に過ぎた分（E=20:00）は、起動後に遅れて通知 / F は古すぎるので捨てる
sent_before = len(fp.sent)
n = k.tick(dt("2026-10-13 12:00"), fp.send)
titles = [s[0] for s in fp.sent[sent_before:]]
check("E: 停止中に過ぎた分は『遅れて通知』", "E停止中" in titles and any("遅れて通知" in s[1] for s in fp.sent[sent_before:] if s[0] == "E停止中"), fp.sent[sent_before:])
check("F: 24時間より古い分は捨てる", "F古すぎる" not in titles and "D過去" not in titles, titles)
check("G: 本文の !10/14 は、当日の朝9:00", k.tick(dt("2026-10-14 09:00"), fp.send) == 1 and fp.sent[-1][0].startswith("G本文"))

# --- あとで（スヌーズ）---
k.snooze(B, 10, dt("2026-10-15 10:00"))
check("あとで: 10分たつまでは送らない", k.tick(dt("2026-10-15 10:05"), fp.send) == 0)
check("あとで: 10分後に再通知", k.tick(dt("2026-10-15 10:11"), fp.send) == 1 and fp.sent[-1][1] == "あとで（再通知）" and fp.sent[-1][4] == B)
check("あとで: 送ったら消える", k.tick(dt("2026-10-15 10:30"), fp.send) == 0)
k.snooze(B, 10, dt("2026-10-15 11:00"))
store.update_note(B, "B時刻つき", status="done")
check("あとで: 完了したメモのスヌーズは捨てる", k.tick(dt("2026-10-15 11:30"), fp.send) == 0 and k._load()["snoozes"] == [])

# 日付を後ろにずらしたら、新しい時刻で、もう一度通知される
store.update_note(A, "A終日", "2026-10-20")
check("日付を変えると、新しい時刻で通知される", k.tick(dt("2026-10-20 09:00"), fp.send) == 1 and fp.sent[-1][0] == "A終日")

# 記録は、通知の中身（タイトル・本文）を含まない形（IDと時刻のみ）
st = k._load()
check("記録にはメモの中身を書かない", all("終日" not in key and "A" not in key.split("|")[1] for key in st["fired"]) and not any("A終日" in str(v) for v in st["fired"].values()))
store.commit_now()
print("失敗", bad)
