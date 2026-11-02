// Animates Hyperliquid order flow over the price pane. Fills leave the live candle and slide right through
// an open lane at their own price, so they never pile up. A depth rail on the right edge shrinks as resting
// bids and asks are taken.
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { fmtUsd } from "@/lib/format.ts";

export type FlowFill = { px: number; usd: number; buy: boolean; t: number; min: number };
type Live = FlowFill & { born: number; pulse: number; x: number; y: number; r: number };
type Rest = { bid: boolean; usd: number; shown: number; hit: number };

const LIFE_MS = 7000; // time to cross the lane
const FADE_FROM = 0.7; // share of the crossing before a bubble starts fading
const PULSE_MS = 900;
const MERGE_MS = 1200; // fills this close in time and price read as one event
const MERGE_PX = 6;
const HIT_MS = 500;
const MAX_FILLS = 80;
const ROW = 3;
const GAP = 3;
const UP = "43,191,133";
const DOWN = "229,83,75";

const easeOut = (x: number) => 1 - (1 - x) ** 3;

export class FlowLayer {
  private c: CanvasRenderingContext2D;
  private fills: Live[] = [];
  private rail = new Map<number, Rest>();
  private raf = 0;
  private small = false;

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

  private radius(usd: number, min: number) {
    const r = Math.min(20, 5 + 4.5 * Math.log10(1 + usd / Math.max(1, min)));
    return this.small ? r * 0.85 : r;
  }

  add(f: FlowFill) {
    const now = performance.now();
    const y = this.series.priceToCoordinate(f.px);
    if (y === null) return;
    const same = this.fills.find((o) => o.buy === f.buy && now - o.born < MERGE_MS && Math.abs(o.y - y) < MERGE_PX);
    if (same) {
      same.usd += f.usd;
      same.pulse = now;
      return;
    }
    this.fills.push({ ...f, born: now, pulse: now, x: 0, y, r: 0 });
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

  private drawRail(now: number, right: number, width: number) {
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
      const w = (r.usd / max) * width;
      c.fillStyle = `rgba(${r.bid ? UP : DOWN},${0.55 + 0.45 * glow})`;
      c.fillRect(right - w, k * ROW, w, ROW - 1);
    }
  }

  private labelOf(f: Live) {
    return f.r >= 9 ? fmtUsd(f.usd) : "";
  }

  // Half the space a bubble needs along its row, counting its label.
  private reach(f: Live) {
    const text = this.labelOf(f);
    return Math.max(f.r, text ? this.c.measureText(text).width / 2 + 5 : 0) + GAP;
  }

  // Newest fills keep their place, and older ones are pushed along the row until nothing touches.
  private layout(now: number, end: number) {
    const placed: Live[] = [];
    for (const f of [...this.fills].sort((a, b) => b.born - a.born)) {
      const start = this.anchor(f);
      if (start === null) continue;
      const age = (now - f.born) / LIFE_MS;
      let want = start + f.r + 8 + age * Math.max(40, end - start);
      // This runs inside the animation frame, so the passes are capped: an endless loop here locks the tab.
      for (let pass = 0, moved = true; moved && pass <= placed.length; pass++) {
        moved = false;
        for (const p of placed) {
          const clear = this.reach(f) + this.reach(p);
          const gap = want - p.x;
          if (Math.abs(p.y - f.y) < f.r + p.r + GAP && gap > -clear && gap < clear - 0.5) {
            want = p.x + clear;
            moved = true;
          }
        }
      }
      f.x = f.x ? f.x + (want - f.x) * 0.22 : want;
      placed.push({ ...f, x: want });
    }
  }

  private anchor(f: Live) {
    const tx = this.chart.timeScale().timeToCoordinate(f.t as UTCTimestamp);
    return tx === null ? null : this.chart.priceScale("left").width() + tx;
  }

  private drawFills(now: number, end: number) {
    const { c } = this;
    c.font = `600 ${this.small ? 10 : 11}px monospace`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    this.fills = this.fills.filter((f) => now - f.born < LIFE_MS);
    for (const f of this.fills) {
      const y = this.series.priceToCoordinate(f.px);
      if (y !== null) f.y = y;
      f.r += (this.radius(f.usd, f.min) - f.r) * 0.3;
    }
    this.layout(now, end);
    for (const f of this.fills) {
      if (!f.x || f.x > end) continue;
      const rgb = f.buy ? UP : DOWN;
      const age = (now - f.born) / LIFE_MS;
      const alpha = age < FADE_FROM ? 1 : (1 - age) / (1 - FADE_FROM);
      const pulse = (now - f.pulse) / PULSE_MS;
      if (pulse < 1) {
        c.beginPath();
        c.arc(f.x, f.y, f.r * (1 + 1.8 * easeOut(pulse)), 0, Math.PI * 2);
        c.strokeStyle = `rgba(${rgb},${0.9 * (1 - pulse) ** 2})`;
        c.lineWidth = 2;
        c.stroke();
      }
      c.beginPath();
      c.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      c.fillStyle = `rgba(${rgb},${alpha})`;
      c.fill();
      c.strokeStyle = `rgba(0,0,0,${alpha})`; // a dark edge separates a bubble from candles and zones
      c.lineWidth = 2;
      c.stroke();
      const text = this.labelOf(f);
      if (!text) continue;
      const w = c.measureText(text).width + 8;
      const top = f.y - f.r - 17;
      c.fillStyle = `rgba(0,0,0,${0.85 * alpha})`;
      c.fillRect(f.x - w / 2, top, w, 14);
      c.fillStyle = `rgba(255,255,255,${alpha})`;
      c.fillText(text, f.x, top + 7.5);
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
    this.small = cw < 500;
    const railW = this.small ? 44 : 84;
    const left = chart.priceScale("left").width();
    const w = chart.timeScale().width();
    const h = chart.panes()[0]?.getHeight() ?? 0;
    c.save();
    c.beginPath();
    c.rect(left, 0, w, h);
    c.clip();
    this.drawRail(now, left + w, railW);
    this.drawFills(now, left + w - railW - 6);
    c.restore();
  }
}
