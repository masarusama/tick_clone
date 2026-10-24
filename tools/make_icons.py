"""アプリのアイコン（青地に白いチェック）を PNG で書き出す。 python tools/make_icons.py"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "static"
BG = (47, 111, 237)  # style.css の --accent
FG = (255, 255, 255)
PTS = [(0.29, 0.52), (0.44, 0.67), (0.73, 0.34)]  # チェックの折れ線（0〜1）
HALF = 0.065  # 線の太さの半分


def seg_dist(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def png(size, path):
    rows = []
    for y in range(size):
        row = bytearray([0])  # フィルタなし
        for x in range(size):
            u, v = (x + 0.5) / size, (y + 0.5) / size
            d = min(seg_dist(u, v, PTS[i], PTS[i + 1]) for i in range(len(PTS) - 1))
            cov = max(0.0, min(1.0, 0.5 + (HALF - d) * size))  # 縁を少しなめらかに
            row += bytes(int(BG[k] + (FG[k] - BG[k]) * cov) for k in range(3))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(data)
    print("書き出し:", path.name, size, "px", len(data), "bytes")


if __name__ == "__main__":
    for s in (192, 512):
        png(s, OUT / f"icon-{s}.png")
