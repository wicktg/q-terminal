// Turns closed bars into what the terminal shows: structure on each timeframe, zones, pools and the two signal lanes.
// Uses the same structure engine and scoring as the backtest. Only the order book wall is live-only.
import type { Bar, Book, Frame, TaPool, TaSignal, TaZone } from "./types.ts";
import { colsFromBars, TF_SEC, type Cols, type Tf } from "./mtf.ts";
import { evaluate, MAX_SCORE, pairUp, type Eval, type SmcParams } from "./ta.ts";
import { poolsAt, walk, zonesAt, type Walk } from "./structure.ts";
import { LANES } from "./lanes.ts";
import { fmtPx } from "./format.ts";

const closed = (bars: Bar[]) => colsFromBars(bars.slice(0, -1)); // the last bar is still forming
const NAME: Record<string, string> = { "15m": "15M", "1h": "1H", "4h": "4H", "1d": "1D" };
const biasName = (h: number) => (h >= 24 ? "1D" : `${h}H`);
const zoneLabel = (k: string, side: number) => (k === "OB" ? "Order block" : k === "FVG" ? "Fair value gap" : side > 0 ? "Demand" : "Supply");

function frame(tf: string, w: Walk, b: Cols): Frame {
  const i = b.n - 1;
  const dir = w.trend[i];
  const ev = w.events.filter((e) => e.kind === "MSS").at(-1);
  const s = w.swings.slice(-4);
  const lastHi = [...w.swings].reverse().find((x) => x.high);
  const lastLo = [...w.swings].reverse().find((x) => !x.high);
  return {
    tf: NAME[tf],
    trend: dir > 0 ? "UP" : dir < 0 ? "DOWN" : "RANGE",
    event: ev ? { kind: ev.kind, dir: ev.dir, level: ev.level, t: b.t[ev.i] } : null,
    hi: lastHi?.price ?? null,
    lo: lastLo?.price ?? null,
    labels: s.map((x) => x.label),
  };
}

// Walks forward from a signal: has it already hit its stop or target?
function stillLive(b: Cols, r: Eval) {
  for (let k = r.i + 1; k < b.n; k++) {
    if (r.dir > 0 ? b.l[k] <= r.stop : b.h[k] >= r.stop) return false;
    if (Number.isFinite(r.target) && (r.dir > 0 ? b.h[k] >= r.target : b.l[k] <= r.target)) return false;
  }
  return true;
}

function lane(name: "HTF" | "LTF", tf: Tf, b: Cols, bias: Cols, p: SmcParams, rMult: number, price: number, walls: Book["walls"]): TaSignal {
  const P = pairUp(b, TF_SEC[tf], p.b, p.L, bias);
  const base = { lane: name, trigger: NAME[tf], bias: biasName(p.b), max: MAX_SCORE + 1 };
  const none: TaSignal = { ...base, state: "NONE", side: null, score: 0, items: [], wall: null, zone: null, entry: 0, stop: 0, target: null, rr: null, plan: `No clear ${biasName(p.b)} structure. Stand aside.`, invalid: "", since: null };
  const wallFor = (side: number, top: number, bottom: number, pad: number) => {
    const w = walls.find((x) => x.side === (side > 0 ? "bid" : "ask") && x.price >= bottom - pad && x.price <= top + pad);
    return w ? { price: w.price, usd: w.usd, venue: w.venue } : null;
  };
  // Newest qualifying signal in the last eight trigger bars that has not already played out.
  for (const ev of [...P.w.events].reverse()) {
    if (ev.i < b.n - 8) break;
    const base0 = evaluate(P, ev, p);
    if (!base0 || base0.score < p.min) continue;
    const entry = b.o[Math.min(base0.i + 1, b.n - 1)];
    // The tested exit for this lane: a fixed multiple of risk, or the next liquidity.
    const r = rMult ? { ...base0, target: entry + base0.dir * rMult * Math.abs(entry - base0.stop) } : base0;
    if (!stillLive(b, r)) continue;
    const wall = r.zone ? wallFor(r.dir, r.zone.top, r.zone.bottom, P.w.atr[r.i]) : null;
    const target = Number.isFinite(r.target) ? r.target : null;
    const side = r.dir > 0 ? "LONG" : "SHORT";
    return {
      ...base,
      state: "ACTIVE",
      side,
      score: r.score + (wall ? 1 : 0),
      items: [...r.items, { label: `Book wall in the zone (live only)`, pts: 1, on: !!wall }],
      wall,
      zone: r.zone ? { label: `${base.bias} ${zoneLabel(r.zone.kind, r.zone.side)}`, top: r.zone.top, bottom: r.zone.bottom } : null,
      entry,
      stop: r.stop,
      target,
      rr: target ? Math.abs(target - entry) / Math.abs(entry - r.stop) : null,
      plan: `${r.ev.kind === "MSS" ? "MSS" : "Structure break"} ${r.dir > 0 ? "up" : "down"} on ${base.trigger} through ${fmtPx(r.ev.level)}.`,
      invalid: `Close ${r.dir > 0 ? "below" : "above"} ${fmtPx(r.stop)}`,
      since: b.t[r.i] + TF_SEC[tf],
    };
  }
  // No trigger yet: the nearest zone in the direction of the bias structure.
  const j = P.B.n - 1;
  const d = P.W.trend[j];
  if (!d) return none;
  const a = P.w.atr[b.n - 1];
  const zones = zonesAt(P.W, j)
    .filter((z) => z.side === d && z.kind !== "FVG" && (d > 0 ? z.bottom < price : z.top > price))
    .sort((x, y) => d * (y.top - x.top));
  const z = zones[0];
  if (!z) return { ...none, side: d > 0 ? "LONG" : "SHORT", plan: `${base.bias} structure is ${d > 0 ? "up" : "down"}, but no fresh ${d > 0 ? "demand" : "supply"} zone is left to trade from.` };
  const entry = (z.top + z.bottom) / 2;
  const stop = d > 0 ? z.bottom - 0.25 * a : z.top + 0.25 * a;
  const pools = poolsAt(P.W, j).filter((x) => x.high === d > 0).map((x) => x.price);
  const target = rMult ? entry + d * rMult * Math.abs(entry - stop) : (pools.filter((x) => d * (x - entry) >= 1.5 * Math.abs(entry - stop)).sort((x, y) => d * (x - y))[0] ?? null);
  const wall = wallFor(d, z.top, z.bottom, a);
  return {
    ...base,
    state: "WATCH",
    side: d > 0 ? "LONG" : "SHORT",
    score: 2 + (wall ? 1 : 0),
    items: [
      { label: `${base.bias} structure agrees`, pts: 2, on: true },
      { label: "Book wall in the zone (live only)", pts: 1, on: !!wall },
    ],
    wall,
    zone: { label: `${base.bias} ${zoneLabel(z.kind, z.side)}`, top: z.top, bottom: z.bottom },
    entry,
    stop,
    target,
    rr: target ? Math.abs(target - entry) / Math.abs(entry - stop) : null,
    plan: `Wait for ${fmtPx(z.bottom)}–${fmtPx(z.top)}, then a ${base.trigger} structure break ${d > 0 ? "up" : "down"}.`,
    invalid: `${base.bias} close ${d > 0 ? "below" : "above"} ${fmtPx(d > 0 ? z.bottom : z.top)}`,
    since: null,
  };
}

export function readTa(m: { b15: Bar[]; b1: Bar[]; b4: Bar[]; bd: Bar[]; price: number; walls: Book["walls"] }) {
  const set: [string, Cols][] = [["1d", closed(m.bd)], ["4h", closed(m.b4)], ["1h", closed(m.b1)], ["15m", closed(m.b15)]];
  const walks = set.map(([tf, b]) => ({ tf, b, w: walk(b, tf === "1d" ? 3 : 5) }));
  const frames = walks.map(({ tf, b, w }) => frame(tf, w, b));
  const zones: TaZone[] = [];
  const pools: TaPool[] = [];
  const px = m.price;
  for (const { tf, b, w } of walks) {
    if (tf === "15m") continue; // too small to plan around
    const i = b.n - 1;
    for (const z of zonesAt(w, i)) {
      const dist = (z.top < px ? z.top / px - 1 : z.bottom > px ? z.bottom / px - 1 : 0) * 100;
      if (Math.abs(dist) <= 15) zones.push({ tf: NAME[tf], kind: z.kind === "FVG" ? "FVG" : z.kind === "OB" ? "Order block" : z.side > 0 ? "Demand" : "Supply", side: z.side > 0 ? "DEMAND" : "SUPPLY", top: z.top, bottom: z.bottom, dist });
    }
    for (const p of poolsAt(w, i)) {
      const dist = (p.price / px - 1) * 100;
      if (Math.abs(dist) <= 15) pools.push({ tf: NAME[tf], side: p.high ? "HIGH" : "LOW", price: p.price, touches: p.touches, dist });
    }
  }
  // Two breaks can leave from one base, so the same zone can appear twice.
  const uniq = <T,>(rows: T[], key: (x: T) => string) => [...new Map(rows.map((x) => [key(x), x])).values()];
  // Gaps are small and plentiful, so only the two nearest on each side share the list with real zones.
  const gaps = { above: 0, below: 0 };
  const zoneRows = uniq(zones, (z) => `${z.tf}|${z.kind}|${z.top}|${z.bottom}`)
    .sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))
    .filter((z) => z.kind !== "FVG" || ++gaps[z.dist >= 0 ? "above" : "below"] <= 2);
  const poolRows = uniq(pools, (p) => `${p.tf}|${p.side}|${p.price}`).sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));
  const of = (tf: string) => set.find((x) => x[0] === tf)![1];
  const biasOf = (h: number) => of(h >= 24 ? "1d" : h >= 4 ? "4h" : "1h");
  const signals: TaSignal[] = [lane("HTF", LANES.HTF.tf, of(LANES.HTF.tf), biasOf(LANES.HTF.p.b), LANES.HTF.p, LANES.HTF.r, px, m.walls), lane("LTF", LANES.LTF.tf, of(LANES.LTF.tf), biasOf(LANES.LTF.p.b), LANES.LTF.p, LANES.LTF.r, px, m.walls)];
  return { signals, frames, zones: zoneRows.slice(0, 14), pools: poolRows.slice(0, 10) };
}
