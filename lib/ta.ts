// Confluence signals from structure, zones and price action. Pure, no I/O.
// OI, funding, liquidations and long/short ratios are not inputs here, by design.
// A signal needs structure on the trigger timeframe to agree with structure on the bias timeframe,
// then earns points for each independent reason. The stop sits past whatever the setup is built on.
import { emaA, resample, TF_SEC, type Cols, type Tf } from "./mtf.ts";
import { Alive, lastAt, walk, type Ev, type Pool, type Walk, type Zone } from "./structure.ts";

export type SmcParams = { min: number; k: number; L: number; b: number }; // b is the bias timeframe, in hours

export type Item = { label: string; pts: number; on: boolean };
export type Eval = { i: number; dir: 1 | -1; ev: Ev; score: number; items: Item[]; zone: Zone | null; stop: number; target: number };
export const MAX_SCORE = 11;

const NAME: Record<number, string> = { 1: "1H", 4: "4H", 24: "1D" };
const zoneName = (z: Zone) => (z.kind === "OB" ? "order block" : z.kind === "FVG" ? "FVG" : z.side > 0 ? "demand" : "supply");

export type Pair = {
  w: Walk;
  W: Walk;
  b: Cols;
  B: Cols;
  bSec: number;
  tfSec: number;
  e50: Float64Array;
  toBias: Int32Array;
  zw: Alive<Zone>;
  zW: Alive<Zone>;
  pw: Alive<Pool>;
  pW: Alive<Pool>;
};

const memo = new WeakMap<Cols, Map<string, Pair>>();

// Index of the last finished bias bar at each trigger bar's close.
export function pairUp(b: Cols, tfSec: number, bHours: number, L: number, bias?: Cols): Pair {
  let cache = memo.get(b);
  if (!cache) memo.set(b, (cache = new Map()));
  const key = `${bHours}|${L}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const bSec = bHours * 3600;
  const B = bias ?? resample(b, bSec, tfSec);
  const toBias = new Int32Array(b.n).fill(-1);
  let k = -1;
  for (let i = 0; i < b.n; i++) {
    while (k + 1 < B.n && B.t[k + 1] + bSec <= b.t[i] + tfSec) k++;
    toBias[i] = k;
  }
  const [w, W] = [walk(b, L), walk(B, L)];
  const zoneEnd = (z: Zone) => z.dead;
  const poolEnd = (p: Pool) => p.gone;
  const pair: Pair = { w, W, b, B, bSec, tfSec, e50: emaA(B.c, 50), toBias, zw: new Alive(w.zones, zoneEnd), zW: new Alive(W.zones, zoneEnd), pw: new Alive(w.pools, poolEnd), pW: new Alive(W.pools, poolEnd) };
  cache.set(key, pair);
  return pair;
}

function nearestTarget(P: Pair, j: number, i: number, d: number, entry: number, stop: number) {
  const risk = Math.abs(entry - stop);
  const want = 1.5 * risk;
  const prices: number[] = [];
  for (const p of P.pW.at(j)) if (p.high === d > 0) prices.push(p.price);
  for (const p of P.pw.at(i)) if (p.high === d > 0) prices.push(p.price);
  for (const z of P.zW.at(j)) if (z.side === -d && z.kind !== "FVG") prices.push(d > 0 ? z.bottom : z.top);
  return prices.filter((x) => d * (x - entry) >= want).sort((x, y) => d * (x - y))[0] ?? NaN;
}

// Scores one structure break. Returns null if the bias timeframe disagrees.
export function evaluate(P: Pair, ev: Ev, p: SmcParams): Eval | null {
  const { b, w, W, B } = P;
  const { i, dir: d } = ev;
  const j = P.toBias[i];
  if (j < 60 || W.trend[j] !== d) return null;
  const A = w.atr[i];
  const from = Math.max(0, i - p.k + 1);
  let [lo, hi, delta, cum] = [Infinity, -Infinity, 0, 0];
  for (let x = from; x <= i; x++) {
    lo = Math.min(lo, b.l[x]);
    hi = Math.max(hi, b.h[x]);
    delta += (2 * b.tb[x] - b.v[x]) * b.c[x];
    cum += b.q[x];
  }
  const touched = (z: Zone) => (d > 0 ? lo <= z.top && hi >= z.bottom : hi >= z.bottom && lo <= z.top);
  const big = P.zW.at(j).filter((z) => z.side === d && touched(z));
  const best = big.find((z) => z.kind === "OB") ?? big.find((z) => z.kind === "SD") ?? big[0] ?? null;
  const alive = P.zw.at(i);
  const small = alive.filter((z) => z.side === d && z.kind !== "FVG" && touched(z));
  const fvg = alive.some((z) => z.kind === "FVG" && z.side === d && z.born >= i - 2);
  let sweep = false;
  for (let x = lastAt(w.sweeps, (s) => s.i, i); x >= 0 && w.sweeps[x].i >= from; x--) if (w.sweeps[x].dir === d) sweep = true;
  let [hiS, loS]: (number | undefined)[] = [undefined, undefined];
  for (let x = lastAt(W.swings, (s) => s.conf, j); x >= 0 && (hiS === undefined || loS === undefined); x--) {
    const q = W.swings[x];
    if (q.high) hiS ??= q.price;
    else loS ??= q.price;
  }
  const mid = hiS !== undefined && loS !== undefined ? (hiS + loS) / 2 : NaN;
  const value = d > 0 ? b.c[i] < mid : b.c[i] > mid;
  const ema = best ? P.e50[j] >= best.bottom - W.atr[j] * 0.25 && P.e50[j] <= best.top + W.atr[j] * 0.25 : false;
  let vAvg = 0;
  for (let x = Math.max(0, i - 20); x < i; x++) vAvg += b.q[x] / 20;
  const tf = NAME[p.b] ?? `${p.b}H`;
  const items: Item[] = [
    { label: `${tf} structure agrees`, pts: 2, on: true },
    { label: best ? `Reacted from ${tf} ${zoneName(best)}` : `Reacted from a ${tf} zone`, pts: 2, on: !!best },
    { label: "Reacted from a trigger-timeframe zone", pts: 1, on: small.length > 0 },
    { label: "Liquidity swept first", pts: 1, on: sweep },
    { label: "Shift made with displacement (MSS)", pts: 1, on: ev.kind === "MSS" },
    { label: "Left a fair value gap", pts: 1, on: fvg },
    { label: d > 0 ? "In discount of the range" : "In premium of the range", pts: 1, on: value },
    { label: `${tf} EMA50 inside the zone`, pts: 1, on: ema },
    { label: "CVD agrees", pts: 1, on: d * delta > 0 },
    { label: "Volume expansion on the break", pts: 1, on: b.q[i] >= 1.5 * vAvg },
  ];
  const score = items.reduce((s, x) => s + (x.on ? x.pts : 0), 0);
  const anchor = d > 0 ? Math.min(lo, best?.bottom ?? lo) : Math.max(hi, best?.top ?? hi);
  const stop = anchor - d * 0.25 * A;
  return { i, dir: d, ev, score, items, zone: best, stop, target: nearestTarget(P, j, i, d, b.c[i], stop) };
}

export function scanSmc(b: Cols, tf: Tf, p: SmcParams) {
  const n = b.n;
  const sig = new Int8Array(n);
  const stop = new Float64Array(n).fill(NaN);
  const target = new Float64Array(n).fill(NaN);
  const P = pairUp(b, TF_SEC[tf], p.b, p.L);
  for (const ev of P.w.events) {
    const r = evaluate(P, ev, p);
    if (!r || r.score < p.min) continue;
    sig[ev.i] = r.dir;
    stop[ev.i] = r.stop;
    target[ev.i] = r.target;
  }
  return { sig, stop, target };
}
