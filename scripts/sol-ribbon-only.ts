// The AVWAP ribbon alone: entries, stops and exits all come from it.
// Run: node --experimental-strip-types --no-warnings scripts/sol-ribbon-only.ts SOL
import { COST, TF_SEC, type Env, type Fund, type Tf } from "../lib/mtf.ts";
import { rng } from "../lib/model.ts";
import { DAY, envs, loadCoin, universe, type Coin } from "./mtf-lib.ts";
import { ribbon } from "./ribbon-lib.ts";

type Mode = "break" | "retest" | "fade";
type P = { tf: Tf; mode: Mode; N: number; cap: number; far: number };
type Tr = { tIn: number; tOut: number; r: number; side: number };

const sym = process.argv[2] ?? "SOL";
const btc = loadCoin("BTC")!;
const fundAt = (f: Fund, T: number) => {
  let [a, b] = [0, f.t.length];
  while (a < b) {
    const m = (a + b) >> 1;
    if (f.t[m] <= T) a = m + 1;
    else b = m;
  }
  return a ? f.cum[a - 1] : 0;
};

type Rb = { top: Float64Array; bot: Float64Array };
const ribs = new Map<Env, Map<number, Rb>>();
function rb(e: Env, N: number) {
  let m = ribs.get(e);
  if (!m) ribs.set(e, (m = new Map()));
  let r = m.get(N);
  if (!r) m.set(N, (r = ribbon(e.b, N)));
  return r;
}

function fire(e: Env, r: Rb, p: P, i: number) {
  const { c, o, h, l } = e.b;
  const { top, bot } = r;
  const A = e.x.atr();
  if (!Number.isFinite(top[i]) || !Number.isFinite(top[i - 3])) return 0;
  if (p.mode === "break") {
    if (c[i] > top[i] && c[i - 1] <= top[i - 1]) return 1;
    if (c[i] < bot[i] && c[i - 1] >= bot[i - 1]) return -1;
  } else if (p.mode === "retest") {
    const above = c[i - 1] > top[i - 1] && c[i - 2] > top[i - 2] && c[i - 3] > top[i - 3];
    const below = c[i - 1] < bot[i - 1] && c[i - 2] < bot[i - 2] && c[i - 3] < bot[i - 3];
    if (above && l[i] <= top[i] && c[i] > top[i] && c[i] > o[i]) return 1;
    if (below && h[i] >= bot[i] && c[i] < bot[i] && c[i] < o[i]) return -1;
  } else {
    const [now, was] = [(c[i] - top[i]) / A[i], (c[i - 1] - top[i - 1]) / A[i - 1]];
    const [dn, wasD] = [(bot[i] - c[i]) / A[i], (bot[i - 1] - c[i - 1]) / A[i - 1]];
    if (now >= p.far && was < p.far) return -1;
    if (dn >= p.far && wasD < p.far) return 1;
  }
  return 0;
}

function sim(e: Env, r: Rb, p: P, i0: number, d: number, fund: Fund): { tr: Tr; end: number } | null {
  const { o, h, l, c, t, n } = e.b;
  const A = e.x.atr();
  const { top, bot } = r;
  const at = i0 + 1;
  if (at >= n - 1) return null;
  const entry = o[at];
  let stop: number;
  if (p.mode === "fade") stop = entry - d * 1.5 * A[i0];
  else {
    const far = d > 0 ? bot[i0] : top[i0];
    const dist = Math.max(0.5 * A[i0], Math.min(d * (entry - far), p.cap * A[i0]));
    stop = entry - d * dist;
  }
  const risk = d * (entry - stop);
  if (risk <= 0) return null;
  const end = Math.min(n - 1, at + 500);
  let [exit, last, fee] = [c[end], end, COST.taker];
  for (let k = at; k <= end; k++) {
    if (d > 0 ? l[k] <= stop : h[k] >= stop) {
      exit = d > 0 ? Math.min(stop, o[k]) : Math.max(stop, o[k]);
      last = k;
      break;
    }
    if (p.mode === "fade") {
      const goal = d > 0 ? bot[k] : top[k]; // the magnet: the near edge of the ribbon
      if (k > at && (d > 0 ? h[k] >= goal : l[k] <= goal)) {
        exit = goal;
        last = k;
        fee = COST.maker;
        break;
      }
    } else if (d * (c[k] - (d > 0 ? top[k] : bot[k])) < 0 && k + 1 < n) {
      exit = o[k + 1]; // closed back inside: out at the next open
      last = k + 1;
      break;
    }
  }
  const span = TF_SEC[e.tf];
  const [tIn, tOut] = [t[at], t[last] + span];
  const paid = d * (fundAt(fund, tOut) - fundAt(fund, tIn));
  const r2 = (d * (exit / entry - 1) - (COST.taker + fee) - paid) / (risk / entry);
  return { tr: { tIn, tOut, r: r2, side: d }, end: last };
}

function run(e: Env, c: Coin, p: P, side: number) {
  const r = rb(e, p.N);
  const out: Tr[] = [];
  let free = 0;
  for (let i = p.N + 4; i < e.b.n - 2; i++) {
    if (i <= free) continue;
    const d = fire(e, r, p, i);
    if (!d || (side && d !== side)) continue;
    const s = sim(e, r, p, i, d, c.fund);
    if (s) {
      out.push(s.tr);
      free = s.end;
    }
  }
  return out;
}

const summ = (tr: Tr[], a: number, b: number) => {
  const x = tr.filter((t) => t.tIn >= a && t.tIn < b);
  const n = x.length;
  const total = x.reduce((s, t) => s + t.r, 0);
  const v = new Map<number, number>();
  for (const t of x) v.set(Math.floor(t.tOut / DAY), (v.get(Math.floor(t.tOut / DAY)) ?? 0) + t.r);
  const days = Math.max(1, Math.floor((Math.min(b, 4e9) - a) / DAY));
  const m = total / days;
  let ss = 0;
  for (const y of v.values()) ss += (y - m) ** 2;
  ss += (days - v.size) * m * m;
  const sd = Math.sqrt(ss / Math.max(1, days - 1));
  return { n, total, avg: n ? total / n : 0, win: n ? x.filter((t) => t.r > 0).length / n : 0, t: sd ? (m / sd) * Math.sqrt(days) : 0 };
};
const envOf = new Map<string, Env>();
const coins = new Map<string, Coin>();
const get = (s: string, tf: Tf) => {
  let c = coins.get(s);
  if (!c) coins.set(s, (c = (s === "BTC" ? btc : loadCoin(s)) as Coin));
  const k = `${s}|${tf}`;
  let e = envOf.get(k);
  if (!e) envOf.set(k, (e = envs([c], btc, tf)[0]));
  return { c, e };
};
const main = get(sym, (process.env.TF ?? "1h") as Tf);
const asOf = main.c.base.t[main.c.base.n - 1] + 300;
const [from60, from30, first] = [asOf - 60 * DAY, asOf - 30 * DAY, main.c.base.t[0]];
const end = asOf + DAY;
const row = (l: string, tr: Tr[], a: number, b: number) => {
  const s = summ(tr, a, b);
  return `${l.padEnd(30)} ${String(s.n).padStart(4)} trades  win ${(s.win * 100).toFixed(0).padStart(3)}%  ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)}R  total ${s.total >= 0 ? "+" : ""}${s.total.toFixed(1)}R  t ${s.t.toFixed(2)}`;
};

const LOCK_TF = (process.env.TF ?? "1h") as Tf; // TF and CAP rerun the breakout rule on another setting
const LOCKED: [string, P][] = [
  ["Breakout hold", { tf: LOCK_TF, mode: "break", N: 300, cap: Number(process.env.CAP ?? 3), far: 3 }],
  ["Retest hold", { tf: "1h", mode: "retest", N: 300, cap: 3, far: 3 }],
  ["Stretch fade", { tf: "1h", mode: "fade", N: 300, cap: 3, far: 3 }],
];
console.log(`=== LOCKED RULES on ${sym}`);
for (const [name, p] of LOCKED) {
  const tr = run(main.e, main.c, p, 0);
  console.log(row(`${name}, last 60 days`, tr, from60, end));
  console.log(row("   first 30", tr, from60, from30));
  console.log(row("   last 30", tr, from30, end));
  console.log(row("   earlier 640 days", tr, first, from60));
  console.log(row("   longs, 60 days", tr.filter((t) => t.side > 0), from60, end));
  console.log(row("   shorts, 60 days", tr.filter((t) => t.side < 0), from60, end));
  // Random entries, same count and sides, same ribbon exits.
  const inWin = tr.filter((t) => t.tIn >= from60);
  const r = rb(main.e, p.N);
  const start = main.e.b.t.findIndex((t) => t >= from60);
  const R = rng(9);
  const means: number[] = [];
  for (let x = 0; x < 2000; x++) {
    let [s, c] = [0, 0];
    for (const t of inWin) {
      const q = sim(main.e, r, p, start + Math.floor(R() * (main.e.b.n - start - 3)), t.side, main.c.fund);
      if (q) {
        s += q.tr.r;
        c++;
      }
    }
    means.push(c ? s / c : 0);
  }
  means.sort((a, b) => a - b);
  const act = summ(tr, from60, end).avg;
  console.log(`   random timing avg ${(means.reduce((s, v) => s + v, 0) / means.length).toFixed(2)}R, 95th pct ${means[1900].toFixed(2)}R, this beats ${((means.filter((v) => v < act).length / means.length) * 100).toFixed(0)}%`);
  let [pos, posE, cnt, a60, n60, aE, nE] = [0, 0, 0, 0, 0, 0, 0];
  const each: string[] = [];
  for (const s of [...universe.watch, ...universe.hold]) {
    const { c, e } = get(s, (process.env.TF ?? "1h") as Tf);
    const t2 = run(e, c, p, 0);
    const [a, b] = [summ(t2, from60, end), summ(t2, first, from60)];
    cnt++;
    if (a.avg > 0) pos++;
    if (b.avg > 0) posE++;
    a60 += a.total;
    n60 += a.n;
    aE += b.total;
    nE += b.n;
    each.push(`${s} ${a.avg.toFixed(2)}`);
  }
  console.log(`   all 16 coins: last 60 ${n60} trades ${(a60 / (n60 || 1)).toFixed(3)}R, positive on ${pos} | earlier ${nE} trades ${(aE / (nE || 1)).toFixed(3)}R, positive on ${posE}`);
  console.log(`   ${each.join("  ")}\n`);
}

const grid: { p: P; side: number; label: string; tr: Tr[] }[] = [];
for (const tf of ["15m", "1h", "4h"] as Tf[])
  for (const mode of ["break", "retest", "fade"] as Mode[])
    for (const N of [120, 300, 500])
      for (const side of [0, 1, -1])
        for (const x of [2, 3, 4]) {
          const p: P = { tf, mode, N, cap: x, far: x };
          const { c, e } = get(sym, tf);
          grid.push({ p, side, label: `${tf} ${mode} N${N} ${side === 0 ? "both" : side > 0 ? "long" : "short"} ${mode === "fade" ? `far ${x}` : `cap ${x}`}`, tr: run(e, c, p, side) });
        }
const able = grid.filter((g) => summ(g.tr, from60, from30).n >= 4).sort((a, b) => summ(b.tr, from60, from30).avg - summ(a.tr, from60, from30).avg);
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
console.log(`=== VARIATIONS: ${grid.length} tried, ${able.length} with 4+ trades in the first 30 days`);
for (const g of able.slice(0, 8)) {
  const [a, b, c] = [summ(g.tr, from60, from30), summ(g.tr, from30, end), summ(g.tr, first, from60)];
  console.log(`${g.label.padEnd(30)} first30 ${a.n}/${a.avg.toFixed(2)}R | last30 ${b.n}/${b.avg.toFixed(2)}R | earlier ${c.n}/${c.avg.toFixed(2)}R t${c.t.toFixed(1)}`);
}
const top = able.slice(0, Math.max(1, Math.floor(able.length / 10)));
console.log(`last 30 days: top 10% picks ${mean(top.map((g) => summ(g.tr, from30, end).avg)).toFixed(3)}R, all ${mean(able.map((g) => summ(g.tr, from30, end).avg)).toFixed(3)}R`);
const steady = able.filter((g) => {
  const [a, b, c] = [summ(g.tr, from60, from30), summ(g.tr, from30, end), summ(g.tr, first, from60)];
  return a.avg > 0 && b.avg > 0 && c.avg > 0 && b.n >= 4 && c.n >= 30;
});
console.log(`positive in all three periods: ${steady.length} of ${able.length}`);
for (const g of steady.slice(0, 6)) {
  const [a, b, c] = [summ(g.tr, from60, from30), summ(g.tr, from30, end), summ(g.tr, first, from60)];
  console.log(`  ${g.label.padEnd(30)} first30 ${a.n}/${a.avg.toFixed(2)}R | last30 ${b.n}/${b.avg.toFixed(2)}R | earlier ${c.n}/${c.avg.toFixed(2)}R t${c.t.toFixed(1)}`);
}
console.log("\nby rule across all settings, both sides (last 60 | earlier):");
for (const m of ["break", "retest", "fade"]) {
  const g = grid.filter((x) => x.p.mode === m && x.side === 0);
  console.log(`  ${m.padEnd(7)} ${mean(g.map((x) => summ(x.tr, from60, end).avg)).toFixed(3)}R | ${mean(g.map((x) => summ(x.tr, first, from60).avg)).toFixed(3)}R`);
}
