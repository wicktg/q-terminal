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

function Stats({ s, prev, comp, naked, px, venue }: { s: Session; prev?: Session; comp: ReturnType<typeof composite>; naked: Naked[]; px: number; venue: string }) {
  const ref = s.live ? px : s.close;
  const where = ref > s.vah ? "above value" : ref < s.val ? "below value" : "inside value";
  const ov = openVsValue(s, prev);
  const ext = { up: "Up only", down: "Down only", both: "Both ways", none: "None yet" }[s.ext];
  const range = (r: { lo: number; hi: number }) => `${fmtPx(r.lo)}–${fmtPx(r.hi)}`;
  const near = [...naked].sort((a, b) => Math.abs(a.poc - px) - Math.abs(b.poc - px)).slice(0, 4);
  const rows: [string, React.ReactNode][] = [
    ["POC", <span key="p" className="amber">{fmtPx(s.poc)}</span>],
    ["Value area", <span key="v" style={{ color: "var(--blue)" }}>{fmtPx(s.val)} – {fmtPx(s.vah)}</span>],
    [s.live ? "Price" : "Close", <span key="w" className={ref > s.vah ? "up" : ref < s.val ? "down" : ""}>{fmtPx(ref)} · {where}</span>],
    ["Opened", ov ? `${ov} prior value` : "—"],
    ["Initial balance", s.ib ? `${range(s.ib)} (${((s.ib.hi / s.ib.lo - 1) * 100).toFixed(1)}%)` : "—"],
    ["Range extension", ext],
    ["Single prints", s.singles.length ? s.singles.map(range).join(", ") : "None"],
    ["Tails", [s.tailHigh && `selling ${range(s.tailHigh)}`, s.tailLow && `buying ${range(s.tailLow)}`].filter(Boolean).join(", ") || "None"],
    ["Poor high / low", [s.poorHigh && "poor high", s.poorLow && "poor low"].filter(Boolean).join(", ") || "None"],
  ];
  return (
    <>
      <div className="h">SESSION<span>{day(s.start)}{s.live ? ` · ${s.periods} of 48 periods` : ""}</span></div>
      <table className="stat"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
      <div className="h">SHAPE<span>{s.shape}</span></div>
      <div className="note">{SHAPE_NOTE[s.shape]}{s.live ? " The session is still building, so the shape can change." : ""}</div>
      <div className="h">5-DAY VALUE</div>
      <table className="stat"><tbody>
        <tr><td>Composite POC</td><td className="amber">{comp ? fmtPx(comp.poc) : "—"}</td></tr>
        <tr><td>Composite value</td><td>{comp ? `${fmtPx(comp.val)} – ${fmtPx(comp.vah)}` : "—"}</td></tr>
      </tbody></table>
      <div className="h">UNTESTED POCS<span>price tends to revisit</span></div>
      <table className="stat"><tbody>
        {near.length ? near.map((n) => <tr key={n.start}><td>{day(n.start)}</td><td><span className="amber">{fmtPx(n.poc)}</span> <span className="dim">{pct(n.poc, px)}</span></td></tr>) : <tr><td>None</td><td /></tr>}
      </tbody></table>
      <div className="note">Each letter is a 30-minute period of the UTC day, A at 00:00. Amber A and B are the initial balance, the blue band is the value area, which holds 70% of the time, and the amber row is the POC. Blue letters are single prints, and red or green letters are tails. Dashed amber lines are POCs price has not revisited. Tap a day to read it. Data: {venue} perps.</div>
    </>
  );
}

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
          <span className="keys faint">ROW {+focus.step.toPrecision(3)} · <i className="amber">■</i> POC <i style={{ color: "var(--blue)" }}>■</i> VALUE <i className="amber">┊</i> UNTESTED POC</span>
        </div>
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
