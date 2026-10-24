"""繰り返しの計算の確認（画面側 data.js と同じ例で、画面側も確かめる）"""
import sys
from datetime import date

import recur

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


D = lambda s: date.fromisoformat(s)

# 次の回: (決まり, 期日, 期待)
NEXT = [
    ("FREQ=DAILY", "2026-10-11", "2026-10-12"),
    ("FREQ=DAILY;INTERVAL=3", "2026-10-30", "2026-11-02"),
    ("FREQ=WEEKLY", "2026-10-11", "2026-10-18"),
    ("FREQ=WEEKLY;INTERVAL=2", "2026-10-11", "2026-10-25"),
    ("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-10-12", "2026-10-14"),        # 月 → 水
    ("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-10-16", "2026-10-19"),        # 金 → 次の月
    ("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-10-09", "2026-10-12"),  # 平日: 金 → 月
    ("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "2026-10-13", "2026-10-27"),
    ("FREQ=MONTHLY;BYMONTHDAY=10", "2026-10-10", "2026-11-10"),
    ("FREQ=MONTHLY;BYMONTHDAY=31", "2026-10-31", "2026-11-30"),        # 30日までの月は、月末に
    ("FREQ=MONTHLY;BYMONTHDAY=31", "2026-11-30", "2026-12-31"),
    ("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-02-28", "2026-03-31"),
    ("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=19", "2026-10-19", "2026-11-19"),
    ("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=5", "2026-10-05", "2026-12-05"),
    ("FREQ=MONTHLY", "2026-01-31", "2026-02-28"),
    ("FREQ=YEARLY", "2026-10-11", "2027-10-11"),
    ("FREQ=YEARLY", "2024-02-29", "2025-02-28"),
    ("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15", "2026-10-11", "2027-03-15"),
    ("RRULE:FREQ=DAILY", "2026-10-11", "2026-10-12"),
]
for rule, due, want in NEXT:
    r = recur.parse(rule)
    got = recur.next_after(r, D(due)) if r else None
    check(f"次の回 {rule} {due}", got == D(want), got)

# 読めない決まり
for rule in ("", "FREQ=HOURLY", "FREQ=MONTHLY;BYDAY=2TU", "FREQ=WEEKLY;BYDAY=XX", "abc", "FREQ=DAILY;INTERVAL=0", "FREQ=MONTHLY;BYMONTHDAY=40"):
    check(f"読めない: {rule!r}", recur.parse(rule) is None)

# UNTIL
r = recur.parse("FREQ=DAILY;UNTIL=20261012")
check("UNTIL の翌日は無い", recur.next_after(r, D("2026-10-12")) is None and recur.next_after(r, D("2026-10-11")) == D("2026-10-12"))

# 遅れて完了: 過ぎた回を飛ばして、今日以降へ
r = recur.parse("FREQ=DAILY")
check("遅れて完了（毎日）→今日", recur.advance(r, D("2026-10-05"), D("2026-10-11")) == D("2026-10-11"))
check("早く完了（毎日）→期日の翌日", recur.advance(r, D("2026-10-20"), D("2026-10-11")) == D("2026-10-21"))
r = recur.parse("FREQ=MONTHLY;BYMONTHDAY=10")
check("遅れて完了（毎月10日・12日に完了）→来月10日", recur.advance(r, D("2026-10-10"), D("2026-10-12")) == D("2026-11-10"))
check("3か月遅れて完了→今日以降の最初の10日", recur.advance(r, D("2026-07-10"), D("2026-10-12")) == D("2026-11-10"))

# 本文から
TXT = [
    ("毎週火曜 10時にゴミ出し", "FREQ=WEEKLY;BYDAY=TU"),
    ("毎週火・金にジム", "FREQ=WEEKLY;BYDAY=TU,FR"),
    ("毎週月水金", "FREQ=WEEKLY;BYDAY=MO,WE,FR"),
    ("毎週", "FREQ=WEEKLY"),
    ("毎月10日に支払い", "FREQ=MONTHLY;BYMONTHDAY=10"),
    ("毎月末に請求", "FREQ=MONTHLY;BYMONTHDAY=-1"),
    ("月末の掃除", "FREQ=MONTHLY;BYMONTHDAY=-1"),
    ("毎日ストレッチ", "FREQ=DAILY"),
    ("毎日新聞を読む", ""),
    ("毎週末は休み", ""),
    ("平日だけ", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
    ("隔週で会議", "FREQ=WEEKLY;INTERVAL=2"),
    ("毎年10月11日", "FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=11"),
    ("3日ごとに水やり", "FREQ=DAILY;INTERVAL=3"),
    ("普通のメモ 10/12", ""),
    ("```\n毎日\n```", ""),
]
for text, want in TXT:
    check(f"本文 {text!r}", recur.extract_repeat(text) == want, recur.extract_repeat(text))

print("失敗", bad)
sys.exit(1 if bad else 0)
