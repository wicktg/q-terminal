"use client";
import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesPrimitive,
  type Logical,
  type SeriesAttachedParameter,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Analysis, Bar, KlinesResp, Profile } from "@/lib/types.ts";
import { avwap, cvd, delta, ema, ribbonAnchors, volumeProfile } from "@/lib/quant.ts";
import { colsFromBars } from "@/lib/mtf.ts";
import { poolsAt, walk, zonesAt } from "@/lib/structure.ts";
import { fmtPx, fmtUsd, hlBar, hlName, pxDigits, type HlCandle } from "@/lib/format.ts";
import { FlowLayer } from "./flow-layer.ts";
import ZoneCard, { type CardZone } from "./ZoneCard.tsx";
import { tpoLevels, type TpoBar } from "@/lib/tpo.ts";
import { wickTag, wickText, type WickEvent, type WickRead } from "@/lib/wicks.ts";
import type { FppRead } from "@/lib/fpp.ts";

const TFS = ["5m", "15m", "1h", "4h", "1d"] as const;
const TF_SEC: Record<(typeof TFS)[number], number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const WS_BASE = "wss://fstream.binance.com/market/ws"; // the old /ws path still connects but sends nothing
const PULSE_MS = 5000;
const TICK_PAINT_MS = 120;
const FULL_PAINT_MS = 400;
const POLL_AFTER_MS = 12e3; // no ticks for this long means the feed is the poll, not the socket
const RECONNECT_AFTER_MS = 30e3;
const VIEW_BARS = 160;
const REST_OFFSET = 8;
const HL_WS = "wss://api.hyperliquid.xyz/ws";
const HL_PING_MS = 30e3; // Hyperliquid drops sockets that stay silent for a minute
const FILL_GROUP_MS = 150; // one order arrives as many fills, across more than one message
const CVD_TAGS = [{ text: "━ CVD PERP", color: "#f5a623" }, { text: "━ CVD SPOT", color: "#5b9cf6" }, { text: "each on its own scale", color: "#555555" }];
const HL_CVD_TAGS = [...CVD_TAGS.slice(0, 2), { text: "Binance taker flow", color: "#555555" }]; // Hyperliquid publishes no taker history
const ts = (t: number) => t as UTCTimestamp;

const stored = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null; // storage may be blocked
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

type HlTrade = { side: "A" | "B"; px: string; sz: string; time: number; hash: string };
type HlLevel = { px: string; sz: string };

type DrawZone = { kind: string; side: number; t: number; top: number; bottom: number; born?: number };
type ZoneAmount = { usd: number; complete: boolean };
type DrawSwing = { t: number; price: number; high: boolean; label: string };
type DrawPool = { t: number; price: number };
type DrawWick = WickEvent & { tag: string; strong: boolean };
type Pt = { l: number; p: number }; // bar index and price
type DrawMeasure = { a: Pt; b: Pt; up: boolean; lines: string[] };
type DrawFpp = { start: number; base: number; read: FppRead };
type Draw = {
  ribbon: { t: number; a: number; b: number }[];
  wicks: DrawWick[];
  showWicks: boolean;
  measure: DrawMeasure | null;
  measureHint: string | null;
  zoneUsd: Record<string, ZoneAmount>; // resting size per zone, keyed top|bottom
  fpp: DrawFpp | null;
  zones: DrawZone[];
  gaps: DrawZone[];
  swings: DrawSwing[];
  pools: DrawPool[];
  profile: Profile | null;
  showRibbon: boolean;
  showZones: boolean;
  showFvg: boolean;
  showStruct: boolean;
  showVp: boolean;
  times: number[];
};

// Draws one band where two of the same kind mostly cover each other.
function mergeZones(rows: DrawZone[]) {
  const out: DrawZone[] = [];
  for (const z of rows) {
    const m = out.find((o) => o.kind === z.kind && o.side === z.side && Math.min(o.top, z.top) - Math.max(o.bottom, z.bottom) >= 0.5 * Math.min(o.top - o.bottom, z.top - z.bottom));
    if (!m) {
      out.push({ ...z });
      continue;
    }
    m.top = Math.max(m.top, z.top);
    m.bottom = Math.min(m.bottom, z.bottom);
    m.t = Math.min(m.t, z.t);
    if (z.born !== undefined) m.born = Math.min(m.born ?? z.born, z.born);
  }
  return out;
}

// Structure and zones for the bars on screen, from the same engine the signals use.
function readChart(B: Bar[], tf: string) {
  const closed = B.slice(0, -1);
  if (closed.length < 40) return { zones: [], gaps: [], swings: [], pools: [] };
  const w = walk(colsFromBars(closed), tf === "1d" ? 3 : 5);
  const i = closed.length - 1;
  const px = closed[i].c;
  const live = zonesAt(w, i)
    .sort((a, b) => Math.abs((a.top + a.bottom) / 2 - px) - Math.abs((b.top + b.bottom) / 2 - px))
    .map((z) => ({ kind: z.kind, side: z.side, t: closed[z.origin].t, top: z.top, bottom: z.bottom, born: closed[z.born].t + (TF_SEC[tf as (typeof TFS)[number]] ?? 3600) }));
  const zones = mergeZones(live.filter((z) => z.kind !== "FVG")).slice(0, 8);
  const gaps = mergeZones(live.filter((z) => z.kind === "FVG")).slice(0, 6);
  const swings = w.swings.slice(-24).map((s) => ({ t: closed[s.i].t, price: s.price, high: s.high, label: s.label }));
  const pools = poolsAt(w, i).slice(-8).map((p) => ({ t: closed[p.born].t, price: p.price }));
  return { zones, gaps, swings, pools };
}

// Draws what lightweight-charts has no series for: ribbon fill, order blocks, volume profile.
class Overlay implements ISeriesPrimitive<Time> {
  d: Draw = { ribbon: [], wicks: [], showWicks: false, measure: null, measureHint: null, zoneUsd: {}, fpp: null, zones: [], gaps: [], swings: [], pools: [], profile: null, showRibbon: false, showZones: true, showFvg: true, showStruct: true, showVp: false, times: [] };
  private p: SeriesAttachedParameter<Time> | null = null;
  attached(p: SeriesAttachedParameter<Time>) {
    this.p = p;
  }
  detached() {
    this.p = null;
  }
  update(d: Partial<Draw>) {
    this.d = { ...this.d, ...d };
    this.p?.requestUpdate();
  }
  updateAllViews() {}
  paneViews() {
    return [
      { zOrder: () => "bottom" as const, renderer: () => ({ draw: (t: never) => this.draw(t) }) },
      { zOrder: () => "top" as const, renderer: () => ({ draw: (t: never) => this.drawWickMarks(t) }) },
      { zOrder: () => "top" as const, renderer: () => ({ draw: (t: never) => this.drawMeasure(t) }) },
      { zOrder: () => "top" as const, renderer: () => ({ draw: (t: never) => this.drawFpp(t) }) },
    ];
  }
  // FPP: the projected path as white candles to the right of the live candle, over a faint band of likely outcomes.
  private drawFpp(target: { useBitmapCoordinateSpace: (f: (s: { context: CanvasRenderingContext2D; horizontalPixelRatio: number; verticalPixelRatio: number; bitmapSize: { width: number; height: number } }) => void) => void }) {
    const p = this.p;
    const f = this.d.fpp;
    if (!p || !f) return;
    const ts_ = p.chart.timeScale();
    const r = f.read;
    const price = (v: number) => f.base * Math.exp(v * r.atrPct);
    const X = (k: number) => ts_.logicalToCoordinate((f.start + k) as Logical);
    const Y = (v: number) => p.series.priceToCoordinate(price(v));
    target.useBitmapCoordinateSpace(({ context: c, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
      const x0 = X(-1);
      const y0 = Y(0);
      if (x0 === null || y0 === null) return;
      // Band: where the middle half of similar past moments ended up at each step.
      const top: [number, number][] = [[x0 * hr, y0 * vr]];
      const bot: [number, number][] = [[x0 * hr, y0 * vr]];
      for (let k = 0; k < r.horizon; k++) {
        const x = X(k);
        const a = Y(r.q75[k]);
        const b = Y(r.q25[k]);
        if (x === null || a === null || b === null) continue;
        top.push([x * hr, a * vr]);
        bot.push([x * hr, b * vr]);
      }
      if (top.length > 1) {
        c.beginPath();
        top.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        [...bot].reverse().forEach(([x, y]) => c.lineTo(x, y));
        c.closePath();
        c.fillStyle = "rgba(255,255,255,0.06)";
        c.fill();
      }
      // Candles: hollow when the projected candle closes up, solid when it closes down.
      const space = ts_.options().barSpacing * hr;
      const bw = Math.max(1, Math.min(space * 0.7, 14 * hr));
      for (let k = 0; k < r.candles.length; k++) {
        const x = X(k);
        const q = r.candles[k];
        const [yo, yh, yl, yc] = [Y(q.o), Y(q.h), Y(q.l), Y(q.c)];
        if (x === null || yo === null || yh === null || yl === null || yc === null) continue;
        const cx = x * hr;
        c.fillStyle = "rgba(255,255,255,0.8)";
        c.fillRect(cx - 0.5 * hr, yh * vr, hr, Math.max(1, (yl - yh) * vr));
        const t = Math.min(yo, yc) * vr;
        const h = Math.max(1, Math.abs(yc - yo) * vr);
        if (q.c >= q.o) {
          c.fillStyle = "#000";
          c.fillRect(cx - bw / 2, t, bw, h);
          c.strokeStyle = "rgba(255,255,255,0.9)";
          c.lineWidth = hr;
          c.strokeRect(cx - bw / 2 + 0.5 * hr, t + 0.5 * vr, bw - hr, Math.max(1, h - vr));
        } else {
          c.fillStyle = "rgba(255,255,255,0.85)";
          c.fillRect(cx - bw / 2, t, bw, h);
        }
      }
      // Label at the end of the path: direction, odds, median move, and whether it has shown an edge here.
      const xe = X(r.horizon - 1);
      const ye = Y(r.median[r.horizon - 1]);
      if (xe === null || ye === null) return;
      const move = (Math.exp(r.median[r.horizon - 1] * r.atrPct) - 1) * 100;
      const lines = [`FPP ${r.dir > 0 ? "▲" : "▼"} ${Math.round(r.prob * 100)}%  ${move >= 0 ? "+" : ""}${move.toFixed(2)}%`, r.test.edge ? `edge in replay ${Math.round(r.test.hit * 100)}%` : `no proven edge here`];
      c.font = `600 ${11 * vr}px monospace`;
      c.textBaseline = "middle";
      const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 14 * hr;
      const lh = 15 * vr;
      const hh = lines.length * lh + 6 * vr;
      const lx = Math.min(Math.max(2 * hr, xe * hr - w / 2), bitmapSize.width - w - 2 * hr);
      const ly = r.dir > 0 ? Math.max(2 * vr, ye * vr - hh - 14 * vr) : Math.min(bitmapSize.height - hh - 2 * vr, ye * vr + 14 * vr);
      c.fillStyle = "rgba(255,255,255,0.95)";
      c.fillRect(lx, ly, w, hh);
      lines.forEach((l, i) => {
        c.fillStyle = i === 0 ? "#000" : "#555";
        c.fillText(l, lx + 7 * hr, ly + 3 * vr + lh * i + lh / 2);
      });
      c.textBaseline = "alphabetic";
    });
  }
  // The ruler: a box from start to end with the move in price, percent, bars and time.
  private drawMeasure(target: { useBitmapCoordinateSpace: (f: (s: { context: CanvasRenderingContext2D; horizontalPixelRatio: number; verticalPixelRatio: number; bitmapSize: { width: number; height: number } }) => void) => void }) {
    const p = this.p;
    const m = this.d.measure;
    const hint = this.d.measureHint;
    if (!p || (!m && !hint)) return;
    target.useBitmapCoordinateSpace(({ context: c, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
      const W = bitmapSize.width;
      c.font = `600 ${11 * vr}px monospace`;
      c.textBaseline = "middle";
      if (hint) {
        const w = c.measureText(hint).width + 16 * hr;
        c.fillStyle = "rgba(245,166,35,0.95)";
        const hy = bitmapSize.height - 30 * vr; // bottom of the price pane, clear of the price readout on phones
        c.fillRect((W - w) / 2, hy, w, 18 * vr);
        c.fillStyle = "#000";
        c.fillText(hint, (W - w) / 2 + 8 * hr, hy + 9 * vr);
      }
      if (!m) return;
      const ts_ = p.chart.timeScale();
      const xa = ts_.logicalToCoordinate(m.a.l as Logical);
      const xb = ts_.logicalToCoordinate(m.b.l as Logical);
      const ya = p.series.priceToCoordinate(m.a.p);
      const yb = p.series.priceToCoordinate(m.b.p);
      if (xa === null || xb === null || ya === null || yb === null) return;
      const rgb = m.up ? "43,191,133" : "229,83,75";
      const [X0, X1, Y0, Y1] = [xa * hr, xb * hr, ya * vr, yb * vr];
      c.fillStyle = `rgba(${rgb},0.13)`;
      c.fillRect(Math.min(X0, X1), Math.min(Y0, Y1), Math.abs(X1 - X0), Math.abs(Y1 - Y0));
      c.strokeStyle = `rgba(${rgb},0.85)`;
      c.lineWidth = hr;
      c.strokeRect(Math.min(X0, X1), Math.min(Y0, Y1), Math.abs(X1 - X0), Math.abs(Y1 - Y0));
      // Arrow from start to end.
      c.lineWidth = 1.5 * hr;
      c.beginPath();
      c.moveTo(X0, Y0);
      c.lineTo(X1, Y1);
      c.stroke();
      const ang = Math.atan2(Y1 - Y0, X1 - X0);
      const head = 8 * hr;
      c.fillStyle = `rgb(${rgb})`;
      c.beginPath();
      c.moveTo(X1, Y1);
      c.lineTo(X1 - head * Math.cos(ang - 0.45), Y1 - head * Math.sin(ang - 0.45));
      c.lineTo(X1 - head * Math.cos(ang + 0.45), Y1 - head * Math.sin(ang + 0.45));
      c.fill();
      // Readout chip past the end of the move, kept inside the pane.
      const lh = 15 * vr;
      const w = Math.max(...m.lines.map((t) => c.measureText(t).width)) + 14 * hr;
      const h = m.lines.length * lh + 6 * vr;
      const cx = Math.min(Math.max(2 * hr, (X0 + X1) / 2 - w / 2), W - w - 2 * hr);
      const top = Math.min(Y0, Y1);
      const bottom = Math.max(Y0, Y1);
      const cy = m.up ? (top - h - 6 * vr > 0 ? top - h - 6 * vr : bottom + 6 * vr) : bottom + h + 6 * vr < bitmapSize.height ? bottom + 6 * vr : top - h - 6 * vr;
      c.fillStyle = "rgba(0,0,0,0.92)";
      c.fillRect(cx, cy, w, h);
      c.strokeStyle = `rgba(${rgb},0.9)`;
      c.lineWidth = hr;
      c.strokeRect(cx + 0.5 * hr, cy + 0.5 * vr, w - hr, h - vr);
      m.lines.forEach((t, i) => {
        c.fillStyle = i === 0 ? `rgb(${rgb})` : "#d9d9d9";
        c.fillText(t, cx + 7 * hr, cy + 3 * vr + lh * i + lh / 2);
      });
      c.textBaseline = "alphabetic";
    });
  }
  // Wick dots, sweep levels and labels sit above the candles so nothing covers them.
  private drawWickMarks(target: { useBitmapCoordinateSpace: (f: (s: { context: CanvasRenderingContext2D; horizontalPixelRatio: number; verticalPixelRatio: number; bitmapSize: { width: number; height: number } }) => void) => void }) {
    const p = this.p;
    if (!p || !this.d.showWicks || !this.d.wicks.length) return;
    const { chart, series } = p;
    const ts_ = chart.timeScale();
    const y = (v: number) => series.priceToCoordinate(v);
    const x = (t: number) => {
      const first = this.d.times.find((v) => v >= t);
      return first === undefined ? null : (ts_.timeToCoordinate(ts(first)) as number | null);
    };
    target.useBitmapCoordinateSpace(({ context: c, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
      const tags: { text: string; rgb: string; X: number; Y: number; up: boolean }[] = [];
      for (const k of this.d.wicks) {
        const xc = x(k.t);
        const yt = y(k.tip);
        if (xc === null || yt === null) continue;
        const up = k.side === "upper";
        const rgb = up ? "229,83,75" : "43,191,133";
        const X = xc * hr;
        // A sweep draws the level it took, faint, from where the level formed up to the wick.
        if (k.sweep) {
          const yl = y(k.sweep.level);
          const x0 = x(k.sweep.from);
          if (yl !== null) {
            c.strokeStyle = "rgba(245,166,35,0.55)";
            c.lineWidth = hr;
            c.setLineDash([4 * hr, 4 * hr]);
            c.beginPath();
            c.moveTo((x0 ?? xc - 40) * hr, yl * vr);
            c.lineTo(X, yl * vr);
            c.stroke();
            c.setLineDash([]);
          }
        }
        // A dot just past the tip: solid when the flow shows who drove the wick, hollow when thin or two-way.
        const dotY = (yt + (up ? -6 : 6)) * vr;
        const r = (k.strong ? 3.5 : 2.5) * hr;
        c.beginPath();
        c.arc(X, dotY, r, 0, Math.PI * 2);
        c.fillStyle = "#000";
        c.fill();
        if (k.kind === "trapped" || k.kind === "rejected") {
          c.fillStyle = `rgb(${rgb})`;
          c.fill();
        } else {
          c.strokeStyle = `rgb(${rgb})`;
          c.lineWidth = 1.5 * hr;
          c.stroke();
        }
        if (k.strong && k.tag) tags.push({ text: k.tag, rgb, X, Y: dotY + (up ? -r - 6 * vr : r + 6 * vr), up });
      }
      // Labels: solid chips past the dot, stepped away from each other so none overlap.
      c.font = `600 ${11 * vr}px monospace`;
      const H = 16 * vr;
      const placed: { x: number; y: number; w: number }[] = [];
      for (const t of tags) {
        const w = c.measureText(t.text).width + 12 * hr;
        let lx = Math.min(Math.max(2 * hr, t.X - w / 2), bitmapSize.width - w - 2 * hr);
        let ly = t.up ? t.Y - H : t.Y;
        for (let n = 0; n < 8 && placed.some((q) => lx < q.x + q.w && lx + w > q.x && Math.abs(q.y - ly) < H + 2 * vr); n++) ly += t.up ? -(H + 2 * vr) : H + 2 * vr;
        placed.push({ x: lx, y: ly, w });
        // A short leader from the chip to the dot.
        c.strokeStyle = `rgba(${t.rgb},0.7)`;
        c.lineWidth = hr;
        c.beginPath();
        c.moveTo(t.X, t.up ? ly + H : ly);
        c.lineTo(t.X, t.Y);
        c.stroke();
        c.fillStyle = "rgba(0,0,0,0.92)";
        c.fillRect(lx, ly, w, H);
        c.strokeStyle = `rgba(${t.rgb},0.9)`;
        c.strokeRect(lx + 0.5 * hr, ly + 0.5 * vr, w - hr, H - vr);
        c.fillStyle = `rgb(${t.rgb})`;
        c.textBaseline = "middle";
        c.fillText(t.text, lx + 6 * hr, ly + H / 2 + 0.5 * vr);
        c.textBaseline = "alphabetic";
      }
    });
  }
  private draw(target: { useBitmapCoordinateSpace: (f: (s: { context: CanvasRenderingContext2D; horizontalPixelRatio: number; verticalPixelRatio: number; bitmapSize: { width: number; height: number } }) => void) => void }) {
    const p = this.p;
    if (!p) return;
    const { chart, series } = p;
    const ts_ = chart.timeScale();
    const y = (v: number) => series.priceToCoordinate(v);
    target.useBitmapCoordinateSpace(({ context: c, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
      const W = bitmapSize.width;
      if (this.d.showRibbon && this.d.ribbon.length > 1) {
        const pts = this.d.ribbon
          .map((r) => ({ x: ts_.timeToCoordinate(ts(r.t)) as number | null, a: y(r.a) as number | null, b: y(r.b) as number | null }))
          .filter((q): q is { x: number; a: number; b: number } => q.x !== null && q.a !== null && q.b !== null);
        if (pts.length > 1) {
          c.beginPath();
          pts.forEach((q, i) => (i ? c.lineTo(q.x * hr, q.a * vr) : c.moveTo(q.x * hr, q.a * vr)));
          [...pts].reverse().forEach((q) => c.lineTo(q.x * hr, q.b * vr));
          c.closePath();
          c.fillStyle = "rgba(245,166,35,0.07)";
          c.fill();
        }
      }
      const x = (t: number) => {
        const first = this.d.times.find((v) => v >= t);
        return first === undefined ? null : (ts_.timeToCoordinate(ts(first)) as number | null);
      };
      const place = (z: DrawZone) => {
        const x0 = x(z.t);
        const top = y(z.top);
        const bot = y(z.bottom);
        if (top === null || bot === null) return null;
        const left = x0 === null ? 0 : Math.max(0, x0 * hr);
        return { left, top: top * vr, w: W - left, h: Math.max(1, (bot - top) * vr) };
      };
      const labels: { text: string; color: string; x: number; y: number }[] = [];
      c.font = `${10 * vr}px monospace`;
      c.lineWidth = hr;
      if (this.d.showFvg) {
        for (const g of this.d.gaps) {
          const r = place(g);
          if (!r) continue;
          c.fillStyle = "rgba(91,156,246,0.10)";
          c.fillRect(r.left, r.top, r.w, r.h);
          c.fillStyle = "rgba(91,156,246,0.6)";
          c.fillRect(r.left, r.top, r.w, 1);
          c.fillRect(r.left, r.top + r.h, r.w, 1);
          labels.push({ text: `FVG ${g.side > 0 ? "↑" : "↓"}`, color: "#5b9cf6", x: r.left + 4 * hr, y: r.top + 2 * vr });
        }
      }
      if (this.d.showZones) {
        // Tall bands first and order blocks last, so the tighter level stays readable on top.
        const order = [...this.d.zones].sort((a, b) => +(a.kind === "OB") - +(b.kind === "OB") || b.top - b.bottom - (a.top - a.bottom));
        for (const z of order) {
          const r = place(z);
          if (!r) continue;
          const up = z.side > 0;
          const rgb = up ? "43,191,133" : "229,83,75";
          if (z.kind === "OB") {
            c.fillStyle = `rgba(${rgb},0.2)`;
            c.fillRect(r.left, r.top, r.w, r.h);
            c.strokeStyle = `rgba(${rgb},0.9)`;
            c.strokeRect(r.left, r.top, r.w, r.h);
          } else {
            c.fillStyle = `rgba(${rgb},0.04)`;
            c.fillRect(r.left, r.top, r.w, r.h);
            c.save();
            c.beginPath();
            c.rect(r.left, r.top, r.w, r.h);
            c.clip();
            c.strokeStyle = `rgba(${rgb},0.3)`;
            c.beginPath();
            for (let q = r.left - r.h; q < W; q += 9 * hr) {
              c.moveTo(q, r.top + r.h);
              c.lineTo(q + r.h, r.top);
            }
            c.stroke();
            c.restore();
            c.strokeStyle = `rgba(${rgb},0.7)`;
            c.setLineDash([5 * hr, 4 * hr]);
            c.strokeRect(r.left, r.top, r.w, r.h);
            c.setLineDash([]);
          }
          const amt = this.d.zoneUsd[`${z.top}|${z.bottom}`];
          const name = z.kind === "OB" ? (up ? "DEMAND OB" : "SUPPLY OB") : up ? "DEMAND" : "SUPPLY";
          labels.push({ text: amt ? `${name} ${fmtUsd(amt.usd)}${amt.complete ? "" : "+"}` : name, color: up ? "#2bbf85" : "#e5534b", x: r.left + 4 * hr, y: r.top + 2 * vr });
        }
      }
      if (this.d.showWicks) {
        // The wick itself, thickened in its colour behind the candle. Markers and labels draw above candles.
        for (const k of this.d.wicks) {
          const xc = x(k.t);
          const yt = y(k.tip);
          const yb = y(k.base);
          if (xc === null || yt === null || yb === null) continue;
          c.fillStyle = `rgba(${k.side === "upper" ? "229,83,75" : "43,191,133"},${k.strong ? 0.9 : 0.55})`;
          c.fillRect(xc * hr - 1.5 * hr, Math.min(yt, yb) * vr, 3 * hr, Math.max(1, Math.abs(yb - yt) * vr));
        }
      }
      // Labels go last on dark chips and step aside from each other, so overlapping zones stay named.
      const chipH = 13 * vr;
      const placed: { x: number; y: number; w: number }[] = [];
      for (const l of labels) {
        const w = c.measureText(l.text).width + 8 * hr;
        let lx = l.x;
        for (let hit = true; hit; ) {
          const p = placed.find((q) => Math.abs(q.y - l.y) < chipH && lx < q.x + q.w && lx + w > q.x);
          hit = !!p;
          if (p) lx = p.x + p.w + 3 * hr;
        }
        placed.push({ x: lx, y: l.y, w });
        c.fillStyle = "rgba(0,0,0,0.8)";
        c.fillRect(lx, l.y, w, chipH);
        c.fillStyle = l.color;
        c.fillText(l.text, lx + 4 * hr, l.y + 10 * vr);
      }
      if (this.d.showStruct) {
        c.font = `${10 * vr}px monospace`;
        for (const p of this.d.pools) {
          const yy = y(p.price);
          const x0 = x(p.t);
          if (yy === null || x0 === null) continue;
          c.fillStyle = "rgba(128,128,128,0.5)";
          for (let q = Math.max(0, x0 * hr); q < W; q += 8 * hr) c.fillRect(q, yy * vr, 3 * hr, 1);
        }
        c.fillStyle = "#808080";
        for (const q of this.d.swings) {
          const yy = y(q.price);
          const xx = x(q.t);
          if (yy === null || xx === null || q.label.length < 2) continue;
          c.fillText(q.label, xx * hr - 7 * hr, (yy + (q.high ? -8 : 16)) * vr);
        }
      }
      if (this.d.showVp && this.d.profile) {
        const rows = this.d.profile.rows;
        const max = Math.max(...rows.map((r) => r.vol)) || 1;
        const maxW = Math.min(110 * hr, W * 0.2);
        const step = rows.length > 1 ? Math.abs((y(rows[1].price) ?? 0) - (y(rows[0].price) ?? 0)) : 2;
        for (const r of rows) {
          const yy = y(r.price);
          if (yy === null) continue;
          const w = (r.vol / max) * maxW;
          c.fillStyle = Math.abs(r.price - this.d.profile.poc) < 1e-9 + (rows[1].price - rows[0].price) / 2 ? "rgba(245,166,35,0.45)" : "rgba(128,128,128,0.16)";
          c.fillRect(W - w, (yy - step / 2) * vr, w, Math.max(1, (step - 0.5) * vr));
        }
      }
    });
  }
}

// Names a pane from inside it, so the label follows the pane on resize and shows on phones.
class PaneLabel implements ISeriesPrimitive<Time> {
  private items: { text: string; color: string }[];
  constructor(items: { text: string; color: string }[]) {
    this.items = items;
  }
  set(items: { text: string; color: string }[]) {
    this.items = items;
  }
  updateAllViews() {}
  paneViews() {
    return [{ zOrder: () => "top" as const, renderer: () => ({ draw: (t: never) => this.draw(t) }) }];
  }
  private draw(target: { useBitmapCoordinateSpace: (f: (s: { context: CanvasRenderingContext2D; horizontalPixelRatio: number; verticalPixelRatio: number }) => void) => void }) {
    target.useBitmapCoordinateSpace(({ context: c, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      c.font = `${11 * vr}px monospace`;
      let x = 8 * hr;
      for (const i of this.items) {
        c.fillStyle = i.color;
        c.fillText(i.text, x, 15 * vr);
        x += c.measureText(i.text).width + 14 * hr;
      }
    });
  }
}

type Props = { sym: string; analysis: Analysis | null; onPrice: (p: number) => void; digits?: number; onWicks?: (w: WickRead | null) => void; onFpp?: (f: FppRead | null) => void };

export default function Chart({ sym, analysis, onPrice, digits, onWicks, onFpp }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const flowCanvas = useRef<HTMLCanvasElement>(null);
  const [flow, setFlow] = useState(() => stored("q.flow") === "1");
  const [minUsd, setMinUsd] = useState(() => Number(stored("q.flowMin") ?? 1000) || 0);
  const minRef = useRef(minUsd);
  minRef.current = minUsd;
  // Timeframe and toggles are saved, so they survive switching tabs (which rebuilds the chart) and reloads.
  const [tf, setTf] = useState<(typeof TFS)[number]>(() => {
    const t = stored("q.chart.tf");
    return (TFS as readonly string[]).includes(t ?? "") ? (t as (typeof TFS)[number]) : "1h";
  });
  const [on, setOn] = useState(() => {
    const base = { struct: true, zones: true, fvg: true, wicks: false, fpp: false, ema: false, ribbon: false, vp: false, tpo: false, liq: false };
    try {
      const saved = JSON.parse(stored("q.chart.on") ?? "{}") as Partial<typeof base>;
      for (const k of Object.keys(base) as (keyof typeof base)[]) if (typeof saved[k] === "boolean") base[k] = saved[k];
    } catch {
      /* a bad saved value falls back to the defaults */
    }
    return base;
  });
  useEffect(() => store("q.chart.on", JSON.stringify(on)), [on]);
  useEffect(() => store("q.chart.tf", tf), [tf]);
  const [feed, setFeed] = useState<"LIVE" | "POLL" | "NOT ON HL" | "...">("...");
  const api = useRef<{
    chart: IChartApi;
    candle: ISeriesApi<"Candlestick">;
    e20: ISeriesApi<"Line">;
    e50: ISeriesApi<"Line">;
    e200: ISeriesApi<"Line">;
    aHi: ISeriesApi<"Line">;
    aLo: ISeriesApi<"Line">;
    vol: ISeriesApi<"Histogram">;
    cvdP: ISeriesApi<"Line">;
    cvdS: ISeriesApi<"Line">;
    overlay: Overlay;
    cvdTag: PaneLabel;
    flow: FlowLayer;
    liq: IPriceLine[];
  } | null>(null);
  const bars = useRef<Bar[]>([]);
  const tape = useRef<Bar[]>([]); // Binance bars behind CVD while the candles come from Hyperliquid
  const hover = useRef<number | null>(null);
  const spot = useRef<Map<number, number>>(new Map());
  const onRef = useRef(on);
  onRef.current = on;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const [measureOn, setMeasureOn] = useState(false);
  const [card, setCard] = useState<CardZone | null>(null);
  const zoneLoad = useRef<(() => void) | null>(null);
  const zoneKey = useRef("");
  const measuring = useRef(false);
  measuring.current = measureOn;
  const measure = useRef<{ a: Pt; b: Pt; done: boolean } | null>(null);
  const wickRead = useRef<WickRead | null>(null);
  const fppRead = useRef<FppRead | null>(null);
  const fppCb = useRef(onFpp);
  fppCb.current = onFpp;
  const baseOffset = useRef(REST_OFFSET);
  const wicksCb = useRef(onWicks);
  wicksCb.current = onWicks;
  const priceCb = useRef(onPrice);
  priceCb.current = onPrice;

  // create the chart once
  useEffect(() => {
    const el = host.current!;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#808080",
        fontSize: 11,
        fontFamily: getComputedStyle(document.body).fontFamily,
        panes: { separatorColor: "#1e1e1e", separatorHoverColor: "#2c2c2c" },
        attributionLogo: false,
      },
      grid: { vertLines: { color: "#0e0e0e" }, horzLines: { color: "#0e0e0e" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#444", labelBackgroundColor: "#2c2c2c" }, horzLine: { color: "#444", labelBackgroundColor: "#2c2c2c" } },
      rightPriceScale: { borderColor: "#1e1e1e" },
      timeScale: { borderColor: "#1e1e1e", timeVisible: true, secondsVisible: false, rightOffset: REST_OFFSET },
    });
    const line = (color: string, width: 1 | 2, pane = 0, style: LineStyle = LineStyle.Solid) =>
      chart.addSeries(LineSeries, { color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, pane);
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#2bbf85",
      downColor: "#e5534b",
      wickUpColor: "#2bbf85",
      wickDownColor: "#e5534b",
      borderVisible: false,
      priceLineColor: "#555",
    });
    const e20 = line("#5b9cf6", 1);
    const e50 = line("#b78cff", 1);
    const e200 = line("#808080", 1);
    const aHi = line("#f5a623", 1);
    const aLo = line("#f5a623", 1, 0, LineStyle.Dashed);
    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    const cvdP = chart.addSeries(LineSeries, { color: "#f5a623", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "volume" } }, 2);
    const cvdS = chart.addSeries(LineSeries, { color: "#5b9cf6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "volume" }, priceScaleId: "left" }, 2);
    const panes = chart.panes();
    [7, 1.2, 2].forEach((f, i) => panes[i]?.setStretchFactor(f));
    const overlay = new Overlay();
    candle.attachPrimitive(overlay);
    vol.attachPrimitive(new PaneLabel([{ text: "VOLUME", color: "#808080" }]));
    const cvdTag = new PaneLabel(CVD_TAGS);
    cvdP.attachPrimitive(cvdTag);
    const flowLayer = new FlowLayer(flowCanvas.current!, chart, candle);
    api.current = { chart, candle, e20, e50, e200, aHi, aLo, vol, cvdP, cvdS, overlay, cvdTag, flow: flowLayer, liq: [] };

    const pointAt = (p: { point?: { x: number; y: number }; paneIndex?: number }) => {
      if (!p.point || (p.paneIndex !== undefined && p.paneIndex !== 0)) return null;
      const price = candle.coordinateToPrice(p.point.y);
      const l = chart.timeScale().coordinateToLogical(p.point.x);
      return price === null || l === null ? null : { l: Math.round(l), p: price };
    };
    chart.subscribeCrosshairMove((p) => {
      hover.current = p.time ? (p.time as number) : null;
      renderLegend();
      const m = measure.current;
      const pt = m && !m.done ? pointAt(p) : null;
      if (m && pt) {
        m.b = pt;
        drawMeasure();
      }
    });
    // MEASURE mode or Shift-click: first click starts, second ends, the next starts again.
    // Read straight from the browser: the chart library drops a quick second click, and a fast tap-tap needs it.
    // The zone under a click, picking the tightest when zones overlap.
    const zoneAt = (e: MouseEvent): CardZone | null => {
      const o = api.current?.overlay.d;
      if (!o?.showZones) return null;
      const r = el.getBoundingClientRect();
      const y = e.clientY - r.top;
      if (y > (chart.panes()[0]?.getHeight() ?? 0)) return null;
      const x = e.clientX - r.left - chart.priceScale("left").width();
      const price = candle.coordinateToPrice(y);
      if (price === null) return null;
      const hits = o.zones.filter((z) => {
        if (price < z.bottom || price > z.top) return false;
        const first = o.times.find((t) => t >= z.t);
        const left = first === undefined ? null : chart.timeScale().timeToCoordinate(ts(first));
        return left === null || x >= left;
      });
      return hits.sort((a, b) => a.top - a.bottom - (b.top - b.bottom))[0] ?? null;
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onPick = (e: MouseEvent) => {
      const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
      if (moved > 6) return; // the end of a drag that panned the chart, not a pick
      const m = measure.current;
      if (!measuring.current && !e.shiftKey) {
        if (m?.done) {
          measure.current = null; // a plain click clears a finished quick measure
          drawMeasure();
          return;
        }
        setCard(zoneAt(e));
        return;
      }
      const r = el.getBoundingClientRect();
      const y = e.clientY - r.top;
      if (y > (chart.panes()[0]?.getHeight() ?? 0)) return; // only the price pane
      const pt = pointAt({ point: { x: e.clientX - r.left - chart.priceScale("left").width(), y }, paneIndex: 0 });
      if (!pt) return;
      measure.current = !m || m.done ? { a: pt, b: pt, done: false } : { ...m, b: pt, done: true };
      drawMeasure();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("click", onPick);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("click", onPick);
      flowLayer.stop();
      api.current = null;
      chart.remove();
    };
  }, []);

  const renderLegend = () => {
    const L = legend.current;
    const b = (hover.current ? bars.current.find((x) => x.t === hover.current) : undefined) ?? bars.current[bars.current.length - 1];
    if (!L || !b) return;
    const chg = ((b.c - b.o) / b.o) * 100;
    const taker = tape.current.length ? tape.current.find((x) => x.t === b.t) : b;
    const d = taker ? delta(taker) : 0;
    const wk = onRef.current.wicks ? (wickRead.current?.events ?? []).filter((e) => e.t === b.t) : [];
    const wickLines = wk.map((e) => `<div class="lg-wick ${e.side === "upper" ? "down" : "up"}">${wickText(e, fmtPx, fmtUsd)}</div>`).join("");
    L.innerHTML = `O<b>${fmtPx(b.o)}</b>H<b>${fmtPx(b.h)}</b>L<b>${fmtPx(b.l)}</b>C<b>${fmtPx(b.c)}</b><b class="${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</b>VOL<b>${fmtUsd(b.q)}</b>DELTA<b class="${d >= 0 ? "up" : "down"}">${fmtUsd(d)}</b>${wickLines}`;
  };

  // Builds the ruler readout: price move, percent, bars and elapsed time.
  const drawMeasure = () => {
    const a = api.current;
    if (!a) return;
    const m = measure.current;
    const hint = measuring.current && (!m || m.done) ? (m ? "Click or tap a new start point" : "Click or tap the start point") : m && !m.done ? "Click or tap the end point" : null;
    if (!m) {
      a.overlay.update({ measure: null, measureHint: hint });
      return;
    }
    const dp = m.b.p - m.a.p;
    const bars = Math.round(m.b.l - m.a.l);
    const secs = Math.abs(bars) * TF_SEC[tfRef.current];
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const mins = Math.round((secs % 3600) / 60);
    const dur = d ? `${d}d${h ? ` ${h}h` : ""}` : h ? `${h}h${mins ? ` ${mins}m` : ""}` : `${mins}m`;
    const sign = dp >= 0 ? "+" : "-";
    const lines = [`${sign}${fmtPx(Math.abs(dp))}  ${sign}${Math.abs((dp / m.a.p) * 100).toFixed(2)}%`, `${Math.abs(bars)} bar${Math.abs(bars) === 1 ? "" : "s"} · ${dur}`, `${fmtPx(m.a.p)} → ${fmtPx(m.b.p)}`];
    a.overlay.update({ measure: { a: m.a, b: m.b, up: dp >= 0, lines }, measureHint: hint });
  };

  // Wick events placed on the candles the chart is drawing, so they sit on the right wick even in HL FLOW.
  const mapWicks = (): DrawWick[] => {
    const r = wickRead.current;
    if (!r) return [];
    const byT = new Map(bars.current.map((x) => [x.t, x]));
    return r.events.flatMap((e) => {
      const k = byT.get(e.t);
      if (!k) return [];
      const up = e.side === "upper";
      const strong = e.score >= 1.6 || (!!e.sweep && (e.kind === "trapped" || e.kind === "rejected"));
      return [{ ...e, tip: up ? k.h : k.l, base: up ? Math.max(k.o, k.c) : Math.min(k.o, k.c), tag: wickTag(e, fmtUsd), strong }];
    });
  };

  const paint = (full: boolean) => {
    const a = api.current;
    const B = bars.current;
    if (!a || !B.length) return;
    const c = B.map((x) => x.c);
    const line = (v: (number | null)[]) => B.map((b, i) => ({ t: b.t, v: v[i] })).filter((p) => p.v !== null).map((p) => ({ time: ts(p.t), value: p.v as number }));
    const E20 = ema(c, 20);
    const E50 = ema(c, 50);
    const E200 = ema(c, 200);
    const T = tape.current.length ? tape.current : B;
    const CV = cvd(T);
    const { hi, lo } = ribbonAnchors(B, Math.min(B.length, 300));
    const AH = avwap(B, hi);
    const AL = avwap(B, lo);
    let s = 0;
    const SP = T.map((b) => {
      const d = spot.current.get(b.t);
      if (d === undefined) return null;
      s += d;
      return s;
    });
    const spotLine = T.map((b, i) => ({ time: ts(b.t), value: SP[i] })).filter((p): p is { time: UTCTimestamp; value: number } => p.value !== null);
    const candles = B.map((b) => ({ time: ts(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
    const takers = new Map(T.map((b) => [b.t, delta(b)]));
    const volUp = (b: Bar) => {
      const d = takers.get(b.t);
      return d ? d > 0 : b.c >= b.o;
    };
    const vols = B.map((b) => ({ time: ts(b.t), value: b.q, color: volUp(b) ? "rgba(43,191,133,0.55)" : "rgba(229,83,75,0.55)" }));
    const showE = onRef.current.ema;
    if (full) {
      a.candle.setData(candles);
      a.e20.setData(showE ? line(E20) : []);
      a.e50.setData(showE ? line(E50) : []);
      a.e200.setData(showE ? line(E200) : []);
      a.aHi.setData(onRef.current.ribbon ? AH.map((p) => ({ time: ts(p.t), value: p.v })) : []);
      a.aLo.setData(onRef.current.ribbon ? AL.map((p) => ({ time: ts(p.t), value: p.v })) : []);
      a.vol.setData(vols);
      a.cvdP.setData(T.map((b, i) => ({ time: ts(b.t), value: CV[i] })));
      a.cvdS.setData(spotLine);
    } else {
      const n = B.length - 1;
      const t = ts(B[n].t);
      a.candle.update(candles[n]);
      a.vol.update(vols[n]);
      const m = T.length - 1;
      a.cvdP.update({ time: ts(T[m].t), value: CV[m] });
      const sv = SP[m];
      if (sv !== null) a.cvdS.update({ time: ts(T[m].t), value: sv });
      if (showE) {
        a.e20.update({ time: t, value: E20[n] });
        a.e50.update({ time: t, value: E50[n] });
        a.e200.update({ time: t, value: E200[n] });
      }
      if (onRef.current.ribbon) {
        a.aHi.update({ time: t, value: AH[AH.length - 1].v });
        a.aLo.update({ time: t, value: AL[AL.length - 1].v });
      }
    }
    const hm = new Map(AH.map((p) => [p.t, p.v]));
    const lm = new Map(AL.map((p) => [p.t, p.v]));
    a.overlay.update({
      ribbon: B.filter((b) => hm.has(b.t) && lm.has(b.t)).map((b) => ({ t: b.t, a: hm.get(b.t)!, b: lm.get(b.t)! })),
      ...(full ? readChart(B, tfRef.current) : {}),
      profile: full ? volumeProfile(B.slice(-360)) : a.overlay.d.profile,
      times: B.map((b) => b.t),
      showRibbon: onRef.current.ribbon,
      showZones: onRef.current.zones,
      showFvg: onRef.current.fvg,
      showStruct: onRef.current.struct,
      showVp: onRef.current.vp,
      wicks: onRef.current.wicks ? mapWicks() : [],
      fpp: onRef.current.fpp && fppRead.current ? { start: B.length, base: B[B.length - 1].c, read: fppRead.current } : null,
      showWicks: onRef.current.wicks,
    });
    // New or moved zones fetch their resting size straight away rather than at the next refresh.
    if (full) {
      const key = a.overlay.d.zones.map((z) => `${z.top}|${z.bottom}`).join(",");
      if (key !== zoneKey.current) {
        zoneKey.current = key;
        zoneLoad.current?.();
      }
    }
    priceCb.current(B[B.length - 1].c);
    renderLegend();
  };

  // load history and stay live for this symbol + timeframe
  useEffect(() => {
    let dead = false;
    let ws: WebSocket | null = null;
    let pulse: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let pendingFull = false;
    let syncing = false;
    let lastTick = 0;
    let ping: ReturnType<typeof setInterval> | null = null;
    let group: ReturnType<typeof setTimeout> | null = null;
    const main = `/api/klines?sym=${sym}&tf=${tf}`;
    const url = flow ? `${main}&venue=hl` : main;
    const orders = new Map<string, { buy: boolean; sz: number; usd: number; time: number }>();
    const schedule = (full: boolean) => {
      pendingFull ||= full;
      if (timer) return;
      // Live ticks repaint fast so the candle and the page price move together. A closed bar redraws zones, so it waits.
      timer = setTimeout(
        () => {
          timer = null;
          paint(pendingFull);
          pendingFull = false;
        },
        pendingFull ? FULL_PAINT_MS : TICK_PAINT_MS,
      );
    };
    const ingest = (b: Bar) => {
      if (dead) return; // a tick from the previous coin can still arrive after its socket closes
      const B = bars.current;
      const l = B[B.length - 1];
      if (!l) return;
      if (b.t > l.t) {
        B.push(b);
        if (b.t > l.t + TF_SEC[tf]) void sync(); // the feed dropped or the device slept, so bars are missing
        schedule(true); // a closed bar can change order blocks and the profile
        return;
      }
      const i = b.t === l.t ? B.length - 1 : b.t === B[B.length - 2]?.t ? B.length - 2 : -1;
      // Volume only grows within a bar, so anything not larger is an older copy of what is on screen.
      if (i < 0 || b.v <= B[i].v) return;
      B[i] = b;
      schedule(i < B.length - 1);
    };
    // Refills history under the live bars without moving the user's view.
    const sync = async () => {
      if (syncing) return;
      syncing = true;
      try {
        const r = (await (await fetch(`${url}&limit=1000`)).json()) as KlinesResp;
        const last = r.bars?.[r.bars.length - 1];
        if (dead || !last) return;
        const held = bars.current.filter((b) => b.t > last.t || (b.t === last.t && b.v > last.v));
        bars.current = [...r.bars.filter((b) => !held.some((h) => h.t === b.t)), ...held];
        if (!flow) spot.current = new Map(r.spot.map((x) => [x.t, x.d]));
        paint(true);
      } catch {
        /* the next gap or pulse tries again */
      } finally {
        syncing = false;
      }
    };
    // Grouped fills become one order, so the minimum size filters orders rather than fragments.
    const flushOrders = () => {
      group = null;
      const layer = api.current?.flow;
      if (!layer || dead) return;
      const sec = TF_SEC[tf];
      for (const o of orders.values()) {
        const px = o.usd / o.sz;
        layer.hit(px, o.buy);
        if (o.usd >= minRef.current) layer.add({ px, usd: o.usd, buy: o.buy, t: Math.floor(o.time / 1000 / sec) * sec, min: minRef.current });
      }
      orders.clear();
    };
    const onTrades = (rows: HlTrade[]) => {
      for (const t of rows) {
        const buy = t.side === "B";
        const sz = +t.sz;
        const usd = sz * +t.px;
        const key = /^0x0+$/.test(t.hash) ? `${t.time}${t.side}` : `${t.hash}${t.side}`; // TWAP slices share a blank hash
        const o = orders.get(key);
        if (o) {
          o.sz += sz;
          o.usd += usd;
        } else orders.set(key, { buy, sz, usd, time: t.time });
      }
      group ??= setTimeout(flushOrders, FILL_GROUP_MS);
    };
    const connectHl = () => {
      if (dead) return;
      lastTick = Date.now();
      const s = new WebSocket(HL_WS);
      const coin = hlName(sym);
      const nSigFigs = tf === "5m" || tf === "15m" ? 4 : 3; // wider buckets so the depth rail spans more of the pane
      ws = s;
      s.onopen = () => {
        for (const subscription of [{ type: "trades", coin }, { type: "candle", coin, interval: tf }, { type: "l2Book", coin, nSigFigs }]) s.send(JSON.stringify({ method: "subscribe", subscription }));
        ping = setInterval(() => s.readyState === WebSocket.OPEN && s.send('{"method":"ping"}'), HL_PING_MS);
      };
      s.onerror = () => s.close();
      s.onclose = () => {
        if (ping) clearInterval(ping);
        if (!dead) retry = setTimeout(connectHl, 3000);
      };
      s.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as { channel: string; data: unknown };
        if (m.channel !== "trades" && m.channel !== "candle" && m.channel !== "l2Book") return;
        lastTick = Date.now();
        setFeed("LIVE");
        if (m.channel === "trades") onTrades(m.data as HlTrade[]);
        else if (m.channel === "candle") ingest(hlBar(m.data as HlCandle));
        else {
          const side = (r: HlLevel[]) => r.map((x) => ({ px: +x.px, usd: +x.px * +x.sz }));
          const [bids, asks] = (m.data as { levels: HlLevel[][] }).levels;
          api.current?.flow.book(side(bids), side(asks));
        }
      };
    };
    const connect = () => {
      if (dead) return;
      if (flow) return connectHl();
      lastTick = Date.now();
      const s = new WebSocket(`${WS_BASE}/${sym.toLowerCase()}usdt@kline_${tf}`);
      ws = s;
      s.onerror = () => s.close();
      s.onclose = () => {
        if (!dead) retry = setTimeout(connect, 3000);
      };
      s.onmessage = (ev) => {
        const k = JSON.parse(ev.data).k;
        if (!k) return;
        lastTick = Date.now();
        setFeed("LIVE"); // only a real tick earns LIVE: an open socket can be silent
        ingest({ t: Math.floor(k.t / 1000), o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, q: +k.q, tb: +k.V });
      };
    };
    // Keeps the CVD pane current while the candles run on Hyperliquid.
    const beatTape = async () => {
      const r = (await (await fetch(`${main}&limit=2`)).json()) as KlinesResp;
      if (dead || !tape.current.length) return;
      r.spot?.forEach((x) => spot.current.set(x.t, x.d));
      for (const b of r.bars ?? []) {
        const T = tape.current;
        const i = T.findLastIndex((x) => x.t === b.t);
        if (i >= 0) T[i] = b;
        else if (b.t > T[T.length - 1].t) T.push(b);
      }
      schedule(false);
    };
    // Runs beside the socket: keeps candles moving if it goes quiet, and keeps spot CVD current.
    const beat = async () => {
      const quiet = Date.now() - lastTick;
      if (quiet > POLL_AFTER_MS) setFeed("POLL");
      if (quiet > RECONNECT_AFTER_MS) {
        lastTick = Date.now();
        ws?.close();
      }
      try {
        if (flow) await beatTape();
        const r = (await (await fetch(`${url}&limit=2`)).json()) as KlinesResp;
        if (dead) return;
        if (!flow) r.spot?.forEach((x) => spot.current.set(x.t, x.d));
        r.bars?.forEach(ingest);
        if (r.spot?.length) schedule(false);
      } catch {
        /* next beat retries */
      }
    };
    const start = async () => {
      setFeed("...");
      api.current?.cvdTag.set(flow ? HL_CVD_TAGS : CVD_TAGS);
      if (flow) api.current?.flow.start();
      try {
        const [r, t] = await Promise.all([
          fetch(`${url}&limit=1000`).then((x) => x.json() as Promise<KlinesResp>),
          flow ? fetch(`${main}&limit=1000`).then((x) => x.json() as Promise<KlinesResp>).catch(() => null) : null,
        ]);
        if (dead) return;
        if (!r.bars?.length) throw new Error("no bars");
        bars.current = r.bars;
        tape.current = t?.bars ?? [];
        spot.current = new Map((t ?? r).spot?.map((x) => [x.t, x.d]) ?? []);
        paint(true);
        const a = api.current;
        const dp = pxDigits(r.bars[r.bars.length - 1].c, sym);
        a?.candle.applyOptions({ priceFormat: { type: "price", precision: dp, minMove: 10 ** -dp } });
        // Dragging a price axis switches auto-scale off, which would strand the new coin off screen.
        if (a) for (const s of [a.candle, a.vol, a.cvdP, a.cvdS]) s.priceScale().applyOptions({ autoScale: true });
        if (a) {
          // HL FLOW opens a lane right of the live candle for fills to travel through.
          const width = Math.max(320, a.chart.timeScale().width());
          const lane = flow ? Math.min(260, Math.max(130, width * 0.34)) : 0;
          const rightOffset = flow ? Math.round((VIEW_BARS * lane) / (width - lane)) : REST_OFFSET;
          a.chart.timeScale().applyOptions({ rightOffset });
          baseOffset.current = rightOffset;
          a.chart.timeScale().setVisibleLogicalRange({ from: r.bars.length - VIEW_BARS, to: r.bars.length + rightOffset });
        }
      } catch {
        if (!dead) {
          if (flow) setFeed("NOT ON HL");
          retry = setTimeout(start, 5000);
        }
        return;
      }
      connect();
      pulse = setInterval(beat, PULSE_MS);
    };
    void start();
    return () => {
      dead = true;
      ws?.close();
      if (pulse) clearInterval(pulse);
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      if (group) clearTimeout(group);
      api.current?.flow.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym, tf, flow]);

  // Resting size inside each zone on screen, for the zone labels. Refreshes while zones are shown.
  useEffect(() => {
    setCard(null);
    if (!on.zones) return;
    let dead = false;
    const load = async () => {
      const zs = api.current?.overlay.d.zones ?? [];
      if (!zs.length) return;
      try {
        const q = zs.map((z) => `${z.bottom}_${z.top}_${z.side}`).join(",");
        const r = (await (await fetch(`/api/zone-liq?sym=${sym}&z=${q}`)).json()) as ZoneAmount[];
        if (dead || !Array.isArray(r)) return;
        const map: Record<string, ZoneAmount> = {};
        zs.forEach((z, i) => {
          if (r[i]) map[`${z.top}|${z.bottom}`] = r[i];
        });
        api.current?.overlay.update({ zoneUsd: map });
      } catch {
        /* the next refresh retries */
      }
    };
    zoneLoad.current = () => void load();
    zoneKey.current = "";
    void load();
    const id = setInterval(load, 10000);
    return () => {
      dead = true;
      zoneLoad.current = null;
      clearInterval(id);
      api.current?.overlay.update({ zoneUsd: {} });
    };
  }, [on.zones, sym, tf]);

  // The ruler resets with the coin or timeframe, shows its hint while the mode is on, and Esc clears it.
  useEffect(() => {
    measure.current = null;
    drawMeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym, tf, measureOn]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (!measure.current && !measuring.current)) return;
      measure.current = null;
      setMeasureOn(false);
      drawMeasure();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Axis decimals follow the coin's tick size once the watchlist has loaded it.
  useEffect(() => {
    if (digits !== undefined) api.current?.candle.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } });
  }, [digits, sym]);

  // overlay toggles
  useEffect(() => {
    paint(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  // liquidation levels as price lines
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.liq.forEach((l) => a.candle.removePriceLine(l));
    a.liq = [];
    if (!analysis || !on.liq || analysis.sym !== sym) return;
    [...analysis.liq.clusters]
      .sort((x, y) => y.usd - x.usd)
      .slice(0, 6)
      .forEach((c) => {
        a.liq.push(
          a.candle.createPriceLine({
            price: c.price,
            color: c.side === "short" ? "rgba(229,83,75,0.6)" : "rgba(43,191,133,0.6)",
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: `${c.side === "short" ? "S" : "L"} ${fmtUsd(c.usd)}`,
          }),
        );
      });
  }, [analysis, on.liq, sym]);

  // FPP for this coin and timeframe. Opens room right of the live candle for the path, and gives it back when off.
  useEffect(() => {
    fppRead.current = null;
    fppCb.current?.(null);
    if (!on.fpp) {
      api.current?.chart.timeScale().applyOptions({ rightOffset: baseOffset.current });
      paint(false);
      return;
    }
    let dead = false;
    let framed = false;
    const load = async () => {
      try {
        const r = (await (await fetch(`/api/fpp?sym=${sym}&tf=${tf}`)).json()) as FppRead & { error?: string };
        if (dead || !r.candles) return;
        fppRead.current = r;
        fppCb.current?.(r);
        const a = api.current;
        if (a && !framed) {
          framed = true;
          const need = r.horizon + 6;
          a.chart.timeScale().applyOptions({ rightOffset: Math.max(baseOffset.current, need) });
          const n = bars.current.length;
          if (n) a.chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + need });
        }
        paint(false);
      } catch {
        /* the next refresh retries */
      }
    };
    void load();
    const id = setInterval(load, 60000);
    return () => {
      dead = true;
      clearInterval(id);
      fppRead.current = null;
      fppCb.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on.fpp, sym, tf]);

  // Wick flow and sweeps for this coin and timeframe, refreshed while the toggle is on.
  useEffect(() => {
    wickRead.current = null;
    wicksCb.current?.(null);
    if (!on.wicks) return;
    let dead = false;
    const load = async () => {
      try {
        const r = (await (await fetch(`/api/wicks?sym=${sym}&tf=${tf}`)).json()) as WickRead & { error?: string };
        if (dead || !r.events) return;
        wickRead.current = r;
        wicksCb.current?.(r);
        paint(false);
      } catch {
        /* the next refresh retries */
      }
    };
    void load();
    const id = setInterval(load, 20000);
    return () => {
      dead = true;
      clearInterval(id);
      wickRead.current = null;
      wicksCb.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on.wicks, sym, tf]);

  // TPO levels as price lines: the live session's POC and value area, and untested POCs nearby.
  useEffect(() => {
    if (!on.tpo) return;
    let dead = false;
    let lines: IPriceLine[] = [];
    const clear = () => {
      const a = api.current;
      if (a) lines.forEach((l) => a.candle.removePriceLine(l));
      lines = [];
    };
    const load = async () => {
      try {
        const r = (await (await fetch(`/api/tpo?sym=${sym}&days=10`)).json()) as { bars?: TpoBar[] };
        const a = api.current;
        const px = bars.current[bars.current.length - 1]?.c;
        const lv = r.bars?.length && px ? tpoLevels(r.bars, px) : null;
        if (dead || !a || !lv) return;
        clear();
        const add = (price: number, color: string, style: LineStyle, title: string) => lines.push(a.candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
        add(lv.poc, "#f5a623", LineStyle.Solid, "POC");
        add(lv.vah, "#5b9cf6", LineStyle.Dashed, "VAH");
        add(lv.val, "#5b9cf6", LineStyle.Dashed, "VAL");
        lv.naked.forEach((n) => add(n.poc, "rgba(245,166,35,0.7)", LineStyle.Dotted, "nPOC"));
      } catch {
        /* the next refresh retries */
      }
    };
    void load();
    const id = setInterval(load, 60000);
    return () => {
      dead = true;
      clearInterval(id);
      clear();
    };
  }, [on.tpo, sym]);

  const toggles: [keyof typeof on, string][] = [
    ["struct", "STRUCTURE"],
    ["zones", "ZONES"],
    ["fvg", "FVG"],
    ["wicks", "WICKS"],
    ["fpp", "FPP"],
    ["ema", "EMA"],
    ["ribbon", "AVWAP"],
    ["vp", "VP"],
    ["tpo", "TPO"],
    ["liq", "LIQ"],
  ];
  return (
    <>
      <div className="chart-bar">
        {TFS.map((t) => (
          <button key={t} data-on={t === tf} onClick={() => setTf(t)}>
            {t.toUpperCase()}
          </button>
        ))}
        <span className="sep" />
        <button data-on={measureOn} title="Measure a move: click a start and an end. Shift-click works any time, Esc clears." onClick={() => setMeasureOn((v) => !v)}>
          MEASURE
        </button>
        <span className="sep" />
        {toggles.map(([k, label]) => (
          <button key={k} data-on={on[k]} onClick={() => setOn((s) => ({ ...s, [k]: !s[k] }))}>
            {label}
          </button>
        ))}
        <span className="sep" />
        <button data-on={flow} title="Hyperliquid candles, fills and order book" onClick={() => setFlow((f) => { store("q.flow", f ? "0" : "1"); return !f; })}>
          HL FLOW
        </button>
        {flow && (
          <label className="flow-min">
            MIN $
            <input
              inputMode="numeric"
              aria-label="Minimum order size in dollars"
              value={minUsd || ""}
              onChange={(e) => {
                const v = Number(e.target.value.replace(/\D/g, ""));
                setMinUsd(v);
                store("q.flowMin", String(v));
              }}
            />
          </label>
        )}
        <span className="sep" />
        <span className={feed === "LIVE" ? "up" : "dim"} style={{ fontSize: 11 }}>
          {flow && feed === "LIVE" ? "HL " : ""}{feed}
        </span>
      </div>
      <div className="chart-wrap">
        <div ref={legend} className="legend" />
        <div ref={host} className="chart-host" />
        {card && <ZoneCard key={`${sym}${card.top}${card.bottom}`} sym={sym} z={card} onClose={() => setCard(null)} />}
        <canvas ref={flowCanvas} className="flow-layer" />
      </div>
    </>
  );
}
