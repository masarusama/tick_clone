"""リンクのタイトル取得の確認（安全の検査を中心に）。 python test_linktitle.py"""
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import linktitle as L

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


def blocked(url):
    try:
        L.check_url(url)
        return False
    except ValueError:
        return True


# --- 禁止されるべきURL ---
for u in ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://10.0.0.1/", "http://192.168.1.1/",
          "http://172.16.0.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/", "http://0.0.0.0/",
          "http://2130706433/", "http://0x7f.0.0.1/", "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/",
          "file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "data:text/html,x",
          "http://user:pw@example.com/", "https://example.com:8443/", "http://example.com:8080/",
          "http:///nohost", "", "http://exa mple.com/", "http://example.com/\r\nHost: evil", "http://" + "a" * 3000 + ".com/"]:
    check("禁止: " + (u[:50] or "(空)"), blocked(u))

# --- 許可されるURL（名前解決が必要）---
try:
    r = L.check_url("https://example.com/path?q=1")
    check("許可: https://example.com", r[1] == 443 and r[2] is True and r[3] == "/path?q=1")
except ValueError as e:
    check("許可: https://example.com", False, str(e))

# --- タイトルの取り出し ---
x = L.extract_title
check("<title>", x("<html><head><title>  こんにちは\n 世界 </title></head>") == "こんにちは 世界")
check("og:title を優先", x('<head><title>サイト名 - 長い飾り</title><meta property="og:title" content="記事の題名"></head>') == "記事の題名")
check("og:title（属性の順が逆）", x('<meta content="題名B" property="og:title">') == "題名B")
check("HTMLの実体参照", x("<title>A &amp; B &lt;C&gt; &#39;D&#39;</title>") == "A & B <C> 'D'")
check("タグの混入を除く", x("<title>A<b>B</b>C</title>") == "A B C")
check("タイトルなし", x("<html><body>x</body></html>") is None)
check("長すぎるタイトルは切る", len(x("<title>" + "あ" * 500 + "</title>")) == 200)
check("制御文字を除く", x("<title>A\x00B\x07C</title>") == "ABC")

# --- 文字コード ---
sj = "<html><head><title>日本語のタイトル</title></head></html>".encode("cp932")
check("Shift_JIS（ヘッダで指定）", x(L._decode(sj, "text/html; charset=Shift_JIS")) == "日本語のタイトル")
check("Shift_JIS（metaで指定）", x(L._decode(b'<meta charset="shift_jis">' + sj, "text/html")) == "日本語のタイトル")
check("EUC-JP（指定なしでも推測）", x(L._decode("<title>日本語</title>".encode("euc-jp"), "text/html")) == "日本語")
check("UTF-8", x(L._decode("<title>日本語</title>".encode("utf-8"), "text/html; charset=utf-8")) == "日本語")


# --- 手元のテスト用サーバーで、取得・転送・上限を確認 ---
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        p = self.path
        if p == "/ok":
            body = "<html><head><title>テストページ</title></head><body>x</body></html>".encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
        elif p == "/sjis":
            body = "<html><head><title>日本語サイト</title></head></html>".encode("cp932")
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=Shift_JIS")
        elif p == "/redir":
            self.send_response(302); self.send_header("Location", "/ok"); body = b""
        elif p == "/redir-evil":
            self.send_response(302); self.send_header("Location", "http://169.254.169.254/latest/meta-data/"); body = b""
        elif p == "/loop":
            self.send_response(302); self.send_header("Location", "/loop"); body = b""
        elif p == "/pdf":
            self.send_response(200); self.send_header("Content-Type", "application/pdf"); body = b"%PDF-1.4"
        elif p == "/404":
            self.send_response(404); body = b"no"
        elif p == "/slow":
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", "1000")
            self.end_headers(); self.wfile.write(b"<html>"); self.wfile.flush(); time.sleep(12); return
        elif p == "/huge":
            self.send_response(200); self.send_header("Content-Type", "text/html")
            self.end_headers()
            try:
                self.wfile.write(b"<html><head>" + b"x" * 5_000_000)
            except OSError:
                pass
            return
        else:
            self.send_response(404); body = b""
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


srv = HTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{port}"

real = L.check_url


def patched(url, allow_private=False, allow_any_port=False):
    # テストサーバー（127.0.0.1）だけを許可し、それ以外は、本番と同じ検査にする
    if url.startswith(f"http://127.0.0.1:{port}/"):
        return real(url, True, True)
    return real(url, False, False)


L.check_url = patched
f = L.fetch_title
check("取得: UTF-8", f(base + "/ok") == "テストページ")
check("取得: Shift_JIS", f(base + "/sjis") == "日本語サイト")
check("転送（同じサーバー内）をたどる", f(base + "/redir") == "テストページ")
try:
    f(base + "/redir-evil")
    check("転送先が禁止アドレスなら拒否", False)
except ValueError:
    check("転送先が禁止アドレスなら拒否", True)
check("転送ループは打ち切る（None）", f(base + "/loop") is None)
check("PDFなどHTML以外は None", f(base + "/pdf") is None)
check("404は None", f(base + "/404") is None)
t0 = time.time()
r = f(base + "/slow")
check("遅いページは、約8秒で打ち切る", r is None and time.time() - t0 < 11, f"{time.time() - t0:.1f}s")
t0 = time.time()
f(base + "/huge")
check("巨大なページでも、すぐ終わる（上限300KB）", time.time() - t0 < 5)
L.check_url = real

# --- 実際のインターネット ---
t = f("https://example.com/")
check("実際のページ: example.com", t == "Example Domain", t)
t = f("https://www.yahoo.co.jp/")
check("実際のページ（日本語）: Yahoo! JAPAN", t is not None and "Yahoo" in t, t)
print("失敗", bad)
