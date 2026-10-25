"""任意のアクセストークン（環境変数 TICK_TOKEN）の確認。サーバーを実際に起動して、HTTP でたしかめる。
使い方: python app/test_auth.py   （自分で、空の一時フォルダと、空いているポートを使う。実データには触れない）"""
import http.client
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

APP = Path(__file__).resolve().parent
bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def req(port, method, path, headers=None, body=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    c.request(method, path, body=body, headers=headers or {})
    r = c.getresponse()
    data = r.read()
    out = (r.status, dict((k.lower(), v) for k, v in r.getheaders()), data)
    c.close()
    return out


def start(token, data):
    port = free_port()
    env = {**os.environ, "TICK_DATA": data, "PYTHONIOENCODING": "utf-8"}
    env.pop("TICK_TOKEN", None)
    if token:
        env["TICK_TOKEN"] = token
    p = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--app-dir", str(APP), "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
                         env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        time.sleep(0.5)
        try:
            req(port, "GET", "/login")
            return p, port
        except OSError:
            continue
    p.kill()
    raise RuntimeError("サーバーが起動しませんでした")


with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    # ---- トークンなし: これまでどおり、認証なし ----
    p, port = start("", td + "/a")
    try:
        check("トークンなし: API が、そのまま使える", req(port, "GET", "/api/counts")[0] == 200)
        check("トークンなし: /login は、トップへ戻す", req(port, "GET", "/login")[0] == 303)
    finally:
        p.kill()

    # ---- トークンあり ----
    TOKEN = "test-token-1234567890"
    p, port = start(TOKEN, td + "/b")
    try:
        check("API は、認証なしだと 401", req(port, "GET", "/api/counts")[0] == 401)
        check("API の書き込みも、認証なしだと 401", req(port, "POST", "/api/notes", {"Content-Type": "application/json"}, b'{"body":"x"}')[0] == 401)
        st, h, _ = req(port, "GET", "/", {"Accept": "text/html"})
        check("画面（HTML）は、ログイン画面へ転送", st == 303 and h.get("location") == "/login", (st, h.get("location")))
        check("JS など、HTML 以外は 401（ログイン画面の中身を返さない）", req(port, "GET", "/app.js", {"Accept": "*/*"})[0] == 401)
        check("添付も、認証なしだと 401", req(port, "GET", "/attachments/x.png")[0] == 401)
        check("アイコン・manifest は、認証なしで見られる（アプリとして入れられる）", req(port, "GET", "/manifest.webmanifest")[0] == 200 and req(port, "GET", "/icon-192.png")[0] == 200)
        st, _, body = req(port, "GET", "/login")
        check("/login は、ログイン画面を返す", st == 200 and "アクセストークン".encode("utf-8") in body)
        check("Bearer ヘッダー（拡張用）で入れる", req(port, "GET", "/api/counts", {"Authorization": "Bearer " + TOKEN})[0] == 200)
        check("違う Bearer は、入れない", req(port, "GET", "/api/counts", {"Authorization": "Bearer wrong"})[0] == 401)
        check("違うトークンでは、ログインできない（401）", req(port, "POST", "/login", {"Content-Type": "application/x-www-form-urlencoded"}, urlencode({"token": "wrong"}).encode())[0] == 401)
        st, h, _ = req(port, "POST", "/login", {"Content-Type": "application/x-www-form-urlencoded"}, urlencode({"token": TOKEN}).encode())
        cookie = h.get("set-cookie", "")
        check("正しいトークンで、ログインできる（Cookie が付く）", st == 303 and "tick_auth=" in cookie and "HttpOnly" in cookie and "samesite=lax" in cookie.lower(), (st, cookie))
        check("Cookie には、トークンそのものを入れない", TOKEN not in cookie, cookie)
        ck = cookie.split(";")[0]
        check("Cookie で、API も、画面も使える", req(port, "GET", "/api/counts", {"Cookie": ck})[0] == 200 and req(port, "GET", "/", {"Cookie": ck, "Accept": "text/html"})[0] == 200)
        check("https の転送（X-Forwarded-Proto）では、Cookie に Secure が付く",
              "secure" in req(port, "POST", "/login", {"Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-Proto": "https"}, urlencode({"token": TOKEN}).encode())[1].get("set-cookie", "").lower())
        # 総当たりを遅らせる: 失敗が続くと 429
        for _ in range(8):
            req(port, "POST", "/login", {"Content-Type": "application/x-www-form-urlencoded"}, urlencode({"token": "bad"}).encode())
        st, _, _ = req(port, "POST", "/login", {"Content-Type": "application/x-www-form-urlencoded"}, urlencode({"token": TOKEN}).encode())
        check("失敗が続くと、正しいトークンでも、しばらく 429", st == 429, st)
    finally:
        p.kill()
print("失敗", bad)
