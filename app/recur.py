"""繰り返し（毎日・毎週・毎月・毎年）の決まり。メモの先頭の枠(frontmatter)の `repeat:` に、RRULE に似た文字列で持つ。

  FREQ=DAILY | WEEKLY | MONTHLY | YEARLY
  INTERVAL=n               n回ごと（既定 1）
  BYDAY=MO,TU,WE,TH,FR     毎週の曜日（FREQ=WEEKLY のとき）
  BYMONTHDAY=d             毎月の日（-1 = 月末）。FREQ=YEARLY のときは、BYMONTH と対で「毎年 m月d日」
  BYMONTH=m
  UNTIL=YYYYMMDD           この日まで

TickTick から取り込んだ `FREQ=MONTHLY;BYMONTHDAY=10` などは、そのまま読める。
読めない決まり（「第2火曜」など）は parse が None を返し、普通のメモとして扱う。
画面側の data.js にも、同じ計算の移植がある（変えるときは、両方を直す。test_recur.py と同じ例で確かめる）。
"""
import calendar
import re
from datetime import date, timedelta

DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


def parse(rule):
    """決まりの文字列 → dict。読めなければ None"""
    if not rule or not isinstance(rule, str):
        return None
    s = rule.strip()
    s = re.sub(r"^(RRULE|ERULE):", "", s, flags=re.I)
    parts = {}
    for tok in s.split(";"):
        if "=" not in tok:
            continue
        k, v = tok.split("=", 1)
        parts[k.strip().upper()] = v.strip().upper()
    freq = parts.get("FREQ")
    if freq not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
        return None
    try:
        interval = int(parts.get("INTERVAL", "1"))
    except ValueError:
        return None
    if not 1 <= interval <= 365:
        return None
    r = {"freq": freq, "interval": interval, "byday": [], "bymonthday": None, "bymonth": None, "until": None}
    if "BYDAY" in parts:
        for d in parts["BYDAY"].split(","):
            if d not in DAYS:  # 「2TU」（第2火曜）などは、まだ扱わない
                return None
            r["byday"].append(DAYS.index(d))
        if freq != "WEEKLY":
            return None
    for key, lo, hi in (("BYMONTHDAY", -1, 31), ("BYMONTH", 1, 12)):
        if key in parts:
            try:
                v = int(parts[key])
            except ValueError:
                return None
            if not (lo <= v <= hi) or v == 0:
                return None
            r[key.lower()] = v
    if "UNTIL" in parts:
        m = re.match(r"(\d{4})(\d{2})(\d{2})", parts["UNTIL"])
        if not m:
            return None
        try:
            r["until"] = date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    return r


def _month_day(y, m, day):
    last = calendar.monthrange(y, m)[1]
    return date(y, m, last if day == -1 else min(day, last))


def _add_months(y, m, n):
    t = y * 12 + (m - 1) + n
    return t // 12, t % 12 + 1


def next_after(r, d):
    """決まり r で、日付 d より後の、最初の日（UNTIL を過ぎたら None）"""
    f, n = r["freq"], r["interval"]
    if f == "DAILY":
        c = d + timedelta(days=n)
    elif f == "WEEKLY":
        if r["byday"]:
            week0 = d - timedelta(days=d.weekday())
            c = None
            for k in range(1, 7 * n + 8):
                x = d + timedelta(days=k)
                if x.weekday() in r["byday"] and ((x - timedelta(days=x.weekday())) - week0).days // 7 % n == 0:
                    c = x
                    break
            if c is None:
                return None
        else:
            c = d + timedelta(days=7 * n)
    elif f == "MONTHLY":
        day = r["bymonthday"] if r["bymonthday"] is not None else d.day
        same = _month_day(d.year, d.month, day)
        if r["bymonthday"] is not None and same > d:
            c = same  # 今月の、まだ先の日
        else:
            y, m = _add_months(d.year, d.month, n)
            c = _month_day(y, m, day)
    else:  # YEARLY
        mo = r["bymonth"] or d.month
        day = r["bymonthday"] if r["bymonthday"] is not None else d.day
        y = d.year
        c = _month_day(y, mo, day)
        if c <= d:
            c = _month_day(y + n, mo, day)
    if r["until"] and c > r["until"]:
        return None
    return c


def advance(r, due, today):
    """完了したとき、次の回の日付。due より後で、かつ今日以降の、最初の回（遅れて完了したときは、過ぎた回を飛ばす）。無ければ None"""
    c = next_after(r, due)
    for _ in range(800):
        if c is None or c >= today:
            return c
        c = next_after(r, c)
    return c


# ---- 本文から、繰り返しの書き方を見つける ----
_WD = "月火水木金土日"
_WD_RE = re.compile(r"毎週\s*(?:の)?\s*([月火水木金土日](?:\s*[・、,と&]?\s*[月火水木金土日])*)\s*(?:曜日?|曜)?")


def _clean_text(body):
    from dates import _clean  # 日付の読み取りと同じ除外（コードブロック・URL・タグ）
    return _clean(body)


def extract_repeat(body):
    """本文の「毎週火曜」「毎月10日」「毎日」などから、決まりの文字列を返す（無ければ ""）"""
    t = _clean_text(body)
    m = _WD_RE.search(t)
    if m:
        days = [DAYS[_WD.index(c)] for c in dict.fromkeys(re.findall(r"[月火水木金土日]", m.group(1)))]
        return "FREQ=WEEKLY;BYDAY=" + ",".join(days)
    if re.search(r"毎(?:週)?平日|平日(?:だけ|のみ|毎日)", t):
        return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
    if re.search(r"隔週", t):
        return "FREQ=WEEKLY;INTERVAL=2"
    m = re.search(r"毎年\s*(\d{1,2})月\s*(\d{1,2})日", t)
    if m and 1 <= int(m[1]) <= 12 and 1 <= int(m[2]) <= 31:
        return f"FREQ=YEARLY;BYMONTH={int(m[1])};BYMONTHDAY={int(m[2])}"
    if re.search(r"毎月\s*(?:の)?\s*末|月末", t):
        return "FREQ=MONTHLY;BYMONTHDAY=-1"
    m = re.search(r"毎月\s*(?:の)?\s*(\d{1,2})日", t)
    if m and 1 <= int(m[1]) <= 31:
        return f"FREQ=MONTHLY;BYMONTHDAY={int(m[1])}"
    m = re.search(r"毎\s*(\d{1,3})\s*日|(\d{1,3})\s*日ごと", t)
    if m:
        n = int(m[1] or m[2])
        if 2 <= n <= 365:
            return f"FREQ=DAILY;INTERVAL={n}"
    if re.search(r"毎日(?!曜|新聞)", t):
        return "FREQ=DAILY"
    if re.search(r"毎週(?!末)", t):
        return "FREQ=WEEKLY"
    if re.search(r"毎月", t):
        return "FREQ=MONTHLY"
    if re.search(r"毎年", t):
        return "FREQ=YEARLY"
    return ""
