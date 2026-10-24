"""tick_clone のデータを、別のフォルダ（クラウド同期のフォルダ・外付けドライブなど）へバックアップする。

- メモ(notes/・trash/)と履歴(.git) → 日付入りzipにまとめる（直近 KEEP 個を残す）
- 添付(attachments/) → 新しい/大きさが違うものだけ追加コピー（バックアップ側では削除しない）
- index.db は作り直せる索引なので対象外

使い方:
  python tools/backup.py --dest <保存先フォルダ>      （環境変数 TICK_BACKUP_DIR でも指定できる）
  保存先を指定しないとき（Windows）: `マイドライブ\\tick_clone` があるドライブ（Google ドライブ）を探して、その中の tick_clone_backup に保存する
"""
import os
import shutil
import string
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

DATA = Path(os.environ.get("TICK_DATA", Path(__file__).resolve().parent.parent / "data"))
LOG = Path(__file__).resolve().parent.parent / "backup.log"
KEEP = 14


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def find_dest():
    """保存先: --dest → 環境変数 TICK_BACKUP_DIR → Google ドライブ（マイドライブ\\tick_clone がある方）の tick_clone_backup。無ければ None"""
    if "--dest" in sys.argv:
        i = sys.argv.index("--dest")
        if i + 1 < len(sys.argv):
            return Path(sys.argv[i + 1])
    if os.environ.get("TICK_BACKUP_DIR"):
        return Path(os.environ["TICK_BACKUP_DIR"])
    root = find_drive_root()
    return root / "tick_clone_backup" if root else None


def find_drive_root():
    """私物のドライブ（マイドライブ\\tick_clone がある方）を探す。見つからなければ None"""
    for letter in string.ascii_uppercase:
        p = Path(f"{letter}:/マイドライブ/tick_clone")
        if p.is_dir():
            return p.parent
    return None


def main():
    dest = find_dest()
    if dest is None:
        log("失敗: 保存先が決まりません。--dest <フォルダ> か、環境変数 TICK_BACKUP_DIR で指定してください（Googleドライブを使うなら、Drive を起動してから再実行）")
        return 1
    (dest / "notes").mkdir(parents=True, exist_ok=True)
    (dest / "attachments").mkdir(parents=True, exist_ok=True)

    # 1) メモ + 履歴 → zip
    srcs = [DATA / "notes", DATA / "trash", DATA / ".git"]
    files = [p for s in srcs if s.exists() for p in s.rglob("*") if p.is_file()]
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    final = dest / "notes" / f"notes_{stamp}.zip"
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / final.name
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for p in files:
                z.write(p, p.relative_to(DATA).as_posix())
        with zipfile.ZipFile(tmp) as z:  # 書いたzipを読み直して確認
            bad = z.testzip()
            n = len(z.namelist())
        if bad or n != len(files):
            log(f"失敗: zipの検証に失敗 (壊れ={bad}, {n}/{len(files)}件)")
            return 1
        shutil.copy2(tmp, final)
        if final.stat().st_size != tmp.stat().st_size:
            log("失敗: ドライブへのコピーサイズが一致しません")
            return 1
    mb = final.stat().st_size / 1e6
    # 古いzipを整理（新しい順に KEEP 個だけ残す）
    zips = sorted((dest / "notes").glob("notes_*.zip"), reverse=True)
    for old in zips[KEEP:]:
        old.unlink()
    log(f"メモ: {len(files)}ファイル → {final.name} ({mb:.1f}MB) / zip {min(len(zips), KEEP)}個保持")

    # 2) 添付 → 追加コピー
    att = DATA / "attachments"
    copied = 0
    if att.exists():
        for p in att.iterdir():
            if not p.is_file():
                continue
            t = dest / "attachments" / p.name
            if not t.exists() or t.stat().st_size != p.stat().st_size:
                shutil.copy2(p, t)
                copied += 1
    log(f"添付: 新しく {copied} 個をコピー")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # 失敗は必ずログに残す
        log(f"失敗: {type(e).__name__}: {e}")
        sys.exit(1)
