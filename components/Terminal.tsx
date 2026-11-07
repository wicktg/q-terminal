"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AbsorbTab from "./AbsorbTab.tsx";
import TpoTab from "./TpoTab.tsx";
import { useJson } from "./use-json.ts";
import { wickText, type WickRead } from "@/lib/wicks.ts";
import type { FppRead } from "@/lib/fpp.ts";
import type { GokuView } from "@/lib/goku.ts";
import type { Analysis, Book, Forecast, Frame, NewsItem, NewsResp, ScreenerRow, UniverseCoin } from "@/lib/types.ts";
import { fmtPct, fmtPx, fmtUsd, pxDigits, setActiveSym, setPriceDigits, toneClass } from "@/lib/format.ts";
import { DEFAULT_LIST } from "@/lib/coins.ts";

const Chart = dynamic(() => import("./Chart"), { ssr: false });

// Applied once to watchlists saved earlier, so a later manual add or remove sticks.
const LIST_CHANGES = ["+1000PEPE", "+AERO", "+VVV", "+UNI", "-AVAX", "-XRP", "-BNB", "+ZRO"];
const TABS = ["CHART", "ZONES", "TPO", "ABSORB", "SCAN", "NEWS", "CONTEXT"] as const;
type Tab = (typeof TABS)[number];
const TICKER_WS = "wss://fstream.binance.com/market/ws/!miniTicker@arr"; // every perp, about once a second
const TICKER_STALE_MS = 15e3;
type Tick = { c: number; o: number };

const Loading = ({ err }: { err?: boolean }) => <div className="note">{err ? "Feed unavailable. Retrying." : "Loading…"}</div>;

const trendCell = (t: string) => <span className={t === "up" ? "up" : t === "down" ? "down" : "dim"}>{t === "up" ? "UP" : t === "down" ? "DOWN" : "MIXED"}</span>;

const trendTone = (t: string) => (t === "UP" ? "up" : t === "DOWN" ? "down" : "dim");
const arrow = (t: string) => (t === "UP" ? "▲" : t === "DOWN" ? "▼" : "–");

function FrameRow({ f }: { f: Frame }) {
  return (
    <div className="fr">
      <span className="dim">{f.tf}</span>
      <span className={trendTone(f.trend)}>{arrow(f.trend)} {f.trend}</span>
      <span className="r">{f.event ? <span className="amber">{f.event.kind} {f.event.dir > 0 ? "↑" : "↓"}</span> : "—"}</span>
      <span className="r dim">{f.event ? fmtPx(f.event.level) : ""}</span>
    </div>
  );
}

const since = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const pctOf = (x: number) => `${Math.round(x * 100)}%`;

function WickPanel({ w }: { w: WickRead }) {
  const recent = [...w.events].filter((e) => e.sweep || e.score >= 1).sort((x, y) => y.t - x.t).slice(0, 4);
  const stats = w.stats.filter((s) => s.n >= 5);
  return (
    <>
      <div className="h">WICKS<span>{w.tf.toUpperCase()} candles, latest first</span></div>
      {recent.length ? (
        recent.map((e) => (
          <div className="wk" key={`${e.t}${e.side}`}>
            <span className={e.side === "upper" ? "down" : "up"}>{e.side === "upper" ? "▼" : "▲"}</span>
            <span>{wickText(e, fmtPx, fmtUsd)}</span>
            <span className="dim">{since(e.t)}</span>
          </div>
        ))
      ) : (
        <div className="note">No meaningful wicks or sweeps lately.</div>
      )}
      <div className="h">WICK TRACK RECORD<span>{w.sym} {w.tf.toUpperCase()}, next {w.horizon} candles</span></div>
      <table className="stat wk-stats">
        <tbody>
          {stats.map((s) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td>
                <span className={s.hit > s.base + 0.05 ? "up" : s.hit < s.base - 0.05 ? "down" : ""}>{pctOf(s.hit)}</span>{" "}
                <span className="dim">vs {pctOf(s.base)} · {s.n}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="note">How often price moved the wick&apos;s way within {w.horizon} candles, against how often it moved that way anyway, with the number of cases. Under 20 cases is anecdotal.</div>
    </>
  );
}

const TF_HOURS: Record<string, number> = { "5m": 1 / 12, "15m": 0.25, "1h": 1, "4h": 4, "1d": 24 };
const span = (h: number) => (h >= 48 ? `${Math.round(h / 24)} days` : h >= 24 ? "1 day" : `${Math.round(h)}h`);

function FppPanel({ f }: { f: FppRead }) {
  const end = (v: number) => (Math.exp(v * f.atrPct) - 1) * 100;
  const pc = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
  const up = f.dir > 0;
  const t = f.test;
  return (
    <>
      <div className="h">FPP · FUTURE PRICE PREDICTION<span>{f.tf.toUpperCase()}, next {f.horizon} candles ({span(f.horizon * TF_HOURS[f.tf])})</span></div>
      <div className="fpp-call">
        <b className={up ? "up" : "down"}>{up ? "▲ UP" : "▼ DOWN"}</b>
        <span><b>{Math.round(f.prob * 100)}%</b> of the {f.neighbors} most similar past moments went this way</span>
      </div>
      <table className="stat fpp-stats">
        <tbody>
          <tr><td>Median move</td><td>{pc(end(f.median[f.horizon - 1]))}</td></tr>
          <tr><td>Middle half of outcomes</td><td>{pc(end(f.q25[f.horizon - 1]))} to {pc(end(f.q75[f.horizon - 1]))}</td></tr>
          <tr><td>Second model</td><td>{f.agree ? "agrees" : "disagrees, so confidence is lower"}</td></tr>
          <tr><td>History used</td><td>{f.days} days, {f.samples.toLocaleString()} moments</td></tr>
        </tbody>
      </table>
      <div className="fpp-drivers">
        <i>MAIN DRIVERS</i>
        {f.drivers.map((d) => (
          <span key={d.name} className={d.push >= 0 ? "up" : "down"}>{d.push >= 0 ? "↑" : "↓"} {d.name}</span>
        ))}
      </div>
      <div className={`fpp-verdict ${t.edge ? "up" : ""}`}>
        Replay on this coin: right {Math.round(t.hit * 100)}% of {t.n} times, against {Math.round(t.base * 100)}% for always guessing the more common direction.
        {t.edge ? " That is better than chance here, but past accuracy can fade." : " No proven edge here, so read the path as a scenario, not a signal."}
      </div>
      <div className="note">It compares the latest candle with every past one on momentum, stretch from the 50 EMA, volatility, taker flow, range position, the daily trend, BTC, market structure, time of day and room to liquidity, then follows what happened next. White candles are the real past path closest to that consensus, scaled to today&apos;s volatility. Open interest, funding, liquidations and long/short ratios are left out.</div>
    </>
  );
}

function GokuPanel({ g }: { g: GokuView }) {
  const s = g.stats;
  const pc = (x: number) => `${Math.round(x * 100)}%`;
  const L = g.last;
  const z = s.n ? (s.hit - s.base) / Math.sqrt(0.25 / s.n) : 0;
  const edge = s.n >= 20 && s.hit >= s.base + 0.05 && z >= 1.65 && s.raceN >= 10 && s.race > 0.5;
  const kZone = g.now.k <= 20 ? "oversold" : g.now.k >= 80 ? "overbought" : "mid-range";
  const wZone = g.now.wt2 <= -53 ? "oversold" : g.now.wt2 >= 53 ? "overbought" : "neutral";
  const touches = (n: number) => `${n} touch${n === 1 ? "" : "es"}`;
  return (
    <>
      <div className="h">GOKU<span>{g.tf.toUpperCase()} · trend, momentum, divergence, levels</span></div>
      <div className="goku-call">
        {L ? (
          <>
            <b className={L.side > 0 ? "up" : "down"}>{L.side > 0 ? "▲ BUY" : "▼ SELL"}{L.strong ? " · STRONG" : ""}</b>
            <span>{g.ago === 0 ? "on the last closed candle" : `${g.ago} candle${g.ago === 1 ? "" : "s"} ago`} at <b>{fmtPx(L.px)}</b></span>
          </>
        ) : (
          <b className="dim">No signal on these candles</b>
        )}
      </div>
      {L && (
        <ul className="goku-why">
          {L.why.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <table className="stat goku-stats">
        <tbody>
          <tr><td>Trend</td><td className={g.now.trend > 0 ? "up" : g.now.trend < 0 ? "down" : ""}>{g.now.trend > 0 ? "Up, fast EMA over slow" : g.now.trend < 0 ? "Down, fast EMA under slow" : "Mixed"}, fast {g.now.fastUp ? "rising" : "falling"}</td></tr>
          <tr><td>Stoch RSI</td><td>K {Math.round(g.now.k)} · D {Math.round(g.now.d)}, {kZone}</td></tr>
          <tr><td>WaveTrend</td><td>{Math.round(g.now.wt1)} / {Math.round(g.now.wt2)}, {wZone}</td></tr>
          <tr><td>Divergence</td><td>{g.div ? `${g.div.hidden ? "Hidden" : "Regular"} ${g.div.bull ? "bullish" : "bearish"}, ${g.div.ago} candles ago` : "None recently"}</td></tr>
          <tr><td>Resistance</td><td className="down">{g.res ? `${fmtPx(g.res.price)}, ${touches(g.res.touches)}` : "—"}</td></tr>
          <tr><td>Support</td><td className="up">{g.sup ? `${fmtPx(g.sup.price)}, ${touches(g.sup.touches)}` : "—"}</td></tr>
        </tbody>
      </table>
      <div className={`fpp-verdict ${edge ? "up" : ""}`}>
        {s.n ? (
          <>
            Track record on these candles: {s.n} signal{s.n === 1 ? "" : "s"}, {pc(s.hit)} closed their way after {s.hold} candles against {pc(s.base)} for the base rate, and {pc(s.race)} of {s.raceN} moved 1 ATR their way before 1 ATR against.
            {s.strongN ? ` Strong ones: ${pc(s.strongHit)} of ${s.strongN}.` : ""}
            {edge ? " Better than chance on this coin and timeframe, but small samples fade." : " No proven edge here, so treat signals as places to look, not orders."}
          </>
        ) : (
          "No finished signals on these candles yet."
        )}
      </div>
      <div className="note">A signal needs WaveTrend to cross out of an extreme plus one confirmation (Stoch RSI turning in its zone, a divergence, or a tested level) with the trend, or two against it. Signals use closed candles only and never repaint. Across 16 coins and four timeframes they tested close to a coin flip, slightly better on 4H and 1D. Open interest, funding, liquidations and long/short ratios are not used.</div>
    </>
  );
}

function StructurePanel({ a, price, wicks, fpp, goku }: { a: Analysis | null; price: number; wicks?: WickRead | null; fpp?: FppRead | null; goku?: GokuView | null }) {
  if (!a) return <Loading />;
  const px = price || a.price;
  const above = a.ta.zones.filter((z) => z.dist > 0).slice(0, 3).reverse();
  const below = a.ta.zones.filter((z) => z.dist < 0).slice(0, 3);
  const inside = a.ta.zones.filter((z) => z.dist === 0).slice(0, 2);
  const Z = ({ z }: { z: (typeof a.ta.zones)[number] }) => (
    <div className="fr">
      <span className="dim">{z.tf}</span>
      <span className={z.side === "DEMAND" ? "up" : "down"}>{z.kind}</span>
      <span className="r">{fmtPx(z.bottom)}–{fmtPx(z.top)}</span>
      <span className="r dim">{z.dist === 0 ? "here" : `${z.dist > 0 ? "+" : ""}${z.dist.toFixed(1)}%`}</span>
    </div>
  );
  return (
    <>
      {goku && goku.sym === a.sym && <GokuPanel g={goku} />}
      <div className="h">STRUCTURE</div>
      {a.ta.frames.map((f) => <FrameRow key={f.tf} f={f} />)}
      <div className="h">KEY ZONES<span>{fmtPx(px)}</span></div>
      {above.map((z) => <Z key={`${z.tf}${z.kind}${z.top}${z.bottom}`} z={z} />)}
      {inside.map((z) => <Z key={`${z.tf}${z.kind}${z.top}${z.bottom}`} z={z} />)}
      {below.map((z) => <Z key={`${z.tf}${z.kind}${z.top}${z.bottom}`} z={z} />)}
      {!a.ta.zones.length && <div className="note">No fresh zones within 15% of price.</div>}
      {fpp && fpp.sym === a.sym && <FppPanel f={fpp} />}
      {wicks && wicks.sym === a.sym && <WickPanel w={wicks} />}
    </>
  );
}

function MarketContext({ a }: { a: Analysis | null }) {
  if (!a) return <Loading />;
  const s = a.stats;
  const rows: [string, React.ReactNode][] = [
    ["Beta 30D / 90D", `${s.beta30.toFixed(2)} / ${s.beta90.toFixed(2)}`],
    ["Alpha/day 30D (t)", <span key="a" className={toneClass(s.alpha30)}>{fmtPct(s.alpha30)} ({s.alpha30t.toFixed(1)})</span>],
    ["Excess vs BTC 7D", <span key="e" className={toneClass(s.excess7d)}>{fmtPct(s.excess7d, 1)}</span>],
    ["Correlation 90D", s.corr90.toFixed(2)],
    ["RSI 1H / 4H / 1D", `${s.rsi1h.toFixed(0)} / ${s.rsi4h.toFixed(0)} / ${s.rsi1d.toFixed(0)}`],
    ["Trend 1H", trendCell(s.trend1h)],
    ["Trend 4H", trendCell(s.trend4h)],
    ["Trend 1D", trendCell(s.trend1d)],
    ["CVD perp 1H", <span key="c1" className={toneClass(s.cvdPerp1h)}>{fmtUsd(s.cvdPerp1h)}</span>],
    ["CVD perp 4H", <span key="c4" className={toneClass(s.cvdPerp4h)}>{fmtUsd(s.cvdPerp4h)}</span>],
    ["CVD perp 24H", <span key="c24" className={toneClass(s.cvdPerp24h)}>{fmtUsd(s.cvdPerp24h)}</span>],
    ["CVD spot 24H", <span key="cs" className={toneClass(s.cvdSpot24h)}>{fmtUsd(s.cvdSpot24h)}</span>],
    ["Volume 24H", fmtUsd(s.vol24hUsd)],
    ["OI (Binance + HL)", fmtUsd(s.oiUsd)],
    ["OI 1H", <span key="o1" className={toneClass(s.oiChg1h)}>{fmtPct(s.oiChg1h, 1)}</span>],
    ["OI 4H", <span key="o4" className={toneClass(s.oiChg4h)}>{fmtPct(s.oiChg4h, 1)}</span>],
    ["OI 24H", <span key="o24" className={toneClass(s.oiChg24h)}>{fmtPct(s.oiChg24h, 1)}</span>],
    ["OI / market cap", s.oiToMcap === null ? "—" : `${s.oiToMcap.toFixed(1)}%`],
    ["Funding Binance", s.fundingBinance === null ? "—" : `${s.fundingBinance.toFixed(1)}%`],
    ["Funding HL", s.fundingHL === null ? "—" : `${s.fundingHL.toFixed(1)}%`],
    ["ATR daily", `${s.atrDayPct.toFixed(1)}%`],
    ["Vol 30D ann.", `${s.vol30dAnn.toFixed(0)}%`],
  ];
  return (
    <>
      <div className="note proof">Reference only.</div>
      <div className="h">READ</div>
      {a.signals.map((g) => (
        <div className="sig" key={g.key}>
          <div className="k">
            <i>{g.key}</i>
            <span className={g.tone === "flat" ? "" : g.tone}>{g.value}</span>
          </div>
          <div className="n">{g.note}</div>
        </div>
      ))}
      <div className="h">NUMBERS</div>
      <table className="stat">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Zones({ sym, a }: { sym: string; a: Analysis | null }) {
  const { data: b, err } = useJson<Book>(`/api/book?sym=${sym}`, 5000);
  if (!a) return <Loading />;
  const dist = (d: number) => (d === 0 ? "here" : `${d > 0 ? "+" : ""}${d.toFixed(1)}%`);
  return (
    <div className="grid2">
      <div>
        <div className="h">SUPPLY AND DEMAND<span>fresh zones, nearest first</span></div>
        <table className="tbl">
          <thead><tr><th>TF</th><th>Type</th><th className="r">Range</th><th className="r">Away</th></tr></thead>
          <tbody>
            {a.ta.zones.map((z) => (
              <tr key={`${z.tf}${z.kind}${z.top}${z.bottom}`}>
                <td className="dim">{z.tf}</td>
                <td className={z.side === "DEMAND" ? "up" : "down"}>{z.kind}</td>
                <td className="r">{fmtPx(z.bottom)} – {fmtPx(z.top)}</td>
                <td className="r dim">{dist(z.dist)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="h">LIQUIDITY<span>untaken highs and lows</span></div>
        <table className="tbl">
          <tbody>
            {a.ta.pools.map((p) => (
              <tr key={`${p.tf}${p.side}${p.price}`}>
                <td className="dim">{p.tf}</td>
                <td className={p.side === "HIGH" ? "down" : "up"}>{p.touches > 1 ? `Equal ${p.side === "HIGH" ? "highs" : "lows"}` : `Swing ${p.side === "HIGH" ? "high" : "low"}`}</td>
                <td className="r">{fmtPx(p.price)}</td>
                <td className="r dim">{dist(p.dist)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="h">ORDER BOOK WALLS<span>{b ? b.venues.join(" · ") : ""}</span></div>
        {!b ? <Loading err={err} /> : (
          <>
            <table className="tbl">
              <tbody>
                {b.walls.map((w, i) => (
                  <tr key={i}>
                    <td className={w.side === "bid" ? "up" : "down"}>{w.side.toUpperCase()}</td>
                    <td>{fmtPx(w.price)}</td>
                    <td className="r">{fmtUsd(w.usd)}</td>
                    <td className="r dim">{dist((w.price / b.mid - 1) * 100)}</td>
                    <td className="dim">{w.venue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="stat">
              <tbody>
                <tr><td>Bids / asks within 2%</td><td>{fmtUsd(b.bid2)} / {fmtUsd(b.ask2)}</td></tr>
                <tr><td>Imbalance 1% / 2%</td><td><span className={toneClass(b.imb1)}>{b.imb1.toFixed(2)}</span> / <span className={toneClass(b.imb2)}>{b.imb2.toFixed(2)}</span></td></tr>
              </tbody>
            </table>
            <div className="note">Walls can be pulled at any time. Read them at a zone, not on their own.</div>
          </>
        )}
      </div>
    </div>
  );
}

function ContextTab({ a, sym }: { a: Analysis | null; sym: string }) {
  if (!a) return <Loading />;
  const liq = [...a.liq.clusters].sort((x, y) => y.usd - x.usd).slice(0, 8);
  return (
    <div className="grid2">
      <div><MarketContext a={a} /></div>
      <div>
        <div className="h">LIQUIDATION CLUSTERS<span>{sym}, estimated, largest first</span></div>
        <table className="stat">
          <tbody>
            <tr><td>Shorts above / longs below, 6%</td><td>{fmtUsd(a.liq.shortsAbove)} / {fmtUsd(a.liq.longsBelow)}</td></tr>
            {liq.map((c) => <tr key={`${c.side}${c.price}`}><td className={c.side === "short" ? "down" : "up"}>{c.side === "short" ? "Shorts" : "Longs"} {fmtPx(c.price)}</td><td>{fmtUsd(c.usd)}</td></tr>)}
          </tbody>
        </table>
        <ForecastTab a={a} />
      </div>
    </div>
  );
}

function Cone({ f, px }: { f: Forecast; px: number }) {
  const W = 640;
  const H = 240;
  const pad = 52;
  const hist = f.history;
  const seven = f.horizons[2];
  const all = [...hist.map((h) => h.c), seven.q05, seven.q95];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const y = (v: number) => 12 + (1 - (v - lo) / (hi - lo || 1)) * (H - 24);
  const split = (W - pad) * 0.66;
  const x = (i: number) => (i / (hist.length - 1)) * split;
  const fx = (d: number) => split + (d / 7) * (W - pad - split);
  const band = (a: "q05" | "q25", b: "q95" | "q75") => {
    const top = f.horizons.map((h) => `${fx(h.days)},${y(h[b])}`).join(" ");
    const bot = [...f.horizons].reverse().map((h) => `${fx(h.days)},${y(h[a])}`).join(" ");
    return `${split},${y(px)} ${top} ${bot}`;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} role="img" aria-label="Price history and 7 day probability cone">
      <polyline fill="none" stroke="#808080" strokeWidth="1" points={hist.map((h, i) => `${x(i)},${y(h.c)}`).join(" ")} />
      <polygon points={band("q05", "q95")} fill="rgba(245,166,35,.09)" />
      <polygon points={band("q25", "q75")} fill="rgba(245,166,35,.16)" />
      <polyline fill="none" stroke="#f5a623" strokeWidth="1" points={[`${split},${y(px)}`, ...f.horizons.map((h) => `${fx(h.days)},${y(h.q50)}`)].join(" ")} />
      <line x1={split} x2={split} y1="0" y2={H} stroke="#2c2c2c" strokeDasharray="2 3" />
      {[seven.q95, seven.q50, seven.q05].map((v) => (
        <text key={v} x={W - pad + 4} y={y(v) + 3} fontSize="10" fill="#808080">{fmtPx(v)}</text>
      ))}
    </svg>
  );
}

function ForecastTab({ a }: { a: Analysis | null }) {
  if (!a) return <Loading />;
  const f = a.forecast;
  const color = f.direction === "UP" ? "up" : f.direction === "DOWN" ? "down" : "amber";
  const trusted = f.backtest.calls >= 15 && f.backtest.hitRate > 0.55;
  return (
    <>
      <div className="verdict">
        <div className={`big ${color}`}>{f.direction}</div>
        <div><span className="dim">P(higher in 3D) </span>{(f.pUp3d * 100).toFixed(1)}%</div>
        <div className="sub">Typical daily move ±{(f.sigmaDay * 100).toFixed(1)}%</div>
      </div>
      <Cone f={f} px={a.price} />
      <table className="tbl">
        <thead>
          <tr><th>Horizon</th><th className="r">5%</th><th className="r">25%</th><th className="r">Median</th><th className="r">75%</th><th className="r">95%</th><th className="r">P(up)</th></tr>
        </thead>
        <tbody>
          {f.horizons.map((h) => (
            <tr key={h.label}>
              <td>{h.label}</td><td className="r">{fmtPx(h.q05)}</td><td className="r">{fmtPx(h.q25)}</td><td className="r amber">{fmtPx(h.q50)}</td><td className="r">{fmtPx(h.q75)}</td><td className="r">{fmtPx(h.q95)}</td><td className="r">{(h.pUp * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid2">
        <div>
          <div className="h">ODDS OF TOUCHING<span>from {fmtPx(a.price)}</span></div>
          <table className="tbl">
            <thead><tr><th>Level</th><th className="r">Price</th><th className="r">3D</th><th className="r">7D</th></tr></thead>
            <tbody>
              {f.touches.map((t) => (
                <tr key={t.price}>
                  <td>{t.label}</td>
                  <td className={`r ${t.price > a.price ? "down" : "up"}`}>{fmtPx(t.price)}</td>
                  <td className="r">{(t.p3d * 100).toFixed(0)}%</td>
                  <td className="r">{(t.p7d * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="h">WHAT DRIVES THE TILT</div>
          <ul className="list">{f.drivers.map((d) => <li key={d}>{d}</li>)}</ul>
          <div className="h">MODEL HONESTY</div>
          <table className="stat">
            <tbody>
              <tr><td>Analogs: P(up) vs base rate</td><td>{(f.analogs.pUp * 100).toFixed(0)}% vs {(f.analogs.base * 100).toFixed(0)}% (n={f.analogs.n})</td></tr>
              <tr><td>Walk-forward hit rate, 3D</td><td className={trusted ? "up" : "down"}>{f.backtest.calls ? `${(f.backtest.hitRate * 100).toFixed(0)}% on ${f.backtest.calls} calls` : "too few calls"}</td></tr>
              <tr><td>Analogs used in forecast?</td><td>{trusted ? "Yes" : "No, not proven on this coin"}</td></tr>
            </tbody>
          </table>
          <div className="note">Paths resample this coin&apos;s own returns at the forecast volatility, so a neutral read is 50%. Flow only tilts the drift slightly. Treat anything near 50% as no edge.</div>
        </div>
      </div>
    </>
  );
}

function Screener({ list, onPick }: { list: string[]; onPick: (s: string) => void }) {
  const url = useMemo(() => `/api/screener?syms=${list.join(",")}`, [list]);
  const { data, err } = useJson<ScreenerRow[]>(url, 90000);
  if (!data) return <Loading err={err} />;
  const tfs = data[0]?.frames.map((f) => f.tf) ?? [];
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tbl">
        <thead>
          <tr><th>Coin</th><th className="r">Price</th><th className="r">24H</th>{tfs.map((t) => <th key={t} className="r">{t}</th>)}<th>Latest shift</th></tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.sym} className="click" onClick={() => onPick(r.sym)}>
              <td style={{ color: "#fff" }}>{r.sym}</td>
              <td className="r">{fmtPx(r.price, r.sym)}</td>
              <td className={`r ${toneClass(r.chg24h)}`}>{fmtPct(r.chg24h)}</td>
              {r.frames.map((f) => <td key={f.tf} className={`r ${trendTone(f.trend)}`}>{arrow(f.trend)}</td>)}
              <td className="dim">{r.event}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ago = (t: number, now: number) => {
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};

// Top stories by impact and freshness, at most two per category so one event cannot fill the list.
function hottest(items: NewsItem[], n: number) {
  const used: Record<string, number> = {};
  const out: NewsItem[] = [];
  for (const i of [...items].filter((x) => x.impact !== "LOW").sort((a, b) => b.hot - a.hot)) {
    if ((used[i.category] ?? 0) >= 2) continue;
    used[i.category] = (used[i.category] ?? 0) + 1;
    out.push(i);
    if (out.length === n) break;
  }
  return out;
}

const biasClass = (b: NewsItem["bias"]) => (b === "RISK-ON" ? "up" : b === "RISK-OFF" ? "down" : "faint");

function NewsRow({ i, now }: { i: NewsItem; now: number }) {
  return (
    <a className="news-row" href={i.link} target="_blank" rel="noreferrer noopener">
      <span className={now - i.updated < 15 * 60000 ? "amber" : "dim"}>{ago(i.updated, now)}</span>
      <span className={i.impact === "HIGH" ? "amber" : i.impact === "MED" ? "" : "faint"}>{i.impact}</span>
      <span className="dim">{i.category}</span>
      <span className="news-main">
        <span className="news-title">{i.title}</span>
        <span className="news-sub">
          {i.source}
          {i.sources > 1 ? ` +${i.sources - 1} more` : ""}
          {i.impact === "HIGH" ? ` · ${i.why}` : ""}
          {i.coins.length ? ` · ${i.coins.join(" ")}` : ""}
        </span>
      </span>
      <span className={`news-bias ${biasClass(i.bias)}`}>{i.bias}</span>
    </a>
  );
}

const FILTERS = ["TOP", "HIGH", "CRYPTO", "MACRO", "WAR", "ALL"] as const;
const WORLD = ["WAR", "FED", "MACRO", "OIL"];

function News({ news, err, sym }: { news: NewsResp | null; err: boolean; sym: string }) {
  const [f, setF] = useState<(typeof FILTERS)[number] | "COIN">("TOP");
  if (!news) return <Loading err={err} />;
  const now = news.asOf;
  const hot = f === "TOP" ? hottest(news.items, 6) : [];
  const test = (i: NewsItem) => {
    if (f === "ALL") return true;
    if (f === "COIN") return i.coins.includes(sym);
    if (f === "HIGH") return i.impact === "HIGH";
    if (f === "WAR") return i.category === "WAR" || i.category === "OIL";
    if (f === "MACRO") return i.category === "FED" || i.category === "MACRO" || i.category === "OIL";
    if (f === "CRYPTO") return !WORLD.includes(i.category);
    return i.impact !== "LOW" && !hot.includes(i);
  };
  const rows = news.items.filter(test);
  return (
    <>
      <div className="chart-bar">
        {FILTERS.map((x) => (
          <button key={x} data-on={x === f} onClick={() => setF(x)}>{x}</button>
        ))}
        <button data-on={f === "COIN"} onClick={() => setF("COIN")}>{sym}</button>
        <span className="keys faint">{news.feedsOk}/{news.feedsTotal} FEEDS · {new Date(news.asOf).toLocaleTimeString("en-GB")}</span>
      </div>
      {hot.length > 0 && (
        <>
          <div className="h">HOT NOW<span>impact and freshness</span></div>
          {hot.map((i) => <NewsRow key={i.id} i={i} now={now} />)}
          <div className="h">LATEST</div>
        </>
      )}
      {rows.map((i) => <NewsRow key={i.id} i={i} now={now} />)}
      {!rows.length && <div className="note">Nothing here in the last 24 hours.</div>}
      <div className="note">Refreshes every 15 seconds. Free feeds run about 5–15 minutes behind the wire, so price can move first. Impact and RISK-ON/OFF are keyword rules reading the headline only. Open the story before acting on it.</div>
    </>
  );
}

export default function Terminal() {
  const [sym, setSym] = useState("HYPE");
  const [tab, setTab] = useState<Tab>("CHART");
  const [list, setList] = useState(DEFAULT_LIST);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<number | null>(null);
  const [wicks, setWicks] = useState<WickRead | null>(null);
  const [goku, setGoku] = useState<GokuView | null>(null);
  const [fpp, setFpp] = useState<FppRead | null>(null);
  const [tick, setTick] = useState<Record<string, Tick>>({});
  const tickAt = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const { data: uni } = useJson<UniverseCoin[]>("/api/universe", 15000);
  const { data: analysis, err } = useJson<Analysis>(`/api/coin?sym=${sym}`, 60000);
  const { data: news, err: newsErr } = useJson<NewsResp>("/api/news", 15000);
  const top = useMemo(() => (news ? hottest(news.items, 1)[0] : undefined), [news]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("q.list") ?? "null");
      if (Array.isArray(saved) && saved.length) {
        const seen = JSON.parse(localStorage.getItem("q.changes") ?? "[]") as string[];
        const merged = LIST_CHANGES.filter((c) => !seen.includes(c)).reduce<string[]>((l, c) => (c[0] === "-" ? l.filter((x) => x !== c.slice(1)) : l.includes(c.slice(1)) ? l : [...l, c.slice(1)]), saved);
        setList(merged);
        localStorage.setItem("q.list", JSON.stringify(merged));
      }
      localStorage.setItem("q.changes", JSON.stringify(LIST_CHANGES));
      const s = localStorage.getItem("q.sym");
      if (s) setSym(s);
    } catch {
      /* storage may be blocked */
    }
  }, []);
  const saveList = (l: string[]) => {
    setList(l);
    try {
      localStorage.setItem("q.list", JSON.stringify(l));
    } catch {
      /* ignore */
    }
  };
  const pick = useCallback((s: string) => {
    setSym(s);
    setLive(null);
    setOpen(false);
    setQ("");
    setTab((t) => (t === "SCAN" ? "CHART" : t));
    try {
      localStorage.setItem("q.sym", s);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) {
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        search.current?.focus();
      }
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length) setTab(TABS[n - 1]);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // Live prices for every coin from Binance's ticker stream, batched to one update a second.
  useEffect(() => {
    let dead = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let buf: Record<string, Tick> = {};
    const connect = () => {
      if (dead) return;
      const s = new WebSocket(TICKER_WS);
      ws = s;
      s.onmessage = (e) => {
        for (const t of JSON.parse(e.data) as { s: string; c: string; o: string }[]) if (t.s.endsWith("USDT")) buf[t.s.slice(0, -4)] = { c: +t.c, o: +t.o };
      };
      s.onerror = () => s.close();
      s.onclose = () => {
        if (!dead) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    const flush = setInterval(() => {
      if (!Object.keys(buf).length) return;
      const b = buf;
      buf = {};
      tickAt.current = Date.now();
      setTick((p) => ({ ...p, ...b }));
    }, 1000);
    return () => {
      dead = true;
      ws?.close();
      clearInterval(flush);
      if (retry) clearTimeout(retry);
    };
  }, []);

  useMemo(() => uni && setPriceDigits(uni), [uni]);
  setActiveSym(sym); // prices on this page format to the selected coin's tick unless told otherwise

  const byS = useMemo(() => new Map(uni?.map((u) => [u.sym, u]) ?? []), [uni]);
  const results = q ? (uni ?? []).filter((u) => u.sym.includes(q.toUpperCase())).slice(0, 40) : null;
  const u = byS.get(sym);
  // One price for the whole page. On the chart tab it is the live candle's close, so the two always match.
  // Elsewhere, and for every other coin, it is the ticker stream, falling back to the 15 second snapshot.
  const ticks = Date.now() - tickAt.current < TICKER_STALE_MS ? tick : {};
  const priceOf = (s: string, fallback: number) => (s === sym && tab === "CHART" && live ? live : (ticks[s]?.c ?? fallback));
  const chgOf = (s: string, p: number, fallback: number) => (ticks[s] ? (p / ticks[s].o - 1) * 100 : fallback);
  const price = priceOf(sym, u?.price ?? analysis?.price ?? 0);
  const chg = chgOf(sym, price, u?.chg24h ?? 0);
  const a = analysis?.sym === sym ? analysis : null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand hide-m">Q</span>
        <button className="sym" onClick={() => setOpen((o) => !o)}>{sym}</button>
        <span className="price">{price ? fmtPx(price) : "—"}</span>
        <span className={toneClass(chg)}>{fmtPct(chg)}</span>
        {a?.ta.frames.map((f) => <span key={f.tf} className="kv"><span className="hide-m">{f.tf} </span><b className={trendTone(f.trend)}>{arrow(f.trend)}</b></span>)}
        <span className="status">{err ? "DATA ERROR" : a ? new Date(a.asOf).toLocaleTimeString("en-GB") : "LOADING"}</span>
      </header>

      <nav className="tabs">
        {TABS.map((t, i) => (
          <button key={t} className="tab" data-on={t === tab} onClick={() => setTab(t)}>
            <kbd>{i + 1}</kbd>{t}
          </button>
        ))}
        {top && (
          <button className="ticker" onClick={() => setTab("NEWS")} title={top.title}>
            <span className={biasClass(top.bias)}>{top.category}</span> {top.title}
          </button>
        )}
      </nav>

      <div className="body">
        <aside className={`side ${open ? "open" : ""}`}>
          <input ref={search} className="search" placeholder="Search / to focus" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search coins" />
          <div className="wl">
            {(results ?? list.map((s) => byS.get(s) ?? { sym: s, price: 0, chg24h: 0, vol24hUsd: 0, funding: 0 })).map((c) => {
              const p = priceOf(c.sym, c.price);
              const ch = chgOf(c.sym, p, c.chg24h);
              return (
              <div key={c.sym} className="wl-row" data-on={c.sym === sym} role="button" tabIndex={0} onClick={() => pick(c.sym)} onKeyDown={(e) => e.key === "Enter" && pick(c.sym)}>
                <span className="n">{c.sym}</span>
                <span>{p ? fmtPx(p, c.sym) : "—"}</span>
                <span className={toneClass(ch)} style={{ minWidth: 52, textAlign: "right" }}>{fmtPct(ch, 1)}</span>
                {results && !list.includes(c.sym) && (
                  <button className="wl-x" style={{ gridColumn: 3 }} onClick={(e) => { e.stopPropagation(); saveList([...list, c.sym]); }}>+ add</button>
                )}
              </div>
              );
            })}
          </div>
        </aside>

        <main className={`main ${tab === "CHART" || tab === "TPO" ? "fill" : ""}`}>
          {tab === "CHART" && (
            <>
              <Chart sym={sym} analysis={a} onPrice={setLive} digits={pxDigits(price || 1, sym)} onWicks={setWicks} onFpp={setFpp} onGoku={setGoku} />
              <div className="ctx-inline"><StructurePanel a={a} price={price} wicks={wicks} fpp={fpp} goku={goku} /></div>
            </>
          )}
          {tab === "ZONES" && <Zones sym={sym} a={a} />}
          {tab === "TPO" && <TpoTab sym={sym} price={price} />}
          {tab === "ABSORB" && <AbsorbTab sym={sym} />}
          {tab === "SCAN" && <Screener list={list} onPick={pick} />}
          {tab === "NEWS" && <News news={news} err={newsErr} sym={sym} />}
          {tab === "CONTEXT" && <ContextTab a={a} sym={sym} />}
        </main>

        <section className="ctx"><StructurePanel a={a} price={price} wicks={wicks} fpp={fpp} goku={goku} /></section>
      </div>

      <nav className="mob-nav">
        {TABS.map((t) => (
          <button key={t} data-on={t === tab} onClick={() => setTab(t)}>{t === "CONTEXT" ? "INFO" : t}</button>
        ))}
      </nav>
    </div>
  );
}
