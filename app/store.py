"""メモの保存と索引。

正本は data/notes/YYYY/MM/<id>.md（1メモ1ファイル）。
SQLite(index.db)は検索用の写しで、消えても Markdown から作り直せる。
"""
import os
import re
import secrets
import sqlite3
import subprocess
import threading
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

import recur
import reminders
from dates import extract_dates, extract_events, extract_items

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("TICK_DATA", ROOT / "data"))
NOTES = DATA / "notes"
TRASH = DATA / "trash"
DB_PATH = DATA / "index.db"

JST = timezone(timedelta(hours=9))
LOCK = threading.RLock()

# 行頭または空白の直後の #タグ。"# 見出し"（#の後が空白）にはマッチしない
TAG_RE = re.compile(r"(?:(?<=\s)|^)#([^\s#\[\]()]+)", re.M)
TAG_TRAIL = "、。，．,.!?！？)）」』】]:;：；"
FENCE_RE = re.compile(r"^(```|~~~).*?^\1", re.M | re.S)
INDEX_VERSION = 18  # 18: 「## 振り返り」の節の日付・語は、日付・繰り返しの読み取りから除く / 17: 中止（abandoned・cancelled 列。完了日には数えない） / 16: 完了日（completed 列） / 15: 種類（kind 列。ノート/タスク） / 14: リスト（lst 列） / 13: 繰り返し（rrule・rsug 列） / 12: 本文の日付の範囲（複数日の予定・dates.u） / 11: 本文の日時に終了時刻・種類(予定/締切)・event列 / 10: 英数字に挟まれた数字・熟語(朝日など)は時刻にしない / 9: 本文の日時に時刻（dates.t） / 8: sort 列（手動の並べ替え） / 2: 本文中の !日付 を日付として索引 / 3: 同期用 seq・due_set 列 / 4: pinned 列 / 5: priority 列 / 6: due_time・ndue・remind 列 / 7: タイトルから [題名](URL) の記号を除く
BANG_DUE_RE =re.compile(r"(?:(?<=\s)|^)[!！]([^\s!！\[]+)", re.M)
ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$")

_db = None


def now_iso():
    return datetime.now(JST).isoformat(timespec="seconds")


def new_id():
    return datetime.now(JST).strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)


def extract_tags(body):
    # コードブロック内の # はタグにしない
    text = FENCE_RE.sub("", body)
    seen, out = set(), []
    for m in TAG_RE.finditer(text):
        t = m.group(1).rstrip(TAG_TRAIL)
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def make_title(body):
    for line in body.splitlines():
        s = line.strip().lstrip("#").strip()
        if s.startswith(("```", "~~~")):
            continue
        # [題名](URL) は題名だけ、![](画像) は取り除く（一覧に記号が出ないように）
        s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
        s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s).strip()
        if s:
            return s[:120]
    return ""


def parse_file(text):
    """frontmatter(--- ... ---)と本文に分ける"""
    meta, body = {}, text
    if text.startswith("---\n") or text.startswith("---\r\n"):
        parts = re.split(r"^---\s*$", text, maxsplit=2, flags=re.M)
        if len(parts) == 3:
            for line in parts[1].strip().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = parts[2].lstrip("\r\n")
    return meta, body


def render_file(meta, body):
    """id/created/updated を先頭に、それ以外のキー（due など）も落とさず書く。"""
    keys = ["id", "created", "updated"] + [k for k in meta if k not in ("id", "created", "updated")]
    head = "".join(f"{k}: {meta[k]}\n" for k in keys)
    return f"---\n{head}---\n{body}"


def is_done(meta):
    return 1 if meta.get("status") in ("done", "abandoned") else 0


_RECAP_HEAD = re.compile(r"^##[ \t]*振り返り[ \t]*$")


def without_recap(body):
    """「## 振り返り」の節（次の見出しの前まで）を取り除いた本文。振り返りは、すでに終わったことの記録なので、その中の日付（「2026-10-25」など）を、
    日付・「今日」の一覧・カレンダーの「本文の日付」・提案・通知に、使わないため（日付・繰り返しを読む前に、これを通す）"""
    if "振り返り" not in body:
        return body
    out, skipping = [], False
    for ln in body.split("\n"):
        if _RECAP_HEAD.match(ln):
            skipping = True
            continue
        if skipping and re.match(r"^#{1,6}[ \t]+\S", ln):
            skipping = False
        if not skipping:
            out.append(ln)
    return "\n".join(out)


def note_dates(meta, body):
    """索引用の日付: [(YYYY-MM-DD, 'due'|'text', 時刻, 種類, 終わりの日), ...]。終わりの日は、複数日の予定のときだけ（その範囲の全日に行が入る）。
    due = frontmatterの start〜due（TickTickの日付）、text = 本文から読み取った日付。
    時刻は '' / 'HH:MM' / 'HH:MM-HH:MM'（範囲）。種類は 'event'（予定）/ 'deadline'（締切）/ ''（本文の日付だけ）"""
    out = set()
    try:
        s = meta.get("start", "")[:10]
        e = meta.get("due", "")[:10]
        if e:
            d1 = date.fromisoformat(s or e)
            d2 = date.fromisoformat(e)
            if d2 < d1:
                d1 = d2
            for i in range(min((d2 - d1).days, 31) + 1):
                out.add(((d1 + timedelta(days=i)).isoformat(), "due", "", "", ""))
    except ValueError:
        pass
    anchor = datetime.fromisoformat(meta["created"]).date()
    body = without_recap(body)  # 振り返りの節の日付は、読まない
    # 本文中の「!10/8」「!明日」は、日付として扱う（! の直後の語だけを日付として読む）
    text = FENCE_RE.sub("", body)
    for m in BANG_DUE_RE.finditer(text):
        for d in extract_dates(m.group(1), anchor):
            out.add((d.isoformat(), "due", "", "", ""))
    for d, st, en, kind, until in extract_items(body, anchor):
        t = (st + ("-" + en if en else "")) if st else ""
        u = until.isoformat() if until else ""
        out.add((d.isoformat(), "text", t, kind, u))
        for i in range(1, ((until - d).days + 1) if until else 0):
            out.add(((d + timedelta(days=i)).isoformat(), "text", "", kind, u))
        if until:
            out.add((until.isoformat(), "text", "", kind, u))
    return sorted(out)


def db():
    global _db
    if _db is None:
        DATA.mkdir(parents=True, exist_ok=True)
        _db = sqlite3.connect(DB_PATH, check_same_thread=False)
        _db.row_factory = sqlite3.Row
        had_dates = _db.execute(
            "SELECT 1 FROM sqlite_master WHERE name='dates'").fetchone()
        _db.executescript(
            """
            CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
            CREATE TABLE IF NOT EXISTS tomb(id TEXT PRIMARY KEY, seq INTEGER);
            CREATE TABLE IF NOT EXISTS dates(note_id TEXT, d TEXT, src TEXT, t TEXT DEFAULT '', k TEXT DEFAULT '', u TEXT DEFAULT '');
            CREATE INDEX IF NOT EXISTS dates_d ON dates(d);
            CREATE INDEX IF NOT EXISTS dates_note ON dates(note_id);
            CREATE TABLE IF NOT EXISTS notes(
              id TEXT PRIMARY KEY, path TEXT, title TEXT, body TEXT,
              created TEXT, updated TEXT, mtime REAL);
            CREATE TABLE IF NOT EXISTS tags(note_id TEXT, tag TEXT);
            CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
            CREATE INDEX IF NOT EXISTS tags_note ON tags(note_id);
            CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
              id UNINDEXED, body, tokenize='trigram');
            """
        )
        # 古い索引の dates 表には、時刻の列(t)が無い → 足す（中身は、全件の再索引で入り直す）
        dcols = [r["name"] for r in _db.execute("PRAGMA table_info(dates)")]
        for col in ("t", "k", "u"):  # t=時刻 / k=種類（予定・締切） / u=複数日の予定の、終わりの日
            if col not in dcols:
                _db.execute(f"ALTER TABLE dates ADD COLUMN {col} TEXT DEFAULT ''")
        _db.commit()
        # 索引は作り直せるキャッシュなので、列の追加は「全件再索引」で済ませる
        cols = [r["name"] for r in _db.execute("PRAGMA table_info(notes)")]
        for col, ddl in (("done", "INTEGER DEFAULT 0"), ("seq", "INTEGER DEFAULT 0"), ("due_set", "TEXT DEFAULT ''"),
                         ("pinned", "TEXT DEFAULT ''"), ("priority", "INTEGER DEFAULT 0"),
                         ("due_time", "TEXT DEFAULT ''"), ("ndue", "TEXT DEFAULT ''"), ("remind", "TEXT DEFAULT ''"),
                         ("sortv", "REAL"), ("event", "TEXT DEFAULT ''"),
                         ("rrule", "TEXT DEFAULT ''"), ("rsug", "TEXT DEFAULT ''"), ("lst", "TEXT DEFAULT ''"), ("kind", "TEXT DEFAULT ''"), ("completed", "TEXT DEFAULT ''"), ("abandoned", "INTEGER DEFAULT 0"), ("cancelled", "TEXT DEFAULT ''")):
            if col not in cols:
                _db.execute(f"ALTER TABLE notes ADD COLUMN {col} {ddl}")
                _db.execute("UPDATE notes SET mtime=-1")
                _db.commit()
        _db.execute("CREATE INDEX IF NOT EXISTS notes_seq ON notes(seq)")
        # 端末側の同期カーソルは「この索引の世代(epoch)」と対で持つ。索引を作り直したら世代が変わり、全件取り直しになる
        if not _db.execute("SELECT 1 FROM kv WHERE k='epoch'").fetchone():
            _db.execute("INSERT INTO kv VALUES('epoch', ?)", (secrets.token_hex(6),))
            _db.execute("INSERT OR IGNORE INTO kv VALUES('seq', '0')")
            _db.commit()
        # 索引の作り方（日付の読み取り規則など）を変えたら INDEX_VERSION を上げる → 全件作り直し
        ver = _db.execute("PRAGMA user_version").fetchone()[0]
        if not had_dates or ver < INDEX_VERSION:
            _db.execute("UPDATE notes SET mtime=-1")
            _db.execute(f"PRAGMA user_version={INDEX_VERSION}")
            _db.commit()
    return _db


def _due_time(meta):
    """日付に時刻があれば "HH:MM"（終日・時刻なしは ""）"""
    d = meta.get("due", "")
    return d[11:16] if len(d) >= 16 and d[10] == "T" and meta.get("allday") != "yes" else ""


def _notify_due(meta, body):
    """通知に使う日付: メモの日付（時刻つきなら "YYYY-MM-DDTHH:MM"）。無ければ本文の「!10/8」（終日）"""
    d = meta.get("due", "")
    if d:
        t = _due_time(meta)
        return f"{d[:10]}T{t}" if t else d[:10]
    try:
        anchor = datetime.fromisoformat(meta["created"]).date()
    except (KeyError, ValueError):
        return ""
    for m in BANG_DUE_RE.finditer(FENCE_RE.sub("", without_recap(body))):
        ds = extract_dates(m.group(1), anchor)
        if ds:
            return ds[0].isoformat()
    return ""


def _repeat(meta):
    """繰り返しの決まり（読める形のものだけ）。読めない・無いときは ""（ファイルの中身は、そのまま残る）"""
    v = str(meta.get("repeat", "")).strip()
    return v if recur.parse(v) else ""


def _event(meta):
    """予定の印。"" = 締切（ふつうの日付）/ "1" = 予定 / "HH:MM" = 予定で、終わりの時刻つき。壊れた値は ""（予定にしない）"""
    v = str(meta.get("event", "")).strip()
    return v if v == "1" or re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v) else ""


def _sortv(meta):
    """手動の並べ替えの位置。無い・壊れていれば None（その場合は、更新日の順で並ぶ）"""
    try:
        v = float(meta["sort"])
    except (KeyError, TypeError, ValueError):
        return None
    return v if abs(v) < 1e12 and v == v else None


def _list(meta):
    """リスト名（"リスト" か "フォルダ/リスト"）。無い・壊れていれば ""（受信箱）"""
    try:
        return norm_list(meta.get("list", ""))
    except ValueError:
        return ""


def _kind(meta):
    """ノート("note")かタスク("task")か。kind: があればそれ。無ければ status: か日付があるものはタスク、どちらも無いものはノート（TickTick の取り込み結果と同じ。ノートには日付が無い）"""
    v = str(meta.get("kind", "")).strip()
    if v in ("note", "task"):
        return v
    return "task" if (meta.get("status") or meta.get("due")) else "note"


def norm_list(v):
    """リスト名を整える。空白・スラッシュの重複を除く。不正（改行・長すぎ・3階層以上）は ValueError。"" = リストなし"""
    parts = [x.strip() for x in str(v or "").replace("\\", "/").split("/") if x.strip()]
    if not parts:
        return ""
    if len(parts) > 2:
        raise ValueError("リストは フォルダ/リスト の2階層までです")
    out = "/".join(parts)
    if len(out) > 100 or re.search(r"[\x00-\x1f#]", out):
        raise ValueError("リスト名が不正です（改行・# は使えません。100文字まで）")
    return out


def _prio(meta):
    """優先度（0=なし / 1=低 / 3=中 / 5=高。TickTickと同じ値）。壊れた値は0"""
    try:
        v = int(meta.get("priority", 0))
    except (TypeError, ValueError):
        return 0
    return v if v in (1, 3, 5) else 0


def _next_seq():
    """変更のたびに増える番号。端末は「前回の番号より後」だけを取りに来る"""
    c = db()
    c.execute("UPDATE kv SET v=CAST(v AS INTEGER)+1 WHERE k='seq'")
    return int(c.execute("SELECT v FROM kv WHERE k='seq'").fetchone()[0])


def _index(meta, body, path, mtime):
    c = db()
    nid = meta["id"]
    c.execute("DELETE FROM tags WHERE note_id=?", (nid,))
    c.execute("DELETE FROM dates WHERE note_id=?", (nid,))
    c.execute("DELETE FROM fts WHERE id=?", (nid,))
    c.execute("DELETE FROM tomb WHERE id=?", (nid,))
    c.execute(
        "INSERT OR REPLACE INTO notes(id,path,title,body,created,updated,mtime,done,seq,due_set,pinned,priority,due_time,ndue,remind,sortv,event,rrule,rsug,lst,kind,completed,abandoned,cancelled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (nid, str(path), make_title(body), body, meta["created"], meta["updated"], mtime, is_done(meta),
         _next_seq(), meta.get("due", "")[:10], meta.get("pinned", ""), _prio(meta),
         _due_time(meta), _notify_due(meta, body), meta.get("reminder", ""), _sortv(meta), _event(meta), _repeat(meta), recur.extract_repeat(without_recap(body)), _list(meta), _kind(meta),
         str(meta.get("completed", "")) if meta.get("status") == "done" else "",  # 完了日は、完了だけ（中止は実績に数えない）
         1 if meta.get("status") == "abandoned" else 0,
         str(meta.get("cancelled") or meta.get("completed") or "") if meta.get("status") == "abandoned" else ""),  # 中止した日時（TickTick から取り込んだ中止は、その完了日時）
    )
    c.executemany("INSERT INTO tags VALUES(?,?)", [(nid, t) for t in extract_tags(body)])
    c.executemany("INSERT INTO dates(note_id,d,src,t,k,u) VALUES(?,?,?,?,?,?)", [(nid, d, s, t, k, u) for d, s, t, k, u in note_dates(meta, body)])
    c.execute("INSERT INTO fts(id, body) VALUES(?,?)", (nid, body))


def reindex():
    """Markdownを走査して索引を最新にする（起動時に実行）。"""
    with LOCK:
        c = db()
        known = {r["id"]: r["mtime"] for r in c.execute("SELECT id, mtime FROM notes")}
        found = set()
        for p in NOTES.rglob("*.md"):
            try:
                mtime = p.stat().st_mtime
                meta, body = parse_file(p.read_text(encoding="utf-8"))
                nid = meta.get("id") or p.stem
                meta.setdefault("id", nid)
                meta.setdefault("created", now_iso())
                meta.setdefault("updated", meta["created"])
                found.add(nid)
                if known.get(nid) != mtime:
                    _index(meta, body, p, mtime)
            except Exception as e:  # 壊れた1ファイルで全体を止めない
                print("index skip:", p, e)
        for nid in set(known) - found:
            c.execute("DELETE FROM notes WHERE id=?", (nid,))
            c.execute("DELETE FROM tags WHERE note_id=?", (nid,))
            c.execute("DELETE FROM dates WHERE note_id=?", (nid,))
            c.execute("DELETE FROM fts WHERE id=?", (nid,))
            c.execute("INSERT OR REPLACE INTO tomb VALUES(?,?)", (nid, _next_seq()))
        c.commit()


def _path_of(nid):
    r = db().execute("SELECT path FROM notes WHERE id=?", (nid,)).fetchone()
    return Path(r["path"]) if r else None


def _row(r, with_body=False):
    d = {
        "id": r["id"],
        "title": r["title"],
        "created": r["created"],
        "updated": r["updated"],
        "done": bool(r["done"]),
        "pinned": r["pinned"] or "",  # ピン留めした日時（空 = ピン留めなし）
        "priority": r["priority"] or 0,
        "due_time": r["due_time"] or "",   # 日付の時刻 "HH:MM"（終日は ""）
        "remind": r["remind"] or "",       # リマインダーの設定（frontmatterの文字列。"" = 既定）
        "sort": r["sortv"],                # 手動の並べ替えの位置（None = 未設定）
        "repeat": r["rrule"] or "",         # 繰り返しの決まり（"" = 繰り返さない）。例 FREQ=WEEKLY;BYDAY=TU
        "repeat_sug": r["rsug"] or "",     # 本文の「毎週火曜」などから読み取った、繰り返しの提案（"" = 無し）
        "abandoned": bool(r["abandoned"]),  # 中止（キャンセル）。done も true になる。実績（完了）には数えない
        "cancelled": r["cancelled"] or "",  # 中止した日時
        "completed": r["completed"] or "",  # 完了した日時（完了・中止のメモだけ。"YYYY-MM-DDTHH:MM"。無ければ ""）
        "kind": r["kind"] or "note",     # "task"（完了できる）/ "note"（読み物・資料。○を付けない）
        "list": r["lst"] or "",           # リスト名（"" = 受信箱 / "リスト" / "フォルダ/リスト"）
        "event": r["event"] or "",         # 予定の印（"" = 締切 / "1" = 予定 / "HH:MM" = 予定の終わりの時刻）
        "due": (db().execute(
            "SELECT MAX(d) FROM dates WHERE note_id=? AND src='due'", (r["id"],)).fetchone()[0]),
        "tags": [t["tag"] for t in db().execute(
            "SELECT tag FROM tags WHERE note_id=?", (r["id"],))],
    }
    if with_body:
        d["body"] = r["body"]
    return d


def _like_escape(s):
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _filters(tag="", done="all", view="all", today="", date_="", src="due,text"):
    """一覧・件数・カレンダーで共通の絞り込み条件（SQLの断片と引数）"""
    sql, args = "", []
    if done == "hide":
        sql += " AND n.done=0"
    elif done == "only":
        sql += " AND n.done=1"
    if tag:
        # "リスト" を指定すると "リスト/Inbox" などの下位タグも含む
        sql += " AND n.id IN (SELECT note_id FROM tags WHERE tag=? OR tag LIKE ? ESCAPE '\\')"
        args += [tag, _like_escape(tag) + "/%"]
    srcs = [s for s in src.split(",") if s in ("due", "text")]
    vsrcs = srcs or ["due", "text"]  # 今日・次の7日は、作成日/更新日の指定の時も日付＋本文で判定する
    if view == "today" and today:
        sql += " AND n.id IN (SELECT note_id FROM dates WHERE d=? AND src IN (%s))" % ",".join("?" * len(vsrcs))
        args += [today] + vsrcs
    elif view == "week" and today:
        end = (date.fromisoformat(today) + timedelta(days=6)).isoformat()
        sql += " AND n.id IN (SELECT note_id FROM dates WHERE d>=? AND d<=? AND src IN (%s))" % ",".join("?" * len(vsrcs))
        args += [today, end] + vsrcs
    elif view == "overdue" and today:
        # 期限切れ = TickTickの日付が今日より前で、まだ終わっていないもの（本文中の日付は数えない）
        sql += (" AND n.done=0 AND n.kind!='note' AND n.event='' AND n.id IN (SELECT note_id FROM dates WHERE src='due' GROUP BY note_id HAVING MAX(d)<?)")
        args.append(today)
    elif view == "nodate":
        sql += " AND n.id NOT IN (SELECT note_id FROM dates)"
    elif view == "notes":
        sql += " AND n.kind='note'"
    if date_:
        parts = []
        if srcs:
            parts.append("n.id IN (SELECT note_id FROM dates WHERE d=? AND src IN (%s))" % ",".join("?" * len(srcs)))
            args += [date_] + srcs
        if "created" in src.split(","):
            parts.append("substr(n.created,1,10)=?")
            args.append(date_)
        if "updated" in src.split(","):
            parts.append("substr(n.updated,1,10)=?")
            args.append(date_)
        if "completed" in src.split(","):
            parts.append("(n.done=1 AND substr(n.completed,1,10)=?)")
            args.append(date_)
        sql += " AND (" + " OR ".join(parts or ["0"]) + ")"
    return sql, args


def counts(done="hide", today=""):
    """左ペインのスマートリストの件数"""
    with LOCK:
        out = {}
        for v in ("all", "today", "week", "overdue", "nodate", "notes"):
            f, a = _filters(done=done, view=v, today=today)
            out[v] = db().execute("SELECT COUNT(*) FROM notes n WHERE 1=1" + f, a).fetchone()[0]
        out["done"] = db().execute("SELECT COUNT(*) FROM notes WHERE done=1").fetchone()[0]
        return out


def calendar(month, src="due,text", done="hide"):
    """月カレンダー用: {YYYY-MM-DD: {"n": 件数, "items": [{id,title,done}, ...最大4件]}}"""
    first = date.fromisoformat(month + "-01")
    nxt = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    # 前後の月の端（グリッドの空き）も埋めるため、前後7日を足して取る
    lo, hi = (first - timedelta(days=7)).isoformat(), (nxt + timedelta(days=7)).isoformat()
    rows = {}
    with LOCK:
        f, a = _filters(done=done)
        srcs = [s for s in src.split(",") if s in ("due", "text")]
        if srcs:
            sql = ("SELECT dt.d, n.id, n.title, n.done FROM dates dt JOIN notes n ON n.id=dt.note_id "
                   "WHERE dt.d>=? AND dt.d<? AND dt.src IN (%s)" % ",".join("?" * len(srcs)) + f)
            for r in db().execute(sql, [lo, hi] + srcs + a):
                rows.setdefault(r["d"], {})[r["id"]] = (r["title"], r["done"])
        for col, key in (("created", "created"), ("updated", "updated"), ("completed", "completed")):
            if key in src.split(","):
                sql = (f"SELECT substr(n.{col},1,10) d, n.id, n.title, n.done FROM notes n "
                       f"WHERE substr(n.{col},1,10)>=? AND substr(n.{col},1,10)<?" + (" AND n.done=1" if key == "completed" else "") + f)
                for r in db().execute(sql, [lo, hi] + a):
                    rows.setdefault(r["d"], {})[r["id"]] = (r["title"], r["done"])
    return {
        d: {"n": len(v), "items": [{"id": i, "title": t, "done": bool(x)} for i, (t, x) in list(v.items())[:4]]}
        for d, v in rows.items()
    }


def list_notes(q="", tag="", done="all", view="all", today="", date_="", src="due,text"):
    """done: all=全部 / hide=完了・中止を除く / only=完了・中止だけ"""
    with LOCK:
        f, args = _filters(tag, done, view, today, date_, src)
        sql = "SELECT n.* FROM notes n WHERE 1=1" + f
        q = q.strip()
        if q:
            if len(q) >= 3:
                # trigramは3文字以上。語はフレーズとして検索（AND）
                match = " ".join('"' + w.replace('"', '""') + '"' for w in q.split() if len(w) >= 3)
                short = [w for w in q.split() if len(w) < 3]
                if match:
                    sql += " AND n.id IN (SELECT id FROM fts WHERE fts MATCH ?)"
                    args.append(match)
                for w in short:
                    sql += " AND n.body LIKE ?"
                    args.append(f"%{w}%")
            else:
                sql += " AND n.body LIKE ?"
                args.append(f"%{q}%")
        sql += " ORDER BY n.updated DESC"
        return [_row(r) for r in db().execute(sql, args)]


def get_note(nid):
    with LOCK:
        r = db().execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        if not r:
            return None
        d = _row(r, True)
        d["due_set"] = r["due_set"] or ""  # 日付ピッカーに出す「メモに設定した日付」（本文の !10/8 は含めない）
        d["dates"] = [[x["d"], x["src"], x["t"] or "", x["k"] or "", x["u"] or ""] for x in db().execute(
            "SELECT d, src, t, k, u FROM dates WHERE note_id=? ORDER BY d, t", (r["id"],))]
        return d


def epoch():
    with LOCK:
        return db().execute("SELECT v FROM kv WHERE k='epoch'").fetchone()[0]


def sync_pull(since=0):
    """端末への差分: seq が since より新しいメモ（本文つき）と、消えたメモのid。"""
    with LOCK:
        c = db()
        cur = int(c.execute("SELECT v FROM kv WHERE k='seq'").fetchone()[0])
        notes = []
        for r in c.execute("SELECT * FROM notes WHERE seq>? ORDER BY seq", (since,)):
            d = _row(r, True)
            d["due_set"] = r["due_set"] or ""
            d["seq"] = r["seq"]
            d["dates"] = [[x["d"], x["src"], x["t"] or "", x["k"] or "", x["u"] or ""] for x in c.execute(
                "SELECT d, src, t, k, u FROM dates WHERE note_id=? ORDER BY d, t", (r["id"],))]
            notes.append(d)
        gone = [r["id"] for r in c.execute("SELECT id FROM tomb WHERE seq>?", (since,))]
        return {"epoch": epoch(), "seq": cur, "notes": notes, "deleted": gone}


def all_tags(done="all"):
    """タグ一覧。"リスト/Inbox" のようなスラッシュ区切りは親タグ "リスト" も返す
    （親の件数は、下位タグを持つメモの重複を除いた数）。real=false は親だけの仮の行。"""
    with LOCK:
        where = " WHERE n.done=0" if done == "hide" else (" WHERE n.done=1" if done == "only" else "")
        notes_of = {}
        for r in db().execute("SELECT t.tag, t.note_id FROM tags t JOIN notes n ON n.id=t.note_id" + where):
            parts = r["tag"].split("/")
            for i in range(1, len(parts) + 1):
                notes_of.setdefault("/".join(parts[:i]), set()).add(r["note_id"])
        real = {r["tag"] for r in db().execute("SELECT DISTINCT tag FROM tags")}
        out = [{"tag": t, "count": len(s), "real": t in real} for t, s in notes_of.items()]
        return sorted(out, key=lambda x: x["tag"].lower())


class Conflict(Exception):
    """端末が見ていた版より、サーバーのメモが新しくなっていた"""
    def __init__(self, note):
        self.note = note


def create_note(body="", nid=None, created=None):
    """nid/created は、オフラインで端末が先に作ったメモ用（idの形式と日時を検証する）。
    同じ id が既にあれば（送信の再試行）、作り直さずそのメモを返す。"""
    with LOCK:
        if nid is not None:
            if not ID_RE.match(nid):
                raise ValueError("id の形式が不正です")
            if _path_of(nid):
                return get_note(nid)
        nid = nid or new_id()
        ts = created or now_iso()
        datetime.fromisoformat(ts)  # 不正な日時はここで ValueError
        meta = {"id": nid, "created": ts, "updated": ts}
        d = NOTES / ts[0:4] / ts[5:7]
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{nid}.md"
        p.write_text(render_file(meta, body), encoding="utf-8", newline="\n")
        _index(meta, body, p, p.stat().st_mtime)
        db().commit()
        schedule_commit(f"作成 {nid}")
        return get_note(nid)


RECAP_RE = re.compile(r"^##[ \t]*振り返り[ \t]*$")


def add_recap_line(body, ymd, text):
    """メモ末尾の「## 振り返り」の節の末尾に、「- 日付 text」の行を足す（節が無ければ、末尾に作る）。
    繰り返すタスクの完了（✓）・スキップ（中止）の記録に使う。同じ日付・同じ印の行が、すでにあれば、何もしない（端末が先に足していても、二重にならない）。
    app/static/data.js の addRecapLine と、同じ決まり。"""
    lines = body.rstrip().split("\n")
    bullet = f"- {ymd} {text}"
    h = next((i for i, ln in enumerate(lines) if RECAP_RE.match(ln)), -1)
    if h < 0:
        return "\n".join(lines) + "\n\n## 振り返り\n" + bullet + "\n"
    end = next((i for i in range(h + 1, len(lines)) if re.match(r"^#{1,6}[ \t]+\S", lines[i])), len(lines))
    at = end
    while at > h + 1 and not lines[at - 1].strip():
        at -= 1
    if any(ln.startswith(bullet) for ln in lines[h + 1:at]):
        return body
    lines.insert(at, bullet)
    return "\n".join(lines) + "\n"


def update_note(nid, body, due=None, base=None, status=None, pinned=None, priority=None, reminder=None, sort=None, event=None, start=None, repeat=None, list_=None, kind=None, completed=None):
    """due: None=変えない / ""=日付を消す / "YYYY-MM-DD"=その日を締切にする
    status: None=変えない / "done"=完了にする / "abandoned"=中止（キャンセル）にする / "open"=完了・中止を戻す。繰り返すメモは、完了も中止も、日付が次の回へ進む（中止は完了日が付かない）
    pinned: None=変えない / True=ピン留め / False=ピン留めを外す
    priority: None=変えない / 0=なし / 1=低 / 3=中 / 5=高
    reminder: None=変えない / ""=既定に戻す / "none"=通知しない / "-PT10M / PT0S" のような長さの列
    repeat: None=変えない / ""=繰り返しをやめる / "FREQ=WEEKLY;BYDAY=TU" のような決まり。繰り返すメモを status="done" にすると、完了ではなく、日付が次の回へ進む
    start: None=変えない / ""=複数日をやめる / "YYYY-MM-DD"=この日から日付（終わりの日）までの、複数日にする（日付を設定したあとに適用）
    event: None=変えない / ""=締切に戻す / "1"=予定にする / "HH:MM"=予定にして、終わりの時刻も持つ（予定は、過ぎても「期限切れ」にならない）
    list_: None=変えない / ""=リストなし（受信箱） / "リスト" / "フォルダ/リスト"（2階層まで）
    kind: None=変えない / "task" / "note"（完了を付けても、種類は変わらない）
    completed: None か "" =変えない / "YYYY-MM-DD"（または "YYYY-MM-DDTHH:MM"）= 完了したメモの、完了日を、この日にする（あとから思い出して完了にしたとき用）
    sort: None=変えない / 数=手動の並べ替えの位置（小さいほど上。これだけの変更では updated は変わらない）
    due は "YYYY-MM-DD"（終日）か "YYYY-MM-DDTHH:MM"（時刻つき・日本時間）
    base: 端末が編集の元にした版の updated。サーバー側がそれより進んでいたら Conflict"""
    with LOCK:
        p = _path_of(nid)
        if not p or not p.exists():
            return None
        meta, old = parse_file(p.read_text(encoding="utf-8"))
        if base is not None and meta.get("updated") != base and old != body:
            raise Conflict(get_note(nid))
        before = (meta.get("due"), meta.get("start"), meta.get("allday"), meta.get("status"), meta.get("pinned"), meta.get("priority"), meta.get("reminder"), meta.get("event"), meta.get("repeat"), meta.get("last_done"), meta.get("last_cancelled"), meta.get("list"), meta.get("kind"), meta.get("completed"))
        sort_before = meta.get("sort")
        if sort is not None:
            # 手動の並べ替えの位置（小さいほど上）。有限の数だけ。更新日は変えない（並べ替えは、メモの編集ではないため）
            if not (isinstance(sort, (int, float)) and abs(sort) < 1e12 and sort == sort):
                raise ValueError("並べ替えの値が不正です")
            meta["sort"] = repr(float(sort))
        if kind is not None:
            if kind not in ("note", "task"):
                raise ValueError("種類は note / task のどちらかです")
            meta["kind"] = kind
            if kind == "note":  # ノートは、日付・予定・繰り返しを持たない（日付を付けたら、タスクになる）
                for k in ("due", "start", "allday", "reminder", "event", "repeat"):
                    meta.pop(k, None)
        elif "kind" not in meta and ((status is not None and (meta.get("status") or "open") != status)
                                     or (due is not None and due != meta.get("due", ""))):
            # kind: を持たない古いメモ。日付を付けたらタスク（ノートには日付が無い）。日付を消す・完了にするときは、いまの種類を書き留める
            meta["kind"] = "task" if due else _kind(meta)
        if list_ is not None:
            ln = norm_list(list_)
            if ln:
                meta["list"] = ln
            else:
                meta.pop("list", None)
        if event is not None:
            if event == "":
                meta.pop("event", None)
            elif event == "1" or re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", event):
                meta["event"] = event
            else:
                raise ValueError("予定の形式が不正です")
        if priority is not None:
            if priority not in (0, 1, 3, 5):
                raise ValueError("優先度は 0/1/3/5 のどれかです")
            if priority:
                meta["priority"] = str(priority)
            else:
                meta.pop("priority", None)
        if pinned is not None:
            if pinned and not meta.get("pinned"):
                meta["pinned"] = now_iso()[:16]
            elif not pinned:
                meta.pop("pinned", None)
        if due is not None:
            if due == "":
                for k in ("due", "start", "allday", "reminder", "event"):
                    meta.pop(k, None)
            else:
                # "YYYY-MM-DD"（終日）または "YYYY-MM-DDTHH:MM"（時刻つき）。不正な値は ValueError
                if len(due) == 10:
                    date.fromisoformat(due)
                    meta["allday"] = "yes"
                elif len(due) == 16 and due[10] == "T":
                    datetime.strptime(due, "%Y-%m-%dT%H:%M")
                    meta["allday"] = "no"
                else:
                    raise ValueError("日付の形式が不正です")
                meta["due"] = due
                meta["kind"] = "task"  # 日付を付けたノートは、タスクになる
                meta.pop("start", None)
                # 終日 ⇄ 時刻つき を切り替えたら、リマインダーは既定に戻す（「10分前」は、終日では意味が変わってしまうため）
                if before[0] and before[2] != meta["allday"] and reminder is None:
                    meta.pop("reminder", None)
        if repeat is not None:
            if repeat == "":
                meta.pop("repeat", None)
            elif recur.parse(repeat):
                meta["repeat"] = repeat.strip()
            else:
                raise ValueError("繰り返しの形式が不正です")
        if start is not None:
            if start == "":
                meta.pop("start", None)
            else:
                s0 = date.fromisoformat(start)  # 不正な値は ValueError
                end = meta.get("due", "")[:10]
                if not end:
                    raise ValueError("先に日付（終わりの日）を決めてください")
                if s0 > date.fromisoformat(end):
                    raise ValueError("開始日が、終わりの日より後です")
                meta["start"] = start if s0 < date.fromisoformat(end) else None
                if meta["start"] is None:
                    meta.pop("start", None)
        if reminder is not None:
            # "" = 既定に戻す / "none" = 通知しない / それ以外は ISO形式の長さ（" / " 区切り）
            if reminder == "":
                meta.pop("reminder", None)
            elif reminder.strip().lower() == "none":
                meta["reminder"] = "none"
            else:
                mins = reminders.parse_reminders(reminder)
                if not mins:
                    raise ValueError("リマインダーの形式が不正です")
                meta["reminder"] = reminders.raw_from_minutes(mins)
        # 完了・中止は、日付・繰り返しなどを反映したあとで行う（端末で、日付や繰り返しを決めてから完了するまでが、1回の送信にまとまることがあるため）
        if status is not None:
            if status not in ("done", "open", "abandoned"):
                raise ValueError("status は done / open / abandoned のどれかです")
            rule = recur.parse(meta.get("repeat")) if status in ("done", "abandoned") else None
            nxt = None
            if rule and meta.get("due") and meta.get("status") not in ("done", "abandoned"):
                # 繰り返すメモの完了・中止: 終わりにせず、日付を次の回へ進める（時刻・開始日からの長さ・予定の印はそのまま）。中止は「この回をスキップ」で、完了日（実績）は付かない
                old_due = date.fromisoformat(meta["due"][:10])
                nxt = recur.advance(rule, old_due, date.fromisoformat(now_iso()[:10]))
            if nxt:
                if meta.get("start"):
                    span = (old_due - date.fromisoformat(meta["start"][:10])).days
                    meta["start"] = (nxt - timedelta(days=span)).isoformat() + meta["start"][10:]
                meta["due"] = nxt.isoformat() + meta["due"][10:]
                meta["last_done" if status == "done" else "last_cancelled"] = now_iso()[:16]
                # 繰り返すタスクは、完了しても、完了日（completed）が残らない。代わりに、本文の「## 振り返り」へ、回ごとの記録（✓ / 中止）を1行足す
                body = add_recap_line(body, now_iso()[:10], "✓" if status == "done" else "中止")
            elif meta.get("status") != status:
                meta["status"] = status
                if status == "done":
                    meta["completed"] = now_iso()[:16]
                    meta.pop("cancelled", None)
                elif status == "abandoned":
                    meta["cancelled"] = now_iso()[:16]
                    meta.pop("completed", None)
                else:
                    meta.pop("completed", None)
                    meta.pop("cancelled", None)
        if completed:
            if not re.fullmatch(r"\d{4}-\d\d-\d\d(T\d\d:\d\d)?", completed):
                raise ValueError("完了日の形式が不正です")
            date.fromisoformat(completed[:10])
            if meta.get("status") == "done":
                meta["completed"] = completed
        same_other = old == body and before == (meta.get("due"), meta.get("start"), meta.get("allday"), meta.get("status"), meta.get("pinned"), meta.get("priority"), meta.get("reminder"), meta.get("event"), meta.get("repeat"), meta.get("last_done"), meta.get("last_cancelled"), meta.get("list"), meta.get("kind"), meta.get("completed"))
        if same_other and meta.get("sort") == sort_before:
            return get_note(nid)
        meta["id"] = nid
        if not same_other:  # 並べ替えだけの変更では、更新日を変えない
            meta["updated"] = now_iso()
        p.write_text(render_file(meta, body), encoding="utf-8", newline="\n")
        _index(meta, body, p, p.stat().st_mtime)
        db().commit()
        schedule_commit(f"更新 {nid}")
        return get_note(nid)


def delete_note(nid):
    """ゴミ箱フォルダへ移すだけ（完全には消さない）。"""
    with LOCK:
        p = _path_of(nid)
        if not p or not p.exists():
            return False
        TRASH.mkdir(parents=True, exist_ok=True)
        meta, body = parse_file(p.read_text(encoding="utf-8"))
        meta["trashed"] = now_iso()  # 消した日時（ゴミ箱の一覧で見せる）
        meta.setdefault("id", nid)
        meta.setdefault("created", now_iso())
        meta.setdefault("updated", meta["created"])
        dst = TRASH / p.name
        dst.write_text(render_file(meta, body), encoding="utf-8", newline="\n")
        p.unlink()
        c = db()
        c.execute("DELETE FROM notes WHERE id=?", (nid,))
        c.execute("DELETE FROM tags WHERE note_id=?", (nid,))
        c.execute("DELETE FROM dates WHERE note_id=?", (nid,))
        c.execute("DELETE FROM fts WHERE id=?", (nid,))
        c.execute("INSERT OR REPLACE INTO tomb VALUES(?,?)", (nid, _next_seq()))
        c.commit()
        schedule_commit(f"ゴミ箱へ {nid}")
        return True


# ---- ゴミ箱（見る・戻す） ----

def _trash_dates():
    """以前（消した日時を記録する前）にゴミ箱へ移したメモの日時を、gitの履歴から割り出す {ファイル名: ISO日時}"""
    out = {}
    r = _git("log", "--diff-filter=A", "--format=@@%aI", "--name-only", "--", "trash/")
    when = ""
    for line in r.stdout.splitlines():
        if line.startswith("@@"):
            when = line[2:]
        elif line.strip().startswith("trash/") and line.strip().endswith(".md"):
            out.setdefault(line.strip().split("/", 1)[1], when)
    return out


def list_trash():
    """ゴミ箱の一覧（消した日時が新しい順）。中身は短い書き出しだけ"""
    with LOCK:
        if not TRASH.exists():
            return []
        fallback = None
        items = []
        for p in TRASH.glob("*.md"):
            try:
                meta, body = parse_file(p.read_text(encoding="utf-8"))
            except OSError:
                continue
            nid = meta.get("id") or p.stem
            if not ID_RE.match(nid):
                continue
            when = meta.get("trashed", "")
            if not when:
                if fallback is None:
                    fallback = _trash_dates()
                when = fallback.get(p.name) or datetime.fromtimestamp(p.stat().st_mtime, JST).isoformat(timespec="seconds")
            items.append({"id": nid, "title": make_title(body), "trashed": when, "created": meta.get("created", ""),
                          "preview": re.sub(r"\s+", " ", body).strip()[:120]})
        items.sort(key=lambda x: (x["trashed"], x["id"]), reverse=True)  # 消した日時が新しい順（同じ秒なら id の順で、並びを安定させる）
        return items[:500]


def _trash_path(nid):
    if not ID_RE.match(nid or ""):
        raise ValueError("id の形式が不正です")
    p = TRASH / f"{nid}.md"
    return p if p.exists() else None


def get_trashed(nid):
    with LOCK:
        p = _trash_path(nid)
        if not p:
            return None
        meta, body = parse_file(p.read_text(encoding="utf-8"))
        return {"id": nid, "title": make_title(body), "body": body, "trashed": meta.get("trashed", ""), "created": meta.get("created", "")}


class RestoreConflict(Exception):
    """同じ id のメモが、すでに（元の場所に）ある"""


def restore_note(nid):
    """ゴミ箱から、元の場所へ戻す。戻したメモを返す。ゴミ箱に無ければ None"""
    with LOCK:
        p = _trash_path(nid)
        if not p:
            return None
        cur = _path_of(nid)
        if cur and cur.exists():  # 索引が古くて、ファイルがもう無いときは、衝突としない
            raise RestoreConflict()
        meta, body = parse_file(p.read_text(encoding="utf-8"))
        meta.pop("trashed", None)
        meta["id"] = nid
        meta.setdefault("created", now_iso())
        meta.setdefault("updated", meta["created"])
        try:
            datetime.fromisoformat(meta["created"])
            ym = (meta["created"][0:4], meta["created"][5:7])
        except ValueError:
            ym = (now_iso()[0:4], now_iso()[5:7])
        d = NOTES / ym[0] / ym[1]
        d.mkdir(parents=True, exist_ok=True)
        dst = d / f"{nid}.md"
        dst.write_text(render_file(meta, body), encoding="utf-8", newline="\n")
        p.unlink()
        _index(meta, body, dst, dst.stat().st_mtime)  # 新しい変更番号が付き、各端末に届く（ゴミ箱の目印は消える）
        db().commit()
        schedule_commit(f"ゴミ箱から戻す {nid}")
        return get_note(nid)


# ---- 改版履歴（git） ----

def _git(*args):
    return subprocess.run(
        ["git", "-C", str(DATA), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def init_git():
    DATA.mkdir(parents=True, exist_ok=True)
    if not (DATA / ".git").exists():
        _git("init")
    _git("config", "user.name", "tick_clone")
    _git("config", "user.email", "tick_clone@localhost")
    _git("config", "core.quotepath", "false")
    gi = DATA / ".gitignore"
    if not gi.exists():
        gi.write_text("index.db\nindex.db-*\nattachments/\n", encoding="utf-8")
    # 通知の鍵・登録（秘密）は、履歴にもバックアップにも入れない
    cur = gi.read_text(encoding="utf-8")
    if "push/" not in cur.splitlines():
        gi.write_text(cur.rstrip("\n") + "\npush/\n", encoding="utf-8")


_timer = None
_pending = []


def schedule_commit(msg, delay=5.0):
    """保存が続いても、止まって数秒後に1回だけコミットする。"""
    global _timer
    _pending.append(msg)
    if _timer:
        _timer.cancel()
    _timer = threading.Timer(delay, commit_now)
    _timer.daemon = True
    _timer.start()


def commit_now():
    with LOCK:
        msgs = list(dict.fromkeys(_pending))
        _pending.clear()
        _git("add", "-A")
        if _git("status", "--porcelain").stdout.strip():
            title = msgs[0] if len(msgs) == 1 else f"{len(msgs)}件の変更"
            _git("commit", "-m", title + ("\n\n" + "\n".join(msgs) if len(msgs) > 1 else ""))


def history(nid):
    with LOCK:
        commit_now()
        p = _path_of(nid)
        if not p:
            return []
        rel = p.relative_to(DATA).as_posix()
        out = _git("log", "--format=%H|%aI", "--", rel).stdout
        return [
            {"sha": a, "date": b}
            for a, b in (l.split("|", 1) for l in out.splitlines() if "|" in l)
        ]


def version(nid, sha):
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        return None
    with LOCK:
        p = _path_of(nid)
        if not p:
            return None
        rel = p.relative_to(DATA).as_posix()
        r = _git("show", f"{sha}:{rel}")
        if r.returncode:
            return None
        return parse_file(r.stdout)[1]
