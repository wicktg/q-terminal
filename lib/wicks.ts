// Reads candle wicks two ways. Pure, no I/O.
//   wick flow  what traded inside the wick, from smaller perp candles' taker data: who got trapped there
//   sweep      a wick through a resting level (swing, equal highs or lows, prior day) that closed back inside
// It also scores how each pattern played out on this coin, so a reader can see what is worth trusting.
import { atrA, colsFromBars } from "./mtf.ts";
import { walk } from "./structure.ts";
import type { Bar } from "./types.ts";

// Smaller candles used to read flow inside each wick, and how many 1,500-candle pages to fetch.
export const SUB_TF: Record<string, [string, number]> = { "5m": ["1m", 1], "15m": ["1m", 2], "1h": ["5m", 2], "4h": ["15m", 2], "1d": ["1h", 2] };
const TF_SEC: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const MIN_ATR = 0.3; // a wick shorter than this share of ATR is ordinary noise
const MIN_SHARE = 0.35; // and it must be a real share of its candle
const THIN = 0.6; // wick volume density below this means little traded there
const LEAN = 0.55; // share of one side's flow needed to call who drove it
const HORIZON = 8; // candles ahead used to score outcomes
const SHOW_BARS = 300;

export type WickKind = "trapped" | "rejected" | "thin" | "mixed";
export type SweepWhat = "swing high" | "swing low" | "equal highs" | "equal lows" | "prior day high" | "prior day low";
export type WickEvent = {
  t: number;
  side: "upper" | "lower"; // an upper wick reads bearish, a lower wick bullish
  tip: number;
  base: number;
  len: number; // in ATRs
  kind: WickKind | null; // null when no flow data covers the candle
  buy: number;
  sell: number;
  density: number | null; // the wick's share of candle volume over its share of candle range
  sweep: { level: number; what: SweepWhat; from: number } | null;
  held: boolean | null; // for sweeps: price has stayed back inside since
  score: number;
  live: boolean;
};
export type WickStat = { key: string; label: string; n: number; hit: number; avg: number; base: number };
export type WickRead = { sym: string; tf: string; asOf: number; horizon: number; flowFrom: number; events: WickEvent[]; stats: WickStat[] };

type Flow = { t: number; h: number; l: number; buy: number; sell: number };

// Taker buys and sells in dollars per smaller candle. Perps only, so old and new wicks are measured the same way.
const flows = (perp: Bar[]): Flow[] =>
  perp.map((b) => {
    const typ = (b.h + b.l + b.c) / 3;
    return { t: b.t, h: b.h, l: b.l, buy: b.tb * typ, sell: (b.v - b.tb) * typ };
  });

const overlap = (f: Flow, lo: number, hi: number) => {
  const inside = Math.min(f.h, hi) - Math.max(f.l, lo);
  if (inside < 0) return 0;
  return f.h > f.l ? inside / (f.h - f.l) : 1;
};

type Level = { price: number; high: boolean; from: number; touches: number };

export function readWicks(sym: string, tf: string, bars: Bar[], subPerp: Bar[]): WickRead {
  const n = bars.length;
  const b = colsFromBars(bars);
  const A = atrA(b);
  const sec = TF_SEC[tf];
  const L = tf === "1d" ? 3 : 5;
  const w = walk(colsFromBars(bars.slice(0, -1)), L);
  const F = flows(subPerp);
  const flowFrom = F[0]?.t ?? Infinity;

  // Smaller candles grouped under each chart candle.
  const sub: Flow[][] = Array.from({ length: n }, () => []);
  for (let i = 0, k = 0; i < n; i++) {
    while (k < F.length && F[k].t < b.t[i]) k++;
    for (let j = k; j < F.length && F[j].t < b.t[i] + sec; j++) sub[i].push(F[j]);
  }

  // Swing levels become live once confirmed. Swings close together count as equal highs or lows.
  const byConf = new Map<number, typeof w.swings>();
  for (const s of w.swings) byConf.set(s.conf, [...(byConf.get(s.conf) ?? []), s]);
  const open: Level[] = [];
  const day = (t: number) => Math.floor(t / 86400);
  const dayHi = new Map<number, { h: number; l: number; hi: number; li: number }>();
  for (let i = 0; i < n; i++) {
    const d = day(b.t[i]);
    const x = dayHi.get(d);
    if (!x) dayHi.set(d, { h: b.h[i], l: b.l[i], hi: i, li: i });
    else {
      if (b.h[i] > x.h) [x.h, x.hi] = [b.h[i], i];
      if (b.l[i] < x.l) [x.l, x.li] = [b.l[i], i];
    }
  }
  let takenUp = -1;
  let takenDn = -1;

  const events: (WickEvent & { i: number })[] = [];
  for (let i = 1; i < n; i++) {
    for (const s of byConf.get(i - 1) ?? []) {
      const near = open.find((p) => p.high === s.high && Math.abs(p.price - s.price) <= 0.15 * A[s.conf]);
      if (near) {
        near.touches++;
        near.price = s.high ? Math.max(near.price, s.price) : Math.min(near.price, s.price);
      } else open.push({ price: s.price, high: s.high, from: b.t[s.i], touches: 1 });
    }
    const [o, h, l, c] = [b.o[i], b.h[i], b.l[i], b.c[i]];
    const a = A[i - 1] || A[i] || 1e-12;
    const range = h - l;

    // Levels this candle swept, best first: prior day, then equal highs or lows, then a single swing.
    const swept: { up: WickEvent["sweep"]; dn: WickEvent["sweep"] } = { up: null, dn: null };
    const rank = (what: SweepWhat) => (what.startsWith("prior") ? 3 : what.startsWith("equal") ? 2 : 1);
    const offer = (key: "up" | "dn", s: NonNullable<WickEvent["sweep"]>) => {
      const cur = swept[key];
      if (!cur || rank(s.what) > rank(cur.what) || (rank(s.what) === rank(cur.what) && (key === "up" ? s.level > cur.level : s.level < cur.level))) swept[key] = s;
    };
    for (let k = open.length - 1; k >= 0; k--) {
      const p = open[k];
      if (p.high && h > p.price) {
        if (c < p.price) offer("up", { level: p.price, what: p.touches > 1 ? "equal highs" : "swing high", from: p.from });
        open.splice(k, 1);
      } else if (!p.high && l < p.price) {
        if (c > p.price) offer("dn", { level: p.price, what: p.touches > 1 ? "equal lows" : "swing low", from: p.from });
        open.splice(k, 1);
      }
    }
    if (sec < 86400) {
      const d = day(b.t[i]);
      const prev = dayHi.get(d - 1);
      if (prev) {
        if (takenUp !== d && h > prev.h) {
          takenUp = d;
          if (c < prev.h) offer("up", { level: prev.h, what: "prior day high", from: b.t[prev.hi] });
        }
        if (takenDn !== d && l < prev.l) {
          takenDn = d;
          if (c > prev.l) offer("dn", { level: prev.l, what: "prior day low", from: b.t[prev.li] });
        }
      }
    }

    for (const side of ["upper", "lower"] as const) {
      const tip = side === "upper" ? h : l;
      const base = side === "upper" ? Math.max(o, c) : Math.min(o, c);
      const len = Math.abs(tip - base);
      const sweep = side === "upper" ? swept.up : swept.dn;
      if (!sweep && (range <= 0 || len < MIN_ATR * a || len / range < MIN_SHARE)) continue;
      // Flow inside the wick, split from each smaller candle by how much of its range sat there.
      let [buy, sell, total] = [0, 0, 0];
      for (const f of sub[i]) {
        total += f.buy + f.sell;
        const k = len > 0 ? overlap(f, Math.min(tip, base), Math.max(tip, base)) : 0;
        buy += f.buy * k;
        sell += f.sell * k;
      }
      const covered = b.t[i] >= flowFrom && total > 0;
      const density = covered && len > 0 && range > 0 ? (buy + sell) / total / (len / range) : null;
      let kind: WickKind | null = null;
      if (density !== null) {
        const chase = side === "upper" ? buy : sell; // the side that pushed price into the wick
        const share = chase / Math.max(1e-9, buy + sell);
        kind = density < THIN ? "thin" : share >= LEAN ? "trapped" : share <= 1 - LEAN ? "rejected" : "mixed";
      }
      const score = (len / a) * (density === null ? 1 : Math.min(2.5, Math.max(0.5, density))) * (sweep ? 1.8 : 1) * (kind === "thin" ? 0.5 : 1);
      events.push({ i, t: b.t[i], side, tip, base, len: len / a, kind, buy, sell, density, sweep, held: null, score, live: i === n - 1 });
    }
  }

  // A sweep holds while no later candle closes back beyond the level.
  for (const e of events) {
    if (!e.sweep || e.live) continue;
    const lvl = e.sweep.level;
    let held = true;
    for (let j = e.i + 1; j < n && held; j++) if (e.side === "upper" ? b.c[j] > lvl : b.c[j] < lvl) held = false;
    e.held = held;
  }

  // How each pattern played out here: price moving the wick's way over the next few candles.
  const ahead = (i: number) => (i + HORIZON < n - 1 ? b.c[i + HORIZON] / b.c[i] - 1 : null);
  let [up, dn, all] = [0, 0, 0];
  for (let i = 0; i < n - 1 - HORIZON; i++) {
    const r = ahead(i)!;
    all++;
    if (r > 0) up++;
    else if (r < 0) dn++;
  }
  const groups: [string, string, (e: WickEvent) => boolean][] = [
    ["sweep-high", "Swept a high", (e) => !!e.sweep && e.side === "upper"],
    ["sweep-low", "Swept a low", (e) => !!e.sweep && e.side === "lower"],
    ["trap-high", "Buyers trapped in an upper wick", (e) => e.kind === "trapped" && e.side === "upper"],
    ["trap-low", "Sellers trapped in a lower wick", (e) => e.kind === "trapped" && e.side === "lower"],
    ["reject-high", "Sellers drove an upper wick down", (e) => e.kind === "rejected" && e.side === "upper"],
    ["reject-low", "Buyers drove a lower wick up", (e) => e.kind === "rejected" && e.side === "lower"],
  ];
  const stats: WickStat[] = groups.map(([key, label, test]) => {
    const moves = events.filter(test).map((e) => ({ e, r: ahead(e.i) })).filter((x): x is { e: typeof x.e; r: number } => x.r !== null).map(({ e, r }) => (e.side === "upper" ? -r : r));
    const bearish = key.endsWith("high");
    return {
      key,
      label,
      n: moves.length,
      hit: moves.length ? moves.filter((m) => m > 0).length / moves.length : 0,
      avg: moves.length ? (moves.reduce((s, m) => s + m, 0) / moves.length) * 100 : 0,
      base: all ? (bearish ? dn : up) / all : 0,
    };
  });

  const recent = events.filter((e) => e.i >= n - SHOW_BARS && (e.sweep || e.score >= 0.8));
  return { sym, tf, asOf: Date.now(), horizon: HORIZON, flowFrom: Number.isFinite(flowFrom) ? flowFrom : 0, events: recent.map(({ i: _i, ...e }) => e), stats };
}

// One plain sentence for a wick. The formatter is passed in so the page can use the coin's decimals.
export function wickText(e: WickEvent, px: (x: number) => string, usd: (x: number) => string) {
  const up = e.side === "upper";
  const head = e.sweep ? `${up ? "Upper" : "Lower"} wick swept the ${e.sweep.what} at ${px(e.sweep.level)} and closed back ${up ? "below" : "above"}` : `${up ? "Upper" : "Lower"} wick to ${px(e.tip)}`;
  const flow =
    e.kind === "trapped"
      ? up
        ? `, with ${usd(e.buy)} of market buying caught inside it. Buyers are trapped above.`
        : `, with ${usd(e.sell)} of market selling caught inside it. Sellers are trapped below.`
      : e.kind === "rejected"
        ? up
          ? `, as ${usd(e.sell)} of market selling drove it back down. Sellers rejected the high.`
          : `, as ${usd(e.buy)} of market buying drove it back up. Buyers rejected the low.`
        : e.kind === "thin"
          ? " on thin volume, a quick poke with little traded."
          : e.kind === "mixed"
            ? ", with two-way flow inside it."
            : ".";
  const after = e.held === null ? "" : e.held ? ` Price has stayed ${up ? "below" : "above"} the level since.` : ` The sweep failed: price has since closed back ${up ? "above" : "below"} the level.`;
  return `${e.live ? "Forming now: " : ""}${head}${flow}${after}`;
}

// A short tag for the chart.
export function wickTag(e: WickEvent, usd: (x: number) => string) {
  const flow = e.kind === "trapped" ? `TRAPPED ${usd(e.side === "upper" ? e.buy : e.sell)}` : e.kind === "rejected" ? `REJECTED ${usd(e.side === "upper" ? e.sell : e.buy)}` : "";
  return [e.sweep ? "SWEEP" : "", flow].filter(Boolean).join(" · ");
}
