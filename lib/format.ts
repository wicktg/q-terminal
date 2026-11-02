import type { Bar } from "./types.ts";

// Binance quotes small coins per 1000 tokens as 1000PEPE. Spot uses PEPE, Hyperliquid uses kPEPE at the same scale.
export const spotName = (sym: string) => sym.replace(/^1000(?=[A-Z])/, "");
export const hlName = (sym: string) => (spotName(sym) === sym ? sym : `k${spotName(sym)}`);

// Hyperliquid candles carry no taker split, so a bar starts with buys and sells even.
export type HlCandle = { t: number; o: string; h: string; l: string; c: string; v: string };
export const hlBar = (k: HlCandle): Bar => ({
  t: Math.floor(k.t / 1000),
  o: +k.o,
  h: +k.h,
  l: +k.l,
  c: +k.c,
  v: +k.v,
  q: (+k.v * (+k.h + +k.l + +k.c)) / 3,
  tb: +k.v / 2,
});

export function pxDigits(x: number) {
  const a = Math.abs(x);
  return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
}

export function fmtPx(x: number) {
  if (!Number.isFinite(x)) return "—";
  const d = pxDigits(x);
  return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtUsd(x: number | null | undefined) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const s = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
}

export function fmtPct(x: number | null | undefined, d = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
}

export const toneClass = (x: number | null | undefined) => (x === null || x === undefined || x === 0 ? "" : x > 0 ? "up" : "down");
