"""お試し用のデモデータを作る。  python tools/seed_demo.py [保存先フォルダ] [--force]

保存先（既定: リポジトリ直下の data-demo/）に、架空のメモ・リスト・フィルターを書き出す。
使うとき:  TICK_DATA=data-demo を付けて起動する（Windows の PowerShell: $env:TICK_DATA="data-demo"; python -m uvicorn ...）。
実データ（data/）には、触れない。すでに中身があるフォルダには、--force を付けない限り、書かない。
"""
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
args = [a for a in sys.argv[1:] if not a.startswith("--")]
dest = Path(args[0]) if args else ROOT / "data-demo"
if dest.exists() and any(dest.iterdir()) and "--force" not in sys.argv:
    sys.exit(f"{dest} には、すでに中身があります。上書きしないので、別の場所を指定するか、--force を付けてください。")
dest.mkdir(parents=True, exist_ok=True)
os.environ["TICK_DATA"] = str(dest.resolve())
sys.path.insert(0, str(ROOT / "app"))
import store  # noqa: E402

JST = timezone(timedelta(hours=9))
today = date.today()
day = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731


def ago(days, hh=10, mm=0):
    d = datetime.now(JST).replace(hour=hh, minute=mm, second=0, microsecond=0) - timedelta(days=days)
    return d.isoformat(timespec="seconds")


def make(body, created_days_ago=1, **kw):
    n = store.create_note(body, created=ago(created_days_ago))
    store.update_note(n["id"], body, **kw)
    return n["id"]


store.init_git()
# ---- 仕事 ----
make("週次レビューをする\n先週の完了を見て、来週の予定を決める。\n\n#仕事", 20, due=day(((4 - today.weekday()) % 7) or 7), kind="task", repeat="FREQ=WEEKLY;BYDAY=FR", list_="仕事")
make("企画書を提出する\n- [ ] 構成を決める\n- [ ] 図を作る\n- [ ] 見直す\n\n#仕事", 6, due=day(5), priority=5, kind="task", list_="仕事/企画")
make("見積もりを送る\n\n#仕事", 4, due=day(1), priority=3, kind="task", list_="仕事/営業")
make("経費を精算する\n\n#仕事", 12, due=day(-2), kind="task", list_="仕事/総務")  # 期限切れ（締切を過ぎている）
# ---- 予定 ----
make("歯医者 15:00\n定期検診。保険証を持っていく。", 3, due=day(3) + "T15:00", event="1", kind="task", list_="予定")
make("友人とランチ\n\n#友人", 2, due=day(6) + "T12:00", event="1", kind="task", list_="予定")
make("温泉旅行\n宿の予約はできている。", 10, due=day(9), start=day(7), event="1", kind="task", list_="予定")
rid = make("ランチ会（雨で中止）\n\n#友人", 9, due=day(-1) + "T12:00", event="1", kind="task", list_="予定")
store.update_note(rid, "ランチ会（雨で中止）\n\n#友人", status="abandoned")  # 中止（キャンセル）: 実績には数えない
# ---- 買い物・いつか ----
make("牛乳・卵・パンを買う\n- [ ] 牛乳\n- [ ] 卵\n- [ ] パン\n\n#買い物", 1, kind="task", list_="買い物")
make("新しいイヤホンを調べる\n\n#買い物", 8, kind="task", list_="いつか")
make("本棚を整理する\n\n#家", 15, kind="task", list_="いつか")
# ---- 完了（実績） ----
for i, (title, d) in enumerate([("電気代を払う", 2), ("返信メールを書く", 1), ("ごみを出す", 0)]):
    nid = make(f"{title}\n\n#家", 5 + i, kind="task", list_="買い物" if i == 1 else "")
    store.update_note(nid, f"{title}\n\n#家", status="done")
# ---- ノート（資料・日記） ----
make("読書メモ: 『小さな習慣』\n- 毎日2分だけ始める\n- 続けることが先、量は後\n\n#読書", 14, kind="note", list_="資料")
make("Python の uvicorn で動かす手順\n1. 部品を入れる\n2. 起動する\n3. ブラウザで開く\n\n#メモ", 30, kind="note", list_="資料")
make("日記\n朝は少し寒かった。午後は散歩して、読書メモを1つ書いた。\n\n#日記", 1, kind="note", list_="資料")
make("日記\n仕事の見積もりを送った。夜はゆっくり過ごした。\n\n#日記", 2, kind="note", list_="資料")
# ---- 受信箱（リスト未設定） ----
make("あとで調べる: 引っ越しの手続き", 0, kind="task")
make("アイデア: アプリの名前を考える", 0, kind="note")
make("https://example.com/\n例のページ\n\n#共有", 0, kind="note")

settings = {
    "tagColors": {"仕事": "#3e63dd", "買い物": "#f76b15", "日記": "#30a46c"},
    "lists": ["仕事", "仕事/企画", "仕事/営業", "仕事/総務", "予定", "買い物", "いつか", "資料"],
    "listKinds": {"資料": "note"},
    "listRoutes": {"deadline": "仕事", "event": "予定", "note": "資料"},
    "listPromote": {},
    "listToNote": ["資料"],
    "filters": [
        {"id": "week", "name": "今週の締切", "match": "all", "incDone": False, "to": "",
         "conds": [{"t": "kind", "v": "task", "not": False}, {"t": "due", "v": "next7", "not": False}, {"t": "event", "v": "deadline", "not": False}]},
        {"id": "diary", "name": "日記", "match": "any", "incDone": True, "to": "",
         "conds": [{"t": "tag", "v": "日記", "not": False}, {"t": "title", "v": "日記", "not": False}]},
    ],
}
(dest / "settings.json").write_text(json.dumps(settings, ensure_ascii=False, indent=1), encoding="utf-8")
store.commit_now()
print(f"デモデータを作りました: {dest}")
print(f"起動:  TICK_DATA={dest}  python -m uvicorn main:app --app-dir app --host 127.0.0.1 --port 8765")
