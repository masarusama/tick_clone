// サービスワーカー: アプリ本体（HTML/JS/CSS）と、見た添付を端末に保存して、オフラインでも開けるようにする。
// メモのデータそのものは data.js が IndexedDB に持つ。ここは「アプリを起動できるようにする」だけ。
const VER = "v53"; // v53: 字下げした行の改行で、次の行も同じ字下げ / v52: 字下げ（整形表示でも先頭の空白を残す・Tab / Shift+Tab） / v51: 上の帯にリスト名・タグの一覧で作ると、そのタグ付き / v50: 「今日」・カレンダーの日で作ると、その日の期日 / v49: 新規メモ（未保存）でも、期日を選べる / v48: 「一段落して次へ」（完了にせず、振り返りへ記録して期日を進める） / v47: ノートは日付を持たない（ノートにすると日付を外す・日付を付けるとタスク） / v46: 並び順に「タグ順」 / v45: 新規メモは、既定でノート（日付を扱う画面・リストの設定を除く）・PCの大きな＋ボタン・Alt+T で新規タスク / v44: 繰り返しのタスクの完了・スキップを、「## 振り返り」へ自動で1行記録 / v43: 完了・中止のあとの「振り返り」（末尾の ## 振り返り）/ v42: 任意のアクセストークン（TICK_TOKEN）のログイン / v41: このリストに入れたメモは、自動でノートにする / v40: 締切が近づいたら別のリストへ移す（1日1回）・フィルターのルールで自動でリストへ / v39: ノートにしたメモを、自動でリストへ（資料など）。共有・Chrome拡張のメモもノート / v38: フィルターに「完了・中止したメモも含める」 / v37: 予定・タスクを「中止（キャンセル）」にする（完了日＝実績には数えない） / v36: フィルター（保存した絞り込み） / v35: 複数選択の見た目と数え方の修正（開いている行を選択と取り違えない・最初のCtrl+クリックで開いているメモも含める） / v34: カレンダーの日付の種類に「完了日」 / v33: スマホの「戻る」ボタンで、アプリの中を1つ戻る / v32: スマホ向けの選択モード（☑ボタン・タップで選ぶ） / v31: 複数選択・まとめてドラッグ・まとめて操作・元に戻す / v30: 日付ピッカーでも、締切・予定のリスト自動振り分け / v29: 完了日の表示・並び順 / 締切・予定のリスト自動振り分け / v28: リマインダーの表示を読みやすく（9540分前 → 7日前の朝9:00） / v27: リストの行をドラッグで並べ替え / v26: ノートとタスクの区別（種類・ノート一覧・リストごとの既定） / v25: リストの並び順・空のリスト・リストの削除 / v24: リスト（受信箱・フォルダ/リスト・ドラッグで移動） / v23: 繰り返し / v22: 整形表示での複数行のコピー・切り取り・貼り付け / v21: アプリ内の使い方（help.html） / v20: 複数日の予定（長い帯・期間の指定） / v19: 予定の印・時刻の範囲・日付の行の次の行の時刻 / v18: 月カレンダーの帯を右クリック・長押しでメニュー / v17: 大きな月カレンダー / v16: 日時が多いメモは提案しない / v15: 本文の日時の提案（期日にする） / v14: 手動の並べ替え・並び順の切り替え・日付に年 / v13: ゴミ箱（見る・戻す） / v12: 上のバーが幅に合わせて折り返す（ボタンが画面外に出ない） / v11: メモの上のバーに「⋯」メニュー（スマホでも削除などを使える） / v10: 編集中も、箇条書き・☐・番号の記号を本物の部品で表示 / v9: 整形表示のまま入力 / v2: HTTPキャッシュ対策 / v3: 優先度・タグの色・グループ表示 / v4: プッシュ通知 / v5: 通知の設定を☰メニューにも / v6: 期日の時刻・リマインダー・通知の完了/あとでボタン / v7: OSの「共有」先 / v8: リンクのタイトル自動付与 / v9: 整形表示のまま入力（段落ごとの編集）
const SHELL = "shell-" + VER;
const ATT = "attachments-" + VER;
const SHARE = "share"; // 共有されたものの一時置き場。版が変わっても消さない（受け取り前に消えないように）
const FILES = ["/", "/app.js", "/data.js", "/holidays.js", "/help.html", "/style.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== ATT && k !== SHARE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 通信を最大4秒待ち、だめなら端末の保存分で開く。つながっていれば常に最新の版が使われる
async function networkFirst(req, cacheKey) {
  const cache = await caches.open(SHELL);
  const fresh = fetch(req, { cache: "no-cache" }).then((r) => { // HTTPキャッシュを使わず、必ずサーバーに確認する
    if (r.ok && !r.redirected) cache.put(cacheKey, r.clone()); // ログイン画面などへの転送（redirected）を、アプリ本体として保存しない
    return r;
  });
  try {
    return await Promise.race([
      fresh,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
  } catch {
    const hit = await cache.match(cacheKey, { ignoreSearch: true });
    if (hit) { fresh.catch(() => {}); return hit; } // 遅いだけなら、裏で更新だけ続ける
    return fresh; // 保存分が無ければ通信の結果を待つ（失敗ならそのままエラー）
  }
}

// 添付（画像・PDF）は、一度見たものを端末に残す。ファイル名が変わらないので保存分を優先してよい
async function cacheFirst(req) {
  const cache = await caches.open(ATT);
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.status === 200) cache.put(req, r.clone()); // 部分応答(206)などは保存しない
  return r;
}

// ---- プッシュ通知: アプリが閉じていても、サーバーからの通知を表示する ----
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "tick_clone", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "tick_clone", {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.tag || undefined,       // 同じ tag の通知は、重ねずに置き換える
      renotify: !!d.tag,
      data: { url: d.url || "/", id: d.id || null },
      // 期日の通知には、通知のまま操作できるボタンを付ける（端末によっては、ボタンが表示されないこともある）
      actions: d.actions && d.id ? [{ action: "done", title: "✅ 完了" }, { action: "snooze", title: "⏰ 10分後" }] : [],
    })
  );
});

// 通知をタップしたら、開いているアプリがあればそこへ、無ければ新しく開く
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = new URL(data.url || "/", self.location.origin).href;
  // 「完了」「あとで」ボタン: アプリを開かずに、サーバーに頼む。つながらなければ、アプリを開く
  if ((e.action === "done" || e.action === "snooze") && data.id) {
    const path = e.action === "done" ? `/api/notes/${data.id}/complete` : `/api/notes/${data.id}/snooze?minutes=10`;
    e.waitUntil(
      fetch(path, { method: "POST" })
        .then((r) => { if (!r.ok) throw new Error(r.status); })
        .catch(() => self.clients.openWindow(url))
    );
    return;
  }
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          if ("navigate" in c && c.url !== url) c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// ---- OSの「共有」から受け取る: 共有された内容を一時置き場に入れて、画面（/?share=ID）に渡す ----
async function receiveShare(req) {
  try {
    const fd = await req.formData();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const cache = await caches.open(SHARE);
    const files = fd.getAll("files").filter((f) => typeof f !== "string" && f.size > 0).slice(0, 10);
    const meta = { title: String(fd.get("title") || ""), text: String(fd.get("text") || ""), url: String(fd.get("url") || ""),
                   files: files.map((f) => ({ name: f.name || "file", type: f.type || "application/octet-stream" })) };
    for (let i = 0; i < files.length; i++) await cache.put(`/_share/${id}/${i}`, new Response(files[i]));
    await cache.put(`/_share/${id}.json`, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    return Response.redirect(`/?share=${id}`, 303);
  } catch {
    return Response.redirect("/", 303); // 受け取れなくても、アプリは開く
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === "POST" && url.origin === location.origin && url.pathname === "/share") { e.respondWith(receiveShare(req)); return; }
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/login") return; // データはアプリ側で扱う（通信失敗も画面側で処理する）。ログイン画面は、ブラウザに任せる
  if (url.pathname.startsWith("/attachments/")) { e.respondWith(cacheFirst(req)); return; }
  if (req.mode === "navigate") { e.respondWith(networkFirst(req, "/")); return; }
  e.respondWith(networkFirst(req, req));
});
