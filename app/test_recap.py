"""繰り返すタスクの、完了・スキップの記録（本文の「## 振り返り」へ、1行）の確認。TICK_DATA に空の一時フォルダを指定して実行"""
import store

bad = 0


def check(name, cond, extra=""):
    global bad
    ok = bool(cond)
    bad += not ok
    print("OK " if ok else "NG ", name, "" if ok else extra)


store.init_git()
store.reindex()
today = store.now_iso()[:10]

# ---- 純粋な関数 ----
f = store.add_recap_line
b = f("題名\n\n#家", "2026-10-25", "✓")
check("見出しが無ければ、末尾に作る", b == "題名\n\n#家\n\n## 振り返り\n- 2026-10-25 ✓\n", repr(b))
b2 = f(b, "2026-11-01", "中止")
check("見出しがあれば、その節の末尾に足す", b2.endswith("- 2026-10-25 ✓\n- 2026-11-01 中止\n"), repr(b2))
check("同じ日付・同じ印は、二重にならない", f(b, "2026-10-25", "✓") == b)
c = f("題名\n\n## 振り返り\n- 2026-10-20 楽しかった\n\n## 別の節\n本文\n", "2026-10-25", "✓")
check("次の見出しの前（節の末尾）に入る", c == "題名\n\n## 振り返り\n- 2026-10-20 楽しかった\n- 2026-10-25 ✓\n\n## 別の節\n本文\n" or "- 2026-10-25 ✓\n\n## 別の節" in c, repr(c))

# ---- 繰り返すタスク: 完了 → 次の回へ進み、回の記録が付く ----
a = store.create_note("週次ミーティング\n\n#仕事")["id"]
store.update_note(a, "週次ミーティング\n\n#仕事", due="2026-10-01", repeat="FREQ=WEEKLY;BYDAY=TH", kind="task")
r = store.update_note(a, "週次ミーティング\n\n#仕事", status="done")
check("次の回へ進む（完了にならない）", not r["done"] and r["due"] > "2026-10-01", r)
check("完了の記録（✓）が、本文の「## 振り返り」に1行付く", f"## 振り返り\n- {today} ✓" in r["body"], r["body"])
body1 = r["body"]
# 端末が、先に同じ行を足して送ってきても、二重にならない
r2 = store.update_note(a, body1, status="done")
check("同じ日に、もう一度完了しても、同じ行が二重にならない", r2["body"].count(f"- {today} ✓") == 1, r2["body"])

# ---- スキップ（中止） ----
s = store.create_note("毎週の予定")["id"]
store.update_note(s, "毎週の予定", due="2026-10-01", repeat="FREQ=WEEKLY;BYDAY=TH", event="1", kind="task")
rs = store.update_note(s, "毎週の予定", status="abandoned")
check("スキップは、「中止」の行が付く（完了日は付かない）", not rs["done"] and f"- {today} 中止" in rs["body"] and rs["completed"] == "", rs["body"])

# ---- 繰り返さないタスク・ノートには、付かない ----
p = store.create_note("普通のタスク")["id"]
store.update_note(p, "普通のタスク", kind="task")
rp = store.update_note(p, "普通のタスク", status="done")
check("繰り返さないタスクには、付かない（完了日が残るので）", "振り返り" not in rp["body"] and rp["done"] and rp["completed"], rp["body"])

# ---- 通知の「完了」ボタンと同じ呼び方（本文はそのまま渡す）でも付く ----
q = store.create_note("通知から完了")["id"]
store.update_note(q, "通知から完了", due="2026-10-01", repeat="FREQ=DAILY", kind="task")
rq = store.update_note(q, store.get_note(q)["body"], status="done")
check("通知の完了ボタン経由でも、記録が付く", f"- {today} ✓" in rq["body"], rq["body"])
# ---- 振り返りの節の日付は、「今日」などに出さない（不具合の再発防止）----
w = store.create_note("月末の掃除 キッチン\n\n#家")["id"]
store.update_note(w, "月末の掃除 キッチン\n\n#家\n\n## 振り返り\n- " + today + " 実は4,5日まえ　完璧にやった\n", kind="task")
ids_today = {x["id"] for x in store.list_notes(view="today", today=today)}
check("振り返りの中の今日の日付で、「今日」の一覧に出ない", w not in ids_today)
check("本文の日付（索引）にも入らない", all(d[0] != today for d in store.note_dates({"created": store.now_iso()}, store.get_note(w)["body"])), store.note_dates({"created": store.now_iso()}, store.get_note(w)["body"]))
w2 = store.create_note("締切あり\n" + today + "までに提出\n\n## 振り返り\n- 2026-01-01 昨年の分\n")["id"]
check("振り返りの外の日付は、これまでどおり、読む", w2 in {x["id"] for x in store.list_notes(view="today", today=today)})
check("without_recap: 次の見出しの前までだけを除く", store.without_recap("A\n## 振り返り\n- 2026-10-25 x\n## 別\n本文 10/26\n") == "A\n## 別\n本文 10/26\n")
ba = store.get_note(a)["body"]
check("繰り返しのタスクの、自動の行（✓）の日付も、本文の日付に入らない", f"- {today} ✓" in ba and all(not (d[1] == "text" and d[0] == today) for d in store.note_dates({"created": store.now_iso()}, ba)), store.note_dates({"created": store.now_iso()}, ba))
store.commit_now()
print("失敗", bad)
