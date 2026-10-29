"""期日・リマインダーの通知（時刻の計算と、時刻係）。

用語
- 期日（due）: "YYYY-MM-DD"（終日）または "YYYY-MM-DDTHH:MM"（時刻つき。日本時間）。TickTickから取り込んだ値は "+09:00" 付きのことがある
- リマインダー: 期日の何分前に知らせるか（前=正、後=負）。メモの先頭の枠(frontmatter)の `reminder:` に保存
    未設定 = 既定（終日→当日の朝9:00 / 時刻つき→期日の時刻）、"none" = 通知しない、
    それ以外 = ISO形式の長さを " / " でつないだもの（例 "-PT10M / PT0S"。TickTickの取り込み値と同じ書き方）
- 通知の時刻 = 期日の時刻 − リマインダー。終日の期日の「期日の時刻」は、その日の 0:00（日本時間）
"""
import json
import re
import threading
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

JST = timezone(timedelta(hours=9))
DEFAULT_ALLDAY = -540   # 当日の朝9:00（0:00 の 9時間「後」）
CATCHUP = timedelta(hours=24)  # PC停止中に過ぎた通知を、起動後に遅れて出す範囲。これより古いものは捨てる
SNOOZE_MIN = 10

_DUR = re.compile(r"^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


def parse_duration(s):
    """"-PT10M" → 10（10分前）、"PT0S" → 0、"PT540M" → -540（540分後）。読めなければ None"""
    s = s.strip().upper().replace("TRIGGER:", "").replace("TRIGGER;", "")
    m = _DUR.match(s)
    if not m or s in ("P", "-P", "+P", "PT", "-PT"):
        return None
    sign, w, d, h, mi, sec = m.groups()
    total = (int(w or 0) * 7 + int(d or 0)) * 1440 + int(h or 0) * 60 + int(mi or 0) + int(sec or 0) // 60
    return total if sign == "-" else -total


def fmt_duration(before):
    return f"-PT{before}M" if before > 0 else ("PT0S" if before == 0 else f"PT{-before}M")


def parse_reminders(raw):
    """frontmatterの reminder 文字列 → 分のリスト（前が正）。None=未設定（既定を使う）、[]=通知しない"""
    raw = (raw or "").strip()
    if not raw:
        return None
    if raw.lower() == "none":
        return []
    out = []
    for part in raw.replace("\n", " / ").split("/"):
        v = parse_duration(part)
        if v is not None and v not in out:
            out.append(v)
    return out or None


def raw_from_minutes(mins):
    """分のリスト → frontmatterに書く文字列。[]は "none" """
    if not mins:
        return "none"
    return " / ".join(fmt_duration(m) for m in sorted(set(mins), reverse=True))


def parse_due(due):
    """期日の文字列 → (その時刻のdatetime(日本時間), 終日か)。読めなければ (None, False)"""
    due = (due or "").strip()
    try:
        if len(due) >= 16 and due[10] == "T":
            return datetime.strptime(due[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=JST), False
        if len(due) >= 10:
            return datetime.strptime(due[:10], "%Y-%m-%d").replace(tzinfo=JST), True
    except ValueError:
        pass
    return None, False


def effective_reminders(due, raw):
    inst, allday = parse_due(due)
    if inst is None:
        return []
    r = parse_reminders(raw)
    if r is None:
        return [DEFAULT_ALLDAY if allday else 0]
    return r


def fire_times(due, raw):
    """通知する時刻のリスト（datetime, 何分前か）"""
    inst, _ = parse_due(due)
    if inst is None:
        return []
    return [(inst - timedelta(minutes=b), b) for b in effective_reminders(due, raw)]


def label(before, allday):
    """何分前か → 人が読む文字"""
    if allday:
        # 終日の期日は、期日の日の0:00 を基準にする。通知する時刻を「何日前の何時」で言う（9540分前 → 7日前の朝9:00）
        notify = -before
        day = notify // 1440
        tod = notify - day * 1440
        dw = "当日" if day == 0 else "前日" if day == -1 else f"{-day}日前" if day < 0 else f"{day}日後"
        return dw + "の" + ("朝9:00" if tod == 540 else f"{tod // 60}:{tod % 60:02d}")
    if before == 0: return "予定の時刻に"
    if before == 1440: return "前日の同じ時刻"
    return _span(abs(before)) + ("前" if before > 0 else "後")


def _span(m):
    """分 → 「6日15時間」「1時間30分」「10分」"""
    d, rest = divmod(m, 1440)
    h, mi = divmod(rest, 60)
    return (f"{d}日" if d else "") + (f"{h}時間" if h else "") + (f"{mi}分" if mi else "")


# ---------- 時刻係 ----------

class Keeper:
    """30秒おきに、「通知する時刻が来て、まだ送っていないもの」を探して送る。
    送った記録は data/push/state.json（gitにもバックアップにも入れない）。"""

    def __init__(self, store, push):
        self.store, self.push = store, push
        self.lock = threading.RLock()
        self._thread = None

    def _path(self):
        return self.store.DATA / "push" / "state.json"

    def _load(self):
        p = self._path()
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except ValueError:
                pass
        return {"fired": {}, "snoozes": [], "baseline": False}

    def _save(self, st):
        p = self._path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)

    def candidates(self):
        """通知の対象: 未完了で、期日があるメモ"""
        with self.store.LOCK:
            return [dict(r) for r in self.store.db().execute(
                "SELECT id, title, ndue, remind FROM notes WHERE done=0 AND ndue!=''")]

    def snooze(self, nid, minutes=SNOOZE_MIN, now=None):
        now = now or datetime.now(JST)
        with self.lock:
            st = self._load()
            st["snoozes"] = [s for s in st["snoozes"] if s["id"] != nid]
            st["snoozes"].append({"id": nid, "at": (now + timedelta(minutes=minutes)).isoformat(timespec="seconds")})
            self._save(st)

    def tick(self, now=None, send=None):
        """1回分の確認。送った件数を返す。send は差し替え用（テスト）"""
        now = now or datetime.now(JST)
        send = send or self.push.send
        sent = 0
        with self.lock:
            if self.push.count() == 0:
                return 0  # 登録された端末が無いうちは、記録も付けない（後から登録したとき、直近の分が出るように）
            st = self._load()
            fired = st["fired"]
            first = not st.get("baseline")
            notes = self.candidates()
            byid = {n["id"]: n for n in notes}
            for n in notes:
                inst, allday = parse_due(n["ndue"])
                for when, before in fire_times(n["ndue"], n["remind"]):
                    key = f"{n['id']}|{when.isoformat(timespec='minutes')}"
                    if key in fired or when > now:
                        continue
                    fired[key] = now.isoformat(timespec="seconds")
                    if first or now - when > CATCHUP:
                        continue  # 初回は、過ぎたものを全部「送った」ことにして、一斉に鳴らさない / 古すぎるものは捨てる
                    late = now - when > timedelta(minutes=5)
                    if allday:
                        body = f"期日: {inst.month}/{inst.day}（終日）"
                    else:
                        body = f"期日: {inst.month}/{inst.day} {inst:%H:%M}"
                    body += f" ・ {label(before, allday)}" + ("（遅れて通知）" if late else "")
                    send(n["title"] or "（空のメモ）", body, f"/?note={n['id']}", f"note-{n['id']}", "high", n["id"], True)
                    sent += 1
            # あとで（スヌーズ）
            keep = []
            for s in st["snoozes"]:
                at = datetime.fromisoformat(s["at"])
                n = byid.get(s["id"])
                if n is None:
                    continue  # 完了した・消した・期日が無いメモのスヌーズは捨てる
                if at <= now:
                    if now - at <= CATCHUP:
                        send(n["title"] or "（空のメモ）", "あとで（再通知）", f"/?note={n['id']}", f"note-{n['id']}", "high", n["id"], True)
                        sent += 1
                else:
                    keep.append(s)
            st["snoozes"] = keep
            st["baseline"] = True
            # 記録の掃除（14日より古いもの）
            cut = (now - timedelta(days=14)).isoformat(timespec="seconds")
            st["fired"] = {k: v for k, v in fired.items() if v >= cut}
            self._save(st)
        return sent

    def start(self):
        if self._thread:
            return

        def loop():
            while True:
                try:
                    self.tick()
                except Exception as e:  # 1回の失敗で時刻係を止めない
                    print("reminder tick failed:", type(e).__name__, e)
                time.sleep(30)

        self._thread = threading.Thread(target=loop, daemon=True, name="reminder-keeper")
        self._thread.start()
