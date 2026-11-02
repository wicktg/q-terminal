// Reads one moment of a market into levels and flow scores. Pure, no I/O.
// The live terminal and the backtest both call this, so what gets tested is what runs.
import type { Analysis, Bar, Book, Level, Tone } from "./types.ts";
import { atr, avwap, ema, liquidationMap, orderBlocks, pivots, ribbonAnchors, sumDelta, volumeProfile } from "./quant.ts";
import { clamp, type Flow } from "./model.ts";

export const pct = (a: number, b: number) => (b ? (a / b - 1) * 100 : 0);
export const last = <T,>(a: T[]) => a[a.length - 1];

export function trendOf(b: Bar[]): Tone {
  const c = b.map((x) => x.c);
  const e20 = last(ema(c, 20));
  const e50 = last(ema(c, 50));
  const p = last(c);
  return p > e20 && e20 > e50 ? "up" : p < e20 && e20 < e50 ? "down" : "flat";
}

export type Market = {
  b4: Bar[];
  b1: Bar[];
  bd: Bar[];
  spot1: Bar[];
  oi4: { t: number; v: number }[] | null; // base-asset OI per 4h
  oi1: number[] | null; // base-asset OI per 1h
  retail: number[] | null;
  top: number[] | null;
  fundingApr: number | null;
  hlOi: number; // Hyperliquid OI in base units, 0 when unknown
  book?: (clusters: Analysis["liq"]["clusters"]) => Book | null;
};

export function readMarket(m: Market) {
  const { b4, b1, bd, spot1, top } = m;
  const px = last(b1).c;
  const c1 = b1.map((x) => x.c);
  const c4 = b4.map((x) => x.c);
  const cd = bd.map((x) => x.c);
  const a4 = last(atr(b4));

  // OI
  const oiC = m.oi1 ?? [];
  const oiBin = oiC.length ? last(oiC) * px : 0;
  const oiHl = m.hlOi * px;
  const oiCh = (n: number) => (oiC.length > n ? pct(last(oiC), oiC[oiC.length - 1 - n]) : null);
  const oiChg4h = oiCh(4);
  const pxChg4 = pct(px, c1[c1.length - 5]);
  const regime =
    oiChg4h === null ? "n/a" : Math.abs(oiChg4h) < 0.3 ? "Flat" : pxChg4 >= 0 ? (oiChg4h > 0 ? "New longs" : "Short covering") : oiChg4h > 0 ? "New shorts" : "Longs closing";

  // Ribbon on 4h, order blocks on 4h, profile on the last 60 days
  const { hi, lo } = ribbonAnchors(b4, 240);
  const vH = last(avwap(b4, hi)).v;
  const vL = last(avwap(b4, lo)).v;
  const obs = orderBlocks(b4);
  const profile = volumeProfile(b4.slice(-360));

  // Liquidation estimate
  let clusters: Analysis["liq"]["clusters"] = [];
  if (m.oi4?.length) {
    const scale = oiBin > 0 ? (oiBin + oiHl) / oiBin : 1;
    clusters = liquidationMap(b4, m.oi4, px, scale);
  }
  const within = (s: "long" | "short") => clusters.filter((c) => c.side === s && Math.abs(c.price / px - 1) <= 0.06).reduce((a, c) => a + c.usd, 0);
  const shortsAbove = within("short");
  const longsBelow = within("long");
  const skew = shortsAbove + longsBelow ? (shortsAbove - longsBelow) / (shortsAbove + longsBelow) : 0;

  const book = m.book?.(clusters) ?? null;

  // Taker flow
  const cvd24 = sumDelta(b1, 24);
  const spotD = spot1.length ? sumDelta(spot1, 24) : null;
  const vol24 = b1.slice(-24).reduce((s, x) => s + x.q, 0);

  const tChg = top ? last(top) - top[Math.max(0, top.length - 25)] : null;

  const t1 = trendOf(b1);
  const t4 = trendOf(b4);
  const tD = trendOf(bd);
  const tv = (t: Tone) => (t === "up" ? 1 : t === "down" ? -1 : 0);

  // Levels the setup engine and the forecast can use
  const levels: Level[] = [];
  const add = (price: number, label: string, weight: number) => {
    if (price > 0 && Number.isFinite(price)) levels.push({ price, label, weight });
  };
  const { highs, lows } = pivots(b4.slice(-180), 5);
  highs.slice(-5).forEach((p) => add(p.price, "Swing high", 1.2));
  lows.slice(-5).forEach((p) => add(p.price, "Swing low", 1.2));
  obs.forEach((o) => add((o.top + o.bottom) / 2, o.side === "bull" ? "Bullish OB" : "Bearish OB", 1.6));
  add(profile.poc, "POC", 1.5);
  add(profile.vah, "VAH", 1);
  add(profile.val, "VAL", 1);
  add(vH, "AVWAP high", 1.2);
  add(vL, "AVWAP low", 1.2);
  add(last(ema(c4, 20)), "EMA20 4h", 0.7);
  add(last(ema(c4, 50)), "EMA50 4h", 1);
  add(last(ema(c4, 200)), "EMA200 4h", 1.2);
  add(last(ema(cd, 50)), "EMA50 1D", 1.2);
  add(bd[bd.length - 2].h, "Prev day high", 0.6);
  add(bd[bd.length - 2].l, "Prev day low", 0.6);
  book?.walls.slice(0, 4).forEach((w) => add(w.price, w.side === "bid" ? "Bid wall" : "Ask wall", 0.9));

  const flow: Flow = {
    trend: (tv(tD) * 2 + tv(t4) * 2 + tv(t1)) / 5,
    cvd: clamp(Math.tanh(((cvd24 + (spotD ?? cvd24)) / 2 / (vol24 || 1)) * 25)),
    book: book?.imb2 ?? 0,
    analog: 0,
  };

  return { px, c1, c4, cd, a4, oiBin, oiHl, oiCh, oiChg4h, pxChg4, regime, hi, lo, vH, vL, obs, profile, clusters, shortsAbove, longsBelow, skew, book, cvd24, spotD, vol24, tChg, t1, t4, tD, levels, flow };
}
