// 日本の祝日（計算で出す。ネットには出ない）。1980〜2099年の春分・秋分の近似式を使う。
// 返すもの: { "YYYY-MM-DD": "祝日名" }
const p2 = (n) => String(n).padStart(2, "0");
const key = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
const dayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
// m月の第n月曜日の「日」
function nthMonday(y, m, n) {
  const first = dayOf(y, m, 1);
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}
const cache = new Map();

export function holidays(y) {
  if (cache.has(y)) return cache.get(y);
  const h = {};
  const add = (m, d, name) => { h[key(y, m, d)] = name; };
  const eq = (base) => Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  add(1, 1, "元日");
  add(1, nthMonday(y, 1, 2), "成人の日");
  if (y >= 1967) add(2, 11, "建国記念の日");
  if (y >= 2020) add(2, 23, "天皇誕生日");
  add(3, eq(20.8431), "春分の日");
  add(4, 29, y >= 2007 ? "昭和の日" : "みどりの日");
  add(5, 3, "憲法記念日");
  if (y >= 2007) add(5, 4, "みどりの日");
  add(5, 5, "こどもの日");
  const sea = y === 2020 ? 23 : y === 2021 ? 22 : nthMonday(y, 7, 3);
  add(7, sea, "海の日");
  if (y >= 2016) add(8, y === 2020 ? 10 : y === 2021 ? 8 : 11, "山の日");
  add(9, nthMonday(y, 9, 3), "敬老の日");
  add(9, eq(23.2488), "秋分の日");
  const sports = y === 2020 ? 24 : y === 2021 ? 23 : nthMonday(y, 10, 2);
  add(10, sports, y >= 2020 ? "スポーツの日" : "体育の日");
  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");
  // 国民の休日: 前日と翌日が祝日の平日（秋分の日の前日など）
  for (const k of Object.keys(h)) {
    const [yy, mm, dd] = k.split("-").map(Number);
    const mid = new Date(Date.UTC(yy, mm - 1, dd + 1));
    const nxt = new Date(Date.UTC(yy, mm - 1, dd + 2));
    const ks = (t) => key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    if (h[ks(nxt)] && !h[ks(mid)] && mid.getUTCDay() !== 0) h[ks(mid)] = "国民の休日";
  }
  // 振替休日: 日曜の祝日は、次の祝日でない日に
  for (const k of Object.keys(h).sort()) {
    const [yy, mm, dd] = k.split("-").map(Number);
    if (dayOf(yy, mm, dd) !== 0) continue;
    let t = new Date(Date.UTC(yy, mm - 1, dd + 1));
    const ks = (x) => key(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
    while (h[ks(t)]) t = new Date(t.getTime() + 86400000);
    if (t.getUTCFullYear() === y) h[ks(t)] = "振替休日";
  }
  cache.set(y, h);
  return h;
}

export const holidayName = (s) => holidays(+s.slice(0, 4))[s] || "";
