// Builds the full per-coin analysis bundle from raw feeds.
import type { Analysis, Bar, Book, BookRow, Signal, Tone } from "./types.ts";
import { hlName } from "./format.ts";
import { cached, depthAll, fundingHours, hlCtxs, lsRatio, oiHist, perpKlines, premiumIndex, spotKlines } from "./data.ts";
import { atr, cvd, ols, returns, rsi, stdev, sumDelta } from "./quant.ts";
import { forecast, toneOf } from "./model.ts";
import { readTa } from "./live-ta.ts";
import { last, pct, readMarket } from "./engine.ts";
import { fmtPx, fmtUsd } from "./format.ts";

const opt = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

function alignedReturns(a: Bar[], b: Bar[]) {
  const m = new Map(b.map((x) => [x.t, x.c]));
  const pairs = a.filter((x) => m.has(x.t)).map((x) => [x.c, m.get(x.t)!] as const);
  return { y: returns(pairs.map((p) => p[0])), x: returns(pairs.map((p) => p[1])) };
}

function cvdRead(b1: Bar[]) {
  const w = b1.slice(-48);
  const c = cvd(w);
  const mid = 24;
  const hiP = (a: Bar[]) => Math.max(...a.map((x) => x.h));
  const loP = (a: Bar[]) => Math.min(...a.map((x) => x.l));
  const hiC = (a: number[]) => Math.max(...a);
  const loC = (a: number[]) => Math.min(...a);
  const [p1, p2] = [w.slice(0, mid), w.slice(mid)];
  const [c1, c2] = [c.slice(0, mid), c.slice(mid)];
  if (hiP(p2) > hiP(p1) && hiC(c2) < hiC(c1)) return { text: "Bearish divergence", note: "Price made a higher high, CVD did not: buying is being absorbed", tone: "down" as Tone };
  if (loP(p2) < loP(p1) && loC(c2) > loC(c1)) return { text: "Bullish divergence", note: "Price made a lower low, CVD did not: selling is being absorbed", tone: "up" as Tone };
  return null;
}

export const analyze = (sym: string) => cached(`an:${sym}`, 90e3, () => build(sym));

// Simulations are CPU-heavy: hand the event loop back so chart and book requests never queue behind them.
const breathe = () => new Promise<void>((r) => setImmediate(r));

async function build(sym: string): Promise<Analysis> {
  const [b15, b4, b1, bd, btc1d, oi4, oi1, retail, top, prem, ctxs, spot1, depth, hours] = await Promise.all([
    perpKlines(sym, "15m", 1000),
    perpKlines(sym, "4h", 1500),
    perpKlines(sym, "1h", 500),
    perpKlines(sym, "1d", 200),
    perpKlines("BTC", "1d", 200),
    opt(oiHist(sym, "4h", 180)),
    opt(oiHist(sym, "1h", 30)),
    opt(lsRatio(sym, "global")),
    opt(lsRatio(sym, "top")),
    opt(premiumIndex(sym)),
    opt(hlCtxs()),
    spotKlines(sym, "1h", 48),
    opt(depthAll(sym)),
    opt(fundingHours()),
  ]);
  const hl = ctxs?.[hlName(sym)];
  const fB = prem ? (+prem.lastFundingRate * 24 * 365 * 100) / (hours?.get(`${sym}USDT`) ?? 8) : null;
  const r = readMarket({
    b4,
    b1,
    bd,
    spot1,
    oi4: oi4?.length ? oi4.map((x) => ({ t: Math.floor(x.timestamp / 1000), v: +x.sumOpenInterest })) : null,
    oi1: oi1?.map((x) => +x.sumOpenInterest) ?? null,
    retail,
    top,
    fundingApr: fB,
    hlOi: hl ? +hl.openInterest : 0,
    book: (clusters) => (depth ? buildBook(depth, b1[b1.length - 1].c, clusters) : null),
  });
  const { px, c1, c4, cd, oiBin, oiHl, oiCh, oiChg4h, pxChg4, regime, hi, lo, vH, vL, obs, profile, clusters, shortsAbove, longsBelow, skew, cvd24, spotD, vol24, tChg, t1, t4, tD, levels, flow } = r;
  const aD = last(atr(bd));
  const oiUsd = oiBin + oiHl;
  const [rTop, rBot] = [Math.max(vH, vL), Math.min(vH, vL)];
  const ribbonState = px > rTop ? "Above ribbon" : px < rBot ? "Below ribbon" : "Inside ribbon";

  // alpha / beta to BTC
  const isBtc = sym === "BTC";
  const dR = alignedReturns(bd, btc1d);
  const w30 = ols(dR.y.slice(-30), dR.x.slice(-30));
  const w90 = ols(dR.y.slice(-90), dR.x.slice(-90));
  const r7 = dR.y.slice(-7).reduce((s, x) => s + x, 0);
  const b7 = dR.x.slice(-7).reduce((s, x) => s + x, 0);

  // Positioning
  const rNow = retail ? last(retail) : null;
  const rChg = retail ? last(retail) - retail[Math.max(0, retail.length - 25)] : null;
  const tNow = top ? last(top) : null;
  const fH = hl ? +hl.funding * 24 * 365 * 100 : null;

  const seed = (sym.split("").reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7) + last(b4).t) >>> 0;
  await breathe();
  const { fc } = forecast(b4, levels, flow, seed);
  await breathe();
  const ta = readTa({ b15, b1, b4, bd, price: px, walls: r.book?.walls ?? [] });

  // Plain-language signal stack
  const signals: Signal[] = [];
  const dv = cvdRead(b1);
  const spotTxt = spotD === null ? "" : ` · Spot ${fmtUsd(spotD)}`;
  signals.push({
    key: "CVD 24H",
    value: `Perp ${fmtUsd(cvd24)}${spotTxt}`,
    note: dv
      ? dv.note
      : spotD !== null && Math.sign(spotD) !== Math.sign(cvd24) && Math.abs(spotD) > Math.abs(cvd24) * 0.2 // ignore immaterial spot flow
        ? spotD > 0
          ? "Spot buying while perps sell: real demand under the move"
          : "Perps buying while spot sells: leverage-led, fragile"
        : cvd24 > 0
          ? "Net taker buying"
          : "Net taker selling",
    tone: dv ? dv.tone : toneOf(cvd24),
  });
  signals.push({
    key: "OI REGIME",
    value: `${regime}${oiChg4h === null ? "" : ` (${oiChg4h >= 0 ? "+" : ""}${oiChg4h.toFixed(1)}% 4h)`}`,
    note:
      regime === "New longs"
        ? "Price and OI rising: real buying"
        : regime === "Short covering"
          ? "Price up, OI down: rally lacks new money"
          : regime === "New shorts"
            ? "Price down, OI up: real selling"
            : regime === "Longs closing"
              ? "Price and OI falling: flush, bounces likely"
              : "No conviction either way",
    tone: regime === "New longs" ? "up" : regime === "New shorts" ? "down" : "flat",
  });
  if (rNow !== null && tNow !== null) {
    const smart = (tChg ?? 0) > 0.1 && (rChg ?? 0) < -0.05;
    const dumb = (tChg ?? 0) < -0.1 && (rChg ?? 0) > 0.05;
    signals.push({
      key: "POSITIONING",
      value: `Retail ${rNow.toFixed(2)} · Top ${tNow.toFixed(2)}`,
      note: smart ? "Top traders adding while retail fades: bullish divergence" : dumb ? "Top traders cutting while retail chases: bearish divergence" : "No divergence",
      tone: smart ? "up" : dumb ? "down" : "flat",
    });
  }
  signals.push({
    key: "FUNDING",
    value: `Binance ${fB === null ? "n/a" : fB.toFixed(1) + "%"} · HL ${fH === null ? "n/a" : fH.toFixed(1) + "%"}`,
    note: (fB ?? 11) > 40 ? "Crowded longs paying up" : (fB ?? 11) < -5 ? "Shorts paying: squeeze fuel" : "Neutral",
    tone: (fB ?? 11) > 40 ? "down" : (fB ?? 11) < -5 ? "up" : "flat",
  });
  signals.push({
    key: "RIBBON",
    value: ribbonState,
    note: `AVWAPs ${fmtPx(rBot)} – ${fmtPx(rTop)}`,
    tone: px > rTop ? "up" : px < rBot ? "down" : "flat",
  });
  signals.push({
    key: "LIQUIDITY",
    value: `Shorts ${fmtUsd(shortsAbove)} · Longs ${fmtUsd(longsBelow)}`,
    note: skew > 0.3 ? "Estimated liquidations pull price up" : skew < -0.3 ? "Estimated liquidations pull price down" : "Balanced",
    tone: skew > 0.3 ? "up" : skew < -0.3 ? "down" : "flat",
  });

  const vol30 = stdev(returns(cd).slice(-30)) * Math.sqrt(365) * 100;
  const mcapRow = oi4?.[oi4.length - 1]?.CMCCirculatingSupply;
  const circ = mcapRow ? +mcapRow : 0;

  return {
    sym,
    asOf: Date.now(),
    price: px,
    stats: {
      chg1h: pct(px, c1[c1.length - 2]),
      chg4h: pxChg4,
      chg24h: pct(px, c1[c1.length - 25]),
      chg7d: pct(px, c1[c1.length - 169]),
      chg30d: pct(px, cd[cd.length - 31]),
      vol24hUsd: vol24,
      fundingBinance: fB,
      fundingHL: fH,
      premiumHL: hl?.premium ? +hl.premium * 100 : null,
      oiUsd,
      oiChg1h: oiCh(1),
      oiChg4h,
      oiChg24h: oiCh(24),
      oiToMcap: circ ? (oiUsd / (circ * px)) * 100 : null,
      rsi1h: last(rsi(c1)) ?? 50,
      rsi4h: last(rsi(c4)) ?? 50,
      rsi1d: last(rsi(cd)) ?? 50,
      atrDayPct: (aD / px) * 100,
      vol30dAnn: vol30,
      trend1h: t1,
      trend4h: t4,
      trend1d: tD,
      alpha30: isBtc ? 0 : w30.alpha * 100,
      alpha30t: isBtc ? 0 : w30.t,
      beta30: isBtc ? 1 : w30.beta,
      beta90: isBtc ? 1 : w90.beta,
      corr90: isBtc ? 1 : w90.corr,
      excess7d: isBtc ? 0 : (r7 - w90.beta * b7) * 100,
      cvdPerp1h: sumDelta(b1, 1),
      cvdPerp4h: sumDelta(b1, 4),
      cvdPerp24h: cvd24,
      cvdSpot24h: spotD,
      retailLS: rNow,
      retailLSChg: rChg,
      topLS: tNow,
      topLSChg: tChg,
      regime,
    },
    signals,
    ribbon: { hiT: b4[hi].t, loT: b4[lo].t, hi: vH, lo: vL, state: ribbonState },
    orderBlocks: obs,
    profile,
    liq: { clusters, shortsAbove, longsBelow, skew },
    forecast: fc,
    ta,
  };
}

export function buildBook(
  depth: { venue: string; bids: [number, number][]; asks: [number, number][] }[],
  ref: number,
  clusters: Analysis["liq"]["clusters"],
): Book {
  // Spread comes from one venue: aggregated books overlap and would show a negative spread.
  const primary = depth.find((d) => d.venue === "Binance") ?? depth[0];
  const bestBid = primary?.bids[0]?.[0] ?? 0;
  const bestAsk = primary?.asks[0]?.[0] ?? Infinity;
  const mid = bestBid && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : ref;
  const STEP = 0.005;
  const SPAN = 16; // +/- 8%
  const map = new Map<number, BookRow>();
  const row = (k: number) => {
    let r = map.get(k);
    if (!r) {
      r = { price: mid * (1 + k * STEP), bid: 0, ask: 0, liqLong: 0, liqShort: 0 };
      map.set(k, r);
    }
    return r;
  };
  for (let k = -SPAN; k <= SPAN; k++) if (k !== 0) row(k);
  const sum = (s: [number, number][], lo: number, hi: number) => s.filter(([p]) => p >= lo && p <= hi).reduce((a, [, u]) => a + u, 0);
  for (const d of depth) {
    for (const [p, u] of d.bids) {
      const k = -Math.ceil((1 - p / mid) / STEP) || -1;
      if (k >= -SPAN) row(k).bid += u;
    }
    for (const [p, u] of d.asks) {
      const k = Math.ceil((p / mid - 1) / STEP) || 1;
      if (k <= SPAN) row(k).ask += u;
    }
  }
  for (const c of clusters) {
    const k = c.price > mid ? Math.ceil((c.price / mid - 1) / STEP) : -Math.ceil((1 - c.price / mid) / STEP);
    if (Math.abs(k) <= SPAN && k !== 0) {
      if (c.side === "long") row(k).liqLong += c.usd;
      else row(k).liqShort += c.usd;
    }
  }
  const imb = (w: number) => {
    let b = 0;
    let a = 0;
    for (const d of depth) {
      b += sum(d.bids, mid * (1 - w), mid);
      a += sum(d.asks, mid, mid * (1 + w));
    }
    return { b, a, i: a + b ? (b - a) / (a + b) : 0 };
  };
  const walls: Book["walls"] = [];
  for (const d of depth) {
    d.bids.forEach(([p, u]) => {
      if (p >= mid * 0.92) walls.push({ side: "bid", price: p, usd: u, venue: d.venue });
    });
    d.asks.forEach(([p, u]) => {
      if (p <= mid * 1.08) walls.push({ side: "ask", price: p, usd: u, venue: d.venue });
    });
  }
  walls.sort((x, y) => y.usd - x.usd);
  const i1 = imb(0.01);
  const i2 = imb(0.02);
  return {
    mid,
    spreadBp: bestBid ? ((bestAsk - bestBid) / mid) * 1e4 : 0,
    imb1: i1.i,
    imb2: i2.i,
    bid2: i2.b,
    ask2: i2.a,
    rows: [...map.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r),
    walls: walls.slice(0, 8),
    venues: depth.map((d) => d.venue),
  };
}
