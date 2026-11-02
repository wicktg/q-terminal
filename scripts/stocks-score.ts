// Scores Hyperliquid stock perps for "undervalued and a long is workable". Rules fixed before reading the output.
// Guardrails remove traps first, then value is a percentile rank inside what remains.
import { readFileSync, writeFileSync } from "node:fs";
import { colsFromBars, Ind } from "../lib/mtf.ts";
import { walk } from "../lib/structure.ts";
import type { Bar } from "../lib/types.ts";

const FILE = process.argv[2];
type Y = { t: number; o: number; h: number; l: number; c: number; v: number };
type S = Record<string, never> & {
  t: string; name: string; sector: string; industry: string; price: number; mark: number; mcap: number; beta: number; fpe: number; peg: number; evEbitda: number; evRev: number; fcf: number; gm: number; om: number; roe: number; revG: number; epsG: number; tgt: number; tgtLo: number; nAn: number; recMean: number; shortPct: number; funding: number; hlOi: number; hlVol: number; lev: number; de: number; cash: number; debt: number; nextEarn: number; epsNow: number; epsNext: number; up30: number; down30: number; trend30: number; trendNow: number; surprises: number[]; bars: Y[];
};
const all = JSON.parse(readFileSync(FILE, "utf8")) as S[];
const FOREIGN = new Set(["TSM", "BABA", "ASML", "NOK", "SKHY", "ARM", "NBIS"]); // report in other currencies, so cash flow and EV ratios mislead
const now = Date.parse("2026-11-01") / 1000;
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function ta(s: S) {
  const b: Bar[] = s.bars.map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v ?? 0, q: (x.v ?? 0) * x.c, tb: 0 }));
  if (b.length < 210) return null;
  const c = colsFromBars(b);
  const x = new Ind(c);
  const w = walk(c, 3);
  const n = c.n - 1;
  const hi52 = Math.max(...b.slice(-252).map((k) => k.h));
  const lo52 = Math.min(...b.slice(-252).map((k) => k.l));
  const [e20, e50, e200] = [x.ema(20)[n], x.ema(50)[n], x.ema(200)[n]];
  const ev = w.events.at(-1);
  return {
    dd: (c.c[n] / hi52 - 1) * 100,
    fromLow: (c.c[n] / lo52 - 1) * 100,
    r1m: (c.c[n] / c.c[n - 21] - 1) * 100,
    r3m: (c.c[n] / c.c[n - 63] - 1) * 100,
    rsi: x.rsi(14)[n],
    e20, e50, e200,
    above: [c.c[n] > e20, c.c[n] > e50, c.c[n] > e200].map((v) => (v ? "Y" : "n")).join(""),
    trend: w.trend[n] > 0 ? "UP" : w.trend[n] < 0 ? "DOWN" : "-",
    event: ev ? `${ev.kind}${ev.dir > 0 ? "↑" : "↓"}` : "-",
    labels: w.swings.slice(-4).map((k) => k.label).join(" "),
    atr: (x.atr()[n] / c.c[n]) * 100,
  };
}

const rows = all.map((s) => ({ s, ta: ta(s) }));
type R = (typeof rows)[number];
const fcfY = (s: S) => (FOREIGN.has(s.t) || !s.mcap || num(s.fcf) === null ? null : (s.fcf / s.mcap) * 100);
const ev = (s: S) => (FOREIGN.has(s.t) ? null : num(s.evEbitda));
const fails = (r: R) => {
  const { s } = r;
  const f: string[] = [];
  if (!(num(s.fpe) !== null && s.fpe > 0)) f.push("no forward profit");
  if (!(num(s.nAn) !== null && s.nAn >= 10)) f.push("thin coverage");
  if (!FOREIGN.has(s.t) && !(num(s.fcf) !== null && s.fcf > 0)) f.push("negative FCF");
  if (!(num(s.revG) !== null && s.revG > 0)) f.push("shrinking revenue");
  if (!(num(s.om) !== null && s.om > 0.05)) f.push("thin margin");
  if (num(s.gm) !== null && s.gm < 0.2) f.push("low gross margin");
  if (num(s.de) !== null && s.de > 250) f.push("heavy debt");
  if (num(s.revG) !== null && num(s.fpe) !== null && s.revG > 1.5 && s.fpe < 8) f.push("peak-cycle earnings");
  if (s.funding > 40) f.push(`funding ${s.funding.toFixed(0)}%`);
  if (s.hlOi < 1e6) f.push("thin perp");
  if (num(s.fpe) !== null && s.fpe > 40) f.push("expensive");
  if (!r.ta) f.push("short history");
  return f;
};
const pass = rows.filter((r) => !fails(r).length);
const rank = (get: (r: R) => number | null, lowBest: boolean) => {
  const v = pass.map((r) => get(r)).filter((x): x is number => x !== null);
  return (r: R) => {
    const x = get(r);
    if (x === null || !v.length) return null;
    const below = v.filter((y) => (lowBest ? y > x : y < x)).length;
    return below / Math.max(1, v.length - 1);
  };
};
const parts: [string, (r: R) => number | null][] = [
  ["fPE", rank((r) => num(r.s.fpe), true)],
  ["PEG", rank((r) => (num(r.s.peg) !== null && r.s.peg > 0 ? r.s.peg : null), true)],
  ["EV", rank((r) => { const e = ev(r.s); return e !== null && e > 0 ? e : null; }, true)],
  ["FCF", rank((r) => fcfY(r.s), false)],
  ["Tgt", rank((r) => (num(r.s.tgt) !== null ? r.s.tgt / r.s.price - 1 : null), false)],
];
const value = (r: R) => {
  const v = parts.map(([, f]) => f(r)).filter((x): x is number => x !== null);
  return v.length >= 3 ? (v.reduce((a, b) => a + b, 0) / v.length) * 100 : 0;
};
const f1 = (x: number | null | undefined, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(d));
const sorted = [...pass].sort((a, b) => value(b) - value(a));
console.log(`universe ${rows.length}, passed guardrails ${pass.length}`);
console.log("\n=== PASSED, BEST VALUE FIRST");
for (const r of sorted) {
  const { s, ta: t } = r;
  const days = s.nextEarn ? Math.round((s.nextEarn - now) / 86400) : null;
  console.log(`${s.t.padEnd(6)} val ${value(r).toFixed(0).padStart(3)} fPE ${f1(s.fpe).padStart(5)} PEG ${f1(s.peg, 2).padStart(5)} EV/E ${f1(ev(s)).padStart(5)} FCFy ${f1(fcfY(s)).padStart(5)} up ${(((s.tgt / s.price - 1) * 100)).toFixed(0).padStart(3)}% revG ${(s.revG * 100).toFixed(0).padStart(3)}% OM ${(s.om * 100).toFixed(0).padStart(3)}% short ${f1(s.shortPct * 100, 0).padStart(3)}% fund ${s.funding.toFixed(0).padStart(3)}% | dd ${f1(t!.dd, 0).padStart(4)}% 1m ${f1(t!.r1m, 0).padStart(4)}% 3m ${f1(t!.r3m, 0).padStart(4)}% RSI ${f1(t!.rsi, 0)} ${t!.above} ${t!.trend} ${t!.event} earn ${days === null ? "-" : `${days}d`} OI $${(s.hlOi / 1e6).toFixed(1)}M | ${s.sector ?? ""}`);
}
console.log("\n=== REMOVED BY GUARDRAILS");
for (const r of rows.filter((x) => fails(x).length)) console.log(`${r.s.t.padEnd(6)} ${fails(r).join(", ")}`);
writeFileSync(FILE.replace("stocks.json", "stocks-pass.json"), JSON.stringify(sorted.map((r) => ({ t: r.s.t, value: value(r), ta: r.ta }))));
