"""URLからページのタイトルを取ってくる（メモに貼ったリンクに、タイトルを付けるため）。

サーバーが、外部のページに接続する機能なので、安全を最優先にする（SSRF対策）:
- http/https の、標準のポート（80/443）だけ。ID・パスワード入りのURLは拒否
- 接続前に、相手のアドレスを名前解決して、**公開インターネットのアドレス以外**（PC内・家庭内・Tailscale・予約済み）はすべて拒否
- 接続は、検査したアドレスに固定する（検査のあとに別のアドレスへ変えられる攻撃＝DNS rebinding を防ぐ）
- 転送（リダイレクト）は最大4回まで、転送先も毎回、同じ検査をする
- 全体で約8秒、読むのは約300KBまで、HTMLだけ
"""
import codecs
import html
import http.client
import ipaddress
import re
import socket
import ssl
import time
from urllib.parse import urljoin, urlsplit

TIMEOUT = 8.0
MAX_BYTES = 300_000
MAX_REDIRECTS = 4
UA = "Mozilla/5.0 (compatible; tick_clone-linktitle/1.0)"
_cache = {}  # url -> (期限, タイトル)
CACHE_SEC = 3600


def check_url(url, allow_private=False, allow_any_port=False):
    """URLを検査して (ホスト, ポート, https か, パス, 接続先IP) を返す。だめなら ValueError"""
    if len(url) > 2000 or any(c in url for c in "\r\n\t "):
        raise ValueError("URLの形式が不正です")
    u = urlsplit(url)
    if u.scheme not in ("http", "https"):
        raise ValueError("http/https 以外は使えません")
    if u.username or u.password:
        raise ValueError("ID・パスワード入りのURLは使えません")
    host = u.hostname
    if not host:
        raise ValueError("ホスト名がありません")
    https = u.scheme == "https"
    port = u.port or (443 if https else 80)
    if not allow_any_port and port != (443 if https else 80):
        raise ValueError("標準以外のポートは使えません")
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise ValueError("名前解決できません")
    ips = []
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if getattr(ip, "ipv4_mapped", None):
            ip = ip.ipv4_mapped
        if not allow_private and not ip.is_global:
            raise ValueError("公開インターネット以外のアドレスには接続しません")
        ips.append(str(ip))
    if not ips:
        raise ValueError("接続先がありません")
    path = (u.path or "/") + (("?" + u.query) if u.query else "")
    return host, port, https, path, ips[0]


class _Pinned(http.client.HTTPConnection):
    """検査したIPアドレスにだけ接続する（Hostヘッダ・TLSのホスト名は、元のホスト名のまま）"""
    def __init__(self, host, port, ip, https, timeout):
        super().__init__(host, port, timeout=timeout)
        self._ip, self._https = ip, https

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        if self._https:
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=self.host)
        self.sock = sock


def _decode(raw, content_type):
    """文字コードを推測して文字列にする（ヘッダ → meta → UTF-8 → 日本語の古い形式）"""
    m = re.search(r"charset=([\w\-]+)", content_type or "", re.I)
    cands = [m.group(1)] if m else []
    head = raw[:4096].decode("ascii", "ignore")
    m2 = re.search(r"<meta[^>]+charset=[\"']?([\w\-]+)", head, re.I)
    if m2:
        cands.append(m2.group(1))
    cands += ["utf-8", "cp932", "euc-jp"]
    for c in cands:
        try:
            codecs.lookup(c)
            return raw.decode(c)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "replace")


_OG = re.compile(r"<meta\b[^>]*?\bproperty\s*=\s*[\"']og:title[\"'][^>]*?>", re.I)
_OG2 = re.compile(r"<meta\b[^>]*?\bname\s*=\s*[\"']og:title[\"'][^>]*?>", re.I)
_CONTENT = re.compile(r"\bcontent\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", re.I)
_TITLE = re.compile(r"<title\b[^>]*>(.*?)</title\s*>", re.I | re.S)


def extract_title(text):
    """HTML → タイトル。og:title があればそれ（余計な飾りが少ない）、なければ <title>"""
    cand = ""
    for rx in (_OG, _OG2):
        m = rx.search(text)
        if m:
            c = _CONTENT.search(m.group(0))
            if c:
                cand = c.group(1) or c.group(2) or ""
                break
    if not cand.strip():
        m = _TITLE.search(text)
        cand = m.group(1) if m else ""
    cand = re.sub(r"<[^>]+>", " ", cand)
    cand = re.sub(r"\s+", " ", html.unescape(cand)).strip()
    cand = "".join(ch for ch in cand if ch.isprintable())
    return cand[:200] or None


def fetch_title(url, allow_private=False, allow_any_port=False):
    """タイトルを返す。取れなければ None（理由は呼び出し側に出さない）。禁止されたURLは ValueError"""
    now = time.time()
    hit = _cache.get(url)
    if hit and hit[0] > now:
        return hit[1]
    deadline = now + TIMEOUT
    cur = url
    for _ in range(MAX_REDIRECTS + 1):
        host, port, https, path, ip = check_url(cur, allow_private, allow_any_port)
        left = deadline - time.time()
        if left <= 0:
            return None
        conn = _Pinned(host, port, ip, https, min(left, TIMEOUT))
        try:
            conn.request("GET", path, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml",
                                              "Accept-Language": "ja,en;q=0.8", "Accept-Encoding": "identity", "Connection": "close"})
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308) and resp.getheader("Location"):
                cur = urljoin(cur, resp.getheader("Location"))
                continue
            if resp.status != 200:
                return None
            ctype = resp.getheader("Content-Type") or ""
            if "html" not in ctype.lower() and ctype:
                return None
            raw = b""
            while len(raw) < MAX_BYTES and time.time() < deadline:
                chunk = resp.read(min(16384, MAX_BYTES - len(raw)))
                if not chunk:
                    break
                raw += chunk
                if b"</head>" in raw.lower() and _TITLE.search(raw.decode("latin-1")):
                    break  # <head> が終わって、タイトルも見つかったら、本文は読まない
            title = extract_title(_decode(raw, ctype))
            _cache[url] = (now + CACHE_SEC, title)
            if len(_cache) > 500:
                _cache.clear()
            return title
        except (OSError, http.client.HTTPException, ssl.SSLError):
            return None
        finally:
            conn.close()
    return None  # 転送が多すぎる
