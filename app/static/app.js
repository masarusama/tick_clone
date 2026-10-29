import * as D from "./data.js";
import { holidayName } from "./holidays.js";

// アクセストークン（TICK_TOKEN）が設定されていて、認証が切れたら、どの通信でも、ログイン画面へ
const _fetch = window.fetch.bind(window);
window.fetch = async (...a) => {
  const r = await _fetch(...a);
  try { if (r.status === 401 && new URL(r.url).pathname.startsWith("/api/")) location.href = "/login"; } catch { /* URL が読めなくても続ける */ }
  return r;
};

const $ = (id) => document.getElementById(id);
const ed = $("editor"), listEl = $("list"), tagTreeEl = $("tagtree"), searchEl = $("search");
const statusEl = $("status"), sug = $("suggest");

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => ymd(new Date());

const state = {
  notes: [], tags: [], counts: {}, cal: {}, cur: null, sel: 0, dirty: false,
  selIds: new Set(), selMode: false, anchor: null, batch: 0, dragIds: [], // selMode: 選択モード（タップでメモを選ぶ。スマホ向け） // 複数選択（Ctrl/Shift+クリック）・まとめて操作の最中か・ドラッグ中の複数id
  filter: "", filters: [], // 選んでいる保存した絞り込みの id / 保存した絞り込みの一覧
  tag: "", q: "", view: "all", list: "", inbox: false, lists: [], inboxCount: 0, // list: 選んでいるリスト（フォルダも可）/ inbox: 受信箱（リスト未設定）を選んでいる            // view: all/today/week/overdue/nodate/calendar/done
  day: "", month: todayStr().slice(0, 7), calSrc: "due,text", calPanel: "day", // calPanel: day / undated
  showDone: false,
  dragId: null, pendingRefresh: false, // ドラッグ中のメモ
  groupBy: "none",                     // 一覧のグループ表示: none / tag
  sortMode: "updated",                 // 並び順: updated / created / created_asc / due / priority / title / manual
  tagColors: {},                       // タグ名 → 色
};

// 画面の小さな好み（折りたたみ・表示モード）は、使えなければ覚えないだけにする
const pref = {
  get(k, d) { try { const v = localStorage.getItem("tc_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tc_" + k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};
const collapsed = new Set(pref.get("collapsed", []));
state.calSrc = pref.get("calSrc", "due,text");
state.groupBy = pref.get("groupBy", "none");
state.sortMode = pref.get("sortMode", "updated");
state.tagColors = pref.get("tagColors", {});
state.filters = pref.get("filters", []); // 保存した絞り込み。設定として全端末で共通
state.listToNote = pref.get("listToNote", []); // このリストに入れたメモは、自動でノートにする（期日の無い未完了のタスクだけ）。設定として全端末で共通
state.listPromote = pref.get("listPromote", {}); // 元のリスト → {to, days}: 締切が近づいたら、別のリストへ移す。設定として全端末で共通
state.listRoutes = pref.get("listRoutes", {}); // "deadline" / "event" → 自動で入れるリスト名。設定として全端末で共通
state.listKinds = pref.get("listKinds", {}); // リスト名 → 新規メモの既定の種類（note / task）。設定として全端末で共通
state.listOrder = pref.get("listOrder", []); // リストの並び順（空のリストも含む）。設定として全端末で共通

// ---------- サーバーAPI（履歴だけ。一覧・検索・保存は端末のコピー D から） ----------
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status}`);
  return r.json();
}

// ---------- 一覧 ----------
async function refresh() {
  if (state.batch) return; // まとめて操作の最中は、終わってから1回だけ作り直す
  const today = todayStr();
  const cal = state.view === "calendar";
  const curFilter = state.filter ? state.filters.find((x) => x.id === state.filter) : null;
  const done = state.view === "done" ? "only" : curFilter || (cal && state.calSrc === "completed") ? "all" : state.showDone ? "all" : "hide"; // 保存した絞り込みは、完了の扱いも、絞り込み自身（と下の filterOpenOnly）で決める
  const f = {
    q: state.q, tag: state.tag, list: state.list, inbox: state.inbox, done, today, src: state.calSrc,
    filter: curFilter, filterOpenOnly: !state.showDone,
    view: cal || state.view === "done" || state.view === "bigcal" ? "all" : state.view,
    sort: state.sortMode,
  };
  if (cal) f.date = state.day;
  // ドラッグ中、またはマウスを押している最中に一覧を作り直すと、ドラッグが途切れて文字選択になってしまう。終わってから作り直す
  if (state.dragId || state.pressing) { state.pendingRefresh = true; return; }
  const undated = cal && state.calPanel === "undated";
  const noList = (cal && !state.day && !undated) || state.view === "trash" || state.view === "bigcal"; // カレンダーで日を選ぶまで / ゴミ箱の表示中は、通常の一覧を空にする
  let notes = noList ? [] : D.list(undated ? { ...f, view: "nodate", date: "" } : f);
  if (state.groupBy === "tag") {
    // ピン留めを先頭に、そのあとタグ名の順（タグなしは最後）。同じグループの中は、もとの並び（更新が新しい順）のまま
    const rank = (n) => (n.pinned ? 0 : 1);
    const g = (n) => groupTagOf(n);
    notes = notes.map((n, i) => [n, i]).sort(([a, i], [b, j]) =>
      rank(a) - rank(b) || (rank(a) === 0 ? 0 : (g(a) === "") - (g(b) === "") || g(a).localeCompare(g(b), "ja")) || i - j).map(([n]) => n);
  }
  state.notes = notes;
  if (state.selIds.size) { const vis = new Set(notes.map((n) => n.id)); state.selIds = new Set([...state.selIds].filter((id) => vis.has(id))); } // 一覧から消えたものは、選択から外す
  state.tags = D.tags(done);
  state.lists = D.lists(done);
  state.inboxCount = D.inboxCount(done);
  state.counts = D.counts(state.showDone ? "all" : "hide", today);
  if (cal) state.cal = D.calendar(state.month, state.calSrc, calDone());
  const i = notes.findIndex((n) => n.id === state.cur);
  if (i >= 0) state.sel = i;
  state.sel = Math.min(state.sel, Math.max(notes.length - 1, 0));
  render();
}

// 日時は、年つき（26/10/11 14:36）で見せる。月日だけだと、何年のものか分からないため
const p2 = (n) => String(n).padStart(2, "0");
function fmtDate(iso) {
  const d = new Date(iso);
  return `${p2(d.getFullYear() % 100)}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
}
function fmt(iso) {
  const d = new Date(iso);
  return `${fmtDate(iso)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
// 期日は、今年のものは月/日だけ、今年でないものは年つき（見やすさのため）
function fmtDue(ymdStr) {
  const [y, m, d] = ymdStr.split("-");
  return +y === new Date().getFullYear() ? `${+m}/${+d}` : `${y.slice(2)}/${m}/${d}`;
}

const VIEWS = [
  ["all", "📥", "すべて"], ["today", "📅", "今日"], ["week", "🗓", "次の7日間"],
  ["overdue", "⚠️", "期限切れ"], ["nodate", "◌", "日付なし"], ["notes", "📝", "ノート"],
  ["calendar", "📆", "カレンダー"], ["bigcal", "🗓", "月カレンダー（大）"], ["done", "✅", "完了・中止"], ["trash", "🗑", "ゴミ箱"],
];
const VIEW_COUNT = { all: "all", today: "today", week: "week", overdue: "overdue", nodate: "nodate", notes: "notes", done: "done" };

function setView(v, tag = "", sel = {}) { // sel: { list } か { inbox: true }（左ペインのリスト欄）
  document.body.classList.remove("navopen"); // スマホではメニューを閉じる
  state.view = v;
  state.tag = tag;
  state.list = sel.list || "";
  state.inbox = !!sel.inbox;
  state.filter = sel.filter || "";
  state.sel = 0;
  if (v === "calendar") state.day = state.day || todayStr();
  if (v === "calendar" && state.day.slice(0, 7) !== state.month) state.month = state.day.slice(0, 7);
  if (v === "trash") { state.trash = null; state.trashMsg = ""; } // 開くたびに、サーバーから読み直す
  refresh();
  if (v === "trash") loadTrash();
}

// ---- ゴミ箱（見る・戻す）。ゴミ箱はサーバーにだけある（端末のコピーには入れない）ので、オンラインのときだけ使える ----
state.trash = null;
state.trashMsg = "";
async function loadTrash(keepMsg = false) { // keepMsg: 「元に戻しました」などの案内を残す
  if (!navigator.onLine) { state.trash = []; state.trashMsg = "ゴミ箱は、オンラインのときだけ見られます"; render(); return; }
  try {
    const r = await fetch("/api/trash", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    state.trash = await r.json();
    if (!keepMsg) state.trashMsg = "";
  } catch {
    state.trash = [];
    state.trashMsg = "ゴミ箱を読み込めませんでした";
  }
  render();
}

function renderTrashList() {
  const rows = [];
  if (state.trashMsg) rows.push(Object.assign(document.createElement("li"), { className: "hint", textContent: state.trashMsg }));
  if (state.trash === null) rows.push(Object.assign(document.createElement("li"), { className: "hint", textContent: "読み込み中…" }));
  else if (!state.trash.length && !state.trashMsg) rows.push(Object.assign(document.createElement("li"), { className: "hint", textContent: "ゴミ箱は、空です" }));
  for (const t of state.trash || []) {
    const li = document.createElement("li");
    li.className = "trashrow";
    li.innerHTML = '<div class="rowtxt"><div class="t"></div><div class="m"></div><div class="m pv"></div></div><button class="restore">元に戻す</button>';
    li.querySelector(".t").textContent = t.title || "（空のメモ）";
    li.querySelector(".m").textContent = `🗑 ${fmt(t.trashed)} に削除`;
    li.querySelector(".pv").textContent = t.preview;
    li.querySelector(".restore").onclick = (e) => { e.stopPropagation(); restoreFromTrash(t.id); };
    li.onclick = () => openTrashDetail(t.id);
    rows.push(li);
  }
  listEl.replaceChildren(...rows);
}

async function restoreFromTrash(id) {
  try {
    const r = await fetch(`/api/trash/${id}/restore`, { method: "POST" });
    if (r.status === 409) { state.trashMsg = "同じメモが、すでに元の場所にあります"; }
    else if (!r.ok) throw new Error(r.status);
    else { state.trashMsg = "元に戻しました（「すべて」に出ます）"; D.kick(200); } // 端末のコピーにも、すぐ取り込む
  } catch { state.trashMsg = "元に戻せませんでした（オンラインか、確認してください）"; }
  closeTrashDetail();
  await loadTrash(true);
}

const trashEl = $("trashview");
async function openTrashDetail(id) {
  try {
    const r = await fetch(`/api/trash/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const t = await r.json();
    $("tv-title").textContent = t.title || "（空のメモ）";
    $("tv-date").textContent = t.trashed ? `${fmt(t.trashed)} に、ゴミ箱へ移しました` : "";
    $("tv-body").textContent = t.body;
    $("tv-restore").onclick = () => restoreFromTrash(id);
    trashEl.hidden = false;
  } catch { state.trashMsg = "読み込めませんでした"; render(); }
}
function closeTrashDetail() { trashEl.hidden = true; }
$("tv-close").onclick = closeTrashDetail;
trashEl.addEventListener("mousedown", (e) => { if (e.target === trashEl) closeTrashDetail(); });

// ---------- 保存した絞り込み（フィルター） ----------
const FTYPES = [
  ["list", "リスト"], ["tag", "タグ"], ["priority", "優先度"], ["kind", "種類（タスク/ノート）"], ["status", "状態（完了/未完了）"],
  ["due", "期日"], ["event", "予定・締切"], ["title", "題名に含む文字"], ["text", "本文に含む文字"], ["pinned", "ピン留め"],
  ["completed", "完了した（○日以内）"], ["created", "作成した（○日以内）"], ["updated", "更新した（○日以内）"],
];
const FOPTS = {
  priority: [[5, "高"], [3, "中"], [1, "低"], [0, "なし"]],
  kind: [["task", "タスク"], ["note", "ノート"]],
  status: [["open", "未完了"], ["completed", "完了（やった）"], ["abandoned", "中止（キャンセル）"], ["done", "完了・中止（終わったもの全部）"]],
  due: [["today", "今日"], ["tomorrow", "明日"], ["next7", "今日から7日以内"], ["overdue", "期限切れ"], ["nodate", "期日なし"], ["hasdate", "期日あり"]],
  event: [["event", "予定"], ["deadline", "締切（期日があって予定でない）"]],
};
const fdefault = (t) => (t === "list" ? "" : t === "tag" ? (state.tags.find((x) => x.real) || {}).tag || "" : t === "priority" ? 5 : t === "kind" ? "task" : t === "status" ? "open"
  : t === "due" ? "today" : t === "event" ? "event" : t === "pinned" ? "" : ["completed", "created", "updated"].includes(t) ? 7 : "");
const filterToday = () => todayStr();
function filterCount(flt) {
  const today = filterToday();
  const openOnly = !state.showDone && !D.filterHasStatus(flt);
  let c = 0;
  for (const n of D.all()) if (!(openOnly && n.done) && D.filterMatch(n, flt, today)) c++;
  return c;
}
function filterRows() {
  const out = [];
  const h = document.createElement("div");
  h.className = "nav-h";
  h.textContent = "フィルター";
  const add = document.createElement("button");
  add.className = "nav-add";
  add.textContent = "＋";
  add.title = "新しいフィルター（条件を組み合わせて、保存した絞り込みを作る）";
  add.onclick = () => openFilterEditor(null);
  h.append(add);
  out.push(h);
  if (!state.filters.length) {
    const hint = document.createElement("div");
    hint.className = "nav-hint";
    hint.textContent = "「＋」で、条件を組み合わせた絞り込みを保存できます";
    out.push(hint);
  }
  state.filters.forEach((flt, i) => {
    const r = document.createElement("div");
    r.className = "tg-row flt-row" + (state.filter === flt.id && state.view !== "trash" ? " on" : "");
    r.style.paddingLeft = "10px";
    const tw = document.createElement("span");
    tw.className = "twist";
    const lb = document.createElement("span");
    lb.className = "lb";
    lb.textContent = "🔍 " + flt.name;
    const c = document.createElement("span");
    c.className = "c";
    c.textContent = filterCount(flt) || "";
    r.append(tw, lb, c);
    r.onclick = () => (state.filter === flt.id ? setView("all") : setView("all", "", { filter: flt.id }));
    r.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu([
        { label: "編集…", icon: "✏️", run: () => openFilterEditor(flt) },
        { label: flt.to ? `当てはまるメモを、自動で入れる: ${flt.to}` : "当てはまるメモを、自動でリストへ入れる", icon: "📋", sub: [
          ...orderedLists().slice(0, 30).map((l) => ({ label: l.name, icon: flt.to === l.name ? "●" : "○", run: () => setFilterTo(flt, l.name) })),
          { sep: true },
          { label: "自動で入れるのをやめる", disabled: !flt.to, run: () => setFilterTo(flt, "") },
        ] },
        { label: "複製", icon: "📄", run: () => { const copy = JSON.parse(JSON.stringify(flt)); copy.id = "f" + Date.now().toString(36); copy.name = flt.name + "（コピー）"; saveFilters([...state.filters, copy]); } },
        { sep: true },
        { label: "1つ上へ", disabled: i === 0, run: () => { const a = [...state.filters]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; saveFilters(a); } },
        { label: "1つ下へ", disabled: i === state.filters.length - 1, run: () => { const a = [...state.filters]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; saveFilters(a); } },
        { sep: true },
        { label: "フィルターを削除…", icon: "🗑", danger: true, run: () => deleteFilter(flt) },
      ], e.clientX, e.clientY);
    });
    out.push(r);
  });
  return out;
}
// フィルターに「当てはまるメモを、自動で入れるリスト」を設定する。いま受信箱（リスト未設定）にある該当メモにも、当てはめるか聞く
async function setFilterTo(flt, to) {
  const next = { ...flt, to };
  saveFilters(state.filters.map((x) => (x.id === flt.id ? next : x)));
  if (!to) { setStatus(`フィルター「${flt.name}」の自動振り分けを、やめました`); return; }
  const today = todayStr();
  const ids = D.all().filter((n) => !n.list && D.filterMatch(n, next, today)).map((n) => n.id);
  setStatus(`フィルター「${flt.name}」に当てはまるメモは、リスト未設定なら、「${to}」へ入ります`);
  if (ids.length && window.confirm(`いま、リスト未設定で、このフィルターに当てはまるメモが ${ids.length} 件あります。「${to}」へ入れますか？（「元に戻す」で戻せます）`)) {
    await runBatch(ids, (id) => actList(id, to), `フィルター「${flt.name}」のルールで、「${to}」へ入れました`);
  }
}
function saveFilters(arr) {
  state.filters = arr;
  pref.set("filters", arr);
  settingsPending = true;
  pref.set("settingsPending", true);
  pushSettings();
  render();
}
function deleteFilter(flt) {
  if (!window.confirm(`フィルター「${flt.name}」を削除します。（メモは消えません）`)) return;
  if (state.filter === flt.id) setView("all");
  saveFilters(state.filters.filter((x) => x.id !== flt.id));
  setStatus(`フィルター「${flt.name}」を削除しました`);
}

// 作る・直す画面
function openFilterEditor(flt) {
  if ($("fedit")) $("fedit").remove();
  const draft = flt ? JSON.parse(JSON.stringify(flt)) : { id: "f" + Date.now().toString(36), name: "", match: "all", conds: [{ t: "list", v: "", not: false }] };
  const ov = document.createElement("div");
  ov.id = "fedit";
  const box = document.createElement("div");
  box.id = "fedit-box";
  ov.append(box);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) ov.remove(); });
  const el = (tag, props = {}, ...kids) => { const x = Object.assign(document.createElement(tag), props); x.append(...kids); return x; };
  const sel = (opts, cur, onchange) => { const s = el("select"); for (const [v, l] of opts) s.append(el("option", { value: String(v), textContent: l, selected: String(v) === String(cur) })); s.onchange = () => onchange(s.value); return s; };

  const draw = () => {
    box.replaceChildren();
    box.append(el("h3", { textContent: flt ? "フィルターを編集" : "新しいフィルター" }));
    const nameIn = el("input", { type: "text", value: draft.name, placeholder: "名前（例: 日記、今週の締切）", maxLength: 60 });
    nameIn.oninput = () => { draft.name = nameIn.value; };
    box.append(el("label", { className: "f-row" }, el("span", { textContent: "名前" }), nameIn));
    box.append(el("label", { className: "f-row" }, el("span", { textContent: "条件の組み合わせ" }),
      sel([["all", "次の条件を、すべて満たす（かつ）"], ["any", "次の条件の、どれかを満たす（または）"]], draft.match, (v) => { draft.match = v; refreshCount(); })));
    const inc = el("input", { type: "checkbox", checked: !!draft.incDone });
    inc.onchange = () => { draft.incDone = inc.checked; refreshCount(); };
    box.append(el("label", { className: "f-row f-inc" }, inc, el("span", { textContent: "完了・中止したメモも含める" })));
    const list = el("div", { id: "fconds" });
    draft.conds.forEach((c, i) => {
      const row = el("div", { className: "f-cond" });
      row.append(sel([["", "含む"], ["1", "除く"]], c.not ? "1" : "", (v) => { c.not = v === "1"; refreshCount(); }));
      row.append(sel(FTYPES, c.t, (v) => { c.t = v; c.v = fdefault(v); draw(); }));
      const val = el("span", { className: "f-val" });
      if (c.t === "list") val.append(sel([["", "受信箱（リストなし）"], ...orderedLists().map((l) => [l.name, l.name])], c.v, (v) => { c.v = v; refreshCount(); }));
      else if (c.t === "tag") val.append(sel(state.tags.filter((x) => x.real).map((x) => [x.tag, "#" + x.tag]), c.v, (v) => { c.v = v; refreshCount(); }));
      else if (FOPTS[c.t]) val.append(sel(FOPTS[c.t], c.v, (v) => { c.v = c.t === "priority" ? +v : v; refreshCount(); }));
      else if (c.t === "title" || c.t === "text") { const t = el("input", { type: "text", value: c.v, placeholder: c.t === "text" ? "空白で区切ると、すべて含む" : "文字" }); t.oninput = () => { c.v = t.value; refreshCount(); }; val.append(t); }
      else if (["completed", "created", "updated"].includes(c.t)) { const t = el("input", { type: "number", min: 0, max: 3650, value: c.v }); t.oninput = () => { c.v = Math.max(0, +t.value || 0); refreshCount(); }; val.append(t, el("span", { textContent: " 日以内（0 = 今日だけ）" })); }
      else val.append(el("span", { className: "f-none", textContent: "（している）" }));
      row.append(val);
      row.append(el("button", { type: "button", className: "f-del", title: "この条件を消す", textContent: "×", onclick: () => { draft.conds.splice(i, 1); draw(); } }));
      list.append(row);
    });
    box.append(list);
    box.append(el("button", { type: "button", id: "f-add", textContent: "＋ 条件を追加", onclick: () => { draft.conds.push({ t: "list", v: "", not: false }); draw(); } }));
    box.append(el("div", { id: "f-count" }));
    const actions = el("div", { id: "f-actions" });
    actions.append(el("button", { type: "button", className: "primary", textContent: "保存", onclick: () => {
      draft.name = draft.name.trim() || "名前なし";
      draft.conds = draft.conds.filter((c) => c.t === "pinned" || c.t === "list" || String(c.v).trim() !== "");
      const arr = flt ? state.filters.map((x) => (x.id === draft.id ? draft : x)) : [...state.filters, draft];
      saveFilters(arr);
      ov.remove();
      setView("all", "", { filter: draft.id });
      setStatus(`フィルター「${draft.name}」を保存しました`);
    } }));
    actions.append(el("button", { type: "button", textContent: "キャンセル", onclick: () => ov.remove() }));
    box.append(actions);
    refreshCount();
  };
  const refreshCount = () => {
    const c = $("f-count");
    if (!c) return;
    const probe = { ...draft, conds: draft.conds.filter((x) => x.t === "pinned" || x.t === "list" || String(x.v).trim() !== "") };
    c.textContent = probe.conds.length ? `いまの条件に当てはまるメモ: ${filterCount(probe)} 件` + (D.filterHasStatus(probe) || state.showDone ? "" : "（完了したメモは除く）") : "条件がありません（すべてのメモが対象になります）";
  };
  document.body.append(ov);
  draw();
}

// ---- リスト欄（左ペイン）。リスト = メモに付ける「1つだけの箱」。"フォルダ/リスト" の2階層まで ----
const lcollapsed = new Set(pref.get("lcollapsed", []));
// 並び順: 設定の順（空のリストも含む）→ メモにだけ付いているリストは、名前順で後ろに
function orderedLists() {
  const cnt = new Map(state.lists.map((l) => [l.name, l.count]));
  const names = [...state.listOrder];
  for (const l of state.lists) if (!names.includes(l.name)) names.push(l.name);
  return names.map((name) => ({ name, count: cnt.get(name) || 0 }));
}
// 並びの構造: [{key, own: そのリスト自体があるか, kids: ["key/子", ...]}]（フォルダ内も、並び順のまま）
function listTree(ord) {
  const tops = [];
  const byKey = new Map();
  for (const { name } of ord) {
    const i = name.indexOf("/");
    const key = i < 0 ? name : name.slice(0, i);
    if (!byKey.has(key)) { const t = { key, own: false, kids: [] }; byKey.set(key, t); tops.push(t); }
    const t = byKey.get(key);
    if (i < 0) t.own = true; else t.kids.push(name);
  }
  return tops;
}
const flattenTree = (tops) => tops.flatMap((t) => [...(t.own ? [t.key] : []), ...t.kids]);
// リストの右クリック: 新規メモの既定の種類（TickTick の「ノート用のリスト」の感覚）
// リストの右クリック: 「締切にしたメモ」「予定にしたメモ」を、このリストに自動で入れる（リストが未設定のメモだけ）
function routeMenu(name) {
  const toggle = (type, label) => () => {
    const routes = { ...state.listRoutes };
    if (routes[type] === name) delete routes[type]; else routes[type] = name;
    saveListOrder(orderedLists().map((l) => l.name), state.listKinds, routes);
    setStatus(routes[type] === name ? `${label}にしたメモは、リストが未設定なら、「${name}」に入ります` : `${label}の自動振り分けを、やめました`);
  };
  return [
    { label: "締切にしたメモを、自動で入れる", icon: state.listRoutes.deadline === name ? "●" : "○", run: toggle("deadline", "締切") },
    { label: "予定にしたメモを、自動で入れる", icon: state.listRoutes.event === name ? "●" : "○", run: toggle("event", "予定") },
    { label: "ノートにしたメモを、自動で入れる", icon: state.listRoutes.note === name ? "●" : "○", run: toggle("note", "ノート") },
  ];
}
// リストの右クリック: 「このリストに入れたメモは、自動でノートにする」（期日の無い未完了のタスクだけ）
function toNoteMenu(name) {
  const on = state.listToNote.includes(name);
  return [{
    label: "このリストに入れたメモは、自動でノートにする", icon: on ? "●" : "○",
    run: async () => {
      const next = on ? state.listToNote.filter((x) => x !== name) : [...state.listToNote, name];
      saveListOrder(orderedLists().map((l) => l.name), state.listKinds, state.listRoutes, state.listPromote, next);
      if (on) { setStatus(`リスト「${name}」の「自動でノートにする」を、やめました`); return; }
      setStatus(`リスト「${name}」に入れた、期日の無い未完了のタスクは、ノートになります`);
      const ids = D.all().filter((n) => n.list === name && n.kind === "task" && !n.done && !n.due_set).map((n) => n.id);
      if (ids.length && window.confirm(`いま「${name}」にある、期日の無い未完了のタスクが ${ids.length} 件あります。ノートにしますか？（期日つき・完了済みは、そのままです。「元に戻す」で戻せます）`)) {
        await runBatch(ids, (id) => actKind(id, "note"), `「${name}」の、期日の無い未完了のタスクを、ノートにしました`);
      }
    },
  }];
}
// リストの右クリック: 「締切が近づいたら、別のリストへ移す」（期日つきの未完了タスクだけ。アプリを開いたとき、1日1回）
function promoteMenu(name) {
  const cur = state.listPromote[name];
  const save = (p) => saveListOrder(orderedLists().map((l) => l.name), state.listKinds, state.listRoutes, p);
  const set = (to, days) => () => { save({ ...state.listPromote, [name]: { to, days } }); setStatus(`「${name}」の期日つきのタスクは、締切が${days}日以内になったら、「${to}」へ移します（アプリを開いたとき）`); };
  const others = orderedLists().filter((l) => l.name !== name).slice(0, 30);
  return [{
    label: cur ? `締切が近づいたら移す: → ${cur.to}（${cur.days}日以内）` : "締切が近づいたら、別のリストへ移す", icon: "⏰",
    sub: [
      ...others.map((l) => ({ label: "移し先: " + l.name, icon: cur && cur.to === l.name ? "●" : "○", run: set(l.name, cur ? cur.days : 7) })),
      { sep: true },
      ...[3, 7, 14, 30].map((d) => ({ label: `締切が ${d} 日以内になったら`, icon: cur && cur.days === d ? "●" : "○", disabled: !cur, run: cur ? set(cur.to, d) : () => {} })),
      { sep: true },
      { label: "移すのをやめる", disabled: !cur, run: () => { const p = { ...state.listPromote }; delete p[name]; save(p); setStatus("締切が近づいたときの移動を、やめました"); } },
    ],
  }];
}
function kindMenu(name) {
  const cur = state.listKinds[name] || "task";
  const set = (k) => () => { const kinds = { ...state.listKinds }; if (k === "task") delete kinds[name]; else kinds[name] = k; saveListOrder(orderedLists().map((l) => l.name), kinds); setStatus(`リスト「${name}」で作る新しいメモは、${k === "note" ? "ノート" : "タスク"}になります`); };
  return [{ label: "新しいメモの種類: タスク", icon: cur === "task" ? "●" : "○", run: set("task") }, { label: "新しいメモの種類: ノート", icon: cur === "note" ? "●" : "○", run: set("note") }];
}
// ---- リストの行のドラッグ並べ替え（一番上の段どうし / 同じフォルダの中どうし） ----
const MIME_LIST = "application/x-tick-list";
const isListDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes(MIME_LIST);
let listSrc = null; // いまドラッグしている行 { key, name }
function listDrag(r, info) {
  const okTarget = () => listSrc && (listSrc.name === null ? true : listSrc.key === info.key && info.name !== null);
  const after = (e) => { const b = r.getBoundingClientRect(); return e.clientY > b.top + b.height / 2; };
  r.draggable = true;
  r.addEventListener("dragstart", (e) => {
    if (e.target !== r) return;
    listSrc = info;
    state.dragId = "list"; // 一覧の作り直しで、ドラッグが途切れないように
    e.dataTransfer.setData(MIME_LIST, JSON.stringify(info));
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => r.classList.add("dragsrc"), 0);
  });
  r.addEventListener("dragover", (e) => {
    if (!isListDrag(e) || !okTarget()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const a = after(e);
    r.classList.toggle("dropafter", a);
    r.classList.toggle("dropbefore", !a);
  });
  r.addEventListener("dragleave", (e) => { if (!r.contains(e.relatedTarget)) r.classList.remove("dropbefore", "dropafter"); });
  r.addEventListener("drop", (e) => {
    if (!isListDrag(e) || !okTarget()) return;
    e.preventDefault();
    const a = after(e);
    r.classList.remove("dropbefore", "dropafter");
    const src = listSrc;
    listSrc = null;
    state.dragId = null;
    if (src) moveListTo(src, info, a);
  });
  r.addEventListener("dragend", () => { listSrc = null; });
}
function moveListTo(src, tgt, after) {
  const tops = listTree(orderedLists());
  let arr, from, to;
  if (src.name === null) { // フォルダ・リストの1ブロックごと動かす
    arr = tops;
    from = arr.findIndex((t) => t.key === src.key);
    to = arr.findIndex((t) => t.key === tgt.key);
  } else { // 同じフォルダの中のリスト
    arr = tops.find((t) => t.key === src.key).kids;
    from = arr.indexOf(src.name);
    to = arr.indexOf(tgt.name);
  }
  if (from < 0 || to < 0 || from === to) return;
  const [x] = arr.splice(from, 1);
  const at = arr.indexOf(src.name === null ? arr.find((t) => t.key === tgt.key) : tgt.name);
  arr.splice(at + (after ? 1 : 0), 0, x);
  saveListOrder(flattenTree(tops));
  setStatus("リストの並びを変えました");
}

function moveList(key, name, dir) { // name: 子リストの名前（フォルダの中で動かす）/ null: 一番上の段で動かす
  const tops = listTree(orderedLists());
  const arr = name ? tops.find((t) => t.key === key).kids : tops;
  const i = name ? arr.indexOf(name) : arr.findIndex((t) => t.key === key);
  const j = dir === "top" ? 0 : dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= arr.length || j === i) return;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
  saveListOrder(flattenTree(tops));
}
function addList(name) { // 空のリストを作る
  if (orderedLists().some((l) => l.name === name)) { setStatus(`リスト「${name}」は、すでにあります`); return false; }
  saveListOrder([...orderedLists().map((l) => l.name), name]);
  return true;
}
async function deleteList(name) {
  const members = D.all().filter((n) => n.list === name);
  const msg = members.length ? `リスト「${name}」を削除します。中の ${members.length} 件のメモは、受信箱に戻ります（メモは消えません）。` : `空のリスト「${name}」を削除します。`;
  if (!window.confirm(msg)) return;
  for (const n of members) D.setList(n.id, "");
  if (state.list === name) setView("all");
  const kinds = { ...state.listKinds };
  delete kinds[name];
  const routes = Object.fromEntries(Object.entries(state.listRoutes).filter(([, v]) => v !== name));
  const promote = Object.fromEntries(Object.entries(state.listPromote).filter(([k, v]) => k !== name && v.to !== name));
  saveFilters(state.filters.map((f) => (f.to === name ? { ...f, to: "" } : f)));
  saveListOrder(orderedLists().map((l) => l.name).filter((x) => x !== name), kinds, routes, promote, state.listToNote.filter((x) => x !== name));
  setStatus(`リスト「${name}」を削除しました`);
  await refresh();
}
function listRows() {
  const out = [];
  const h = document.createElement("div");
  h.className = "nav-h";
  h.textContent = "リスト";
  const add = document.createElement("button");
  add.className = "nav-add";
  add.textContent = "＋";
  add.title = "新しいリスト（空）を作る。メモは、ドラッグかメニューで入れる";
  add.onclick = () => { const name = askListName(); if (name && addList(name)) setStatus(`リスト「${name}」を作りました（メモをドラッグして入れます）`); };
  h.append(add);
  out.push(h);
  const row = (label, count, { depth = 0, on = false, twist = "", onTwist, onClick, name = null, tip = "", menu = [], drag = null }) => {
    const r = document.createElement("div");
    r.className = "tg-row lst-row" + (on ? " on" : "");
    r.style.paddingLeft = 10 + depth * 14 + "px";
    const tw = document.createElement("span");
    tw.className = "twist";
    if (twist) { tw.textContent = twist; tw.onclick = (e) => { e.stopPropagation(); onTwist(); }; }
    const lb = document.createElement("span");
    lb.className = "lb";
    lb.textContent = label;
    const c = document.createElement("span");
    c.className = "c";
    c.textContent = count || "";
    r.append(tw, lb, c);
    r.onclick = onClick;
    if (tip) r.title = tip;
    if (menu.length) {
      r.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMenu(menu, e.clientX, e.clientY);
      });
    }
    if (drag) listDrag(r, drag); // リストの行は、ドラッグで並べ替えられる
    return r;
  };
  const inbox = row("📥 受信箱", state.inboxCount, {
    on: state.inbox && state.view !== "trash",
    onClick: () => (state.inbox ? setView("all") : setView("all", "", { inbox: true })),
    tip: "リストを付けていないメモ。メモをここに落とすと、リストが外れます",
  });
  dropTarget(inbox, (id) => actList(id, ""), "リストを外す（受信箱へ）");
  out.push(inbox);
  // フォルダごとにまとめる（"A/B" は A の下）。並びは設定の順（フォルダ名と同じ名前のリストがあってもよい）
  const ord = orderedLists();
  const cnt = new Map(ord.map((l) => [l.name, l.count]));
  const isOn = (name) => state.list === name && state.view !== "trash" && !state.inbox;
  const pick = (name) => () => (state.list === name ? setView("all") : setView("all", "", { list: name }));
  const mv = (key, name, dir) => () => moveList(key, name, dir);
  for (const t of listTree(ord)) {
    const nm = t.key;
    const total = (t.own ? cnt.get(nm) : 0) + t.kids.reduce((x, k) => x + cnt.get(k), 0);
    const r = row("📋 " + nm, total, {
      on: isOn(nm), onClick: pick(nm),
      twist: t.kids.length ? (lcollapsed.has(nm) ? "▸" : "▾") : "",
      onTwist: () => { lcollapsed.has(nm) ? lcollapsed.delete(nm) : lcollapsed.add(nm); pref.set("lcollapsed", [...lcollapsed]); renderNav(); },
      tip: t.kids.length ? "フォルダ（中のリストをまとめて表示）" : "",
      drag: { key: nm, name: null },
      menu: [
        ...(t.own ? [{ label: "名前を変える…", icon: "✏️", run: () => renameList(nm) }, ...kindMenu(nm), ...routeMenu(nm), ...toNoteMenu(nm), ...promoteMenu(nm), { sep: true }] : []),
        { label: "先頭へ", run: mv(nm, null, "top") }, { label: "1つ上へ", run: mv(nm, null, "up") }, { label: "1つ下へ", run: mv(nm, null, "down") },
        ...(t.own ? [{ sep: true }, { label: "リストを削除…", icon: "🗑", danger: true, run: () => deleteList(nm) }] : []),
      ],
    });
    if (t.own) dropTarget(r, (id) => actList(id, nm), "リスト「" + nm + "」へ入れる");
    out.push(r);
    if (lcollapsed.has(nm)) continue;
    for (const k of t.kids) {
      const kr = row(k.slice(nm.length + 1), cnt.get(k), {
        depth: 1, on: isOn(k), onClick: pick(k), drag: { key: nm, name: k },
        menu: [
          { label: "名前を変える…", icon: "✏️", run: () => renameList(k) }, ...kindMenu(k), ...routeMenu(k), ...toNoteMenu(k), ...promoteMenu(k), { sep: true },
          { label: "先頭へ", run: mv(nm, k, "top") }, { label: "1つ上へ", run: mv(nm, k, "up") }, { label: "1つ下へ", run: mv(nm, k, "down") },
          { sep: true }, { label: "リストを削除…", icon: "🗑", danger: true, run: () => deleteList(k) },
        ],
      });
      dropTarget(kr, (id) => actList(id, k), "リスト「" + k + "」へ入れる");
      out.push(kr);
    }
  }
  return out;
}

// 締切/予定にしたメモが、リスト未設定なら、設定したリストへ入れる（手で決めたリストは動かさない）
function routeList(id, type) {
  const n = D.get(id);
  if (!n || n.list) return "";
  let to = state.listRoutes[type];
  const pr = to && state.listPromote[to]; // 締切が、すでに「近い」なら、遠い締切の置き場（Oneday）ではなく、移し先（具体的な次…）へ直接入れる
  if (to && type === "deadline" && pr && n.due_set && n.due_set <= addDays(pr.days)) to = pr.to;
  if (to) return `（リスト「${to}」へ入れました）` + enterList(id, to);
  return autoFile(id); // 種類・日付の設定が無いときは、保存したフィルターのルールで
}
// メモをリストへ入れる（自動振り分け・ドラッグ・メニュー共通）。「このリストに入れたメモは、自動でノートにする」のリストなら、期日の無い未完了のタスクは、ノートにする。戻り値: 追加の案内
function enterList(id, name) {
  D.setList(id, name);
  const n = D.get(id);
  if (name && n && state.listToNote.includes(name) && n.kind === "task" && !n.done && !n.due_set) {
    D.setKind(id, "note");
    return "（ノートにしました）";
  }
  return "";
}
// 保存したフィルターの「当てはまるメモを、自動で入れるリスト」: リスト未設定のメモが、フィルターに当てはまれば、そのリストへ（上のフィルターが優先）
function autoFile(id) {
  const n = D.get(id);
  if (!n || n.list) return "";
  const today = todayStr();
  const f = state.filters.find((x) => x.to && D.filterMatch(n, x, today));
  if (!f) return "";
  const extra = enterList(id, f.to);
  return `（フィルター「${f.name}」のルールで、リスト「${f.to}」へ入れました）` + extra;
}
// 1日1回（アプリを開いたとき）: ①締切が近づいたタスクを移す ②リスト未設定のメモに、フィルターのルールを当てはめる。「元に戻す」が出る
let dailyBusy = false;
async function maybeDaily() {
  const today = todayStr();
  if (dailyBusy || state.batch || state.dragId || pref.get("dailyDay", "") === today) return;
  dailyBusy = true;
  try {
    pref.set("dailyDay", today); // 先に印を付ける（2回走らないように）
    for (const [from, rule] of Object.entries(state.listPromote)) {
      const limit = addDays(rule.days);
      const ids = D.all().filter((n) => n.list === from && n.kind === "task" && !n.done && n.due_set && n.due_set <= limit).map((n) => n.id);
      if (ids.length) await runBatch(ids, (id) => actList(id, rule.to), `締切が${rule.days}日以内になったので、「${from}」から「${rule.to}」へ移しました`);
    }
    const rules = state.filters.filter((f) => f.to);
    if (rules.length) {
      const hit = new Map();
      for (const n of D.all()) { if (n.list) continue; const f = rules.find((r) => D.filterMatch(n, r, today)); if (f) hit.set(n.id, f); }
      if (hit.size) await runBatch([...hit.keys()], (id) => actList(id, hit.get(id).to), "フィルターのルールで、リスト未設定のメモを、リストへ入れました");
    }
  } finally { dailyBusy = false; }
}
// 日付ピッカーで期日を選んだあと: リスト未設定なら、予定の印があれば「予定」、無ければ「締切」のリストへ入れる
async function routeAfterPicker(id) {
  const n = id && D.get(id);
  if (!n || !n.due_set) return;
  const r = routeList(id, n.event ? "event" : "deadline");
  if (!r) return;
  setStatus(statusEl.textContent + r);
  await refresh();
  if (id === state.cur && document.body.classList.contains("previewing")) togglePreview(true, false);
}
async function actList(id, name) {
  if (id === state.cur) await flush();
  const n = D.get(id);
  if (!n || (n.list || "") === name) return;
  const extra = enterList(id, name);
  setStatus((name ? `リスト「${name}」へ入れました` : "リストを外しました（受信箱へ）") + extra);
  await refresh();
}

function askListName(init = "") {
  const v = window.prompt("リスト名（フォルダに入れるなら「フォルダ/リスト」。2階層まで）", init);
  if (v == null) return null;
  const name = v.split("/").map((x) => x.trim()).filter(Boolean).join("/");
  if (!name) return null;
  if (name.split("/").length > 2 || /[#\x00-\x1f]/.test(name) || name.length > 100) { setStatus("リスト名が使えません（2階層まで・# や改行は不可）"); return null; }
  return name;
}
async function newListFor(id) {
  const name = askListName();
  if (name) await actList(id, name);
}
async function renameList(from) {
  const to = askListName(from);
  if (!to || to === from) return;
  if (orderedLists().some((l) => l.name === to)) { setStatus(`リスト「${to}」は、すでにあります`); return; }
  let c = 0;
  for (const n of D.all()) if (n.list === from) { D.setList(n.id, to); c++; }
  if (state.list === from) state.list = to;
  const kinds = { ...state.listKinds };
  if (kinds[from]) { kinds[to] = kinds[from]; delete kinds[from]; }
  const routes = Object.fromEntries(Object.entries(state.listRoutes).map(([t, v]) => [t, v === from ? to : v]));
  const promote = Object.fromEntries(Object.entries(state.listPromote).map(([k, v]) => [k === from ? to : k, { ...v, to: v.to === from ? to : v.to }]));
  saveFilters(state.filters.map((f) => (f.to === from ? { ...f, to } : f)));
  saveListOrder(orderedLists().map((l) => (l.name === from ? to : l.name)), kinds, routes, promote, state.listToNote.map((x) => (x === from ? to : x)));
  setStatus(`リスト名を変えました: ${from} → ${to}（${c}件）`);
  await refresh();
}

function renderNav() {
  const nodes = [];
  for (const [v, icon, label] of VIEWS) {
    const b = document.createElement("button");
    b.className = "nv" + (state.view === v && !state.tag && !state.list && !state.inbox && !state.filter ? " on" : "");
    const n = VIEW_COUNT[v] ? state.counts[VIEW_COUNT[v]] : "";
    b.innerHTML = `<span class="ic"></span><span class="lb"></span><span class="c"></span>`;
    b.children[0].textContent = icon;
    b.children[1].textContent = label;
    b.children[2].textContent = n ? n : "";
    if (v === "overdue" && n) b.children[2].classList.add("warn");
    b.onclick = () => setView(v);
    // メモをドラッグして落とすと、その一覧に入る条件になる（今日→期日が今日、など）
    const dropAct = {
      today: [(id) => actDue(id, todayStr()), "期日を今日にする"],
      week: [(id) => actDue(id, addDays(1)), "期日を明日にする"],
      nodate: [(id) => actDue(id, ""), "期日を消す"],
      done: [(id) => actDone(id, true), "完了にする"],
    }[v];
    if (dropAct) { dropTarget(b, dropAct[0], dropAct[1]); b.title = "メモをここに落とすと、" + dropAct[1]; }
    nodes.push(b);
  }
  nodes.push(...listRows());
  nodes.push(...filterRows());
  const h = document.createElement("div");
  h.className = "nav-h";
  h.textContent = "タグ";
  nodes.push(h);
  // タグの階層（"リスト/Inbox" は "リスト" の下）。親が畳まれていたら子は出さない
  const hasKids = new Set(state.tags.map((t) => t.tag.split("/").slice(0, -1).join("/")).filter(Boolean));
  for (const t of state.tags) {
    const parts = t.tag.split("/");
    let hidden = false;
    for (let i = 1; i < parts.length; i++) if (collapsed.has(parts.slice(0, i).join("/"))) hidden = true;
    if (hidden) continue;
    const row = document.createElement("div");
    row.className = "tg-row" + (state.tag === t.tag ? " on" : "");
    row.style.paddingLeft = 10 + (parts.length - 1) * 14 + "px";
    const tw = document.createElement("span");
    tw.className = "twist";
    if (hasKids.has(t.tag)) {
      tw.textContent = collapsed.has(t.tag) ? "▸" : "▾";
      tw.onclick = (e) => {
        e.stopPropagation();
        collapsed.has(t.tag) ? collapsed.delete(t.tag) : collapsed.add(t.tag);
        pref.set("collapsed", [...collapsed]);
        renderNav();
      };
    }
    const lb = document.createElement("span");
    lb.className = "lb";
    lb.textContent = "#" + parts[parts.length - 1];
    const c = document.createElement("span");
    c.className = "c";
    c.textContent = t.count;
    const dot = tagColor(t.tag);
    if (dot) lb.style.color = dot;
    row.append(tw, lb, c);
    row.addEventListener("contextmenu", (e) => { // タグを右クリック → 色を選ぶ
      e.preventDefault();
      openMenu([
        ...TAG_COLORS.map(([name, hex]) => ({ label: name, icon: state.tagColors[t.tag] === hex ? "●" : "○", color: hex, run: () => setTagColor(t.tag, hex) })),
        { sep: true },
        { label: "色を消す", disabled: !state.tagColors[t.tag], run: () => setTagColor(t.tag, "") },
      ], e.clientX, e.clientY);
    });
    if (t.real) { dropTarget(row, (id) => actTag(id, t.tag), "#" + t.tag + " を付ける"); row.title = "メモをここに落とすと #" + t.tag + " が付きます"; }
    row.onclick = () => { state.tag === t.tag ? setView("all") : setView(state.view === "calendar" ? "calendar" : "all", t.tag); };
    nodes.push(row);
  }
  tagTreeEl.replaceChildren(...nodes);
}

// ---- カレンダー ----
const calEl = $("cal");
const SRC_LABELS = [["due,text", "期日＋本文の日付"], ["due", "期日だけ"], ["created", "作成日"], ["updated", "更新日"], ["completed", "完了日"]];
const calDone = () => (state.calSrc === "completed" ? "all" : state.showDone ? "all" : "hide"); // 完了日で見るときは、完了したメモが対象

function renderCal() {
  const on = state.view === "calendar";
  calEl.hidden = !on;
  if (!on) return;
  const [y, m] = state.month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - first.getDay()); // 日曜始まり
  const today = todayStr();
  const head = document.createElement("div");
  head.className = "cal-head";
  const prev = Object.assign(document.createElement("button"), { textContent: "‹", title: "前の月 ([)" });
  const next = Object.assign(document.createElement("button"), { textContent: "›", title: "次の月 (])" });
  const now = Object.assign(document.createElement("button"), { textContent: "今日" });
  const ttl = Object.assign(document.createElement("b"), { textContent: `${y}年${m}月` });
  const sel = document.createElement("select");
  for (const [v, l] of SRC_LABELS) sel.append(Object.assign(document.createElement("option"), { value: v, textContent: l, selected: v === state.calSrc }));
  prev.onclick = () => shiftMonth(-1);
  next.onclick = () => shiftMonth(1);
  now.onclick = () => { state.month = today.slice(0, 7); state.day = today; refresh(); };
  sel.onchange = () => { state.calSrc = sel.value; pref.set("calSrc", sel.value); refresh(); };
  head.append(prev, ttl, next, now, sel);
  const grid = document.createElement("div");
  grid.className = "cal-grid";
  for (const w of ["日", "月", "火", "水", "木", "金", "土"]) grid.append(Object.assign(document.createElement("div"), { className: "cal-w", textContent: w }));
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const s = ymd(d);
    if (i >= 35 && d.getMonth() !== m - 1) break; // 6行目が丸ごと翌月なら出さない
    const info = state.cal[s];
    const c = document.createElement("div");
    c.className = "cal-d" + (d.getMonth() !== m - 1 ? " out" : "") + (s === today ? " today" : "") + (s === state.day ? " sel" : "");
    c.innerHTML = '<span class="dn"></span><span class="dc"></span>';
    c.children[0].textContent = d.getDate();
    if (info) {
      c.children[1].textContent = info.n;
      c.title = info.items.map((x) => x.title).join("\n");
    }
    c.onclick = () => { state.day = s; state.calPanel = "day"; state.sel = 0; refresh(); };
    dropTarget(c, (id) => actDue(id, s), `期日を ${+s.slice(5, 7)}/${+s.slice(8)} にする`); // メモをこの日にドラッグ → 期日がこの日になる
    grid.append(c);
  }
  // 一覧に出すもの: 選んだ日のメモ / まだ日付が無いメモ（ここからカレンダーの日へドラッグできる）
  const tabs = document.createElement("div");
  tabs.className = "cal-tabs";
  for (const [k, label] of [["day", "選んだ日"], ["undated", `日付なし (${state.counts.nodate ?? 0})`]]) {
    const b = Object.assign(document.createElement("button"), { textContent: label });
    b.className = state.calPanel === k ? "on" : "";
    b.onclick = () => { state.calPanel = k; state.sel = 0; refresh(); };
    tabs.append(b);
  }
  calEl.replaceChildren(head, grid, tabs);
}

// ---- 大きな月カレンダー（窓いっぱい。メモは日付のマスに、帯で並ぶ） ----
const bigEl = $("bigcal");
state.bigMode = pref.get("bigMode", "month"); // month / week
state.bigDay = todayStr();                    // 週表示の基準日・月表示で見ている月の日
const WD_NAMES = ["月", "火", "水", "木", "金", "土", "日"]; // 月曜始まり
const mondayOf = (s) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
const addD = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function bigRange() {
  const base = new Date(state.bigDay + "T00:00:00");
  if (state.bigMode === "week") return { start: mondayOf(state.bigDay), rows: 1, month: base.getMonth() };
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const st = mondayOf(ymd(first));
  const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  const rows = Math.ceil((Math.round((last - st) / 86400000) + 1) / 7);
  return { start: st, rows, month: base.getMonth() };
}

function shiftBig(dir) {
  const d = new Date(state.bigDay + "T00:00:00");
  state.bigDay = ymd(state.bigMode === "week" ? addD(d, 7 * dir) : new Date(d.getFullYear(), d.getMonth() + dir, 1));
  renderBig();
}

function barColor(n) {
  for (const t of n.tags) { const c = tagColor(t); if (c) return c; }
  return "";
}

function renderBig() {
  const on = state.view === "bigcal";
  document.body.classList.toggle("bigcal", on);
  bigEl.hidden = !on;
  if (!on) { document.body.classList.remove("bigopen"); return; }
  const { start, rows, month } = bigRange();
  const today = todayStr();
  const lo = ymd(start), hi = ymd(addD(start, rows * 7));
  const items = D.calendarFull(lo, hi, state.calSrc, calDone());
  const base = new Date(state.bigDay + "T00:00:00");
  const head = document.createElement("div");
  head.id = "bc-head";
  const navb = Object.assign(document.createElement("button"), { textContent: "☰", title: "メニュー", id: "bc-nav" });
  navb.onclick = (e) => { e.stopPropagation(); document.body.classList.add("navopen"); };
  const ttl = Object.assign(document.createElement("b"), { textContent: `${base.getFullYear()}年${base.getMonth() + 1}月` + (state.bigMode === "week" ? "（週）" : "") });
  const mk = (text, title, fn) => Object.assign(document.createElement("button"), { textContent: text, title, onclick: fn });
  const sel = document.createElement("select");
  for (const [v, l] of SRC_LABELS) sel.append(Object.assign(document.createElement("option"), { value: v, textContent: l, selected: v === state.calSrc }));
  sel.onchange = () => { state.calSrc = sel.value; pref.set("calSrc", sel.value); renderBig(); };
  const mode = mk(state.bigMode === "week" ? "週" : "月", "月 ⇄ 週", () => { state.bigMode = state.bigMode === "week" ? "month" : "week"; pref.set("bigMode", state.bigMode); renderBig(); });
  head.append(navb, ttl, mk("＋", "新しいメモ（期日は今日）", () => newBigNote(today)), mode, sel,
    mk("‹", "前へ ([)", () => shiftBig(-1)), mk("今日", "今日へ", () => { state.bigDay = today; renderBig(); }), mk("›", "次へ (])", () => shiftBig(1)));
  const wk = document.createElement("div");
  wk.id = "bc-wk";
  WD_NAMES.forEach((w, i) => wk.append(Object.assign(document.createElement("div"), { textContent: w, className: i === 6 ? "sun" : i === 5 ? "sat" : "" })));
  const grid = document.createElement("div");
  grid.id = "bc-grid";
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  // 複数日のメモは、週ごとに1本の長い帯にする（同じ高さの段に並べる）
  const isSpan = (it) => it.s && it.e && it.s < it.e;
  const spanRows = [];
  for (let r = 0; r < rows; r++) {
    const rowStart = ymd(addD(start, r * 7)), rowEnd = ymd(addD(start, r * 7 + 6));
    const recs = new Map();
    for (let col = 0; col < 7; col++) {
      for (const it of items[ymd(addD(start, r * 7 + col))] || []) {
        if (!isSpan(it)) continue;
        const rec = recs.get(it.id) || { it, a: col, b: col };
        rec.b = col;
        recs.set(it.id, rec);
      }
    }
    const list = [...recs.values()].sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a));
    const slots = [];
    for (const rec of list) {
      let k = 0;
      while (slots[k] !== undefined && slots[k] >= rec.a) k++;
      slots[k] = rec.b;
      rec.slot = k;
      rec.contL = rec.it.s < rowStart;
      rec.contR = rec.it.e > rowEnd;
    }
    spanRows.push({ list, n: slots.length });
  }
  const mkBar = (it, text) => {
    const b = document.createElement("div");
    b.className = "bc-bar" + (it.done ? " done" : "") + (it.id === state.cur ? " cur" : "") + (it.ghost ? " ghost" : "");
    b.dataset.id = it.id;
    const col = barColor(it);
    if (col) b.style.background = col;
    b.textContent = text;
    b.title = text;
    b.draggable = !it.ghost; // 今後の回（薄い帯）は、ドラッグしない（元のメモの期日が動いてしまうため）
    if (!it.ghost) b.addEventListener("dragstart", (e) => startDrag(e, it, b));
    b.onclick = (e) => { e.stopPropagation(); openFromBig(it.id); };
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openMenu(noteMenu(it.id), e.clientX, e.clientY); });
    if (it.ghost) b.title = "今後の回（繰り返し）: " + b.title;
    return b;
  };
  for (let i = 0; i < rows * 7; i++) {
    const d = addD(start, i), s = ymd(d);
    const hol = holidayName(s);
    const c = document.createElement("div");
    c.className = "bc-d" + (state.bigMode === "month" && d.getMonth() !== month ? " out" : "") + (i % 7 === 6 || hol ? " sun" : i % 7 === 5 ? " sat" : "");
    c.dataset.d = s;
    const top = document.createElement("div");
    top.className = "bc-top";
    top.append(Object.assign(document.createElement("span"), { className: "bc-n" + (s === today ? " today" : ""), textContent: d.getDate() === 1 ? `${d.getMonth() + 1}月1日` : d.getDate() }));
    if (hol) top.append(Object.assign(document.createElement("span"), { className: "bc-hol", textContent: hol }));
    const list = document.createElement("div");
    list.className = "bc-list";
    const sr = spanRows[Math.floor(i / 7)], col = i % 7;
    for (let k = 0; k < sr.n; k++) { // 複数日の帯の段（この日に帯がなければ、同じ高さの空き）
      const rec = sr.list.find((x) => x.slot === k && x.a <= col && col <= x.b);
      if (rec && rec.a === col) {
        const w = rec.b - rec.a + 1;
        const b = mkBar(rec.it, (rec.contL ? "◀ " : "") + (rec.it.title || "（空のメモ）") + (rec.contR ? " ▶" : ""));
        b.classList.add("bc-span");
        b.style.width = `calc(${w * 100}% + ${(w - 1) * 7}px)`;
        list.append(b);
      } else {
        const sp = document.createElement("div");
        sp.className = "bc-bar bc-sp";
        list.append(sp);
      }
    }
    for (const it of items[s] || []) {
      if (isSpan(it)) continue;
      list.append(mkBar(it, (it.time ? it.time + " " : "") + (it.title || "（空のメモ）"))); // 右クリック・長押し → いつものメモのメニュー
    }
    c.append(top, list);
    c.ondblclick = (e) => { if (!e.target.closest(".bc-bar")) newBigNote(s); };
    dropTarget(c, (id) => actDue(id, s), `期日を ${d.getMonth() + 1}/${d.getDate()} にする`);
    grid.append(c);
  }
  bigEl.replaceChildren(head, wk, grid);
  requestAnimationFrame(fitBars);
}

// マスの高さに入らない帯は、「+N件」にまとめる（押すと、その日を、いつものカレンダーで開く）
function fitBars() {
  for (const c of bigEl.querySelectorAll(".bc-d")) {
    const list = c.querySelector(".bc-list");
    const bars = [...list.querySelectorAll(".bc-bar")];
    list.querySelector(".bc-more")?.remove();
    bars.forEach((b) => (b.hidden = false));
    const room = c.clientHeight - c.querySelector(".bc-top").offsetHeight - 4;
    const per = (bars[0] ? bars[0].offsetHeight : 18) + 2;
    const cap = Math.max(1, Math.floor(room / per));
    if (bars.length > cap) {
      const keep = Math.max(cap - 1, 0);
      bars.slice(keep).forEach((b) => (b.hidden = true));
      const more = Object.assign(document.createElement("div"), { className: "bc-more", textContent: `+${bars.length - keep}件` });
      more.onclick = (e) => { e.stopPropagation(); state.day = c.dataset.d; state.month = c.dataset.d.slice(0, 7); state.calPanel = "day"; setView("calendar"); };
      list.append(more);
    }
  }
}
window.addEventListener("resize", () => { if (state.view === "bigcal") fitBars(); });

async function openFromBig(id) {
  document.body.classList.add("bigopen");
  await open(id, true);
  renderBig();
}
async function newBigNote(day) {
  document.body.classList.add("bigopen");
  await newNote(undefined, day);
}
$("bc-close").onclick = async () => {
  await flush();
  state.cur = null;
  ed.value = "";
  state.newDue = "";
  state.newTime = "";
  document.body.classList.remove("bigopen", "editing");
  document.body.classList.add("noedit");
  renderBig();
};

function shiftMonth(d) {
  const [y, m] = state.month.split("-").map(Number);
  state.month = ymd(new Date(y, m - 1 + d, 1)).slice(0, 7);
  state.day = "";
  refresh();
}

const PRIO_NAME = { 0: "なし", 1: "低", 3: "中", 5: "高" };

// グループ表示用: リスト名タグ（"リスト/…"）以外の、最初のタグ
function groupTagOf(n) {
  return n.tags.find((t) => !t.startsWith("リスト/")) || "";
}

// タグの色（端末をまたいで共通。サーバーの設定ファイルと同期する）
const TAG_COLORS = [
  ["赤", "#e5484d"], ["オレンジ", "#f76b15"], ["黄", "#d6a700"], ["緑", "#30a46c"],
  ["水色", "#0ea5c6"], ["青", "#3e63dd"], ["紫", "#8e4ec6"], ["ピンク", "#d6409f"], ["灰色", "#8b8d98"],
];
function tagColor(tag) {
  // "本/小説" は、自分の色が無ければ、親タグ "本" の色を使う
  const parts = tag.split("/");
  for (let i = parts.length; i >= 1; i--) {
    const c = state.tagColors[parts.slice(0, i).join("/")];
    if (c) return c;
  }
  return "";
}
let settingsPending = !!pref.get("settingsPending", false);
async function pushSettings() {
  if (!settingsPending || !navigator.onLine) return;
  try {
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tagColors: state.tagColors, lists: state.listOrder, listKinds: state.listKinds, listRoutes: state.listRoutes, listPromote: state.listPromote, listToNote: state.listToNote, filters: state.filters }) });
    if (r.ok) { settingsPending = false; pref.set("settingsPending", false); }
  } catch { /* つながったとき、次の同期でもう一度 */ }
}
async function pullSettings() {
  if (settingsPending || !navigator.onLine) return pushSettings();
  try {
    const r = await fetch("/api/settings", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    if (JSON.stringify(j.tagColors || {}) !== JSON.stringify(state.tagColors) || JSON.stringify(j.lists || []) !== JSON.stringify(state.listOrder) || JSON.stringify(j.listKinds || {}) !== JSON.stringify(state.listKinds) || JSON.stringify(j.listRoutes || {}) !== JSON.stringify(state.listRoutes) || JSON.stringify(j.filters || []) !== JSON.stringify(state.filters) || JSON.stringify(j.listPromote || {}) !== JSON.stringify(state.listPromote) || JSON.stringify(j.listToNote || []) !== JSON.stringify(state.listToNote)) {
      state.tagColors = j.tagColors || {};
      state.listOrder = j.lists || [];
      state.listKinds = j.listKinds || {};
      state.listRoutes = j.listRoutes || {};
      state.filters = j.filters || [];
      state.listPromote = j.listPromote || {};
      state.listToNote = j.listToNote || [];
      pref.set("listPromote", state.listPromote);
      pref.set("listToNote", state.listToNote);
      pref.set("filters", state.filters);
      pref.set("listKinds", state.listKinds);
      pref.set("listRoutes", state.listRoutes);
      pref.set("tagColors", state.tagColors);
      pref.set("listOrder", state.listOrder);
      render();
    }
  } catch { /* オフライン */ }
}
function saveListOrder(order, kinds = state.listKinds, routes = state.listRoutes, promote = state.listPromote, toNote = state.listToNote) {
  state.listToNote = toNote;
  pref.set("listToNote", toNote);
  state.listPromote = promote;
  pref.set("listPromote", promote);
  state.listOrder = order;
  state.listKinds = kinds;
  state.listRoutes = routes;
  pref.set("listRoutes", routes);
  pref.set("listOrder", order);
  pref.set("listKinds", kinds);
  settingsPending = true;
  pref.set("settingsPending", true);
  pushSettings();
  render();
}
function setTagColor(tag, color) {
  if (color) state.tagColors[tag] = color; else delete state.tagColors[tag];
  pref.set("tagColors", state.tagColors);
  settingsPending = true;
  pref.set("settingsPending", true);
  pushSettings();
  render();
}

function dueLabel(n) {
  if (!n.due) return "";
  const t = todayStr();
  const time = n.due_time && n.due === n.due_set ? " " + n.due_time + (/^\d\d:\d\d$/.test(n.event) ? "-" + n.event : "") : "";
  const bell = n.remind && n.remind.toLowerCase() === "none" ? " 🔕" : n.remind ? " ⏰" : "";
  return (n.due < t && !n.done && !n.event ? "⚠ " : n.event ? "🗓 " : "📅 ") + `${n.start ? fmtDue(n.start) + "〜" : ""}${fmtDue(n.due)}${time}${bell}${n.repeat ? " 🔁" : ""}`;
}

function render() {
  renderNav();
  renderCal();
  renderBig();
  paintSortBtn();
  const crumb = $("crumb");
  const bits = [];
  const vl = VIEWS.find((v) => v[0] === state.view);
  if (vl && state.view !== "all") bits.push(vl[2]);
  if (state.tag) bits.push("#" + state.tag);
  if (state.inbox) bits.push("📥 受信箱");
  if (state.filter) { const fl = state.filters.find((x) => x.id === state.filter); if (fl) bits.push("🔍 " + fl.name); }
  if (state.list) bits.push("📋 " + state.list.replace("/", " › "));
  if (state.view === "calendar" && state.calPanel === "undated") bits.push("日付なし");
  else if (state.view === "calendar" && state.day) bits.push(state.day.replace(/-0?/g, "/").replace("/", "年").replace("/", "月") + "日");
  crumb.textContent = state.view === "trash"
    ? "ゴミ箱" + (state.trash ? `  (${state.trash.length})` : "")
    : (bits.join(" › ") || "すべて") + `  (${state.notes.length})`;
  if (state.view === "trash") { renderTrashList(); return; }
  const empty = state.view === "calendar" && !state.day;
  // 見出し: ピン留めは常に先頭の1グループ。そのあとは「グループ表示」の設定（なし / タグ）に従う
  const keyOf = (n) => (n.pinned ? "pin" : state.groupBy === "tag" ? "t:" + groupTagOf(n) : "rest");
  const counts = new Map();
  state.notes.forEach((n) => counts.set(keyOf(n), (counts.get(keyOf(n)) || 0) + 1));
  const hasPinned = counts.has("pin");
  const headText = (k) => (k === "pin" ? "📌 ピン留め" : k === "rest" ? "そのほか" : k.slice(2) ? "#" + k.slice(2) : "タグなし");
  const groupHead = (k) => {
    const li = Object.assign(document.createElement("li"), { className: "grouphead" });
    const c = k.startsWith("t:") ? tagColor(k.slice(2)) : "";
    if (c) li.style.borderLeft = `4px solid ${c}`;
    li.textContent = `${headText(k)}  ${counts.get(k)}`;
    return li;
  };
  const showHeads = hasPinned || state.groupBy === "tag";
  listEl.replaceChildren(
    ...(empty ? [Object.assign(document.createElement("li"), { className: "hint", textContent: "日付を選んでください" })] : []),
    ...state.notes.flatMap((n, i) => {
      const heads = [];
      const k = keyOf(n);
      if (showHeads && (i === 0 || k !== keyOf(state.notes[i - 1]))) {
        if (k === "rest" && !hasPinned) { /* ピン留めが無いときの「そのほか」は出さない */ } else heads.push(groupHead(k));
      }
      const li = document.createElement("li");
      li.className = (i === state.sel ? "sel " : "") + (n.id === state.cur ? "cur " : "") + (state.selIds.has(n.id) ? "msel " : "") + (n.done ? "done" : "");
      li.dataset.id = n.id;
      li.draggable = true;
      li.addEventListener("dragstart", (e) => startDrag(e, n, li));
      if (state.sortMode === "manual") { // 手動の並べ替え: 行の上半分に落とすと、その上に、下半分なら、その下に置く
        const half = (e) => { const r = li.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
        li.addEventListener("dragover", (e) => {
          if (!isNoteDrag(e) || state.dragId === n.id || state.dragIds.length > 1) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const after = half(e);
          li.classList.toggle("dropafter", after);
          li.classList.toggle("dropbefore", !after);
        });
        li.addEventListener("dragleave", () => li.classList.remove("dropbefore", "dropafter"));
        li.addEventListener("drop", (e) => {
          if (!isNoteDrag(e) || state.dragIds.length > 1) return;
          e.preventDefault();
          const after = half(e);
          li.classList.remove("dropbefore", "dropafter");
          const id = e.dataTransfer.getData(MIME) || state.dragId;
          state.dragId = null; // 続く一覧の更新を通す
          document.body.classList.remove("dragging");
          if (id) reorderTo(id, n.id, after);
        });
      }
      li.innerHTML = '<button class="rowchk"></button><div class="rowtxt"><div class="t"></div><div class="m"></div></div>';
      const chk = li.firstChild;
      chk.title = n.done ? "完了を戻す (x)" : "完了にする (x)";
      chk.textContent = n.abandoned ? "×" : n.done ? "✓" : "";
      if (n.abandoned) chk.classList.add("canc");
      if (n.kind === "note") { chk.classList.add("isnote"); chk.textContent = "📝"; chk.title = "ノート（完了は付けません。タスクにすると、○で完了できます）"; }
      if (n.priority) { chk.classList.add("p" + n.priority); chk.title += `　優先度: ${PRIO_NAME[n.priority]}`; }
      chk.onclick = (e) => { e.stopPropagation(); if (state.selMode) { clickRow(e, n, i); return; } if (n.kind === "note") { state.sel = i; open(n.id); return; } actDone(n.id, !n.done); };
      const txt = li.lastChild;
      txt.firstChild.textContent = (n.pinned ? "📌 " : "") + (n.title || "（空のメモ）");
      const due = dueLabel(n);
      const m = txt.lastChild;
      if (due) {
        const s = document.createElement("span");
        s.className = "due" + (due.startsWith("⚠") ? " late" : "");
        s.textContent = due;
        m.append(s, " ");
      }
      // 日付は年つき（26/10/11）。作成日の順のときは作成日。マウスを乗せると、作成・更新の日時が全部出る
      m.append((state.sortMode.startsWith("created") ? "作成 " + fmtDate(n.created) : n.abandoned ? "🚫中止 " + fmtDate(n.cancelled || n.updated) : n.done && n.completed ? "✓完了 " + fmtDate(n.completed) : fmtDate(n.updated)) + (n.tags.length ? "  " : ""));
      li.title = `作成 ${fmt(n.created)}\n更新 ${fmt(n.updated)}` + (n.abandoned ? `\n中止 ${fmt(n.cancelled || n.updated)}` : n.done && n.completed ? `\n完了 ${fmt(n.completed)}` : "");
      if (n.list && !state.list) { // リストを選んでいない一覧では、どのリストか見せる
        const lc = document.createElement("span");
        lc.className = "listchip";
        lc.textContent = "📋" + n.list;
        m.append(lc, " ");
      }
      for (const t of n.tags) {
        const chip = document.createElement("span");
        chip.className = "tagchip";
        chip.textContent = "#" + t;
        const c = tagColor(t);
        if (c) chip.style.cssText = `background:${c}33;color:${c};border-color:${c}66`;
        m.append(chip, " ");
      }
      li.onclick = (e) => clickRow(e, n, i);
      return [...heads, li];
    })
  );
  paintSel();
  const el = listEl.querySelector(".sel");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function moveSel(d) {
  if (!state.notes.length) return;
  state.sel = Math.max(0, Math.min(state.notes.length - 1, state.sel + d));
  render();
}

// ---------- 編集・保存 ----------
let saveTimer = null, saving = Promise.resolve();

function setStatus(s) { if (state.batch) return; statusEl.textContent = s; }

function onInput() {
  state.dirty = true;
  setStatus("未保存…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 800);
}

function flush() {
  clearTimeout(saveTimer);
  saving = saving.then(doSave).catch((e) => setStatus("保存失敗: " + e.message));
  return saving;
}

// 端末に書く（即時・同期処理）。サーバーへは D が裏で送る（オフラインなら送信待ちに溜まる）
function saveLocal() {
  if (!state.dirty) return false;
  const body = ed.value;
  state.dirty = false;
  if (!state.cur) {
    if (!body.trim()) { setStatus(""); return false; }
    const kind = state.newDue ? "task" : state.newKind || "task"; // カレンダーの日から作ったメモ（日付つき）は、タスク
    state.cur = D.create(body, state.newDue || "", (state.list && orderedLists().some((l) => l.name === state.list) ? state.list : "") || (kind === "note" ? state.listRoutes.note || "" : ""), kind).id;
    state.newKind = "";
    if (state.newDue && state.newTime) D.setDue(state.cur, `${state.newDue}T${state.newTime}`); // 時刻つきの期日
    state.newDue = "";
    state.newTime = "";
  } else {
    D.save(state.cur, body);
  }
  const filed = autoFile(state.cur); // 本文のタグなどが、フィルターのルールに当てはまれば、リストへ（リスト未設定のメモだけ）
  if (ed.value !== body) state.dirty = true; // 念のため（同期処理なので通常は起きない）
  else setStatus("保存済み" + filed);
  return true;
}

async function doSave() {
  if (saveLocal()) await refresh();
}

async function open(id, focus = true) {
  await flush();
  const n = D.get(id);
  if (!n) return;
  state.cur = id;
  ed.value = n.body;
  state.dirty = false;
  syncDueUI(n);
  document.body.classList.remove("noedit");
  setStatus(`作成 ${fmt(n.created)} / 更新 ${fmt(n.updated)}` + (n.abandoned ? ` / 中止 ${fmt(n.cancelled || n.updated)}` : n.done && n.completed ? ` / 完了 ${fmt(n.completed)}` : ""));
  if (focus) document.body.classList.add("editing");
  togglePreview(true, focus); // メモは整形表示で開く（編集は e / クリック / Alt+P）
  render();
}

// 新規メモの種類: 「ノート」の一覧 → ノート / 選んでいるリストに既定があればそれ / それ以外はタスク
// 新規メモの種類（`n`・＋ボタン・共有）。選んだリストがあれば、そのリストの設定（無ければタスク）。
// リストを選んでいない「すべて」などでは、**ノート**（書く時は仕分けしない。日付を付けると、タスクになる）。日付を扱う画面（今日・次の7日間・期限切れ・カレンダー）だけ、タスク
function defaultKind() {
  if (state.list) return (state.listToNote.includes(state.list) ? "note" : state.listKinds[state.list]) || "task";
  if (["today", "week", "overdue", "calendar", "bigcal"].includes(state.view)) return "task";
  return "note";
}
async function newNote(kind, due = "") {
  await flush();
  state.newKind = kind === "note" || kind === "task" ? kind : defaultKind();
  if (!due && state.view === "today") due = todayStr(); // 「今日」の一覧で作るメモは、今日の期日（作った途端に一覧から消えないように）
  if (!due && state.view === "calendar" && state.day) due = state.day; // カレンダーで選んでいる日
  state.newDue = due; // 期日つきで作るとき（前の、書きかけの日付は引き継がない）
  state.newTime = "";
  state.cur = null;
  ed.value = "";
  state.dirty = false;
  syncDueUI(null);
  dueEl.value = due;
  resetView();
  document.body.classList.remove("noedit");
  document.body.classList.add("editing");
  setStatus(state.newKind === "task" ? "新規タスク" : "新規ノート（日付を付けると、タスクになります）");
  render();
  togglePreview(true, false); // 新しいメモも、整形表示で始める（最初の行が、そのまま書ける状態）
  beginEdit(blockEls()[0], "start");
}

async function trashNote() {
  if (!state.cur) return;
  await flush();
  D.remove(state.cur);
  state.cur = null;
  ed.value = "";
  document.body.classList.add("noedit");
  document.body.classList.remove("editing");
  setStatus("ゴミ箱へ移しました");
  await refresh();
}

ed.addEventListener("input", () => { onInput(); updateSuggest(); });
// 画面を閉じる・隠す直前に、入力中の分を端末へ書き切る（IndexedDBへの書き込みも急ぐ）
const saveBeforeLeave = () => { clearTimeout(saveTimer); saveLocal(); D.persistNow(); };
window.addEventListener("beforeunload", saveBeforeLeave);
window.addEventListener("pagehide", saveBeforeLeave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveBeforeLeave(); else if (D.status && D.status.lastSync) maybeDaily(); }); // 日をまたいで開きっぱなしのとき、戻ってきたら、その日の分を行う

// ---------- タグ候補 ----------
let composing = false, sugItems = [], sugIdx = 0, sugRange = null;

ed.addEventListener("compositionstart", () => { composing = true; hideSuggest(); });
ed.addEventListener("compositionend", () => { composing = false; updateSuggest(); });
ed.addEventListener("click", updateSuggest);
ed.addEventListener("keyup", (e) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateSuggest();
});
ed.addEventListener("blur", () => setTimeout(hideSuggest, 120));

function hideSuggest() { sug.hidden = true; sugItems = []; sugRange = null; }

function updateSuggest() {
  if (composing) return;
  const el = inputEl();
  const pos = el.selectionStart;
  if (pos !== el.selectionEnd) return hideSuggest();
  const before = el.value.slice(0, pos);
  const m = before.match(/(?:^|\s)#([^\s#]*)$/);
  if (!m) return hideSuggest();
  const part = m[1].toLowerCase();
  const start = pos - m[1].length - 1; // "#"の位置
  // 自分自身がまだ入力途中のタグ（このメモだけが使っている）は候補から外す
  const mine = new Set((state.notes.find((n) => n.id === state.cur) || { tags: [] }).tags);
  sugItems = state.tags
    .filter((t) => t.real && !(t.count === 1 && mine.has(t.tag)))
    .filter((t) => t.tag.toLowerCase().includes(part) && t.tag.toLowerCase() !== part)
    .sort((a, b) => (b.tag.toLowerCase().startsWith(part) - a.tag.toLowerCase().startsWith(part)) || b.count - a.count)
    .slice(0, 8);
  if (!sugItems.length) return hideSuggest();
  sugRange = [start, pos];
  sugIdx = 0;
  drawSuggest();
  if (el === ed) {
    const c = caretXY(start);
    sug.style.left = Math.min(c.x, ed.clientWidth - 180) + "px";
    sug.style.top = c.y + "px";
  } else { // 段落の入力欄: その真下に出す
    const r = el.getBoundingClientRect(), w = $("wrap").getBoundingClientRect();
    sug.style.left = Math.max(0, Math.min(r.left - w.left + 12, w.width - 190)) + "px";
    sug.style.top = r.bottom - w.top + 2 + "px";
  }
  sug.hidden = false;
}

function drawSuggest() {
  sug.replaceChildren(
    ...sugItems.map((t, i) => {
      const d = document.createElement("div");
      d.className = i === sugIdx ? "sel" : "";
      d.innerHTML = "<span></span><small></small>";
      d.firstChild.textContent = "#" + t.tag;
      d.lastChild.textContent = t.count;
      d.onmousedown = (e) => { e.preventDefault(); acceptSuggest(i); };
      return d;
    })
  );
}

function acceptSuggest(i) {
  const t = sugItems[i];
  if (!t || !sugRange) return;
  const [s, e] = sugRange;
  const el = inputEl();
  const rest = el.value.slice(e);
  const ins = "#" + t.tag + (/^\s/.test(rest) ? "" : " ");
  el.setRangeText(ins, s, e, "end");
  hideSuggest();
  if (el === ed) onInput(); else { syncFromTa(); autosize(el); }
}

// textareaのキャレット位置（px）を、同じ見た目の隠しdivで測る
function caretXY(index) {
  const cs = getComputedStyle(ed);
  const div = document.createElement("div");
  for (const p of ["fontFamily", "fontSize", "lineHeight", "letterSpacing", "paddingTop",
    "paddingLeft", "paddingRight", "paddingBottom", "borderLeftWidth", "tabSize"]) div.style[p] = cs[p];
  Object.assign(div.style, {
    position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap",
    overflowWrap: "break-word", width: ed.clientWidth + "px", top: "0", left: "0",
  });
  div.textContent = ed.value.slice(0, index);
  const mark = document.createElement("span");
  mark.textContent = "​";
  div.appendChild(mark);
  $("wrap").appendChild(div);
  const x = mark.offsetLeft, y = mark.offsetTop - ed.scrollTop + mark.offsetHeight;
  div.remove();
  return { x, y };
}

// ---------- 履歴 ----------
const histEl = $("hist"), histList = $("hist-list"), histView = $("hist-view");
let hist = [], histSel = 0, histBody = null;

async function openHistory() {
  if (!state.cur) return;
  await flush();
  // 履歴はサーバー（gitの記録）にあるので、オンラインで、サーバーに送信済みのメモだけ見られる
  try {
    if (!navigator.onLine) throw new Error("offline");
    hist = await api("GET", `/api/notes/${state.cur}/history`);
  } catch {
    setStatus("履歴は、オンラインで、サーバーに送信済みのメモだけ見られます");
    return;
  }
  histSel = 0;
  histEl.hidden = false;
  drawHistory();
}

function drawHistory() {
  if (!hist.length) {
    histList.innerHTML = "<li>まだ履歴がありません（保存の数秒後に記録されます）</li>";
    histView.textContent = "";
    histBody = null;
    return;
  }
  histList.replaceChildren(
    ...hist.map((h, i) => {
      const li = document.createElement("li");
      li.className = i === histSel ? "sel" : "";
      li.textContent = fmt(h.date) + "  " + h.sha.slice(0, 7);
      li.onclick = () => { histSel = i; drawHistory(); };
      return li;
    })
  );
  const seq = (drawHistory.seq = (drawHistory.seq || 0) + 1);
  api("GET", `/api/notes/${state.cur}/history/${hist[histSel].sha}`).then((v) => {
    if (seq !== drawHistory.seq) return;
    histBody = v.body;
    histView.textContent = v.body;
  });
}

function closeHistory() {
  histEl.hidden = true;
  if (document.body.classList.contains("previewing")) previewEl.focus(); else ed.focus();
}

function restoreHistory() {
  if (histBody == null) return;
  ed.value = histBody;
  onInput();
  histEl.hidden = true;
  if (document.body.classList.contains("previewing")) togglePreview(true); // 戻した本文で整形表示を作り直す
  else ed.focus();
}

// ---------- コマンドパレット ----------
const palEl = $("palette"), palInput = $("pal-input"), palList = $("pal-list");
let palItems = [], palSel = 0;

const commands = () => [
  { label: "新規メモ", key: "Alt+N", run: newNote },
  { label: "履歴を見る", key: "Alt+H", run: openHistory },
  { label: "整形表示 ⇄ 編集", key: "Alt+P", run: () => togglePreview() },
  { label: "通知の設定（この端末）", key: "", run: () => { $("notify").hidden = false; renderNotify(); } },
  { label: "リンクにタイトルを付ける（開いているメモ）", key: "", run: () => state.cur && actLinkTitles(state.cur) },
  { label: "一覧のグループ表示 ⇄ なし（タグごと）", key: "g", run: toggleGroupBy },
  { label: "優先度: 高（開いているメモ）", key: "", run: () => state.cur && actPrio(state.cur, 5) },
  { label: "優先度: 中（開いているメモ）", key: "", run: () => state.cur && actPrio(state.cur, 3) },
  { label: "優先度: 低（開いているメモ）", key: "", run: () => state.cur && actPrio(state.cur, 1) },
  { label: "優先度: なし（開いているメモ）", key: "", run: () => state.cur && actPrio(state.cur, 0) },
  { label: "期日: 今日", key: "", run: () => setDue(addDays(0)) },
  { label: "期日: 明日", key: "", run: () => setDue(addDays(1)) },
  { label: "期日: 1週間後", key: "", run: () => setDue(addDays(7)) },
  { label: "期日を入力（日付欄へ）", key: "Alt+D", run: () => dueEl.focus() },
  { label: "期日を消す", key: "", run: () => setDue("") },
  { label: "完了にする ⇄ 戻す（開いているメモ）", key: "x", run: () => { const n = state.cur && D.get(state.cur); if (n) actDone(n.id, !n.done); } },
  { label: "メモのメニューを開く（右クリックと同じ）", key: ".", run: () => { if (state.cur) menuAtSelection(state.cur); } },
  { label: "ゴミ箱へ移す", key: "Alt+Backspace", run: trashNote },
  { label: "検索へ移動", key: "/", run: () => searchEl.focus() },
  { label: "タグの絞り込みを解除", key: "", run: () => setView(state.view) },
  ...SORT_MODES.map(([k, label]) => ({ label: "並び順: " + label, key: "", run: () => setSortMode(k) })),
  ...VIEWS.map(([v, , l]) => ({ label: "表示: " + l, key: { all: "a", today: "t", calendar: "c" }[v] || "", run: () => setView(v) })),
  { label: "使い方（ヘルプ・ショートカット）", key: "?", run: () => openHelp() },
];

function openPalette() {
  palEl.hidden = false;
  palInput.value = "";
  buildPalette();
  palInput.focus();
}
function closePalette() { palEl.hidden = true; }

function buildPalette() {
  const q = palInput.value.trim().toLowerCase();
  const cmds = commands().filter((c) => c.label.toLowerCase().includes(q));
  const tagItems = state.tags
    .filter((t) => q && t.tag.toLowerCase().includes(q.replace(/^#/, "")))
    .map((t) => ({ label: "#" + t.tag + " で絞り込む", key: t.count + "件", run: () => setView("all", t.tag) }));
  const notes = state.notes
    .filter((n) => !q || (n.title + " " + n.tags.join(" ")).toLowerCase().includes(q))
    .slice(0, q ? 20 : 8)
    .map((n) => ({ label: n.title || "（空のメモ）", key: fmt(n.updated), run: () => { state.sel = state.notes.indexOf(n); return open(n.id); } }));
  palItems = [...cmds, ...tagItems, ...notes];
  palSel = 0;
  drawPalette();
}

function drawPalette() {
  palList.replaceChildren(
    ...palItems.map((it, i) => {
      const li = document.createElement("li");
      li.className = i === palSel ? "sel" : "";
      li.innerHTML = "<span></span><small></small>";
      li.firstChild.textContent = it.label;
      li.lastChild.textContent = it.key;
      li.onclick = () => runPalette(i);
      return li;
    })
  );
  const el = palList.querySelector(".sel");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function runPalette(i) {
  const it = palItems[i];
  closePalette();
  if (it) it.run();
}

palInput.addEventListener("input", buildPalette);
palInput.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "ArrowDown") { palSel = Math.min(palItems.length - 1, palSel + 1); drawPalette(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { palSel = Math.max(0, palSel - 1); drawPalette(); e.preventDefault(); }
  else if (e.key === "Enter") { runPalette(palSel); e.preventDefault(); }
  else if (e.key === "Escape") closePalette();
});
palEl.addEventListener("mousedown", (e) => { if (e.target === palEl) closePalette(); });
histEl.addEventListener("mousedown", (e) => { if (e.target === histEl) closeHistory(); });
// 使い方（help.html。使い方.md から tools/build_help.py で作る）。端末に保存されるので、オフラインでも読める
let helpLoaded = false;
async function openHelp() {
  document.body.classList.remove("navopen");
  $("help").hidden = false;
  $("help-body").scrollTop = 0;
  if (helpLoaded) return;
  try {
    const r = await fetch("/help.html");
    if (!r.ok) throw new Error(r.status);
    $("help-body").innerHTML = await r.text();
    helpLoaded = true;
  } catch {
    $("help-body").textContent = "使い方を読み込めませんでした（オンラインになってから、もう一度開いてください）";
  }
}
$("nav-help").onclick = openHelp;
$("help-close").onclick = () => { $("help").hidden = true; };
$("help").addEventListener("mousedown", (e) => { if (e.target === $("help")) $("help").hidden = true; });

// ---------- 検索 ----------
let searchTimer;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = searchEl.value; state.sel = 0; refresh(); }, 150);
});
searchEl.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "ArrowDown") { moveSel(1); e.preventDefault(); }
  else if (e.key === "ArrowUp") { moveSel(-1); e.preventDefault(); }
  else if (e.key === "Enter") {
    const n = state.notes[state.sel];
    if (n) open(n.id);
    e.preventDefault();
  } else if (e.key === "Escape") {
    if (searchEl.value) { searchEl.value = ""; state.q = ""; refresh(); }
    else searchEl.blur();
  }
});

$("showdone").addEventListener("change", (e) => { state.showDone = e.target.checked; state.sel = 0; refresh(); });

// ---------- 全体のキー操作 ----------
$("btn-new").onclick = () => newNote();
$("btn-add").onclick = () => newNote(); // PC の、一覧の上の大きな「＋」（スマホは、右下の丸い＋）
$("fab").onclick = newNote;
$("btn-nav").onclick = (e) => { e.stopPropagation(); document.body.classList.toggle("navopen"); };
$("btn-back").onclick = () => { flush(); document.body.classList.remove("editing"); render(); };
// メニューの外をタップしたら閉じる
document.addEventListener("click", (e) => {
  if (document.body.classList.contains("navopen") && !e.target.closest("#nav")) document.body.classList.remove("navopen");
});
$("btn-history").onclick = openHistory;

// ---------- スマホの「戻る」ボタン（Android）: アプリの外へ出ず、いまの画面を1つ閉じる ----------
// 一番上の層（拡大画像 → メニュー → 各ダイアログ → 選択モード → ☰メニュー → 開いているメモ → 絞り込み）を1つだけ閉じる。閉じたものがあれば true
function backStep() {
  if ($("fedit")) { $("fedit").remove(); return true; } // フィルターの編集画面
  if (!lightbox.hidden) { lightbox.hidden = true; return true; }
  if (menu) { closeMenu(); return true; }
  if (!$("notify").hidden) { $("notify").hidden = true; return true; }
  if (!trashEl.hidden) { closeTrashDetail(); return true; }
  if (!histEl.hidden) { closeHistory(); return true; }
  if (!$("help").hidden) { $("help").hidden = true; return true; }
  if (!palEl.hidden) { closePalette(); return true; }
  if (state.selMode || state.selIds.size) { exitSel(); return true; }
  const cl = document.body.classList;
  if (cl.contains("navopen")) { cl.remove("navopen"); return true; }
  if (cl.contains("bigopen")) { $("bc-close").click(); return true; } // 月カレンダー（大）で開いているメモ
  if (cl.contains("editing")) { $("btn-back").click(); return true; } // メモ → 一覧
  if (state.q || state.tag || state.list || state.inbox || state.filter || state.view !== "all") { // 絞り込み・別の画面 → 「すべて」
    state.q = ""; searchEl.value = "";
    setView("all");
    return true;
  }
  return false;
}
// 履歴に「見張りの1段」を積んでおき、戻るボタンで1段戻ったら、画面を1つ閉じて、また積み直す。何も閉じるものが無い（一覧の一番上）ときだけ、本当に戻る（アプリを抜ける）。
// タッチ端末だけ（PC のブラウザの「戻る」は、いままでどおり）
if (matchMedia("(pointer: coarse)").matches) {
  const arm = () => { try { history.pushState({ tc: "s" }, ""); } catch { /* 履歴に積めなくても、アプリは動く */ } };
  if (!(history.state && history.state.tc)) { try { history.replaceState({ tc: "b" }, ""); } catch { /* 同上 */ } arm(); }
  window.addEventListener("popstate", () => {
    if (backStep()) { arm(); return; }
    history.back();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (!lightbox.hidden) { lightbox.hidden = true; e.preventDefault(); return; }
  if (!$("notify").hidden) { if (e.key === "Escape") $("notify").hidden = true; return; }
  if (!trashEl.hidden) { if (e.key === "Escape") closeTrashDetail(); return; }
  if (menu) { menuKey(e); return; }
  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
    const id = keyTargetId();
    if (id) { menuAtSelection(id); e.preventDefault(); }
    return;
  }

  if (!histEl.hidden) {
    if (e.key === "ArrowDown") { histSel = Math.min(hist.length - 1, histSel + 1); drawHistory(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { histSel = Math.max(0, histSel - 1); drawHistory(); e.preventDefault(); }
    else if (e.key === "Enter") { restoreHistory(); e.preventDefault(); }
    else if (e.key === "Escape") closeHistory();
    return;
  }
  if (!$("help").hidden) { $("help").hidden = true; e.preventDefault(); return; }
  if (!palEl.hidden) return; // パレット自身の入力欄が処理する

  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === "k") { openPalette(); e.preventDefault(); return; }
  if (e.ctrlKey && k === "s") { flush(); e.preventDefault(); return; }
  if (e.altKey && k === "n") { newNote(e.shiftKey ? "note" : undefined); e.preventDefault(); return; }
  if (e.altKey && k === "t") { newNote("task"); e.preventDefault(); return; } // はっきりタスクで作る
  if (e.altKey && k === "h") { openHistory(); e.preventDefault(); return; }
  if (e.altKey && k === "p") { togglePreview(); e.preventDefault(); return; }
  if (e.altKey && k === "d") { dueEl.focus(); e.preventDefault(); return; }
  if (e.key === "Escape" && document.body.classList.contains("previewing") && document.activeElement !== dueEl) {
    // 整形表示からの Esc は、一覧へ戻る
    previewEl.blur();
    document.body.classList.remove("editing");
    render();
    e.preventDefault();
    return;
  }
  if (e.altKey && e.key === "Backspace") { trashNote(); e.preventDefault(); return; }

  // タグ候補が開いているとき
  if (!sug.hidden && document.activeElement === ed) {
    if (e.key === "ArrowDown") { sugIdx = (sugIdx + 1) % sugItems.length; drawSuggest(); e.preventDefault(); return; }
    if (e.key === "ArrowUp") { sugIdx = (sugIdx - 1 + sugItems.length) % sugItems.length; drawSuggest(); e.preventDefault(); return; }
    if (e.key === "Enter" || e.key === "Tab") { acceptSuggest(sugIdx); e.preventDefault(); return; }
    if (e.key === "Escape") { hideSuggest(); e.preventDefault(); return; }
  }

  const inField = ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName);
  if (e.key === "Escape" && (state.selIds.size || state.selMode) && !inField && document.activeElement !== previewEl) { clearSel(); e.preventDefault(); return; } // 複数選択をやめる
  if ((e.ctrlKey || e.metaKey) && k === "z" && !inField && undoStack.length) { undoLast(); e.preventDefault(); return; } // まとめて操作を元に戻す
  if (e.key === "Escape" && document.activeElement === ed) {
    flush();
    if (state.cur && ed.value.trim()) { togglePreview(true); return; } // 編集 → 整形表示
    ed.blur();
    document.body.classList.remove("editing");
    render();
    return;
  }
  if (inField) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+C / Ctrl+X / Ctrl+A などは、一文字ショートカット（c=カレンダー・x=完了・a=すべて）と取り違えない
  // 整形表示中の e / Enter → 編集
  if (document.body.classList.contains("previewing") && state.cur) {
    if (e.key === "e") { togglePreview(false); e.preventDefault(); return; } // e → ソース編集（全文を文字だけで）
    if (e.key === "Enter" && document.activeElement === previewEl) { beginEdit(blockEls().find((b) => !b.classList.contains("blank")) || blockEls()[0], "end"); e.preventDefault(); return; }
  }

  // 一覧にいるとき（編集中でない）
  if (e.key === "/") { searchEl.focus(); e.preventDefault(); }
  else if (e.key === "?") { openHelp(); e.preventDefault(); }
  else if (e.key === "j" || e.key === "ArrowDown") { moveSel(1); e.preventDefault(); }
  else if (e.key === "k" || e.key === "ArrowUp") { moveSel(-1); e.preventDefault(); }
  else if (e.key === "n") { newNote(); e.preventDefault(); }
  else if (e.key === "N") { newNote("note"); e.preventDefault(); }
  else if (e.key === "x" && state.selIds.size > 1) { bulkDone(selectedIds()); e.preventDefault(); }
  else if (e.key === "x") {
    const id = keyTargetId();
    const n = id && D.get(id);
    if (n) actDone(id, !n.done);
    e.preventDefault();
  } else if (e.key === "g") {
    toggleGroupBy();
    e.preventDefault();
  } else if (e.key === "p") {
    const id = keyTargetId();
    const n = id && D.get(id);
    if (n) actPin(id, !n.pinned);
    e.preventDefault();
  } else if (e.key === ".") {
    const id = keyTargetId();
    if (id) menuAtSelection(id);
    e.preventDefault();
  }
  else if (e.key === "t") { setView("today"); e.preventDefault(); }
  else if (e.key === "a") { setView("all"); e.preventDefault(); }
  else if (e.key === "c") { setView("calendar"); e.preventDefault(); }
  else if (e.key === "[" && state.view === "bigcal") { shiftBig(-1); e.preventDefault(); }
  else if (e.key === "]" && state.view === "bigcal") { shiftBig(1); e.preventDefault(); }
  else if (e.key === "[" && state.view === "calendar") { shiftMonth(-1); e.preventDefault(); }
  else if (e.key === "]" && state.view === "calendar") { shiftMonth(1); e.preventDefault(); }
  else if (e.key === "Enter") {
    const n = state.notes[state.sel];
    if (n) open(n.id);
    e.preventDefault();
  }
});

// ---------- 整形表示（画像・リンク）と添付 ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const OK_URL = /^(https?:\/\/|attachments\/)/;
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function inline(s) {
  // s はエスケープ済み。`code` の中は加工しない
  return s.split(/(`[^`]+`)/).map((part, i) => {
    if (i % 2) return "<code>" + part.slice(1, -1) + "</code>";
    return part
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
        if (!OK_URL.test(url)) return m;
        // 画像でない拡張子（PDFなど）は、画像ではなくリンクにする
        if (url.startsWith("attachments/") && !IMG_EXT.test(decodeURIComponent(url)))
          return `<a href="${url}" target="_blank" rel="noopener">📎 ${alt || decodeURIComponent(url.split("/").pop())}</a>`;
        return `<img loading="lazy" alt="${alt}" src="${url}">`;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, url) =>
        OK_URL.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${t}</a>` : m)
      .replace(/(^|[\s>])(https?:\/\/[^\s<"]+)/g, (m, pre, url) =>
        `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      .replace(/(^|\s)#([^\s#\[\]()<]+)/g, '$1<span class="tg">#$2</span>');
  }).join("");
}

// 1行（コードブロックは、まとまり）ごとを「段落」とし、元の行番号を data-l / data-e に持たせる。
// base は、行番号の始まり（段落の一部だけを描き直すとき用）
function renderMd(src, base = 0) {
  const out = [];
  let code = null, codeStart = 0;
  const lines = src.replace(/\r/g, "").split("\n");
  const wrap = (l, e, cls, html) => `<div class="blk${cls ? " " + cls : ""}" data-l="${base + l}" data-e="${base + e}">${html}</div>`;
  const pre = () => "<pre><code>" + esc(code.join("\n")) + "</code></pre>";
  lines.forEach((raw, i) => {
    if (/^(```|~~~)/.test(raw)) {
      if (code === null) { code = []; codeStart = i; } else { out.push(wrap(codeStart, i, "", pre())); code = null; }
      return;
    }
    if (code !== null) { code.push(raw); return; }
    const line = esc(raw);
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) out.push(wrap(i, i, "", `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`));
    else if ((m = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s?(.*)$/))) {
      const done = m[2] !== " ";
      out.push(wrap(i, i, "", `<div class="li" style="margin-left:${m[1].length * 8}px"><span class="chk" title="クリックで切り替え">${done ? "☑" : "☐"}</span><span class="${done ? "done-t" : ""}">${inline(m[3])}</span></div>`));
    } else if ((m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)))
      out.push(wrap(i, i, "", `<div class="li" style="margin-left:${m[1].length * 8}px">${/\d/.test(m[2]) ? m[2] : "・"} ${inline(m[3])}</div>`));
    else if ((m = line.match(/^&gt;\s?(.*)$/))) out.push(wrap(i, i, "", `<blockquote>${inline(m[1])}</blockquote>`));
    else if (!line.trim()) out.push(wrap(i, i, "blank", '<div class="sp"></div>'));
    else out.push(wrap(i, i, "", `<p>${inline(line)}</p>`));
  });
  if (code !== null) out.push(wrap(codeStart, lines.length - 1, "", pre())); // 閉じていないコードブロック
  return out.join("");
}

const previewEl = $("preview"), galleryEl = $("gallery"), lightbox = $("lightbox");

const SUG_MAX = 5; // 本文の日時がこの数以上あるメモには、提案を出さない
// 本文から読み取った日時の提案（期日が未設定・未完了のとき、今日以降でいちばん近いもの）
function dateSuggestion() {
  if (state.curDue || !state.cur) return null;
  const n = D.get(state.cur);
  if (!n || n.done) return null;
  const today = todayStr();
  const texts = (n.dates || []).filter((x) => x[1] === "text");
  if (texts.length >= SUG_MAX) return null; // 日時がやたら多いメモ（メール・ログ・一覧）は、どれが期日か分からないので提案しない
  // 複数日（終わりの日 x[4] つき）は、全日に行がある。開始日の行に直して、終わりの日が今日以降のものを候補にする
  const startOf = (x) => (x[4] ? texts.filter((y) => y[4] === x[4]).map((y) => y[0]).sort()[0] : x[0]);
  const c = texts.filter((x) => (x[4] || x[0]) >= today).map((x) => [startOf(x), x[1], x[4] ? "" : x[2], x[3], x[4]])
    .sort((a, b) => (a[0] + (a[2] || "")).localeCompare(b[0] + (b[2] || "")))[0];
  if (!c) return null;
  const [st, en] = (c[2] || "").split("-");
  const key = c[0] + "T" + (c[2] || "") + (c[4] ? "U" + c[4] : "");
  if ((pref.get("sugDismiss", {}))[state.cur] === key) return null;
  return { d: c[0], t: st || "", end: en || "", kind: c[3] || "", until: c[4] || "", key };
}

function repeatSuggestion() {
  const n = state.cur && D.get(state.cur);
  if (!n || n.done || n.repeat || !n.repeat_sug) return null;
  if ((pref.get("sugDismiss", {}))["r:" + state.cur] === n.repeat_sug) return null;
  return n.repeat_sug;
}

function previewChip() {
  let h = "";
  if (state.curDue) {
    const n = D.get(state.cur);
    const time = n ? dueSpan(n) : state.curTime ? " " + state.curTime : "（終日）";
    h = `<div class="pv-due${state.curDue < todayStr() && !(n && n.event) ? " late" : ""}">${n && n.event ? "🗓 予定" : "📅"} ${n && n.start ? fmtDue(n.start) + "〜" : ""}${fmtDue(state.curDue)}${time}${n && n.repeat ? " ・ 🔁 " + esc(D.ruleLabel(n.repeat)) : ""}`
      + (n ? ` ・ ⏰ ${esc(remindSummary(n))}` : "") + `</div>`;
  }
  const s = dateSuggestion();
  if (s) {
    const ev = s.kind === "event";
    h += `<div class="pv-sug">💡 本文の${ev ? "予定" : s.kind === "deadline" ? "締切" : "日時"}: ${fmtDue(s.d)}${s.until ? "〜" + fmtDue(s.until) : ""} ${s.until ? "" : s.t ? s.t + (s.end ? "〜" + s.end : "") : "（終日）"} `
      + `<button class="sug-apply" type="button">${ev ? "予定にする" : "期日にする"}</button><button class="sug-no" type="button" title="この提案を消す">×</button></div>`;
  }
  const rs = repeatSuggestion();
  if (rs) {
    h += `<div class="pv-sug">💡 本文の繰り返し: ${esc(D.ruleLabel(rs))} `
      + `<button class="rsug-apply" type="button">繰り返しにする</button><button class="rsug-no" type="button" title="この提案を消す">×</button></div>`;
  }
  return `<div id="pvtop">${h}</div>`;
}

async function applyRepeatSuggestion(rule) {
  const id = state.cur;
  await flush();
  const n = D.get(id);
  if (!n) return;
  if (!n.due_set) { // 期日が無ければ、今日以降の最初の回を、期日にする
    const r = D.parseRule(rule);
    const first = r && D.nextAfter(r, addDaysYmd(todayStr(), -1));
    if (first) await setDue(first);
  }
  D.setRepeat(id, rule);
  setStatus(`繰り返しにしました: ${D.ruleLabel(rule)}`);
  await refresh();
  if (document.body.classList.contains("previewing")) togglePreview(true, false);
}
const addDaysYmd = (s, k) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + k); return ymd(d); };

// 提案を、期日（または予定）にする。予定で時刻つきなら、10分前に通知する
async function applySuggestion(s) {
  const id = state.cur;
  await setDue(s.until ? s.until : s.t ? s.d + "T" + s.t : s.d);
  if (s.until) D.setStart(id, s.d); // 複数日: 期日が終わりの日、開始日は s.d
  if (s.kind === "event") {
    D.setEvent(id, s.end || "1");
    if (s.t && !s.until) D.setRemind(id, "-PT10M");
    setStatus(`予定にしました: ${fmtDue(s.d)}${s.until ? "〜" + fmtDue(s.until) : " " + (s.t ? s.t + (s.end ? "〜" + s.end : "") : "（終日）")}${routeList(id, "event")}`);
    await refresh();
    if (document.body.classList.contains("previewing")) togglePreview(true, false);
  } else {
    const r = routeList(id, "deadline");
    if (r) { setStatus(`期日にしました${r}`); await refresh(); }
  }
}

// 同期で本文の日時が変わったときなど、上の帯だけ差し替える
function updateTop() {
  const top = $("pvtop");
  if (!top || blk || previewEl.hidden) return;
  const html = previewChip();
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  if (tmp.firstChild && tmp.firstChild.innerHTML !== top.innerHTML) top.innerHTML = tmp.firstChild.innerHTML;
}

// 整形表示を、本文から作り直す（末尾に、書き足すための余白をつける）
function renderPreview() {
  previewEl.innerHTML = previewChip() + renderMd(ed.value) + '<div class="blk-tail" title="ここをクリックすると、末尾に書き足せます"></div>';
}

function togglePreview(force, focus = true) {
  commitActive(); // 段落の入力中なら、先に確定する
  const on = force ?? !document.body.classList.contains("previewing");
  if (on && document.body.classList.contains("noedit")) return;
  document.body.classList.toggle("previewing", on);
  previewEl.hidden = !on;
  $("btn-preview").textContent = on ? "ソース" : "整形表示";
  $("btn-preview").title = on ? "全文を、ソース（文字だけ）で編集 (Alt+P)" : "整形表示に戻る (Alt+P)";
  if (on) {
    renderPreview();
    galleryEl.hidden = true;
    previewEl.tabIndex = -1;
    if (focus) previewEl.focus();
  } else {
    updateGallery();
    if (focus) ed.focus();
  }
}

// ---------- 段落ごとの編集（整形されたまま入力する） ----------
let blk = null; // 編集中の段落 { ta, el, l, e, origE }。l..e は本文の行番号（0始まり）
const LIST_RE = /^(\s*)([-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+\.\s+|>\s?)/;
const PREFIX_RE = /^(\s*(?:[-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+\.\s+))/; // 本物の部品として見せる、行頭の記号（箇条書き・☐・番号）
const FENCE = /^(```|~~~)/;
const inputEl = () => (blk ? blk.ta : ed); // いま文字を入力している欄（段落の入力欄、またはソース編集）
const srcLines = () => ed.value.split("\n");
const autosize = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };

// ta の内容を、本文の該当行に書き戻す（本文 ed が正本。保存・同期は、いつもの仕組みに任せる）
function syncFromTa() {
  if (!blk) return;
  const taLines = blk.ta.value.split("\n");
  taLines[0] = blk.prefix + taLines[0]; // 隠している先頭の記号を、1行目に戻す
  const lines = srcLines();
  lines.splice(blk.l, blk.e - blk.l + 1, ...taLines);
  blk.e = blk.l + taLines.length - 1;
  ed.value = lines.join("\n");
  onInput();
}

function blockEls() { return [...previewEl.querySelectorAll(".blk")]; }
function blockAtLine(n) { return blockEls().find((b) => +b.dataset.l <= n && n <= +b.dataset.e) || null; }

function beginEdit(el, where = "end") {
  if (!el || !previewEl.contains(el)) return;
  if (blk && blk.el === el) return;
  commitActive();
  if (!el.isConnected) return;
  if (ed.value.includes("\r")) ed.value = ed.value.replace(/\r\n?/g, "\n"); // 行の数え方がずれないよう、改行を\nにそろえる
  const l = +el.dataset.l, e = +el.dataset.e;
  const lines = srcLines();
  while (lines.length <= e) lines.push("");
  const ta = document.createElement("textarea");
  ta.className = "blk-edit";
  ta.rows = 1;
  ta.spellcheck = false;
  const whole = lines.slice(l, e + 1).join("\n");
  // 箇条書き・☐・番号の行は、先頭の記号（- [ ] / - / 1. ）を本物の部品として見せ、入力欄には中身だけを入れる
  const pm = l === e && !FENCE.test(whole) ? whole.match(PREFIX_RE) : null;
  const prefix = pm ? pm[1] : "";
  ta.value = whole.slice(prefix.length);
  el.classList.add("editing");
  blk = { ta, el, l, e, origE: e, prefix, pfx: null };
  if (prefix) {
    const row = document.createElement("div");
    row.className = "li blk-row";
    row.style.marginLeft = prefix.match(/^\s*/)[0].length * 8 + "px";
    const pfx = document.createElement("span");
    pfx.className = "pfx";
    blk.pfx = pfx;
    paintPrefix();
    pfx.addEventListener("mousedown", (ev) => ev.preventDefault()); // 入力欄のフォーカスを外さない
    pfx.addEventListener("click", () => { // ☐ をクリックで切り替え（編集中のまま）
      if (!blk || blk.pfx !== pfx || !/\[[ xX]\]/.test(blk.prefix)) return;
      blk.prefix = blk.prefix.replace(/\[([ xX])\]/, (m0, c) => (c === " " ? "[x]" : "[ ]"));
      paintPrefix();
      syncFromTa();
    });
    row.append(pfx, ta);
    el.replaceChildren(row);
  } else {
    el.replaceChildren(ta);
  }
  wireBlock(ta);
  autosize(ta);
  ta.focus();
  // 数字で位置を渡されたときは、行全体での位置。記号の部分を引いた位置にする
  const pos = where === "start" ? 0 : where === "end" ? ta.value.length : Math.max(0, where - prefix.length);
  ta.setSelectionRange(pos, pos);
}

// 先頭の記号の見た目（☐ ☑ ・ 1.）
function paintPrefix() {
  if (!blk || !blk.pfx) return;
  const p = blk.prefix, c = p.match(/\[([ xX])\]/), n = p.match(/(\d+)\./);
  blk.pfx.textContent = c ? (c[1] === " " ? "☐" : "☑") : n ? n[1] + "." : "・";
  blk.pfx.classList.toggle("chk", !!c);
}

// 段落の編集を確定して、その段落だけを整形表示に戻す（ほかの段落の要素は、そのまま残す）
function commitActive() {
  if (!blk) return;
  const { ta, el, l, origE, prefix } = blk;
  blk = null;
  hideSuggest();
  const text = prefix + ta.value; // 隠していた先頭の記号も含めた、行の全文
  if (!el.isConnected) return;
  const newE = l + text.split("\n").length - 1;
  const delta = newE - origE;
  if (delta) for (const b of blockEls()) { if (+b.dataset.l > origE) { b.dataset.l = +b.dataset.l + delta; b.dataset.e = +b.dataset.e + delta; } }
  const tmp = document.createElement("div");
  tmp.innerHTML = renderMd(text, l);
  el.replaceWith(...tmp.childNodes);
}

// 行を差し替えて、整形表示を作り直し、指定した行を編集状態にする（Enterで分ける・Backspaceでつなぐ等）
function replaceLines(startLine, endLine, newLines, focusRel, caret) {
  blk = null;
  hideSuggest();
  const lines = srcLines();
  lines.splice(startLine, endLine - startLine + 1, ...newLines);
  ed.value = lines.join("\n");
  onInput();
  renderPreview();
  beginEdit(blockAtLine(startLine + focusRel), caret);
}

const nextMarker = (m) => {
  const mk = m[2];
  if (/\[[ xX]\]/.test(mk)) return m[1] + mk.replace(/\[[ xX]\]/, "[ ]");
  const n = mk.match(/^(\d+)\./);
  return m[1] + (n ? `${+n[1] + 1}. ` : mk);
};

function enterKey() {
  const ta = blk.ta, v = ta.value;
  if (FENCE.test(v)) { ta.setRangeText("\n", ta.selectionStart, ta.selectionEnd, "end"); syncFromTa(); autosize(ta); return; } // コードブロックの中は、普通に改行
  const p = ta.selectionStart, q = ta.selectionEnd;
  const before = blk.prefix + v.slice(0, p), after = v.slice(q); // before は、行頭の記号も含めた「カーソルより前」
  const m = before.match(LIST_RE);
  let marker = "";
  if (m) {
    if (!before.slice(m[0].length).trim() && !after.trim()) return replaceLines(blk.l, blk.e, [""], 0, 0); // 空の項目でEnter → 箇条書きを終える
    marker = nextMarker(m);
  }
  replaceLines(blk.l, blk.e, [before, marker + after], 1, marker.length);
}

function wireBlock(ta) {
  ta.addEventListener("input", () => { syncFromTa(); autosize(ta); updateSuggest(); });
  ta.addEventListener("compositionstart", () => { composing = true; hideSuggest(); });
  ta.addEventListener("compositionend", () => { composing = false; updateSuggest(); });
  ta.addEventListener("click", updateSuggest);
  ta.addEventListener("blur", () => setTimeout(() => { // 別の段落などをクリックしたときの、確定（クリックを邪魔しないよう、少し遅らせる）
    if (blk && blk.ta === ta && document.activeElement !== ta) commitActive();
    setTimeout(hideSuggest, 100);
  }, 0));
  ta.addEventListener("paste", (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) { e.preventDefault(); attachFiles(files); return; }
    const txt = ((e.clipboardData && e.clipboardData.getData("text/plain")) || "").trim();
    if (/^https?:\/\/\S+$/.test(txt)) { e.preventDefault(); pasteUrl(txt); }
  });
  // 一部のAndroidのキーボードは、Enterのキー操作を通知せず、改行の入力だけを通知する
  ta.addEventListener("beforeinput", (e) => {
    if ((e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") && !composing && blk && blk.ta === ta) { e.preventDefault(); enterKey(); }
  });
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229 || !blk) return; // 日本語入力の変換中は、何もしない
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    // タグ候補が出ているとき
    if (!sug.hidden) {
      if (e.key === "ArrowDown") { sugIdx = (sugIdx + 1) % sugItems.length; drawSuggest(); e.preventDefault(); return; }
      if (e.key === "ArrowUp") { sugIdx = (sugIdx - 1 + sugItems.length) % sugItems.length; drawSuggest(); e.preventDefault(); return; }
      if (e.key === "Enter" || e.key === "Tab") { acceptSuggest(sugIdx); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === "Escape") { hideSuggest(); e.preventDefault(); e.stopPropagation(); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); commitActive(); previewEl.focus(); return; }
    if (e.key === "Enter" && !e.shiftKey && !mod) { e.preventDefault(); e.stopPropagation(); enterKey(); return; }
    const noSel = ta.selectionStart === ta.selectionEnd;
    if (e.key === "Backspace" && noSel && ta.selectionStart === 0 && blk.prefix && !mod) { // 記号つきの行の行頭 → まず記号だけ外して、普通の文にする
      e.preventDefault(); e.stopPropagation();
      replaceLines(blk.l, blk.e, [ta.value], 0, 0);
      return;
    }
    if (e.key === "Backspace" && noSel && ta.selectionStart === 0 && blk.l > 0 && !mod) { // 行頭のBackspace → 前の行とつなぐ
      const prev = srcLines()[blk.l - 1];
      if (FENCE.test(prev) || FENCE.test(ta.value)) return;
      e.preventDefault(); e.stopPropagation();
      replaceLines(blk.l - 1, blk.e, [prev + ta.value], 0, prev.length);
      return;
    }
    if (e.key === "ArrowUp" && noSel && ta.selectionStart === 0 && !e.shiftKey && !mod) { // 先頭で↑ → 前の段落の末尾へ
      const t = blk.el.previousElementSibling;
      if (t && t.classList.contains("blk")) { e.preventDefault(); e.stopPropagation(); beginEdit(t, "end"); }
      return;
    }
    if (e.key === "ArrowDown" && noSel && ta.selectionStart === ta.value.length && !e.shiftKey && !mod) { // 末尾で↓ → 次の段落の先頭へ
      const t = blk.el.nextElementSibling;
      if (t && t.classList.contains("blk")) { e.preventDefault(); e.stopPropagation(); beginEdit(t, "start"); }
    }
  });
}

// チェックボックスを、クリックで切り替える（編集欄を開かずに）
function toggleCheck(el) {
  commitActive();
  if (ed.value.includes("\r")) ed.value = ed.value.replace(/\r\n?/g, "\n");
  const l = +el.dataset.l;
  const lines = srcLines();
  const m = (lines[l] || "").match(/^(\s*[-*]\s+\[)([ xX])(\])/);
  if (!m) return;
  lines[l] = lines[l].replace(/^(\s*[-*]\s+\[)([ xX])(\])/, `$1${m[2] === " " ? "x" : " "}$3`);
  ed.value = lines.join("\n");
  onInput();
  const tmp = document.createElement("div");
  tmp.innerHTML = renderMd(lines[l], l);
  el.replaceWith(...tmp.childNodes);
}

// 末尾の余白をクリック → 末尾に、新しい行を足して、書き始める
function tailEdit() {
  commitActive();
  if (ed.value.includes("\r")) ed.value = ed.value.replace(/\r\n?/g, "\n");
  const lines = srcLines();
  if ((lines[lines.length - 1] || "").trim() !== "") { lines.push(""); ed.value = lines.join("\n"); onInput(); renderPreview(); }
  const last = blockEls().at(-1);
  beginEdit(last, "start");
}

// ---------- 期日 ----------
const dueEl = $("due");

const timeEl = $("duetime");

// 開いているメモの、期日・時刻・リマインダーの表示を、メモの内容に合わせる
function syncDueUI(n) {
  state.curDue = (n && n.due_set) || "";
  state.curTime = (n && n.due_time) || "";
  state.curRemind = (n && n.remind) || "";
  dueEl.value = state.curDue;
  timeEl.value = state.curTime;
}

const dueSpan = (n) => (n.due_time ? " " + n.due_time + (/^\d\d:\d\d$/.test(n.event) ? "-" + n.event : "") : "（終日）");
const dueText = (n) => (n.due_set ? (n.start ? fmtDue(n.start) + "〜" : "") + fmtDue(n.due_set) + dueSpan(n) + (n.event ? "（予定）" : "") : "");

// v: "YYYY-MM-DD" / "YYYY-MM-DDTHH:MM" / ""
async function setDue(v) {
  await flush();
  if (!state.cur) { // まだ保存していない新規メモ: 日付（と時刻）を覚えておいて、保存するときに付ける
    state.newDue = v.slice(0, 10);
    state.newTime = v.length >= 16 ? v.slice(11, 16) : "";
    dueEl.value = state.newDue;
    timeEl.value = state.newTime;
    setStatus(v ? "期日を選びました（本文を書くと、保存されて、期日が付きます）" : "期日を消しました");
    return;
  }
  const n = D.setDue(state.cur, v);
  if (!n) return;
  syncDueUI(n);
  setStatus(v ? "期日を設定しました: " + dueText(n) : "期日を消しました");
  if (document.body.classList.contains("previewing")) togglePreview(true, false);
  await refresh();
}
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
// 日付欄・時刻欄の変更 → 日付と時刻を合わせて保存。時刻だけ入れたら、日付は今日にする。時刻を空にすれば終日
const fromInputs = () => {
  const day = dueEl.value || (timeEl.value ? todayStr() : "");
  return day ? (timeEl.value ? `${day}T${timeEl.value}` : day) : "";
};
dueEl.addEventListener("change", async () => {
  const id = state.cur;
  await setDue(fromInputs());
  if (dueEl.value) await routeAfterPicker(id); // 日付ピッカーで日付を選んだら、締切・予定の自動振り分けも行う
});
timeEl.addEventListener("change", () => setDue(fromInputs()));
$("due-clear").onclick = () => setDue("");
$("btn-more").onclick = async () => { // 開いているメモのメニュー（右クリック・長押しと同じ。スマホでも、ここから「ゴミ箱へ」などが使える）
  if (!state.cur) { setStatus("まだ保存されていないメモです（何か書くと、保存されます）"); return; }
  await flush();
  const r = $("btn-more").getBoundingClientRect();
  openMenu(noteMenu(state.cur), r.right - 190, r.bottom + 4);
};
$("btn-remind").onclick = async () => { // バーの ⏰ → リマインダーのメニュー（ボタンの下に出す）
  if (!state.cur) return;
  await flush();
  const r = $("btn-remind").getBoundingClientRect();
  openMenu(remindMenu(state.cur), r.left, r.bottom + 4);
};
// 整形表示のクリック: ☐/☑ は切り替え、文字の部分は、その段落だけを編集に、末尾の余白は、書き足し（リンク・画像・文字の範囲選択中は除く）
previewEl.addEventListener("click", (e) => {
  const rg = e.target.closest(".rsug-apply, .rsug-no");
  if (rg) { // 本文の繰り返しの提案: 「繰り返しにする」（期日が無ければ、次の回を期日にする） / 「×」
    const rule = repeatSuggestion();
    if (!rule) return;
    if (rg.classList.contains("rsug-apply")) applyRepeatSuggestion(rule);
    else { const m = pref.get("sugDismiss", {}); m["r:" + state.cur] = rule; pref.set("sugDismiss", m); updateTop(); }
    return;
  }
  const sg = e.target.closest(".sug-apply, .sug-no");
  if (sg) { // 本文の日時の提案: 「期日にする」 / 「×」（この提案だけ、そのメモでは出さない）
    const s = dateSuggestion();
    if (!s) return;
    if (sg.classList.contains("sug-apply")) applySuggestion(s);
    else { const m = pref.get("sugDismiss", {}); m[state.cur] = s.key; pref.set("sugDismiss", m); updateTop(); }
    return;
  }
  if (e.target.closest("a") || e.target.tagName === "IMG") return;
  if (e.target.closest(".blk.editing")) return; // 編集中の行の中のクリックは、行の側で処理する（記号の☐など）
  const chk = e.target.closest(".chk");
  if (chk) { toggleCheck(chk.closest(".blk")); return; }
  if (String(getSelection()).length) return; // 文字を選んで、コピーしようとしているとき
  const b = e.target.closest(".blk");
  if (b) { beginEdit(b, "end"); return; }
  if (e.target.closest(".blk-tail") || e.target === previewEl) tailEdit();
});

// ---- 整形表示での コピー・切り取り・貼り付け（複数行をまたぐとき）----
// 入力中の1行の中は、ブラウザ標準のまま（Ctrl+C/X/V が効く）。整形表示のまま、行をまたいで文字を選んだときは、
// 見た目の文字ではなく、元の Markdown の行（記号つき）をコピー／切り取りする
function selBlocks() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return [];
  const r = sel.getRangeAt(0);
  if (!previewEl.contains(r.commonAncestorContainer)) return [];
  return blockEls().filter((b) => r.intersectsNode(b));
}
const mdOfBlocks = (bs) => srcLines().slice(+bs[0].dataset.l, +bs[bs.length - 1].dataset.e + 1).join("\n");
const inEdit = (e) => !!(e.target.closest && e.target.closest(".blk-edit"));
previewEl.addEventListener("copy", (e) => {
  if (inEdit(e)) return;
  const bs = selBlocks();
  if (bs.length < 2) return; // 1行の中だけの選択は、そのまま
  e.clipboardData.setData("text/plain", mdOfBlocks(bs));
  e.preventDefault();
});
// 切り取り: 整形表示（入力欄ではない）では、ブラウザは「切り取り」の通知を出さないので、Ctrl+X のキーで自分で行う
function cutBlocks() {
  const bs = selBlocks();
  if (bs.length < 2) return false; // 1行の中だけの選択は、行をクリックして入力に入ってから切り取る
  const md = mdOfBlocks(bs);
  const t = document.createElement("textarea"); // クリップボードへ（選択 → コピー）
  t.value = md;
  t.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(t);
  t.select();
  const ok = document.execCommand("copy");
  t.remove();
  if (!ok) { setStatus("切り取れませんでした（コピーが許可されていません）"); return true; }
  const lines = srcLines();
  lines.splice(+bs[0].dataset.l, +bs[bs.length - 1].dataset.e - +bs[0].dataset.l + 1);
  ed.value = lines.join("\n");
  getSelection().removeAllRanges();
  onInput();
  renderPreview();
  previewEl.focus();
  setStatus(`${bs.length}行を切り取りました`);
  return true;
}
previewEl.addEventListener("cut", (e) => { if (!inEdit(e) && selBlocks().length >= 2) e.preventDefault(); });
previewEl.addEventListener("paste", (e) => {
  if (inEdit(e)) return; // 入力中の行は、その行の処理（URLの題名つけ・画像の添付）に任せる
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (files.length) { e.preventDefault(); attachFiles(files); return; }
  const txt = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
  if (!txt.trim()) return;
  e.preventDefault();
  const bs = selBlocks();
  const lines = srcLines();
  const at = bs.length ? +bs[bs.length - 1].dataset.e + 1 : lines.length; // 選んだ行の次、選んでいなければ末尾に、行として足す
  const add = txt.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  lines.splice(at, 0, ...add);
  ed.value = lines.join("\n");
  onInput();
  renderPreview();
  setStatus(`${add.length}行を貼り付けました`);
});
previewEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && !e.altKey && !inEdit(e)) { if (cutBlocks()) e.preventDefault(); return; }
  // Ctrl+A: 整形表示の本文だけを全部選ぶ（ページ全体ではなく）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !inEdit(e)) {
    e.preventDefault();
    const r = document.createRange();
    r.selectNodeContents(previewEl);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
});

// 本文中の添付（attachments/…）を、編集中も下の帯に並べる
function updateGallery() {
  if (document.body.classList.contains("previewing")) return;
  const seen = new Set(), imgs = [], files = [];
  for (const m of ed.value.matchAll(/(!?)\[([^\]]*)\]\((attachments\/[^)\s]+)\)/g)) {
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    const name = decodeURIComponent(m[3].split("/").pop());
    (IMG_EXT.test(name) ? imgs : files).push({ url: m[3], name });
  }
  const nodes = [];
  for (const i of imgs) {
    const im = document.createElement("img");
    im.loading = "lazy"; im.src = i.url; im.alt = i.name; im.title = i.name;
    nodes.push(im);
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = f.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "📎 " + f.name.replace(/^[0-9a-f]{24}_/, "");
    nodes.push(a);
  }
  galleryEl.replaceChildren(...nodes);
  galleryEl.hidden = !nodes.length;
}

function resetView() {
  document.body.classList.remove("previewing");
  previewEl.hidden = true;
  $("btn-preview").textContent = "整形表示";
  updateGallery();
}

function showLightbox(src) { lightbox.firstChild.src = src; lightbox.hidden = false; }
lightbox.addEventListener("click", () => { lightbox.hidden = true; });
for (const el of [previewEl, galleryEl]) {
  el.addEventListener("click", (e) => { if (e.target.tagName === "IMG") showLightbox(e.target.src); });
}
$("btn-preview").onclick = () => togglePreview();

let galleryTimer;
ed.addEventListener("input", () => { clearTimeout(galleryTimer); galleryTimer = setTimeout(updateGallery, 400); });

// ---------- メモの操作（右クリックメニュー・チェック・ショートカットで共通） ----------
// ノートにすると、期日・予定・繰り返しは外れる。あるメモが含まれるときは、先に確かめる（false なら、やめる）
function okNote(ids) {
  const k = ids.filter((id) => { const n = D.get(id); return n && n.kind !== "note" && (n.due_set || n.event || n.repeat); }).length;
  return !k || window.confirm(`${k}件に、期日（予定・繰り返し）が付いています。ノートには日付を持たせないので、日付を外してノートにします。よろしいですか？（「元に戻す」で戻せます）`);
}
async function actKind(id, kind) {
  if (id === state.cur) await flush();
  D.setKind(id, kind);
  const routed = kind === "note" ? routeList(id, "note") : autoFile(id); // ノートにした瞬間、「ノートを自動で入れる」リストへ（リスト未設定のメモだけ）
  setStatus((kind === "task" ? "タスクにしました（完了できます）" : "ノートにしました（完了は付けません）") + routed);
  await refresh();
  if (id === state.cur && document.body.classList.contains("previewing")) togglePreview(true, false);
}
// ---- 振り返り: 完了・中止にしたあとの、ひとこと（ライフログ）。メモの末尾の「## 振り返り」の下に、日付つきの行で残す ----
// 末尾の「## 振り返り」へ、手で書くための行を足す（本体は data.js の addRecapLine。繰り返しの完了・中止の自動の行があれば、その行の続きに書く）
const addRecap = (body, ymdStr) => D.addRecapLine(body, ymdStr, "");
async function writeRecap(id) {
  if (id === state.cur) await flush();
  const n = D.get(id);
  if (!n) return;
  D.save(id, addRecap(n.body, todayStr()));
  recapBar.hidden = true;
  await refresh();
  await open(id, true);
  const bl = blockEls().filter((b) => !b.classList.contains("blank"));
  if (bl.length) beginEdit(bl.at(-1), "end"); // 末尾の「- 日付 」の行に、カーソルを置く
}
// 完了・中止にした直後の、小さな案内（任意。「今後は出さない」で、オフにできる）
const recapBar = Object.assign(document.createElement("div"), { id: "recapbar", hidden: true });
recapBar.innerHTML = '<span id="recapmsg"></span><button id="recapgo" type="button">振り返りを書く</button><button id="recapoff" type="button" title="この案内を、今後は出さない（メモのメニューで、またオンにできます）">今後は出さない</button><button id="recapclose" type="button" title="閉じる">×</button>';
document.body.append(recapBar);
let recapTimer = null, recapId = null;
function offerRecap(id, what) {
  const n = D.get(id);
  if (state.batch || !pref.get("recapPrompt", true) || !n || n.kind === "note") return;
  recapId = id;
  $("recapmsg").textContent = (what === "中止" ? "中止にしました。理由などを、" : "完了しました。") + "振り返りに残しますか？";
  recapBar.hidden = false;
  clearTimeout(recapTimer);
  recapTimer = setTimeout(() => { recapBar.hidden = true; }, 15000);
}
$("recapgo").onclick = () => { if (recapId) writeRecap(recapId); };
$("recapclose").onclick = () => { recapBar.hidden = true; };
$("recapoff").onclick = () => { pref.set("recapPrompt", false); recapBar.hidden = true; setStatus("完了後の「振り返り」の案内を、オフにしました（メモのメニューで、またオンにできます）"); };

// 一段落して次へ: 完了にせず、振り返りへ「- 日付 ✓ 」の行を足して、期日を次の区切りへ進める（1つのタスクを、続いていく流れとして使う）
async function actStep(id, due) {
  if (id === state.cur) await flush();
  const n = D.get(id);
  if (!n || n.kind === "note" || n.done) return;
  const today = todayStr();
  let body = D.addRecapLine(n.body, today, "✓");
  if (body === n.body) body = D.addRecapLine(n.body, today, ""); // 今日の「✓」の行が、すでにある: 新しい行だけ足す
  D.save(id, body);
  D.setDue(id, n.due_time ? `${due}T${n.due_time}` : due);
  recapBar.hidden = true;
  setStatus(`一段落しました。次の期日: ${fmtDue(due)}（続きを振り返りに書けます）`);
  await refresh();
  await open(id, true);
  const bl = blockEls().filter((b) => !b.classList.contains("blank"));
  if (bl.length) beginEdit(bl.at(-1), "end"); // 「- 日付 ✓ 」の続きに、カーソルを置く
}

// 中止（キャンセル）: 予定・タスクを、やらないことにする。メモは残り、完了日（実績）には数えない。繰り返しは「この回をスキップ」
async function actCancel(id, on) {
  const n0 = D.get(id);
  if (!n0) return;
  if (n0.kind === "note") { if (!state.batch) setStatus("ノートは中止にできません（タスクにすると使えます）"); return; }
  if (on && n0.done && !n0.abandoned) { if (!state.batch) setStatus("完了したメモは、先に完了を戻してから、中止にしてください"); return; }
  if (id === state.cur) await flush();
  const rep0 = on && n0.repeat && !n0.done;
  const n = D.setDone(id, on, true);
  if (on && rep0 && n && !n.done) setStatus(`この回を中止にしました（スキップ）。次の回: ${fmtDue(n.due_set)}${n.due_time ? " " + n.due_time : ""}（${D.ruleLabel(n.repeat)}）`);
  else setStatus(on ? "中止にしました（「完了・中止」の一覧に移ります。実績には数えません）" : "中止を戻しました");
  await refresh();
  if (id === state.cur && document.body.classList.contains("previewing")) togglePreview(true, false);
  if (on) offerRecap(id, "中止");
}
async function actDone(id, done) {
  if (D.get(id) && D.get(id).kind === "note") { setStatus("ノートは完了にできません。メニューの「種類」でタスクにすると、完了できます"); return; }
  if (id === state.cur) await flush();
  const rep0 = D.get(id) && D.get(id).repeat && !D.get(id).done;
  const n = D.setDone(id, done);
  if (done && rep0 && n && !n.done) setStatus(`完了しました。次の回: ${fmtDue(n.due_set)}${n.due_time ? " " + n.due_time : ""}（${D.ruleLabel(n.repeat)}）`);
  else setStatus(done ? "完了にしました（「完了・中止」の一覧に移ります）" : "完了を戻しました");
  await refresh();
  if (id === state.cur && document.body.classList.contains("previewing")) togglePreview(true, false);
  if (done) offerRecap(id, "完了");
}

// 繰り返しの設定（メニューの「繰り返し」）
async function actRepeat(id, rule) {
  if (id === state.cur) await flush();
  D.setRepeat(id, rule);
  setStatus(rule ? `繰り返しにしました: ${D.ruleLabel(rule)}（完了すると、次の回に進みます）` : "繰り返しをやめました");
  await refresh();
  if (id === state.cur && document.body.classList.contains("previewing")) togglePreview(true, false);
}
function repeatPresets(n) {
  const wd = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][(new Date(n.due_set + "T00:00:00").getDay() + 6) % 7];
  const day = +n.due_set.slice(8, 10), mon = +n.due_set.slice(5, 7);
  return [
    ["毎日", "FREQ=DAILY"],
    ["平日（月〜金）", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
    [`毎週（${D.ruleLabel("FREQ=WEEKLY;BYDAY=" + wd).replace("毎週 ", "")}曜）`, "FREQ=WEEKLY;BYDAY=" + wd],
    [`隔週（${D.ruleLabel("FREQ=WEEKLY;BYDAY=" + wd).replace("毎週 ", "")}曜）`, `FREQ=WEEKLY;INTERVAL=2;BYDAY=${wd}`],
    [`毎月（${day}日）`, `FREQ=MONTHLY;BYMONTHDAY=${day}`],
    ["毎月末", "FREQ=MONTHLY;BYMONTHDAY=-1"],
    [`毎年（${mon}月${day}日）`, "FREQ=YEARLY"],
  ];
}

async function actEvent(id, v) {
  if (id === state.cur) await flush();
  D.setEvent(id, v);
  setStatus((v ? "予定にしました（過ぎても期限切れにしません）" : "締切に戻しました") + routeList(id, v ? "event" : "deadline"));
  await refresh();
  if (id === state.cur && document.body.classList.contains("previewing")) togglePreview(true, false);
}

async function actPrio(id, p) {
  if (id === state.cur) await flush();
  D.setPriority(id, p);
  setStatus(p ? `優先度を「${PRIO_NAME[p]}」にしました` : "優先度を外しました");
  await refresh();
}

function toggleGroupBy() {
  state.groupBy = state.groupBy === "tag" ? "none" : "tag";
  pref.set("groupBy", state.groupBy);
  setStatus(state.groupBy === "tag" ? "タグごとにグループ表示します" : "グループ表示をやめました");
  refresh();
}

async function actPin(id, pinned) {
  if (id === state.cur) await flush();
  D.setPinned(id, pinned);
  setStatus(pinned ? "ピン留めしました" : "ピン留めを外しました");
  await refresh();
}

// 日付だけを渡されたとき（今日・明日・ドラッグなど）は、メモに時刻があれば、その時刻を保つ
const ymdAdd = (s, k) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + k); return ymd(d); };
const ymdDiff = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 864e5);
async function actDue(id, v) {
  const n0 = D.get(id);
  let newStart = "";
  if (v.length === 10 && n0 && n0.start && n0.due_set) { // 複数日のメモは、選んだ日を「開始日」にして、長さを保ったまま動かす
    newStart = v;
    v = ymdAdd(v, ymdDiff(n0.start, n0.due_set));
  }
  if (v.length === 10 && n0 && n0.due_time) v = `${v}T${n0.due_time}`;
  if (id === state.cur) {
    await setDue(v);
    if (newStart) { D.setStart(id, newStart); await refresh(); if (document.body.classList.contains("previewing")) togglePreview(true, false); }
    return;
  }
  const n = D.setDue(id, v);
  if (newStart) D.setStart(id, newStart);
  setStatus(v && n ? `期日を設定しました: ${dueText(n)}` : "期日を消しました");
  await refresh();
}

// 時刻だけを変える（空 = 終日にする）。期日が無ければ今日にする
async function actDueTime(id, t) {
  const n = D.get(id);
  if (!n) return;
  const day = n.due_set || todayStr();
  const v = t ? `${day}T${t}` : day;
  if (id === state.cur) return setDue(v);
  const m = D.setDue(id, v);
  setStatus(`期日を設定しました: ${m ? dueText(m) : v}`);
  await refresh();
}

// ---- 並び順・手動の並べ替え ----
const SORT_MODES = [
  ["updated", "更新日（新しい順）", "更新日"], ["created", "作成日（新しい順）", "作成日"], ["created_asc", "作成日（古い順）", "作成日↑"],
  ["due", "期日（近い順）", "期日"], ["priority", "優先度（高い順）", "優先度"], ["completed", "完了日（新しい順）", "完了日"], ["title", "題名順", "題名"], ["tag", "タグ順（最初のタグの名前順）", "タグ"], ["manual", "手動（ドラッグ・メニューで並べる）", "手動"],
];
function paintSortBtn() {
  const b = $("btn-sort");
  b.hidden = state.view === "trash";
  if ($("btn-select")) $("btn-select").hidden = state.view === "trash";
  const m = SORT_MODES.find((x) => x[0] === state.sortMode) || SORT_MODES[0];
  b.textContent = `並び: ${m[2]} ▾`;
}
function setSortMode(m) {
  state.sortMode = m;
  pref.set("sortMode", m);
  setStatus(m === "manual" ? "手動の並べ替え: 一覧のメモをドラッグして、好きな位置に置けます（メニューの「並べ替え」でも）" : "並び順を変えました");
  refresh();
}
$("btn-sort").onclick = () => {
  const r = $("btn-sort").getBoundingClientRect();
  openMenu(SORT_MODES.map(([k, label]) => ({ label, icon: state.sortMode === k ? "●" : "○", run: () => setSortMode(k) })), r.left, r.bottom + 2);
};

// v に、メモ id を置く。above / below = 置く位置の、すぐ上・すぐ下のメモ（同じピン留めグループの中）
function placeBetween(id, above, below, rest) {
  const ea = above ? D.sortEff(above) : null, eb = below ? D.sortEff(below) : null;
  let v;
  if (ea !== null && eb !== null) {
    if (eb - ea < 1e-3) { rebalanceOrder(id, above, rest); return; } // 間が狭すぎるときは、並べ直して、振り直す
    v = (ea + eb) / 2;
  } else if (ea !== null) v = ea + 60;
  else if (eb !== null) v = eb - 60;
  else v = 0;
  D.setSort(id, v);
  setStatus("並べ替えました");
  refresh();
}

function rebalanceOrder(id, above, rest) {
  const order = [...rest];
  order.splice(above ? order.findIndex((x) => x.id === above.id) + 1 : 0, 0, D.get(id));
  const base = Math.min(...order.map((n) => D.sortEff(n)));
  order.forEach((n, i) => D.setSort(n.id, base + i * 30));
  setStatus("並べ替えました");
  refresh();
}

// ドラッグで、target の上（after=false）か下（after=true）に置く
function reorderTo(id, targetId, after) {
  const me = D.get(id), target = D.get(targetId);
  if (!me || !target || id === targetId) return;
  if (!!me.pinned !== !!target.pinned) { setStatus("ピン留めのメモと、そうでないメモの間は、並べ替えできません"); return; }
  const rest = state.notes.filter((x) => x.id !== id && !!x.pinned === !!me.pinned);
  const idx = rest.findIndex((x) => x.id === targetId);
  const at = after ? idx + 1 : idx;
  placeBetween(id, rest[at - 1] || null, rest[at] || null, rest);
}

// メニュー用（ドラッグできないスマホ向け）: 先頭へ / 1つ上へ / 1つ下へ / 末尾へ
function moveStep(id, dir) {
  const me = D.get(id);
  if (!me) return;
  const group = state.notes.filter((x) => !!x.pinned === !!me.pinned);
  const i = group.findIndex((x) => x.id === id);
  if (i < 0) { setStatus("このメモは、いまの一覧にありません"); return; }
  const rest = group.filter((x) => x.id !== id);
  const at = { top: 0, bottom: rest.length, up: Math.max(0, i - 1), down: Math.min(rest.length, i + 1) }[dir];
  placeBetween(id, rest[at - 1] || null, rest[at] || null, rest);
}

// ---- リマインダー ----
// 選べる通知の時刻（何分前か）。終日の期日と、時刻つきの期日で、選択肢が違う
function remindOptions(n) {
  if (!n.due_set) return [];
  if (!n.due_time) return [[D.DEFAULT_ALLDAY, "当日の朝9:00"], [900, "前日の朝9:00"], [2340, "2日前の朝9:00"]];
  const tmin = +n.due_time.slice(0, 2) * 60 + +n.due_time.slice(3, 5);
  return [[0, "期日の時刻に"], [5, "5分前"], [10, "10分前"], [30, "30分前"], [60, "1時間前"], [1440, "前日の同じ時刻"], [900 + tmin, "前日の朝9:00"]];
}

async function actRemind(id, raw) {
  if (id === state.cur) await flush();
  const n = D.setRemind(id, raw);
  if (id === state.cur && n) syncDueUI(n);
  if (document.body.classList.contains("previewing") && id === state.cur) togglePreview(true, false);
  setStatus(raw === "" ? "リマインダーを既定に戻しました" : raw === "none" ? "通知しない設定にしました" : "リマインダーを設定しました");
  await refresh();
}

function remindMenu(id) {
  const n = D.get(id);
  if (!n) return [];
  if (!n.due_set) return [{ label: "先に、期日を付けてください", disabled: true }];
  const allday = !n.due_time;
  const cur = D.remindMinutes(n.remind, allday);
  const explicit = !!n.remind;
  const off = explicit && n.remind.trim().toLowerCase() === "none";
  const items = remindOptions(n).map(([b, label]) => ({
    label, icon: !off && cur.includes(b) ? "☑" : "☐",
    run: () => { // 選んだ項目を、入れたり外したりする（外して空になったら「通知しない」）
      const next = cur.includes(b) && !off ? cur.filter((x) => x !== b) : [...(off ? [] : cur), b];
      actRemind(id, D.remindRaw(next));
    },
  }));
  return [
    ...items, { sep: true },
    { label: "通知しない", icon: off ? "●" : "○", run: () => actRemind(id, "none") },
    { label: "既定に戻す（" + (allday ? "当日の朝9:00" : "期日の時刻に") + "）", icon: !explicit ? "●" : "○", run: () => actRemind(id, "") },
  ];
}

function remindSummary(n) {
  if (!n.due_set) return "";
  const allday = !n.due_time;
  const mins = D.remindMinutes(n.remind, allday);
  return mins.length ? mins.map((b) => D.remindLabel(b, allday)).join("、") : "通知しない";
}

async function actTrash(id) {
  if (id === state.cur) return trashNote();
  D.remove(id);
  setStatus("ゴミ箱へ移しました");
  await refresh();
}

// 末尾が「#タグだけの行」ならそこへ足し、そうでなければ空行を挟んで新しい行にする
function addTagToBody(body, tag) {
  const lines = body.replace(/\s+$/, "").split("\n");
  const last = lines[lines.length - 1];
  if (lines.length > 1 && /^\s*#[^\s#]+(\s+#[^\s#]+)*\s*$/.test(last)) lines[lines.length - 1] = last.trimEnd() + " #" + tag;
  else lines.push("", "#" + tag);
  return lines.join("\n") + "\n";
}

async function actTag(id, tag) {
  if (id === state.cur) await flush();
  const n = D.get(id);
  if (!n || n.tags.includes(tag)) return;
  const body = addTagToBody(n.body, tag);
  D.save(id, body);
  const filed = autoFile(id); // タグを付けたことで、フィルターのルールに当てはまれば、リストへ
  if (id === state.cur) {
    ed.value = body;
    if (document.body.classList.contains("previewing")) togglePreview(true, false);
  }
  setStatus(`#${tag} を付けました` + filed);
  await refresh();
}

async function newTagFor(id) {
  await open(id);
  togglePreview(false);
  ed.value = ed.value.replace(/\s+$/, "") + "\n\n#";
  ed.focus();
  ed.setSelectionRange(ed.value.length, ed.value.length);
  onInput();
  updateSuggest();
}

async function actCopy(id, what) {
  const n = D.get(id);
  if (!n) return;
  try {
    await navigator.clipboard.writeText(what === "title" ? n.title : n.body);
    setStatus(what === "title" ? "タイトルをコピーしました" : "本文をコピーしました");
  } catch {
    setStatus("コピーできませんでした");
  }
}

// 「日付を選ぶ…」: 見えない日付欄を出してピッカーを開く
function pickDate(id, pos, then) {
  const inp = document.createElement("input");
  inp.type = "date";
  inp.style.cssText = `position:fixed;left:${pos.x}px;top:${pos.y}px;opacity:0;width:1px;height:1px;border:0;padding:0`;
  document.body.append(inp);
  inp.addEventListener("change", async () => { const v = inp.value; inp.remove(); if (v) { if (then) await then(v); else { await actDue(id, v); await routeAfterPicker(id); } } });
  inp.addEventListener("blur", () => setTimeout(() => inp.remove(), 400));
  inp.focus();
  try { inp.showPicker(); } catch { /* 対応していなければ、そのまま手入力できる */ }
}

// 複数日にする: いまの期日（または開始日）から、選んだ「終わりの日」まで
function pickEnd(id, pos) {
  const inp = document.createElement("input");
  inp.type = "date";
  inp.style.cssText = `position:fixed;left:${pos.x}px;top:${pos.y}px;opacity:0;width:1px;height:1px;border:0;padding:0`;
  document.body.append(inp);
  inp.addEventListener("change", () => { if (inp.value) actSpan(id, inp.value); inp.remove(); });
  inp.addEventListener("blur", () => setTimeout(() => inp.remove(), 400));
  inp.focus();
  try { inp.showPicker(); } catch { /* 対応していなければ、そのまま手入力できる */ }
}
async function actSpan(id, end) {
  const n = D.get(id);
  if (!n || !n.due_set) return;
  if (id === state.cur) await flush();
  if (end === "") {
    D.setStart(id, "");
    setStatus("1日だけに戻しました");
  } else {
    const st = n.start || n.due_set;
    if (end <= st) { setStatus("終わりの日は、開始日（" + fmtDue(st) + "）より後にしてください"); return; }
    D.setDue(id, n.due_time ? `${end}T${n.due_time}` : end);
    D.setStart(id, st);
    setStatus(`複数日にしました: ${fmtDue(st)}〜${fmtDue(end)}`);
  }
  await refresh();
  if (id === state.cur && document.body.classList.contains("previewing")) togglePreview(true, false);
}

function noteMenu(id) {
  const n = D.get(id);
  if (!n) return [];
  const nextMon = nextMonday();
  const dueItem = (label, v) => ({ label, hint: v.slice(5).replace("-", "/"), run: () => actDue(id, v) });
  const tagItems = state.tags.filter((t) => t.real).sort((a, b) => b.count - a.count).slice(0, 12)
    .map((t) => ({ label: "#" + t.tag, hint: String(t.count), disabled: n.tags.includes(t.tag), run: () => actTag(id, t.tag) }));
  return [
    { label: "複数選択を始める（このメモから）", icon: "☑", run: () => startSelMode(id) },
    { sep: true },
    { label: n.abandoned ? "中止を戻す" : n.done ? "完了を戻す" : "完了にする", icon: n.done ? "↩" : "✅", key: "x", disabled: n.kind === "note", run: () => (n.abandoned ? actCancel(id, false) : actDone(id, !n.done)) },
    ...(n.kind === "note" || n.done || n.repeat ? [] : [{ label: "一段落して次へ（完了にしない）", icon: "➡️", sub: [
      { label: "次の期日: 明日", hint: addDays(1).slice(5).replace("-", "/"), run: () => actStep(id, addDays(1)) },
      { label: "次の期日: 来週の月曜", hint: nextMon.slice(5).replace("-", "/"), run: () => actStep(id, nextMon) },
      { label: "次の期日: 1週間後", hint: addDays(7).slice(5).replace("-", "/"), run: () => actStep(id, addDays(7)) },
      { label: "次の期日: 日付を選ぶ…", run: (pos) => pickDate(id, pos, (v) => actStep(id, v)) },
    ] }]),
    ...(n.kind === "note" || n.done ? [] : [{ label: n.repeat ? "この回を中止にする（スキップ）" : "中止にする（キャンセル）", icon: "🚫", run: () => actCancel(id, true) }]),
    { label: n.kind === "note" ? "種類: ノート" : "種類: タスク", icon: n.kind === "note" ? "📝" : "☑", sub: [
      { label: "タスク（完了できる）", icon: n.kind === "task" ? "●" : "○", run: () => actKind(id, "task") },
      { label: "ノート（読み物・資料）", icon: n.kind === "note" ? "●" : "○", run: () => { if (okNote([id])) actKind(id, "note"); } },
    ] },
    { label: n.pinned ? "ピン留めを外す" : "ピン留め", icon: "📌", key: "p", run: () => actPin(id, !n.pinned) },
    { label: "優先度", icon: "🚩", sub: [
      { label: "高", icon: n.priority === 5 ? "●" : "○", color: "#e5484d", run: () => actPrio(id, 5) },
      { label: "中", icon: n.priority === 3 ? "●" : "○", color: "#f76b15", run: () => actPrio(id, 3) },
      { label: "低", icon: n.priority === 1 ? "●" : "○", color: "#3e63dd", run: () => actPrio(id, 1) },
      { sep: true },
      { label: "なし", icon: !n.priority ? "●" : "○", run: () => actPrio(id, 0) },
    ] },
    state.sortMode === "manual"
      ? { label: "並べ替え", icon: "↕", sub: [
        { label: "先頭へ", run: () => moveStep(id, "top") }, { label: "1つ上へ", run: () => moveStep(id, "up") },
        { label: "1つ下へ", run: () => moveStep(id, "down") }, { label: "末尾へ", run: () => moveStep(id, "bottom") },
      ] }
      : { label: "手動で並べ替える", icon: "↕", run: () => setSortMode("manual") },
    { label: "期日", icon: "📅", sub: [
      dueItem("今日", addDays(0)), dueItem("明日", addDays(1)), dueItem("来週の月曜", nextMon), dueItem("1週間後", addDays(7)),
      { label: "日付を選ぶ…", run: (pos) => pickDate(id, pos) }, { sep: true },
      { label: "期日を消す", disabled: !n.due_set, run: () => actDue(id, "") },
    ] },
    { label: n.repeat ? "繰り返し: " + D.ruleLabel(n.repeat) : "繰り返し", icon: "🔁", disabled: !n.due_set, sub: [
      ...(n.due_set ? repeatPresets(n) : []).map(([label, rule]) => ({ label, icon: n.repeat === rule ? "●" : "○", run: () => actRepeat(id, rule) })),
      { sep: true },
      { label: "繰り返さない", disabled: !n.repeat, run: () => actRepeat(id, "") },
    ] },
    { label: n.event ? "締切に戻す（過ぎたら期限切れ）" : "予定にする（過ぎても期限切れにしない）", icon: n.event ? "📅" : "🗓", disabled: !n.due_set, run: () => actEvent(id, n.event ? "" : "1") },
    { label: "複数日（〜まで続く）", icon: "↔", disabled: !n.due_set, sub: [
      { label: "終わりの日を選ぶ…", run: (pos) => pickEnd(id, pos) },
      { label: "1日だけに戻す", disabled: !n.start, run: () => actSpan(id, "") },
    ] },
    { label: "時刻", icon: "🕘", sub: [
      ...["09:00", "12:00", "15:00", "18:00", "21:00"].map((t) => ({ label: t, icon: n.due_time === t ? "●" : "○", run: () => actDueTime(id, t) })),
      { sep: true },
      { label: "時刻なし（終日）", icon: n.due_set && !n.due_time ? "●" : "○", disabled: !n.due_set, run: () => actDueTime(id, "") },
    ] },
    { label: "リマインダー", icon: "⏰", sub: remindMenu(id) },
    { label: n.list ? "リスト: " + n.list : "リスト", icon: "📋", sub: [
      { label: "受信箱（リストなし）", icon: !n.list ? "●" : "○", run: () => actList(id, "") },
      { sep: true },
      ...orderedLists().slice(0, 30).map((l) => ({ label: l.name, hint: String(l.count), icon: n.list === l.name ? "●" : "○", run: () => actList(id, l.name) })),
      { sep: true },
      { label: "新しいリスト…", run: () => newListFor(id) },
    ] },
    { label: "タグ", icon: "🏷", sub: [...tagItems, { sep: true }, { label: "新しいタグ…", run: () => newTagFor(id) }] },
    { sep: true },
    { label: "編集", icon: "✏️", key: "e", run: async () => { await open(id); togglePreview(false); } },
    { label: "振り返りを書く", icon: "📝", run: () => writeRecap(id) },
    { label: "ファイルを添付…", icon: "📎", run: async () => { await open(id); $("filepick").click(); } },
    { label: "リンクにタイトルを付ける", icon: "🔗", run: () => actLinkTitles(id) },
    { label: "コピー", icon: "📋", sub: [
      { label: "タイトル", run: () => actCopy(id, "title") }, { label: "本文", run: () => actCopy(id, "body") },
    ] },
    { label: "履歴", icon: "🕘", key: "Alt+H", run: async () => { await open(id); openHistory(); } },
    { sep: true },
    // 作成・更新の日時（年つき。スマホでも、メニューから見られる）
    { label: pref.get("recapPrompt", true) ? "完了後の「振り返り」の案内: オン（オフにする）" : "完了後の「振り返り」の案内: オフ（オンにする）", icon: "💬", run: () => { const on = !pref.get("recapPrompt", true); pref.set("recapPrompt", on); setStatus(on ? "完了・中止の直後に、振り返りを促します" : "完了後の「振り返り」の案内を、オフにしました"); } },
    { label: `作成 ${fmt(n.created)}`, disabled: true },
    { label: `更新 ${fmt(n.updated)}`, disabled: true },
    ...(n.abandoned ? [{ label: `中止 ${fmt(n.cancelled || n.updated)}`, disabled: true }] : n.done && n.completed ? [{ label: `完了 ${fmt(n.completed)}`, disabled: true }] : []),
    { sep: true },
    { label: "ゴミ箱へ", icon: "🗑", key: "Alt+⌫", danger: true, run: () => actTrash(id) },
  ];
}

// ---- メニューの部品（入れ子対応・キーボード操作対応） ----
const ctxEl = $("ctx");
let menu = null; // { levels: [{items, sel, el}] }

function closeMenu() {
  ctxEl.replaceChildren();
  ctxEl.hidden = true;
  menu = null;
}

function placeMenu(el, x, y, parentRect) {
  el.style.left = x + "px";
  el.style.top = y + "px";
  const r = el.getBoundingClientRect();
  let nx = x, ny = y;
  if (r.right > innerWidth - 4) nx = parentRect ? parentRect.left - r.width + 4 : innerWidth - r.width - 4;
  if (r.bottom > innerHeight - 4) ny = Math.max(4, innerHeight - r.height - 4);
  el.style.left = Math.max(4, nx) + "px";
  el.style.top = ny + "px";
}

function levelEl(items, depth) {
  const el = document.createElement("div");
  el.className = "menu";
  items.forEach((it, i) => {
    if (it.sep) { el.append(Object.assign(document.createElement("div"), { className: "sep" })); return; }
    const row = document.createElement("div");
    row.className = "mi" + (it.disabled ? " disabled" : "") + (it.danger ? " danger" : "");
    row.dataset.i = i;
    row.innerHTML = '<span class="ic"></span><span class="lb"></span><span class="k"></span>';
    row.children[0].textContent = it.icon || "";
    if (it.color) row.children[0].style.color = it.color;
    row.children[1].textContent = it.label;
    row.children[2].textContent = it.sub ? "›" : (it.key || it.hint || "");
    row.addEventListener("mouseenter", () => { if (!it.disabled) selectRow(depth, i); });
    row.addEventListener("click", (e) => { e.stopPropagation(); if (!it.disabled) activateRow(depth, i); });
    el.append(row);
  });
  return el;
}

function openMenu(items, x, y) {
  if (!items.length) return;
  closeMenu();
  ctxEl.hidden = false;
  const el = levelEl(items, 0);
  ctxEl.append(el);
  placeMenu(el, x, y);
  menu = { levels: [{ items, sel: -1, el }] };
}

function trimLevels(depth) {
  while (menu.levels.length > depth + 1) menu.levels.pop().el.remove();
}

function selectRow(depth, i) {
  trimLevels(depth);
  const lv = menu.levels[depth];
  lv.sel = i;
  lv.el.querySelectorAll(".mi").forEach((r) => r.classList.toggle("sel", +r.dataset.i === i));
  if (lv.items[i].sub) openSub(depth, i);
}

function openSub(depth, i) {
  const lv = menu.levels[depth];
  const row = lv.el.querySelector(`[data-i="${i}"]`);
  const r = row.getBoundingClientRect();
  const items = lv.items[i].sub;
  const el = levelEl(items, depth + 1);
  ctxEl.append(el);
  placeMenu(el, r.right - 4, r.top - 4, r);
  menu.levels.push({ items, sel: -1, el });
}

function activateRow(depth, i) {
  const it = menu.levels[depth].items[i];
  if (it.sub) { selectRow(depth, i); return; }
  const r = menu.levels[depth].el.querySelector(`[data-i="${i}"]`).getBoundingClientRect();
  closeMenu();
  if (it.run) it.run({ x: r.left, y: r.bottom });
}

function menuKey(e) {
  const depth = menu.levels.length - 1;
  const lv = menu.levels[depth];
  const step = (d) => {
    let i = lv.sel;
    for (let n = 0; n < lv.items.length; n++) {
      i = (i + d + lv.items.length) % lv.items.length;
      if (!lv.items[i].sep && !lv.items[i].disabled) { selectRow(depth, i); if (lv.items[i].sub) trimLevels(depth); return; }
    }
  };
  if (e.key === "ArrowDown") step(1);
  else if (e.key === "ArrowUp") step(-1);
  else if (e.key === "ArrowRight") {
    const it = lv.items[lv.sel];
    if (it && it.sub) { selectRow(depth, lv.sel); const sub = menu.levels[depth + 1]; if (sub) { const f = sub.items.findIndex((x) => !x.sep && !x.disabled); if (f >= 0) selectRow(depth + 1, f); } }
  } else if (e.key === "ArrowLeft") { if (depth > 0) trimLevels(depth - 1); }
  else if (e.key === "Enter" || e.key === " ") { if (lv.sel >= 0) activateRow(depth, lv.sel); }
  else if (e.key === "Escape") { if (depth > 0) trimLevels(depth - 1); else closeMenu(); }
  else if (e.key === "Tab") closeMenu();
  e.preventDefault();
}

document.addEventListener("mousedown", (e) => { if (menu && !e.target.closest("#ctx")) closeMenu(); });
window.addEventListener("blur", () => { if (menu) closeMenu(); });
window.addEventListener("resize", () => { if (menu) closeMenu(); });
listEl.addEventListener("scroll", () => { if (menu) closeMenu(); });

// 一覧のメモを右クリック（スマホは長押し）
listEl.addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  e.preventDefault();
  if (state.selIds.size > 1 && state.selIds.has(li.dataset.id)) { openMenu(bulkMenu(selectedIds()), e.clientX, e.clientY); return; } // 選んだ行を右クリック → まとめて
  const i = state.notes.findIndex((n) => n.id === li.dataset.id);
  if (i >= 0) { state.sel = i; render(); }
  openMenu(noteMenu(li.dataset.id), e.clientX, e.clientY);
});

// 開いているメモの整形表示を右クリック（文字を選択中・リンク・画像のときは、ブラウザ標準のメニューを残す）
previewEl.addEventListener("contextmenu", (e) => {
  if (!state.cur || String(getSelection()).length || e.target.closest("a, img, .blk-edit")) return;
  e.preventDefault();
  openMenu(noteMenu(state.cur), e.clientX, e.clientY);
});

// キーボードから: 選択中のメモで x（完了）／ . ・ メニューキー・Shift+F10（メニュー）
function keyTargetId() {
  return document.activeElement === previewEl && state.cur ? state.cur : (state.notes[state.sel] || {}).id;
}
function menuAtSelection(id) {
  const li = listEl.querySelector(`li[data-id="${id}"]`);
  const r = (li || listEl).getBoundingClientRect();
  openMenu(noteMenu(id), r.left + 40, r.top + Math.min(r.height, 36));
}

// ---------- 複数選択・まとめて操作・元に戻す ----------
const selectedIds = () => state.notes.filter((n) => state.selIds.has(n.id)).map((n) => n.id); // 一覧の並び順で
const selbar = Object.assign(document.createElement("div"), { id: "selbar", hidden: true });
selbar.innerHTML = '<span id="selcount"></span><button id="sel-all" type="button" title="いま一覧に出ているメモを、全部選ぶ">すべて</button><button id="sel-menu" type="button">まとめて操作 ▾</button><button id="sel-clear" type="button">解除</button>';
listEl.before(selbar);
$("sel-clear").onclick = () => exitSel();
$("sel-all").onclick = () => { state.selIds = new Set(state.notes.map((n) => n.id)); paintSel(); };
$("sel-menu").onclick = (e) => { const ids = selectedIds(); if (!ids.length) { setStatus("まとめて操作するメモを、先に選んでください"); return; } const r = e.currentTarget.getBoundingClientRect(); openMenu(bulkMenu(ids), Math.max(4, r.left - 120), r.bottom + 2); };
// 一覧の上の「☑」: 選択モードの入り切り（スマホは、これでタップして選ぶ）
const selBtn = Object.assign(document.createElement("button"), { id: "btn-select", type: "button", textContent: "☑", title: "選択モード（複数のメモを、タップで選ぶ）" });
$("btn-sort").before(selBtn);
selBtn.onclick = () => (state.selMode ? exitSel() : startSelMode());
function startSelMode(id) {
  state.selMode = true;
  if (id) { state.selIds.add(id); state.anchor = id; }
  paintSel();
  setStatus("選択モード: メモをタップして選びます。終わったら「終了」");
}
function exitSel() {
  state.selMode = false;
  state.selIds = new Set();
  state.anchor = null;
  paintSel();
}

function paintSel() {
  listEl.querySelectorAll("li[data-id]").forEach((li) => li.classList.toggle("msel", state.selIds.has(li.dataset.id)));
  const k = state.selIds.size;
  document.body.classList.toggle("selmode", state.selMode);
  document.body.classList.toggle("hassel", state.selMode || k > 0); // 選んでいる間は、「いま開いている行」の強調を消す（選んだ行と見分けがつかないため）
  selbar.hidden = !(state.selMode || k > 0);
  $("selcount").textContent = state.selMode && !k ? "タップして選びます" : `${k}件 選択中`;
  $("sel-clear").textContent = state.selMode ? "終了" : "解除";
  $("sel-menu").disabled = k < 1;
  selBtn.classList.toggle("on", state.selMode);
}
function clearSel() {
  if (state.selMode) { exitSel(); return; }
  if (!state.selIds.size) return;
  state.selIds = new Set();
  state.anchor = null;
  paintSel();
}
// 行のクリック: Ctrl/Cmd+クリック = 1件ずつ追加・外す / Shift+クリック = 範囲 / ふつうのクリック = 選択をやめて、メモを開く
function clickRow(e, n, i) {
  if (state.selMode) { // 選択モード: タップで選ぶ・外す。Shift（PC）なら範囲
    if (e.shiftKey && state.anchor) {
      const a = state.notes.findIndex((x) => x.id === state.anchor);
      if (a >= 0) { const [lo, hi] = a < i ? [a, i] : [i, a]; state.notes.slice(lo, hi + 1).forEach((x) => state.selIds.add(x.id)); paintSel(); return; }
    }
    state.selIds.has(n.id) ? state.selIds.delete(n.id) : state.selIds.add(n.id);
    state.anchor = n.id;
    paintSel();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (!state.selIds.size) { // 最初の Ctrl+クリック: いま開いている（直前にクリックした）メモも、選びに含める
      const base = state.anchor || state.cur;
      if (base && base !== n.id && state.notes.some((x) => x.id === base)) state.selIds.add(base);
    }
    state.selIds.has(n.id) ? state.selIds.delete(n.id) : state.selIds.add(n.id);
    state.anchor = n.id;
    paintSel();
    return;
  }
  if (e.shiftKey) {
    const a = state.notes.findIndex((x) => x.id === state.anchor);
    if (a >= 0) {
      const [lo, hi] = a < i ? [a, i] : [i, a];
      state.selIds = new Set(state.notes.slice(lo, hi + 1).map((x) => x.id));
    } else { state.selIds = new Set([n.id]); state.anchor = n.id; }
    paintSel();
    return;
  }
  clearSel();
  state.anchor = n.id; // Shift/Ctrl+クリックの起点
  state.sel = i;
  open(n.id);
}
listEl.addEventListener("mousedown", (e) => { if (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey) && e.target.closest("li[data-id]")) e.preventDefault(); }); // Shift+クリックで、文字が選択されてしまわないように

// 変更前の状態を控える（元に戻すため）
function snapshot(id) {
  const n = D.get(id);
  if (!n) return null;
  return { id, body: n.body, done: n.done, abandoned: !!n.abandoned, due: n.due_set ? n.due_set + (n.due_time ? "T" + n.due_time : "") : "", start: n.start || "", event: n.event || "",
    remind: n.remind || "", repeat: n.repeat || "", list: n.list || "", kind: n.kind, priority: n.priority || 0, pinned: !!n.pinned };
}
async function restoreSnap(s) {
  const n = D.get(s.id);
  if (!n) { // ゴミ箱へ移したもの → サーバーのゴミ箱から戻す（オンラインのとき）
    try {
      const r = await fetch(`/api/trash/${s.id}/restore`, { method: "POST" });
      if (r.ok) D.kick(200); // 端末のコピーにも、すぐ取り込む
      return r.ok || r.status === 409;
    } catch { return false; }
  }
  if (n.body !== s.body) D.save(s.id, s.body);
  D.setList(s.id, s.list);
  const cur = n.due_set ? n.due_set + (n.due_time ? "T" + n.due_time : "") : "";
  if (cur !== s.due) D.setDue(s.id, s.due); // 期日を消すと、予定・通知も消えるので、そのあとで戻す
  if ((D.get(s.id).start || "") !== s.start) D.setStart(s.id, s.start);
  D.setEvent(s.id, s.event);
  D.setRemind(s.id, s.remind);
  D.setRepeat(s.id, s.repeat);
  D.setKind(s.id, s.kind);
  D.setPriority(s.id, s.priority);
  D.setPinned(s.id, s.pinned);
  const cur2 = D.get(s.id);
  if (cur2.done !== s.done || !!cur2.abandoned !== !!s.abandoned) { // 完了・中止の状態を戻す（いったん未完了に戻してから）
    if (cur2.done) D.setDone(s.id, false);
    if (s.done) D.setDone(s.id, true, !!s.abandoned);
  }
  return true;
}

const undoStack = [];
const undobar = Object.assign(document.createElement("div"), { id: "undobar", hidden: true });
undobar.innerHTML = '<span id="undomsg"></span><button id="undobtn" type="button">元に戻す</button><button id="undoclose" type="button" title="閉じる">×</button>';
document.body.append(undobar);
let undoTimer = null;
function showUndo(msg) {
  $("undomsg").textContent = msg;
  undobar.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { undobar.hidden = true; }, 25000);
}
$("undobtn").onclick = () => undoLast();
$("undoclose").onclick = () => { undobar.hidden = true; };

async function undoLast() {
  const u = undoStack.pop();
  if (!u) return;
  undobar.hidden = true;
  state.batch++;
  let ok = 0, ng = 0;
  try { for (const s of u.snaps) { try { (await restoreSnap(s)) ? ok++ : ng++; } catch { ng++; } } } finally { state.batch--; }
  await refresh();
  setStatus(ng ? `元に戻しました（${ok}件）。${ng}件は戻せませんでした（ゴミ箱の復元は、オンラインのときだけです）` : `元に戻しました（${ok}件）`);
  if (undoStack.length) showUndo(`${undoStack.at(-1).n}件: ${undoStack.at(-1).label}`);
  else if (state.cur && D.get(state.cur) && document.body.classList.contains("previewing")) togglePreview(true, false);
}

// ids の全部に、fn(id) を順に行う。最後に1回だけ一覧を作り直し、「元に戻す」を出す
async function runBatch(ids, fn, label) {
  ids = [...new Set(ids)].filter((id) => D.get(id));
  if (ids.length < 2) { for (const id of ids) await fn(id); return; }
  const snaps = ids.map(snapshot).filter(Boolean);
  state.batch++;
  try { for (const id of ids) { try { await fn(id); } catch (err) { console.error(err); } } } finally { state.batch--; }
  await refresh();
  setStatus(`${ids.length}件: ${label}`);
  undoStack.push({ label, snaps, n: ids.length });
  if (undoStack.length > 20) undoStack.shift();
  showUndo(`${ids.length}件: ${label}`);
}

async function bulkDone(ids) {
  const all = ids.map((id) => D.get(id)).filter(Boolean);
  const tasks = all.filter((n) => n.kind !== "note");
  const skipped = all.length - tasks.length;
  if (!tasks.length) { setStatus("ノートは完了にできません（タスクにすると完了できます）"); return; }
  const to = tasks.some((n) => !n.done); // ひとつでも未完了があれば、全部を完了に。全部完了済みなら、戻す
  await runBatch(tasks.map((n) => n.id), (id) => actDone(id, to), (to ? "完了にしました" : "完了を戻しました") + (skipped ? `（ノート${skipped}件は除く）` : ""));
}

function bulkMenu(ids) {
  const k = ids.length;
  const run = (fn, label) => () => runBatch(ids, fn, label);
  const dueItem = (label, v) => ({ label, hint: v.slice(5).replace("-", "/"), run: run((id) => actDue(id, v), `期日を「${label}」にしました`) });
  const tagItems = state.tags.filter((t) => t.real).sort((a, b) => b.count - a.count).slice(0, 12)
    .map((t) => ({ label: "#" + t.tag, hint: String(t.count), run: run((id) => actTag(id, t.tag), `#${t.tag} を付けました`) }));
  return [
    { label: `${k}件を、まとめて`, disabled: true },
    { sep: true },
    { label: "完了にする / 戻す", icon: "✅", key: "x", run: () => bulkDone(ids) },
    { label: "中止にする（キャンセル）", icon: "🚫", run: run((id) => actCancel(id, true), "中止にしました") },
    { label: "リスト", icon: "📋", sub: [
      { label: "受信箱（リストなし）", run: run((id) => actList(id, ""), "リストを外しました（受信箱へ）") },
      { sep: true },
      ...orderedLists().slice(0, 30).map((l) => ({ label: l.name, hint: String(l.count), run: run((id) => actList(id, l.name), `リスト「${l.name}」へ入れました`) })),
    ] },
    { label: "タグを付ける", icon: "🏷", sub: tagItems.length ? tagItems : [{ label: "（タグがありません）", disabled: true }] },
    { label: "期日", icon: "📅", sub: [
      dueItem("今日", addDays(0)), dueItem("明日", addDays(1)), dueItem("来週の月曜", nextMonday()), dueItem("1週間後", addDays(7)), { sep: true },
      { label: "期日を消す", run: run((id) => actDue(id, ""), "期日を消しました") },
    ] },
    { label: "優先度", icon: "🚩", sub: [
      { label: "高", color: "#e5484d", run: run((id) => actPrio(id, 5), "優先度を「高」にしました") },
      { label: "中", color: "#f76b15", run: run((id) => actPrio(id, 3), "優先度を「中」にしました") },
      { label: "低", color: "#3e63dd", run: run((id) => actPrio(id, 1), "優先度を「低」にしました") },
      { sep: true },
      { label: "なし", run: run((id) => actPrio(id, 0), "優先度を外しました") },
    ] },
    { label: "種類", icon: "📝", sub: [
      { label: "タスク（完了できる）", run: run((id) => actKind(id, "task"), "タスクにしました") },
      { label: "ノート（読み物・資料）", run: () => { if (okNote(ids)) run((id) => actKind(id, "note"), "ノートにしました")(); } },
    ] },
    { label: "ピン留め / 外す", icon: "📌", sub: [
      { label: "ピン留めする", run: run((id) => actPin(id, true), "ピン留めしました") },
      { label: "ピン留めを外す", run: run((id) => actPin(id, false), "ピン留めを外しました") },
    ] },
    { sep: true },
    { label: "ゴミ箱へ", icon: "🗑", danger: true, run: () => { if (window.confirm(`${k}件を、ゴミ箱へ移します。よろしいですか？（「元に戻す」で戻せます）`)) runBatch(ids, (id) => actTrash(id), "ゴミ箱へ移しました"); } },
  ];
}

// ---------- ドラッグ&ドロップ（メモ → タグ・日付・完了・ゴミ箱） ----------
const MIME = "application/x-tick-note";
const isNoteDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes(MIME);
const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return ymd(d);
}

// el に「メモを落とせる」性質を付ける。落とされたら onDrop(メモid)
// ドラッグ中、カーソルのそばに「落とすと何が起きるか」を出す（どの行を狙っているか確実に分かるように）
const dropTip = document.createElement("div");
dropTip.id = "droptip";
dropTip.hidden = true;
document.body.append(dropTip);
function showTip(e, text) {
  dropTip.textContent = text;
  dropTip.hidden = false;
  const x = Math.min(e.clientX + 18, innerWidth - dropTip.offsetWidth - 8);
  dropTip.style.left = x + "px";
  dropTip.style.top = Math.min(e.clientY + 22, innerHeight - dropTip.offsetHeight - 8) + "px";
}

function dropTarget(el, onDrop, tip = "") {
  el.addEventListener("dragenter", (e) => { if (isNoteDrag(e)) { e.preventDefault(); el.classList.add("dropover"); if (tip) showTip(e, tip); } });
  el.addEventListener("dragover", (e) => {
    if (!isNoteDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("dropover");
    if (tip) showTip(e, tip);
  });
  el.addEventListener("dragleave", (e) => {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove("dropover");
    dropTip.hidden = true;
  });
  el.addEventListener("drop", (e) => {
    if (!isNoteDrag(e)) return;
    e.preventDefault();
    el.classList.remove("dropover");
    dropTip.hidden = true;
    const id = e.dataTransfer.getData(MIME) || state.dragId;
    const ids = state.dragIds.length > 1 ? state.dragIds.slice() : [];
    state.dragId = null; // ここで終わらせて、続く一覧の更新を通す
    state.dragIds = [];
    document.body.classList.remove("dragging");
    if (ids.length > 1) { // 選んだ複数をまとめて落とした
      if (/ゴミ箱/.test(tip) && !window.confirm(`${ids.length}件を、ゴミ箱へ移します。よろしいですか？（「元に戻す」で戻せます）`)) return;
      runBatch(ids, onDrop, tip || "まとめて操作");
    } else if (id) onDrop(id);
  });
}

// マウスを押している間は、一覧の更新（同期など）を待たせる
function releasePress() {
  if (!state.pressing) return;
  state.pressing = false;
  if (state.pendingRefresh && !state.dragId) { state.pendingRefresh = false; refresh(); }
}
listEl.addEventListener("mousedown", (e) => { if (e.button === 0) state.pressing = true; });
document.addEventListener("mouseup", () => setTimeout(releasePress, 0), true); // クリックの処理が済んでから
window.addEventListener("blur", releasePress);

function startDrag(e, n, li) {
  state.pressing = false;
  if (state.selIds.size && !state.selIds.has(n.id)) clearSel(); // 選んでいないメモを掴んだら、選択はやめて、そのメモだけ動かす
  const multi = state.selIds.has(n.id) && state.selIds.size > 1;
  state.dragIds = multi ? selectedIds() : [];
  state.dragId = n.id;
  e.dataTransfer.setData(MIME, n.id);
  e.dataTransfer.effectAllowed = "move";
  // ドラッグ中にカーソルに付く画像を、行まるごと（大きい）ではなく、小さな札にして、右下にずらす
  try {
    const chip = document.createElement("div");
    chip.className = "dragchip";
    chip.textContent = multi ? `📄 ${state.dragIds.length}件` : "📄 " + (n.title || "（空のメモ）").slice(0, 24);
    document.body.append(chip);
    e.dataTransfer.setDragImage(chip, -16, -10); // 負の値 = 札はカーソルの右下に出る（落とし先を隠さない）
    setTimeout(() => chip.remove(), 0);
  } catch { /* 画像が変えられなくても、ドラッグ自体はできる */ }
  document.body.classList.add("dragging");
  setTimeout(() => (multi ? listEl.querySelectorAll("li.msel") : [li]).forEach((x) => x.classList.add("dragsrc")), 0); // 掴んだ見た目を壊さないよう、少し遅らせて薄くする
}

function endDrag() {
  dropTip.hidden = true;
  state.dragId = null;
  state.dragIds = [];
  document.body.classList.remove("dragging");
  document.querySelectorAll(".dropover, .dragsrc, .dropbefore, .dropafter").forEach((x) => x.classList.remove("dropover", "dragsrc", "dropbefore", "dropafter"));
  if (state.pendingRefresh) { state.pendingRefresh = false; refresh(); }
}
document.addEventListener("dragend", endDrag, true);
document.addEventListener("drop", () => setTimeout(endDrag, 0), true);

// ドラッグしている間だけ、画面の下に「落とし先」を出す
(() => {
  const dock = document.createElement("div");
  dock.id = "dock";
  const acts = {
    today: (id) => actDue(id, todayStr()), tomorrow: (id) => actDue(id, addDays(1)), nextmon: (id) => actDue(id, nextMonday()),
    clear: (id) => actDue(id, ""), done: (id) => actDone(id, true), trash: (id) => actTrash(id),
  };
  for (const [k, label, tip] of [
    ["today", "📅 今日", "期日を今日にする"], ["tomorrow", "🌅 明日", "期日を明日にする"],
    ["nextmon", "🗓 来週の月曜", "期日を来週の月曜にする"], ["clear", "◌ 日付なし", "期日を消す"],
    ["done", "✅ 完了", "完了にする"], ["trash", "🗑 ゴミ箱", "ゴミ箱へ移す"],
  ]) {
    const b = document.createElement("div");
    b.className = "dk";
    b.textContent = label;
    dropTarget(b, acts[k], tip);
    dock.append(b);
  }
  document.body.append(dock);
})();

// ---------- ファイルの添付（ドラッグ&ドロップ・貼り付け・📎） ----------
const dropzone = $("dropzone");
let fileDragDepth = 0;
window.addEventListener("dragenter", (e) => { if (isFileDrag(e)) { e.preventDefault(); fileDragDepth++; dropzone.hidden = false; } });
window.addEventListener("dragover", (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
window.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (!fileDragDepth) dropzone.hidden = true;
});
window.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); // ファイルを画面のどこに落としても、ブラウザがそのファイルを開いてしまわないように
  fileDragDepth = 0;
  dropzone.hidden = true;
  const files = [...e.dataTransfer.files];
  if (files.length) attachFiles(files);
});
ed.addEventListener("paste", (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (files.length) { e.preventDefault(); attachFiles(files); return; } // 画像のコピー → Ctrl+V
  const txt = ((e.clipboardData && e.clipboardData.getData("text/plain")) || "").trim();
  if (/^https?:\/\/\S+$/.test(txt)) { e.preventDefault(); pasteUrl(txt); } // URLを貼った → タイトル付きのリンクにする
});

// ---------- リンクにタイトルを付ける ----------
const mdText = (t) => t.replace(/\[/g, "［").replace(/\]/g, "］"); // 題名の中の [ ] は、リンクを壊すので全角にする

async function fetchLinkTitle(url) {
  if (!navigator.onLine) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 14000);
    const r = await fetch("/api/linktitle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    return (await r.json()).title || null;
  } catch { return null; }
}

// 文章中の「裸のURL」（[題名](URL) の中や、`コード`の中のものは除く）
const BARE_URL = /(?<!\]\()(?<!`)https?:\/\/[^\s)>\]」』）`]+/g;

// 入力欄 el（ソース編集、または段落の入力欄）の、裸のURLを、リンクに置き換える。near = そのURLを入れた位置（近くにあるものを優先）
function replaceBareUrl(url, md, near = 0, el = ed) {
  const v = el.value;
  let idx = v.startsWith(url, near) ? near : -1;
  if (idx < 0) {
    for (const m of v.matchAll(BARE_URL)) if (m[0] === url) { idx = m.index; break; }
  }
  if (idx < 0) return false;
  const caret = el.selectionStart;
  const delta = md.length - url.length;
  el.setRangeText(md, idx, idx + url.length, "preserve");
  const pos = caret >= idx + url.length ? caret + delta : caret; // URLの末尾か、それより後ろにカーソルがあれば、置き換えた分だけずらす
  el.setSelectionRange(pos, pos);
  if (el === ed) onInput(); else { syncFromTa(); autosize(el); }
  return true;
}

// 段落の入力欄を、すでに離れていたとき（別の段落へ移った後など）は、本文を直接置き換える
function replaceBareUrlInSource(url, md) {
  for (const m of ed.value.matchAll(BARE_URL)) {
    if (m[0] !== url) continue;
    ed.setRangeText(md, m.index, m.index + url.length, "preserve");
    onInput();
    if (document.body.classList.contains("previewing")) renderPreview();
    return true;
  }
  return false;
}

async function pasteUrl(url) {
  const el = inputEl();
  const sync = () => (el === ed ? onInput() : (syncFromTa(), autosize(el)));
  const s = el.selectionStart, e2 = el.selectionEnd;
  if (s !== e2) { // 文字を選んでURLを貼った → 選んだ文字を題名にしたリンク
    const sel = el.value.slice(s, e2);
    el.setRangeText(`[${mdText(sel)}](${url})`, s, e2, "end");
    sync();
    return;
  }
  el.setRangeText(url, s, s, "end"); // まずURLをそのまま入れる（すぐ入力を続けられる）
  sync();
  if (el === ed) updateGallery();
  const title = await fetchLinkTitle(url);
  if (!title) return;
  const md = `[${mdText(title)}](${url})`;
  const stillHere = el === ed || (blk && blk.ta === el);
  if (stillHere ? replaceBareUrl(url, md, s, el) : replaceBareUrlInSource(url, md)) setStatus("リンクにタイトルを付けました");
}

// メモの中の裸のURLに、まとめてタイトルを付ける（最大8件）
async function actLinkTitles(id) {
  const n = D.get(id);
  if (!n) return;
  if (id === state.cur) await flush();
  const urls = [...new Set([...D.get(id).body.matchAll(BARE_URL)].map((m) => m[0]))].slice(0, 8);
  if (!urls.length) { setStatus("タイトルを付けられるURLが、メモの中にありません"); return; }
  setStatus(`${urls.length}件のURLのタイトルを取得中…`);
  const titles = await Promise.all(urls.map(fetchLinkTitle));
  let body = D.get(id).body; // 取得している間に変わっているかもしれないので、最新を読み直す
  let ok = 0;
  urls.forEach((u, i) => {
    if (!titles[i]) return;
    // URLの直前が ]( や ` でなく、直後がURLの続きでない（別の長いURLの一部を置き換えない）ものだけ
    const rx = new RegExp("(?<!\\]\\()(?<!`)" + u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![^\\s)>\\]」』）`])", "g");
    const next = body.replace(rx, `[${mdText(titles[i])}](${u})`);
    if (next !== body) { body = next; ok++; }
  });
  if (ok) {
    D.save(id, body);
    if (id === state.cur) { ed.value = body; if (document.body.classList.contains("previewing")) togglePreview(true, false); }
    await refresh();
  }
  setStatus(ok ? `${ok}件のURLにタイトルを付けました` + (ok < urls.length ? `（${urls.length - ok}件は取得できませんでした）` : "") : "タイトルを取得できませんでした（ログインが必要なページ等は、取得できません）");
}

// 共有でURLだけが届いたメモは、1行目を、ページのタイトルにする
async function titleFirstLineFromUrl(id) {
  const n = D.get(id);
  const first = n && n.body.split("\n")[0].trim();
  if (!first || !/^https?:\/\/\S+$/.test(first)) return;
  const title = await fetchLinkTitle(first);
  const cur = D.get(id);
  if (!title || !cur || cur.body.split("\n")[0].trim() !== first) return; // 取得中に、メモが変わっていたら、何もしない
  const body = `${title}\n` + cur.body;
  D.save(id, body);
  if (id === state.cur && !state.dirty) { ed.value = body; if (document.body.classList.contains("previewing")) togglePreview(true, false); }
  await refresh();
}
$("btn-attach").onclick = () => $("filepick").click();
$("filepick").addEventListener("change", (e) => { attachFiles([...e.target.files]); e.target.value = ""; });

function insertText(text) {
  const wasPreview = document.body.classList.contains("previewing");
  if (wasPreview) togglePreview(false, false); // 整形表示中は、末尾に足す
  const pos = wasPreview ? ed.value.length : ed.selectionStart;
  ed.setRangeText(text, pos, wasPreview ? pos : ed.selectionEnd, "end");
  onInput();
  updateGallery();
  if (wasPreview) togglePreview(true, false);
}

async function attachFiles(files) {
  if (!navigator.onLine) { setStatus("添付はオンラインのときだけ追加できます"); return; }
  if (document.body.classList.contains("noedit")) await newNote(); // 開いているメモが無ければ、新しいメモにする
  const md = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const label = (f.name || "image.png").replace(/[\[\]]/g, "");
    setStatus(`アップロード中… ${i + 1}/${files.length}  ${label}`);
    try {
      const r = await fetch("/api/attachments", { method: "POST", headers: { "X-Filename": encodeURIComponent(f.name || "image.png") }, body: f });
      if (!r.ok) throw new Error(r.status === 413 ? "大きすぎます（上限200MB）" : "HTTP " + r.status);
      const j = await r.json();
      fetch(j.url).catch(() => {}); // この端末にも保存しておく（オフラインでも見えるように）
      md.push(IMG_EXT.test(label) ? `![](${j.url})` : `[${label}](${j.url})`);
    } catch (e) {
      setStatus(`添付できませんでした: ${label}（${e.message}）`);
    }
  }
  if (!md.length) return;
  insertText("\n" + md.join("\n") + "\n");
  setStatus(`${md.length}個のファイルを添付しました`);
}

// ---------- 通知の設定（Webプッシュ） ----------
const ntEl = $("notify"), ntState = $("nt-state"), ntActions = $("nt-actions");
const b64ToBytes = (s) => {
  const p = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderNotify(msg = "") {
  const lines = [];
  const btns = [];
  const btn = (label, fn, primary) => {
    const b = Object.assign(document.createElement("button"), { textContent: label });
    if (primary) b.className = "primary";
    b.onclick = async () => { b.disabled = true; try { await fn(); } finally { renderNotify(); } };
    btns.push(b);
  };
  if (!pushSupported()) {
    lines.push("このブラウザは、プッシュ通知に対応していません。（iPhoneは、ホーム画面に追加したアプリでのみ対応）");
  } else if (!window.isSecureContext) {
    lines.push("通知は https の接続でだけ使えます。https://… のアドレスで開いてください。");
  } else if (Notification.permission === "denied") {
    lines.push("通知が「ブロック」されています。ブラウザ（またはAndroidの設定 → アプリ → 通知）で、このアプリの通知を許可してください。");
  } else {
    const sub = await currentSub().catch(() => null);
    let devices = "?";
    try { devices = (await (await fetch("/api/push/key")).json()).devices; } catch { lines.push("⚠ サーバーにつながりません（登録・テストはオンラインのときだけ）"); }
    lines.push(sub ? "✅ この端末は、通知が<b>有効</b>です。" : "この端末は、通知が<b>まだ有効ではありません</b>。");
    lines.push(`登録済みの端末: ${devices} 台`);
    if (!sub) btn("通知を有効にする", enablePush, true);
    else {
      btn("テスト通知（いますぐ）", () => testPush(0), true);
      btn("テスト通知（20秒後）— アプリを閉じて確かめる", () => testPush(20));
      btn("この端末の通知を無効にする", disablePush);
    }
  }
  ntState.innerHTML = (msg ? `<b>${msg}</b><br>` : "") + lines.join("<br>");
  ntActions.replaceChildren(...btns);
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return renderNotify("通知が許可されませんでした");
    const { publicKey } = await (await fetch("/api/push/key")).json();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    if (!r.ok) throw new Error("登録できませんでした (" + r.status + ")");
    await renderNotify("有効にしました。「テスト通知」で確かめてください。");
  } catch (e) {
    await renderNotify("有効にできませんでした: " + (e.message || e));
  }
}

async function disablePush() {
  const sub = await currentSub();
  if (sub) {
    try { await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch { /* 端末側だけでも外す */ }
    await sub.unsubscribe();
  }
}

async function testPush(delay) {
  const r = await fetch("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delay }) });
  const j = await r.json();
  if (j.scheduled) return renderNotify(`${j.scheduled}秒後に送ります。アプリを閉じて（スマホは画面を消して）お待ちください。`);
  renderNotify(j.sent ? `送りました（${j.sent}台）` : `送れませんでした（成功 ${j.sent} / 失敗 ${j.failed} / 無効で削除 ${j.removed}）`);
}

const openNotify = () => { document.body.classList.remove("navopen"); ntEl.hidden = false; renderNotify(); };
$("btn-notify").onclick = openNotify;
$("nav-notify").onclick = openNotify; // スマホは、☰メニューの中から開く（メモを開かなくても使える）
$("nt-close").onclick = () => { ntEl.hidden = true; };
ntEl.addEventListener("mousedown", (e) => { if (e.target === ntEl) ntEl.hidden = true; });

// ---------- 通信状態の表示 ----------
const netEl = $("netstat");
function renderNet(s) {
  let t, cls = "";
  if (!s.online) { t = "○ オフライン" + (s.pending ? `・送信待ち ${s.pending}` : ""); cls = "off"; }
  else if (s.error) { t = "⚠ " + s.error; cls = "err"; }
  else if (s.syncing) t = "◐ 同期中…";
  else if (s.pending) t = `◐ 送信待ち ${s.pending}`;
  else t = "● 同期済み";
  if (!s.persisted) t += "（この画面を閉じるまで）";
  netEl.textContent = t;
  netEl.className = cls;
}

// サーバーや他の端末の変更が届いたとき、開いているメモを（編集中でなければ）最新にする
let changeTimer;
function onDataChange() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    await refresh();
    if (await tryOpenPending()) return;
    updateTop();
    if (!state.cur || state.dirty || document.activeElement === ed || blk) return;
    const n = D.get(state.cur);
    if (!n) { // 他の端末で消された
      state.cur = null;
      ed.value = "";
      document.body.classList.add("noedit");
      document.body.classList.remove("editing");
      render();
    } else if (n.body !== ed.value || n.due_set !== state.curDue || n.due_time !== state.curTime || n.remind !== state.curRemind) {
      ed.value = n.body;
      syncDueUI(n);
      if (document.body.classList.contains("previewing")) togglePreview(true, false);
    }
  }, 50);
}

// ---------- OSの「共有」から受け取る ----------
// 共有されたタイトル・文章・URL → メモの本文。1行目をタイトルに、2行目にURL、最後に #共有 のタグ
function shareBody({ title = "", text = "", url = "" }) {
  const nl = (s) => s.replace(/\r\n?/g, "\n"); // 改行は \n にそろえる
  const t = nl(title).trim();
  let u = url.trim();
  let rest = nl(text).trim();
  // 文章が「URLだけ」（Android版Chromeの共有はこの形）なら、URLとして扱う。それ以外の文章は、そのまま残す
  if (/^https?:\/\/\S+$/.test(rest)) { if (!u) u = rest; rest = ""; }
  else if (u && rest === u) rest = "";
  if (rest && t && rest === t) rest = "";
  const lines = [];
  if (t) lines.push(t);
  else if (rest) { const [first, ...others] = rest.split("\n"); lines.push(first); rest = others.join("\n").trim(); }
  else lines.push(u || "共有されたファイル");
  if (u && !lines.concat(rest).some((l) => l.includes(u))) lines.push(u);
  if (rest) lines.push("", rest);
  lines.push("", "#共有");
  return lines.join("\n") + "\n";
}

async function processShare(id) {
  try {
    const cache = await caches.open("share");
    const r = await cache.match(`/_share/${id}.json`);
    if (!r) return false;
    const meta = await r.json();
    const files = [];
    for (let i = 0; i < (meta.files || []).length; i++) {
      const fr = await cache.match(`/_share/${id}/${i}`);
      if (fr) files.push(new File([await fr.blob()], meta.files[i].name, { type: meta.files[i].type }));
    }
    const n = D.create(shareBody(meta), "", state.listRoutes.note || "", "note"); // 共有されたものは、ノート（読み物）として入れる
    await refresh();
    await open(n.id);
    setStatus("共有されたものを、新しいメモにしました");
    titleFirstLineFromUrl(n.id); // URLだけの共有なら、ページのタイトルを、1行目に足す（裏で）
    if (files.length) await attachFiles(files); // 画像・PDFは添付として入れる（オンラインのときだけ）
    await cache.delete(`/_share/${id}.json`);
    for (let i = 0; i < (meta.files || []).length; i++) await cache.delete(`/_share/${id}/${i}`);
    return true;
  } catch (e) {
    setStatus("共有を受け取れませんでした");
    return false;
  }
}

// ---------- 起動 ----------
let pendingOpen = null;
async function tryOpenPending() {
  if (!pendingOpen || !D.get(pendingOpen)) return false;
  const id = pendingOpen;
  pendingOpen = null;
  const n = D.get(id);
  if (n.done) { state.showDone = true; $("showdone").checked = true; await refresh(); } // 完了済みでも開けるように
  state.sel = Math.max(0, state.notes.findIndex((x) => x.id === id));
  await open(id);
  return true;
}
let lastSettingsSync = 0;
document.body.classList.add("noedit");
(async () => {
  await D.init(); // 端末に保存してあるコピーを読む（オフラインでもここまでで画面が出る）
  D.onChange(onDataChange);
  D.onStatus(renderNet);
  D.onStatus((s) => { if (s.lastSync && s.lastSync !== lastSettingsSync) { lastSettingsSync = s.lastSync; Promise.resolve(pullSettings()).then(() => setTimeout(maybeDaily, 800)); } });
  pullSettings();
  D.onNotice((m) => setStatus(m));
  renderNet(D.status);
  await refresh();
  // 通知をタップして開いたとき（/?note=メモID）は、そのメモを開く。まだ端末に無ければ、同期で届いてから開く
  const qp = new URLSearchParams(location.search);
  pendingOpen = qp.get("note");
  const shareId = qp.get("share"); // OSの「共有」から来たとき
  if (pendingOpen || shareId) history.replaceState(null, "", location.pathname);
  if (shareId && (await processShare(shareId))) { /* 共有されたメモを開いた */ }
  else if (!(await tryOpenPending()) && state.notes[0]) open(state.notes[0].id, false);
  D.startAutoSync(); // つながっていれば、裏で差分を取り込む
})();

if ("serviceWorker" in navigator) {
  // アプリ本体（HTML/JS/CSS）を端末にも保存して、オフラインでも起動できるようにする
  const hadController = !!navigator.serviceWorker.controller;
  // アプリが更新されて新しいサービスワーカーに替わったら、入力中の分を端末に書いてから、自動で読み込み直す
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return; // 初めての導入では読み込み直さない
    saveLocal();
    D.persistNow().finally(() => location.reload());
  });
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
