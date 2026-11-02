// Pure indicator and statistics functions. No I/O: safe on server and client.
import type { Bar, OrderBlock, Profile, LiqCluster } from "./types.ts";

export function ema(v: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = new Array(v.length);
  let e = v[0];
  for (let i = 0; i < v.length; i++) {
    e = i === 0 ? v[0] : v[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function sma(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

// Wilder RSI
export function rsi(c: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  let up = 0;
  let dn = 0;
  for (let i = 1; i <= n; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) up += d;
    else dn -= d;
  }
  up /= n;
  dn /= n;
  out[n] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    up = (up * (n - 1) + Math.max(d, 0)) / n;
    dn = (dn * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

// Wilder ATR
export function atr(b: Bar[], n = 14): number[] {
  const out: number[] = new Array(b.length).fill(0);
  let a = 0;
  for (let i = 0; i < b.length; i++) {
    const tr = i === 0 ? b[i].h - b[i].l : Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}

// Per-candle signed volume in USDT: taker buys minus taker sells.
export const delta = (b: Bar) => (2 * b.tb - b.v) * ((b.h + b.l + b.c) / 3);

export function cvd(b: Bar[]): number[] {
  let s = 0;
  return b.map((x) => (s += delta(x)));
}

export const sumDelta = (b: Bar[], n: number) => b.slice(-n).reduce((s, x) => s + delta(x), 0);

export type Pivot = { i: number; price: number };

export function pivots(b: Bar[], s = 5): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  for (let i = s; i < b.length - s; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - s; j <= i + s; j++) {
      if (j === i) continue;
      if (b[j].h >= b[i].h) isH = false;
      if (b[j].l <= b[i].l) isL = false;
    }
    if (isH) highs.push({ i, price: b[i].h });
    if (isL) lows.push({ i, price: b[i].l });
  }
  return { highs, lows };
}

export function avwap(b: Bar[], from: number): { t: number; v: number }[] {
  let pv = 0;
  let vol = 0;
  const out: { t: number; v: number }[] = [];
  for (let i = Math.max(from, 0); i < b.length; i++) {
    const tp = (b[i].h + b[i].l + b[i].c) / 3;
    pv += tp * b[i].v;
    vol += b[i].v;
    out.push({ t: b[i].t, v: vol ? pv / vol : tp });
  }
  return out;
}

// Double AVWAP ribbon: VWAPs anchored at the major high and major low of the lookback.
export function ribbonAnchors(b: Bar[], look = 200) {
  const start = Math.max(0, b.length - look);
  let hi = start;
  let lo = start;
  for (let i = start; i < b.length; i++) {
    if (b[i].h > b[hi].h) hi = i;
    if (b[i].l < b[lo].l) lo = i;
  }
  return { hi, lo };
}

// Order blocks: the last opposite candle before a displacement that breaks structure.
// Only blocks that have not been closed through are returned.
export function orderBlocks(b: Bar[], maxEach = 3): OrderBlock[] {
  if (b.length < 40) return [];
  const a = atr(b);
  const { highs, lows } = pivots(b, 4);
  const found: (OrderBlock & { i: number })[] = [];
  const used = new Set<number>();
  let hIdx = 0;
  let lIdx = 0;
  let lastH: Pivot | null = null;
  let lastL: Pivot | null = null;
  for (let i = 10; i < b.length; i++) {
    while (hIdx < highs.length && highs[hIdx].i + 4 <= i) lastH = highs[hIdx++];
    while (lIdx < lows.length && lows[lIdx].i + 4 <= i) lastL = lows[lIdx++];
    const disp = Math.abs(b[i].c - b[i].o) > 0.8 * a[i] || b[i].h - b[i].l > 1.5 * a[i];
    if (lastH && b[i].c > lastH.price && b[i - 1].c <= lastH.price && disp) {
      for (let j = i; j >= Math.max(0, i - 15); j--) {
        if (b[j].c < b[j].o && !used.has(j)) {
          used.add(j);
          found.push({ side: "bull", t: b[j].t, i: j, top: b[j].o, bottom: b[j].l, tests: 0 });
          break;
        }
      }
    }
    if (lastL && b[i].c < lastL.price && b[i - 1].c >= lastL.price && disp) {
      for (let j = i; j >= Math.max(0, i - 15); j--) {
        if (b[j].c > b[j].o && !used.has(j)) {
          used.add(j);
          found.push({ side: "bear", t: b[j].t, i: j, top: b[j].h, bottom: b[j].o, tests: 0 });
          break;
        }
      }
    }
  }
  const px = b[b.length - 1].c;
  const alive = found.filter((o) => {
    for (let k = o.i + 2; k < b.length; k++) {
      if (o.side === "bull" && b[k].c < o.bottom) return false;
      if (o.side === "bear" && b[k].c > o.top) return false;
      if (o.side === "bull" && b[k].l <= o.top) o.tests++;
      if (o.side === "bear" && b[k].h >= o.bottom) o.tests++;
    }
    return true;
  });
  const near = (o: OrderBlock) => Math.abs((o.top + o.bottom) / 2 - px);
  const pick = (s: "bull" | "bear") =>
    alive
      .filter((o) => o.side === s)
      .sort((x, y) => near(x) - near(y))
      .slice(0, maxEach);
  return [...pick("bull"), ...pick("bear")].map(({ side, t, top, bottom, tests }) => ({ side, t, top, bottom, tests }));
}

// Volume profile: each candle's volume is spread evenly across the rows it spans.
export function volumeProfile(b: Bar[], rows = 48): Profile {
  const hi = Math.max(...b.map((x) => x.h));
  const lo = Math.min(...b.map((x) => x.l));
  const step = (hi - lo) / rows || 1;
  const vols = new Array(rows).fill(0);
  for (const x of b) {
    const a = Math.min(rows - 1, Math.floor((x.l - lo) / step));
    const z = Math.min(rows - 1, Math.floor((x.h - lo) / step));
    const share = x.q / (z - a + 1);
    for (let i = a; i <= z; i++) vols[i] += share;
  }
  let poc = 0;
  vols.forEach((v, i) => {
    if (v > vols[poc]) poc = i;
  });
  const total = vols.reduce((s, v) => s + v, 0);
  let up = poc;
  let dn = poc;
  let acc = vols[poc];
  while (acc < total * 0.7 && (up < rows - 1 || dn > 0)) {
    const a = up < rows - 1 ? vols[up + 1] : -1;
    const c = dn > 0 ? vols[dn - 1] : -1;
    if (a >= c) acc += vols[++up];
    else acc += vols[--dn];
  }
  return {
    poc: lo + (poc + 0.5) * step,
    vah: lo + (up + 1) * step,
    val: lo + dn * step,
    rows: vols.map((vol, i) => ({ price: lo + (i + 0.5) * step, vol })),
  };
}

export function ols(y: number[], x: number[]) {
  const n = Math.min(y.length, x.length);
  const my = y.reduce((s, v) => s + v, 0) / n;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
    syy += (y[i] - my) ** 2;
  }
  const beta = sxx ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (y[i] - alpha - beta * x[i]) ** 2;
  const s2 = sse / Math.max(1, n - 2);
  const seA = Math.sqrt(s2 * (1 / n + (mx * mx) / (sxx || 1)));
  const corr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  return { alpha, beta, corr, t: seA ? alpha / seA : 0 };
}

export const returns = (c: number[]) => c.slice(1).map((v, i) => v / c[i] - 1);

export function stdev(v: number[]) {
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
}

// Estimated liquidation map. Replays OI changes into entry cohorts, removes cohorts whose
// liquidation price was crossed, and scales closes proportionally. Two leverage mixes are
// averaged because per-position leverage is not public. This is a model, not exchange data.
export function liquidationMap(
  bars: Bar[], // 4h bars covering the OI window
  oi: { t: number; v: number }[], // base-asset OI per 4h
  px: number,
  scale: number,
): LiqCluster[] {
  const mixes = [
    { lev: [3, 5, 10, 20, 40], w: [0.15, 0.25, 0.3, 0.2, 0.1] },
    { lev: [2, 3, 5, 10, 20], w: [0.25, 0.25, 0.25, 0.15, 0.1] },
  ];
  const mm = 0.005;
  const byT = new Map(bars.map((b) => [b.t, b]));
  const binPct = 0.01;
  const bins = new Map<number, { long: number; short: number }>();
  for (const { lev, w } of mixes) {
    type C = { e: number; L: number[]; S: number[] };
    const start = bars.find((b) => b.t >= oi[0].t) ?? bars[0];
    const coh: C[] = [{ e: start.c, L: w.map((x) => x * oi[0].v), S: w.map((x) => x * oi[0].v) }];
    const total = () => coh.reduce((s, c) => s + c.L.reduce((a, x) => a + x, 0) + c.S.reduce((a, x) => a + x, 0), 0) / 2;
    for (let i = 1; i < oi.length; i++) {
      const b = byT.get(oi[i].t);
      if (!b) continue;
      for (const c of coh) {
        lev.forEach((L, j) => {
          if (b.l <= c.e * (1 - 1 / L + mm)) c.L[j] = 0;
          if (b.h >= c.e * (1 + 1 / L - mm)) c.S[j] = 0;
        });
      }
      const now = total();
      if (oi[i].v > now) {
        const add = oi[i].v - now;
        coh.push({ e: b.c, L: w.map((x) => x * add), S: w.map((x) => x * add) });
      } else if (now > 0) {
        const f = oi[i].v / now;
        for (const c of coh) {
          c.L = c.L.map((x) => x * f);
          c.S = c.S.map((x) => x * f);
        }
      }
    }
    for (const c of coh) {
      lev.forEach((L, j) => {
        const lp = c.e * (1 - 1 / L + mm);
        const sp = c.e * (1 + 1 / L - mm);
        const add = (price: number, side: "long" | "short", amt: number) => {
          if (amt <= 0) return;
          const k = Math.round(Math.log(price / px) / Math.log(1 + binPct));
          if (Math.abs(k) > 25) return;
          const e = bins.get(k) ?? { long: 0, short: 0 };
          e[side] += (amt * px * scale) / mixes.length;
          bins.set(k, e);
        };
        if (lp < px) add(lp, "long", c.L[j]);
        if (sp > px) add(sp, "short", c.S[j]);
      });
    }
  }
  const out: LiqCluster[] = [];
  for (const [k, e] of bins) {
    const price = px * (1 + binPct) ** k;
    if (e.long > 0) out.push({ price, side: "long", usd: e.long });
    if (e.short > 0) out.push({ price, side: "short", usd: e.short });
  }
  return out.sort((a, b) => a.price - b.price);
}
