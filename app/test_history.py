"""履歴に「何が変わったか」（日付・完了・リスト・本文など）が出ることの確認。TICK_DATA に一時フォルダを指定して実行"""
import store

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


def changes(nid):
    """新しい順の、変更の説明の一覧（履歴の1行ずつ）"""
    return [h["changes"] for h in store.history(nid)]


store.init_git()
store.reindex()
a = store.create_note("履歴のテスト")["id"]
store.commit_now()
h = changes(a)
check("作成の1件だけ", h == [["作成"]], h)

store.update_note(a, "履歴のテスト", "2026-11-10")
store.commit_now()
h = changes(a)
check("日付を付けた", len(h) == 2 and any("日付: なし → 2026/11/10" in c for c in h[0]), h)

store.update_note(a, "履歴のテスト", "2026-11-15T15:00")
store.commit_now()
h = changes(a)
check("日付を変えた（時刻つき）", any("日付: 2026/11/10 → 2026/11/15 15:00" in c for c in h[0]), h[0])
check("本文は変えていないので「本文を変更」は出ない", "本文を変更" not in h[0], h[0])

store.update_note(a, "履歴のテスト\n2行目", "2026-11-15T15:00")
store.commit_now()
h = changes(a)
check("本文だけ変えた", h[0] == ["本文を変更"], h[0])

store.update_note(a, "履歴のテスト\n2行目", "2026-11-15T15:00", list_="仕事/営業")
store.commit_now()
check("リストを入れた", any("リスト: 受信箱 → 仕事/営業" in c for c in changes(a)[0]), changes(a)[0])

store.update_note(a, "履歴のテスト\n2行目", "2026-11-15T15:00", status="done")
store.commit_now()
check("完了にした", "完了にした" in changes(a)[0], changes(a)[0])

store.update_note(a, "履歴のテスト\n2行目", "2026-11-15T15:00", status="open")
store.commit_now()
check("完了を戻した", "完了・中止を戻した" in changes(a)[0], changes(a)[0])

store.update_note(a, "履歴のテスト\n2行目", "2026-11-15T15:00", priority=5, pinned=True)
store.commit_now()
c = changes(a)[0]
check("優先度・ピン留め", "優先度: なし → 高" in c and "ピン留め: なし → ピン留め" in c, c)

h = store.history(a)
check("どの行にも changes がある", all("changes" in r for r in h) and len(h) >= 8, len(h))
check("sha・date は今までどおり", all(r["sha"] and r["date"] for r in h))

# 単体（git を使わない）
d = store.describe_change
base = "---\nid: x\ncreated: 2026-11-01T00:00:00+09:00\nupdated: 2026-11-01T00:00:00+09:00\n---\n本文\n"
moved = base.replace("updated: 2026-11-01T00:00:00+09:00\n", "updated: 2026-11-02T00:00:00+09:00\nsort: 5.0\n")
check("updated と sort だけの違いは、説明なし", d(base, moved) == [], d(base, moved))
check("削除", d(base, None) == ["ゴミ箱へ移動（または削除）"])
cancelled = base.replace("---\n本文", "status: abandoned\ncancelled: 2026-11-05\n---\n本文")
check("中止にした", d(base, cancelled)[0] == "中止にした" and any("中止日: なし → 2026/11/5" in x for x in d(base, cancelled)), d(base, cancelled))

store.commit_now()
print("失敗", bad)
