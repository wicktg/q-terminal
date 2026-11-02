// Market structure from price alone. Pure, no I/O. One forward pass, so every record says when it became
// knowable: `conf` for swings, `born` for zones and pools. Reading the past never needs the future.
//   swing   pivot confirmed L bars after it printed, labelled HH, HL, LH or LL
//   BOS     close through the last swing, in the direction of the trend
//   CHoCH   close through the last swing, against the trend
//   MSS     a CHoCH made with displacement
//   OB      last opposite candle before a break, open to wick
//   SD      the tight base a displaced move left from
//   FVG     three-candle imbalance
//   pool    resting liquidity at equal highs or lows
//   sweep   wick through a pool or swing that closes back inside
import { atrA, type Cols } from "./mtf.ts";

export type Swing = { i: number; conf: number; price: number; high: boolean; label: "HH" | "HL" | "LH" | "LL" | "H" | "L" };
export type Ev = { i: number; kind: "BOS" | "CHoCH" | "MSS"; dir: 1 | -1; level: number; swing: number };
export type ZoneKind = "OB" | "SD" | "FVG";
export type Zone = { kind: ZoneKind; side: 1 | -1; top: number; bottom: number; origin: number; born: number; dead: number };
export type Pool = { high: boolean; price: number; born: number; touches: number; gone: number };
export type Sweep = { i: number; dir: 1 | -1; level: number; extreme: number };
export type Walk = { trend: Int8Array; swings: Swing[]; events: Ev[]; zones: Zone[]; pools: Pool[]; sweeps: Sweep[]; atr: Float64Array };

export function walk(b: Cols, L: number): Walk {
  const { n, o, h, l, c, q } = b;
  const A = atrA(b);
  const trend = new Int8Array(n);
  const swings: Swing[] = [];
  const events: Ev[] = [];
  const zones: Zone[] = [];
  const pools: Pool[] = [];
  const sweeps: Sweep[] = [];
  const active: Zone[] = [];
  const open: Pool[] = [];
  let [sh, sl] = [-1, -1]; // last swing high and low, as indexes into swings
  let [shDone, slDone] = [true, true];
  let [lastH, lastL] = [NaN, NaN];
  let dir = 0;
  let volAvg = 0;
  const addZone = (z: Zone) => {
    if (z.top <= z.bottom) return;
    zones.push(z);
    active.push(z);
  };
  const addPool = (high: boolean, price: number, i: number) => {
    const near = open.find((p) => p.high === high && Math.abs(p.price - price) <= 0.15 * A[i]);
    if (near) near.touches++;
    else {
      const p: Pool = { high, price, born: i, touches: 1, gone: Infinity };
      pools.push(p);
      open.push(p);
    }
  };
  for (let i = 0; i < n; i++) {
    volAvg = i < 20 ? (volAvg * i + q[i]) / (i + 1) : volAvg * 0.95 + q[i] * 0.05;
    const a = A[i] || 1e-12;

    // Sweeps are read before new swings, against levels already known at this bar.
    for (const p of open) {
      if (p.high && h[i] > p.price) {
        if (c[i] < p.price) sweeps.push({ i, dir: -1, level: p.price, extreme: h[i] });
        p.gone = i;
      } else if (!p.high && l[i] < p.price) {
        if (c[i] > p.price) sweeps.push({ i, dir: 1, level: p.price, extreme: l[i] });
        p.gone = i;
      }
    }
    for (let k = open.length - 1; k >= 0; k--) if (open[k].gone <= i) open.splice(k, 1);

    // Zones die when price closes through them. An FVG dies when it is fully traded.
    for (let k = active.length - 1; k >= 0; k--) {
      const z = active[k];
      if (i <= z.born) continue;
      const broke = z.side > 0 ? (z.kind === "FVG" ? l[i] <= z.bottom : c[i] < z.bottom) : z.kind === "FVG" ? h[i] >= z.top : c[i] > z.top;
      if (broke) {
        z.dead = i;
        active.splice(k, 1);
      }
    }

    if (i >= 2) {
      const [g0, g2] = [l[i] - h[i - 2], l[i - 2] - h[i]];
      if (g0 >= 0.2 * a) addZone({ kind: "FVG", side: 1, top: l[i], bottom: h[i - 2], origin: i - 1, born: i, dead: Infinity });
      else if (g2 >= 0.2 * a) addZone({ kind: "FVG", side: -1, top: l[i - 2], bottom: h[i], origin: i - 1, born: i, dead: Infinity });
    }

    // Pivot confirmed at this bar.
    if (i >= 2 * L) {
      const m = i - L;
      let [isH, isL] = [true, true];
      for (let j = m - L; j <= m + L; j++) {
        if (j === m) continue;
        if (h[j] >= h[m]) isH = false;
        if (l[j] <= l[m]) isL = false;
      }
      if (isH) {
        swings.push({ i: m, conf: i, price: h[m], high: true, label: Number.isNaN(lastH) ? "H" : h[m] > lastH ? "HH" : "LH" });
        lastH = h[m];
        sh = swings.length - 1;
        shDone = false;
        addPool(true, h[m], i);
      }
      if (isL) {
        swings.push({ i: m, conf: i, price: l[m], high: false, label: Number.isNaN(lastL) ? "L" : l[m] > lastL ? "HL" : "LL" });
        lastL = l[m];
        sl = swings.length - 1;
        slDone = false;
        addPool(false, l[m], i);
      }
    }

    // Structure breaks, on closes only.
    const up = sh >= 0 && !shDone && c[i] > swings[sh].price;
    const down = sl >= 0 && !slDone && c[i] < swings[sl].price;
    if (up || down) {
      const d = (up ? 1 : -1) as 1 | -1;
      if (up) shDone = true;
      else slDone = true;
      const displaced = Math.abs(c[i] - o[i]) >= 0.6 * a && h[i] - l[i] >= 1.2 * a && q[i] >= 1.2 * volAvg;
      const kind: Ev["kind"] = dir === -d ? (displaced ? "MSS" : "CHoCH") : "BOS";
      const swing = up ? sh : sl;
      events.push({ i, kind, dir: d, level: swings[swing].price, swing });
      dir = d;
      // Order block: last opposite candle before the break.
      for (let j = i; j >= Math.max(0, i - 15); j--) {
        if (d > 0 ? c[j] < o[j] : c[j] > o[j]) {
          addZone({ kind: "OB", side: d, top: d > 0 ? o[j] : h[j], bottom: d > 0 ? l[j] : o[j], origin: j, born: i, dead: Infinity });
          break;
        }
      }
      // Supply or demand: the tight base the move left from.
      for (let j = i - 1; j >= Math.max(1, i - 15); j--) {
        if (Math.abs(c[j] - o[j]) < 0.5 * A[j] && d * (c[i] - c[j]) >= 1.5 * a) {
          const top = Math.max(h[j], h[j - 1]);
          const bottom = Math.min(l[j], l[j - 1]);
          if (top - bottom <= 2.5 * a) addZone({ kind: "SD", side: d, top, bottom, origin: j, born: i, dead: Infinity });
          break;
        }
      }
    }
    trend[i] = dir;
  }
  return { trend, swings, events, zones, pools, sweeps, atr: A };
}

export const zonesAt = (w: Walk, i: number) => w.zones.filter((z) => z.born <= i && z.dead > i);
export const poolsAt = (w: Walk, i: number) => w.pools.filter((p) => p.born <= i && p.gone > i);
export const swingsAt = (w: Walk, i: number) => w.swings.filter((s) => s.conf <= i);

// Items alive at a bar, kept as a running list so asking in time order stays cheap on long histories.
export class Alive<T extends { born: number }> {
  private pos = 0;
  private cur: T[] = [];
  private last = -1;
  private items: T[];
  private end: (x: T) => number;
  constructor(items: T[], end: (x: T) => number) {
    this.items = items;
    this.end = end;
  }
  at(i: number) {
    if (i < this.last) {
      this.pos = 0;
      this.cur = [];
    }
    while (this.pos < this.items.length && this.items[this.pos].born <= i) this.cur.push(this.items[this.pos++]);
    this.cur = this.cur.filter((x) => this.end(x) > i);
    this.last = i;
    return this.cur;
  }
}

// Position of the last record at or before a bar, for records already in time order.
export function lastAt<T>(rows: T[], key: (x: T) => number, i: number) {
  let [a, b] = [0, rows.length];
  while (a < b) {
    const m = (a + b) >> 1;
    if (key(rows[m]) <= i) a = m + 1;
    else b = m;
  }
  return a - 1;
}
