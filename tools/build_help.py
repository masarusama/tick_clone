"""使い方.md（Drive の tick_clone フォルダ）→ アプリ内ヘルプ（app/static/help.html）を作る。
文書を直したら、これを実行する:  python tools/build_help.py
使っている Markdown の範囲: 見出し(#〜###)・箇条書き(- と、2段目は2文字下げ)・表・水平線・`コード`・**太字**・段落"""
import html
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "docs" / "使い方.md"
DST = Path(__file__).resolve().parent.parent / "app" / "static" / "help.html"


def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
    return s


def convert(md):
    out, lines, i = [], md.splitlines(), 0
    while i < len(lines):
        ln = lines[i]
        if not ln.strip():
            i += 1
        elif ln.strip() == "---":
            out.append("<hr>")
            i += 1
        elif ln.startswith("#"):
            m = re.match(r"(#{1,3})\s+(.*)", ln)
            n = len(m.group(1))
            out.append(f"<h{n}>{inline(m.group(2))}</h{n}>")
            i += 1
        elif ln.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                    rows.append(cells)
                i += 1
            head, body = rows[0], rows[1:]
            t = "<table><thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead><tbody>"
            for r in body:
                t += "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>"
            out.append(t + "</tbody></table>")
        elif re.match(r"\s*- ", ln):
            items = []  # (深さ, 文)
            while i < len(lines) and re.match(r"\s*- ", lines[i]):
                m = re.match(r"(\s*)- (.*)", lines[i])
                items.append((1 if len(m.group(1)) >= 2 else 0, m.group(2)))
                i += 1
            h = "<ul>"
            for k, (d, text) in enumerate(items):
                nxt = items[k + 1][0] if k + 1 < len(items) else 0
                if d == 0:
                    h += f"<li>{inline(text)}" + ("<ul>" if nxt == 1 else "</li>")
                else:
                    h += f"<li>{inline(text)}</li>" + ("</ul></li>" if nxt == 0 else "")
            out.append(h + "</ul>")
        else:
            para = [ln]
            i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r"\s*(- |#|\||---)", lines[i]):
                para.append(lines[i])
                i += 1
            out.append("<p>" + "<br>".join(inline(p) for p in para) + "</p>")
    return "\n".join(out)


if __name__ == "__main__":
    DST.write_text(convert(SRC.read_text(encoding="utf-8")) + "\n", encoding="utf-8", newline="\n")
    print("書き出し:", DST)
