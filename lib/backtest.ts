// Trade simulator. Walks 1h bars forward from the moment a setup was issued.
// Conservative by design: if one bar could hit both stop and target, the stop counts,
// a fill bar can stop out but cannot take profit, and every trade pays fees, slippage and funding.
import type { Bar, Level } from "./types.ts";
import { nextTargets } from "./model.ts";

export const HOUR = 3600;
export const COST = { maker: 0.0002, taker: 0.0005, slip: 0.0003 };

export type Cand = {
  sym: string;
  T: number; // moment it was issued, seconds. Only data before T was used.
  rank: number; // 0 is the setup the terminal shows
  name: string;
  side: 1 | -1;
  zone: [number, number];
  entry: number;
  stop: number;
  t1: number;
  a4: number;
  px: number;
  score: number;
  grade: string;
  expR: number;
  pWin: number;
  pReach: number;
  flow: Record<string, number>;
  regime: string;
  levels: Level[];
  market?: boolean; // enters at the next open instead of waiting at a zone
};

export type Rule = {
  entry: "limit" | "confirm";
  valid: number; // hours an order stays live
  hold: number; // hours a position stays open
  stopAtr: number | null; // null keeps the engine's stop
  target: "level" | number; // next level, or a fixed multiple of risk
};

export type Trade = {
  sym: string;
  name: string;
  side: 1 | -1;
  T: number;
  tIn: number;
  tOut: number;
  entry: number;
  stop: number;
  target: number;
  r: number;
  gross: number;
  how: "target" | "stop" | "time";
  cand: Cand;
};

export type Series = { bars: Bar[]; index: Map<number, number>; funding: { t: number; r: number }[] };

export function series(bars: Bar[], funding: { t: number; r: number }[]): Series {
  return { bars, index: new Map(bars.map((b, i) => [b.t, i])), funding };
}

function fundingPaid(s: Series, from: number, to: number) {
  let a = 0;
  let b = s.funding.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (s.funding[m].t <= from) a = m + 1;
    else b = m;
  }
  let sum = 0;
  for (let i = a; i < s.funding.length && s.funding[i].t <= to; i++) sum += s.funding[i].r;
  return sum;
}

const isPullback = (n: string) => n === "Pullback long" || n === "Rejection short";

function stopFor(c: Cand, rule: Rule) {
  if (rule.stopAtr === null) return c.stop;
  const [lo, hi] = c.zone;
  const k = rule.stopAtr * c.a4;
  if (c.name === "Pullback long" || c.name === "Breakout-retest long") return lo - k;
  return hi + k;
}

export function targetFor(c: Cand, entry: number, stop: number, rule: Rule) {
  const risk = Math.abs(entry - stop);
  if (rule.target === "level") return nextTargets(c.levels, entry, stop, c.side).t1;
  return entry + c.side * rule.target * risk;
}

// Finds the fill, returning the bar index, price and whether it paid taker fees.
function findEntry(c: Cand, s: Series, start: number, stop: number, rule: Rule) {
  if (c.market) return { i: start, px: s.bars[start].o, taker: true };
  const [lo, hi] = c.zone;
  const end = Math.min(s.bars.length - 1, start + rule.valid);
  const up = c.side > 0;
  if (isPullback(c.name)) {
    let touched = false;
    for (let i = start; i <= end; i++) {
      const b = s.bars[i];
      if (rule.entry === "limit") {
        if (up ? b.l <= c.entry : b.h >= c.entry) return { i, px: c.entry, taker: false };
        continue;
      }
      if (up ? b.c < stop : b.c > stop) return null; // zone failed before it confirmed
      if (up ? b.l <= hi : b.h >= lo) touched = true;
      if (touched && (up ? b.c > hi : b.c < lo) && i + 1 < s.bars.length) return { i: i + 1, px: s.bars[i + 1].o, taker: true };
    }
    return null;
  }
  // Break, then retest: the level must close through on a 4h candle first.
  const level = up ? hi : lo;
  let broken = false;
  for (let i = start; i <= end; i++) {
    const b = s.bars[i];
    if (broken) {
      if (up ? b.c < stop : b.c > stop) return null;
      const retest = up ? b.l <= level : b.h >= level;
      if (retest) {
        if (rule.entry === "limit") return { i, px: level, taker: false };
        if ((up ? b.c > level : b.c < level) && i + 1 < s.bars.length) return { i: i + 1, px: s.bars[i + 1].o, taker: true };
      }
    } else if ((b.t + HOUR) % (4 * HOUR) === 0 && (up ? b.c > level : b.c < level)) broken = true;
  }
  return null;
}

export type Sim = { trade: Trade | null; freeAt: number };

export function simulate(c: Cand, s: Series, rule: Rule): Sim {
  const start = s.index.get(c.T); // first bar opening at or after the moment of issue
  if (start === undefined) return { trade: null, freeAt: c.T };
  const zoneStop = stopFor(c, rule);
  const fill = findEntry(c, s, start, zoneStop, rule);
  if (!fill) return { trade: null, freeAt: c.T + rule.valid * HOUR };
  const { side } = c;
  const entry = fill.px;
  const stop = c.market ? entry - side * (rule.stopAtr ?? 1.5) * c.a4 : zoneStop;
  const risk = (entry - stop) * side;
  if (risk <= 0) return { trade: null, freeAt: s.bars[fill.i].t };
  const target = targetFor(c, entry, stop, rule);
  const end = Math.min(s.bars.length - 1, fill.i + rule.hold);
  let exit = 0;
  let how: Trade["how"] = "time";
  let at = end;
  for (let i = fill.i; i <= end; i++) {
    const b = s.bars[i];
    if (side > 0 ? b.l <= stop : b.h >= stop) {
      exit = side > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o); // a gap fills past the stop
      how = "stop";
      at = i;
      break;
    }
    if (i > fill.i && (side > 0 ? b.h >= target : b.l <= target)) {
      exit = target;
      how = "target";
      at = i;
      break;
    }
  }
  if (how === "time") exit = s.bars[end].c;
  const fees = (fill.taker ? COST.taker + COST.slip : COST.maker) + (how === "target" ? COST.maker : COST.taker + COST.slip);
  const tIn = s.bars[fill.i].t;
  const tOut = s.bars[at].t + HOUR;
  const paid = side * fundingPaid(s, tIn, tOut);
  const move = side * (exit / entry - 1);
  const riskPct = risk / entry;
  return {
    trade: { sym: c.sym, name: c.name, side, T: c.T, tIn, tOut, entry, stop, target, gross: move / riskPct, r: (move - fees - paid) / riskPct, how, cand: c },
    freeAt: tOut,
  };
}

// One position or live order per coin. A new signal is ignored until the coin is free.
export function run(cands: Cand[], data: Record<string, Series>, rule: Rule, pass: (c: Cand) => boolean): Trade[] {
  const out: Trade[] = [];
  const free: Record<string, number> = {};
  for (const c of cands) {
    if (c.T < (free[c.sym] ?? 0) || !pass(c)) continue;
    const r = simulate(c, data[c.sym], rule);
    free[c.sym] = r.freeAt;
    if (r.trade) out.push(r.trade);
  }
  return out;
}

export type Stats = { n: number; win: number; avg: number; total: number; pf: number; t: number; dd: number; days: number };

// The t-stat is on daily totals, not trades: alts move together, so trades are not independent.
export function stats(tr: Trade[]): Stats {
  const n = tr.length;
  if (!n) return { n: 0, win: 0, avg: 0, total: 0, pf: 0, t: 0, dd: 0, days: 0 };
  const total = tr.reduce((s, x) => s + x.r, 0);
  const up = tr.filter((x) => x.r > 0).reduce((s, x) => s + x.r, 0);
  const dn = tr.filter((x) => x.r <= 0).reduce((s, x) => s - x.r, 0);
  const byDay = new Map<number, number>();
  for (const x of tr) {
    const d = Math.floor(x.tOut / 86400);
    byDay.set(d, (byDay.get(d) ?? 0) + x.r);
  }
  const first = Math.min(...byDay.keys());
  const lastDay = Math.max(...byDay.keys());
  const days = lastDay - first + 1;
  const v: number[] = [];
  for (let d = first; d <= lastDay; d++) v.push(byDay.get(d) ?? 0);
  const m = total / days;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, days - 1));
  let peak = 0;
  let eq = 0;
  let dd = 0;
  for (const x of [...tr].sort((a, b) => a.tOut - b.tOut)) {
    eq += x.r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return { n, win: tr.filter((x) => x.r > 0).length / n, avg: total / n, total, pf: dn ? up / dn : 99, t: sd ? (m / sd) * Math.sqrt(days) : 0, dd, days };
}
