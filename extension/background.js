// tick_clone に追加（Chrome 拡張）。右クリック / ツールバーのボタンから、メモ（ノート）を作る。
// 送り先は、自分の tick_clone だけ（設定の URL → 既定の2つ、の順に試す）。

const DEFAULT_SERVERS = ["http://localhost:8765"]; // 先に試すアドレスは、オプション画面で入れる（例: https://<PC名>.<tailnet名>.ts.net）

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "clip", title: "tick_clone に追加", contexts: ["selection", "page", "link", "image"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "clip") clip(info, tab);
});
chrome.action.onClicked.addListener((tab) => clip({}, tab));

async function servers() {
  const { server } = await chrome.storage.sync.get("server");
  const list = [];
  for (const s of [server, ...DEFAULT_SERVERS]) {
    const u = (s || "").trim().replace(/\/+$/, "");
    if (u && !list.includes(u)) list.push(u);
  }
  return list;
}

// つながったサーバーに送る。つながらない（通信エラー）ときだけ、次の候補を試す。サーバーが答えたら、その結果で終わり
// アクセストークン（サーバーに TICK_TOKEN を設定しているときだけ）は、この端末の中（chrome.storage.local）にだけ保存し、Authorization ヘッダーで送る
async function send(path, init) {
  let lastErr = null;
  const { token } = await chrome.storage.local.get("token");
  const headers = { ...(init && init.headers), ...(token ? { Authorization: "Bearer " + token } : {}) };
  for (const base of await servers()) {
    try {
      const r = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(8000) });
      return { r, base };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("送り先がありません");
}

function newId() { // サーバーと同じ形（日本時間）。同じ id を送り直しても、メモは重複しない
  const t = new Date(Date.now() + 9 * 3600 * 1000).toISOString();
  const hex = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { id: `${t.slice(0, 10).replace(/-/g, "")}-${t.slice(11, 19).replace(/:/g, "")}-${hex}`, created: t.slice(0, 19) + "+09:00" };
}

function noteBody({ title, url, text }) {
  const lines = [];
  const t = (title || "").replace(/\s+/g, " ").trim();
  lines.push(t || url || "Webクリップ");
  if (url) lines.push(url);
  const body = (text || "").replace(/\r\n?/g, "\n").trim();
  if (body) lines.push("", body);
  lines.push("", "#共有");
  return lines.join("\n") + "\n";
}

async function uploadImage(srcUrl) {
  const res = await fetch(srcUrl);
  if (!res.ok) throw new Error("画像を取得できませんでした (" + res.status + ")");
  const blob = await res.blob();
  let name = "image";
  try { name = decodeURIComponent(new URL(srcUrl).pathname.split("/").pop()) || name; } catch { /* 名前が取れなくても続ける */ }
  if (!/\.\w{2,5}$/.test(name)) name += "." + ((blob.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*/, ""));
  const { r } = await send("/api/attachments", { method: "POST", headers: { "X-Filename": encodeURIComponent(name) }, body: blob });
  if (!r.ok) throw new Error("画像を送れませんでした (" + r.status + ")");
  return await r.json();
}

async function clip(info, tab) {
  try {
    const url = info.linkUrl || info.pageUrl || (tab && tab.url) || "";
    let title = (tab && tab.title) || "";
    let text = info.selectionText || "";
    if (info.linkUrl && !info.selectionText) title = ""; // リンクを右クリック: ページのタイトルではなく、リンクだけ
    if (info.srcUrl && info.mediaType === "image") {
      const up = await uploadImage(info.srcUrl);
      text = `![](${up.url})` + (text ? "\n\n" + text : "");
    }
    const body = noteBody({ title, url, text });
    const { id, created } = newId();
    const { r, base } = await send("/api/notes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, id, created, kind: "note" }),
    });
    if (r.status === 401) throw new Error("アクセストークンが違う、または未設定です（拡張機能のオプションで入れてください）");
    if (!r.ok) throw new Error("サーバーのエラー (" + r.status + ")");
    notify("tick_clone に追加しました", body.split("\n")[0] + "\n（" + base.replace(/^https?:\/\//, "") + "）");
  } catch (e) {
    notify("tick_clone に追加できませんでした", String((e && e.message) || e) + "\nPC が起動していて、Tailscale につながっているか確認してください。");
  }
}

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icon.png", title, message: message.slice(0, 300) });
}
