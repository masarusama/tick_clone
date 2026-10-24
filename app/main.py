import gzip
import json
import logging
import os
import re
import secrets
import threading
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, unquote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import linktitle
import push
import reminders
import store

STATIC = Path(__file__).parent / "static"

app = FastAPI(title="tick_clone")
keeper = reminders.Keeper(store, push)


class Body(BaseModel):
    body: str = ""
    due: str | None = None      # None=変えない / ""=消す / "YYYY-MM-DD"
    status: str | None = None   # None=変えない / "done" / "open"
    pinned: bool | None = None  # None=変えない / True=ピン留め / False=外す
    priority: int | None = None  # None=変えない / 0=なし / 1=低 / 3=中 / 5=高
    start: str | None = None  # None=変えない / ""=複数日をやめる / "YYYY-MM-DD"=この日から期日までの複数日
    repeat: str | None = None  # None=変えない / ""=繰り返さない / "FREQ=WEEKLY;BYDAY=TU" など
    event: str | None = None  # None=変えない / ""=締切 / "1"=予定 / "HH:MM"=予定（終わりの時刻つき）
    reminder: str | None = None  # None=変えない / ""=既定 / "none"=通知しない / "-PT10M / PT0S" など
    list: str | None = None     # None=変えない / ""=リストなし / "リスト" / "フォルダ/リスト"
    kind: str | None = None     # None=変えない / "task" / "note"
    sort: float | None = None    # None=変えない / 手動の並べ替えの位置（小さいほど上）
    base: str | None = None     # 端末が編集の元にした版の updated（競合の検出用）
    id: str | None = None       # 端末で先に作ったメモの id（作成時のみ）
    created: str | None = None  # 同 作成日時（作成時のみ）


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    """画面のファイル（JS/CSS/HTML）は、毎回「変わっていないか」を確認させる（変わっていなければ中身は送り直さない）。
    これが無いと、ブラウザが古いJS/CSSを何時間も使い続け、更新が反映されない"""
    resp = await call_next(request)
    p = request.url.path
    if not p.startswith(("/api/", "/attachments/")) and "cache-control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def _heartbeat():
    """10分おきに「生きている」と記録する。突然止まったとき、最後の記録で止まった時刻を絞れる"""
    log = logging.getLogger("uvicorn.error")
    while True:
        time.sleep(600)
        log.info("alive")


@app.on_event("startup")
def startup():
    store.init_git()
    store.reindex()
    threading.Thread(target=_heartbeat, daemon=True).start()
    keeper.start()  # 期日・リマインダーの通知


@app.on_event("shutdown")
def shutdown():
    store.commit_now()


def _need(n):
    if n is None:
        raise HTTPException(404, "メモが見つかりません")
    return n


@app.get("/api/notes")
def list_notes(q: str = "", tag: str = "", done: str = "all", view: str = "all",
               today: str = "", date: str = "", src: str = "due,text"):
    return store.list_notes(q, tag, done, view, today, date, src)


@app.get("/api/counts")
def counts(done: str = "hide", today: str = ""):
    return store.counts(done, today)


@app.get("/api/calendar")
def calendar(month: str, src: str = "due,text", done: str = "hide"):
    try:
        return store.calendar(month, src, done)
    except ValueError:
        raise HTTPException(400, "month は YYYY-MM の形で指定してください")


@app.post("/api/notes")
def create_note(b: Body):
    try:
        n = store.create_note(b.body, b.id, b.created)
    except ValueError as e:
        raise HTTPException(400, str(e))
    lst = b.list or (_route("note") if b.kind == "note" else "")  # ノートとして作られ、リストが未設定なら、「ノートを自動で入れる」リストへ（Chrome拡張・共有からのメモも）
    if b.due or b.status or b.pinned or b.priority or b.reminder or b.event or b.start or b.repeat or lst or b.kind or b.sort is not None:  # 端末で期日・完了・ピン留め・優先度・リマインダー・並び順を付けてから作ったメモ
        try:
            n = store.update_note(n["id"], b.body, b.due, None, b.status, b.pinned, b.priority, b.reminder, b.sort, b.event, b.start, b.repeat, lst, b.kind) or n
        except ValueError as e:
            raise HTTPException(400, str(e))
    return n


COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class Settings(BaseModel):
    tagColors: dict[str, str] = {}
    lists: list[str] = []  # リストの並び順（空のリストもここに残る）。"リスト" か "フォルダ/リスト"
    filters: list[dict] = []  # 保存した絞り込み: [{id, name, match: "all"|"any", conds: [{t, v, not}]}]
    listRoutes: dict[str, str] = {}  # "deadline"（締切にしたメモ）/ "event"（予定にしたメモ）/ "note"（ノートにしたメモ）→ 自動で入れるリスト名（リスト未設定のメモだけ）
    listToNote: list[str] = []  # このリストに入れたメモは、自動でノートにする（期日の無い未完了のタスクだけ）
    listPromote: dict[str, dict] = {}  # 元のリスト名 → {to: 移す先のリスト名, days: 締切が何日以内になったら移すか}（期日つきの未完了タスクだけ）
    listKinds: dict[str, str] = {}  # リスト名 → 新規メモの既定の種類（"note" / "task"。無ければ task）


def _settings_path():
    return store.DATA / "settings.json"


def _route(kind):
    """設定の「自動振り分け」（listRoutes）で、kind（deadline / event / note）の入れ先リスト。無ければ ""。"""
    try:
        return str(json.loads(_settings_path().read_text(encoding="utf-8")).get("listRoutes", {}).get(kind) or "")
    except (OSError, ValueError, AttributeError):
        return ""


FILTER_TYPES = {"list", "tag", "priority", "kind", "status", "due", "event", "title", "text", "pinned", "completed", "created", "updated"}


def _filter_to(v):
    """フィルターの「当てはまるメモを自動で入れるリスト」。無い・不正なら ""。"""
    try:
        return store.norm_list(v) if v else ""
    except ValueError:
        return ""


def _clean_filters(raw):
    """保存した絞り込みを、決まった形だけに整える（不正な条件は捨てる）"""
    out, seen = [], set()
    for f in (raw or [])[:100]:
        if not isinstance(f, dict):
            continue
        fid = str(f.get("id") or "")[:40]
        if not fid or fid in seen:
            continue
        seen.add(fid)
        conds = []
        for c in (f.get("conds") or [])[:30]:
            if not isinstance(c, dict) or c.get("t") not in FILTER_TYPES:
                continue
            v = c.get("v", "")
            if isinstance(v, bool) or not isinstance(v, (str, int, float)):
                v = ""
            conds.append({"t": c["t"], "v": v if isinstance(v, (int, float)) else str(v)[:200], "not": bool(c.get("not"))})
        out.append({"id": fid, "name": str(f.get("name") or "名前なし")[:60], "match": "any" if f.get("match") == "any" else "all", "incDone": bool(f.get("incDone")), "to": _filter_to(f.get("to")), "conds": conds})
    return out


@app.get("/api/settings")
def get_settings():
    """端末をまたいで共通にしたい小さな設定（いまはタグの色）。data/settings.json に保存（gitで履歴が残る）"""
    p = _settings_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {"tagColors": {}, "lists": [], "listKinds": {}, "listRoutes": {}, "listPromote": {}, "listToNote": [], "filters": []}


@app.put("/api/settings")
def put_settings(s: Settings):
    colors = {k[:80]: v for k, v in s.tagColors.items() if v and COLOR_RE.match(v) and len(s.tagColors) <= 500}
    lists = []
    for x in s.lists[:500]:
        try:
            n = store.norm_list(x)
        except ValueError:
            continue
        if n and n not in lists:
            lists.append(n)
    kinds = {}
    for k, v in list(s.listKinds.items())[:500]:
        try:
            n = store.norm_list(k)
        except ValueError:
            continue
        if n and v in ("note", "task"):
            kinds[n] = v
    routes = {}
    for k, v in s.listRoutes.items():
        if k in ("deadline", "event", "note"):
            try:
                n = store.norm_list(v)
            except ValueError:
                continue
            if n:
                routes[k] = n
    promote = {}
    for k, v in list(s.listPromote.items())[:100]:
        try:
            src = store.norm_list(k)
            dst = store.norm_list(v.get("to", "")) if isinstance(v, dict) else ""
            days = int(v.get("days", 7)) if isinstance(v, dict) else 7
        except (ValueError, TypeError):
            continue
        if src and dst and src != dst and 1 <= days <= 365:
            promote[src] = {"to": dst, "days": days}
    to_note = []
    for x in s.listToNote[:200]:
        try:
            n = store.norm_list(x)
        except ValueError:
            continue
        if n and n not in to_note:
            to_note.append(n)
    out = {"tagColors": colors, "lists": lists, "listKinds": kinds, "listRoutes": routes, "listPromote": promote, "listToNote": to_note, "filters": _clean_filters(s.filters)}
    p = _settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)
    store.schedule_commit("設定（タグの色・リスト）を更新")
    return out


class PushSub(BaseModel):
    subscription: dict


class PushEndpoint(BaseModel):
    endpoint: str


class PushTest(BaseModel):
    delay: int = 0  # 秒。アプリを閉じる余裕を作るための待ち時間（最大120秒）


@app.get("/api/push/key")
def push_key():
    return {"publicKey": push.public_key(), "devices": push.count()}


@app.post("/api/push/subscribe")
def push_subscribe(b: PushSub, request: Request):
    try:
        n = push.subscribe(b.subscription, request.headers.get("user-agent", ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"devices": n}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(b: PushEndpoint):
    return {"removed": push.unsubscribe(b.endpoint), "devices": push.count()}


@app.post("/api/push/test")
def push_test(b: PushTest):
    """テスト通知。delay を付けると、その秒数のあとに送る（アプリを閉じてから届くか確かめるため）"""
    delay = max(0, min(b.delay, 120))
    args = ("tick_clone", "テスト通知です。アプリを閉じていても、これが見えれば成功です。", "/", "tick-test")
    if delay:
        t = threading.Timer(delay, lambda: push.send(*args))
        t.daemon = True
        t.start()
        return {"scheduled": delay, "devices": push.count()}
    return {**push.send(*args), "devices": push.count()}


class LinkReq(BaseModel):
    url: str


_title_slots = threading.Semaphore(4)  # 同時に外へ取りに行くのは4件まで


@app.post("/api/linktitle")
def link_title(b: LinkReq):
    """URLのページのタイトルを取ってくる。禁止されたアドレス（家庭内・PC内など）には接続しない"""
    if not _title_slots.acquire(timeout=10):
        return {"title": None, "error": "busy"}
    try:
        return {"title": linktitle.fetch_title(b.url.strip()), "error": None}
    except ValueError:
        return {"title": None, "error": "blocked"}
    finally:
        _title_slots.release()


@app.get("/api/trash")
def trash_list():
    return store.list_trash()


@app.get("/api/trash/{nid}")
def trash_get(nid: str):
    try:
        return _need(store.get_trashed(nid))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/trash/{nid}/restore")
def trash_restore(nid: str):
    try:
        return _need(store.restore_note(nid))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except store.RestoreConflict:
        raise HTTPException(409, "同じメモが、すでに元の場所にあります")


@app.post("/share")
def share_fallback():
    """OSの「共有」から届いたとき、Service Workerがまだ動いていない場合の保険。内容は受け取れないが、アプリは開く"""
    return RedirectResponse("/", status_code=303)


@app.post("/api/notes/{nid}/complete")
def complete_from_notification(nid: str):
    """通知の「完了」ボタン用（Service Workerから呼ぶ）。本文は触らず、完了にするだけ"""
    n = store.get_note(nid)
    if not n:
        raise HTTPException(404, "メモが見つかりません")
    store.update_note(nid, n["body"], status="done")
    return {"ok": True}


@app.post("/api/notes/{nid}/snooze")
def snooze_from_notification(nid: str, minutes: int = reminders.SNOOZE_MIN):
    """通知の「あとで」ボタン用。指定の分（1〜1440）後に、もう一度通知する"""
    if not store.get_note(nid):
        raise HTTPException(404, "メモが見つかりません")
    keeper.snooze(nid, max(1, min(minutes, 1440)))
    return {"ok": True, "minutes": minutes}


@app.get("/api/sync")
def sync(request: Request, since: int = 0, epoch: str = ""):
    """差分同期。epoch が違う（サーバーの索引が作り直された）端末には全件を返す。
    全件は数MBになるので、対応していればgzipで圧縮して返す（画像などには使わない）"""
    data = json.dumps(store.sync_pull(since if epoch == store.epoch() else 0), ensure_ascii=False).encode("utf-8")
    headers = {"Cache-Control": "no-store"}
    if "gzip" in request.headers.get("accept-encoding", ""):
        data = gzip.compress(data, 5)
        headers["Content-Encoding"] = "gzip"
    return Response(data, media_type="application/json", headers=headers)


@app.get("/api/notes/{nid}")
def get_note(nid: str):
    return _need(store.get_note(nid))


@app.put("/api/notes/{nid}")
def update_note(nid: str, b: Body):
    try:
        return _need(store.update_note(nid, b.body, b.due, b.base, b.status, b.pinned, b.priority, b.reminder, b.sort, b.event, b.start, b.repeat, b.list, b.kind))
    except store.Conflict as c:
        return JSONResponse(status_code=409, content={"conflict": True, "server": c.note})
    except ValueError as e:
        raise HTTPException(400, str(e) or "期日は YYYY-MM-DD か YYYY-MM-DDTHH:MM の形で指定してください")


@app.delete("/api/notes/{nid}")
def delete_note(nid: str):
    if not store.delete_note(nid):
        raise HTTPException(404, "メモが見つかりません")
    return {"ok": True}


@app.get("/api/tags")
def tags(done: str = "all"):
    return store.all_tags(done)


@app.get("/api/notes/{nid}/history")
def history(nid: str):
    return store.history(nid)


@app.get("/api/notes/{nid}/history/{sha}")
def version(nid: str, sha: str):
    body = store.version(nid, sha)
    if body is None:
        raise HTTPException(404, "その版は見つかりません")
    return {"body": body}


MAX_UPLOAD = 200 * 1024 * 1024
# ブラウザ上でスクリプトとして動き得る形式は、表示せずダウンロードさせる
RISKY_EXT = {".html", ".htm", ".xhtml", ".svg", ".xml", ".js", ".mjs"}


def _attachment_name(orig, data):
    """アップロードされたファイルの保存名: 日時-乱数_安全にした元の名前.拡張子"""
    base, ext = os.path.splitext(unicodedata.normalize("NFC", os.path.basename(orig.replace("\\", "/"))))
    base = re.sub(r"[^\w.\-]", "_", base).strip("._")[:60] or "file"
    ext = ext.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext):
        ext = ""
    if not ext:  # 拡張子が無い貼り付け画像などは、中身から判断する
        ext = ".png" if data[:8] == b"\x89PNG\r\n\x1a\n" else ".jpg" if data[:3] == b"\xff\xd8\xff" else ".pdf" if data[:5] == b"%PDF-" else ""
    stamp = datetime.now(store.JST).strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-{secrets.token_hex(2)}_{base}{ext}"


@app.post("/api/attachments")
async def upload_attachment(request: Request):
    """画像・PDFなどを添付する。本体をそのまま受け取り、元のファイル名は X-Filename（URLエンコード）で受ける"""
    if int(request.headers.get("content-length") or 0) > MAX_UPLOAD:
        raise HTTPException(413, "大きすぎます（上限200MB）")
    data = await request.body()
    if not data:
        raise HTTPException(400, "空のファイルです")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "大きすぎます（上限200MB）")
    name = _attachment_name(unquote(request.headers.get("x-filename", "")), data)
    folder = store.DATA / "attachments"
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / (name + ".part")
    tmp.write_bytes(data)
    tmp.replace(folder / name)
    return {"name": name, "url": "attachments/" + quote(name), "size": len(data)}


@app.get("/attachments/{name}")
def attachment(name: str):
    base = (store.DATA / "attachments").resolve()
    p = (base / name).resolve()
    # ../ などで attachments の外に出られないようにする
    if p.parent != base or name.startswith(("_", ".")) or not p.is_file():
        raise HTTPException(404, "添付が見つかりません")
    headers = {"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"}
    if p.suffix.lower() in RISKY_EXT:
        headers["Content-Disposition"] = "attachment"
    return FileResponse(p, headers=headers)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=STATIC), name="static")
