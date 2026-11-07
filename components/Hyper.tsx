"use client";
// HYPERMODE: what the market makers on Hyperliquid are doing in each coin, read with structure and the analog
// range engine. Everything here is a live read; the side panel says which parts have been replay-tested.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Band, HyperLevel, HyperRead, HyperRow, Side } from "@/lib/hyper.ts";
import { DEFAULT_LIST } from "@/lib/coins.ts";
import { fmtPct, fmtPx, fmtUsd, setActiveSym, setPriceDigits, toneClass } from "@/lib/format.ts";
import { useJson } from "./use-json.ts";

const arrow = (d: number) => (d > 0 ? "▲" : d < 0 ? "▼" : "◆");
const tone = (d: number) => (d > 0 ? "up" : d < 0 ? "down" : "amber");
const pct = (p: number) => `${Math.round(p * 100)}%`;
const mins = (m: number) => (m < 90 ? `${Math.max(1, Math.round(m))}m` : `${(m / 60).toFixed(1)}h`);
const signed = (x: number) => `${x > 0 ? "+" : ""}${fmtUsd(x)}`;

export default function Hyper() {
  const [list, setList] = useState<string[]>(DEFAULT_LIST);
  const [sym, setSym] = useState<string>("");
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("q.list") ?? "null");
      const l = Array.isArray(saved) && saved.length ? (saved as string[]) : DEFAULT_LIST;
      setList(l);
      const url = new URLSearchParams(location.search).get("sym")?.toUpperCase();
      setSym(url || localStorage.getItem("q.hyper.sym") || localStorage.getItem("q.sym") || l[0]);
    } catch {
      setSym(DEFAULT_LIST[0]);
    }
  }, []);
  const pick = (s: string) => {
    setSym(s);
    try {
      localStorage.setItem("q.hyper.sym", s);
      history.replaceState(null, "", `?sym=${s}`);
    } catch {}
  };

  const { data: uni } = useJson<{ sym: string; dp?: number }[]>("/api/universe", 60000);
  useMemo(() => uni && setPriceDigits(uni), [uni]);
  if (sym) setActiveSym(sym);
  const { data: rows } = useJson<HyperRow[]>(list.length ? `/api/hyper/all?syms=${list.join(",")}` : null, 30000);
  const { data, err } = useJson<HyperRead & { error?: string }>(sym ? `/api/hyper?sym=${sym}` : null, 20000);
  const h = data && data.sym === sym && !data.error ? data : null;

  return (
    <div className="hm">
      <header className="topbar">
        <a className="brand" href="/">Q</a>
        <span className="hm-title">HYPERMODE</span>
        {h && (
          <>
            <span className="sym">{sym}</span>
            <span className="price">{fmtPx(h.mid)}</span>
            <span className={toneClass(h.chg)}>{fmtPct(h.chg)}</span>
          </>
        )}
        <a className="hm-back" href="/">← TERMINAL</a>
        <span className="status hm-status">{err ? "DATA ERROR" : h ? new Date(h.asOf).toLocaleTimeString("en-GB") : "LOADING"}</span>
      </header>

      <nav className="hm-strip">
        {list.map((s) => {
          const r = rows?.find((x) => x.sym === s);
          const p = r?.pressure ?? 0;
          return (
            <button key={s} data-on={s === sym} onClick={() => pick(s)} title={r ? `Makers net ${fmtUsd(r.net)} · pressure ${p}` : s}>
              <span>{s}</span>
              <em className={Math.abs(p) >= 15 ? tone(p) : "faint"}>{r ? `${p > 0 ? "+" : ""}${p}` : "·"}</em>
              <i className="hm-chip-bar"><b className={tone(p)} style={{ width: `${Math.min(50, Math.abs(p) / 2)}%`, [p >= 0 ? "left" : "right"]: "50%" }} /></i>
            </button>
          );
        })}
      </nav>

      <main className="hm-body">
        {!h ? (
          <div className="hm-wait">{data?.error ? data.error : err ? "Could not read Hyperliquid right now. Retrying." : `Reading market makers on ${sym || "…"}`}</div>
        ) : (
          <div className="hm-grid">
            <div className="hm-col">
              <Verdict h={h} />
              <Tactics h={h} />
            </div>
            <div className="hm-col">
              <RangeMap h={h} />
              <Levels h={h} />
            </div>
            <div className="hm-wide">
              <Makers h={h} />
              <Book h={h} />
              <HowTo />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Verdict({ h }: { h: HyperRead }) {
  const v = h.verdict;
  const word = v.dir > 0 ? "UP" : v.dir < 0 ? "DOWN" : "RANGE";
  const t = (tf: string) => h.frames.find((f) => f.tf === tf)?.trend;
  const tArrow = (tf: string) => arrow(t(tf) === "UP" ? 1 : t(tf) === "DOWN" ? -1 : 0);
  const a = h.analog.h24;
  const rows: [string, Band][] = [["4H", h.range.h4], ["24H", h.range.h24], ["3D", h.range.d3]];
  return (
    <section className="hm-card">
      <div className="h">VERDICT · NEXT HOURS TO DAYS</div>
      <div className="hm-call">
        <b className={tone(v.dir)}>{arrow(v.dir)} {word}</b>
        <span>{v.label}</span>
      </div>
      <div className="hm-votes">
        <div><i>MAKERS</i><b className={tone(v.mm)}>{arrow(v.mm)} {h.mm.pressure > 0 ? "+" : ""}{h.mm.pressure}</b></div>
        <div><i>CHART</i><b>1H <span className={tone(t("1H") === "UP" ? 1 : t("1H") === "DOWN" ? -1 : 0)}>{tArrow("1H")}</span> 4H <span className={tone(t("4H") === "UP" ? 1 : t("4H") === "DOWN" ? -1 : 0)}>{tArrow("4H")}</span></b></div>
        <div><i>ANALOGS 24H</i><b className={tone(v.analog)}>{arrow(a.dir)} {pct(a.prob)}</b></div>
      </div>
      <Gauge h={h} />
      <div className="hm-plan">
        <div>
          <i>{v.dir !== 0 ? "TARGET" : "RANGE HIGH"}</i>
          <b className={v.dir !== 0 ? tone(v.dir) : ""}>{v.target ? fmtPx(v.target.px) : "—"}</b>
          <span>{v.target?.label}</span>
          <em>{pct(v.pTarget)} first</em>
        </div>
        <div>
          <i>{v.dir !== 0 ? "INVALID" : "RANGE LOW"}</i>
          <b>{v.invalid ? fmtPx(v.invalid.px) : "—"}</b>
          <span>{v.invalid?.label}</span>
          <em>{pct(v.pInvalid)} first</em>
        </div>
        <small>Which trades first within 24 hours, in similar past moments. Neither: {pct(v.pNone)}.</small>
      </div>
      <table className="tbl hm-ranges">
        <thead><tr><th /><th className="r">TYPICAL REACH</th><th className="r">WIDE (1 IN 5 BEYOND)</th></tr></thead>
        <tbody>
          {rows.map(([k, b]) => (
            <tr key={k}><td className="dim">{k}</td><td className="r">{fmtPx(b.lo50)} – {fmtPx(b.hi50)}</td><td className="r dim">{fmtPx(b.lo80)} – {fmtPx(b.hi80)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="hm-note">
        Analog replay on {h.sym} 1H: direction right {pct(a.hit)} of {a.n} times, against {pct(a.base)} for always guessing the common side.{" "}
        {a.edge ? <b className="up">Edge in replay.</b> : <b>No proven edge.</b>} The 80% close band held {pct(a.cover80)} of the time. The maker read is live only and cannot be replayed.
      </p>
    </section>
  );
}

function Gauge({ h }: { h: HyperRead }) {
  const p = h.mm.pressure;
  const parts: [string, number, string][] = [
    ["Quote skew", h.mm.parts.quote, "bids vs asks, size and distance"],
    ["Aggressive flow", h.mm.parts.aggressive, "makers paying the spread"],
    ["Passive flow", h.mm.parts.passive, "fills taken, counted against"],
  ];
  const bar = (x: number) => <i className="hm-bar"><b className={tone(x)} style={{ width: `${Math.min(50, Math.abs(x) * 50)}%`, [x >= 0 ? "left" : "right"]: "50%" }} /></i>;
  return (
    <div className="hm-gauge">
      <div className="hm-gauge-top"><span>MAKER PRESSURE</span><b className={Math.abs(p) >= 15 ? tone(p) : "amber"}>{p > 0 ? "+" : ""}{p}</b><span className="faint">−100 sell · +100 buy</span></div>
      <i className="hm-bar big"><b className={tone(p)} style={{ width: `${Math.min(50, Math.abs(p) / 2)}%`, [p >= 0 ? "left" : "right"]: "50%" }} /><u style={{ left: "42.5%" }} /><u style={{ left: "57.5%" }} /></i>
      {parts.map(([n, x, note]) => (
        <div key={n} className="hm-part" title={note}><span>{n}</span>{bar(x)}<em className={Math.abs(x) >= 0.1 ? tone(x) : "faint"}>{x >= 0 ? "+" : ""}{x.toFixed(2)}</em></div>
      ))}
    </div>
  );
}

function Tactics({ h }: { h: HyperRead }) {
  return (
    <section className="hm-card">
      <div className="h">MARKET MAKER TACTICS · NOW</div>
      {h.tactics.map((t, i) => (
        <div key={i} className="hm-tac">
          <span className={`hm-tag ${t.tone === "flat" ? "" : t.tone}`}>{t.tag}</span>
          <p>{t.text}</p>
        </div>
      ))}
    </section>
  );
}

// Places labels top to bottom at least `gap` apart, then pulls them back up if they ran off the bottom.
function spread(ys: number[], gap: number, top: number, bottom: number) {
  const out = ys.map((y) => Math.max(top, y));
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  if (out.length && out[out.length - 1] > bottom) {
    out[out.length - 1] = bottom;
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
  }
  return out;
}

function RangeMap({ h }: { h: HyperRead }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 460;
  const pad = 16;
  const { lo, hi, bins } = h.depth;
  const y = (p: number) => pad + (1 - (p - lo) / (hi - lo)) * (H - 2 * pad - 14);
  const narrow = w < 520;
  const depthW = narrow ? 58 : 110;
  const ax = depthW + 4;
  const colW = narrow ? 16 : 24;
  const colGap = narrow ? 5 : 9;
  const colX = (i: number) => ax + 8 + i * (colW + colGap);
  const labX = colX(3) + 4;
  const maxBook = Math.max(1, ...bins.map((b) => b.book));
  const maxMm = Math.max(1, ...bins.map((b) => b.mmBid + b.mmAsk));
  const step = bins.length > 1 ? bins[1].px - bins[0].px : 0;
  const cols: [string, Band][] = [["4H", h.range.h4], ["24H", h.range.h24], ["3D", h.range.d3]];
  const v = h.verdict;
  const same = (a: number, b?: { px: number } | null) => !!b && Math.abs(a - b.px) < 1e-12;
  const color = (k: string) => (k === "pool" ? "var(--amber)" : k === "zone" ? "var(--blue)" : k === "wall" ? "#e2e2e2" : k === "edge" ? "#bdbdbd" : "var(--dim)");
  type Item = { px: number; text: string; kind: string; p: number | null };
  const edges: Item[] = [v.target, v.invalid]
    .filter((x): x is { px: number; label: string } => !!x && !h.levels.some((l) => same(l.px, x)))
    .map((x) => ({ px: x.px, kind: "edge", p: null, text: `${fmtPx(x.px)} ${x === v.target ? (v.dir === 0 ? "RANGE HIGH" : "TARGET") : v.dir === 0 ? "RANGE LOW" : "INVALID"}` }));
  const items: Item[] = [...h.levels.map((l) => ({ px: l.px, kind: l.kind, p: l.p24, text: `${fmtPx(l.px)} ${l.label}` })), ...edges]
    .filter((x) => x.px > lo && x.px < hi)
    .sort((a, b) => b.px - a.px);
  const ly = spread(items.map((x) => y(x.px)), 13, pad + 4, H - pad - 18);
  const chars = Math.max(10, Math.floor((w - labX - 22) / 6.1));
  const ym = y(h.mid);
  return (
    <section className="hm-card">
      <div className="h">RANGE MAP · MAKER ORDERS, REACH AND LEVELS</div>
      <div ref={ref} className="hm-map">
        <svg width={w} height={H} role="img" aria-label={`Range map for ${h.sym}`}>
          {bins.map((b, i) => {
            const y0 = y(b.px + step / 2);
            const y1 = y(b.px - step / 2);
            const bh = Math.max(1, y1 - y0 - 1);
            const bw = (b.book / maxBook) * (depthW - 4);
            const mw = ((b.mmBid + b.mmAsk) / maxMm) * (depthW - 4);
            return (
              <g key={i}>
                <rect x={ax - bw} y={y0} width={bw} height={bh} fill="#1c1c1c" />
                {mw > 0 && <rect x={ax - mw} y={y0 + bh * 0.2} width={mw} height={Math.max(1, bh * 0.6)} fill={b.mmBid >= b.mmAsk ? "var(--up)" : "var(--down)"} opacity={0.85} />}
              </g>
            );
          })}
          <line x1={ax} x2={ax} y1={pad - 6} y2={H - pad - 10} stroke="var(--line-2)" />
          {cols.map(([k, b], i) => (
            <g key={k}>
              <rect x={colX(i)} y={y(Math.min(hi, b.hi80))} width={colW} height={Math.max(1, y(Math.max(lo, b.lo80)) - y(Math.min(hi, b.hi80)))} fill="rgba(255,255,255,0.07)" />
              <rect x={colX(i)} y={y(Math.min(hi, b.hi50))} width={colW} height={Math.max(1, y(Math.max(lo, b.lo50)) - y(Math.min(hi, b.hi50)))} fill="rgba(255,255,255,0.17)" />
              <rect x={colX(i) + colW / 2 - 1.5} y={y(b.c75)} width={3} height={Math.max(1, y(b.c25) - y(b.c75))} fill="var(--amber)" opacity={0.9} />
              <text x={colX(i) + colW / 2} y={H - 4} textAnchor="middle" className="hm-svg-dim">{k}</text>
            </g>
          ))}
          <line x1={0} x2={w} y1={ym} y2={ym} stroke="var(--amber)" strokeDasharray="3 3" opacity={0.8} />
          <text x={2} y={ym - 4} className="hm-svg-px">{fmtPx(h.mid)}</text>
          {items.map((x, i) => {
            const yy = y(x.px);
            const t = same(x.px, v.target);
            const inv = same(x.px, v.invalid);
            const cls = t && v.dir !== 0 ? `hm-svg-lv ${v.dir < 0 ? "down" : "up"}` : inv && v.dir !== 0 ? "hm-svg-lv dim" : "hm-svg-lv";
            const room = chars - (x.p === null ? 2 : 6);
            return (
              <g key={`${x.kind}${x.px}`}>
                <line x1={colX(0) - 4} x2={labX} y1={yy} y2={yy} stroke={color(x.kind)} opacity={t || inv ? 0.9 : 0.35} strokeDasharray={x.kind === "entry" || x.kind === "edge" ? "3 3" : undefined} />
                <line x1={labX} x2={labX + 6} y1={yy} y2={ly[i] - 3.5} stroke={color(x.kind)} opacity={0.5} />
                <text x={labX + 9} y={ly[i]} className={cls}>
                  {t && v.dir !== 0 ? "◎ " : inv && v.dir !== 0 ? "✕ " : ""}
                  {x.text.length > room ? `${x.text.slice(0, room - 1)}…` : x.text}
                  {x.p !== null && <tspan className="hm-svg-p"> {pct(x.p)}</tspan>}
                </text>
              </g>
            );
          })}
          <text x={2} y={pad - 4} className="hm-svg-dim">{fmtPx(hi)}</text>
          <text x={2} y={H - pad - 2} className="hm-svg-dim">{fmtPx(lo)}</text>
        </svg>
      </div>
      <div className="hm-legend">
        <span><i className="sw up-bg" />maker bids</span>
        <span><i className="sw down-bg" />maker asks</span>
        <span><i className="sw book" />whole book</span>
        <span><i className="sw reach" />typical · wide reach</span>
        <span><i className="sw close" />middle half of closes</span>
        <span>% = trades within 24h</span>
      </div>
    </section>
  );
}

function Levels({ h }: { h: HyperRead }) {
  const above = h.levels.filter((l) => l.px > h.mid);
  const below = h.levels.filter((l) => l.px <= h.mid);
  const row = (l: HyperLevel) => (
    <div key={l.px} className="hm-lv">
      <b>{fmtPx(l.px)}</b>
      <span className={`k-${l.kind}`}>{l.label}</span>
      <em><i style={{ width: pct(l.p4) }} />{pct(l.p4)}</em>
      <em><i style={{ width: pct(l.p24) }} />{pct(l.p24)}</em>
      <span className={`r ${toneClass(l.gain)}`}>{Math.abs(l.gain) >= 1000 ? signed(l.gain) : "—"}</span>
    </div>
  );
  return (
    <section className="hm-card">
      <div className="h">LEVELS · CHANCE THEY TRADE</div>
      <div className="hm-lv hm-lv-head"><b>PRICE</b><span>WHAT</span><em>4H</em><em>24H</em><span className="r">MAKERS P&amp;L</span></div>
      {above.map(row)}
      <div className="hm-lv hm-now"><b>{fmtPx(h.mid)}</b><span>now</span><em /><em /><span /></div>
      {below.map(row)}
      <p className="hm-note">Chance = share of similar past moments whose path traded that far away in time. Makers P&amp;L = what a move there does to the tracked makers&apos; open profit, from their net position.</p>
    </section>
  );
}

// A table cell that also carries its column name, which phones show as a label beside the value.
const Cell = ({ l, cls = "", children }: { l: string; cls?: string; children: React.ReactNode }) => (
  <span className={`r ${cls}`} data-l={l}>
    <span>{children}</span>
  </span>
);

function Makers({ h }: { h: HyperRead }) {
  const m = h.mm;
  return (
    <section className="hm-card">
      <div className="h">MARKET MAKERS ON {h.coin}</div>
      <div className="hm-mm hm-mm-head">
        <span>MAKER</span><span className="r">POSITION</span><span className="r">ENTRY</span><span className="r">OPEN P&amp;L</span><span className="r">BIDS 2%</span><span className="r">ASKS 2%</span><span className="r">LEAN</span><span className="r">LATEST FILLS</span>
      </div>
      {m.makers.map((x) => {
        const q = x.quotes;
        const f = x.flow;
        return (
          <div key={x.name} className="hm-mm" title={x.note}>
            <span className="hm-mm-name"><b>{x.name}</b><i className={`hm-kind k-${x.kind}`}>{x.kind === "named" ? "NAMED" : x.kind === "protocol" ? "PROTOCOL" : "DETECTED"}</i></span>
            <Cell l="POSITION" cls={`${x.pos ? toneClass(x.pos.coins) : "faint"}`}>{x.pos ? `${x.pos.coins > 0 ? "LONG" : "SHORT"} ${fmtUsd(Math.abs(x.pos.usd))}` : "—"}</Cell>
            <Cell l="ENTRY">{x.pos ? fmtPx(x.pos.entry) : "—"}</Cell>
            <Cell l="OPEN P&L" cls={`${x.pos ? toneClass(x.pos.upnl) : ""}`}>{x.pos ? signed(x.pos.upnl) : "—"}</Cell>
            <Cell l="BIDS 2%">{q ? fmtUsd(q.bid) : "—"}</Cell>
            <Cell l="ASKS 2%">{q ? fmtUsd(q.ask) : "—"}</Cell>
            <Cell l="LEAN" cls={`${q && Math.abs(q.skew) >= 0.1 ? tone(q.skew) : "faint"}`}>{q && q.bid + q.ask > 0 ? (Math.abs(q.skew) < 0.1 ? "even" : `${q.skew > 0 ? "buy" : "sell"} ${q.skew > 0 ? "+" : ""}${q.skew.toFixed(2)}`) : "—"}</Cell>
            <Cell l="LATEST FILLS">
              {f ? (f.taker + f.maker > 0 ? <>{mins(f.minutes)} · <span className={toneClass(f.net)}>{signed(f.net)}</span>{f.taker ? <> · taker <span className={toneClass(f.takerNet)}>{signed(f.takerNet)}</span></> : null}</> : <span className="faint">none in {mins(f.minutes)}</span>) : <span className="faint">not read</span>}
            </Cell>
          </div>
        );
      })}
      <div className="hm-mm hm-mm-total">
        <span><b>NET OF TRACKED</b></span>
        <Cell l="POSITION" cls={`${toneClass(m.net.coins)}`}>{m.net.coins ? `${m.net.coins > 0 ? "LONG" : "SHORT"} ${fmtUsd(Math.abs(m.net.usd))}` : "—"}</Cell>
        <span /><span />
        <Cell l="BIDS 2%">{fmtUsd(m.quotes.bid)}</Cell>
        <Cell l="ASKS 2%">{fmtUsd(m.quotes.ask)}</Cell>
        <Cell l="LEAN" cls={`${Math.abs(m.parts.quote) >= 0.1 ? tone(m.parts.quote) : "faint"}`}>{m.parts.quote >= 0 ? "+" : ""}{m.parts.quote.toFixed(2)}</Cell>
        <Cell l="LATEST FILLS">{m.flow.minutes ? <>taker <span className={toneClass(m.flow.takerNet)}>{signed(m.flow.takerNet)}</span> · passive <span className={toneClass(m.flow.makerNet)}>{signed(m.flow.makerNet)}</span></> : "—"}</Cell>
      </div>
      <p className="hm-note">Latest fills are each account&apos;s most recent 2,000, which for a busy maker covers minutes and for a quiet one hours. Hover or tap a row for why it is tracked.</p>
    </section>
  );
}

function Book({ h }: { h: HyperRead }) {
  const b = h.book;
  return (
    <section className="hm-card hm-book">
      <div className="h">HYPERLIQUID BOOK</div>
      <div className="hm-book-row">
        <div><i>BIDS 1%</i><b>{fmtUsd(b.bid1)}</b></div>
        <div><i>ASKS 1%</i><b>{fmtUsd(b.ask1)}</b></div>
        <div><i>BIDS 2%</i><b>{fmtUsd(b.bid2)}</b></div>
        <div><i>ASKS 2%</i><b>{fmtUsd(b.ask2)}</b></div>
        <div><i>SPREAD</i><b>{b.spread.toFixed(1)} bp</b></div>
        <div><i>MICROPRICE</i><b className={Math.abs(b.micro) >= 0.5 ? toneClass(b.micro) : ""}>{b.micro >= 0 ? "+" : ""}{b.micro.toFixed(1)} bp</b></div>
        <div><i>MAKERS OF BIDS</i><b>{pct(b.share.bid)}</b></div>
        <div><i>MAKERS OF ASKS</i><b>{pct(b.share.ask)}</b></div>
      </div>
    </section>
  );
}

function HowTo() {
  return (
    <details className="hm-card hm-how">
      <summary className="h">HOW HYPERMODE WORKS · LIMITS</summary>
      <p><b>Who is tracked.</b> Wintermute from the address you gave, Hyperliquid&apos;s own HLP vault, and accounts detected as market makers: at least 80% of their 14-day volume added liquidity, at least $500M of it, and they quote both sides in five or more markets. The detected list is refreshed with scripts/mm-discover.ts.</p>
      <p><b>Maker pressure.</b> Half comes from quote skew: whether the makers&apos; resting size within 2% is bigger and closer on the bid or the ask, which is how a maker shows the side it wants. 35% comes from aggressive flow, when makers pay the spread. 15% comes from passive flow, counted against: makers who get filled buying usually unload into the next bounce, and the takers who sold to them are often better informed. +15 or more leans up, −15 or less leans down.</p>
      <p><b>The verdict.</b> Makers carry two votes, the 1H and 4H trends one each, and the analog odds one when they reach 55%. Two net votes make a direction; anything less is a range.</p>
      <p><b>Ranges and odds.</b> The analog engine finds the past moments most like now on this coin and follows what price did next. Typical reach is what half of them got to; wide is what only one in five went beyond. Level odds are the share of those paths that traded that far. Ranges are anchored to the live Hyperliquid mid.</p>
      <p><b>Limits.</b> Makers hedge across venues, so a big perp position here is usually one leg of a hedge. Hyperliquid only serves each account&apos;s latest fills, so the maker read cannot be replayed for a track record; the analog part shows its replay. Walls can be pulled in a millisecond. Open interest, funding, liquidations and long/short ratios are not used.</p>
    </details>
  );
}
