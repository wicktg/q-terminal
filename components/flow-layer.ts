// Animates Hyperliquid order flow over the price pane: fills pulse where they trade, and a depth rail
// on the right edge shrinks as resting bids and asks are taken.
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { fmtUsd } from "@/lib/format.ts";

export type FlowFill = { px: number; usd: number; buy: boolean; t: number; frac: number; size: number };
type Live = FlowFill & { born: number };
type Rest = { bid: boolean; usd: number; shown: number; hit: number };

const RING_MS = 1800;
const DOT_MS = 9000;
const HIT_MS = 500;
const MAX_FILLS = 240;
const RAIL_W = 84;
const ROW = 3;
const UP = "43,191,133";
const DOWN = "229,83,75";

const easeOut = (x: number) => 1 - (1 - x) ** 3;

export class FlowLayer {
  private c: CanvasRenderingContext2D;
  private fills: Live[] = [];
  private rail = new Map<number, Rest>();
  private raf = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private chart: IChartApi,
    private series: ISeriesApi<"Candlestick">,
  ) {
    this.c = canvas.getContext("2d")!;
  }

  start() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.fills = [];
    this.rail.clear();
    this.c.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  add(f: FlowFill) {
    this.fills.push({ ...f, born: performance.now() });
    if (this.fills.length > MAX_FILLS) this.fills.shift();
  }

  // Flashes the resting level a taker just traded into, whatever the order's size.
  hit(px: number, buy: boolean) {
    let near: Rest | null = null;
    let gap = Infinity;
    for (const [p, r] of this.rail) {
      if (r.bid === buy || Math.abs(p - px) >= gap) continue;
      gap = Math.abs(p - px);
      near = r;
    }
    if (near) near.hit = performance.now();
  }

  book(bids: { px: number; usd: number }[], asks: { px: number; usd: number }[]) {
    for (const r of this.rail.values()) r.usd = 0;
    const set = (rows: typeof bids, bid: boolean) => {
      for (const { px, usd } of rows) {
        const r = this.rail.get(px);
        if (r) {
          r.usd = usd;
          r.bid = bid;
        } else this.rail.set(px, { bid, usd, shown: 0, hit: 0 });
      }
    };
    set(bids, true);
    set(asks, false);
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    this.draw(performance.now());
  };

  private drawRail(now: number, right: number) {
    const { c } = this;
    const rows = new Map<number, { usd: number; bid: boolean; hit: number }>();
    for (const [px, r] of this.rail) {
      r.shown += (r.usd - r.shown) * 0.16;
      if (!r.usd && r.shown < 1) {
        this.rail.delete(px);
        continue;
      }
      const y = this.series.priceToCoordinate(px);
      if (y === null) continue;
      const k = Math.round(y / ROW);
      const row = rows.get(k);
      if (row) {
        row.usd += r.shown;
        row.hit = Math.max(row.hit, r.hit);
      } else rows.set(k, { usd: r.shown, bid: r.bid, hit: r.hit });
    }
    const max = Math.max(1, ...[...rows.values()].map((r) => r.usd));
    for (const [k, r] of rows) {
      const glow = Math.max(0, 1 - (now - r.hit) / HIT_MS);
      const w = (r.usd / max) * RAIL_W;
      c.fillStyle = `rgba(${r.bid ? UP : DOWN},${0.42 + 0.58 * glow})`;
      c.fillRect(right - w, k * ROW, w, ROW - 1);
    }
  }

  private drawFills(now: number, left: number) {
    const { c } = this;
    const scale = this.chart.timeScale();
    const space = scale.options().barSpacing;
    this.fills = this.fills.filter((f) => now - f.born < DOT_MS);
    c.textAlign = "center";
    c.font = "10px monospace";
    for (const f of this.fills) {
      const y = this.series.priceToCoordinate(f.px);
      const tx = scale.timeToCoordinate(f.t as UTCTimestamp);
      if (y === null || tx === null) continue;
      const x = left + tx + (f.frac - 0.5) * space;
      const rgb = f.buy ? UP : DOWN;
      const age = (now - f.born) / RING_MS;
      if (age < 1) {
        c.beginPath();
        c.arc(x, y, f.size * (1 + 2.6 * easeOut(age)), 0, Math.PI * 2);
        c.strokeStyle = `rgba(${rgb},${0.8 * (1 - age) ** 2})`;
        c.lineWidth = 1.5;
        c.stroke();
      }
      c.beginPath();
      c.arc(x, y, f.size, 0, Math.PI * 2);
      c.fillStyle = `rgba(${rgb},${0.85 * (1 - (now - f.born) / DOT_MS)})`;
      c.fill();
      if (f.size >= 7 && age < 2.2) {
        c.fillStyle = `rgba(232,232,232,${Math.min(1, 2.2 - age)})`;
        c.fillText(fmtUsd(f.usd), x, y - f.size - 6);
      }
    }
  }

  private draw(now: number) {
    const { canvas, c, chart } = this;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cw, ch);
    const left = chart.priceScale("left").width();
    const w = chart.timeScale().width();
    const h = chart.panes()[0]?.getHeight() ?? 0;
    c.save();
    c.beginPath();
    c.rect(left, 0, w, h);
    c.clip();
    this.drawRail(now, left + w);
    this.drawFills(now, left);
    c.restore();
  }
}
