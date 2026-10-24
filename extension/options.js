const $ = (id) => document.getElementById(id);
const msg = (s) => { $("msg").textContent = s; };

chrome.storage.sync.get("server").then(({ server }) => { $("server").value = server || ""; });

$("save").onclick = async () => {
  const v = $("server").value.trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\/[^\s/]+$/.test(v)) { msg("アドレスの形が違います（例: https://<PC名>.<tailnet名>.ts.net）"); return; }
  await chrome.storage.sync.set({ server: v });
  msg("保存しました");
};

$("test").onclick = async () => {
  const typed = $("server").value.trim().replace(/\/+$/, "");
  const list = [typed, "http://localhost:8765"].filter((x, i, a) => x && a.indexOf(x) === i);
  msg("確認中…");
  for (const base of list) {
    try {
      const r = await fetch(base + "/api/counts", { signal: AbortSignal.timeout(6000) });
      if (r.ok) { msg("つながりました: " + base); return; }
    } catch { /* 次の候補へ */ }
  }
  msg("どこにもつながりません（PC が起動中か、Tailscale につながっているか確認してください）");
};
