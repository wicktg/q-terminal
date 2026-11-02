// Forecast and setup engine.
//  - Volatility: EWMA blended with the long-run level.
//  - Paths: bootstrap of the coin's own standardized returns, so fat tails are preserved.
//  - Drift: kNN analogs on price and CVD features, shrunk hard. Most short-horizon edge is small.
//  - Honesty: the analog model is walk-forward tested and its hit rate is shown beside it.
import type { Bar, Forecast, Level, Setup, Touch, Tone } from "./types.ts";
import { atr, delta, ema, rsi, stdev } from "./quant.ts";
import { RECORD } from "./record.ts";

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (x: number, a = -1, b = 1) => Math.max(a, Math.min(b, x));

const quantile = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];

export function residuals(c: number[], win = 42) {
  const r = c.slice(1).map((v, i) => Math.log(v / c[i]));
  const out: number[] = [];
  for (let i = win; i < r.length; i++) {
    const sd = stdev(r.slice(i - win, i));
    if (sd > 0) out.push(r[i] / sd);
  }
  const m = out.reduce((s, x) => s + x, 0) / (out.length || 1);
  const sd = stdev(out.map((x) => x - m)) || 1;
  return out.map((x) => (x - m) / sd);
}

export function sigma4h(c: number[]) {
  const r = c.slice(1).map((v, i) => Math.log(v / c[i]));
  let v = r.slice(0, 30).reduce((s, x) => s + x * x, 0) / 30;
  for (let i = 30; i < r.length; i++) v = 0.97 * v + 0.03 * r[i] ** 2;
  const lr = stdev(r) ** 2;
  return Math.sqrt(0.75 * v + 0.25 * lr);
}

// ---- analogs -------------------------------------------------------------------------

export function features(b: Bar[]) {
  const c = b.map((x) => x.c);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const R = rsi(c);
  const A = atr(b);
  const X: (number[] | null)[] = b.map((_, i) => {
    if (i < 110) return null;
    const a = A[i] || 1;
    let d = 0;
    let q = 0;
    for (let j = i - 11; j <= i; j++) {
      d += delta(b[j]);
      q += b[j].q;
    }
    let a100 = 0;
    for (let j = i - 99; j <= i; j++) a100 += A[j];
    return [
      ((R[i] ?? 50) - 50) / 20,
      (c[i] - e50[i]) / a,
      (e20[i] - e50[i]) / a,
      q ? (d / q) * 10 : 0,
      a / (a100 / 100) - 1,
      ((c[i] / c[i - 20] - 1) * c[i]) / (a * Math.sqrt(20)),
    ];
  });
  return X;
}

export function analogStats(X: (number[] | null)[], c: number[], idx: number, h: number, k = 40) {
  const cur = X[idx];
  if (!cur) return null;
  const train: { j: number; d: number }[] = [];
  const dims = cur.length;
  const pool: number[] = [];
  for (let j = 0; j < idx - h; j++) if (X[j]) pool.push(j);
  if (pool.length < k * 3) return null;
  const mean = new Array(dims).fill(0);
  const sd = new Array(dims).fill(0);
  for (const j of pool) for (let m = 0; m < dims; m++) mean[m] += X[j]![m] / pool.length;
  for (const j of pool) for (let m = 0; m < dims; m++) sd[m] += (X[j]![m] - mean[m]) ** 2 / pool.length;
  for (let m = 0; m < dims; m++) sd[m] = Math.sqrt(sd[m]) || 1;
  let ups = 0;
  for (const j of pool) {
    if (c[j + h] > c[j]) ups++;
    let d = 0;
    for (let m = 0; m < dims; m++) d += ((X[j]![m] - cur[m]) / sd[m]) ** 2;
    train.push({ j, d });
  }
  train.sort((a, b) => a.d - b.d);
  const chosen: number[] = [];
  for (const t of train) {
    if (chosen.every((j) => Math.abs(j - t.j) >= 3)) chosen.push(t.j); // thin out overlapping bars
    if (chosen.length >= k) break;
  }
  const rets = chosen.map((j) => c[j + h] / c[j] - 1).sort((a, b) => a - b);
  return {
    n: chosen.length,
    pUp: rets.filter((r) => r > 0).length / chosen.length,
    base: ups / pool.length,
    medianRet: rets[Math.floor(rets.length / 2)],
  };
}

export function walkForward(X: (number[] | null)[], c: number[], h: number) {
  let calls = 0;
  let hits = 0;
  const end = c.length - 1 - h;
  for (let i = end; i > end - 240 && i > 300; i -= 6) {
    const s = analogStats(X, c, i, h);
    if (!s) continue;
    const edge = s.pUp - s.base;
    if (Math.abs(edge) < 0.08) continue;
    calls++;
    if (edge > 0 === c[i + h] > c[i]) hits++;
  }
  return { calls, hitRate: calls ? hits / calls : 0 };
}

// ---- paths ---------------------------------------------------------------------------

type Sim = { sig: number; mu: number; z: number[]; seed: number };

function paths(px: number, sim: Sim, steps: number, n: number, marks: number[]) {
  const r = rng(sim.seed);
  const zl = sim.z.length;
  const ends = marks.map(() => new Float64Array(n));
  const mins = marks.map(() => new Float64Array(n));
  const maxs = marks.map(() => new Float64Array(n));
  for (let p = 0; p < n; p++) {
    let lg = 0;
    let lo = 0;
    let hi = 0;
    let m = 0;
    for (let s = 1; s <= steps; s++) {
      lg += sim.z[Math.floor(r() * zl)] * sim.sig + sim.mu;
      if (lg < lo) lo = lg;
      if (lg > hi) hi = lg;
      if (s === marks[m]) {
        ends[m][p] = lg;
        mins[m][p] = lo;
        maxs[m][p] = hi;
        m++;
      }
    }
  }
  const toPx = (a: Float64Array) => Array.from(a, (x) => px * Math.exp(x));
  return { ends: ends.map(toPx), mins: mins.map(toPx), maxs: maxs.map(toPx) };
}

// Inputs to the forecast and zone scoring. OI, funding, liquidations and long/short ratios are excluded on purpose.
export type Flow = {
  trend: number;
  cvd: number;
  book: number;
  analog: number;
};

const flowTotal = (f: Flow) =>
  0.5 * f.trend + 0.4 * f.cvd + 0.1 * f.book;

// Volatility, drift and analog trust. Split out so the backtest can skip the price-path simulation.
export function driftOf(b4: Bar[], flow: Flow, seed: number) {
  const c = b4.map((x) => x.c);
  const z = residuals(c);
  const sig = sigma4h(c);
  const X = features(b4);
  const h = 18; // 3 days of 4h bars
  const a = analogStats(X, c, c.length - 1, h);
  const wf = walkForward(X, c, h);
  const analogEdge = a ? a.pUp - a.base : 0;
  // Shrink hard unless the walk-forward test earned some trust.
  const trust = wf.calls >= 15 ? clamp((wf.hitRate - 0.5) / 0.15, 0, 1) : 0;
  const tilt = 0.08 * sig * flowTotal(flow) + 0.1 * sig * trust * clamp(analogEdge / 0.2);
  return { sim: { sig, mu: tilt, z, seed } as Sim, trust, a, wf, tilt };
}

export function forecast(b4: Bar[], levels: Level[], flow: Flow, seed: number) {
  const c = b4.map((x) => x.c);
  const px = c[c.length - 1];
  const { sim, trust, a, wf, tilt } = driftOf(b4, flow, seed);
  const { sig } = sim;
  const P = paths(px, sim, 42, 6000, [6, 18, 42]);
  const hz = [
    { label: "1D", days: 1, i: 0 },
    { label: "3D", days: 3, i: 1 },
    { label: "7D", days: 7, i: 2 },
  ].map(({ label, days, i }) => {
    const s = [...P.ends[i]].sort((x, y) => x - y);
    return {
      label,
      days,
      q05: quantile(s, 0.05),
      q25: quantile(s, 0.25),
      q50: quantile(s, 0.5),
      q75: quantile(s, 0.75),
      q95: quantile(s, 0.95),
      pUp: P.ends[i].filter((x) => x > px).length / P.ends[i].length,
    };
  });
  const seen = new Set<string>();
  const uniq = levels.filter((l) => {
    const k = String(Math.round(Math.log(l.price / px) / 0.005)); // one level per 0.5% band
    if (seen.has(k) || Math.abs(l.price / px - 1) > 0.25) return false;
    seen.add(k);
    return true;
  });
  const near = (dir: number) =>
    uniq
      .filter((l) => (dir > 0 ? l.price > px : l.price < px))
      .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))
      .slice(0, 5);
  const touches: Touch[] = [...near(1).reverse(), ...near(-1)].map((l) => {
    const up = l.price > px;
    const hit = (arr: number[]) => arr.filter((v) => (up ? v >= l.price : v <= l.price)).length / arr.length;
    return { price: l.price, label: l.label, p3d: hit(up ? P.maxs[1] : P.mins[1]), p7d: hit(up ? P.maxs[2] : P.mins[2]) };
  });
  const pUp3d = hz[1].pUp;
  const direction: Forecast["direction"] = pUp3d > 0.54 ? "UP" : pUp3d < 0.46 ? "DOWN" : "NEUTRAL";
  const drivers: string[] = [];
  const named: [string, number][] = [
    ["Trend", flow.trend],
    ["CVD", flow.cvd],
    ["Order book", flow.book],
  ];
  named
    .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
    .slice(0, 3)
    .forEach(([k, v]) => drivers.push(`${k} ${v > 0 ? "supports upside" : "supports downside"} (${v > 0 ? "+" : ""}${v.toFixed(2)})`));
  const fc: Forecast = {
    direction,
    pUp3d,
    sigmaDay: sig * Math.sqrt(6),
    driftDay: tilt * 6,
    horizons: hz,
    touches,
    analogs: a ? { n: a.n, pUp: a.pUp, base: a.base, medianRet: a.medianRet } : { n: 0, pUp: 0.5, base: 0.5, medianRet: 0 },
    backtest: { calls: wf.calls, hitRate: wf.hitRate, horizonDays: 3 },
    history: b4.slice(-90).map((x) => ({ t: x.t, c: x.c })),
    drivers,
  };
  return { fc, sim, trust };
}

// ---- setups --------------------------------------------------------------------------

type Zone = { lo: number; hi: number; score: number; names: string[] };

function bestZone(levels: Level[], from: number, to: number, width: number): Zone | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const inRange = levels.filter((l) => l.price >= lo && l.price <= hi).sort((a, b) => a.price - b.price);
  let best: Zone | null = null;
  for (let i = 0; i < inRange.length; i++) {
    const grp = inRange.filter((l) => l.price >= inRange[i].price && l.price <= inRange[i].price + width);
    const score = grp.reduce((s, l) => s + l.weight, 0);
    if (!best || score > best.score) {
      best = { lo: grp[0].price, hi: grp[grp.length - 1].price, score, names: [...new Set(grp.map((g) => g.label))] };
    }
  }
  return best;
}

export function nextTargets(levels: Level[], entry: number, stop: number, side: 1 | -1) {
  const risk = Math.abs(entry - stop);
  const ahead = levels
    .filter((l) => (side > 0 ? l.price > entry : l.price < entry))
    .sort((a, b) => side * (a.price - b.price));
  const first = ahead.find((l) => Math.abs(l.price - entry) >= risk * 1.2);
  const t1 = first?.price ?? entry + side * risk * 1.5;
  const second = ahead.find((l) => side * (l.price - t1) > risk * 0.8 && Math.abs(l.price - entry) >= risk * 2);
  const t2 = second?.price ?? entry + side * risk * 2.5;
  return { t1, t2 };
}

function firstPassage(entry: number, stop: number, target: number, side: 1 | -1, sim: Sim, seed: number, n = 1200) {
  const r = rng(seed);
  const sig = sim.sig / 2; // 1h steps
  const mu = sim.mu / 4;
  const zl = sim.z.length;
  const up = Math.log(target / entry);
  const dn = Math.log(stop / entry);
  let win = 0;
  let lose = 0;
  for (let p = 0; p < n; p++) {
    let lg = 0;
    for (let s = 0; s < 168; s++) {
      lg += sim.z[Math.floor(r() * zl)] * sig + mu;
      if (side > 0 ? lg >= up : lg <= up) {
        win++;
        break;
      }
      if (side > 0 ? lg <= dn : lg >= dn) {
        lose++;
        break;
      }
    }
  }
  return win / Math.max(1, win + lose);
}

function pTouch(px: number, level: number, sim: Sim, seed: number, n = 1000) {
  if (Math.abs(level / px - 1) < 0.0005) return 1;
  const r = rng(seed);
  const sig = sim.sig / 2;
  const mu = sim.mu / 4;
  const tgt = Math.log(level / px);
  const zl = sim.z.length;
  let hit = 0;
  for (let p = 0; p < n; p++) {
    let lg = 0;
    for (let s = 0; s < 168; s++) {
      lg += sim.z[Math.floor(r() * zl)] * sig + mu;
      if (tgt > 0 ? lg >= tgt : lg <= tgt) {
        hit++;
        break;
      }
    }
  }
  return hit / n;
}

export function buildSetups(px: number, a4: number, levels: Level[], flow: Flow, sim: Sim, fmt: (x: number) => string, runs = 1200) {
  const dirScore = (side: 1 | -1) => {
    const f = flow;
    const parts = [f.trend * 2, f.cvd * 2, f.book * 0.5, f.analog];
    const w = 2 + 2 + 0.5 + 1;
    return clamp((side * parts.reduce((s, x) => s + x, 0)) / w);
  };
  const reasons = (side: 1 | -1) => {
    const f = flow;
    const out: string[] = [];
    const pick: [number, string, string][] = [
      [f.trend, "Higher-timeframe trend is up", "Higher-timeframe trend is down"],
      [f.cvd, "Taker flow (CVD) is net buying", "Taker flow (CVD) is net selling"],
      [f.analog, "Historical analogs lean up", "Historical analogs lean down"],
    ];
    for (const [v, u, d] of pick) if (Math.abs(v) > 0.2 && Math.sign(v) === side) out.push(side > 0 ? u : d);
    return out.slice(0, 4);
  };
  const out: Setup[] = [];
  const add = (
    name: string,
    side: 1 | -1,
    zone: Zone,
    entry: number,
    stop: number,
    trigger: string,
    invalid: string,
    i: number,
  ) => {
    const risk = Math.abs(entry - stop);
    if (risk <= 0 || risk / entry > 0.25) return;
    const { t1, t2 } = nextTargets(levels, entry, stop, side);
    const pWin = firstPassage(entry, stop, t1, side, sim, sim.seed + i * 13, runs);
    const pReach = pTouch(px, entry, sim, sim.seed + i * 17, Math.round(runs * 0.83));
    const rr1 = Math.abs(t1 - entry) / risk;
    const rr2 = Math.abs(t2 - entry) / risk;
    const expR = pWin * rr1 - (1 - pWin);
    // The simulation overstates wins: a resting order tends to fill as price pushes through it.
    // Ranking stays on the raw figures, which is what was tested. Display uses the corrected ones.
    const realWin = clamp(RECORD.calib.a + RECORD.calib.b * pWin, 0.02, 0.95);
    const realEv = realWin * rr1 - (1 - realWin);
    const tested = RECORD.bySetup[name];
    const proven = !!tested && tested.n >= 100 && tested.avg > 0 && tested.t >= 2;
    const conf = clamp(zone.score / 6, 0, 1);
    const align = (dirScore(side) + 1) / 2;
    const er = 1 / (1 + Math.exp(-3 * expR));
    const score = Math.round(100 * (0.35 * er + 0.2 * conf + 0.3 * align + 0.15 * pReach));
    out.push({
      name,
      side: side > 0 ? "LONG" : "SHORT",
      grade: !proven || realEv < 0.03 ? "C" : score >= 66 ? "A" : score >= 54 ? "B" : "C", // a good grade has to be earned in the backtest
      score,
      zone: [zone.lo, zone.hi],
      trigger,
      entry,
      stop,
      t1,
      t2,
      rr1,
      rr2,
      pReach,
      pWin: realWin,
      expR: realEv,
      rawWin: pWin,
      rawEv: expR,
      confluence: zone.names,
      why: reasons(side),
      invalid,
    });
  };
  const below = bestZone(levels, px - 0.25 * a4, px - 5 * a4, 0.7 * a4);
  const above = bestZone(levels, px + 0.25 * a4, px + 5 * a4, 0.7 * a4);
  if (below) {
    const stop = below.lo - 0.7 * a4;
    const entry = (below.lo + below.hi) / 2;
    add(
      "Pullback long",
      1,
      below,
      entry,
      stop,
      `Wick into ${fmt(below.lo)}–${fmt(below.hi)}, then a 1h close back above ${fmt(below.hi)}`,
      `4h close below ${fmt(stop)}`,
      1,
    );
    const bdStop = below.hi + 0.7 * a4;
    add(
      "Breakdown short",
      -1,
      below,
      below.lo,
      bdStop,
      `4h close below ${fmt(below.lo)}, then a failed retest of it`,
      `4h close back above ${fmt(bdStop)}`,
      2,
    );
  }
  if (above) {
    const stop = above.hi + 0.7 * a4;
    const entry = (above.lo + above.hi) / 2;
    add(
      "Rejection short",
      -1,
      above,
      entry,
      stop,
      `Wick into ${fmt(above.lo)}–${fmt(above.hi)}, then a 1h close back below ${fmt(above.lo)}`,
      `4h close above ${fmt(stop)}`,
      3,
    );
    const boStop = above.lo - 0.7 * a4;
    add(
      "Breakout-retest long",
      1,
      above,
      above.hi,
      boStop,
      `4h close above ${fmt(above.hi)}, then a retest that holds`,
      `4h close back below ${fmt(boStop)}`,
      4,
    );
  }
  return out.sort((a, b) => b.score - a.score);
}

export const toneOf = (x: number, eps = 0): Tone => (x > eps ? "up" : x < -eps ? "down" : "flat");
