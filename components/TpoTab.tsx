"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { composite, defaultStep, LETTERS, nakedPocs, openVsValue, sessions, SHAPE_NOTE, type Session, type TpoBar } from "@/lib/tpo.ts";
import { fmtPx } from "@/lib/format.ts";
import { useJson } from "./use-json.ts";

type Resp = { venue: string; bars: TpoBar[] };
type Naked = { start: number; poc: number };

const ROW_H = 12;
const AXIS_W = 64;
const HEAD_H = 22;
const PAD_ROWS = 2;
const COL_MIN = 150;
const ONE_COL_BELOW = 380; // phones get one day at a time, with arrows
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const C = { amber: "#f5a623", blue: "#5b9cf6", up: "#2bbf85", down: "#e5534b", text: "#9a9a9a", dim: "#808080", faint: "#555", line: "#161616" };

const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" }).toUpperCase();
const pct = (a: number, b: number) => `${a >= b ? "+" : ""}${((a / b - 1) * 100).toFixed(1)}%`;

function draw(cv: HTMLCanvasElement, W: number, shown: Session[], focus: Session, naked: Naked[], px: number) {
  const step = shown[0].step;
  const kOf = (x: number) => Math.floor(x / step + 1e-9);
  const kHi = Math.max(...shown.map((s) => s.rows[s.rows.length - 1].k), kOf(px)) + PAD_ROWS;
  const kLo = Math.min(...shown.map((s) => s.rows[0].k), kOf(px)) - PAD_ROWS;
  const H = HEAD_H + (kHi - kLo + 1) * ROW_H + 8;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const c = cv.getContext("2d")!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const plot = W - AXIS_W;
  const colW = plot / shown.length;
  const top = (k: number) => HEAD_H + (kHi - k) * ROW_H;
  const yPx = (p: number) => HEAD_H + (kHi + 1 - p / step) * ROW_H;
  const longest = Math.max(1, ...shown.flatMap((s) => s.rows.map((r) => r.letters.length)));
  const cw = Math.max(3, Math.min(9, (colW - 22) / longest));
  const letters = cw >= 7;
  c.textBaseline = "middle";

  // Price grid and axis, one label every five rows.
  c.font = `10px ${MONO}`;
  c.textAlign = "left";
  for (let k = kLo; k <= kHi; k++) {
    if (k % 5) continue;
    const y = top(k) + ROW_H;
    c.fillStyle = C.line;
    c.fillRect(0, y, plot, 1);
    c.fillStyle = C.faint;
    c.fillText(fmtPx(k * step), plot + 6, y);
  }

  shown.forEach((s, j) => {
    const x0 = j * colW;
    const isFocus = s === focus;
    if (j) {
      c.fillStyle = "#1e1e1e";
      c.fillRect(x0, 0, 1, H);
    }
    c.font = `10px ${MONO}`;
    c.textAlign = "left";
    c.fillStyle = isFocus ? C.amber : C.dim;
    c.fillText(`${day(s.start)}${s.live ? " · LIVE" : ""}`, x0 + 8, 11);
    c.textAlign = "right";
    c.fillStyle = C.faint;
    c.fillText(s.shape, x0 + colW - 6, 11);
    if (isFocus) {
      c.fillStyle = "rgba(245,166,35,0.04)";
      c.fillRect(x0 + 1, HEAD_H, colW - 1, H - HEAD_H);
    }
    // Value area, then the POC row on top of it.
    c.fillStyle = "rgba(91,156,246,0.09)";
    c.fillRect(x0 + 2, top(s.vahK), colW - 4, (s.vahK - s.valK + 1) * ROW_H);
    c.fillStyle = "rgba(245,166,35,0.2)";
    c.fillRect(x0 + 2, top(s.pocK), colW - 4, ROW_H);
    // Initial balance as an amber bar down the left edge.
    if (s.ib) {
      c.fillStyle = "rgba(245,166,35,0.75)";
      c.fillRect(x0 + 5, top(kOf(s.ib.hi)), 2, (kOf(s.ib.hi) - kOf(s.ib.lo) + 1) * ROW_H);
    }
    // The session open, as a small notch.
    const yo = top(kOf(s.open)) + ROW_H / 2;
    c.fillStyle = "#e8e8e8";
    c.beginPath();
    c.moveTo(x0 + 9, yo - 3);
    c.lineTo(x0 + 13, yo);
    c.lineTo(x0 + 9, yo + 3);
    c.fill();
    const inRange = (k: number, r: { lo: number; hi: number } | null) => !!r && k >= kOf(r.lo) && k < kOf(r.hi);
    c.font = `${isFocus ? 600 : 400} 10px ${MONO}`;
    c.textAlign = "left";
    for (const r of s.rows) {
      const y = top(r.k);
      const single = s.singles.some((g) => inRange(r.k, g));
      const color = inRange(r.k, s.tailHigh) ? C.down : inRange(r.k, s.tailLow) ? C.up : single ? C.blue : C.text;
      r.letters.forEach((p, i) => {
        const x = x0 + 16 + i * cw;
        c.fillStyle = s.live && p === s.periods - 1 ? "#fff" : p < 2 ? C.amber : color;
        if (letters) c.fillText(LETTERS[p], x, y + ROW_H / 2);
        else c.fillRect(x, y + 2, cw - 1, ROW_H - 4);
      });
    }
  });

  // Untested POCs run right until price trades back through them.
  c.setLineDash([4, 4]);
  c.lineWidth = 1;
  for (const n of naked) {
    const k = kOf(n.poc);
    if (k < kLo || k > kHi) continue;
    const idx = shown.findIndex((s) => s.start === n.start);
    const from = idx >= 0 ? (idx + 1) * colW : 0;
    const y = top(k) + ROW_H / 2;
    c.strokeStyle = "rgba(245,166,35,0.6)";
    c.beginPath();
    c.moveTo(from, y);
    c.lineTo(plot, y);
    c.stroke();
  }
  // Live price.
  const yp = yPx(px);
  c.strokeStyle = "rgba(255,255,255,0.7)";
  c.beginPath();
  c.moveTo(0, yp);
  c.lineTo(plot, yp);
  c.stroke();
  c.setLineDash([]);

  // Axis tags for the focused session's levels, the untested POCs and price.
  const tag = (p: number, text: string, bg: string, fg: string) => {
    const y = Math.max(HEAD_H + 6, Math.min(H - 8, yPx(p)));
    c.font = `600 10px ${MONO}`;
    c.fillStyle = bg;
    c.fillRect(plot + 1, y - 7, AXIS_W - 2, 14);
    c.fillStyle = fg;
    c.textAlign = "left";
    c.fillText(text, plot + 4, y);
  };
  for (const n of naked) if (kOf(n.poc) >= kLo && kOf(n.poc) <= kHi) tag(n.poc, `n ${fmtPx(n.poc)}`, "#2a1f0a", C.amber);
  tag(focus.vah, `H ${fmtPx(focus.vah)}`, "#0d1a2e", C.blue);
  tag(focus.val, `L ${fmtPx(focus.val)}`, "#0d1a2e", C.blue);
  tag(focus.poc, fmtPx(focus.poc), C.amber, "#000");
  tag(px, fmtPx(px), "#e8e8e8", "#000");
  return { colW, rowY: yPx(px) };
}

type Level = { label: string; price: number; tone: "poc" | "va" | "comp" | "naked" | "prev" };

// Plain-English reading of a session, written for someone glancing at it mid-trade.
function readOf(s: Session, prev: Session | undefined, comp: ReturnType<typeof composite>, naked: Naked[], px: number) {
  const out: string[] = [];
  const ref = s.live ? px : s.close;
  const value = `${fmtPx(s.val)}–${fmtPx(s.vah)}`;
  const where = ref > s.vah ? `above value (${value})` : ref < s.val ? `below value (${value})` : `inside value (${value})`;
  out.push(s.live ? `Price ${fmtPx(px)} is ${where}, ${pct(px, s.poc)} from the POC at ${fmtPx(s.poc)}.` : `It closed ${where} at ${fmtPx(s.close)}.`);
  if (prev) {
    const before = s.live ? "yesterday's" : "the day before's";
    const mid = (s.vah + s.val) / 2;
    const pm = (prev.vah + prev.val) / 2;
    out.push(
      s.val > prev.vah
        ? `Value moved fully above ${before}. Buyers are in control.`
        : s.vah < prev.val
          ? `Value moved fully below ${before}. Sellers are in control.`
          : mid > pm * 1.002
            ? `Value overlaps ${before} but is building higher.`
            : mid < pm * 0.998
              ? `Value overlaps ${before} but is building lower.`
              : `Value sits where it was ${s.live ? "yesterday" : "the day before"}. The market is balanced.`,
    );
  }
  const ext = {
    up: "Price broke above the first hour's range, so buyers started the move.",
    down: "Price broke below the first hour's range, so sellers started the move.",
    both: "Price broke the first hour's range both ways, so neither side is in control.",
    none: "Price is still inside the first hour's range.",
  };
  out.push(ext[s.ext]);
  const range = (r: { lo: number; hi: number }) => `${fmtPx(r.lo)}–${fmtPx(r.hi)}`;
  if (s.tailLow) out.push(`Buyers rejected ${range(s.tailLow)} sharply, so that low is defended.`);
  if (s.tailHigh) out.push(`Sellers rejected ${range(s.tailHigh)} sharply, so that high is defended.`);
  if (s.poorHigh) out.push("The high is flat, an unfinished auction that often gets retested.");
  if (s.poorLow) out.push("The low is flat, an unfinished auction that often gets retested.");
  if (s.live) {
    const others = [prev?.vah, prev?.poc, prev?.val, comp?.vah, comp?.poc, comp?.val, ...naked.map((n) => n.poc)].filter((x): x is number => !!x);
    const up = others.filter((x) => x > s.vah * 1.001).sort((x, y) => x - y)[0];
    const dn = others.filter((x) => x < s.val * 0.999).sort((x, y) => y - x)[0];
    if (ref > s.vah) out.push(`If price holds above ${fmtPx(s.vah)} for an hour, value is moving up${up ? `, next ${fmtPx(up)}` : ""}. Back inside value points to the POC at ${fmtPx(s.poc)}.`);
    else if (ref < s.val) out.push(`If price holds below ${fmtPx(s.val)} for an hour, value is moving down${dn ? `, next ${fmtPx(dn)}` : ""}. Back inside value points to the POC at ${fmtPx(s.poc)}.`);
    else out.push(`Watch the edges. An hour above ${fmtPx(s.vah)} means price is accepted higher${up ? `, next ${fmtPx(up)}` : ""}. An hour below ${fmtPx(s.val)} means lower${dn ? `, next ${fmtPx(dn)}` : ""}.`);
  }
  return out;
}

function Stats({ s, prev, comp, naked, px, venue }: { s: Session; prev?: Session; comp: ReturnType<typeof composite>; naked: Naked[]; px: number; venue: string }) {
  const tag = s.live ? "Today" : day(s.start).slice(0, 3);
  const levels: Level[] = [
    { label: `${tag} value high`, price: s.vah, tone: "va" as const },
    { label: `${tag} POC`, price: s.poc, tone: "poc" as const },
    { label: `${tag} value low`, price: s.val, tone: "va" as const },
    ...(prev ? [{ label: "Prior day POC", price: prev.poc, tone: "prev" as const }] : []),
    ...(comp
      ? [
          { label: "5-day value high", price: comp.vah, tone: "comp" as const },
          { label: "5-day POC", price: comp.poc, tone: "comp" as const },
          { label: "5-day value low", price: comp.val, tone: "comp" as const },
        ]
      : []),
    ...naked.filter((n) => Math.abs(n.poc / px - 1) <= 0.12).map((n) => ({ label: `Untested POC ${day(n.start).slice(4)}`, price: n.poc, tone: "naked" as const })),
  ].sort((x, y) => y.price - x.price);
  const at = levels.findIndex((l) => l.price < px);
  const ladder: (Level | null)[] = [...levels];
  ladder.splice(at < 0 ? levels.length : at, 0, null); // null marks where price sits
  const range = (r: { lo: number; hi: number }) => `${fmtPx(r.lo)}–${fmtPx(r.hi)}`;
  const ov = openVsValue(s, prev);
  const details: [string, string][] = [
    ["Shape", `${s.shape}: ${SHAPE_NOTE[s.shape]}`],
    ["Opened", ov ? `${ov} the prior day's value` : "—"],
    ["First hour range", s.ib ? `${range(s.ib)} (${((s.ib.hi / s.ib.lo - 1) * 100).toFixed(1)}%)` : "—"],
    ["Single prints", s.singles.length ? s.singles.map(range).join(", ") : "None"],
    ["Tails", [s.tailHigh && `selling ${range(s.tailHigh)}`, s.tailLow && `buying ${range(s.tailLow)}`].filter(Boolean).join(", ") || "None"],
    ["Flat high or low", [s.poorHigh && "high", s.poorLow && "low"].filter(Boolean).join(", ") || "None"],
  ];
  return (
    <>
      <div className="h">WHAT IT SAYS<span>{day(s.start)}{s.live ? ` · live, ${s.periods} of 48 periods` : ""}</span></div>
      <ul className="tpo-read">{readOf(s, prev, comp, naked, px).map((l) => <li key={l}>{l}</li>)}</ul>
      <div className="h">KEY LEVELS<span>highest first, with distance from price</span></div>
      <div className="lv">
        {ladder.map((l) =>
          l ? (
            <div key={`${l.label}${l.price}`} className="lv-row" data-tone={l.tone}>
              <span>{l.label}</span>
              <span className="r">{fmtPx(l.price)}</span>
              <span className="r dim">{pct(l.price, px)}</span>
            </div>
          ) : (
            <div key="now" className="lv-row lv-now">
              <span>Price now</span>
              <span className="r">{fmtPx(px)}</span>
              <span />
            </div>
          ),
        )}
      </div>
      <div className="h">DETAILS</div>
      <table className="stat tpo-details"><tbody>{details.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
      <div className="note">Each block or letter is 30 minutes of the UTC day, A at 00:00. Long rows are prices the market accepted, and short rows were rejected. Tap a day to read it. Data: {venue} perps.</div>
    </>
  );
}

const Legend = () => (
  <div className="tpo-legend">
    <span><i className="amber">■</i>POC, most time</span>
    <span><i style={{ color: "var(--blue)" }}>■</i>value area, 70% of time</span>
    <span><i className="amber">▌</i>first hour</span>
    <span><i>▸</i>open</span>
    <span><i style={{ color: "#fff" }}>■</i>now</span>
    <span><i style={{ color: "var(--blue)" }}>A</i>single prints</span>
    <span><i className="up">■</i><i className="down">■</i>tails</span>
    <span><i className="amber">┊</i>untested POC</span>
  </div>
);

export default function TpoTab({ sym, price }: { sym: string; price: number }) {
  const { data, err } = useJson<Resp>(`/api/tpo?sym=${sym}&days=12`, 60000);
  const scroller = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const geom = useRef({ colW: 1 });
  const centred = useRef("");
  const [width, setWidth] = useState(0);
  const [back, setBack] = useState(0);
  const [pick, setPick] = useState<number | null>(null);

  // The scroller only exists once data has arrived, so attach the size watcher then.
  const ready = !!data;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
  useEffect(() => {
    setBack(0);
    setPick(null);
  }, [sym]);

  const model = useMemo(() => {
    if (!data?.bars?.length) return null;
    const list = sessions(data.bars, defaultStep(data.bars));
    return { list, naked: nakedPocs(list, data.bars), comp: composite(list.filter((s) => !s.live).slice(-5)) };
  }, [data]);
  const list = model?.list ?? [];
  const cols = width < ONE_COL_BELOW ? 1 : Math.max(2, Math.min(7, Math.floor((width - AXIS_W) / COL_MIN)));
  const maxBack = Math.max(0, list.length - cols);
  const b = Math.min(back, maxBack);
  const shown = list.slice(Math.max(0, list.length - cols - b), list.length - b);
  const focus = shown.find((s) => s.start === pick) ?? shown[shown.length - 1];
  const px = price || list[list.length - 1]?.close || 0;

  useEffect(() => {
    if (!cv.current || !focus || !width || !model) return;
    const g = draw(cv.current, width, shown, focus, model.naked, px);
    geom.current = g;
    // Bring price into view the first time a coin is drawn.
    const el = scroller.current;
    if (el && centred.current !== sym) {
      centred.current = sym;
      el.scrollTop = Math.max(0, g.rowY - el.clientHeight / 2);
    }
  });

  if (!data) return <div className="note">{err ? "TPO feed unavailable. Retrying." : "Loading…"}</div>;
  if (!focus || !model) return <div className="note">No 30-minute history for {sym}.</div>;
  return (
    <div className="tpo">
      <div className="tpo-main">
        <div className="chart-bar tpo-bar">
          <button disabled={b >= maxBack} onClick={() => setBack(b + 1)} aria-label="Older session">◀</button>
          <span className="dim">{shown.length > 1 ? `${day(shown[0].start)} – ${day(shown[shown.length - 1].start)}` : day(focus.start)}</span>
          <button disabled={b === 0} onClick={() => setBack(b - 1)} aria-label="Newer session">▶</button>
          {b > 0 && <button onClick={() => setBack(0)}>LATEST</button>}
          <span className="faint tpo-row">ROW {+focus.step.toPrecision(3)}</span>
        </div>
        <Legend />
        <div className="tpo-scroll" ref={scroller}>
          <canvas
            ref={cv}
            role="img"
            aria-label={`Market profile for ${sym}`}
            onClick={(e) => {
              const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
              const s = shown[Math.floor(x / geom.current.colW)];
              if (s) setPick(s.start);
            }}
          />
        </div>
      </div>
      <div className="tpo-side">
        <Stats s={focus} prev={list[list.indexOf(focus) - 1]} comp={model.comp} naked={model.naked} px={px} venue={data.venue} />
      </div>
    </div>
  );
}
