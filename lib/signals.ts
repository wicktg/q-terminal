// Candidate signal families, tested against the zone setups under the same simulator.
// Each one fires at a 4h close using only data up to that close, and enters at the next open.
import type { Bar } from "./types.ts";
import type { Cand } from "./backtest.ts";
import { atr, delta, ema, rsi } from "./quant.ts";

const H4 = 14400;
const DAY = 86400;

export const FAMILIES = ["Sweep reclaim", "CVD divergence", "Trend pullback", "Breakout", "Flush", "Funding extreme"] as const;

const hi = (b: Bar[], a: number, z: number) => {
  let m = -Infinity;
  for (let i = a; i <= z; i++) m = Math.max(m, b[i].h);
  return m;
};
const lo = (b: Bar[], a: number, z: number) => {
  let m = Infinity;
  for (let i = a; i <= z; i++) m = Math.min(m, b[i].l);
  return m;
};

export function signalCands(sym: string, b4: Bar[], bd: Bar[], funding: { t: number; r: number }[], oi: { t: number; v: number }[], from: number): Cand[] {
  const c = b4.map((x) => x.c);
  const A = atr(b4);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const R = rsi(c);
  const dr = b4.map((x) => (x.q ? delta(x) / x.q : 0));
  const dc = bd.map((x) => x.c);
  const de20 = ema(dc, 20);
  const de50 = ema(dc, 50);
  const oiAt = new Map(oi.map((x) => [x.t, x.v]));
  const out: Cand[] = [];
  let f = 0;
  let d = 0;
  const push = (i: number, name: string, side: 1 | -1, T: number) =>
    out.push({ sym, T, rank: 0, name, side, zone: [c[i], c[i]], entry: c[i], stop: 0, t1: 0, a4: A[i], px: c[i], score: 0, grade: "-", expR: 0, pWin: 0, pReach: 0, flow: { dr: dr[i], rsi: R[i] ?? 50 }, regime: "", levels: [], market: true });
  for (let i = 60; i < b4.length; i++) {
    const T = b4[i].t + H4;
    while (f + 1 < funding.length && funding[f + 1].t <= T) f++;
    while (d + 1 < bd.length && bd[d + 1].t + DAY <= T) d++;
    if (T < from) continue;
    const b = b4[i];
    const dUp = dc[d] > de20[d] && de20[d] > de50[d];
    const dDn = dc[d] < de20[d] && de20[d] < de50[d];

    // Sweep and reclaim: stop run through a recent extreme that closes back inside.
    const pLo = lo(b4, i - 30, i - 3);
    const pHi = hi(b4, i - 30, i - 3);
    if (b.l < pLo && b.c > pLo) push(i, "Sweep reclaim", 1, T);
    if (b.h > pHi && b.c < pHi) push(i, "Sweep reclaim", -1, T);

    // CVD divergence over the last four days, on a fresh extreme that has turned.
    let cum = 0;
    let c1lo = Infinity;
    let c2lo = Infinity;
    let c1hi = -Infinity;
    let c2hi = -Infinity;
    for (let k = i - 23; k <= i; k++) {
      cum += b4[k].q ? delta(b4[k]) : 0;
      if (k <= i - 12) {
        c1lo = Math.min(c1lo, cum);
        c1hi = Math.max(c1hi, cum);
      } else {
        c2lo = Math.min(c2lo, cum);
        c2hi = Math.max(c2hi, cum);
      }
    }
    const lo1 = lo(b4, i - 23, i - 12);
    const lo2 = lo(b4, i - 11, i);
    const hi1 = hi(b4, i - 23, i - 12);
    const hi2 = hi(b4, i - 11, i);
    if (lo2 < lo1 && c2lo > c1lo && Math.min(b.l, b4[i - 1].l) === lo2 && b.c > b4[i - 1].c) push(i, "CVD divergence", 1, T);
    if (hi2 > hi1 && c2hi < c1hi && Math.max(b.h, b4[i - 1].h) === hi2 && b.c < b4[i - 1].c) push(i, "CVD divergence", -1, T);

    // Trend pullback: daily and 4h trends agree, price dips to the 4h EMA20 and closes back with the trend.
    if (dUp && e20[i] > e50[i] && b.l <= e20[i] + 0.2 * A[i] && b.c > e20[i] && b.c > b.o) push(i, "Trend pullback", 1, T);
    if (dDn && e20[i] < e50[i] && b.h >= e20[i] - 0.2 * A[i] && b.c < e20[i] && b.c < b.o) push(i, "Trend pullback", -1, T);

    // Breakout on real volume with taker flow behind it.
    let vAvg = 0;
    for (let k = i - 20; k < i; k++) vAvg += b4[k].q / 20;
    if (b.c > hi(b4, i - 30, i - 1) && b.q > 1.5 * vAvg && dr[i] > 0) push(i, "Breakout", 1, T);
    if (b.c < lo(b4, i - 30, i - 1) && b.q > 1.5 * vAvg && dr[i] < 0) push(i, "Breakout", -1, T);

    // Flush: a fast move on falling OI, meaning forced exits rather than new positions.
    const move = (c[i] - c[i - 12]) / (A[i] * Math.sqrt(12));
    const oiNow = oiAt.get(b.t + H4) ?? oiAt.get(b.t);
    const oiThen = oiAt.get(b4[i - 12].t + H4) ?? oiAt.get(b4[i - 12].t);
    if (oiNow && oiThen) {
      const oiChg = oiNow / oiThen - 1;
      if (move < -1.5 && (R[i] ?? 50) < 35 && oiChg < -0.03) push(i, "Flush", 1, T);
      if (move > 1.5 && (R[i] ?? 50) > 65 && oiChg < -0.03) push(i, "Flush", -1, T);
    }

    // Funding extreme against its own history: the crowd paying up to be on one side.
    if (f >= 180) {
      let m = 0;
      let s = 0;
      for (let k = f - 179; k <= f; k++) m += funding[k].r / 180;
      for (let k = f - 179; k <= f; k++) s += (funding[k].r - m) ** 2 / 180;
      const z = s ? (funding[f].r - m) / Math.sqrt(s) : 0;
      if (z > 2.5 && (R[i] ?? 50) > 60) push(i, "Funding extreme", -1, T);
      if (z < -2.5 && (R[i] ?? 50) < 45) push(i, "Funding extreme", 1, T);
    }
  }
  return out;
}
