"""Webプッシュ通知（アプリを閉じていても、スマホ等に通知を届ける）。

- 鍵（VAPID）と、端末の登録は data/push/ に保存する。**このフォルダは git にも、バックアップにも入れない**
  （秘密鍵だから。失くしたら、鍵を作り直して、端末で通知を許可し直すだけで済む）
- 送信先は、既知のプッシュ配信所のドメインだけ許可する（サーバーが任意のURLへ通信させられないように）
"""
import base64
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

import store

LOCK = threading.RLock()
# VAPIDの連絡先。pywebpushは mailto: 形式を必須とする。配信所に渡る値なので、個人のメールアドレスは使わず架空のものにする
SUB = "mailto:tick-clone@example.invalid"
ALLOWED = ("fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com",
           ".push.apple.com", ".notify.windows.com")
MAX_SUBS = 20


def _dir():
    d = store.DATA / "push"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _key_path():
    return _dir() / "vapid_private.pem"


def _subs_path():
    return _dir() / "subscriptions.json"


def vapid():
    """鍵を読む。無ければ作る（初回だけ）"""
    with LOCK:
        p = _key_path()
        if not p.exists():
            v = Vapid()
            v.generate_keys()
            v.save_key(str(p))
        return Vapid.from_file(str(p))


def public_key():
    """ブラウザに渡す公開鍵（base64url）"""
    raw = vapid().public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _load():
    p = _subs_path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return []


def _save(subs):
    p = _subs_path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(subs, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def _endpoint_ok(ep):
    u = urlparse(ep)
    host = u.hostname or ""
    return u.scheme == "https" and any(host == a or (a.startswith(".") and host.endswith(a)) for a in ALLOWED)


def subscribe(sub, ua=""):
    ep = (sub or {}).get("endpoint", "")
    keys = (sub or {}).get("keys") or {}
    if not _endpoint_ok(ep) or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("登録情報が正しくありません")
    with LOCK:
        subs = [s for s in _load() if s["subscription"]["endpoint"] != ep]
        subs.append({"subscription": {"endpoint": ep, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}},
                     "ua": ua[:160], "added": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        _save(subs[-MAX_SUBS:])
        return len(subs[-MAX_SUBS:])


def unsubscribe(ep):
    with LOCK:
        subs = _load()
        keep = [s for s in subs if s["subscription"]["endpoint"] != ep]
        _save(keep)
        return len(subs) - len(keep)


def count():
    return len(_load())


def send(title, body="", url="/", tag="", urgency="normal", note_id=None, actions=False):
    """登録済みの全端末に送る。通知の中身（title/body）は、ログにも記録にも残さない。
    note_id と actions=True を付けると、通知に「完了」「あとで」のボタンが付く。
    戻り値: {"sent": 成功した台数, "failed": 失敗した台数, "removed": 無効になって削除した台数}"""
    if urgency not in ("very-low", "low", "normal", "high"):
        urgency = "normal"
    payload = json.dumps({"title": title[:120], "body": body[:300], "url": url[:500], "tag": tag[:60],
                          "id": note_id if note_id and store.ID_RE.match(note_id) else None, "actions": bool(actions and note_id)},
                         ensure_ascii=False)
    sent = failed = 0
    dead = []
    v = vapid()
    for s in _load():
        try:
            webpush(subscription_info=s["subscription"], data=payload, vapid_private_key=v,
                    vapid_claims={"sub": SUB}, ttl=3600, headers={"Urgency": urgency})
            sent += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):  # 端末側で通知を取り消された登録は、もう使えない
                dead.append(s["subscription"]["endpoint"])
            failed += 1
        except Exception:
            failed += 1
    if dead:
        with LOCK:
            _save([s for s in _load() if s["subscription"]["endpoint"] not in dead])
    return {"sent": sent, "failed": failed, "removed": len(dead)}
