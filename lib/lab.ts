// LAB: range and pattern rules taken from @tradermatt's public posts, Oct 2026, with add-ons from traders in the same lane.
// Pure, no I/O. The search, the gates and the live LAB page all run this file.
//
// Range:  an impulse, then sideways price touching both edges. Key information is the sideways action.
// Where:  only at a swing high or low. Mid-swing is skipped: "a lot of randomness between extremes".
// Enter:  on closes, confirmation over prediction.
// Stop:   the opposite side of the range. Deviations use the wick.
// Target: at least 2.5R away, otherwise skip.
// Rules:  no weekends, New York hours for intraday.
// Add-ons from peers (Trader_XO): monthly VWAP side, failed acceptance. Taker flow as a check on the base.
import type { Cols, Env, Tf } from "./mtf.ts";
import { resample, TF_SEC } from "./mtf.ts";

export type LabP = { m: number; w: number; ret: number; sess: number; add: number; h?: number };
export type Rng = { hi: number; lo: number; dir: number; pos: number };

export function monthlyVwap(b: Cols) {
  const a = new Float64Array(b.n);
  let [pv, vol, mon] = [0, 0, -1];
  for (let i = 0; i < b.n; i++) {
    const d = new Date(b.t[i] * 1000);
    const k = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (k !== mon) {
      mon = k;
      pv = 0;
      vol = 0;
    }
    pv += ((b.h[i] + b.l[i] + b.c[i]) / 3) * b.v[i];
    vol += b.v[i];
    a[i] = vol ? pv / vol : b.c[i];
  }
  return a;
}

// Separate visits to a price edge inside the window.
function visits(b: Cols, a: number, z: number, level: number, tol: number, high: boolean) {
  let [n, out] = [0, true];
  for (let k = a; k <= z; k++) {
    const near = high ? b.h[k] >= level - tol : b.l[k] <= level + tol;
    if (near && out) n++;
    if (!near) out = true;
    else out = false;
  }
  return n;
}

// The range known at the close of bar i, built only from bars before it.
export function rangeAt(e: Env, i: number, m: number, w: number): Rng | null {
  const { b, x } = e;
  const imp = m;
  if (i < m + imp + 210) return null;
  const A = x.atr()[i];
  const [hi, lo] = [x.hi(m)[i], x.lo(m)[i]];
  const span = hi - lo;
  if (!(span <= w * A) || span < 0.5 * A) return null;
  const move = b.c[i - m] - b.c[i - m - imp];
  if (Math.abs(move) < 2.5 * A) return null;
  const tol = 0.2 * span;
  if (visits(b, i - m, i - 1, hi, tol, true) < 2 || visits(b, i - m, i - 1, lo, tol, false) < 2) return null;
  const [HH, LL] = [x.hi(200)[i], x.lo(200)[i]];
  const pos = HH > LL ? ((hi + lo) / 2 - LL) / (HH - LL) : 0.5;
  if (pos > 0.3 && pos < 0.7) return null; // mid-swing
  return { hi, lo, dir: Math.sign(move), pos };
}

function sessionOk(t: number, sess: number) {
  if (!sess) return true;
  const day = (Math.floor(t / 86400) + 4) % 7;
  if (day === 0 || day === 6) return false;
  if (sess === 1) return true;
  const hr = Math.floor((t % 86400) / 3600);
  return hr >= 13 && hr < 18; // New York morning, after the first hour of volume arrives
}

type Out = { sig: Int8Array; stop: Float64Array; target: Float64Array };
const blank = (n: number): Out => ({ sig: new Int8Array(n), stop: new Float64Array(n).fill(NaN), target: new Float64Array(n).fill(NaN) });

function addOn(e: Env, i: number, d: number, add: number, mv: Float64Array, m: number) {
  if (add === 1) return d * (e.b.c[i] - mv[i]) > 0;
  if (add === 2) {
    let s = 0;
    for (let k = i - m; k < i; k++) s += 2 * e.b.tb[k] - e.b.v[k];
    return d * s > 0;
  }
  return true;
}

// kind 1 continuation: break out the way the impulse was going.
// kind 2 reversal: the base fails and breaks back through its far side.
function scanBreak(e: Env, p: LabP, kind: 1 | 2): Out {
  const { b } = e;
  const o = blank(b.n);
  const mv = monthlyVwap(b);
  const { c, l, h } = b;
  let pend: { d: number; lvl: number; stop: number; until: number } | null = null;
  for (let i = 300; i < b.n; i++) {
    const T = b.t[i] + TF_SEC[e.tf];
    if (pend) {
      if (i > pend.until || pend.d * (c[i] - pend.stop) < 0) pend = null;
      else if ((pend.d > 0 ? l[i] <= pend.lvl : h[i] >= pend.lvl) && pend.d * (c[i] - pend.lvl) > 0) {
        if (sessionOk(T, p.sess) && addOn(e, i, pend.d, p.add, mv, p.m)) {
          o.sig[i] = pend.d;
          o.stop[i] = pend.stop;
        }
        pend = null;
      }
    }
    const r = rangeAt(e, i, p.m, p.w);
    if (!r) continue;
    const up = c[i] > r.hi && c[i - 1] <= r.hi;
    const dn = c[i] < r.lo && c[i - 1] >= r.lo;
    if (!up && !dn) continue;
    const d = up ? 1 : -1;
    if ((kind === 1 && d !== r.dir) || (kind === 2 && d === r.dir)) continue;
    if (r.dir * (r.pos - 0.5) < 0) continue; // the base must sit at the end of its impulse
    const stop = d > 0 ? r.lo : r.hi;
    if (p.ret) {
      pend = { d, lvl: d > 0 ? r.hi : r.lo, stop, until: i + p.m };
      continue;
    }
    if (!sessionOk(T, p.sess) || !addOn(e, i, d, p.add, mv, p.m)) continue;
    o.sig[i] = d;
    o.stop[i] = stop;
  }
  return o;
}

// Deviation: a wick through the range that closes back inside, aiming for the other side.
function scanDev(e: Env, p: LabP): Out {
  const { b } = e;
  const o = blank(b.n);
  const mv = monthlyVwap(b);
  const { c, l, h } = b;
  for (let i = 300; i < b.n; i++) {
    const r = rangeAt(e, i, p.m, p.w);
    if (!r) continue;
    const d = l[i] < r.lo && c[i] > r.lo ? 1 : h[i] > r.hi && c[i] < r.hi ? -1 : 0;
    if (!d) continue;
    if (!sessionOk(b.t[i] + TF_SEC[e.tf], p.sess) || !addOn(e, i, d, p.add, mv, p.m)) continue;
    o.sig[i] = d;
    o.stop[i] = d > 0 ? l[i] : h[i];
    o.target[i] = d > 0 ? r.hi : r.lo;
  }
  return o;
}

// HTF range as the map, LTF reversal at its extreme as the entry, the far side as the target.
function scanMtf(e: Env, p: LabP): Out {
  const { b } = e;
  const o = blank(b.n);
  const hSec = (p.h ?? 4) * 3600;
  if (hSec <= TF_SEC[e.tf]) return o;
  const B = resample(b, hSec, TF_SEC[e.tf]);
  const H: Env = { sym: e.sym, tf: e.tf, b: B, x: new (e.x.constructor as new (c: Cols) => Env["x"])(B), btc: null, oi: null, bias: {} };
  const mv = monthlyVwap(b);
  const { c } = b;
  let k = -1;
  let cur: Rng | null = null;
  for (let i = 300; i < b.n; i++) {
    const T = b.t[i] + TF_SEC[e.tf];
    while (k + 1 < B.n && B.t[k + 1] + hSec <= T) {
      k++;
      if (k > 0) {
        const r = rangeAt(H, k, p.m, p.w * 1.5);
        if (r) cur = r;
        else if (cur && (B.c[k] > cur.hi + 0.5 * (cur.hi - cur.lo) || B.c[k] < cur.lo - 0.5 * (cur.hi - cur.lo))) cur = null; // the map has broken
      }
    }
    if (!cur) continue;
    const span = cur.hi - cur.lo;
    const atTop = c[i] >= cur.hi - 0.2 * span && c[i] <= cur.hi + 0.25 * span;
    const atBot = c[i] <= cur.lo + 0.2 * span && c[i] >= cur.lo - 0.25 * span;
    if (!atTop && !atBot) continue;
    const r = rangeAt(e, i, Math.max(8, Math.round(p.m / 2)), p.w);
    if (!r) continue;
    const short = atTop && c[i] < r.lo && c[i - 1] >= r.lo;
    const long = atBot && c[i] > r.hi && c[i - 1] <= r.hi;
    if (!short && !long) continue;
    const d = long ? 1 : -1;
    if (!sessionOk(T, p.sess) || !addOn(e, i, d, p.add, mv, p.m)) continue;
    o.sig[i] = d;
    o.stop[i] = d > 0 ? r.lo : r.hi;
    o.target[i] = d > 0 ? cur.hi : cur.lo;
  }
  return o;
}

export function labScan(id: string, e: Env, p: LabP): Out {
  if (id === "labcont") return scanBreak(e, p, 1);
  if (id === "labrev") return scanBreak(e, p, 2);
  if (id === "labdev") return scanDev(e, p);
  return scanMtf(e, p);
}

export const LAB_INFO: Record<string, { name: string; tfs: Tf[] }> = {
  labcont: { name: "Continuation range break", tfs: ["5m", "15m", "1h", "4h", "1d"] },
  labrev: { name: "Reversal range failure", tfs: ["5m", "15m", "1h", "4h", "1d"] },
  labdev: { name: "Range deviation", tfs: ["5m", "15m", "1h", "4h", "1d"] },
  labmtf: { name: "HTF range, LTF reversal", tfs: ["5m", "15m", "1h"] },
};

export function labGrid(id: string) {
  const out: LabP[] = [];
  for (const m of [12, 24]) for (const w of [3, 5]) for (const sess of [0, 1, 2]) for (const add of [0, 1, 2]) {
    if (id === "labmtf") for (const h of [4, 24]) out.push({ m, w, ret: 0, sess, add, h });
    else if (id === "labdev") out.push({ m, w, ret: 0, sess, add });
    else for (const ret of [0, 1]) out.push({ m, w, ret, sess, add });
  }
  return out;
}
