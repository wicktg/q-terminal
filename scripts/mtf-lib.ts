// Loading and shared statistics for the multi-timeframe search and gates.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { colsFromRows, fundCum, makeEnv, resample, TF_SEC, type Cols, type Env, type Extra, type Fund, type Tf, type Trade } from "../lib/mtf.ts";

export const DIR = resolve(import.meta.dirname, "../data/ltf");
export const OUT = resolve(import.meta.dirname, "../data/mtf");
export const DAY = 86400;
export const universe = JSON.parse(readFileSync(resolve(DIR, "universe.json"), "utf8")) as { watch: string[]; hold: string[] };

export type Coin = { sym: string; base: Cols; fund: Fund; oi: { t: number; v: number }[]; extra: Extra };

export function loadCoin(sym: string): Coin | null {
  const f = resolve(DIR, `${sym}.5m.bin`);
  if (!existsSync(f)) return null;
  const buf = readFileSync(f);
  const base = colsFromRows(new Float64Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 8)));
  if (base.n < 2000) return null;
  const fundFile = resolve(DIR, `${sym}.funding.json`);
  const oiFile = resolve(DIR, `${sym}.oi1h.json`);
  const rows = existsSync(fundFile) ? JSON.parse(readFileSync(fundFile, "utf8")) : [];
  const spotFile = resolve(DIR, `${sym}.spot1h.json`);
  const cbFile = resolve(DIR, "coinbase-btc.json");
  return {
    sym,
    base,
    extra: { fund: rows, spot: existsSync(spotFile) ? JSON.parse(readFileSync(spotFile, "utf8")) : [], cb: existsSync(cbFile) ? JSON.parse(readFileSync(cbFile, "utf8")) : [] },
    fund: fundCum(rows),
    oi: existsSync(oiFile) ? JSON.parse(readFileSync(oiFile, "utf8")) : [],
  };
}

export const barsAt = (base: Cols, tf: Tf) => (tf === "5m" ? base : resample(base, TF_SEC[tf], 300));

export function envs(coins: Coin[], btc: Coin, tf: Tf): Env[] {
  const btcD = barsAt(btc.base, "1d");
  const btcTf = barsAt(btc.base, tf);
  return coins.map((c) => makeEnv(c.sym, tf, barsAt(c.base, tf), barsAt(c.base, "1d"), barsAt(c.base, "4h"), btcD, btcTf, c.oi, c.extra));
}

export type Summary = { n: number; win: number; avg: number; total: number; t: number; sharpe: number };

// The t-stat is on daily portfolio totals, because alts move together and trades are not independent.
export function dailySeries(tr: Trade[], from: number, to: number) {
  const a = Math.floor(from / DAY);
  const days = Math.max(1, Math.floor(to / DAY) - a);
  const v = new Float64Array(days);
  for (const x of tr) {
    const k = Math.floor(x.tOut / DAY) - a;
    if (k >= 0 && k < days) v[k] += x.r;
  }
  return v;
}

export function summary(tr: Trade[], from: number, to: number): Summary {
  const inP = tr.filter((x) => x.tIn >= from && x.tIn < to);
  const n = inP.length;
  if (!n) return { n: 0, win: 0, avg: 0, total: 0, t: 0, sharpe: 0 };
  const total = inP.reduce((s, x) => s + x.r, 0);
  const v = dailySeries(inP, from, to);
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
  return { n, win: inP.filter((x) => x.r > 0).length / n, avg: total / n, total, t: sd ? (m / sd) * Math.sqrt(v.length) : 0, sharpe: sd ? (m / sd) * Math.sqrt(365) : 0 };
}

export const asOfOf = (c: Coin) => c.base.t[c.base.n - 1] + 300;
