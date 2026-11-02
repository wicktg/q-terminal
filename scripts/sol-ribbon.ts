// CVD plus AVWAP ribbon. Locked rule first, then variations, on the last 60 days of one coin.
// Run: node --experimental-strip-types --no-warnings scripts/sol-ribbon.ts SOL
import { EXITS, runCoin, simOne, type Cfg, type Env, type Exit, type Tf, type Trade } from "../lib/mtf.ts";
import { rng } from "../lib/model.ts";
import { asOfOf, DAY, envs, loadCoin, summary, type Coin } from "./mtf-lib.ts";
import { deltaShare, ribbon } from "./ribbon-lib.ts";

const sym = process.argv[2] ?? "SOL";
const btc = loadCoin("BTC")!;
const coin = (sym === "BTC" ? btc : loadCoin(sym)) as Coin;
const asOf = asOfOf(coin);
const from60 = asOf - 60 * DAY;
const from30 = asOf - 30 * DAY;
const first = coin.base.t[0];

type P = { tf: Tf; mode: "reclaim" | "retest"; cvd: "none" | "perp" | "spot" | "both"; N: number; k: number };
function signal(e: Env, p: P) {
  const { c, o, h, l, n } = e.b;
  const { top, bot } = ribbon(e.b, p.N);
  const pd = deltaShare(e.b, p.k);
  const sd = e.spotD;
  const s = new Int8Array(n);
  const ok = (i: number, d: number) => {
    const perp = d * pd[i] > 0;
    const spot = !!sd && d * sd[i] > 0;
    return p.cvd === "none" ? true : p.cvd === "perp" ? perp : p.cvd === "spot" ? spot : perp && spot;
  };
  for (let i = 3; i < n; i++) {
    if (!Number.isFinite(top[i]) || !Number.isFinite(top[i - 3])) continue;
    if (p.mode === "reclaim") {
      if (c[i] > top[i] && c[i - 1] <= top[i - 1] && ok(i, 1)) s[i] = 1;
      else if (c[i] < bot[i] && c[i - 1] >= bot[i - 1] && ok(i, -1)) s[i] = -1;
    } else {
      const above = c[i - 1] > top[i - 1] && c[i - 2] > top[i - 2] && c[i - 3] > top[i - 3];
      const below = c[i - 1] < bot[i - 1] && c[i - 2] < bot[i - 2] && c[i - 3] < bot[i - 3];
      if (above && l[i] <= top[i] && c[i] > top[i] && c[i] > o[i] && ok(i, 1)) s[i] = 1;
      else if (below && h[i] >= bot[i] && c[i] < bot[i] && c[i] < o[i] && ok(i, -1)) s[i] = -1;
    }
  }
  return s;
}

const ENV = new Map<Tf, Env>();
const env = (tf: Tf) => {
  let e = ENV.get(tf);
  if (!e) ENV.set(tf, (e = envs([coin], btc, tf)[0]));
  return e;
};
const trades = (p: P, side: 0 | 1 | -1, ex: Exit) => {
  const e = env(p.tf);
  const cfg: Cfg = { fam: "ribbon", tf: p.tf, p: {}, side, htf: "none", ex };
  return runCoin(e, signal(e, p), cfg, coin.fund, 0);
};
const fmt = (l: string, tr: Trade[], a: number, b: number) => {
  const s = summary(tr, a, b);
  const tot = s.avg * s.n;
  return `${l.padEnd(34)} ${String(s.n).padStart(4)} trades  win ${(s.win * 100).toFixed(0).padStart(3)}%  ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)}R  total ${tot >= 0 ? "+" : ""}${tot.toFixed(1)}R  t ${s.t.toFixed(2)}`;
};
const px = (T: number) => {
  const b = coin.base;
  let i = 0;
  while (i + 1 < b.n && b.t[i + 1] <= T) i++;
  return b.c[i];
};
console.log(`${sym}: ${new Date(from60 * 1000).toISOString().slice(0, 10)} to ${new Date(asOf * 1000).toISOString().slice(0, 10)}, price ${px(from60).toFixed(2)} to ${px(asOf).toFixed(2)} (${((px(asOf) / px(from60) - 1) * 100).toFixed(1)}%)`);

// ---- locked rule
const TRAIL = EXITS.trend[0];
const lockR: P = { tf: "1h", mode: "reclaim", cvd: "both", N: 300, k: 24 };
const lockT: P = { ...lockR, mode: "retest" };
console.log("\n=== LOCKED RULE: 1H, 300-bar ribbon, perp and spot CVD agree over 24 bars, 1.5 ATR stop, 3 ATR trail");
for (const [name, p] of [["Reclaim", lockR], ["Retest", lockT]] as [string, P][]) {
  const tr = trades(p, 0, TRAIL);
  console.log(fmt(`${name}, last 60 days`, tr, from60, asOf + DAY));
  console.log(fmt(`${name}, earlier ${Math.round((from60 - first) / DAY)} days`, tr, first, from60));
  console.log(fmt(`${name} without CVD, last 60 days`, trades({ ...p, cvd: "none" }, 0, TRAIL), from60, asOf + DAY));
  for (const t of tr.filter((x) => x.tIn >= from60)) console.log(`    ${new Date(t.tIn * 1000).toISOString().slice(0, 16).replace("T", " ")} ${t.side > 0 ? "LONG " : "SHORT"} ${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R`);
}

// ---- random timing, same count, sides and exit, inside the 60 days
const lockTr = [...trades(lockR, 0, TRAIL), ...trades(lockT, 0, TRAIL)].filter((t) => t.tIn >= from60);
const e1 = env("1h");
const start = e1.b.t.findIndex((t) => t >= from60);
const r = rng(7);
const means: number[] = [];
for (let run = 0; run < 2000; run++) {
  let [s, c] = [0, 0];
  for (const t of lockTr) {
    const x = simOne(e1, start + Math.floor(r() * (e1.b.n - start - 2)), t.side, TRAIL, coin.fund, 1, 0);
    if (x) {
      s += x.r;
      c++;
    }
  }
  means.push(c ? s / c : 0);
}
means.sort((a, b) => a - b);
const actual = lockTr.reduce((s, t) => s + t.r, 0) / (lockTr.length || 1);
console.log(`\nrandom timing: average ${(means.reduce((s, x) => s + x, 0) / means.length).toFixed(2)}R, 95th percentile ${means[1900].toFixed(2)}R. Locked rules ${actual.toFixed(2)}R, beats ${((means.filter((x) => x < actual).length / means.length) * 100).toFixed(0)}% of random runs`);

// ---- variations: picked on the first 30 days, judged on the last 30
const grid: { p: P; side: 0 | 1 | -1; ex: Exit; label: string; tr: Trade[] }[] = [];
for (const tf of ["15m", "1h", "4h"] as Tf[])
  for (const mode of ["reclaim", "retest"] as const)
    for (const cvd of ["none", "perp", "spot", "both"] as const)
      for (const N of [120, 300, 500])
        for (const k of [12, 24])
          for (const side of [0, 1, -1] as const)
            for (const ex of EXITS.trend) {
              const p = { tf, mode, cvd, N, k };
              grid.push({ p, side, ex, label: `${tf} ${mode} cvd:${cvd} N${N} k${k} ${side === 0 ? "both" : side > 0 ? "long" : "short"} ${ex.target ? `${ex.stop}ATR ${ex.target}R` : `${ex.stop}ATR trail ${ex.trail}`}`, tr: trades(p, side, ex) });
            }
const avg = (tr: Trade[], a: number, b: number) => summary(tr, a, b);
const able = grid.filter((g) => avg(g.tr, from60, from30).n >= 5).sort((x, y) => avg(y.tr, from60, from30).avg - avg(x.tr, from60, from30).avg);
console.log(`\n=== VARIATIONS: ${grid.length} tried, ${able.length} with 5+ trades in the first 30 days`);
console.log("top 8 on the first 30 days, then the last 30 and everything before:");
for (const g of able.slice(0, 8)) {
  const [a, b, c] = [avg(g.tr, from60, from30), avg(g.tr, from30, asOf + DAY), avg(g.tr, first, from60)];
  console.log(`${g.label.padEnd(50)} first30 ${a.n}/${a.avg.toFixed(2)}R | last30 ${b.n}/${b.avg.toFixed(2)}R | earlier ${c.n}/${c.avg.toFixed(2)}R t${c.t.toFixed(1)}`);
}
const top = able.slice(0, Math.max(1, Math.floor(able.length / 10)));
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
console.log(`\nlast 30 days, top 10% picks: ${mean(top.map((g) => avg(g.tr, from30, asOf + DAY).avg)).toFixed(3)}R, every variation: ${mean(able.map((g) => avg(g.tr, from30, asOf + DAY).avg)).toFixed(3)}R`);
console.log("does CVD help? average over all variations, last 60 days:");
for (const c of ["none", "perp", "spot", "both"]) {
  const g = grid.filter((x) => x.p.cvd === c && x.side === 0 && avg(x.tr, from60, asOf + DAY).n >= 3);
  console.log(`  ${c.padEnd(5)} ${mean(g.map((x) => avg(x.tr, from60, asOf + DAY).avg)).toFixed(3)}R across ${g.length}; earlier history ${mean(g.map((x) => avg(x.tr, first, from60).avg)).toFixed(3)}R`);
}
