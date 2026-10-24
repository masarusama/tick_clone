"""ゴミ箱（見る・戻す）の確認。TICK_DATA に一時フォルダを指定して実行"""
import store

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


store.init_git()
store.reindex()
a = store.create_note("戻すメモ #仕事\n本文の2行目")["id"]
b = store.create_note("そのまま消すメモ")["id"]
store.update_note(a, "戻すメモ #仕事\n本文の2行目", "2026-10-20T15:30", reminder="-PT10M")
store.update_note(a, "戻すメモ #仕事\n本文の2行目", pinned=True, priority=5)
before = store.get_note(a)
seq0 = store.sync_pull(0)["seq"]

check("消す", store.delete_note(a) is True and store.get_note(a) is None)
store.delete_note(b)
tr = store.list_trash()
check("一覧に2件（消した日時が新しい順。同じ秒のときは順不同）", {t["id"] for t in tr} == {a, b} and [t["trashed"] for t in tr] == sorted((t["trashed"] for t in tr), reverse=True), tr)
t = {x["id"]: x for x in tr}[a]
check("題名・書き出し・消した日時", t["title"] == "戻すメモ #仕事" and "本文の2行目" in t["preview"] and t["trashed"].startswith("20"), t)
g = store.get_trashed(a)
check("中身を読める", g and g["body"].startswith("戻すメモ") and g["title"] == "戻すメモ #仕事")
check("消した直後、端末側には『消えた』と通知される", a in store.sync_pull(seq0)["deleted"])

r = store.restore_note(a)
check("戻せる", r and r["id"] == a and r["body"] == before["body"], r)
check("期日・時刻・リマインダー・ピン・優先度も、そのまま戻る",
      r["due_set"] == "2026-10-20" and r["due_time"] == "15:30" and r["remind"] == "-PT10M" and r["pinned"] and r["priority"] == 5, r)
check("タグも戻る", "仕事" in r["tags"])
check("ゴミ箱から消える", [t["id"] for t in store.list_trash()] == [b])
p = store.sync_pull(seq0)
check("端末側には『戻った』と通知される（消えた通知は取り消される）", a in [n["id"] for n in p["notes"]] and a not in p["deleted"], p["deleted"])
check("ファイルに trashed の目印が残らない", "trashed" not in store._path_of(a).read_text(encoding="utf-8"))
check("作成日の年月の場所に戻る", "/".join(store._path_of(a).parts[-3:-1]) == before["created"][0:4] + "/" + before["created"][5:7].replace("/", ""), store._path_of(a))
check("ゴミ箱に残るのは、戻していないほう", [t["id"] for t in store.list_trash()] == [b])
check("2回戻そうとすると、ゴミ箱に無いので None", store.restore_note(a) is None)
try:
    store.restore_note("../../etc/passwd")
    check("不正なidは拒否", False)
except ValueError:
    check("不正なidは拒否", True)
try:
    store.get_trashed("..\\x")
    check("不正なidは拒否（読み出し）", False)
except ValueError:
    check("不正なidは拒否（読み出し）", True)
check("存在しないidは None", store.get_trashed("20200101-000000-abcd") is None)

# 同じidのメモが元の場所にあるのに、ゴミ箱にも同じidがあるときは、衝突として戻さない
c = store.create_note("衝突テスト")["id"]
p0 = store._path_of(c)
store.TRASH.mkdir(parents=True, exist_ok=True)
(store.TRASH / f"{c}.md").write_text(p0.read_text(encoding="utf-8"), encoding="utf-8")
try:
    store.restore_note(c)
    check("同じidが既にあれば衝突", False)
except store.RestoreConflict:
    check("同じidが既にあれば衝突", True)
check("衝突しても元のメモは無事", store.get_note(c)["body"] == "衝突テスト")

# 以前（消した日時の記録が無かった時代）にゴミ箱へ移したメモ: gitの履歴から日時を割り出す
d = store.create_note("古い時代に消したメモ")["id"]
store.commit_now()
op = store._path_of(d)
store.TRASH.mkdir(parents=True, exist_ok=True)
op.replace(store.TRASH / op.name)  # 目印（trashed）を付けずに移す = 旧い消し方
store.commit_now()
items = {x["id"]: x for x in store.list_trash()}
check("旧い消し方でも、日時が出る", d in items and items[d]["trashed"].startswith("20"), items.get(d))
check("旧い消し方でも、戻せる", store.restore_note(d)["body"] == "古い時代に消したメモ")
store.commit_now()
print("失敗", bad)
