// How much aggressive flow each supply and demand zone has soaked up, and where heavy flow failed to move price.
// Pure, no I/O. Flow is Binance taker data on 15-minute bars, perps plus spot where spot exists.
//   absorbed   market orders that traded inside a zone against it: sells into demand, buys into supply
//   opposing   market orders inside the zone on the zone's own side
//   built      volume of the candles that formed the zone, as a yardstick for size
import { colsFromBars, type Cols } from "./mtf.ts";
import { walk } from "./structure.ts";
import type { Bar } from "./types.ts";

export type ZoneStatus = "TESTING" | "HOLDING" | "FRESH" | "BROKEN";
export type AbsorbZone = {
  tf: "1H" | "4H";
  kind: "OB" | "SD";
  side: 1 | -1;
  top: number;
  bottom: number;
  bornT: number;
  deadT: number | null;
  status: ZoneStatus;
  dist: number;
  absorbed: number;
  opposing: number;
  touches: number;
  deepest: number;
  reactions: number[];
  built: number;
  partial: boolean; // formed before the flow data starts, so early touches are missing
  now: { absorbed: number; opposing: number } | null;
  weakening: boolean;
};
export type AbsorbEvent = { t: number; lo: number; hi: number; delta: number; vol: number; move: number; absorbed: "buyers" | "sellers"; held: boolean };
export type AbsorbRead = {
  sym: string;
  asOf: number;
  price: number;
  spot: boolean;
  from: number;
  zones: AbsorbZone[];
  events: AbsorbEvent[];
  day: { sellers: number; buyers: number; nSellers: number; nBuyers: number };
};

export type Flow = { t: number; o: number; h: number; l: number; c: number; buy: number; sell: number };

const SEC15 = 900;
const TF_SEC = { "1H": 3600, "4H": 14400 } as const;
const REACT_BARS = 16; // how far after a visit to look for the bounce, in 15-minute bars
const BROKEN_DAYS = 3;

// Taker buys and sells in dollars per bar, perps and spot added together.
export function flows(perp: Bar[], spot: Bar[]): Flow[] {
  const sp = new Map(spot.map((b) => [b.t, b]));
  return perp.map((b) => {
    const typ = (b.h + b.l + b.c) / 3;
    let buy = b.tb * typ;
    let sell = (b.v - b.tb) * typ;
    const s = sp.get(b.t);
    if (s) {
      const st = (s.h + s.l + s.c) / 3;
      buy += s.tb * st;
      sell += (s.v - s.tb) * st;
    }
    return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, buy, sell };
  });
}

// Share of a bar's range that sat inside the zone, used to split its volume.
export const overlap = (f: Flow, top: number, bottom: number) => {
  const inside = Math.min(f.h, top) - Math.max(f.l, bottom);
  if (inside < 0) return 0;
  return f.h > f.l ? inside / (f.h - f.l) : 1;
};

export function measure(F: Flow[], side: 1 | -1, top: number, bottom: number, from: number, to: number, price: number) {
  let [absorbed, opposing, deepest, touches, gap] = [0, 0, 0, 0, 99];
  let cur: { absorbed: number; opposing: number } | null = null;
  const visits: [number, number][] = [];
  for (let i = 0; i < F.length; i++) {
    const f = F[i];
    if (f.t < from || f.t >= to) continue;
    const k = overlap(f, top, bottom);
    if (!k) {
      gap++;
      continue;
    }
    if (gap >= 2) {
      touches++;
      visits.push([i, i]);
      cur = { absorbed: 0, opposing: 0 };
    } else if (visits.length) visits[visits.length - 1][1] = i;
    gap = 0;
    const against = (side > 0 ? f.sell : f.buy) * k;
    const withIt = (side > 0 ? f.buy : f.sell) * k;
    absorbed += against;
    opposing += withIt;
    if (cur) {
      cur.absorbed += against;
      cur.opposing += withIt;
    }
    deepest = Math.max(deepest, side > 0 ? (top - f.l) / (top - bottom) : (f.h - bottom) / (top - bottom));
  }
  // The bounce after each finished visit: the best move away from the zone in the next few hours.
  const reactions: number[] = [];
  for (const [, end] of visits) {
    const after = F.slice(end + 1, end + 1 + REACT_BARS).filter((f) => f.t < to);
    if (after.length < 2) continue;
    reactions.push(side > 0 ? (Math.max(...after.map((f) => f.h)) / top - 1) * 100 : (1 - Math.min(...after.map((f) => f.l)) / bottom) * 100);
  }
  const inside = price >= bottom && price <= top;
  return { absorbed, opposing, deepest: Math.min(deepest, 1.5), touches, reactions, now: inside && gap < 2 ? cur : null };
}

function zonesFor(tf: "1H" | "4H", bars: Bar[], F: Flow[], price: number, now: number): AbsorbZone[] {
  const closed = bars.slice(0, -1);
  if (closed.length < 60) return [];
  const b: Cols = colsFromBars(closed);
  const w = walk(b, 5);
  const sec = TF_SEC[tf];
  const from = F[0]?.t ?? now;
  const out: AbsorbZone[] = [];
  for (const z of w.zones) {
    if (z.kind === "FVG") continue;
    const bornT = b.t[z.born] + sec;
    const deadT = Number.isFinite(z.dead) ? b.t[z.dead] + sec : null;
    const dist = (z.top < price ? z.top / price - 1 : z.bottom > price ? z.bottom / price - 1 : 0) * 100;
    if (deadT !== null ? deadT < now - BROKEN_DAYS * 86400 || deadT < from : Math.abs(dist) > 15) continue;
    const m = measure(F, z.side, z.top, z.bottom, bornT, deadT ?? Infinity, price);
    let built = 0;
    for (let i = z.origin; i <= z.born; i++) built += b.q[i];
    const r = m.reactions;
    const status: ZoneStatus = deadT !== null ? "BROKEN" : m.now ? "TESTING" : m.touches ? "HOLDING" : "FRESH";
    out.push({
      tf,
      kind: z.kind,
      side: z.side,
      top: z.top,
      bottom: z.bottom,
      bornT,
      deadT,
      status,
      dist,
      ...m,
      built,
      partial: bornT < from,
      weakening: status !== "BROKEN" && (m.touches >= 3 || (r.length >= 2 && r[r.length - 1] < 0.6 * r[r.length - 2])),
    });
  }
  return out;
}

// Bars where heavy one-sided flow failed to move price. Passive orders on the other side soaked it up.
function absorptionEvents(F: Flow[]) {
  const recent = F.slice(-500);
  const size = recent.map((f) => Math.abs(f.buy - f.sell)).sort((a, b) => a - b);
  const median = size[Math.floor(size.length / 2)] ?? 0;
  const bar = recent.slice(-96).reduce((a, f) => a + (f.h - f.l), 0) / Math.max(1, Math.min(96, recent.length));
  const cut = Math.max(size[Math.floor(size.length * 0.9)] ?? Infinity, 3 * median); // the heaviest tenth of bars
  const hits: (AbsorbEvent & { i: number })[] = [];
  F.forEach((f, i) => {
    if (i < F.length - 192) return; // last 48 hours
    const delta = f.buy - f.sell;
    if (Math.abs(delta) < cut) return;
    const move = f.c - f.o;
    const stalled = delta > 0 ? move <= 0.15 * bar : move >= -0.15 * bar;
    if (!stalled) return;
    hits.push({ i, t: f.t, lo: f.l, hi: f.h, delta, vol: f.buy + f.sell, move: (f.c / f.o - 1) * 100, absorbed: delta > 0 ? "buyers" : "sellers", held: true });
  });
  // Neighbouring bars on the same side are one event.
  const merged: (AbsorbEvent & { i: number; j: number; o: number })[] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && last.absorbed === h.absorbed && h.i - last.j <= 1) {
      last.j = h.i;
      last.lo = Math.min(last.lo, h.lo);
      last.hi = Math.max(last.hi, h.hi);
      last.delta += h.delta;
      last.vol += h.vol;
      last.move = (F[h.i].c / last.o - 1) * 100;
    } else merged.push({ ...h, j: h.i, o: F[h.i].o });
  }
  // A level holds until a later bar closes through it.
  for (const e of merged) {
    const later = F.slice(e.j + 1);
    e.held = e.absorbed === "buyers" ? !later.some((f) => f.c > e.hi) : !later.some((f) => f.c < e.lo);
  }
  const day = { sellers: 0, buyers: 0, nSellers: 0, nBuyers: 0 };
  for (const h of hits) {
    if (h.i < F.length - 96) continue;
    if (h.absorbed === "sellers") {
      day.sellers += -h.delta;
      day.nSellers++;
    } else {
      day.buyers += h.delta;
      day.nBuyers++;
    }
  }
  return { events: merged.reverse().slice(0, 10).map(({ i: _i, j: _j, o: _o, ...e }) => e), day };
}

const ORDER: Record<ZoneStatus, number> = { TESTING: 0, HOLDING: 1, FRESH: 1, BROKEN: 2 };

export function readAbsorb(sym: string, p15: Bar[], s15: Bar[], h1: Bar[], h4: Bar[]): AbsorbRead {
  const F = flows(p15, s15);
  const price = p15[p15.length - 1].c;
  const now = p15[p15.length - 1].t + SEC15;
  const all = [...zonesFor("1H", h1, F, price, now), ...zonesFor("4H", h4, F, price, now)];
  // One break can leave an order block and a base on top of each other. Keep the one that took more flow.
  const kept: AbsorbZone[] = [];
  for (const z of all.sort((a, b) => b.absorbed - a.absorbed)) {
    const same = kept.find((k) => k.tf === z.tf && k.side === z.side && Math.min(k.top, z.top) - Math.max(k.bottom, z.bottom) > 0.6 * Math.min(k.top - k.bottom, z.top - z.bottom));
    if (!same) kept.push(z);
  }
  const zones = kept
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.status === "BROKEN" ? (b.deadT ?? 0) - (a.deadT ?? 0) : Math.abs(a.dist) - Math.abs(b.dist)))
    .filter((z, i, list) => z.status !== "BROKEN" || list.slice(0, i).filter((x) => x.status === "BROKEN").length < 4)
    .slice(0, 12);
  const { events, day } = absorptionEvents(F);
  return { sym, asOf: Date.now(), price, spot: s15.length > 0, from: F[0]?.t ?? now, zones, events, day };
}
