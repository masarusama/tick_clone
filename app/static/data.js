// 端末側のデータ層。メモの全コピーを端末（IndexedDB）に持ち、画面はここから読む。
// 編集はまず端末に書き（即時）、サーバーへは「送信待ち(outbox)」から順に送る。
// サーバーとの差分は seq（変更番号）で取得する。オフラインでも読み書きでき、つながると同期する。

const DB_NAME = "tick_clone";
const JST_MS = 9 * 3600 * 1000;

// ---------- 小さな道具（サーバー側 store.py / dates と同じ規則の移植） ----------
const TAG_RE = /(?:(?<=\s)|^)#([^\s#\[\]()]+)/gm;
const TAG_TRAIL = "、。，．,.!?！？)）」』】]:;：；";
const FENCE_RE = /^(```|~~~).*?^\1/gms;

export function extractTags(body) {
  const text = body.replace(FENCE_RE, "");
  const seen = new Set(), out = [];
  for (const m of text.matchAll(TAG_RE)) {
    let t = m[1];
    while (t && TAG_TRAIL.includes(t[t.length - 1])) t = t.slice(0, -1);
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

export function makeTitle(body) {
  for (const line of body.split(/\r?\n/)) {
    let s = line.trim().replace(/^#+/, "").trim();
    if (s.startsWith("```") || s.startsWith("~~~")) continue;
    // [題名](URL) は題名だけ、![](画像) は取り除く（サーバーの make_title と同じ）
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
    if (s) return s.slice(0, 120);
  }
  return "";
}

const nowIso = () => new Date(Date.now() + JST_MS).toISOString().slice(0, 19) + "+09:00";
function newId() {
  const rnd = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return nowIso().slice(0, 19).replace(/[-:T]/g, (c) => (c === "T" ? "-" : "")) + "-" + rnd;
}
const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// ---------- 状態 ----------
const notes = new Map();   // id -> メモ（本文つき）
const outbox = new Map();  // id -> 未送信の操作 {id, kind:'create'|'put'|'delete', body, due, base, created, v}
const meta = { epoch: "", seq: 0 };
let idb = null;
const listeners = new Set(), statusListeners = new Set(), noticeListeners = new Set();
export const onChange = (f) => listeners.add(f);
export const onStatus = (f) => statusListeners.add(f);
export const onNotice = (f) => noticeListeners.add(f);
const emit = () => listeners.forEach((f) => f());
export const status = { online: navigator.onLine, syncing: false, pending: 0, error: "", persisted: false, lastSync: 0 };
function setStatus(p) {
  Object.assign(status, p, { pending: outbox.size });
  statusListeners.forEach((f) => f(status));
}
const notice = (m) => noticeListeners.forEach((f) => f(m));

// ---------- IndexedDB（使えなくてもメモリだけで動く） ----------
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("notes", { keyPath: "id" });
      d.createObjectStore("outbox", { keyPath: "id" });
      d.createObjectStore("meta");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const dirtyN = new Set(), dirtyO = new Set();
let dirtyMeta = false, persistTimer = null;
function schedulePersist() {
  if (!idb) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 300);
}
export async function persistNow() {
  if (!idb || !(dirtyN.size || dirtyO.size || dirtyMeta)) return;
  clearTimeout(persistTimer);
  const n = [...dirtyN], o = [...dirtyO], m = dirtyMeta;
  dirtyN.clear(); dirtyO.clear(); dirtyMeta = false;
  try {
    const tx = idb.transaction(["notes", "outbox", "meta"], "readwrite");
    for (const id of n) notes.has(id) ? tx.objectStore("notes").put(notes.get(id)) : tx.objectStore("notes").delete(id);
    for (const id of o) outbox.has(id) ? tx.objectStore("outbox").put(outbox.get(id)) : tx.objectStore("outbox").delete(id);
    if (m) tx.objectStore("meta").put({ ...meta }, "sync");
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  } catch (e) {
    n.forEach((x) => dirtyN.add(x)); o.forEach((x) => dirtyO.add(x)); dirtyMeta = dirtyMeta || m;
    setStatus({ error: "端末への保存に失敗: " + e });
  }
}
const touchNote = (id) => { dirtyN.add(id); schedulePersist(); };
const touchOp = (id) => { dirtyO.add(id); schedulePersist(); setStatus({}); };
const touchMeta = () => { dirtyMeta = true; schedulePersist(); };

export async function init() {
  try {
    idb = await openDb();
    const tx = idb.transaction(["notes", "outbox", "meta"], "readonly");
    const [ns, os, m] = await Promise.all([
      reqP(tx.objectStore("notes").getAll()), reqP(tx.objectStore("outbox").getAll()), reqP(tx.objectStore("meta").get("sync")),
    ]);
    ns.forEach((n) => notes.set(n.id, n));
    os.forEach((o) => outbox.set(o.id, o));
    if (m) Object.assign(meta, m);
    status.persisted = true;
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* 任意 */ }
  } catch (e) {
    idb = null; // プライベートモード等: この画面を開いている間だけ端末に持つ
    status.persisted = false;
  }
  setStatus({});
}

// ---------- 繰り返し（サーバーの recur.py と同じ決まり。変えるときは両方を直す） ----------
const RDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const wdOf = (ymd) => (new Date(Date.parse(ymd + "T00:00:00Z")).getUTCDay() + 6) % 7; // 月=0
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m は 1〜12
const p2d = (n) => String(n).padStart(2, "0");
const mkYmd = (y, m, d) => `${y}-${p2d(m)}-${p2d(d)}`;
const monthDay = (y, m, day) => mkYmd(y, m, day === -1 ? dim(y, m) : Math.min(day, dim(y, m)));

export function parseRule(rule) {
  if (!rule || typeof rule !== "string") return null;
  const parts = {};
  for (const tok of rule.trim().replace(/^(RRULE|ERULE):/i, "").split(";")) {
    const i = tok.indexOf("=");
    if (i > 0) parts[tok.slice(0, i).trim().toUpperCase()] = tok.slice(i + 1).trim().toUpperCase();
  }
  const freq = parts.FREQ;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return null;
  const r = { freq, interval, byday: [], bymonthday: null, bymonth: null, until: null };
  if (parts.BYDAY !== undefined) {
    for (const d of parts.BYDAY.split(",")) {
      const k = RDAYS.indexOf(d);
      if (k < 0) return null;
      r.byday.push(k);
    }
    if (freq !== "WEEKLY") return null;
  }
  for (const [key, lo, hi, prop] of [["BYMONTHDAY", -1, 31, "bymonthday"], ["BYMONTH", 1, 12, "bymonth"]]) {
    if (parts[key] !== undefined) {
      const v = Number(parts[key]);
      if (!Number.isInteger(v) || v < lo || v > hi || v === 0) return null;
      r[prop] = v;
    }
  }
  if (parts.UNTIL !== undefined) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL);
    if (!m) return null;
    r.until = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return r;
}

export function nextAfter(r, d) {
  const n = r.interval;
  let c;
  if (r.freq === "DAILY") c = addDays(d, n);
  else if (r.freq === "WEEKLY") {
    if (r.byday.length) {
      const week0 = addDays(d, -wdOf(d));
      c = null;
      for (let k = 1; k < 7 * n + 8; k++) {
        const x = addDays(d, k);
        if (r.byday.includes(wdOf(x)) && Math.floor(dayDiff(week0, addDays(x, -wdOf(x))) / 7) % n === 0) { c = x; break; }
      }
      if (c === null) return null;
    } else c = addDays(d, 7 * n);
  } else if (r.freq === "MONTHLY") {
    const y = +d.slice(0, 4), m = +d.slice(5, 7), dd = +d.slice(8, 10);
    const day = r.bymonthday !== null ? r.bymonthday : dd;
    const same = monthDay(y, m, day);
    if (r.bymonthday !== null && same > d) c = same;
    else { const t = y * 12 + (m - 1) + n; c = monthDay(Math.floor(t / 12), (t % 12) + 1, day); }
  } else {
    const y = +d.slice(0, 4);
    const mo = r.bymonth || +d.slice(5, 7), day = r.bymonthday !== null ? r.bymonthday : +d.slice(8, 10);
    c = monthDay(y, mo, day);
    if (c <= d) c = monthDay(y + n, mo, day);
  }
  return r.until && c > r.until ? null : c;
}

// 完了したとき、次の回。d より後で、かつ today 以降の最初の回（過ぎた回は飛ばす）
export function advanceRule(r, d, today) {
  let c = nextAfter(r, d);
  for (let i = 0; i < 800 && c !== null && c < today; i++) c = nextAfter(r, c);
  return c;
}

const WDJ = ["月", "火", "水", "木", "金", "土", "日"];
export function ruleLabel(rule) {
  const r = typeof rule === "string" ? parseRule(rule) : rule;
  if (!r) return "";
  const n = r.interval;
  if (r.freq === "DAILY") return n === 1 ? "毎日" : `${n}日ごと`;
  if (r.freq === "WEEKLY") {
    if (r.byday.length === 5 && [0, 1, 2, 3, 4].every((k) => r.byday.includes(k))) return "平日";
    const days = r.byday.length ? " " + [...r.byday].sort().map((k) => WDJ[k]).join("・") : "";
    return (n === 1 ? "毎週" : n === 2 ? "隔週" : `${n}週間ごと`) + days;
  }
  if (r.freq === "MONTHLY") {
    const d = r.bymonthday === -1 ? "末" : r.bymonthday ? `${r.bymonthday}日` : "";
    return (n === 1 ? "毎月" : `${n}か月ごと`) + d;
  }
  return (n === 1 ? "毎年" : `${n}年ごと`) + (r.bymonth ? ` ${r.bymonth}/${r.bymonthday || ""}` : "");
}

// ---------- 読み出し（画面用）。サーバー側 store.py の絞り込みと同じ意味 ----------
function normalize(n) {
  const dues = (n.dates || []).filter((x) => x[1] === "due").map((x) => x[0]).sort();
  return { ...n, dates: n.dates || [], due: dues.length ? dues.at(-1) : null, start: dues.length > 1 ? dues[0] : "", tags: n.tags || [], due_set: n.due_set || "", pinned: n.pinned || "", priority: n.priority || 0, due_time: n.due_time || "", event: n.event || "", repeat: n.repeat || "", repeat_sug: n.repeat_sug || "", list: n.list || "", completed: n.done && !n.abandoned ? (n.completed || "") : "", abandoned: !!n.abandoned, cancelled: n.abandoned ? (n.cancelled || "") : "", kind: n.kind === "task" ? "task" : "note", remind: n.remind || "", sort: typeof n.sort === "number" ? n.sort : null };
}

function matches(n, f) {
  if (f.done === "hide" && n.done) return false;
  if (f.done === "only" && !n.done) return false;
  if (f.inbox && n.list) return false; // 受信箱 = リスト未設定
  if (f.list && n.list !== f.list && !n.list.startsWith(f.list + "/")) return false; // フォルダを選ぶと、中のリストも含む
  if (f.tag && !n.tags.some((t) => t === f.tag || t.startsWith(f.tag + "/"))) return false;
  if (f.filter) { // 保存した絞り込み。状態（完了/未完了）の条件が無いときは、ふだんの一覧と同じく、完了したメモを除く
    if (f.filterOpenOnly && !filterHasStatus(f.filter) && n.done) return false;
    if (!filterMatch(n, f.filter, f.today)) return false;
  }
  const srcs = (f.src || "due,text").split(",");
  const vs = srcs.filter((s) => s === "due" || s === "text");
  const vsrcs = vs.length ? vs : ["due", "text"];
  const v = f.view || "all";
  if (v === "today" && f.today) { if (!n.dates.some(([d, s]) => d === f.today && vsrcs.includes(s))) return false; }
  else if (v === "week" && f.today) {
    const end = addDays(f.today, 6);
    if (!n.dates.some(([d, s]) => d >= f.today && d <= end && vsrcs.includes(s))) return false;
  } else if (v === "overdue" && f.today) {
    if (n.done || n.event || n.kind === "note" || !n.due || !(n.due < f.today)) return false; // 期日(due)の最後の日が今日より前。ノートは期限切れにならない
  } else if (v === "nodate") { if (n.dates.length) return false; }
  else if (v === "notes") { if (n.kind !== "note") return false; }
  if (f.date) {
    const hit = n.dates.some(([d, s]) => d === f.date && vs.includes(s))
      || (srcs.includes("created") && n.created.slice(0, 10) === f.date)
      || (srcs.includes("updated") && n.updated.slice(0, 10) === f.date)
      || (srcs.includes("completed") && n.done && !!n.completed && n.completed.slice(0, 10) === f.date);
    if (!hit) return false;
  }
  if (f.q) {
    const hay = n.body.toLowerCase();
    for (const w of f.q.trim().toLowerCase().split(/\s+/)) if (w && !hay.includes(w)) return false;
  }
  return true;
}

// ---------- 保存した絞り込み（フィルター） ----------
// flt = { match: "all" | "any", conds: [{ t, v, not }] }。条件は、まとめて「すべて満たす」か「どれかを満たす」。各条件は「除く」にもできる
// 状態の条件がある、または「完了・中止したメモも含める」（incDone）なら、完了したメモを、自動では除かない
export const filterHasStatus = (flt) => !!flt.incDone || (flt.conds || []).some((c) => c.t === "status" || c.t === "completed");
export function filterMatch(n, flt, today) {
  const conds = flt.conds || [];
  if (!conds.length) return true;
  const within = (iso, days) => { if (!iso) return false; const d = dayDiff(iso.slice(0, 10), today); return d >= 0 && d <= (+days || 0); };
  const test = (c) => {
    const v = c.v;
    switch (c.t) {
      case "list": return v === "" ? !n.list : n.list === v || n.list.startsWith(v + "/");
      case "tag": return n.tags.some((t) => t === v || t.startsWith(v + "/"));
      case "priority": return (n.priority || 0) === +v;
      case "kind": return n.kind === v;
      case "status": return v === "done" ? n.done : v === "completed" ? n.done && !n.abandoned : v === "abandoned" ? !!n.abandoned : !n.done; // done = 完了・中止（終わったもの全部）
      case "due": {
        const has = (a, b) => n.dates.some(([d, s]) => s === "due" && d >= a && d <= b);
        if (v === "today") return has(today, today);
        if (v === "tomorrow") return has(addDays(today, 1), addDays(today, 1));
        if (v === "next7") return has(today, addDays(today, 6));
        if (v === "overdue") return !n.done && !n.event && n.kind !== "note" && !!n.due && n.due < today;
        if (v === "nodate") return !n.due_set && !n.dates.some((x) => x[1] === "due");
        if (v === "hasdate") return n.dates.some((x) => x[1] === "due");
        return false;
      }
      case "event": return v === "event" ? !!n.event : !n.event && n.dates.some((x) => x[1] === "due");
      case "title": return (n.title || "").toLowerCase().includes(String(v).toLowerCase());
      case "text": return String(v).toLowerCase().split(/\s+/).filter(Boolean).every((w) => n.body.toLowerCase().includes(w));
      case "pinned": return !!n.pinned;
      case "completed": return n.done && within(n.completed, v);
      case "created": return within(n.created, v);
      case "updated": return within(n.updated, v);
      default: return false;
    }
  };
  const res = conds.map((c) => test(c) !== !!c.not);
  return flt.match === "any" ? res.some(Boolean) : res.every(Boolean);
}

export function list(f) {
  const out = [];
  for (const n of notes.values()) if (matches(n, f)) out.push(n);
  // ピン留めしたメモを先頭に。そのあとは、選んだ並び順（f.sort）で
  const sorter = SORTERS[f.sort] || SORTERS.updated;
  return out.sort((a, b) => (!!b.pinned - !!a.pinned) || ((a.pinned && b.pinned && f.sort !== "manual") ? cmpDesc(a.pinned, b.pinned) : 0) || sorter(a, b));
}

const cmpDesc = (x, y) => (x < y ? 1 : x > y ? -1 : 0);
// 手動の並べ替えの位置。未設定のメモは、更新が新しいほど小さい（上）値にして、並び順が自然につながるようにする
export const sortEff = (n) => (typeof n.sort === "number" ? n.sort : -(Date.parse(n.updated) / 1000));
const SORTERS = {
  updated: (a, b) => cmpDesc(a.updated, b.updated),
  created: (a, b) => cmpDesc(a.created, b.created),
  created_asc: (a, b) => cmpDesc(b.created, a.created),
  due: (a, b) => { const x = a.due || "9999", y = b.due || "9999"; return x < y ? -1 : x > y ? 1 : cmpDesc(a.updated, b.updated); },
  priority: (a, b) => (b.priority || 0) - (a.priority || 0) || cmpDesc(a.updated, b.updated),
  completed: (a, b) => cmpDesc(a.completed || "", b.completed || "") || cmpDesc(a.updated, b.updated), // 完了日が新しい順（完了日の無いものは後ろ）
  title: (a, b) => (a.title || "").localeCompare(b.title || "", "ja") || cmpDesc(a.updated, b.updated),
  manual: (a, b) => sortEff(a) - sortEff(b) || cmpDesc(a.updated, b.updated),
};

// 手動の並べ替え: v は位置（小さいほど上）。更新日は変えない
export function setSort(id, v) {
  const n = notes.get(id);
  if (!n || n.sort === v) return n || null;
  n.sort = v;
  touchNote(id);
  queue(n, { sort: v });
  emit();
  return n;
}

export function counts(done, today) {
  const out = { all: 0, today: 0, week: 0, overdue: 0, nodate: 0, notes: 0, done: 0 };
  for (const n of notes.values()) {
    if (n.done) out.done++;
    for (const v of ["all", "today", "week", "overdue", "nodate", "notes"]) if (matches(n, { done, view: v, today })) out[v]++;
  }
  return out;
}

export function tags(done) {
  const of = new Map(), real = new Set();
  for (const n of notes.values()) {
    for (const t of n.tags) real.add(t);
    if ((done === "hide" && n.done) || (done === "only" && !n.done)) continue;
    for (const t of n.tags) {
      const p = t.split("/");
      for (let i = 1; i <= p.length; i++) {
        const k = p.slice(0, i).join("/");
        if (!of.has(k)) of.set(k, new Set());
        of.get(k).add(n.id);
      }
    }
  }
  return [...of].map(([tag, s]) => ({ tag, count: s.size, real: real.has(tag) }))
    .sort((a, b) => (a.tag.toLowerCase() < b.tag.toLowerCase() ? -1 : 1));
}

// 左ペインのリスト一覧: [{name:"リスト"|"フォルダ/リスト", count}]（メモに付いているリストから集める。受信箱は含めない）
export function lists(done) {
  const m = new Map();
  for (const n of notes.values()) {
    if (!n.list) continue;
    if ((done === "hide" && n.done) || (done === "only" && !n.done)) { if (!m.has(n.list)) m.set(n.list, 0); continue; }
    m.set(n.list, (m.get(n.list) || 0) + 1);
  }
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export function inboxCount(done) {
  let c = 0;
  for (const n of notes.values()) if (!n.list && !(done === "hide" && n.done) && !(done === "only" && !n.done)) c++;
  return c;
}

export function calendar(month, src, done) {
  const srcs = src.split(",");
  const first = month + "-01";
  const lo = addDays(first, -7);
  const hi = addDays(new Date(Date.parse(first + "T00:00:00Z") + 35 * 86400000).toISOString().slice(0, 7) + "-01", 7);
  const days = new Map();
  const add = (d, n) => {
    if (d < lo || d >= hi) return;
    if (!days.has(d)) days.set(d, new Map());
    days.get(d).set(n.id, n);
  };
  for (const n of notes.values()) {
    if ((done === "hide" && n.done) || (done === "only" && !n.done)) continue;
    for (const [d, s] of n.dates) if (srcs.includes(s)) add(d, n);
    if (srcs.includes("created")) add(n.created.slice(0, 10), n);
    if (srcs.includes("updated")) add(n.updated.slice(0, 10), n);
    if (srcs.includes("completed") && n.done && n.completed) add(n.completed.slice(0, 10), n);
  }
  const out = {};
  for (const [d, m] of days) {
    out[d] = { n: m.size, items: [...m.values()].slice(0, 4).map((n) => ({ id: n.id, title: n.title, done: n.done })) };
  }
  return out;
}

// 大きな月カレンダー用: [lo, hi) の各日の、メモの一覧（時刻つきを先に、時刻の順）
export function calendarFull(lo, hi, src, done) {
  const srcs = src.split(",");
  const days = new Map();
  const add = (d, n, t, span, ghost) => {
    if (d < lo || d >= hi) return;
    if (!days.has(d)) days.set(d, new Map());
    const m = days.get(d), cur = m.get(n.id);
    if (!cur) m.set(n.id, { id: n.id, title: n.title, done: n.done, tags: n.tags, time: t || "", s: span ? n.start : "", e: span ? n.due : "", ghost: !!ghost });
    else if (!cur.time && t) cur.time = t;
  };
  for (const n of notes.values()) {
    if ((done === "hide" && n.done) || (done === "only" && !n.done)) continue;
    for (const x of n.dates) {
      if (!srcs.includes(x[1])) continue;
      add(x[0], n, x[1] === "due" ? (x[0] === n.due ? n.due_time + (n.due_time && /^\d\d:\d\d$/.test(n.event) ? "-" + n.event : "") : "") : x[2], x[1] === "due" && !!n.start);
    }
    const rule = srcs.includes("due") && !n.done && !n.start && n.due && n.repeat ? parseRule(n.repeat) : null;
    if (rule) { // 繰り返しのメモの、今後の回（薄く出すだけ。メモとして先に作るわけではない）
      const t = n.due_time + (n.due_time && /^\d\d:\d\d$/.test(n.event) ? "-" + n.event : "");
      let c = nextAfter(rule, n.due);
      for (let i = 0; i < 120 && c !== null && c < hi; i++, c = nextAfter(rule, c)) add(c, n, t, false, true);
    }
    if (srcs.includes("created")) add(n.created.slice(0, 10), n, "");
    if (srcs.includes("updated")) add(n.updated.slice(0, 10), n, "");
    if (srcs.includes("completed") && n.done && n.completed) add(n.completed.slice(0, 10), n, n.completed.slice(11, 16)); // 完了した時刻も出す
  }
  const out = {};
  for (const [d, m] of days) {
    out[d] = [...m.values()].sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || a.time.localeCompare(b.time));
  }
  return out;
}

export const get = (id) => notes.get(id) || null;
export const all = () => [...notes.values()];

// ---------- 書き込み（端末へ即時 → outbox → サーバーへ） ----------
// 注意: op.kind は送信の種別（create / put / delete）。メモの種類（note / task）は op.nk
function queue(n, patch) {
  let op = outbox.get(n.id);
  if (!op) op = { id: n.id, kind: n.base ? "put" : "create", body: n.body, due: null, base: n.base || null, created: n.created, v: 0 };
  op.body = n.body;
  Object.assign(op, patch);
  op.v++;
  outbox.set(n.id, op);
  touchOp(n.id);
  kick();
}

export function create(body = "", due = "", listName = "", kind = "task") {
  const ts = nowIso();
  const n = normalize({
    id: newId(), title: makeTitle(body), body, created: ts, updated: ts, done: false,
    due_set: due, tags: extractTags(body), dates: due ? [[due, "due"]] : [], base: null, list: listName, kind,
  });
  notes.set(n.id, n);
  touchNote(n.id);
  queue(n, { due: due || null, list: listName || undefined, nk: kind });
  emit();
  return n;
}

export function save(id, body) {
  const n = notes.get(id);
  if (!n || n.body === body) return n || null;
  Object.assign(n, { body, title: makeTitle(body), tags: extractTags(body), updated: nowIso() });
  touchNote(id);
  queue(n, {});
  emit();
  return n;
}

// v: "YYYY-MM-DD"（終日）/ "YYYY-MM-DDTHH:MM"（時刻つき）/ ""（期日を消す。リマインダーも消える）
export function setDue(id, v) {
  const n = notes.get(id);
  if (!n) return null;
  const day = v.slice(0, 10);
  const switched = !!n.due_set && !!v && !n.due_time !== (v.length < 16); // 終日 ⇄ 時刻つき の切り替え
  n.due_set = day;
  n.due_time = v.length >= 16 ? v.slice(11, 16) : "";
  if (!v) n.event = ""; // 期日を消すと、予定の印も消える（サーバーも同じ）
  if (!v || switched) n.remind = ""; // 期日を消す / 終日⇄時刻つき を切り替えたら、リマインダーは既定に戻る（サーバーも同じ）
  n.dates = n.dates.filter((x) => x[1] !== "due");
  if (day) n.dates.push([day, "due"]);
  const toTask = !!v && n.kind === "note"; // 期日を付けたノートはタスクになる（サーバーも同じ）
  if (toTask) n.kind = "task";
  Object.assign(n, normalize(n), { updated: nowIso() });
  touchNote(id);
  queue(n, { ...(switched ? { due: v, reminder: "", start: null } : { due: v, start: null }), ...(toTask ? { nk: "task" } : {}) }); // 期日を設定し直すと、複数日はいったん解除される（サーバーも同じ）
  emit();
  return n;
}

// 複数日: s（開始日 "YYYY-MM-DD"。期日が終わりの日）。""なら1日だけに戻す
export function setStart(id, st) {
  const n = notes.get(id);
  if (!n || !n.due_set) return n || null;
  if (st && st >= n.due_set) st = "";
  n.dates = n.dates.filter((x) => x[1] !== "due");
  if (st) for (let i = 0, d = st; d <= n.due_set && i <= 31; i++, d = addDays(d, 1)) n.dates.push([d, "due"]);
  else n.dates.push([n.due_set, "due"]);
  Object.assign(n, normalize(n), { updated: nowIso() });
  touchNote(id);
  queue(n, { start: st });
  emit();
  return n;
}

// 繰り返し: ""（やめる）/ "FREQ=WEEKLY;BYDAY=TU" など
export function setRepeat(id, rule) {
  const n = notes.get(id);
  if (!n || (n.repeat || "") === rule) return n || null;
  n.repeat = rule;
  n.updated = nowIso();
  touchNote(id);
  queue(n, { repeat: rule });
  emit();
  return n;
}

// 予定の印: ""（締切 = ふつうの期日）/ "1"（予定）/ "HH:MM"（予定。終わりの時刻つき）
export function setEvent(id, val) {
  const n = notes.get(id);
  if (!n || (n.event || "") === val) return n || null;
  n.event = val;
  n.updated = nowIso();
  touchNote(id);
  queue(n, { event: val });
  emit();
  return n;
}

// raw: ""（既定に戻す）/ "none"（通知しない）/ "-PT10M / PT0S" のような長さの列
export function setRemind(id, raw) {
  const n = notes.get(id);
  if (!n || (n.remind || "") === raw) return n || null;
  n.remind = raw;
  n.updated = nowIso();
  touchNote(id);
  queue(n, { reminder: raw });
  emit();
  return n;
}

// ---- リマインダーの長さ（サーバーの reminders.py と同じ決まり。前=正の分） ----
export const DEFAULT_ALLDAY = -540; // 終日の既定 = 当日の朝9:00
export function parseDuration(s) {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim().toUpperCase().replace(/^TRIGGER[:;]/, ""));
  if (!m || /^[+-]?PT?$/.test(s.trim().toUpperCase())) return null;
  const total = ((+m[2] || 0) * 7 + (+m[3] || 0)) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0) + Math.floor((+m[6] || 0) / 60);
  return m[1] === "-" ? total : -total;
}
export const fmtDuration = (b) => (b > 0 ? `-PT${b}M` : b === 0 ? "PT0S" : `PT${-b}M`);
// 設定の文字列 → 分のリスト。未設定は既定（終日=当日朝9時 / 時刻つき=期日の時刻）、"none" は []
export function remindMinutes(raw, allday) {
  const r = (raw || "").trim();
  if (!r) return [allday ? DEFAULT_ALLDAY : 0];
  if (r.toLowerCase() === "none") return [];
  const out = [];
  for (const p of r.split("/")) { const v = parseDuration(p); if (v !== null && !out.includes(v)) out.push(v); }
  return out.length ? out : [allday ? DEFAULT_ALLDAY : 0];
}
export const remindRaw = (mins) => (mins.length ? [...new Set(mins)].sort((a, b) => b - a).map(fmtDuration).join(" / ") : "none");
export function remindLabel(b, allday) {
  if (allday) { // 終日の期日は、期日の日の0:00 が基準。通知する時刻を「何日前の何時」で言う（9540分前 → 7日前の朝9:00）。サーバーの reminders.label と同じ決まり
    const notify = -b, day = Math.floor(notify / 1440), tod = notify - day * 1440;
    const dw = day === 0 ? "当日" : day === -1 ? "前日" : day < 0 ? `${-day}日前` : `${day}日後`;
    return dw + "の" + (tod === 540 ? "朝9:00" : `${Math.floor(tod / 60)}:${String(tod % 60).padStart(2, "0")}`);
  }
  if (b === 0) return "期日の時刻に";
  if (b === 1440) return "前日の同じ時刻";
  const m = Math.abs(b), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60; // 「6日15時間」「1時間30分」「10分」
  return (d ? `${d}日` : "") + (h ? `${h}時間` : "") + (mi ? `${mi}分` : "") + (b > 0 ? "前" : "後");
}

export function setPinned(id, pinned) {
  const n = notes.get(id);
  if (!n || !!n.pinned === pinned) return n || null;
  n.pinned = pinned ? nowIso().slice(0, 16) : "";
  n.updated = nowIso();
  touchNote(id);
  queue(n, { pinned });
  emit();
  return n;
}

// ---- 振り返り（メモ末尾の「## 振り返り」の節）。サーバーの store.add_recap_line と同じ決まり ----
// text が空: 手で書くための行「- 日付 」を足す（直前の行が、自動の「- 日付 ✓」「- 日付 中止」なら、その行の続きに書けるようにする）
// text がある: 自動の記録の行「- 日付 text」を足す（同じ行が、すでにあれば、何もしない）
export function addRecapLine(body, ymdStr, text = "") {
  const lines = body.replace(/\s+$/, "").split("\n");
  const bullet = `- ${ymdStr} ${text}`;
  const h = lines.findIndex((l) => /^##[ \t]*振り返り[ \t]*$/.test(l));
  if (h < 0) return lines.join("\n") + "\n\n## 振り返り\n" + bullet + "\n";
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) if (/^#{1,6}[ \t]+\S/.test(lines[i])) { end = i; break; }
  let at = end;
  while (at > h + 1 && lines[at - 1].trim() === "") at--;
  if (text) { if (lines.slice(h + 1, at).some((l) => l.startsWith(bullet))) return body; }
  else {
    const last = lines[at - 1] || "";
    const m = new RegExp(`^- ${ymdStr} (✓|中止)[ \\t]*$`).exec(last);
    if (at - 1 > h && m) { lines[at - 1] = `- ${ymdStr} ${m[1]} `; return lines.join("\n") + "\n"; }
  }
  lines.splice(at, 0, bullet);
  return lines.join("\n") + "\n";
}

// 種類: "task"（完了できる）/ "note"（読み物・資料。○を付けない）
export function setKind(id, kind) {
  const n = notes.get(id);
  if (!n || n.kind === kind) return n || null;
  n.kind = kind;
  n.updated = nowIso();
  touchNote(id);
  queue(n, { nk: kind });
  emit();
  return n;
}

// リスト: "" = 受信箱（リストなし）/ "リスト" / "フォルダ/リスト"
export function setList(id, name) {
  const n = notes.get(id);
  name = (name || "").split("/").map((x) => x.trim()).filter(Boolean).join("/");
  if (!n || (n.list || "") === name) return n || null;
  n.list = name;
  n.updated = nowIso();
  touchNote(id);
  queue(n, { list: name });
  emit();
  return n;
}

export function setPriority(id, p) {
  const n = notes.get(id);
  if (!n || (n.priority || 0) === p) return n || null;
  n.priority = p;
  n.updated = nowIso();
  touchNote(id);
  queue(n, { priority: p });
  emit();
  return n;
}

// done: 終わりにする / 戻す。cancel: 「中止（キャンセル）」として終わりにする（完了日＝実績には数えない）
export function setDone(id, done, cancel = false) {
  const n = notes.get(id);
  if (!n || n.done === done) return n || null;
  const rule = done && n.repeat && n.due_set ? parseRule(n.repeat) : null;
  const nxt = rule ? advanceRule(rule, n.due_set, new Date().toLocaleDateString("sv-SE")) : null;
  if (nxt) { // 繰り返すメモ: 完了にせず、期日を次の回へ（サーバーも同じ計算をする）
    const span = n.start ? dayDiff(n.start, n.due_set) : 0;
    n.due_set = nxt;
    n.dates = n.dates.filter((x) => x[1] !== "due");
    for (let i = span; i >= 0; i--) n.dates.push([addDays(nxt, -i), "due"]);
    n.body = addRecapLine(n.body, new Date().toLocaleDateString("sv-SE"), cancel ? "中止" : "✓"); // 回ごとの記録を、「## 振り返り」へ（サーバーも同じ。二重にはならない）
    Object.assign(n, normalize(n), { updated: nowIso() });
    touchNote(id);
    queue(n, { status: cancel ? "abandoned" : "done" });
    emit();
    return n;
  }
  n.done = done;
  n.abandoned = !!(done && cancel);
  n.status = done ? (cancel ? "abandoned" : "done") : "open";
  n.completed = done && !cancel ? nowIso().slice(0, 16) : ""; // 完了した日時（サーバーも同じ。中止には付けない）
  n.cancelled = done && cancel ? nowIso().slice(0, 16) : "";
  n.updated = nowIso();
  touchNote(id);
  queue(n, { status: n.status });
  emit();
  return n;
}

export function remove(id) {
  const n = notes.get(id);
  if (!n) return;
  notes.delete(id);
  touchNote(id);
  const op = outbox.get(id);
  if (op && op.kind === "create") outbox.delete(id); // まだサーバーに無いメモは、送らずに消すだけ
  else outbox.set(id, { id, kind: "delete", base: n.base, v: (op ? op.v : 0) + 1 });
  touchOp(id);
  kick();
  emit();
}

// ---------- 同期 ----------
const http = async (method, url, body) => {
  const r = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) location.href = "/login"; // アクセストークンが設定されていて、まだログインしていない（または切れた）
  return r;
};

let uiChanged = false; // 画面に見える変化があったか（無ければ一覧を作り直さない）

function adoptServerNote(s, keepLocalBody) {
  uiChanged = true;
  const cur = notes.get(s.id);
  const merged = normalize({ ...(cur || {}), ...s, dates: s.dates || (cur ? cur.dates : []), base: s.updated });
  if (keepLocalBody && cur) Object.assign(merged, { body: cur.body, title: cur.title, tags: cur.tags, updated: cur.updated });
  notes.set(s.id, merged);
  touchNote(s.id);
}

let flushing = false;
async function flush() {
  if (flushing || !navigator.onLine) return true;
  flushing = true;
  try {
    for (const op of [...outbox.values()]) {
      const v = op.v;
      let r;
      try {
        if (op.kind === "create") r = await http("POST", "/api/notes", { body: op.body, id: op.id, created: op.created, due: op.due || undefined, status: op.status || undefined, pinned: op.pinned || undefined, priority: op.priority || undefined, reminder: op.reminder || undefined, event: op.event || undefined, start: op.start || undefined, repeat: op.repeat || undefined, list: op.list || undefined, kind: op.nk || undefined, sort: op.sort ?? undefined });
        else if (op.kind === "put") r = await http("PUT", "/api/notes/" + op.id, { body: op.body, due: op.due, base: op.base, status: op.status || null, pinned: op.pinned ?? null, priority: op.priority ?? null, reminder: op.reminder ?? null, event: op.event ?? null, start: op.start ?? null, repeat: op.repeat ?? null, list: op.list ?? null, kind: op.nk ?? null, sort: op.sort ?? null });
        else r = await http("DELETE", "/api/notes/" + op.id);
      } catch { return false; } // 通信できない: 残りは次の機会に
      if (r.status >= 500) return false;
      if (r.status === 409) {
        // 他の端末が先に更新していた: こちらの編集は別メモとして残し、元のメモはサーバーの版にする
        const j = await r.json();
        const local = notes.get(op.id);
        const mine = (local ? local.body : op.body) + "\n\n---\n⚠ 競合: 元のメモ(" + op.id + ")を他の端末が先に更新していたため、この端末での編集を別メモとして残しました\n";
        outbox.delete(op.id); touchOp(op.id);
        adoptServerNote(j.server);
        create(mine);
        notice("競合: この端末での編集を、別メモとして残しました");
        continue;
      }
      if (!r.ok && r.status !== 404) { // 400など: 再送しても通らない操作は捨てて、止まらないようにする
        outbox.delete(op.id); touchOp(op.id);
        notice(`送信できない操作を破棄しました (${op.kind} ${r.status})`);
        continue;
      }
      if (op.kind === "delete" || r.status === 404) {
        if (outbox.get(op.id) === op) { outbox.delete(op.id); touchOp(op.id); }
        continue;
      }
      const s = await r.json();
      if (outbox.get(op.id) && outbox.get(op.id).v === v) {
        outbox.delete(op.id); touchOp(op.id);
        adoptServerNote(s, false);
      } else { // 送信中にさらに編集された: 本文は端末の版を残し、次回は新しい base で送る
        adoptServerNote(s, true);
        const o = outbox.get(op.id);
        if (o) { o.kind = "put"; o.base = s.updated; touchOp(op.id); }
      }
    }
    return true;
  } finally {
    flushing = false;
    setStatus({});
  }
}

async function pull() {
  const r = await fetch(`/api/sync?since=${meta.seq}&epoch=${encodeURIComponent(meta.epoch)}`);
  if (r.status === 401) { location.href = "/login"; return; }
  if (!r.ok) throw new Error("sync " + r.status);
  const j = await r.json();
  if (j.epoch !== meta.epoch) { // 初回、またはサーバーの索引が作り直された: 全件取り直し
    for (const id of [...notes.keys()]) if (!outbox.has(id)) { notes.delete(id); touchNote(id); }
  }
  for (const n of j.notes) {
    if (outbox.has(n.id)) continue; // 未送信の編集がある: 競合は送信時に判定される
    notes.set(n.id, normalize({ ...n, base: n.updated }));
    touchNote(n.id);
    uiChanged = true;
  }
  for (const id of j.deleted) if (!outbox.has(id) && notes.delete(id)) { touchNote(id); uiChanged = true; }
  meta.epoch = j.epoch;
  meta.seq = j.seq;
  touchMeta();
}

let syncing = false, again = false;
export async function sync() {
  if (!navigator.onLine) return setStatus({ online: false });
  if (syncing) { again = true; return; }
  syncing = true;
  setStatus({ syncing: true, online: true });
  let failed = false;
  try {
    const ok = await flush();
    if (ok === false) throw new TypeError("送信できない"); // 通信できなかった
    await pull();
    if (outbox.size) await flush();
    setStatus({ error: "", online: true, lastSync: Date.now() });
    if (uiChanged) { uiChanged = false; emit(); } // 変化が無い定期同期では、画面を作り直さない
  } catch (e) {
    failed = true;
    // 通信できない（サーバーに届かない）ときは「オフライン」と表示し、それ以外の失敗だけエラーにする
    const unreachable = e instanceof TypeError;
    setStatus({ error: unreachable ? "" : "同期できませんでした", online: unreachable ? false : navigator.onLine });
  } finally {
    syncing = false;
    setStatus({ syncing: false });
    if (again) { again = false; kick(); }
    else if (failed) kick(15000); // つながるまで15秒おきに再試行（画面が見えている間だけ実際に動く）
  }
}

let kickTimer = null;
export function kick(ms = 800) {
  clearTimeout(kickTimer);
  kickTimer = setTimeout(sync, ms);
}

export function startAutoSync() {
  window.addEventListener("online", () => { setStatus({ online: true }); sync(); });
  window.addEventListener("offline", () => setStatus({ online: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistNow();
    else sync();
  });
  window.addEventListener("pagehide", persistNow);
  setInterval(() => { if (document.visibilityState === "visible") sync(); }, 30000);
  sync();
}
