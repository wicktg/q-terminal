// Short new perp listings. Robot James reports the average new Binance perp decays for about 100 days,
// but his rules are paywalled, so these rules are mine. Locked before this ever ran:
//   grid     wait 1/3/7/14 days, hold 14/30/60 days, stop +30/50/100%/none, filter none/funding not negative/below day one/pumped
//   costs    0.4% round trip because new perps are thin, plus actual funding
//   choice   the best grid point by t on listings before the validation date, nothing later
// Pass marks, all required:
//   unseen months: avg > 0 and t >= 1, at least 30 listings / excess over the liquid-coin basket > 0 with t >= 1 on the unseen months
//   excess over the basket > 0 before that too / both BTC regimes positive / eight time blocks, five positive
//   double costs positive / best five trades removed positive / 75% of neighbouring grid points positive
//   block bootstrap under 5% / deflated Sharpe at least 0.90 against the cumulative trial count
// The last 30 days are reported only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rng } from "../lib/model.ts";

const DAY = 86400;
const dir = resolve(import.meta.dirname, "../data");
const L = JSON.parse(readFileSync(resolve(dir, "listings.json"), "utf8")) as { asOf: number; coins: Record<string, { on: number; status: string; bars: number[][]; funding: number[][] }> };
const W = JSON.parse(readFileSync(resolve(dir, "wide.json"), "utf8")) as { bars: Record<string, { t: number; c: number; q: number }[]> };
const asOf = Math.floor(L.asOf / 1000);
const finalFrom = asOf - 30 * DAY;
const validFrom = asOf - 210 * DAY;
const coins = Object.entries(L.coins);
console.log(`listings ${coins.length}, delisted or halted ${coins.filter(([, c]) => c.status !== "TRADING").length}`);

// Liquid basket for the control: top 40 by trailing 30-day volume on the day.
const close: Record<string, Map<number, { c: number; q: number }>> = {};
for (const [s, b] of Object.entries(W.bars)) close[s] = new Map(b.map((x) => [x.t, x]));
const basketMemo = new Map<number, string[]>();
function basket(day: number) {
  let b = basketMemo.get(day);
  if (b) return b;
  b = Object.keys(close)
    .flatMap((s) => {
      let v = 0;
      for (let k = 1; k <= 30; k++) v += close[s].get(day - k * DAY)?.q ?? 0;
      return close[s].get(day) && v ? [{ s, v }] : [];
    })
    .sort((x, y) => y.v - x.v)
    .slice(0, 40)
    .map((x) => x.s);
  basketMemo.set(day, b);
  return b;
}
function marketRet(a: number, z: number) {
  const [d0, d1] = [a - (a % DAY), z - (z % DAY)];
  const r = basket(d0).flatMap((s) => {
    const [x, y] = [close[s].get(d0)?.c, close[s].get(d1)?.c];
    return x && y ? [y / x - 1] : [];
  });
  return r.length ? r.reduce((s, v) => s + v, 0) / r.length : 0;
}
const btc = (W.bars.BTCUSDT ?? []).map((x) => x.c);
const btcT = (W.bars.BTCUSDT ?? []).map((x) => x.t);
const btcE = new Map<number, number>();
{
  let e = btc[0];
  btc.forEach((c, i) => {
    e = c * (2 / 51) + e * (1 - 2 / 51);
    btcE.set(btcT[i], c > e ? 1 : -1);
  });
}

type Cfg = { wait: number; hold: number; stop: number; filter: string };
type Tr = { sym: string; tIn: number; tOut: number; r: number; excess: number; regime: number; daily: [number, number][] };
const FEE = 0.004;

function trade(sym: string, c: (typeof L.coins)[string], g: Cfg, fee: number): Tr | null {
  const start = c.on + g.wait * DAY;
  const i = c.bars.findIndex((b) => b[0] >= start);
  if (i < 1) return null;
  const entry = c.bars[i][1];
  const dayOne = c.bars[Math.min(5, i - 1)][4];
  const lastF = [...c.funding].reverse().find((f) => f[0] <= c.bars[i][0])?.[1] ?? 0;
  if (g.filter === "fund" && lastF < 0) return null;
  if (g.filter === "below" && entry >= dayOne) return null;
  if (g.filter === "pumped" && entry < dayOne * 1.3) return null;
  const end = c.bars[i][0] + g.hold * DAY;
  let prev = entry;
  let exit = entry;
  let at = c.bars[i][0];
  const daily: [number, number][] = [[c.bars[i][0], -fee / 2]];
  for (let k = i; k < c.bars.length && c.bars[k][0] < end; k++) {
    const b = c.bars[k];
    const lvl = entry * (1 + g.stop);
    if (g.stop && b[2] >= lvl) {
      exit = Math.max(lvl, b[1]);
      at = b[0] + 14400;
      daily.push([at, -(exit - prev) / entry]);
      break;
    }
    exit = b[4];
    at = b[0] + 14400;
    daily.push([at, -(b[4] - prev) / entry]);
    prev = b[4];
  }
  let fund = 0;
  for (const f of c.funding)
    if (f[0] > c.bars[i][0] && f[0] <= at) {
      fund += f[1];
      daily.push([f[0], f[1]]);
    }
  daily.push([at, -fee / 2]);
  const r = -(exit / entry - 1) - fee + fund;
  return { sym, tIn: c.bars[i][0], tOut: at, r, excess: r + marketRet(c.bars[i][0], at), regime: btcE.get(c.bars[i][0] - (c.bars[i][0] % DAY)) ?? 0, daily };
}

const runGrid = (g: Cfg, fee = FEE) => coins.flatMap(([s, c]) => trade(s, c, g, fee) ?? []);
function series(tr: Tr[], from: number, to: number) {
  const a = Math.floor(from / DAY);
  const v = new Float64Array(Math.max(1, Math.floor(to / DAY) - a));
  for (const x of tr) for (const [t, p] of x.daily) {
    const k = Math.floor(t / DAY) - a;
    if (k >= 0 && k < v.length) v[k] += p;
  }
  return v;
}
const stat = (tr: Tr[], from: number, to: number, key: "r" | "excess" = "r") => {
  const p = tr.filter((x) => x.tIn >= from && x.tIn < to);
  const n = p.length;
  const avg = p.reduce((s, x) => s + x[key], 0) / (n || 1);
  const sd = Math.sqrt(p.reduce((s, x) => s + (x[key] - avg) ** 2, 0) / Math.max(1, n - 1));
  // Listings cluster in time, so the t-stat uses weekly groups of trades.
  const wk = new Map<number, number>();
  for (const x of p) {
    const k = Math.floor(x.tIn / (7 * DAY));
    wk.set(k, (wk.get(k) ?? 0) + x[key]);
  }
  const w = [...wk.values()];
  const wm = w.reduce((s, x) => s + x, 0) / (w.length || 1);
  const ws = Math.sqrt(w.reduce((s, x) => s + (x - wm) ** 2, 0) / Math.max(1, w.length - 1));
  return { n, avg, sd, t: ws ? (wm / ws) * Math.sqrt(w.length) : 0 };
};

const start = Math.min(...coins.map(([, c]) => c.on));
const grid: Cfg[] = [];
for (const wait of [1, 3, 7, 14]) for (const hold of [14, 30, 60]) for (const stop of [0.3, 0.5, 1, 0]) for (const filter of ["none", "fund", "below", "pumped"]) grid.push({ wait, hold, stop, filter });
const scored = grid.map((g) => {
  const tr = runGrid(g);
  return { g, tr, d: stat(tr, start, validFrom) };
});
const best = [...scored].filter((x) => x.d.n >= 40).sort((a, b) => b.d.t - a.d.t)[0];
const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
const show = (l: string, s: ReturnType<typeof stat>) => console.log(`${l.padEnd(34)} n ${String(s.n).padStart(4)}  avg ${pc(s.avg).padStart(7)}  t ${s.t.toFixed(2).padStart(5)}`);
console.log(`grid ${grid.length}, best on discovery: wait ${best.g.wait}d hold ${best.g.hold}d stop ${best.g.stop || "none"} filter ${best.g.filter}`);
show("discovery", best.d);
show("discovery, excess over basket", stat(best.tr, start, validFrom, "excess"));
const v = stat(best.tr, validFrom, finalFrom);
const ve = stat(best.tr, validFrom, finalFrom, "excess");
show("unseen months", v);
show("unseen months, excess over basket", ve);
const pre = (x: Tr) => x.tIn < finalFrom;
const all = best.tr.filter(pre);
const preE = stat(best.tr, start, validFrom, "excess");
const reg = (s: number) => stat(all.filter((x) => x.regime === s), start, finalFrom);
show("BTC above its 50-day", reg(1));
show("BTC below its 50-day", reg(-1));
const size = (finalFrom - start) / 8;
const blocks = Array.from({ length: 8 }, (_, i) => all.filter((x) => x.tIn >= start + i * size && x.tIn < start + (i + 1) * size).reduce((s, x) => s + x.r, 0));
const dbl = stat(runGrid(best.g, FEE * 2).filter(pre), start, finalFrom);
show("double costs", dbl);
const sorted = [...all].sort((a, b) => b.r - a.r);
const noBest = stat(sorted.slice(5), start, finalFrom);
show("best five trades removed", noBest);
console.log(`biggest single loss ${pc(Math.min(...all.map((x) => x.r)))}`);
const near = scored.filter((x) => x.g !== best.g && x.g.filter === best.g.filter && [x.g.wait === best.g.wait, x.g.hold === best.g.hold, x.g.stop === best.g.stop].filter(Boolean).length === 2);
const nearPos = near.filter((x) => stat(x.tr, start, finalFrom).avg > 0).length / (near.length || 1);
const day = series(all, start, finalFrom);
const r = rng(3);
let bad = 0;
for (let n = 0; n < 5000; n++) {
  let s = 0;
  let i = Math.floor(r() * day.length);
  for (let k = 0; k < day.length; k++) {
    s += day[i];
    i = r() < 0.1 ? Math.floor(r() * day.length) : (i + 1) % day.length;
  }
  if (s <= 0) bad++;
}
const bootP = bad / 5000;
const m = day.reduce((s, x) => s + x, 0) / day.length;
const sd = Math.sqrt(day.reduce((s, x) => s + (x - m) ** 2, 0) / (day.length - 1));
const dailyT = (m / sd) * Math.sqrt(day.length);
// About 30,000 variations have been tried across every round, which needs a t near 4.3 by luck alone.
const luck = Math.sqrt(2 * Math.log(30000));
const checks: [string, boolean][] = [
  ["unseen months: avg > 0, t >= 1, 30+ listings", v.avg > 0 && v.t >= 1 && v.n >= 30],
  ["unseen months beat the basket, t >= 1", ve.avg > 0 && ve.t >= 1],
  ["earlier months beat the basket", preE.avg > 0],
  ["both BTC regimes positive", reg(1).avg > 0 && reg(-1).avg > 0],
  ["five of eight time blocks positive", blocks.filter((x) => x > 0).length >= 5],
  ["double costs positive", dbl.avg > 0],
  ["best five trades removed positive", noBest.avg > 0],
  ["75% of neighbours positive", nearPos >= 0.75],
  ["block bootstrap under 5%", bootP < 0.05],
  [`deflated: daily t ${dailyT.toFixed(2)} beats luck ${luck.toFixed(2)}`, dailyT >= luck],
];
console.log("");
for (const [l, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${l}`);
console.log(`\n${checks.filter((c) => c[1]).length}/${checks.length} ${checks.every((c) => c[1]) ? "VERDICT: PASSED" : "VERDICT: FAILED"}  blocks ${blocks.filter((x) => x > 0).length}/8  neighbours ${(nearPos * 100).toFixed(0)}%  boot p ${bootP}`);
show("last 30 days", stat(best.tr, finalFrom, asOf + 1));
show("last 30 days, excess", stat(best.tr, finalFrom, asOf + 1, "excess"));
