// GOKU: a mixture of classic indicators read together. Pure, no I/O.
// Trend: a fast and a slow EMA, each coloured by its slope. Momentum: Stoch RSI and WaveTrend, with WaveTrend
// cross dots and regular (R) and hidden (H) divergences. Location: the nearest support and resistance that price
// has tested before. A BUY or SELL needs WaveTrend to turn out of an extreme and at least one confirmation from the
// rest, or two when it fights the trend. Signals read closed candles only and never repaint, and every past signal
// on the loaded candles is replayed for the track record. Open interest, funding, liquidations and long/short
// ratios are not used.
import type { Bar } from "./types.ts";

export const GOKU = { fast: 34, slow: 89, rsi: 14, stoch: 14, k: 3, d: 3, n1: 10, n2: 21, ob: 53, ob2: 60, pivot: 8 };
// Candles a signal is given to work, per chart timeframe.
export const GOKU_HOLD: Record<string, number> = { "5m": 24, "15m": 16, "1h": 12, "4h": 8, "1d": 7 };

export type GokuDiv = { i: number; conf: number; bull: boolean; hidden: boolean; wt: number };
export type GokuCross = { i: number; bull: boolean; zone: boolean; wt: number };
export type GokuSignal = { i: number; t: number; side: 1 | -1; strong: boolean; why: string[]; px: number; level: number | null };
export type GokuLevel = { price: number; touches: number };
// hit: closed in the signal's favour after `hold` candles. race: moved 1 ATR its way before 1 ATR against.
export type GokuStats = { n: number; hit: number; base: number; avg: number; mfe: number; mae: number; race: number; raceN: number; strongN: number; strongHit: number; hold: number };
// What the side panel needs, without the per-candle arrays.
export type GokuView = { sym: string; tf: string; px: number; last: GokuSignal | null; ago: number; div: (GokuDiv & { ago: number }) | null; res: GokuLevel | null; sup: GokuLevel | null; stats: GokuStats; now: GokuRead["now"] };
export type GokuRead = {
  fast: number[];
  slow: number[];
  k: number[];
  d: number[];
  wt1: number[];
  wt2: number[];
  crosses: GokuCross[];
  divs: GokuDiv[];
  signals: GokuSignal[];
  res: GokuLevel | null;
  sup: GokuLevel | null;
  stats: GokuStats;
  now: { trend: 1 | -1 | 0; fastUp: boolean; slowUp: boolean; k: number; d: number; wt1: number; wt2: number };
};

const ema = (x: number[], n: number) => {
  const out = new Array<number>(x.length).fill(NaN);
  const a = 2 / (n + 1);
  let v = NaN;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) continue;
    v = Number.isFinite(v) ? v + a * (x[i] - v) : x[i];
    out[i] = v;
  }
  return out;
};
const sma = (x: number[], n: number) => {
  const out = new Array<number>(x.length).fill(NaN);
  let s = 0;
  let c = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(x[i])) {
      s += x[i];
      c++;
    }
    if (i >= n && Number.isFinite(x[i - n])) {
      s -= x[i - n];
      c--;
    }
    if (c === n) out[i] = s / n;
  }
  return out;
};
// Wilder's RSI.
const rsi = (c: number[], n: number) => {
  const out = new Array<number>(c.length).fill(NaN);
  let [g, l] = [0, 0];
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    const [up, dn] = [Math.max(ch, 0), Math.max(-ch, 0)];
    if (i <= n) {
      g += up / n;
      l += dn / n;
      if (i < n) continue;
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
    }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
};
const atr = (B: Bar[], n: number) => {
  const tr = B.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l));
  return ema(tr, n);
};

// `closed` is how many candles have closed; the rest are still forming and are drawn but never signal.
export function readGoku(B: Bar[], opts: { closed?: number; hold?: number } = {}): GokuRead {
  const n = B.length;
  const closed = Math.min(n, opts.closed ?? n);
  const hold = opts.hold ?? 10;
  const P = GOKU;
  const c = B.map((b) => b.c);
  const fast = ema(c, P.fast).map((v, i) => (i < P.fast ? NaN : v));
  const slow = ema(c, P.slow).map((v, i) => (i < P.slow ? NaN : v));

  // Stoch RSI 14 14 3 3.
  const r = rsi(c, P.rsi);
  const raw = r.map((v, i) => {
    if (i < P.rsi + P.stoch - 1) return NaN;
    let [lo, hi] = [Infinity, -Infinity];
    for (let k = i - P.stoch + 1; k <= i; k++) {
      lo = Math.min(lo, r[k]);
      hi = Math.max(hi, r[k]);
    }
    return hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50;
  });
  const K = sma(raw, P.k);
  const D = sma(K, P.d);

  // WaveTrend 10 21: the typical price's distance from its average, in units of its usual distance.
  const ap = B.map((b) => (b.h + b.l + b.c) / 3);
  const esa = ema(ap, P.n1);
  const dev = ema(ap.map((v, i) => Math.abs(v - esa[i])), P.n1);
  const ci = ap.map((v, i) => (dev[i] ? (v - esa[i]) / (0.015 * dev[i]) : 0));
  const wt1 = ema(ci, P.n2).map((v, i) => (i < P.n1 + P.n2 ? NaN : v));
  const wt2 = sma(wt1, 4);

  const crosses: GokuCross[] = [];
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(wt2[i - 1])) continue;
    const up = wt1[i - 1] <= wt2[i - 1] && wt1[i] > wt2[i];
    const dn = wt1[i - 1] >= wt2[i - 1] && wt1[i] < wt2[i];
    if (up || dn) crosses.push({ i, bull: up, wt: wt2[i], zone: up ? wt2[i] <= -P.ob : wt2[i] >= P.ob });
  }

  // Divergences between price and WaveTrend at 5-candle fractals, known two candles after the turn.
  const divs: GokuDiv[] = [];
  let lastTop = -1;
  let lastBot = -1;
  for (let i = 4; i < closed; i++) {
    const f = i - 2;
    const w = (k: number) => wt2[k];
    if (![w(f - 2), w(f - 1), w(f), w(f + 1), w(f + 2)].every(Number.isFinite)) continue;
    const top = w(f) > w(f - 1) && w(f) > w(f - 2) && w(f) > w(f + 1) && w(f) > w(f + 2);
    const bot = w(f) < w(f - 1) && w(f) < w(f - 2) && w(f) < w(f + 1) && w(f) < w(f + 2);
    const hiAt = (k: number) => Math.max(B[k - 1].h, B[k].h, B[k + 1].h);
    const loAt = (k: number) => Math.min(B[k - 1].l, B[k].l, B[k + 1].l);
    if (top) {
      const p = lastTop;
      if (p >= 0 && f - p >= 5 && f - p <= 60) {
        if (hiAt(f) > hiAt(p) && w(f) < w(p) && w(p) >= 30) divs.push({ i: f, conf: i, bull: false, hidden: false, wt: w(f) });
        else if (hiAt(f) < hiAt(p) && w(f) > w(p) && w(f) >= 0) divs.push({ i: f, conf: i, bull: false, hidden: true, wt: w(f) });
      }
      lastTop = f;
    }
    if (bot) {
      const p = lastBot;
      if (p >= 0 && f - p >= 5 && f - p <= 60) {
        if (loAt(f) < loAt(p) && w(f) > w(p) && w(p) <= -30) divs.push({ i: f, conf: i, bull: true, hidden: false, wt: w(f) });
        else if (loAt(f) > loAt(p) && w(f) < w(p) && w(f) <= 0) divs.push({ i: f, conf: i, bull: true, hidden: true, wt: w(f) });
      }
      lastBot = f;
    }
  }

  // Swing points that price has respected, each known only once its right side has printed.
  const L = P.pivot;
  const A = atr(B, 14);
  const pivots: { i: number; conf: number; price: number; high: boolean }[] = [];
  for (let i = L; i < closed - L; i++) {
    let hi = true;
    let lo = true;
    for (let k = i - L; k <= i + L && (hi || lo); k++) {
      if (k === i) continue;
      if (B[k].h >= B[i].h) hi = false;
      if (B[k].l <= B[i].l) lo = false;
    }
    if (hi) pivots.push({ i, conf: i + L, price: B[i].h, high: true });
    if (lo) pivots.push({ i, conf: i + L, price: B[i].l, high: false });
  }
  // Price tested a level at candle i: a wick reached within 0.4 ATR of it and the close held the right side.
  const testedAt = (i: number, side: 1 | -1) => {
    const a = A[i] || 0;
    for (const p of pivots) {
      if (p.conf > i || p.i < i - 300) continue;
      for (let k = Math.max(0, i - 2); k <= i; k++) {
        if (side > 0 && B[k].l <= p.price + 0.4 * a && B[i].c >= p.price - 0.2 * a && B[i].c > p.price - a) return p.price;
        if (side < 0 && B[k].h >= p.price - 0.4 * a && B[i].c <= p.price + 0.2 * a && B[i].c < p.price + a) return p.price;
      }
    }
    return null;
  };

  // Signals: a WaveTrend turn out of an extreme, then confirmations.
  const signals: GokuSignal[] = [];
  for (const x of crosses) {
    const i = x.i;
    if (i >= closed || i < P.slow + 3) continue;
    const side: 1 | -1 = x.bull ? 1 : -1;
    const ext = side > 0 ? Math.min(wt2[i], wt2[i - 1], wt2[i - 2]) <= -P.ob : Math.max(wt2[i], wt2[i - 1], wt2[i - 2]) >= P.ob;
    if (!ext) continue;
    const why: string[] = [];
    const kWin = [K[i], K[i - 1], K[i - 2], K[i - 3]];
    if (side > 0 ? Math.min(...kWin) <= 20 && K[i] > D[i] : Math.max(...kWin) >= 80 && K[i] < D[i]) why.push(side > 0 ? "Stoch RSI turned up from oversold" : "Stoch RSI turned down from overbought");
    const dv = divs.filter((d) => d.bull === (side > 0) && d.conf <= i && d.conf >= i - 8).at(-1);
    if (dv) why.push(`${dv.hidden ? "Hidden" : "Regular"} ${side > 0 ? "bullish" : "bearish"} divergence`);
    const lvl = testedAt(i, side);
    if (lvl !== null) why.push(side > 0 ? "Held a tested support" : "Rejected a tested resistance");
    const withTrend = side > 0 ? c[i] > slow[i] : c[i] < slow[i];
    const score = why.length;
    if (!(withTrend ? score >= 1 : score >= 2)) continue;
    const prev = signals.at(-1);
    if (prev && prev.side === side && i - prev.i < 6) continue;
    why.unshift(`WaveTrend crossed ${side > 0 ? "up from oversold" : "down from overbought"}`);
    why.push(withTrend ? `With the trend (price ${side > 0 ? "above" : "below"} the slow EMA)` : "Against the trend, so it needed two confirmations");
    signals.push({ i, t: B[i].t, side, px: c[i], level: lvl, strong: score >= 3 || (withTrend && score >= 2) || (!!dv && lvl !== null), why });
  }

  // Nearest tested levels around the last close: pivots grouped within half an ATR, needing two touches.
  const last = closed - 1;
  const a = A[last] || 0;
  const live = pivots.filter((p) => p.conf <= last && p.i >= last - 400);
  const groups = live.map((p) => {
    const near = live.filter((q) => Math.abs(q.price - p.price) <= 0.5 * a);
    return { price: near.reduce((s, q) => s + q.price, 0) / near.length, touches: near.length };
  });
  const pick = (side: 1 | -1) => {
    const px = c[last];
    const cands = groups.filter((g) => (side < 0 ? g.price > px + 0.1 * a : g.price < px - 0.1 * a)).sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px));
    return cands.find((g) => g.touches >= 2) ?? cands[0] ?? null;
  };

  // Track record on these candles: each closed signal held for `hold` candles, against the plain base rate.
  let [hits, sum, mfe, mae, sN, sHit, ups, all, rWin, rN] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const done = signals.filter((s) => s.i + hold < closed);
  for (const s of done) {
    const ret = ((c[s.i + hold] - c[s.i]) / c[s.i]) * s.side * 100;
    let [best, worst] = [0, 0];
    let raced = false;
    const r1 = A[s.i] || 0;
    for (let k = s.i + 1; k <= s.i + hold; k++) {
      best = Math.max(best, ((s.side > 0 ? B[k].h - c[s.i] : c[s.i] - B[k].l) / c[s.i]) * 100);
      worst = Math.max(worst, ((s.side > 0 ? c[s.i] - B[k].l : B[k].h - c[s.i]) / c[s.i]) * 100);
      // First to 1 ATR either way; a candle that reaches both is left out because its order is unknown.
      if (!raced && r1) {
        const fav = s.side > 0 ? B[k].h >= c[s.i] + r1 : B[k].l <= c[s.i] - r1;
        const adv = s.side > 0 ? B[k].l <= c[s.i] - r1 : B[k].h >= c[s.i] + r1;
        if (fav || adv) {
          raced = true;
          if (fav !== adv) {
            rN++;
            if (fav) rWin++;
          }
        }
      }
    }
    if (ret > 0) hits++;
    sum += ret;
    mfe += best;
    mae += worst;
    if (s.strong) {
      sN++;
      if (ret > 0) sHit++;
    }
  }
  for (let i = P.slow; i + hold < closed; i++) {
    all++;
    if (c[i + hold] > c[i]) ups++;
  }
  const pUp = all ? ups / all : 0.5;
  const buys = done.filter((s) => s.side > 0).length;
  const N = done.length;
  const stats: GokuStats = {
    n: N,
    hit: N ? hits / N : 0,
    base: N ? (buys * pUp + (N - buys) * (1 - pUp)) / N : 0.5,
    avg: N ? sum / N : 0,
    mfe: N ? mfe / N : 0,
    mae: N ? mae / N : 0,
    race: rN ? rWin / rN : 0,
    raceN: rN,
    strongN: sN,
    strongHit: sN ? sHit / sN : 0,
    hold,
  };
  const j = n - 1;
  return {
    fast,
    slow,
    k: K,
    d: D,
    wt1,
    wt2,
    crosses,
    divs,
    signals,
    res: pick(-1),
    sup: pick(1),
    stats,
    now: { trend: c[j] > slow[j] && fast[j] > slow[j] ? 1 : c[j] < slow[j] && fast[j] < slow[j] ? -1 : 0, fastUp: fast[j] >= fast[j - 1], slowUp: slow[j] >= slow[j - 1], k: K[j], d: D[j], wt1: wt1[j], wt2: wt2[j] },
  };
}
