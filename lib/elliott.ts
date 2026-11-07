// Elliott Wave, counted by machine. Pure, no I/O.
// Swings come from a zigzag at three sizes: 2.5, 4 and 6.5 ATR. At each size the latest swings are tested against
// every position a count can be in: wave 3, 4 or 5 of an impulse, or wave A, B or C of the correction after one.
// Elliott's three hard rules must hold (Frost and Prechter): wave 2 never retraces all of wave 1, wave 3 is never the
// shortest of 1, 3 and 5, and wave 4 never trades into wave 1's range. Counts that pass are scored on the Fibonacci
// guidelines: wave 2 near 50-62% of wave 1, wave 3 near 1.618 or 2.618 of wave 1, wave 4 near 38% of wave 3, wave 5
// near wave 1 or 0.618 of waves 1-3, alternation between waves 2 and 4, zigzag B near 50-62% of A and C near A or
// 1.618 A, flat B near all of A. The Elliott Wave Oscillator (5/35) adds weight when wave 3 carries the strongest
// momentum and wave 5 diverges, and a count scores higher when it starts from a real extreme. The best count is drawn
// with its targets and the price that would prove it wrong; the best count pointing the other way is the alternate.
// Every past candle is recounted with only the swings known then, to score how often the first target traded before
// the invalidation. Open interest, funding, liquidations and long/short ratios are not used.
import type { Bar } from "./types.ts";

export const EW_SIZES = [2.5, 4, 6.5];
const DEGREE = ["small", "medium", "large"] as const;

type Piv = { i: number; price: number; high: boolean };
export type EwPoint = { t: number; price: number; label: string; high: boolean; ratio: string | null };
export type EwLevel = { price: number; label: string };
export type EwCheck = { ok: boolean; text: string };
export type EwKind = "2" | "3" | "4" | "5" | "A" | "B" | "C";
export type EwCount = {
  kind: EwKind;
  dir: 1 | -1; // the direction of the impulse this count belongs to
  next: 1 | -1; // the direction of the wave in progress
  degree: string;
  size: number;
  title: string;
  score: number;
  points: EwPoint[]; // finished waves, oldest first, starting with the impulse origin
  live: EwPoint; // the wave in progress, at its extreme so far
  targets: EwLevel[]; // where the wave in progress tends to end, nearest first
  invalid: EwLevel; // trading beyond this proves the count wrong
  then: EwLevel | null; // where the following wave tends to go, for wave 4 and B
  // The price that proves the count right. Usually the first target; for waves 2 and 4, which move toward their
  // invalidation, it is the end of the wave before them, because clearing it means the next impulse wave has begun.
  goal: EwLevel;
  checks: EwCheck[];
  key: string; // identity of the count, for the replay
};
export type EwStats = { n: number; hit: number; miss: number; open: number; base: number };
export type EwRead = { primary: EwCount | null; alternate: EwCount | null; all: EwCount[]; ewo: number; ewoPct: number; stats: EwStats };

const sma = (x: number[], n: number) => {
  const out = new Array<number>(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
};
const atrOf = (B: Bar[], n = 14) => {
  const out: number[] = [];
  let v = 0;
  B.forEach((b, i) => {
    const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l;
    v = i < n ? (v * i + tr) / (i + 1) : (v * (n - 1) + tr) / n;
    out.push(v);
  });
  return out;
};

// Closeness of a ratio to its Fibonacci ideals, 0 to 1, measured in log terms so 0.5 and 2 are equally far from 1.
const fit = (x: number, ideals: [number, number, number?][]) =>
  x > 0 ? Math.max(...ideals.map(([ideal, tol, w = 1]) => w * Math.exp(-((Math.log(x / ideal) / tol) ** 2)))) : 0;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const r2s = (x: number) => x.toFixed(2).replace(/^0/, "");

// A zigzag that only turns once price has come back `k` ATRs from its extreme. Recording its state at every candle
// lets the replay see exactly the swings that were known at that time.
function zigzag(B: Bar[], atr: number[], k: number) {
  const piv: Piv[] = [];
  const count: number[] = [];
  const live: { i: number; price: number; high: boolean }[] = [];
  let dir = 0;
  let ei = 0;
  let ep = 0;
  let hiI = 0;
  let loI = 0;
  for (let i = 0; i < B.length; i++) {
    const a = atr[i] * k;
    if (dir === 0) {
      if (B[i].h >= B[hiI].h) hiI = i;
      if (B[i].l <= B[loI].l) loI = i;
      if (hiI < i && B[hiI].h - B[i].l >= a) {
        piv.push({ i: hiI, price: B[hiI].h, high: true });
        [dir, ei, ep] = [-1, i, B[i].l];
      } else if (loI < i && B[i].h - B[loI].l >= a) {
        piv.push({ i: loI, price: B[loI].l, high: false });
        [dir, ei, ep] = [1, i, B[i].h];
      }
    } else if (dir > 0) {
      if (B[i].h >= ep) [ei, ep] = [i, B[i].h];
      else if (ep - B[i].l >= a) {
        piv.push({ i: ei, price: ep, high: true });
        [dir, ei, ep] = [-1, i, B[i].l];
      }
    } else {
      if (B[i].l <= ep) [ei, ep] = [i, B[i].l];
      else if (B[i].h - ep >= a) {
        piv.push({ i: ei, price: ep, high: false });
        [dir, ei, ep] = [1, i, B[i].h];
      }
    }
    count.push(piv.length);
    live.push({ i: ei, price: ep, high: dir > 0 });
  }
  return { piv, count, live };
}

type Ctx = { B: Bar[]; ewo: number[]; size: number; degree: string };

// The strongest oscillator reading along a leg, in the leg's direction.
const legEwo = (ewo: number[], a: number, b: number, d: number) => {
  let m = -Infinity;
  for (let k = Math.max(0, a); k <= b; k++) if (Number.isFinite(ewo[k])) m = Math.max(m, d * ewo[k]);
  return m;
};
// Does the count start from a real extreme: nothing beyond it over as many candles before it as the count is long.
const isExtreme = (B: Bar[], p: Piv, span: number, d: number) => {
  for (let k = Math.max(0, p.i - span); k < p.i; k++) if (d > 0 ? B[k].l < p.price : B[k].h > p.price) return false;
  return true;
};

// Every count the latest swings allow at one swing size.
function countsAt(P: Piv[], L: { i: number; price: number }, close: number, ctx: Ctx): EwCount[] {
  const { B, ewo } = ctx;
  const out: EwCount[] = [];
  const N = P.length;
  const pt = (p: Piv, label: string, ratio: string | null): EwPoint => ({ t: B[p.i].t, price: p.price, label, high: p.high, ratio });
  const liveAs = (label: string, high: boolean): EwPoint => ({ t: B[L.i].t, price: L.price, label, high, ratio: null });

  for (const kind of ["3", "4", "5", "A", "B", "C"] as Exclude<EwKind, "2">[]) {
    const need = { "3": 3, "4": 4, "5": 5, A: 6, B: 7, C: 8 }[kind];
    if (N < need) continue;
    const s = P.slice(N - need);
    const d: 1 | -1 = s[0].high ? -1 : 1;
    const x = s.map((p) => d * p.price);
    const xl = d * L.price;
    const xc = d * close;
    const w1 = x[1] - x[0];
    // Rule 1: wave 2 stays inside wave 1.
    if (!(w1 > 0 && x[2] > x[0] && x[2] < x[1])) continue;
    const checks: EwCheck[] = [{ ok: true, text: "Wave 2 did not retrace all of wave 1" }];
    const fits: number[] = [];
    const r2 = (x[1] - x[2]) / w1;
    fits.push(fit(r2, [[0.5, 0.35], [0.618, 0.3]]));
    checks.push({ ok: r2 >= 0.382 && r2 <= 0.786, text: `Wave 2 retraced ${pct(r2)} of wave 1 (typical 50-62%)` });
    let w3 = 0;
    let w4 = 0;
    let w5 = 0;
    let ewoScore = 0.5;
    if (need >= 4) {
      w3 = x[3] - x[2];
      if (!(x[3] > x[1])) continue; // wave 3 must clear the end of wave 1
      const r3 = w3 / w1;
      fits.push(fit(r3, [[1.618, 0.25], [2.618, 0.25], [1, 0.2, 0.6]]));
      checks.push({ ok: r3 >= 1.382, text: `Wave 3 is ${r2s(r3)} times wave 1 (typical 1.618 or 2.618)` });
    }
    if (need >= 5) {
      w4 = x[3] - x[4];
      // Rule 3: wave 4 stays out of wave 1's range.
      if (!(x[4] > x[1] && x[4] < x[3])) continue;
      checks.push({ ok: true, text: "Wave 4 stayed out of wave 1's range" });
      const r4 = w4 / w3;
      fits.push(fit(r4, [[0.382, 0.3], [0.236, 0.3, 0.8], [0.5, 0.25, 0.8]]));
      checks.push({ ok: r4 >= 0.2 && r4 <= 0.5, text: `Wave 4 retraced ${pct(r4)} of wave 3 (typical 24-38%)` });
      const t2 = s[2].i - s[1].i;
      const t4 = s[4].i - s[3].i;
      const alt = Math.abs(r2 - r4) >= 0.15 || t2 / t4 < 0.67 || t2 / t4 > 1.5;
      fits.push(alt ? 1 : 0.4);
      checks.push({ ok: alt, text: alt ? "Waves 2 and 4 alternate in depth or time" : "Waves 2 and 4 look alike (guideline: they alternate)" });
      const e1 = legEwo(ewo, s[0].i, s[1].i, d);
      const e3 = legEwo(ewo, s[2].i, s[3].i, d);
      const strong3 = e3 > e1;
      ewoScore = strong3 ? 0.8 : 0.3;
      checks.push({ ok: strong3, text: strong3 ? "Momentum peaked in wave 3 (Elliott Wave Oscillator)" : "Wave 1 had more momentum than wave 3" });
    }
    if (need >= 6) {
      w5 = x[5] - x[4];
      if (!(x[5] > x[3])) continue; // no truncated fifths
      // Rule 2: wave 3 is never the shortest.
      if (w3 < w1 && w3 < w5) continue;
      checks.push({ ok: true, text: "Wave 3 is not the shortest of waves 1, 3 and 5" });
      const r5 = w5 / w1;
      fits.push(Math.max(fit(r5, [[1, 0.25], [1.618, 0.25, 0.8]]), fit(w5 / (x[3] - x[0]), [[0.618, 0.25]])));
      checks.push({ ok: Math.abs(r5 - 1) <= 0.25 || Math.abs(w5 / (x[3] - x[0]) - 0.618) <= 0.12 || Math.abs(r5 - 1.618) <= 0.25, text: `Wave 5 is ${r2s(r5)} times wave 1 (typical: equal, or 0.618 of waves 1-3)` });
      const e3 = legEwo(ewo, s[2].i, s[3].i, d);
      const e5 = legEwo(ewo, s[4].i, s[5].i, d);
      const div = e5 < e3;
      ewoScore = Math.min(1, ewoScore + (div ? 0.2 : -0.2));
      checks.push({ ok: div, text: div ? "Wave 5 momentum diverged from wave 3" : "Wave 5 carried more momentum than wave 3" });
    }

    // The wave in progress, its targets and its invalidation, all in the impulse's direction (x terms).
    let title = "";
    let next: 1 | -1 = d;
    let tg: [number, string][] = [];
    let inv: [number, string] = [x[need - 1], ""];
    let then: [number, string] | null = null;
    let points: EwPoint[] = [];
    let liveLabel = "";
    const imp = (k: number) => s.slice(0, k + 1).map((p, j) => pt(p, j === 0 ? "" : String(j), j === 2 ? r2s(r2) : j === 3 ? r2s(w3 / w1) : j === 4 ? r2s(w4 / w3) : j === 5 ? r2s(w5 / w1) : null));
    if (kind === "3") {
      if (!(xc > x[2])) continue;
      title = "Impulse: wave 3 in progress";
      tg = [[x[2] + w1, "3 = 1.0 × 1"], [x[2] + 1.618 * w1, "3 = 1.618 × 1"], [x[2] + 2.618 * w1, "3 = 2.618 × 1"]];
      inv = [x[2], "end of wave 2"];
      points = imp(2);
      liveLabel = "3";
      if (xl > x[1]) fits.push(1);
      else fits.push(0.5);
    } else if (kind === "4") {
      next = d === 1 ? -1 : 1;
      if (!(xc > x[1] && xl > x[1])) continue;
      title = "Impulse: wave 4 in progress";
      tg = [[x[3] - 0.236 * w3, "4 = 23.6% of 3"], [x[3] - 0.382 * w3, "4 = 38.2% of 3"], [x[3] - 0.5 * w3, "4 = 50% of 3"]];
      inv = [x[1], "end of wave 1 (wave 4 may not overlap it)"];
      const x4 = Math.max(x[3] - 0.382 * w3, x[1]);
      then = [x4 + w1, "then wave 5 = wave 1"];
      points = imp(3);
      liveLabel = "4";
    } else if (kind === "5") {
      if (!(xc > x[4] && xl > x[4])) continue;
      title = "Impulse: wave 5 in progress";
      const cap = w3 < w1 ? x[4] + w3 : Infinity; // rule 2 caps wave 5 when wave 3 is shorter than wave 1
      tg = ([[x[3], "beyond the end of wave 3"], [x[4] + 0.618 * (x[3] - x[0]), "5 = 0.618 × (1 to 3)"], [x[4] + w1, "5 = 1.0 × 1"], [x[4] + 1.618 * w1, "5 = 1.618 × 1 (extended)"]] as [number, string][]).filter(
        ([v]) => v <= cap,
      );
      inv = [x[4], "end of wave 4"];
      points = imp(4);
      liveLabel = "5";
      const e3 = legEwo(ewo, s[2].i, s[3].i, d);
      const el = legEwo(ewo, s[4].i, L.i, d);
      if (xl > x[3]) checks.push({ ok: el < e3, text: el < e3 ? "Wave 5 momentum is diverging from wave 3, as a fifth should" : "Wave 5 momentum still beats wave 3, so it may be an extended third" });
    } else {
      const span = x[5] - x[0];
      if (kind === "A") {
        next = d === 1 ? -1 : 1;
        if (!(xc < x[5])) continue;
        title = "Correction after a five-wave impulse: wave A in progress";
        tg = [[x[5] - 0.382 * span, "38.2% of the impulse"], [x[5] - 0.5 * span, "50% of the impulse"], [x[4], "wave 4, the usual end of the whole correction"], [x[5] - 0.618 * span, "61.8% of the impulse"]];
        inv = [x[5], "end of wave 5 (a new extreme means the fifth is extending)"];
        points = imp(5);
        liveLabel = "A";
      } else {
        const A = x[5] - x[6];
        const ra = A / span;
        if (!(ra > 0.1 && ra < 1)) continue;
        fits.push(fit(ra, [[0.382, 0.3], [0.5, 0.3], [0.618, 0.3]]));
        checks.push({ ok: ra >= 0.236 && ra <= 0.786, text: `Wave A retraced ${pct(ra)} of the impulse` });
        if (kind === "B") {
          if (!(xc > x[6])) continue;
          title = "Correction: wave B in progress";
          tg = [[x[6] + 0.5 * A, "B = 50% of A"], [x[6] + 0.618 * A, "B = 61.8% of A"], [x[6] + 0.786 * A, "B = 78.6% of A"], [x[5], "B = all of A (a flat)"]];
          inv = [x[6], "end of wave A (below it, B is over and C is under way)"];
          then = [x[6] + 0.618 * A - A, "then wave C = wave A"];
          points = [...imp(5), pt(s[6], "A", r2s(ra))];
          liveLabel = "B";
          next = d;
        } else {
          const Bw = x[7] - x[6];
          const rb = Bw / A;
          if (!(rb > 0.236 && rb < 1.382)) continue;
          const shape = rb < 0.8 ? "zigzag" : rb <= 1.05 ? "flat" : "expanded flat";
          fits.push(shape === "zigzag" ? fit(rb, [[0.5, 0.3], [0.618, 0.3]]) : fit(rb, [[1, 0.1], [1.236, 0.15, 0.8]]));
          checks.push({ ok: true, text: `Wave B retraced ${pct(rb)} of A, ${shape === "expanded flat" ? "an" : "a"} ${shape}` });
          if (!(xc < x[7])) continue;
          title = `Correction (${shape}): wave C in progress`;
          tg = [[x[7] - 0.618 * A, "C = 0.618 × A"], [x[7] - A, "C = A"], [x[7] - 1.618 * A, "C = 1.618 × A"]];
          inv = [Math.max(x[5], x[7]), x[7] >= x[5] ? "end of wave B" : "end of wave 5"];
          points = [...imp(5), pt(s[6], "A", r2s(ra)), pt(s[7], "B", r2s(rb))];
          liveLabel = "C";
          next = d === 1 ? -1 : 1;
        }
      }
    }

    // Targets the wave has not already traded through, nearest first; drop the count if none are left.
    const ahead = tg.filter(([v]) => (next === d ? v > Math.max(xc, xl) : v < Math.min(xc, xl))).sort((a, b) => Math.abs(a[0] - xc) - Math.abs(b[0] - xc));
    if (!ahead.length) continue;
    const span = L.i - s[0].i;
    const sig = isExtreme(B, s[0], Math.max(20, span), d) ? 1 : 0.35;
    const complete = { "3": 0.2, "4": 0.4, "5": 0.6, A: 0.8, B: 0.9, C: 1 }[kind];
    const f = fits.reduce((a, b) => a + b, 0) / fits.length;
    const score = Math.round(100 * (0.55 * f + 0.2 * sig + 0.1 * ewoScore + 0.15 * complete));
    checks.push({ ok: sig === 1, text: sig === 1 ? "The count starts from a real extreme" : "The count does not start from a clear extreme" });
    const px = (v: number) => d * v;
    out.push({
      kind,
      dir: d,
      next,
      degree: ctx.degree,
      size: ctx.size,
      title,
      score,
      points,
      live: liveAs(liveLabel, next > 0),
      targets: ahead.map(([v, label]) => ({ price: px(v), label })),
      invalid: { price: px(inv[0]), label: inv[1] },
      then: then ? { price: px(then[0]), label: then[1] } : null,
      goal: kind === "4" ? { price: s[3].price, label: "beyond the end of wave 3 (wave 5 under way)" } : { price: px(ahead[0][0]), label: ahead[0][1] },
      checks,
      key: `${ctx.size}|${kind}|${s[0].i}`,
    });
  }
  return out;
}

// Shorter counts for when no finished impulse is in view: wave 2 after a first wave from a real extreme, or a plain
// A-B-C with wave C in progress. Both still obey the rules: wave 2 may not pass the start of wave 1, and B may not
// run far past the start of A.
function simpleCounts(P: Piv[], L: { i: number; price: number }, close: number, ctx: Ctx): EwCount[] {
  const { B, ewo } = ctx;
  const out: EwCount[] = [];
  const N = P.length;
  const pt = (p: Piv, label: string, ratio: string | null): EwPoint => ({ t: B[p.i].t, price: p.price, label, high: p.high, ratio });
  const near = (tg: [number, string][], xc: number, xl: number, up: boolean) => tg.filter(([v]) => (up ? v > Math.max(xc, xl) : v < Math.min(xc, xl))).sort((a, b) => Math.abs(a[0] - xc) - Math.abs(b[0] - xc));
  if (N >= 2) {
    const [s0, s1] = P.slice(N - 2);
    const d: 1 | -1 = s0.high ? -1 : 1;
    const [x0, x1, xl, xc] = [d * s0.price, d * s1.price, d * L.price, d * close];
    const w1 = x1 - x0;
    const ahead = w1 > 0 && xl > x0 && xc > x0 ? near([[x1 - 0.5 * w1, "2 = 50% of 1"], [x1 - 0.618 * w1, "2 = 61.8% of 1"], [x1 - 0.786 * w1, "2 = 78.6% of 1"]], xc, xl, false) : [];
    if (ahead.length) {
      const sig = isExtreme(B, s0, Math.max(20, L.i - s0.i), d) ? 1 : 0.35;
      const strong = legEwo(ewo, s0.i, s1.i, d) > 0;
      const score = Math.round(100 * (0.55 * (strong ? 0.7 : 0.4) + 0.2 * sig + 0.05 + 0.015));
      out.push({
        kind: "2",
        dir: d,
        next: d === 1 ? -1 : 1,
        degree: ctx.degree,
        size: ctx.size,
        title: "New impulse: wave 2 in progress",
        score,
        points: [pt(s0, "", null), pt(s1, "1", null)],
        live: { t: B[L.i].t, price: L.price, label: "2", high: d < 0, ratio: null },
        targets: ahead.map(([v, label]) => ({ price: d * v, label })),
        invalid: { price: s0.price, label: "start of wave 1 (wave 2 can never go beyond it)" },
        then: { price: d * (x1 - 0.618 * w1 + 1.618 * w1), label: "then wave 3 = 1.618 × 1" },
        goal: { price: s1.price, label: "beyond the end of wave 1 (wave 3 under way)" },
        checks: [
          { ok: true, text: "Wave 2 has not retraced all of wave 1" },
          { ok: strong, text: strong ? "Wave 1 carried momentum (Elliott Wave Oscillator)" : "Wave 1 carried little momentum" },
          { ok: sig === 1, text: sig === 1 ? "Wave 1 starts from a real extreme" : "Wave 1 does not start from a clear extreme" },
        ],
        key: `${ctx.size}|2|${s0.i}`,
      });
    }
  }
  if (N >= 3) {
    const [s0, s1, s2] = P.slice(N - 3);
    const d: 1 | -1 = s0.high ? 1 : -1; // the trend the correction runs against
    const [x0, x1, x2, xl, xc] = [d * s0.price, d * s1.price, d * s2.price, d * L.price, d * close];
    const A = x0 - x1;
    const rb = A > 0 ? (x2 - x1) / A : 0;
    if (A > 0 && rb > 0.236 && rb < 1.382 && xc < x2) {
      const shape = rb < 0.8 ? "zigzag" : rb <= 1.05 ? "flat" : "expanded flat";
      const ahead = near([[x2 - 0.618 * A, "C = 0.618 × A"], [x2 - A, "C = A"], [x2 - 1.618 * A, "C = 1.618 × A"]], xc, xl, false);
      if (ahead.length) {
        const f = shape === "zigzag" ? fit(rb, [[0.5, 0.3], [0.618, 0.3]]) : fit(rb, [[1, 0.1], [1.236, 0.15, 0.8]]);
        const sig = isExtreme(B, s0, Math.max(20, L.i - s0.i), d === 1 ? -1 : 1) ? 1 : 0.35;
        const score = Math.round(100 * (0.55 * f + 0.2 * sig + 0.05 + 0.045));
        out.push({
          kind: "C",
          dir: d,
          next: d === 1 ? -1 : 1,
          degree: ctx.degree,
          size: ctx.size,
          title: `Correction (${shape}): wave C in progress`,
          score,
          points: [pt(s0, "", null), pt(s1, "A", null), pt(s2, "B", r2s(rb))],
          live: { t: B[L.i].t, price: L.price, label: "C", high: d < 0, ratio: null },
          targets: ahead.map(([v, label]) => ({ price: d * v, label })),
          invalid: { price: d * (shape === "zigzag" ? x2 : Math.max(x0, x2)), label: shape === "zigzag" ? "end of wave B" : x2 >= x0 ? "end of wave B (it ran past A's start)" : "start of wave A" },
          then: null,
          goal: { price: d * ahead[0][0], label: ahead[0][1] },
          checks: [
            { ok: true, text: `Wave B retraced ${pct(rb)} of A, ${shape === "expanded flat" ? "an" : "a"} ${shape}` },
            { ok: sig === 1, text: sig === 1 ? "The correction starts from a real extreme" : "The correction does not start from a clear extreme" },
          ],
          key: `${ctx.size}|abc|${s0.i}`,
        });
      }
    }
  }
  return out;
}

function best(all: EwCount[]) {
  const sorted = [...all].sort((a, b) => b.score - a.score);
  const primary = sorted[0] && sorted[0].score >= 40 ? sorted[0] : null;
  const alternate = primary ? (sorted.find((c) => c.next !== primary.next && c.score >= 35) ?? null) : null;
  return { primary, alternate, sorted };
}

export function readElliott(B: Bar[], opts: { closed?: number; replay?: boolean } = {}): EwRead {
  const n = B.length;
  const closed = Math.min(n, opts.closed ?? n);
  const atr = atrOf(B);
  const mid = B.map((b) => (b.h + b.l) / 2);
  const f5 = sma(mid, 5);
  const f35 = sma(mid, 35);
  const ewo = mid.map((_, i) => f5[i] - f35[i]);
  const zz = EW_SIZES.map((k) => zigzag(B, atr, k));

  // The count as of candle `at`, from the swings that were confirmed by then.
  const at = (j: number) => {
    const all: EwCount[] = [];
    zz.forEach((z, k) => {
      const P = z.piv.slice(0, z.count[j]);
      const ctx = { B, ewo, size: EW_SIZES[k], degree: DEGREE[k] };
      all.push(...countsAt(P, z.live[j], B[j].c, ctx), ...simpleCounts(P, z.live[j], B[j].c, ctx));
    });
    return best(all);
  };
  const now = at(n - 1);

  // Replay: each new primary count is a call. Did it prove right (its goal traded) before its invalidation?
  let [calls, hit, miss, open, base] = [0, 0, 0, 0, 0];
  if (opts.replay !== false) {
    let lastKey = "";
    for (let j = 120; j < closed; j += 1) {
      const c = at(j).primary;
      if (!c || c.key === lastKey) continue;
      lastKey = c.key;
      const T = c.goal.price;
      const X = c.invalid.price;
      const up = T > B[j].c;
      if (up ? X >= B[j].c : X <= B[j].c) continue; // the goal and the invalidation must sit on opposite sides
      const dT = Math.abs(T - B[j].c);
      const dX = Math.abs(B[j].c - X);
      if (!dT || !dX) continue;
      calls++;
      base += dX / (dT + dX); // a coin toss with the same distances
      let res = 0;
      for (let k = j + 1; k < closed && !res; k++) {
        const tHit = up ? B[k].h >= T : B[k].l <= T;
        const xHit = up ? B[k].l <= X : B[k].h >= X;
        if (tHit && xHit) res = 2; // both inside one candle: order unknown, counted as a miss
        else if (tHit) res = 1;
        else if (xHit) res = 2;
      }
      if (res === 1) hit++;
      else if (res === 2) miss++;
      else open++;
    }
  }
  const j = n - 1;
  return {
    primary: now.primary,
    alternate: now.alternate,
    all: now.sorted,
    ewo: ewo[j],
    ewoPct: (ewo[j] / B[j].c) * 100,
    stats: { n: calls, hit, miss, open, base: calls ? base / calls : 0 },
  };
}

// Top-down counting, as Elliott analysts work: the largest degree sets the frame, and each lower timeframe may only
// count the smaller waves inside the higher wave now in progress. An impulsive wave (3, 5, C, and A of a zigzag)
// divides into five waves its own way; a corrective wave (2, 4, B) into three against the trend, or five for the A of
// a zigzag. A lower count fits only if it starts where the higher wave started, at the same price.
const IMPULSE = new Set<EwKind>(["2", "3", "4", "5"]);
export function nestsIn(child: EwCount, parent: EwCount, childSec: number, parentSec: number) {
  const start = parent.points[parent.points.length - 1];
  const o = child.points[0];
  if (!start || !o) return false;
  if (o.t < start.t - 2 * childSec || o.t > start.t + parentSec) return false;
  if (Math.abs(o.price / start.price - 1) > 0.005) return false;
  const five = IMPULSE.has(child.kind) && child.dir === parent.next;
  const three = !IMPULSE.has(child.kind) && -child.dir === parent.next;
  if (parent.kind === "3" || parent.kind === "5" || parent.kind === "C") return five;
  return five || three; // 2, 4, B, and A, which can be a five or a three
}

// Counts on a lower timeframe that start exactly where a higher wave started. The zigzag runs from that turning point
// at a range of swing sizes, so the swings since it can line up as a five or a three, the way an analyst subdivides
// a wave instead of counting the latest swings alone.
const ANCHOR_SIZES = [2, 2.5, 3, 4, 5, 6.5, 8, 10, 13];
export function anchoredCounts(B: Bar[], start: { t: number; price: number; high: boolean }, sec: number, parentSec: number): EwCount[] {
  let ia = -1;
  for (let i = 0; i < B.length; i++) {
    if (B[i].t < start.t - 2 * sec || B[i].t > start.t + parentSec) continue;
    if (Math.abs((start.high ? B[i].h : B[i].l) / start.price - 1) < 1e-6) {
      ia = i;
      break;
    }
  }
  if (ia < 0 || B.length - ia < 8) return [];
  const S = B.slice(ia);
  const mid = B.map((b) => (b.h + b.l) / 2);
  const f5 = sma(mid, 5);
  const f35 = sma(mid, 35);
  const ewo = mid.map((_, i) => f5[i] - f35[i]).slice(ia);
  const atr = atrOf(B).slice(ia);
  const out: EwCount[] = [];
  for (const k of ANCHOR_SIZES) {
    const z = zigzag(S, atr, k);
    if (!z.piv.length || z.piv[0].i !== 0) continue; // the turning point itself must be the first swing
    const last = S.length - 1;
    const ctx = { B: S, ewo, size: k, degree: "nested" };
    for (const c of [...countsAt(z.piv, z.live[last], S[last].c, ctx), ...simpleCounts(z.piv, z.live[last], S[last].c, ctx)])
      if (c.points[0].t === S[0].t) out.push({ ...c, key: `a${c.key}` });
  }
  return out;
}

export type EwLink = { tf: string; count: EwCount };
// levels run from the highest timeframe down to the chart's. The frame is the largest count of good quality (60+)
// on the highest timeframe that has one; each level below adds its best count that fits inside the one above,
// from its own counts and from counts anchored at the start of the higher wave.
export function topDown(levels: { tf: string; sec: number; bars: Bar[]; read: EwRead }[]): EwLink[] {
  const chain: EwLink[] = [];
  let sec = 0;
  for (const lv of levels) {
    if (!chain.length) {
      const good = lv.read.all.filter((c) => c.score >= 60);
      if (!good.length) continue;
      const span = (c: EwCount) => c.live.t - c.points[0].t;
      chain.push({ tf: lv.tf, count: good.reduce((a, b) => (span(b) > span(a) || (span(b) === span(a) && b.score > a.score) ? b : a)) });
      sec = lv.sec;
      continue;
    }
    const parent = chain[chain.length - 1].count;
    const start = parent.points[parent.points.length - 1];
    const pool = [...lv.read.all, ...anchoredCounts(lv.bars, start, lv.sec, sec)];
    const kid = pool.filter((c) => nestsIn(c, parent, lv.sec, sec)).sort((a, b) => b.score - a.score)[0];
    if (!kid) break;
    chain.push({ tf: lv.tf, count: kid });
    sec = lv.sec;
  }
  return chain;
}
