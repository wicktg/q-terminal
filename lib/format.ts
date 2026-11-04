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

// Price decimals follow each coin's tick size on the exchange, so 1000PEPE shows 7 and BTC shows 1.
// Coins without a known tick fall back to a rule on magnitude. The page sets the coin it is showing,
// and anything formatting another coin's price passes that coin's symbol.
const tickDigits = new Map<string, number>();
let activeSym = "";
export function setPriceDigits(rows: { sym: string; dp?: number }[]) {
  for (const r of rows) if (r.dp !== undefined) tickDigits.set(r.sym, r.dp);
}
export function setActiveSym(sym: string) {
  activeSym = sym;
}
const byMagnitude = (a: number) => (a >= 10000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : 7);

export function pxDigits(x: number, sym = activeSym) {
  return tickDigits.get(sym) ?? byMagnitude(Math.abs(x));
}

export function fmtPx(x: number, sym?: string) {
  if (!Number.isFinite(x)) return "—";
  const d = pxDigits(x, sym);
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
