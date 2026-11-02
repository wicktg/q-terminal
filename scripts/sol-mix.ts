// EMA stack, AVWAP ribbon and CVD together. Locked rule first, then each ingredient removed, then variations.
// Run: node --experimental-strip-types --no-warnings scripts/sol-mix.ts SOL
import { EXITS, runCoin, simOne, type Cfg, type Env, type Exit, type Tf, type Trade } from "../lib/mtf.ts";
import { rng } from "../lib/model.ts";
import { DAY, envs, loadCoin, summary, universe, type Coin } from "./mtf-lib.ts";
import { deltaShare, ribbon } from "./ribbon-lib.ts";

const sym = process.argv[2] ?? "SOL";
const btc = loadCoin("BTC")!;
const TRAIL = EXITS.trend[0];

type P = { tf: Tf; ema: "stack" | "fast" | "long" | "off"; touch: "ema20" | "ema50" | "ribbon" | "any"; rib: boolean; cvd: "none" | "perp" | "spot" | "both"; N: number; k: number };
const memo = new Map<Env, Map<string, Int8Array>>();
function signal(e: Env, p: P) {
  let m = memo.get(e);
  if (!m) memo.set(e, (m = new Map()));
  const key = JSON.stringify(p);
  const hit = m.get(key);
  if (hit) return hit;
  const { c, o, h, l, n } = e.b;
  const { top, bot } = ribbon(e.b, p.N);
  const [e20, e50, e200, A] = [e.x.ema(20), e.x.ema(50), e.x.ema(200), e.x.atr()];
  const pd = deltaShare(e.b, p.k);
  const sd = e.spotD;
  const s = new Int8Array(n);
  const flow = (i: number, d: number) => {
    const perp = d * pd[i] > 0;
    const spot = !!sd && d * sd[i] > 0;
    return p.cvd === "none" ? true : p.cvd === "perp" ? perp : p.cvd === "spot" ? spot : perp && spot;
  };
  const trend = (i: number, d: number) => {
    if (p.ema === "off") return true;
    if (p.ema === "long") return d * (c[i] - e200[i]) > 0;
    if (p.ema === "fast") return d * (e20[i] - e50[i]) > 0;
    return d > 0 ? e20[i] > e50[i] && e50[i] > e200[i] : e20[i] < e50[i] && e50[i] < e200[i];
  };
  for (let i = 3; i < n; i++) {
    if (!Number.isFinite(top[i])) continue;
    const pad = 0.1 * A[i];
    const hold = (d: number, lvl: number) => (d > 0 ? l[i] <= lvl + pad && c[i] > lvl : h[i] >= lvl - pad && c[i] < lvl);
    for (const d of [1, -1]) {
      const edge = d > 0 ? top[i] : bot[i];
      const side = !p.rib || d * (c[i] - edge) > 0;
      const candle = d * (c[i] - o[i]) > 0;
      if (!side || !candle || !trend(i, d) || !flow(i, d)) continue;
      const clear = d * (c[i] - e20[i]) > 0; // always closes back on the trend side of the fast EMA
      const t = p.touch === "ema20" ? hold(d, e20[i]) : p.touch === "ema50" ? hold(d, e50[i]) : p.touch === "ribbon" ? hold(d, edge) : hold(d, e20[i]) || hold(d, e50[i]) || hold(d, edge);
      if (clear && t) {
        s[i] = d;
        break;
      }
    }
  }
  m.set(key, s);
  return s;
}

const setups = new Map<string, Map<Tf, Env>>();
const coinOf = new Map<string, Coin>();
function env(name: string, tf: Tf) {
  let c = coinOf.get(name);
  if (!c) coinOf.set(name, (c = (name === "BTC" ? btc : loadCoin(name)) as Coin));
  let t = setups.get(name);
  if (!t) setups.set(name, (t = new Map()));
  let e = t.get(tf);
  if (!e) t.set(tf, (e = envs([c], btc, tf)[0]));
  return { e, c };
}
const trades = (name: string, p: P, side: 0 | 1 | -1, ex: Exit, htf = "none") => {
  const { e, c } = env(name, p.tf);
  const cfg: Cfg = { fam: "mix", tf: p.tf, p: {}, side, htf, ex };
  return runCoin(e, signal(e, p), cfg, c.fund, 0);
};
const { c: coin } = env(sym, "1h");
const asOf = coin.base.t[coin.base.n - 1] + 300;
const from60 = asOf - 60 * DAY;
const from30 = asOf - 30 * DAY;
const first = coin.base.t[0];
const fmt = (l: string, tr: Trade[], a: number, b: number) => {
  const s = summary(tr, a, b);
  const tot = s.avg * s.n;
  return `${l.padEnd(32)} ${String(s.n).padStart(4)} trades  win ${(s.win * 100).toFixed(0).padStart(3)}%  ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)}R  total ${tot >= 0 ? "+" : ""}${tot.toFixed(1)}R  t ${s.t.toFixed(2)}`;
};

const LOCK: P = { tf: "1h", ema: "stack", touch: "any", rib: true, cvd: "both", N: 300, k: 24 };
const lock = trades(sym, LOCK, 0, TRAIL);
console.log(`=== LOCKED RULE on ${sym}`);
console.log(fmt("Last 60 days", lock, from60, asOf + DAY));
console.log(fmt("First 30 of them", lock, from60, from30));
console.log(fmt("Last 30 days", lock, from30, asOf + DAY));
console.log(fmt("Earlier history", lock, first, from60));
for (const t of lock.filter((x) => x.tIn >= from60)) console.log(`    ${new Date(t.tIn * 1000).toISOString().slice(0, 16).replace("T", " ")} ${t.side > 0 ? "LONG " : "SHORT"} ${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R`);

console.log("\n=== TAKE ONE INGREDIENT OUT (last 60 days, then earlier history)");
for (const [name, p] of [["Full mix", LOCK], ["No ribbon", { ...LOCK, rib: false }], ["No EMA stack", { ...LOCK, ema: "off" }], ["No CVD", { ...LOCK, cvd: "none" }], ["EMA stack only", { ...LOCK, rib: false, cvd: "none" }]] as [string, P][]) {
  const tr = trades(sym, p, 0, TRAIL);
  console.log(fmt(name, tr, from60, asOf + DAY));
  console.log(fmt("   earlier", tr, first, from60));
}

const { e: e1, c: c1 } = env(sym, "1h");
const inWin = lock.filter((t) => t.tIn >= from60);
const start = e1.b.t.findIndex((t) => t >= from60);
const r = rng(7);
const means: number[] = [];
for (let run = 0; run < 2000; run++) {
  let [s, n] = [0, 0];
  for (const t of inWin) {
    const x = simOne(e1, start + Math.floor(r() * (e1.b.n - start - 2)), t.side, TRAIL, c1.fund, 1, 0);
    if (x) {
      s += x.r;
      n++;
    }
  }
  means.push(n ? s / n : 0);
}
means.sort((a, b) => a - b);
const actual = inWin.reduce((s, t) => s + t.r, 0) / (inWin.length || 1);
console.log(`\nrandom timing: average ${(means.reduce((s, x) => s + x, 0) / means.length).toFixed(2)}R, 95th percentile ${means[1900].toFixed(2)}R. Locked rule ${actual.toFixed(2)}R, beats ${((means.filter((x) => x < actual).length / means.length) * 100).toFixed(0)}% of random runs`);

console.log("\n=== SAME LOCKED RULE ON THE OTHER COINS (last 60 days | earlier history)");
let [posA, posB, cnt] = [0, 0, 0];
let [sum60, n60, sumE, nE] = [0, 0, 0, 0];
for (const s of [...universe.watch, ...universe.hold]) {
  const tr = trades(s, LOCK, 0, TRAIL);
  const [a, b] = [summary(tr, from60, asOf + DAY), summary(tr, first, from60)];
  cnt++;
  if (a.avg > 0) posA++;
  if (b.avg > 0) posB++;
  sum60 += a.avg * a.n;
  n60 += a.n;
  sumE += b.avg * b.n;
  nE += b.n;
  console.log(`  ${s.padEnd(5)} ${String(a.n).padStart(3)} ${a.avg.toFixed(2).padStart(6)}R | ${String(b.n).padStart(3)} ${b.avg.toFixed(2).padStart(6)}R`);
}
console.log(`  all coins: ${n60} trades ${(sum60 / (n60 || 1)).toFixed(3)}R, positive on ${posA} of ${cnt} | ${nE} trades ${(sumE / (nE || 1)).toFixed(3)}R, positive on ${posB} of ${cnt}`);

const grid: { p: P; side: 0 | 1 | -1; ex: Exit; htf: string; label: string; tr: Trade[] }[] = [];
for (const tf of ["15m", "1h", "4h"] as Tf[])
  for (const ema of ["stack", "fast", "long"] as const)
    for (const touch of ["ema20", "ema50", "ribbon", "any"] as const)
      for (const cvd of ["none", "perp", "spot", "both"] as const)
        for (const N of [120, 300])
          for (const k of [12, 24])
            for (const side of [0, 1, -1] as const)
              for (const htf of ["none", "d50"])
                for (const ex of EXITS.trend) {
                  const p: P = { tf, ema, touch, rib: true, cvd, N, k };
                  grid.push({ p, side, ex, htf, label: `${tf} ${ema} ${touch} cvd:${cvd} N${N} k${k} ${side === 0 ? "both" : side > 0 ? "long" : "short"} ${htf} ${ex.target ? `${ex.stop}ATR ${ex.target}R` : `${ex.stop}ATR trail ${ex.trail}`}`, tr: trades(sym, p, side, ex, htf) });
                }
const st = summary;
const able = grid.filter((g) => st(g.tr, from60, from30).n >= 4).sort((x, y) => st(y.tr, from60, from30).avg - st(x.tr, from60, from30).avg);
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
console.log(`\n=== VARIATIONS: ${grid.length} tried, ${able.length} with 4+ trades in the first 30 days`);
for (const g of able.slice(0, 6)) {
  const [a, b, c] = [st(g.tr, from60, from30), st(g.tr, from30, asOf + DAY), st(g.tr, first, from60)];
  console.log(`${g.label.padEnd(58)} first30 ${a.n}/${a.avg.toFixed(2)}R | last30 ${b.n}/${b.avg.toFixed(2)}R | earlier ${c.n}/${c.avg.toFixed(2)}R t${c.t.toFixed(1)}`);
}
const top = able.slice(0, Math.max(1, Math.floor(able.length / 10)));
console.log(`last 30 days: top 10% picks ${mean(top.map((g) => st(g.tr, from30, asOf + DAY).avg)).toFixed(3)}R, all variations ${mean(able.map((g) => st(g.tr, from30, asOf + DAY).avg)).toFixed(3)}R`);
console.log(`positive on first 30 AND last 30 AND earlier history (5+ trades each): ${able.filter((g) => { const [a, b, c] = [st(g.tr, from60, from30), st(g.tr, from30, asOf + DAY), st(g.tr, first, from60)]; return a.avg > 0 && b.avg > 0 && c.avg > 0 && b.n >= 5 && c.n >= 30; }).length} of ${able.length}`);
