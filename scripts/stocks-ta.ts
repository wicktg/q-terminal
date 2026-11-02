// Technical read on stock perps: daily from Yahoo for history, 4H and 1H from Hyperliquid for the tradable perp.
import { readFileSync } from "node:fs";
import { colsFromBars, Ind, resample } from "../lib/mtf.ts";
import { avwap, volumeProfile } from "../lib/quant.ts";
import { poolsAt, walk, zonesAt } from "../lib/structure.ts";
import type { Bar } from "../lib/types.ts";

const FILE = process.argv[2];
type Y = { t: number; o: number; h: number; l: number; c: number; v: number };
type S = { t: string; coin: string; mark: number; price: number; funding: number; hlOi: number; hlVol: number; lev: number; shortPct: number; bars: Y[] };
const all = JSON.parse(readFileSync(FILE, "utf8")) as S[];
const hl = async (b: unknown) => {
  const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20000) });
  return r.ok ? r.json() : null;
};
const p = (x: number) => (x >= 100 ? x.toFixed(1) : x.toFixed(2));
const when = (t: number) => new Date(t * 1000).toISOString().slice(5, 10);
for (const sym of process.argv.slice(3)) {
  const s = all.find((x) => x.t === sym);
  if (!s) continue;
  const d: Bar[] = s.bars.map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v ?? 0, q: (x.v ?? 0) * x.c, tb: 0 }));
  const cd = colsFromBars(d);
  const xd = new Ind(cd);
  const wd = walk(cd, 3);
  const n = cd.n - 1;
  const raw = (await hl({ type: "candleSnapshot", req: { coin: s.coin, interval: "1h", startTime: Date.now() - 85 * 86400e3, endTime: Date.now() } })) as { t: number; o: string; h: string; l: string; c: string; v: string }[] | null;
  const h1: Bar[] = (raw ?? []).map((k) => ({ t: Math.floor(k.t / 1000), o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, q: +k.v * +k.c, tb: 0 })).slice(0, -1);
  const c1 = colsFromBars(h1);
  const c4 = c1.n > 100 ? resample(c1, 14400, 3600) : c1;
  const w4 = walk(c4, 3);
  const x4 = new Ind(c4);
  const px = s.mark;
  console.log(`\n######## ${sym}  perp ${p(px)}  last close ${p(s.price)}  weekend ${(((px / s.price - 1) * 100)).toFixed(1)}%  funding ${s.funding.toFixed(0)}%/yr (${(s.funding / 12).toFixed(1)}%/mo)  OI $${(s.hlOi / 1e6).toFixed(1)}M  vol $${(s.hlVol / 1e6).toFixed(2)}M  max lev ${s.lev}`);
  const last = d.slice(-252);
  const hi52 = Math.max(...last.map((b) => b.h));
  const lo52 = Math.min(...last.map((b) => b.l));
  const vAvg = d.slice(-51, -1).reduce((a, b) => a + b.v, 0) / 50;
  let streak = 0;
  for (let i = n; i > 0 && cd.c[i] < cd.c[i - 1]; i--) streak++;
  console.log(`52w ${p(lo52)}-${p(hi52)} position ${(((px - lo52) / (hi52 - lo52)) * 100).toFixed(0)}% | from high ${(((px / hi52 - 1) * 100)).toFixed(0)}% | from low ${(((px / lo52 - 1) * 100)).toFixed(0)}%`);
  console.log(`1D: trend ${wd.trend[n] > 0 ? "UP" : "DOWN"} RSI ${xd.rsi(14)[n].toFixed(0)} EMA20 ${p(xd.ema(20)[n])} EMA50 ${p(xd.ema(50)[n])} EMA200 ${p(xd.ema(200)[n])} (price ${(((px / xd.ema(200)[n] - 1) * 100)).toFixed(0)}% from 200) ATR ${((xd.atr()[n] / px) * 100).toFixed(1)}% | down days ${streak} | last vol ${(cd.v[n] / vAvg).toFixed(1)}x | ${wd.swings.slice(-4).map((k) => k.label).join(" ")} | ${wd.events.slice(-2).map((e) => `${e.kind}${e.dir > 0 ? "↑" : "↓"} ${p(e.level)} ${when(cd.t[e.i])}`).join(" ")}`);
  const big = d.slice(-40).map((b, i, a) => ({ b, g: i ? b.o / a[i - 1].c - 1 : 0, pc: i ? a[i - 1].c : 0 })).filter((x) => Math.abs(x.g) > 0.05);
  if (big.length) console.log(`gaps: ${big.map((x) => `${when(x.b.t)} ${(x.g * 100).toFixed(0)}% (${p(x.pc)} to ${p(x.b.o)})`).join(" | ")}`);
  const prof = volumeProfile(d.slice(-252), 48);
  console.log(`1y profile POC ${p(prof.poc)} VAH ${p(prof.vah)} VAL ${p(prof.val)}`);
  const iLo = cd.n - 252 + last.findIndex((b) => b.l === lo52);
  const iHi = cd.n - 252 + last.findIndex((b) => b.h === hi52);
  console.log(`AVWAP from 52w low ${p(avwap(d, iLo).at(-1)!.v)} | from 52w high ${p(avwap(d, iHi).at(-1)!.v)}`);
  const seen = new Set<string>();
  const zs = zonesAt(wd, n).filter((z) => z.kind !== "FVG" && z.side > 0 && z.top < px * 1.03).sort((a, b) => b.top - a.top).filter((z) => !seen.has(`${z.top}`) && !!seen.add(`${z.top}`)).slice(0, 4);
  console.log(`1D demand: ${zs.map((z) => `${z.kind} ${p(z.bottom)}-${p(z.top)} (${when(cd.t[z.origin])})`).join(" | ") || "none near"}`);
  const sup = zonesAt(wd, n).filter((z) => z.kind !== "FVG" && z.side < 0 && z.bottom > px * 0.97).sort((a, b) => a.bottom - b.bottom).slice(0, 3);
  console.log(`1D supply: ${sup.map((z) => `${z.kind} ${p(z.bottom)}-${p(z.top)}`).join(" | ") || "none near"}`);
  const fvg = zonesAt(wd, n).filter((z) => z.kind === "FVG").sort((a, b) => Math.abs((a.top + a.bottom) / 2 - px) - Math.abs((b.top + b.bottom) / 2 - px)).slice(0, 3);
  console.log(`1D unfilled gaps: ${fvg.map((z) => `${z.side > 0 ? "bull" : "bear"} ${p(z.bottom)}-${p(z.top)}`).join(" | ") || "none"}`);
  if (c4.n > 60) {
    const m = c4.n - 1;
    console.log(`4H perp: trend ${w4.trend[m] > 0 ? "UP" : "DOWN"} RSI ${x4.rsi(14)[m].toFixed(0)} | ${w4.swings.slice(-5).map((k) => `${k.label} ${p(k.price)}`).join(" ")} | ${w4.events.slice(-3).map((e) => `${e.kind}${e.dir > 0 ? "↑" : "↓"} ${p(e.level)}`).join(" ")}`);
    console.log(`4H demand: ${zonesAt(w4, m).filter((z) => z.kind !== "FVG" && z.side > 0).sort((a, b) => b.top - a.top).slice(0, 3).map((z) => `${z.kind} ${p(z.bottom)}-${p(z.top)}`).join(" | ") || "none"} | supply: ${zonesAt(w4, m).filter((z) => z.kind !== "FVG" && z.side < 0).sort((a, b) => a.bottom - b.bottom).slice(0, 3).map((z) => `${z.kind} ${p(z.bottom)}-${p(z.top)}`).join(" | ") || "none"}`);
    console.log(`4H liquidity: ${poolsAt(w4, m).filter((q) => Math.abs(q.price / px - 1) < 0.2).sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px)).slice(0, 6).map((q) => `${q.high ? "H" : "L"} ${p(q.price)}${q.touches > 1 ? ` x${q.touches}` : ""}`).join(" ")}`);
    const m3 = h1.slice(-24);
    if (m3.length) console.log(`last 24h on perp: ${p(Math.min(...m3.map((b) => b.l)))}-${p(Math.max(...m3.map((b) => b.h)))}, vol $${(m3.reduce((a, b) => a + b.q, 0) / 1e6).toFixed(2)}M`);
  } else console.log(`perp history short: ${c1.n} hourly bars`);
}
