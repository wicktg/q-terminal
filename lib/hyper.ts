// HYPERMODE. Reads the market makers on Hyperliquid (lib/mm.ts) together with chart structure (lib/live-ta.ts)
// and the analog range engine (lib/fpp.ts). Out come a lean, ranges for the next 4 hours, 24 hours and 3 days,
// the levels inside them with their odds of trading, and the maker tactics visible right now.
// Open interest, funding, liquidations and long/short ratios are not used.
import { hlLadder, perpKlines, perpKlinesPaged, universe, type BookSeg, type DeepBook } from "./data.ts";
import { hlName } from "./format.ts";
import { raceP, readFpp, touchP, type FppRead } from "./fpp.ts";
import { readTa } from "./live-ta.ts";
import { hlMarket, loadMakers, readMm, type MmRead } from "./mm.ts";
import type { Frame } from "./types.ts";

export type Band = { lo50: number; hi50: number; lo80: number; hi80: number; c25: number; c75: number };
export type HyperLevel = { px: number; label: string; kind: "pool" | "zone" | "wall" | "entry"; p4: number; p24: number; gain: number };
export type Tactic = { tag: string; text: string; tone: "up" | "down" | "flat" };
export type Analog = { dir: 1 | -1; prob: number; hit: number; base: number; n: number; edge: boolean; cover50: number; cover80: number };
export type Side = 1 | -1 | 0;
export type HyperRead = {
  sym: string;
  coin: string;
  asOf: number;
  mid: number;
  chg: number;
  mm: Omit<MmRead, "orders">;
  book: { bid1: number; ask1: number; bid2: number; ask2: number; spread: number; micro: number; share: { bid: number; ask: number } };
  depth: { lo: number; hi: number; bins: { px: number; mmBid: number; mmAsk: number; book: number }[] };
  frames: Frame[];
  range: { h4: Band; h24: Band; d3: Band };
  analog: { h24: Analog; d3: Analog };
  levels: HyperLevel[];
  verdict: {
    dir: Side;
    mm: Side;
    ta: Side;
    analog: Side;
    label: string;
    target: { px: number; label: string } | null;
    invalid: { px: number; label: string } | null;
    pTarget: number;
    pInvalid: number;
    pNone: number;
  };
  tactics: Tactic[];
};

// Book dollars between two prices. Grouped buckets count in proportion to their overlap.
const within = (segs: BookSeg[], lo: number, hi: number) =>
  segs.reduce((s, g) => {
    if (g.hi < lo || g.lo > hi) return s;
    if (g.hi === g.lo) return s + g.usd;
    const ov = Math.min(g.hi, hi) - Math.max(g.lo, lo);
    return s + (ov > 0 ? (g.usd * ov) / (g.hi - g.lo) : 0);
  }, 0);

const analogOf = (f: FppRead): Analog => ({ dir: f.dir, prob: f.prob, hit: f.test.hit, base: f.test.base, n: f.test.n, edge: f.test.edge, cover50: f.test.cover50, cover80: f.test.cover80 });
const trendOf = (frames: Frame[], tf: string): Side => {
  const t = frames.find((f) => f.tf === tf)?.trend;
  return t === "UP" ? 1 : t === "DOWN" ? -1 : 0;
};

export async function readHyper(sym: string): Promise<HyperRead> {
  const coin = hlName(sym);
  const [market, uni] = await Promise.all([hlMarket(), universe().catch(() => [])]);
  const ctx = market[coin];
  if (!ctx) throw new Error(`${sym} is not listed on Hyperliquid`);
  const dp = (uni as { sym: string; dp?: number }[]).find((u) => u.sym === sym)?.dp ?? (ctx.mid >= 1000 ? 1 : ctx.mid >= 10 ? 2 : ctx.mid >= 1 ? 4 : 6);
  const px = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const usd = (x: number) => {
    const a = Math.abs(x);
    return a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(0)}K` : `$${a.toFixed(0)}`;
  };

  const [makers, book, b15, b1, bd, p1, p4, d500, btc1, btc4] = await Promise.all([
    loadMakers(),
    hlLadder(coin).catch(() => null),
    perpKlines(sym, "15m", 1000),
    perpKlines(sym, "1h", 500),
    perpKlines(sym, "1d", 200),
    perpKlinesPaged(sym, "1h", 2),
    perpKlinesPaged(sym, "4h", 1),
    perpKlines(sym, "1d", 500),
    sym === "BTC" ? Promise.resolve([]) : perpKlinesPaged("BTC", "1h", 2),
    sym === "BTC" ? Promise.resolve([]) : perpKlinesPaged("BTC", "4h", 1),
  ]);
  const mid = ctx.mid;
  const mm = readMm(coin, ctx, makers, 0.12);
  const f1 = readFpp(sym, "1h", p1, d500, btc1, { keep: true });
  const f4 = readFpp(sym, "4h", p4, d500, btc4, { keep: true });
  const ta = readTa({ b15, b1, b4: p4, bd, price: mid, walls: [] });

  // Ranges anchored on the live Hyperliquid mid: typical reach (50) and the reach one in five went beyond (80).
  const band = (f: FppRead, k: number): Band => {
    const at = (u: number) => mid * Math.exp(u * f.atrPct);
    return { lo50: at(f.reach.lo50[k]), hi50: at(f.reach.hi50[k]), lo80: at(f.reach.lo80[k]), hi80: at(f.reach.hi80[k]), c25: at(f.q25[k]), c75: at(f.q75[k]) };
  };
  const range = { h4: band(f1, 3), h24: band(f1, f1.horizon - 1), d3: band(f4, f4.horizon - 1) };
  const units = (p: number) => Math.log(p / mid) / f1.atrPct;
  const sim = f1.sim ?? [];

  // Hyperliquid book around the mid, and how much of it the tracked makers are.
  const bk: DeepBook = book ?? { venue: "Hyperliquid", bids: [], asks: [], bidReach: mid, askReach: mid };
  const bid1 = within(bk.bids, mid * 0.99, mid);
  const ask1 = within(bk.asks, mid, mid * 1.01);
  const bid2 = within(bk.bids, mid * 0.98, mid);
  const ask2 = within(bk.asks, mid, mid * 1.02);
  const [bb, ba] = [bk.bids[0], bk.asks[0]];
  const bm = bb && ba ? (bb.lo + ba.lo) / 2 : mid;
  const micro = bb && ba ? ((ba.lo * bb.usd + bb.lo * ba.usd) / (bb.usd + ba.usd) / bm - 1) * 1e4 : 0;
  const spread = bb && ba ? ((ba.lo - bb.lo) / bm) * 1e4 : 0;
  const mmIn = (side: 1 | -1, lo: number, hi: number) => mm.orders.reduce((s, o) => s + (o.side === side && o.px >= lo && o.px <= hi ? o.px * o.sz : 0), 0);
  const share = { bid: bid1 ? Math.min(1, mmIn(1, mid * 0.99, mid) / bid1) : 0, ask: ask1 ? Math.min(1, mmIn(-1, mid, mid * 1.01) / ask1) : 0 };
  // A maker order is a wall when it is at least 5% of everything resting on its side within 2%.
  const isWall = (w: { side: 1 | -1; usd: number }) => w.usd >= 2.5e4 && w.usd >= 0.05 * (w.side > 0 ? bid2 : ask2);

  // Levels worth knowing inside the 3-day range: liquidity pools, zones, maker walls and big maker entries.
  const raw: Omit<HyperLevel, "p4" | "p24" | "gain">[] = [];
  for (const p of ta.pools) raw.push({ px: p.price, kind: "pool", label: `${p.tf} ${p.touches >= 2 ? "equal" : "swing"} ${p.side === "HIGH" ? "highs" : "lows"}` });
  for (const z of ta.zones) {
    if (z.dist === 0) continue;
    raw.push({ px: z.dist > 0 ? z.bottom : z.top, kind: "zone", label: `${z.tf} ${z.kind === "FVG" ? "gap" : z.kind.toLowerCase()}` });
  }
  for (const w of mm.walls.filter(isWall).slice(0, 3)) raw.push({ px: w.px, kind: "wall", label: `${w.name} ${w.side > 0 ? "bid" : "ask"} ${usd(w.usd)}` });
  for (const m of mm.makers) if (m.pos && Math.abs(m.pos.usd) >= 2.5e5) raw.push({ px: m.pos.entry, kind: "entry", label: `${m.name} entry` });
  const [vLo, vHi] = [Math.min(range.d3.lo80, range.h24.lo80) * 0.99, Math.max(range.d3.hi80, range.h24.hi80) * 1.01];
  const rank = { pool: 0, zone: 1, wall: 2, entry: 3 };
  const merged: typeof raw = [];
  const gap = mid * f1.atrPct * 0.15; // levels closer than this are one level
  const join = (a: string, b: string) => (a.split(" · ").includes(b) ? a : `${a} · ${b}`);
  for (const l of raw.filter((l) => l.px >= vLo && l.px <= vHi && Math.abs(l.px / mid - 1) > 5e-4).sort((a, b) => a.px - b.px)) {
    const last = merged[merged.length - 1];
    if (last && l.px - last.px < gap) {
      if (rank[l.kind] < rank[last.kind]) merged[merged.length - 1] = { ...l, label: join(l.label, last.label) };
      else last.label = join(last.label, l.label);
    } else merged.push({ ...l });
  }
  const levels: HyperLevel[] = merged
    .sort((a, b) => Math.abs(a.px - mid) - Math.abs(b.px - mid))
    .slice(0, 14)
    .map((l) => ({ ...l, p4: touchP(sim, units(l.px), 4), p24: touchP(sim, units(l.px)), gain: mm.net.coins * (l.px - mid) }))
    .sort((a, b) => b.px - a.px);

  // The lean: makers count two votes, the 1H and 4H trends one each, the analog odds one when they are clear.
  const mmDir: Side = mm.pressure >= 15 ? 1 : mm.pressure <= -15 ? -1 : 0;
  const [t1, t4] = [trendOf(ta.frames, "1H"), trendOf(ta.frames, "4H")];
  const taDir = Math.sign(t1 + t4) as Side;
  const anDir: Side = f1.prob >= 0.55 ? f1.dir : 0;
  const score = 2 * mmDir + t1 + t4 + anDir;
  const dir: Side = score >= 2 ? 1 : score <= -2 ? -1 : 0;
  const label =
    dir !== 0 && mmDir === dir && taDir === dir ? "Makers and chart agree"
    : dir !== 0 && mmDir === dir ? "Makers lead, chart not confirming"
    : dir !== 0 && mmDir === 0 ? "Makers neutral, chart leads"
    : mmDir !== 0 && taDir !== 0 && mmDir !== taDir ? "Makers against the chart"
    : "No clear side";

  // Target: the nearest real level the lean points at inside the wide 24h reach. Invalidation: the nearest real level
  // past the typical 24h reach on the other side. With no lean, the typical 24h range edges race each other.
  const minMove = mid * f1.atrPct * 0.3;
  const real = levels.filter((l) => l.kind === "pool" || l.kind === "zone");
  const near = (side: 1 | -1, from: number, to: number) =>
    real.filter((l) => side * (l.px - mid) >= from && side * (l.px - mid) <= to).sort((a, b) => Math.abs(a.px - mid) - Math.abs(b.px - mid))[0];
  let target: { px: number; label: string } | null = null;
  let invalid: { px: number; label: string } | null = null;
  if (dir !== 0) {
    const r = range.h24;
    const t = near(dir, minMove, dir > 0 ? r.hi80 - mid : mid - r.lo80);
    target = t ? { px: t.px, label: t.label } : { px: dir > 0 ? r.hi50 : r.lo50, label: "typical 24h reach" };
    const edge = dir > 0 ? mid - r.lo50 : r.hi50 - mid;
    const v = near(dir > 0 ? -1 : 1, edge, Infinity);
    invalid = v ? { px: v.px, label: v.label } : { px: dir > 0 ? r.lo80 : r.hi80, label: "wide 24h reach" };
  } else {
    target = { px: range.h24.hi50, label: "top of typical 24h reach" };
    invalid = { px: range.h24.lo50, label: "bottom of typical 24h reach" };
  }
  const [up, dn] = target.px > invalid.px ? [target.px, invalid.px] : [invalid.px, target.px];
  const race = raceP(sim, units(up), units(dn));
  const tUp = target.px > mid;
  const verdict = { dir, mm: mmDir, ta: taDir, analog: anDir, label, target, invalid, pTarget: tUp ? race.pUp : race.pDn, pInvalid: tUp ? race.pDn : race.pUp, pNone: race.pNone };

  // Depth profile across the view: maker orders against the whole Hyperliquid book.
  const [dLo, dHi] = [Math.max(mid * 0.88, Math.min(vLo, mid * 0.97)), Math.min(mid * 1.12, Math.max(vHi, mid * 1.03))];
  const N = 40;
  const step = (dHi - dLo) / N;
  const bins = Array.from({ length: N }, (_, i) => {
    const [lo, hi] = [dLo + i * step, dLo + (i + 1) * step];
    return { px: (lo + hi) / 2, mmBid: mmIn(1, lo, hi), mmAsk: mmIn(-1, lo, hi), book: within(bk.bids, lo, Math.min(hi, mid)) + within(bk.asks, Math.max(lo, mid), hi) };
  });

  // Tactics visible right now, most telling first.
  const T: Tactic[] = [];
  const fl = mm.flow;
  const win = fl.minutes ? `${Math.max(1, Math.round(fl.minutes[1]))} min` : "";
  // Flow only counts as a tactic once it is a real share of the coin's usual volume over the same window.
  if (fl.taker >= Math.max(1e4, 0.25 * fl.scale) && Math.abs(fl.takerNet) / fl.taker >= 0.4) {
    const b = fl.takerNet > 0;
    T.push({ tag: "AGGRESSIVE", tone: b ? "up" : "down", text: `Makers crossed the spread: net ${usd(fl.takerNet)} ${b ? "bought" : "sold"} at market in their latest fills (up to ${win}). Makers normally wait to be filled, so paying the spread means urgent hedging or repositioning.` });
  }
  const q = mm.parts.quote;
  if (Math.abs(q) >= 0.12) {
    const lead = [...mm.makers].filter((m) => m.quotes).sort((a, b) => Math.abs(b.quotes!.skew) * (b.quotes!.bid + b.quotes!.ask) - Math.abs(a.quotes!.skew) * (a.quotes!.bid + a.quotes!.ask))[0];
    T.push({ tag: "QUOTE SKEW", tone: q > 0 ? "up" : "down", text: `Makers are quoting heavier and closer on the ${q > 0 ? "bid" : "ask"}: ${usd(mm.quotes.bid)} bids against ${usd(mm.quotes.ask)} asks within 2%${lead ? `, led by ${lead.name}` : ""}. They would rather ${q > 0 ? "buy here, which cushions dips" : "sell here, which caps bounces"}.` });
  }
  const wall = mm.walls.find((w) => Math.abs(w.px / mid - 1) <= 0.03 && isWall(w));
  const sideBook = wall ? (wall.side > 0 ? bid2 : ask2) : 0;
  if (wall && sideBook && wall.usd / sideBook >= 0.1) {
    T.push({ tag: "WALL", tone: wall.side > 0 ? "up" : "down", text: `${wall.name} shows a ${usd(wall.usd)} ${wall.side > 0 ? "bid" : "ask"} at ${px(wall.px)}, ${Math.round(Math.min(1, wall.usd / sideBook) * 100)}% of all Hyperliquid ${wall.side > 0 ? "bids" : "asks"} within 2%. Size like this acts as a ${wall.side > 0 ? "floor" : "ceiling"} until it is pulled, which takes a millisecond.` });
  }
  if (fl.maker >= Math.max(2e4, 0.5 * fl.scale) && Math.abs(fl.makerNet) / fl.maker >= 0.4) {
    const b = fl.makerNet > 0;
    T.push({ tag: "ABSORBING", tone: b ? "down" : "up", text: `Makers passively ${b ? "bought" : "sold"} ${usd(fl.makerNet)} net as takers ${b ? "sold into" : "bought from"} them. They now carry that inventory and tend to unload it into ${b ? "bounces" : "dips"}, and the takers on the other side are often the better informed.` });
  }
  const pool = levels.filter((l) => l.kind === "pool" && l.px >= range.h24.lo50 && l.px <= range.h24.hi50).sort((a, b) => Math.abs(a.px - mid) - Math.abs(b.px - mid))[0];
  if (pool) T.push({ tag: "LIQUIDITY", tone: pool.px > mid ? "up" : "down", text: `Stops likely rest ${pool.px > mid ? "above" : "below"} ${px(pool.px)} (${pool.label}). Price traded a level this far away within 24 hours in ${Math.round(pool.p24 * 100)}% of similar past moments.` });
  const inZone = ta.zones.find((z) => z.dist === 0 && z.kind !== "FVG");
  if (inZone) T.push({ tag: "IN ZONE", tone: inZone.side === "DEMAND" ? "up" : "down", text: `Price is inside the ${inZone.tf} ${inZone.kind.toLowerCase()} (${px(inZone.bottom)}–${px(inZone.top)}), where ${inZone.side === "DEMAND" ? "buyers" : "sellers"} stepped in before.` });
  const big = mm.makers.find((m) => m.pos && Math.abs(m.pos.usd) >= 2.5e5);
  if (big?.pos) {
    const p = big.pos;
    const d = big.flow?.dCoins ?? 0;
    const change = Math.abs(d * mid) >= 1e4 ? ` In its latest fills it ${Math.sign(d) === Math.sign(p.coins) ? "added" : p.coins < 0 ? "covered" : "trimmed"} ${usd(d * mid)}.` : "";
    T.push({ tag: "INVENTORY", tone: "flat", text: `${big.name} is ${p.coins > 0 ? "long" : "short"} ${usd(p.usd)} from ${px(p.entry)} (${p.upnl >= 0 ? "+" : "-"}${usd(p.upnl)}). Market makers usually hold perps against spot inventory or token loans, so the size is mostly a hedge; changes say more than the level.${change}` });
  }
  if (Math.abs(mm.net.usd) >= 2.5e5 && verdict.target && verdict.invalid) {
    const g = (l: number) => mm.net.coins * (l - mid);
    const say = (x: number) => `${x >= 0 ? "adds" : "costs"} about ${usd(x)}`;
    T.push({ tag: "WHO GAINS", tone: "flat", text: `Tracked makers are net ${mm.net.coins > 0 ? "long" : "short"} ${usd(mm.net.usd)} here. A move to ${px(verdict.target.px)} ${say(g(verdict.target.px))} for them; a move to ${px(verdict.invalid.px)} ${say(g(verdict.invalid.px))}.` });
  }
  if (Math.abs(mm.pressure) < 15 && Math.abs(q) < 0.06 && mm.quotes.bid + mm.quotes.ask >= 2e4)
    T.push({ tag: "PINNED", tone: "flat", text: "Quotes are balanced on both sides. Makers are earning the spread rather than leaning, which usually means rotation inside the range." });
  if (bid1 + ask1 > 0) {
    const r = bid1 / (ask1 || 1);
    T.push({ tag: "BOOK", tone: r >= 1.5 ? "up" : r <= 0.67 ? "down" : "flat", text: `Hyperliquid book within 1%: ${usd(bid1)} bids against ${usd(ask1)} asks. Tracked makers are ${Math.round(share.bid * 100)}% of those bids and ${Math.round(share.ask * 100)}% of the asks.` });
  }

  const { orders: _o, ...mmOut } = mm;
  void _o;
  return {
    sym,
    coin,
    asOf: Date.now(),
    mid,
    chg: ctx.prev ? (mid / ctx.prev - 1) * 100 : 0,
    mm: mmOut,
    book: { bid1, ask1, bid2, ask2, spread, micro, share },
    depth: { lo: dLo, hi: dHi, bins },
    frames: ta.frames,
    range,
    analog: { h24: analogOf(f1), d3: analogOf(f4) },
    levels,
    verdict,
    tactics: T,
  };
}

// The cross-coin strip: maker footprint only, which is cheap because every coin shares the same account reads.
export type HyperRow = { sym: string; mid: number; chg: number; net: number; pressure: number; quote: number; flow: number };
export async function readHyperAll(syms: string[]): Promise<HyperRow[]> {
  const [market, makers] = await Promise.all([hlMarket(), loadMakers()]);
  return syms.flatMap((sym) => {
    const ctx = market[hlName(sym)];
    if (!ctx) return [];
    const mm = readMm(hlName(sym), ctx, makers, 0.02);
    return [{ sym, mid: ctx.mid, chg: ctx.prev ? (ctx.mid / ctx.prev - 1) * 100 : 0, net: mm.net.usd, pressure: mm.pressure, quote: mm.parts.quote, flow: mm.flow.takerNet + mm.flow.makerNet }];
  });
}
