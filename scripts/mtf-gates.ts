// Gate stage: a strategy counts only if it passes EVERY independent test. Locked before any search result existed.
//
// Shortlist, from DISCOVERY on watchlist coins only:
//   enough trades, avg >= 0.05R, t >= 2, positive on 8+ of 14 coins, positive in both halves. Top 6 per family and timeframe.
// Gates:
//   G1  unseen months     validation period on watchlist coins: avg > 0, t >= 1
//   G2  unseen coins      holdout coins, whole pre-final period: avg > 0, t >= 1.5, half of the coins positive
//   G3  time blocks       eight equal blocks: at least five positive
//   G4  PBO               combinatorial cross-validation inside its family and timeframe: below 0.5
//   G5  deflated Sharpe   adjusted for the effective number of trials: at least 0.90
//   G6  friction          double costs, and a one-bar late entry: both still positive
//   G7  parameter jitter  every parameter moved up and down: 75% stay positive, median at least 40% of base
//   G8  regimes           BTC above and below its 50-day: neither side negative (20+ trades needed to judge)
//   G9  alpha             daily results regressed on BTC: alpha t >= 1.5
//   G10 block bootstrap   chance that the true total is zero or less: below 5%
//   G11 random timing     same coins, sides and exits at random moments: beats the 95th percentile
//   G12 synthetic paths   same strategy on 30 reshuffled price histories: beats the 90th percentile
// The last 30 days are reported, never gated: four weeks cannot prove anything.
// Run: node --experimental-strip-types --no-warnings scripts/mtf-gates.ts 1h
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { emaA, FAMILY, makeEnv, resample, runCoin, simOne, TF_SEC, TFS, type Cfg, type Cols, type Env, type Tf, type Trade } from "../lib/mtf.ts";
import { ols } from "../lib/quant.ts";
import { rng } from "../lib/model.ts";
import { asOfOf, barsAt, dailySeries, DAY, envs, loadCoin, OUT, summary, universe, type Coin } from "./mtf-lib.ts";

const tf = process.argv[2] as Tf;
const only = process.argv[3];
const tag = only ? `-${only}` : "";
const MIN_N: Record<Tf, number> = { "5m": 150, "15m": 150, "1h": 100, "4h": 60, "1d": 30 };
const PATHS = 30;

type Row = { id: string; cfg: Cfg; n: number; win: number; avg: number; t: number; pos: number; h1: number; h2: number; bins: number[] };
type File = { tf: Tf; trials: number; asOf: number; start: number; validFrom: number; finalFrom: number; nBins: number; rows: Row[] };
const files = [...TFS.map((x) => resolve(OUT, `search-${x}.json`)), resolve(OUT, "search-1h-vote.json"), ...TFS.map((x) => resolve(OUT, `search-${x}-n.json`)), ...TFS.map((x) => resolve(OUT, `search-${x}-smc.json`)), ...TFS.map((x) => resolve(OUT, `search-${x}-lab.json`))].filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")) as File);
const me = JSON.parse(readFileSync(resolve(OUT, `search-${tf}${tag}.json`), "utf8")) as File;
const { start, validFrom, finalFrom, asOf } = me;
const allRows = files.flatMap((f) => f.rows);
const totalTrials = files.reduce((s, f) => s + f.trials, 0);

// ---- statistics -----------------------------------------------------------------------

function invNorm(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -invNorm(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function normCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const z = Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
  const p = z * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// Trials are heavily correlated, so the honest count sits between 1 and the raw total.
function effectiveTrials() {
  const usable = allRows.filter((r) => r.n >= MIN_N[r.cfg.tf]);
  const r = rng(5);
  const pick = Array.from({ length: Math.min(300, usable.length) }, () => usable[Math.floor(r() * usable.length)].bins);
  let [sum, cnt] = [0, 0];
  for (let i = 0; i < pick.length; i++)
    for (let j = i + 1; j < pick.length; j++) {
      const [a, b] = [pick[i], pick[j]];
      const n = Math.min(a.length, b.length);
      const [ma, mb] = [a.reduce((s, x) => s + x, 0) / n, b.reduce((s, x) => s + x, 0) / n];
      let [ab, aa, bb] = [0, 0, 0];
      for (let k = 0; k < n; k++) {
        ab += (a[k] - ma) * (b[k] - mb);
        aa += (a[k] - ma) ** 2;
        bb += (b[k] - mb) ** 2;
      }
      if (aa && bb) {
        sum += ab / Math.sqrt(aa * bb);
        cnt++;
      }
    }
  const rho = Math.max(0, cnt ? sum / cnt : 0);
  const days = (validFrom - start) / DAY;
  const srs = usable.map((x) => x.t / Math.sqrt(days));
  const m = srs.reduce((s, x) => s + x, 0) / srs.length;
  return { rho, N: rho + (1 - rho) * totalTrials, srVar: srs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, srs.length - 1) };
}

function deflated(v: Float64Array, N: number, srVar: number) {
  const T = v.length;
  const m = v.reduce((s, x) => s + x, 0) / T;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (T - 1)) || 1;
  const sr = m / sd;
  let [g3, g4] = [0, 0];
  for (const x of v) {
    const z = (x - m) / sd;
    g3 += z ** 3 / T;
    g4 += z ** 4 / T;
  }
  const e = 0.5772156649;
  const sr0 = Math.sqrt(srVar) * ((1 - e) * invNorm(1 - 1 / Math.max(2, N)) + e * invNorm(1 - 1 / (Math.max(2, N) * Math.E)));
  return normCdf(((sr - sr0) * Math.sqrt(T - 1)) / Math.sqrt(Math.max(1e-9, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr)));
}

// Combinatorially symmetric cross-validation: the best in-sample pick, ranked out of sample.
function pbo(rows: Row[]) {
  if (rows.length < 8) return 1;
  const S = 10;
  const nb = rows[0].bins.length;
  const M = rows.map((r) => {
    const out = new Array<number>(S).fill(0);
    r.bins.forEach((v, i) => (out[Math.min(S - 1, Math.floor((i / nb) * S))] += v));
    return out;
  });
  const masks: number[] = [];
  for (let m = 0; m < 1 << S; m++) {
    let c = 0;
    for (let k = 0; k < S; k++) if (m & (1 << k)) c++;
    if (c === S / 2) masks.push(m);
  }
  let bad = 0;
  for (const m of masks) {
    let [best, bestV] = [0, -Infinity];
    const oos = M.map((row, i) => {
      let [a, b] = [0, 0];
      row.forEach((v, k) => (m & (1 << k) ? (a += v) : (b += v)));
      if (a > bestV) {
        bestV = a;
        best = i;
      }
      return b;
    });
    const below = oos.filter((v) => v < oos[best]).length;
    if (below / rows.length <= 0.5) bad++;
  }
  return bad / masks.length;
}

function blockBoot(v: Float64Array, runs = 5000, mean = 10, seed = 3) {
  const r = rng(seed);
  const T = v.length;
  let bad = 0;
  for (let n = 0; n < runs; n++) {
    let s = 0;
    let i = Math.floor(r() * T);
    for (let k = 0; k < T; k++) {
      s += v[i];
      i = r() < 1 / mean ? Math.floor(r() * T) : (i + 1) % T;
    }
    if (s <= 0) bad++;
  }
  return bad / runs;
}

// ---- running a config -----------------------------------------------------------------

const watch = universe.watch.map(loadCoin).filter((c): c is Coin => !!c);
const hold = universe.hold.map(loadCoin).filter((c): c is Coin => !!c);
const btc = watch.find((c) => c.sym === "BTC")!;
const eW = envs(watch, btc, tf);
const eH = envs(hold, btc, tf);
const sigCache = new Map<string, Int8Array>();
const signal = (e: Env, c: Cfg) => {
  const k = `${e.sym}|${c.fam}|${JSON.stringify(c.p)}`;
  let s = sigCache.get(k);
  if (!s) sigCache.set(k, (s = FAMILY[c.fam].sig(e, c.p)));
  return s;
};
const runAll = (es: Env[], cs: Coin[], cfg: Cfg, o: { cost?: number; delay?: number; from?: number; to?: number } = {}, cache = true) => {
  const out: Trade[] = [];
  es.forEach((e, i) => {
    const sig = cache ? signal(e, cfg) : FAMILY[cfg.fam].sig(e, cfg.p);
    for (const t of runCoin(e, sig, cfg, cs[i].fund, i, o)) out.push(t);
  });
  return out;
};

// BTC's side of its 50-day on each date, known at the start of that day.
const btcD = barsAt(btc.base, "1d");
const e50 = emaA(btcD.c, 50);
const regime = new Map<number, number>();
for (let i = 51; i < btcD.n; i++) regime.set(Math.floor(btcD.t[i] / DAY), btcD.c[i - 1] > e50[i - 1] ? 1 : -1);
const btcRet = new Map<number, number>();
for (let i = 1; i < btcD.n; i++) btcRet.set(Math.floor(btcD.t[i] / DAY), btcD.c[i] / btcD.c[i - 1] - 1);

// One shared day order per path keeps coins moving together, as they really do.
function dayOrder(days: number, seed: number) {
  const r = rng(seed);
  const out: number[] = [];
  let d = Math.floor(r() * days);
  while (out.length < days) {
    out.push(d);
    d = r() < 1 / 3 ? Math.floor(r() * days) : (d + 1) % days;
  }
  return out;
}

function synth(b: Cols, order: number[], first: number): { cols: Cols; map: Int32Array } {
  const span = b.n > 1 ? b.t[1] - b.t[0] : 300;
  const byDay = new Map<number, number[]>();
  for (let i = 1; i < b.n; i++) {
    const d = Math.floor(b.t[i] / DAY) - first;
    const g = byDay.get(d);
    if (g) g.push(i);
    else byDay.set(d, [i]);
  }
  const idx: number[] = [];
  for (const d of order) {
    const g = byDay.get(d);
    if (g) for (const i of g) idx.push(i);
  }
  const n = idx.length;
  const c = { n, t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n), q: new Float64Array(n), tb: new Float64Array(n) };
  let prev = b.c[0];
  const t0 = b.t[0];
  idx.forEach((i, k) => {
    const open = prev * (b.o[i] / b.c[i - 1]);
    const f = open / b.o[i];
    c.t[k] = t0 + k * span;
    c.o[k] = open;
    c.h[k] = b.h[i] * f;
    c.l[k] = b.l[i] * f;
    c.c[k] = b.c[i] * f;
    c.v[k] = b.v[i];
    c.q[k] = b.q[i];
    c.tb[k] = b.tb[i];
    prev = c.c[k];
  });
  return { cols: c, map: Int32Array.from(idx) };
}

function synthEnvs(order: number[], first: number): Env[] {
  const span = TF_SEC[tf];
  const lift = (b: Cols, to: number) => (to === span ? b : to < span ? b : resample(b, to, span));
  const btcS = synth(barsAt(btc.base, tf), order, first).cols;
  const btcDS = lift(btcS, 86400);
  return eW.map((e) => {
    const s = e.sym === "BTC" ? { cols: btcS, map: synth(e.b, order, first).map } : synth(e.b, order, first);
    const env = makeEnv(e.sym, tf, s.cols, lift(s.cols, 86400), lift(s.cols, Math.max(14400, span)), btcDS, btcS, null);
    // Side data follows the same reshuffle, so spot, funding and premium stay paired with their bars.
    if (e.fund) env.fund = Float64Array.from(s.map, (i) => e.fund![i]);
    if (e.cb) env.cb = Float64Array.from(s.map, (i) => e.cb![i]);
    if (e.spotD) env.spotD = Float64Array.from(s.map, (i) => e.spotD![i]);
    if (e.spotC) env.spotC = Float64Array.from(s.map, (i, k) => (e.spotC![i] ? (s.cols.c[k] * e.spotC![i]) / e.b.c[i] : 0));
    if (e.oi) {
      const oi = new Float64Array(s.cols.n);
      let v = 1;
      for (let k = 0; k < s.cols.n; k++) {
        const i = s.map[k];
        const [a, b] = [e.oi[i], e.oi[i - 1]];
        v *= a && b ? a / b : 1;
        oi[k] = v;
      }
      env.oi = oi;
    }
    return env;
  });
}

// ---- gates ----------------------------------------------------------------------------

const { rho, N, srVar } = effectiveTrials();
console.log(`${tf}: total trials ${totalTrials}, average correlation ${rho.toFixed(2)}, effective trials ${N.toFixed(0)}`);
const groups = new Map<string, Row[]>();
for (const r of me.rows) {
  const k = r.cfg.fam;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const pboBy = new Map([...groups].map(([k, v]) => [k, pbo(v)]));
// SYN_IDS forces synthetic paths on named strategies, as extra evidence. It never changes a pass mark.
const synIds = process.env.SYN_IDS?.split(";");
const short = synIds
  ? me.rows.filter((r) => synIds.includes(r.id))
  : [...groups.values()].flatMap((rows) =>
      rows
        .filter((r) => r.n >= MIN_N[tf] && r.avg >= 0.05 && r.t >= 2 && r.pos >= 8 && r.h1 > 0 && r.h2 > 0)
        .sort((a, b) => b.t - a.t)
        .slice(0, 6),
    );
console.log(`${tf}: shortlist ${short.length} from ${me.rows.length} scored rows`);

type G = Record<string, boolean | number>;
const results: { id: string; cfg: Cfg; disc: unknown; valid: unknown; hold: unknown; final: unknown; finalHold: unknown; gates: G; detail: Record<string, number>; passed: boolean; passedCount: number }[] = [];
for (const row of short) {
  const cfg = row.cfg;
  const tw = runAll(eW, watch, cfg, { to: finalFrom });
  const th = runAll(eH, hold, cfg, { to: finalFrom });
  const gates: G = {};
  const detail: Record<string, number> = {};
  const v = summary(tw, validFrom, finalFrom);
  gates.G1 = v.avg > 0 && v.t >= 1;
  const h = summary(th, start, finalFrom);
  const hc = hold.map((_, i) => th.filter((x) => x.coin === i)).filter((x) => x.length);
  const hp = hc.filter((x) => x.reduce((s, t) => s + t.r, 0) > 0).length;
  gates.G2 = h.avg > 0 && h.t >= 1.5 && hp >= hc.length / 2;
  detail.holdPos = hp;
  detail.holdCoins = hc.length;
  const both = [...tw, ...th];
  const B = 8;
  const size = (finalFrom - start) / B;
  const blocks = Array.from({ length: B }, (_, i) => both.filter((x) => x.tIn >= start + i * size && x.tIn < start + (i + 1) * size).reduce((s, x) => s + x.r, 0));
  detail.blocksPos = blocks.filter((x) => x > 0).length;
  gates.G3 = detail.blocksPos >= 5;
  detail.pbo = +(pboBy.get(cfg.fam) ?? 1).toFixed(3);
  gates.G4 = detail.pbo < 0.5;
  const day = dailySeries(tw, start, finalFrom);
  detail.dsr = +deflated(day, N, srVar).toFixed(3);
  gates.G5 = detail.dsr >= 0.9;
  const dc = summary([...runAll(eW, watch, cfg, { to: finalFrom, cost: 2 }), ...runAll(eH, hold, cfg, { to: finalFrom, cost: 2 })], start, finalFrom);
  const dl = summary([...runAll(eW, watch, cfg, { to: finalFrom, delay: 1 }), ...runAll(eH, hold, cfg, { to: finalFrom, delay: 1 })], start, finalFrom);
  detail.costAvg = +dc.avg.toFixed(3);
  detail.delayAvg = +dl.avg.toFixed(3);
  gates.G6 = dc.avg > 0 && dl.avg > 0;
  // Jitter: every knob, one at a time, up and down.
  const base = summary(tw, start, finalFrom).avg;
  const neighbours: Cfg[] = [];
  for (const k of Object.keys(cfg.p).filter((x) => !["sess", "add", "ret", "h", "b"].includes(x)))
    for (const f of [0.75, 1.25]) {
      const raw = cfg.p[k] * f;
      const val = Number.isInteger(cfg.p[k]) && cfg.p[k] > 1 ? Math.max(2, Math.round(raw)) : raw;
      if (val !== cfg.p[k]) neighbours.push({ ...cfg, p: { ...cfg.p, [k]: val } });
    }
  for (const k of ["stop", "target", "trail"] as const)
    if (cfg.ex[k]) for (const f of [0.8, 1.2]) neighbours.push({ ...cfg, ex: { ...cfg.ex, [k]: cfg.ex[k] * f } });
  const nav = neighbours.map((c) => summary(runAll(eW, watch, c, { to: finalFrom }, false), start, finalFrom).avg).sort((a, b) => a - b);
  detail.jitterPos = +(nav.filter((x) => x > 0).length / (nav.length || 1)).toFixed(2);
  detail.jitterMed = +(nav[Math.floor(nav.length / 2)] ?? 0).toFixed(3);
  gates.G7 = detail.jitterPos >= 0.75 && detail.jitterMed >= 0.4 * base;
  // Regimes
  const reg = (s: number) => both.filter((x) => regime.get(Math.floor(x.tIn / DAY)) === s);
  const [up, dn] = [reg(1), reg(-1)];
  const avg = (x: Trade[]) => x.reduce((s, t) => s + t.r, 0) / (x.length || 1);
  detail.upAvg = +avg(up).toFixed(3);
  detail.dnAvg = +avg(dn).toFixed(3);
  detail.upN = up.length;
  detail.dnN = dn.length;
  gates.G8 = (up.length < 20 || avg(up) >= 0) && (dn.length < 20 || avg(dn) >= 0);
  // Alpha against BTC
  const a0 = Math.floor(start / DAY);
  const x: number[] = [];
  const y: number[] = [];
  day.forEach((val, i) => {
    const b = btcRet.get(a0 + i);
    if (b !== undefined) {
      x.push(b);
      y.push(val);
    }
  });
  const o = ols(y, x);
  detail.alphaT = +o.t.toFixed(2);
  detail.beta = +o.beta.toFixed(2);
  gates.G9 = o.t >= 1.5;
  detail.bootP = +blockBoot(day).toFixed(4);
  gates.G10 = detail.bootP < 0.05;
  // Random timing
  const r = rng(99);
  const means: number[] = [];
  const counts = eW.map((_, i) => tw.filter((t) => t.coin === i));
  for (let run = 0; run < 200; run++) {
    let [s, c] = [0, 0];
    eW.forEach((e, i) => {
      const hi = e.b.n - 2;
      for (const t of counts[i]) {
        const at = 210 + Math.floor(r() * (hi - 210));
        const tr = simOne(e, at, t.side, ["smc", "lab"].includes(FAMILY[cfg.fam].kind) ? { ...cfg.ex, stop: 1.5, target: cfg.ex.target || 2, trail: 0 } : cfg.ex, watch[i].fund, 1, 0);
        if (tr) {
          s += tr.r;
          c++;
        }
      }
    });
    means.push(c ? s / c : 0);
  }
  means.sort((a, b) => a - b);
  detail.rand95 = +means[Math.floor(0.95 * means.length)].toFixed(3);
  detail.actual = +summary(tw, start, finalFrom).avg.toFixed(3);
  gates.G11 = detail.actual > detail.rand95;
  // Synthetic price paths are the slowest test, so they run only for strategies still alive.
  const alive = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11"].every((k) => gates[k]);
  const missed = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11"].filter((k) => !gates[k]).length;
  if (missed <= 1 || synIds) {
    const first = Math.floor(start / DAY);
    const days = Math.floor((finalFrom - start) / DAY);
    const syn: number[] = [];
    for (let p = 0; p < PATHS; p++) {
      const es = synthEnvs(dayOrder(days, 1000 + p), first);
      syn.push(summary(runAll(es, watch, cfg, {}, false), es[0].b.t[0], es[0].b.t[es[0].b.n - 1] + DAY).avg);
    }
    syn.sort((a, b) => a - b);
    detail.syn90 = +syn[Math.floor(0.9 * syn.length)].toFixed(3);
    gates.G12 = detail.actual > detail.syn90;
  } else gates.G12 = false;
  const count = Object.values(gates).filter(Boolean).length;
  const fw = runAll(eW, watch, cfg, { from: finalFrom });
  const fh = runAll(eH, hold, cfg, { from: finalFrom });
  results.push({ id: row.id, cfg, disc: { n: row.n, avg: row.avg, t: row.t, win: row.win }, valid: v, hold: h, final: summary(fw, finalFrom, asOf + 1), finalHold: summary(fh, finalFrom, asOf + 1), gates, detail, passed: alive && !!gates.G12, passedCount: count });
  console.log(`${row.id} passed ${count}/12 ${Object.entries(gates).filter(([, ok]) => !ok).map(([k]) => k).join(" ")}`);
}
writeFileSync(resolve(OUT, `gates-${tf}${tag}${synIds ? "-syn" : ""}.json`), JSON.stringify({ tf, totalTrials, rho, N, shortlist: short.length, pbo: Object.fromEntries(pboBy), results }, null, 1));
console.log(`${tf}: done, survivors ${results.filter((x) => x.passed).length}`);
