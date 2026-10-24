"""テストを全部、1つずつ、新しい空のデータフォルダで走らせて、結果をまとめる。 python tools/run_tests.py
（テストは、空のフォルダ（環境変数 TICK_DATA）を前提にしている。実データには触れない）
  --network  インターネットにつなぐテスト（リンクのタイトル取得）も含める
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
network = "--network" in sys.argv
failed = []
for t in sorted(APP.glob("test_*.py")):
    if t.name == "test_linktitle.py" and not network:
        print(f"-- {t.name}: スキップ（--network を付けると走らせます）")
        continue
    with tempfile.TemporaryDirectory() as td:
        env = {**os.environ, "TICK_DATA": td, "PYTHONIOENCODING": "utf-8"}
        r = subprocess.run([sys.executable, str(t)], cwd=APP, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    last = [ln for ln in r.stdout.splitlines() if ln.strip()][-1:] or ["（出力なし）"]
    ng = [ln for ln in r.stdout.splitlines() if ln.startswith("NG ")]
    ok = r.returncode == 0 and not ng and last[0].replace(" ", "") == "失敗0"
    print(("OK  " if ok else "NG  ") + t.name + "  " + last[0])
    if not ok:
        failed.append(t.name)
        for ln in (ng or r.stderr.splitlines()[-5:]):
            print("      ", ln[:200])
print("\n全部通りました" if not failed else f"\n失敗: {', '.join(failed)}")
sys.exit(1 if failed else 0)
