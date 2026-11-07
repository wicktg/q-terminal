// FPP, future price prediction. Pure, no I/O.
// Every past candle is described by the same set of measurements. The candles most like the latest one are
// found, and what price did after them decides the single most probable direction, its odds, the range of
// outcomes, and one representative path drawn as candles. The model then replays itself on this coin's own
// history, using only data from before each point, to report its real hit rate against the baseline.
// Open interest, funding, liquidations and long/short ratios are left out on purpose.
import { atrA, colsFromBars, Ind } from "./mtf.ts";
import { walk } from "./structure.ts";
import type { Bar } from "./types.ts";

// Forecast length in candles, and how many 1,500-candle pages of history to fetch for each chart timeframe.
export const FPP_SETUP: Record<string, { horizon: number; pages: number }> = {
  "5m": { horizon: 48, pages: 12 },
  "15m": { horizon: 32, pages: 4 },
  "1h": { horizon: 24, pages: 2 },
  "4h": { horizon: 18, pages: 1 },
  "1d": { horizon: 10, pages: 1 },
};
const TF_SEC: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

export const FEATURES = [
  "Short momentum",
  "Medium momentum",
  "Long momentum",
  "Stretch from the 50 EMA",
  "Volatility regime",
  "Taker flow",
  "Position in recent range",
  "Daily trend",
  "BTC move",
  "Market structure",
  "Hour of day (a)",
  "Hour of day (b)",
  "Room to liquidity above",
  "Room to liquidity below",
] as const;

export type FppCandle = { o: number; h: number; l: number; c: number }; // log move from the base price, in ATRs
export type FppRead = {
  sym: string;
  tf: string;
  asOf: number;
  horizon: number;
  days: number;
  samples: number;
  neighbors: number;
  dir: 1 | -1;
  prob: number; // share of similar past moments that went the predicted way, shrunk toward even odds
  atrPct: number; // today's ATR as a share of price, to turn the paths below back into prices
  median: number[]; // consensus path per step, log move in ATRs
  q25: number[];
  q75: number[];
  candles: FppCandle[];
  agree: boolean; // whether the linear model points the same way
  drivers: { name: string; push: number }[]; // what moved the linear model's estimate, signed toward up
  test: { n: number; hit: number; base: number; avg: number; edge: boolean };
};

const median = (xs: number[], ws: number[], q = 0.5) => {
  const idx = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b]);
  const total = ws.reduce((s, w) => s + w, 0);
  let acc = 0;
  for (const i of idx) {
    acc += ws[i];
    if (acc >= q * total) return xs[i];
  }
  return xs[idx[idx.length - 1]];
};

// Solves (A + λI)x = b for a small system, the ridge regression behind the driver list.
function ridge(X: number[][], y: number[], lambda: number) {
  const f = X[0].length;
  const A = Array.from({ length: f }, (_, r) => Array.from({ length: f + 1 }, (_, c) => (c === f ? 0 : r === c ? lambda : 0)));
  X.forEach((row, n) => {
    for (let r = 0; r < f; r++) {
      A[r][f] += row[r] * y[n];
      for (let c = 0; c < f; c++) A[r][c] += row[r] * row[c];
    }
  });
  for (let c = 0; c < f; c++) {
    let p = c;
    for (let r = c + 1; r < f; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < f; r++) {
      if (r === c || !A[c][c]) continue;
      const k = A[r][c] / A[c][c];
      for (let cc = c; cc <= f; cc++) A[r][cc] -= k * A[c][cc];
    }
  }
  return A.map((row, r) => (row[r] ? row[f] / row[r] : 0));
}

export function readFpp(sym: string, tf: string, all: Bar[], daily: Bar[], btc: Bar[]): FppRead {
  const H = FPP_SETUP[tf].horizon;
  const bars = all.slice(0, -1); // the forming candle is left out
  const b = colsFromBars(bars);
  const n = b.n;
  const ind = new Ind(b);
  const atr = atrA(b, 14);
  const atrLong = atrA(b, 100);
  const ema50 = ind.ema(50);
  const lc = Array.from(b.c, Math.log);
  const atrPct = Array.from(atr, (a, i) => a / b.c[i] || 1e-9);
  const w = walk(b, tf === "1d" ? 3 : 5);
  const flowLen = Math.max(4, Math.round(H / 2));
  const rangeLen = 4 * H;
  const sec = TF_SEC[tf];

  // Daily trend at each candle, from the last daily close already known at that time.
  const dc = colsFromBars(daily);
  const dEma = new Ind(dc).ema(20);
  const dAtr = atrA(dc, 14);
  const btcBy = new Map<number, number>();
  if (btc.length) {
    const bc = colsFromBars(btc);
    const bAtr = atrA(bc, 14);
    for (let i = H; i < bc.n; i++) btcBy.set(bc.t[i], (Math.log(bc.c[i]) - Math.log(bc.c[i - H])) / ((bAtr[i] / bc.c[i]) * Math.sqrt(H) || 1));
  }

  const warm = Math.max(rangeLen, 110);
  const X: number[][] = [];
  let di = 0;
  let sumFlow = 0;
  let sumVol = 0;
  for (let i = 0; i < n; i++) {
    sumFlow += 2 * b.tb[i] - b.v[i];
    sumVol += b.v[i];
    if (i >= flowLen) {
      sumFlow -= 2 * b.tb[i - flowLen] - b.v[i - flowLen];
      sumVol -= b.v[i - flowLen];
    }
    while (di + 1 < dc.n && dc.t[di + 1] + 86400 <= b.t[i]) di++;
    if (i < warm) {
      X.push([]);
      continue;
    }
    const mom = (k: number) => (lc[i] - lc[i - k]) / (atrPct[i] * Math.sqrt(k));
    let [lo, hi] = [Infinity, -Infinity];
    for (let k = i - rangeLen + 1; k <= i; k++) {
      lo = Math.min(lo, b.l[k]);
      hi = Math.max(hi, b.h[k]);
    }
    const dayOk = dc.n > 20 && dc.t[di] + 86400 <= b.t[i];
    const dTrend = dayOk ? (dc.c[di] - dEma[di]) / (dAtr[di] || 1) : 0;
    let [up, dn] = [10, 10];
    for (const p of w.pools) {
      if (p.born > i || p.gone <= i) continue;
      const d = (p.price - b.c[i]) / (atr[i] || 1);
      if (d > 0) up = Math.min(up, d);
      else dn = Math.min(dn, -d);
    }
    const hour = ((b.t[i] % 86400) / 86400) * 2 * Math.PI;
    X.push([
      mom(Math.max(2, Math.round(H / 4))),
      mom(H),
      mom(4 * H),
      (b.c[i] - ema50[i]) / (atr[i] || 1),
      atr[i] / (atrLong[i] || atr[i] || 1),
      sumVol ? sumFlow / sumVol : 0,
      hi > lo ? (b.c[i] - lo) / (hi - lo) - 0.5 : 0,
      Math.max(-5, Math.min(5, dTrend)),
      btcBy.get(b.t[i]) ?? 0,
      w.trend[i],
      sec < 86400 ? Math.sin(hour) : 0,
      sec < 86400 ? Math.cos(hour) : 0,
      Math.min(up, 10),
      Math.min(dn, 10),
    ]);
  }
  const now = n - 1;
  // A past candle's outcome: its next H closes and candles, as log moves in its own ATRs.
  const path = (j: number) => Array.from({ length: H }, (_, k) => (lc[j + k + 1] - lc[j]) / atrPct[j]);
  const candle = (j: number, k: number): FppCandle => {
    const s = (x: number) => (Math.log(x) - lc[j]) / atrPct[j];
    return { o: s(b.o[j + k + 1]), h: s(b.h[j + k + 1]), l: s(b.l[j + k + 1]), c: s(b.c[j + k + 1]) };
  };

  // Measurements in one flat array, with running sums so any training window's mean and spread cost nothing.
  const f = FEATURES.length;
  const XF = new Float64Array(n * f);
  const S1 = new Float64Array((n + 1) * f);
  const S2 = new Float64Array((n + 1) * f);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < f; k++) {
      const v = i >= warm ? X[i][k] : 0;
      XF[i * f + k] = v;
      S1[(i + 1) * f + k] = S1[i * f + k] + v;
      S2[(i + 1) * f + k] = S2[i * f + k] + v * v;
    }

  // Nearest neighbours on standardised measurements. Only candles whose outcome is known by time i qualify.
  const knn = (i: number) => {
    const end = Math.max(warm, i - H); // training candles are warm .. end-1
    const cnt = end - warm;
    const mean = new Array<number>(f);
    const sd = new Array<number>(f);
    const inv = new Float64Array(f);
    for (let k = 0; k < f; k++) {
      mean[k] = cnt ? (S1[end * f + k] - S1[warm * f + k]) / cnt : 0;
      const v = cnt ? (S2[end * f + k] - S2[warm * f + k]) / cnt - mean[k] ** 2 : 0;
      sd[k] = Math.sqrt(Math.max(v, 0)) || 1;
      inv[k] = 1 / sd[k] ** 2;
    }
    const kk = Math.max(20, Math.min(60, Math.round(Math.sqrt(cnt))));
    const bestD = new Float64Array(kk).fill(Infinity);
    const bestJ = new Int32Array(kk);
    const qi = i * f;
    for (let j = warm; j < end; j++) {
      const worst = bestD[kk - 1];
      let d2 = 0;
      const row = j * f;
      for (let k = 0; k < f && d2 < worst; k++) {
        const diff = XF[row + k] - XF[qi + k];
        d2 += diff * diff * inv[k];
      }
      if (d2 >= worst) continue;
      let p = kk - 1;
      while (p > 0 && bestD[p - 1] > d2) {
        bestD[p] = bestD[p - 1];
        bestJ[p] = bestJ[p - 1];
        p--;
      }
      bestD[p] = d2;
      bestJ[p] = j;
    }
    const near: { j: number; d: number }[] = [];
    for (let p = 0; p < kk && bestD[p] < Infinity; p++) near.push({ j: bestJ[p], d: Math.sqrt(bestD[p]) });
    const wts = near.map((x) => 1 / (x.d + 0.25));
    const finals = near.map((x) => lc[x.j + H] - lc[x.j]);
    const wUp = near.reduce((s, x, k) => s + (finals[k] > 0 ? wts[k] : 0), 0);
    const wAll = wts.reduce((s, x) => s + x, 0);
    const prior = 8 * (wAll / Math.max(1, near.length)); // eight imaginary neighbours split evenly, so thin evidence stays near 50%
    const z = (row: number[]) => row.map((x, k) => (x - mean[k]) / sd[k]);
    return { near, wts, pUp: (wUp + prior / 2) / (wAll + prior), end, z };
  };

  const live = knn(now);
  const train = Array.from({ length: live.end - warm }, (_, k) => warm + k);
  const dir: 1 | -1 = live.pUp >= 0.5 ? 1 : -1;
  const paths = live.near.map((x) => path(x.j));
  const med = Array.from({ length: H }, (_, k) => median(paths.map((p) => p[k]), live.wts));
  const q25 = Array.from({ length: H }, (_, k) => median(paths.map((p) => p[k]), live.wts, 0.25));
  const q75 = Array.from({ length: H }, (_, k) => median(paths.map((p) => p[k]), live.wts, 0.75));
  // The drawn path is the real past path closest to the consensus, among those that went the predicted way.
  let best = -1;
  let bestErr = Infinity;
  live.near.forEach((x, k) => {
    if (Math.sign(paths[k][H - 1]) !== dir) return;
    const err = paths[k].reduce((s, v, step) => s + (v - med[step]) ** 2, 0);
    if (err < bestErr) [best, bestErr] = [k, err];
  });
  const rep = live.near[best >= 0 ? best : 0].j;
  const candles = Array.from({ length: H }, (_, k) => candle(rep, k));

  // Linear model for the reasons: which measurements push the expected move up or down right now.
  const ys = train.map((j) => (lc[j + H] - lc[j]) / atrPct[j]);
  const beta = ridge(train.map((j) => live.z(X[j])), ys, 10);
  const xNow = live.z(X[now]);
  const pushes = FEATURES.map((name, k) => ({ name: name.replace(/ \([ab]\)$/, ""), push: beta[k] * xNow[k] }));
  const merged = new Map<string, number>();
  for (const p of pushes) merged.set(p.name, (merged.get(p.name) ?? 0) + p.push);
  const drivers = [...merged.entries()].map(([name, push]) => ({ name, push })).sort((a, c) => Math.abs(c.push) - Math.abs(a.push)).slice(0, 4);
  const linear = beta.reduce((s, bk, k) => s + bk * xNow[k], 0);

  // Honest replay: predict at past points with only earlier data, and score against what happened.
  const step = Math.max(1, Math.round(H / 2));
  const start = Math.max(warm + 200, Math.floor(warm + 0.6 * (now - H - warm)));
  let [hits, ups, follow, tests] = [0, 0, 0, 0];
  for (let i = start; i + H <= now; i += step) {
    const r = knn(i);
    const call = r.pUp >= 0.5 ? 1 : -1;
    const out = lc[i + H] - lc[i];
    tests++;
    if (out > 0) ups++;
    if (Math.sign(out) === call) hits++;
    follow += call * out;
  }
  const hit = tests ? hits / tests : 0;
  const base = tests ? Math.max(ups / tests, 1 - ups / tests) : 0.5;
  const zScore = tests ? (hit - 0.5) / Math.sqrt(0.25 / tests) : 0;

  return {
    sym,
    tf,
    asOf: Date.now(),
    horizon: H,
    days: Math.round((b.t[n - 1] - b.t[0]) / 86400),
    samples: train.length,
    neighbors: live.near.length,
    dir,
    prob: dir > 0 ? live.pUp : 1 - live.pUp,
    atrPct: atrPct[now],
    median: med,
    q25,
    q75,
    candles,
    agree: Math.sign(linear) === dir,
    drivers,
    test: { n: tests, hit, base, avg: tests ? (follow / tests) * 100 : 0, edge: tests >= 30 && hit >= base + 0.03 && zScore >= 1.65 },
  };
}
