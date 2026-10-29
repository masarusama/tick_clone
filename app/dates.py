"""メモ本文の「日付っぽい文字」を、日付と時刻に直す。

基準日は「メモの作成日」。「明日」「来週火曜」「10/8」などを、書いた日から見た日付にする。
「お昼」「午後3時半」「18:30」などの時刻は、同じ行の、近くにある日付と組にする（来週の日曜のお昼 → 日曜 12:00）。
外れることもある（「1/2」を分数として書いた等）ので、索引上は由来を 'text' として
frontmatterの日付（'due'）と区別する。自動では日付にしない（画面で、提案として見せるだけ）。

時刻の決まり（日本時間・24時間表記）:
- N時 / N時M分 / N時半 / H:MM。「午前・午後・朝・昼・夕方・夜」が前にあれば、それに従う
- 印が無い「N時」は、1〜6時 → 午後（13〜18時）、7〜11時 → 午前、12時 → 正午、13時以降 → そのまま
- 時刻だけの言葉: 正午・お昼・昼=12:00 / 朝=9:00 / 午前=10:00 / 午後=15:00 / 夕方・夕=17:00 / 夜=19:00
- 「3時間」「2時限」のような、長さ・数え方は、時刻にしない
"""
import re
from datetime import date, timedelta

WD = {"月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5, "日": 6}
REL = {"一昨日": -2, "おととい": -2, "昨日": -1, "今日": 0, "本日": 0, "明日": 1, "あした": 1, "明後日": 2, "あさって": 2}

URL_RE = re.compile(r"https?://\S+")
FENCE_RE = re.compile(r"^(```|~~~).*?^\1", re.M | re.S)
LINK_PATH_RE = re.compile(r"\]\(attachments/[^)]*\)")
TAG_RE = re.compile(r"(?:(?<=\s)|^)#[^\s#\[\]()]+", re.M)

FULL = re.compile(r"(?<!\d)(20\d{2})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?(?!\d)")
MD_KANJI = re.compile(r"(?<![\d/.:\-])(\d{1,2})月(\d{1,2})日")
MD_SLASH = re.compile(r"(?<![\d/.:\-])(\d{1,2})/(\d{1,2})(?![\d/:])")
WEEK = re.compile(r"(再来週|来週|今週)の?([月火水木金土日])曜?日?")
WEEKDAY_ONLY = re.compile(r"(?<![月火水木金土日来今])([月火水木金土日])曜日")
REL_RE = re.compile("|".join(sorted(REL, key=len, reverse=True)))

# 時刻: 「午後3時半」「18:30」「夜8時」など（印 + 時 + 分）
AP = r"(?P<ap>午前|午後|AM|PM|am|pm|朝|夜|夕方|夕|昼)?"
HOUR_RE = re.compile(AP + r"\s*(?<![\dA-Za-z_])(?P<h>\d{1,2})\s*時(?!間|限)\s*(?:(?P<half>半)|(?:(?P<m1>\d{1,2})\s*分))?")
HOUR_COLON = re.compile(r"(?<![\d:/.A-Za-z_])" + AP + r"\s*(?<![\d:/.A-Za-z_])(?P<h>\d{1,2}):(?P<m2>[0-5]\d)(?![\d:A-Za-z_])")
WORD_TIME = {"正午": "12:00", "お昼": "12:00", "昼": "12:00", "朝": "09:00", "午前": "10:00", "午後": "15:00", "夕方": "17:00", "夕": "17:00", "夜": "19:00"}
# 「朝日」「昼食」「夜景」のような熟語の一部は、時刻の言葉として読まない
_NOT_WORD = {"朝": "日食刊礼会", "昼": "食休間", "夜": "景間中行", "夕": "食刊日"}
WORD_RE = re.compile("|".join((k + "(?![" + _NOT_WORD[k] + "])") if k in _NOT_WORD else k for k in sorted(WORD_TIME, key=len, reverse=True)))

PAIR_AFTER = 15   # 日付のすぐ後ろ（この文字数以内）にある時刻と組にする
PAIR_BEFORE = 12  # 日付の前にある時刻（12時に集合 明日 など）


def _valid(y, m, d):
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _nearest(anchor, m, d):
    """年が無い月日は、基準日に最も近い年のものにする"""
    best = None
    for y in (anchor.year - 1, anchor.year, anchor.year + 1):
        c = _valid(y, m, d)
        if c and (best is None or abs((c - anchor).days) < abs((best - anchor).days)):
            best = c
    return best


def _clean(body):
    """日付として読まない部分（コードブロック・URL・添付のパス・タグ）を、空白にする"""
    text = FENCE_RE.sub(" ", body)
    text = URL_RE.sub(" ", text)
    text = LINK_PATH_RE.sub("]", text)
    return TAG_RE.sub(" ", text)


def _blank(text, m):
    """マッチした部分を、同じ長さの空白にする（以降の検索で重複して拾わず、位置も変えない）"""
    return text[:m.start()] + " " * (m.end() - m.start()) + text[m.end():]


def _date_tokens(text, anchor):
    """[(date, start, end)]。本文中の日付の表現を、位置つきで"""
    out = []

    def add(d, m):
        if d and 2000 <= d.year <= 2100:
            out.append((d, m.start(), m.end()))

    for m in FULL.finditer(text):
        add(_valid(int(m[1]), int(m[2]), int(m[3])), m)
    t2 = text
    for m in FULL.finditer(text):
        t2 = _blank(t2, m)
    for rx in (MD_KANJI, MD_SLASH):
        for m in rx.finditer(t2):
            mo, d = int(m[1]), int(m[2])
            if 1 <= mo <= 12 and 1 <= d <= 31:
                add(_nearest(anchor, mo, d), m)
    monday = anchor - timedelta(days=anchor.weekday())
    t3 = text
    for m in WEEK.finditer(text):
        shift = {"今週": 0, "来週": 7, "再来週": 14}[m[1]]
        add(monday + timedelta(days=shift + WD[m[2]]), m)
        t3 = _blank(t3, m)
    for m in WEEKDAY_ONLY.finditer(t3):
        delta = (WD[m[1]] - anchor.weekday()) % 7  # 基準日以降で最初のその曜日
        add(anchor + timedelta(days=delta), m)
    for m in REL_RE.finditer(text):
        add(anchor + timedelta(days=REL[m[0]]), m)
    return out


def _to_hhmm(ap, h, minute):
    """印（午前・午後…）と時分 → "HH:MM"。読めなければ None"""
    if not (0 <= h <= 24 and 0 <= minute <= 59):
        return None
    ap = (ap or "").lower()
    if ap in ("午前", "am", "朝"):
        hh = 0 if h == 12 else h
    elif ap in ("午後", "pm", "夜", "夕方", "夕", "昼"):
        hh = h + 12 if h < 12 else h
    else:
        hh = h + 12 if 1 <= h <= 6 else h  # 印が無い 1〜6時 は午後とみなす
    if hh >= 24:
        return None
    return f"{hh:02d}:{minute:02d}"


RANGE_SEP = re.compile(r"\s*(?:[-~〜～–—]|から)\s*")
LINE_CLOCK = re.compile(r"[ \t]*(?:午前|午後|AM|PM|am|pm)?\s*\d{1,2}(?::\d\d|時)")
DEADLINE_AFTER = re.compile(r"^[^\n]{0,6}?(?:まで|迄|には|締切|締め切り|〆)")
DEADLINE_BEFORE = re.compile(r"(?:締切|締め切り|期限|〆|期日)\s*[:：]?\s*$")
EVENT_AFTER = re.compile(r"^\s*(?:の?(?:お昼|朝|夜|夕方)?)?に")


def _time_tokens(text):
    """[(開始 HH:MM, start, end, 終了 HH:MM または None)]。本文中の時刻の表現を、位置つきで。
    「17:00-19:00」「17時から19時」のような範囲は、1つにまとめる"""
    raw = []
    t = text
    for rx in (HOUR_RE, HOUR_COLON):
        for m in rx.finditer(t):
            minute = 30 if rx is HOUR_RE and m.group("half") else int((m.group("m1") if rx is HOUR_RE else m.group("m2")) or 0)
            hhmm = _to_hhmm(m.group("ap"), int(m.group("h")), minute)
            if hhmm:
                # 時刻の位置は、前の空白（改行を含む）を除いた、「午後」または数字から
                start = m.start("ap") if m.group("ap") else m.start("h")
                raw.append([hhmm, start, m.end(), None])
                t = _blank(t, m)
    for m in WORD_RE.finditer(t):  # 「午後3時」で使った「午後」は、もう空白にしてあるので、重ならない
        raw.append([WORD_TIME[m.group(0)], m.start(), m.end(), None])
    raw.sort(key=lambda x: x[1])
    out = []
    for tok in raw:
        prev = out[-1] if out else None
        if prev and prev[3] is None:
            sep = text[prev[2]:tok[1]]
            if "\n" not in sep and RANGE_SEP.fullmatch(sep) and tok[0] > prev[0]:
                prev[3] = tok[0]
                prev[2] = tok[2]
                continue
        out.append(tok)
    return [tuple(x) for x in out]


BARE_END = re.compile(r"[-~〜～–—](\d{1,2})(?![\d:/時月年分件個円])|(?:から|[-~〜～–—])\s*(\d{1,2})日")


def _merge_ranges(text, dates):
    """日付の範囲（「10/12〜10/14」「10/12-14」「12日から14日まで」）を1つにまとめる。
    返すもの: ([(date, start, end)], {index: 終わりの日})"""
    dates = sorted(dates, key=lambda x: x[1])
    out, until, i = [], {}, 0
    while i < len(dates):
        d, ds, de = dates[i]
        nxt = dates[i + 1] if i + 1 < len(dates) else None
        if nxt and "\n" not in text[de:nxt[1]] and RANGE_SEP.fullmatch(text[de:nxt[1]]) and 0 < (nxt[0] - d).days <= 30:
            until[len(out)] = nxt[0]
            out.append((d, ds, nxt[2]))
            i += 2
            continue
        m = BARE_END.match(text, de)
        if m:
            n = int(m.group(1) or m.group(2))
            try:
                e = d.replace(day=n)
            except ValueError:
                e = None
            if e and 0 < (e - d).days <= 30:
                until[len(out)] = e
                out.append((d, ds, m.end()))
                i += 1
                continue
        out.append((d, ds, de))
        i += 1
    return out, until


def extract_items(body, anchor):
    """body から (日付, 開始時刻|None, 終了時刻|None, 種類, 終わりの日|None) の一覧を返す（重複なし・古い順）。anchor は date。
    「10/12〜10/14」のような日付の範囲は、開始の日付に「終わりの日」を付けて1件にする（複数日の予定）。
    種類: 'event'（予定: 「17:00-19:00」「…に」）/ 'deadline'（締切: 「…まで」「締切」）/ ''（どちらとも言えない）。
    時刻は、同じ行で日付の近くにあるものと組にする。ただし、日付の行の直後（空行をはさんでもよい）の行が
    「17:00」「17時…」のような時刻で始まるときは、それも組にする（1つの時刻は、1つの日付にだけ）"""
    text = _clean(body)
    dates, untils = _merge_ranges(text, _date_tokens(text, anchor))
    times = _time_tokens(text)
    pairs = []
    for di, (_, ds, de) in enumerate(dates):
        for ti, (_, ts, te, _e) in enumerate(times):
            if ts >= de and ts - de <= PAIR_AFTER and "\n" not in text[de:ts]:
                pairs.append((ts - de, di, ti))
            elif te <= ds and ds - te <= PAIR_BEFORE and "\n" not in text[te:ds]:
                pairs.append((ds - te, di, ti))
    got_d, got_t, assigned = set(), set(), {}
    for gap, di, ti in sorted(pairs):
        if di in got_d or ti in got_t:
            continue
        got_d.add(di)
        got_t.add(ti)
        assigned[di] = ti
    # 日付の行のあとの行が、時刻（「17:00-19:00」「17時…」）で始まるなら、その日付の時刻にする。
    # ただし「15時にね」のような言葉の途中の時刻は、取り違えやすいので、「H:MM」か範囲のときだけ
    for di, (_, ds, de) in enumerate(dates):
        if di in got_d:
            continue
        eol = text.find("\n", de)
        if eol < 0:
            continue
        for ti, (_, ts, te, e2) in enumerate(times):
            if ti in got_t or ts < eol:
                continue
            gap = text[eol:ts]
            if gap.strip() or gap.count("\n") > 2:
                continue
            if not (e2 or ":" in text[ts:te]):
                continue
            got_d.add(di)
            got_t.add(ti)
            assigned[di] = ti
            break
    items = set()
    for di, (d, ds, de) in enumerate(dates):
        ti = assigned.get(di)
        st, en, end_pos = None, None, de
        if ti is not None:
            st, en, end_pos = times[ti][0], times[ti][3], max(de, times[ti][2])
        after = text[end_pos:end_pos + 14]
        before = text[max(0, ds - 8):ds]
        if en or di in untils:
            kind = "event"  # 「17:00-19:00」「10/12〜10/14」のように終わりまである → 予定
        elif DEADLINE_AFTER.match(text[de:de + 14]) or DEADLINE_AFTER.match(after) or DEADLINE_BEFORE.search(before):
            kind = "deadline"
        elif EVENT_AFTER.match(after):
            kind = "event"
        else:
            kind = ""
        items.add((d, st, en, kind, untils.get(di)))
    return sorted(items, key=lambda e: (e[0], e[1] or "", e[2] or "", e[4] or e[0]))


def extract_events(body, anchor):
    """body から (日付, 時刻 または None) の一覧を返す（重複なし・古い順）。anchor は date。"""
    return sorted({(d, st) for d, st, _e, _k, _u in extract_items(body, anchor)}, key=lambda e: (e[0], e[1] or ""))


def extract_dates(body, anchor):
    """body から日付(date)の一覧を返す（重複なし・古い順）。anchor は date。"""
    return sorted({d for d, _ in extract_events(body, anchor)})
