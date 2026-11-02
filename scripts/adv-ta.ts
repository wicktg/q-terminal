// One-time advanced technical read on named coins, on closed bars from live feeds.
// Run: node --experimental-strip-types --no-warnings scripts/adv-ta.ts ZEC HYPE LIT
import type { Bar } from "../lib/types.ts";
import { colsFromBars, emaA, Ind, rsiA, type Cols } from "../lib/mtf.ts";
import { avwap, cvd, volumeProfile } from "../lib/quant.ts";
import { poolsAt, walk, zonesAt, type Walk, type Zone } from "../lib/structure.ts";

const FAPI = "https://fapi.binance.com";
const kl = async (sym: string, tf: string, n: number): Promise<Bar[]> => {
  const r = await fetch(`${FAPI}/fapi/v1/klines?symbol=${sym}USDT&interval=${tf}&limit=${n}`, { signal: AbortSignal.timeout(20000) });
  const rows = (await r.json()) as (string | number)[][];
  return rows.map((k) => ({ t: Math.floor(+k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], tb: +k[9] }));
};
const p3 = (x: number) => (x >= 100 ? x.toFixed(1) : x >= 10 ? x.toFixed(2) : x.toFixed(4));
const pc = (a: number, b: number) => ((a / b - 1) * 100).toFixed(1);
const when = (t: number) => new Date(t * 1000).toISOString().slice(5, 16).replace("T", " ");

function adx(b: Cols, n = 14) {
  let [pdm, ndm, tr, val] = [0, 0, 0, 0];
  for (let i = 1; i < b.n; i++) {
    const up = b.h[i] - b.h[i - 1];
    const dn = b.l[i - 1] - b.l[i];
    const t = Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
    pdm = pdm - pdm / n + (up > dn && up > 0 ? up : 0);
    ndm = ndm - ndm / n + (dn > up && dn > 0 ? dn : 0);
    tr = tr - tr / n + t;
    const [pi, ni] = [tr ? (100 * pdm) / tr : 0, tr ? (100 * ndm) / tr : 0];
    const dx = pi + ni ? (100 * Math.abs(pi - ni)) / (pi + ni) : 0;
    val = val + (dx - val) / n;
  }
  return val;
}

function pctRank(v: Float64Array, look: number) {
  const n = v.length - 1;
  let below = 0;
  for (let i = n - look; i < n; i++) if (v[i] < v[n]) below++;
  return (below / look) * 100;
}

function divergence(b: Cols, w: Walk, name: string) {
  const r = rsiA(b.c, 14);
  let [s, cv] = [0, new Float64Array(b.n)];
  for (let i = 0; i < b.n; i++) cv[i] = s += (2 * b.tb[i] - b.v[i]) * b.c[i];
  const out: string[] = [];
  for (const high of [true, false]) {
    const sw = w.swings.filter((x) => x.high === high).slice(-2);
    if (sw.length < 2) continue;
    const [a, z] = sw;
    const pUp = z.price > a.price;
    const [rUp, cUp] = [r[z.i] > r[a.i], cv[z.i] > cv[a.i]];
    if (high && pUp && !rUp) out.push(`${name} bearish RSI div (${r[a.i].toFixed(0)} to ${r[z.i].toFixed(0)})`);
    if (high && !pUp && rUp) out.push(`${name} hidden bearish RSI (${r[a.i].toFixed(0)} to ${r[z.i].toFixed(0)})`);
    if (!high && !pUp && rUp) out.push(`${name} bullish RSI div (${r[a.i].toFixed(0)} to ${r[z.i].toFixed(0)})`);
    if (!high && pUp && !rUp) out.push(`${name} hidden bullish RSI (${r[a.i].toFixed(0)} to ${r[z.i].toFixed(0)})`);
    if (high && pUp && !cUp) out.push(`${name} bearish CVD div`);
    if (!high && !pUp && cUp) out.push(`${name} bullish CVD div`);
  }
  return out.length ? out.join("; ") : `${name} no divergence`;
}

// Bars since the zone was born that entered it, counting each separate visit once.
function visits(b: Cols, z: Zone) {
  let [n, out] = [0, true];
  for (let k = z.born + 1; k < b.n; k++) {
    const inside = b.l[k] <= z.top && b.h[k] >= z.bottom;
    if (inside && out) n++;
    out = !inside;
  }
  return n;
}

function nakedPocs(m15: Bar[], px: number) {
  const days = new Map<number, Bar[]>();
  for (const b of m15) {
    const d = Math.floor(b.t / 86400);
    days.set(d, [...(days.get(d) ?? []), b]);
  }
  const keys = [...days.keys()].sort((a, b) => a - b).slice(0, -1);
  const out: { d: string; poc: number }[] = [];
  for (const d of keys) {
    const bars = days.get(d)!;
    if (bars.length < 60) continue;
    const poc = volumeProfile(bars, 24).poc;
    const later = m15.filter((b) => b.t >= (d + 1) * 86400);
    if (!later.some((b) => b.l <= poc && b.h >= poc)) out.push({ d: new Date(d * 86400000).toISOString().slice(5, 10), poc });
  }
  return out.sort((a, b) => Math.abs(a.poc - px) - Math.abs(b.poc - px)).slice(0, 5);
}

const btcD = await kl("BTC", "1d", 120);
for (const sym of process.argv.slice(2)) {
  const [r15, r1, r4, rd] = await Promise.all([kl(sym, "15m", 1500), kl(sym, "1h", 1500), kl(sym, "4h", 1500), kl(sym, "1d", 500)]);
  const px = r15[r15.length - 1].c;
  const sets: [string, Bar[]][] = [["1D", rd.slice(0, -1)], ["4H", r4.slice(0, -1)], ["1H", r1.slice(0, -1)], ["15M", r15.slice(0, -1)]];
  const data = sets.map(([tf, bars]) => {
    const b = colsFromBars(bars);
    return { tf, bars, b, x: new Ind(b), w: walk(b, tf === "1D" ? 3 : 5) };
  });
  const [D, H4, H1, M15] = data;
  console.log(`\n################ ${sym}  price ${p3(px)}  ${when(r15[r15.length - 1].t)} UTC`);

  console.log("--- STRUCTURE");
  for (const f of data) {
    const n = f.b.n - 1;
    const c = f.b.c[n];
    const [e20, e50, e200] = [f.x.ema(20)[n], f.x.ema(50)[n], f.x.ema(200)[n]];
    const stack = e20 > e50 && e50 > e200 ? "bull stack" : e20 < e50 && e50 < e200 ? "bear stack" : "mixed";
    const ev = f.w.events.slice(-3).map((e) => `${e.kind}${e.dir > 0 ? "↑" : "↓"} ${p3(e.level)}`).join(" ");
    const lab = f.w.swings.slice(-6).map((s) => s.label).join(" ");
    console.log(`${f.tf.padEnd(4)} trend ${f.w.trend[n] > 0 ? "UP" : f.w.trend[n] < 0 ? "DOWN" : "-"} | ${stack} (20 ${p3(e20)}, 50 ${p3(e50)}, 200 ${p3(e200)}) | above 20/50/200 ${[e20, e50, e200].map((e) => (c > e ? "Y" : "n")).join("")} | RSI ${f.x.rsi(14)[n].toFixed(0)} | ADX ${adx(f.b).toFixed(0)} | BB width pct ${(f.x.bbRank()[n] * 100).toFixed(0)} | ATR ${p3(f.x.atr()[n])} (${((f.x.atr()[n] / c) * 100).toFixed(1)}%) rank ${pctRank(f.x.atr(), Math.min(300, n - 1)).toFixed(0)}`);
    console.log(`     ${lab} | ${ev}`);
  }

  console.log("--- DEALING RANGES, position 0 is the low, 100 the high, above 50 is premium");
  for (const f of [D, H4, H1]) {
    const hi = [...f.w.swings].reverse().find((s) => s.high)!;
    const lo = [...f.w.swings].reverse().find((s) => !s.high)!;
    const pos = ((px - lo.price) / (hi.price - lo.price)) * 100;
    const up = lo.i < hi.i; // leg ran from low to high
    const leg = hi.price - lo.price;
    const fib = [0.382, 0.5, 0.618, 0.705, 0.786].map((k) => `${k} ${p3(up ? hi.price - k * leg : lo.price + k * leg)}`).join("  ");
    console.log(`${f.tf.padEnd(4)} low ${p3(lo.price)} (${when(f.bars[lo.i].t)}) high ${p3(hi.price)} (${when(f.bars[hi.i].t)}) leg ${up ? "UP" : "DOWN"} position ${pos.toFixed(0)}%`);
    console.log(`     fib retrace: ${fib}`);
  }
  const look = H1.bars.slice(-720);
  const hi30 = Math.max(...look.map((b) => b.h));
  const lo30 = Math.min(...look.map((b) => b.l));
  console.log(`30d range ${p3(lo30)}-${p3(hi30)} position ${(((px - lo30) / (hi30 - lo30)) * 100).toFixed(0)}%`);

  console.log("--- ANCHORED VWAP (1H bars)");
  const bars = H1.bars;
  const idxOf = (fn: (b: Bar) => boolean, from = 0) => bars.findIndex((b, i) => i >= from && fn(b));
  const start30 = bars.length - 720;
  const iHi = start30 + look.findIndex((b) => b.h === hi30);
  const iLo = start30 + look.findIndex((b) => b.l === lo30);
  const recent = bars.slice(-168);
  const iVol = bars.length - 168 + recent.findIndex((b) => b.q === Math.max(...recent.map((x) => x.q)));
  const lastT = bars[bars.length - 1].t;
  const dNow = new Date(lastT * 1000);
  const monday = lastT - (((dNow.getUTCDay() + 6) % 7) * 86400 + (lastT % 86400));
  const anchors: [string, number][] = [
    ["30d high", iHi],
    ["30d low", iLo],
    [`Biggest bar ${when(bars[iVol].t)}`, iVol],
    ["Oct open", idxOf((b) => b.t >= Date.UTC(2026, 9, 1) / 1000)],
    ["Week open", idxOf((b) => b.t >= monday)],
  ];
  for (const [name, i] of anchors) {
    if (i < 0) continue;
    const v = avwap(bars, i).at(-1)!.v;
    console.log(`${name.padEnd(28)} ${p3(v)}  price ${px > v ? "above" : "below"} by ${Math.abs(+pc(px, v)).toFixed(1)}%`);
  }

  console.log("--- VOLUME PROFILE");
  for (const [name, list] of [["7d", M15.bars.slice(-672)], ["30d", H1.bars.slice(-720)]] as [string, Bar[]][]) {
    const p = volumeProfile(list, 48);
    console.log(`${name.padEnd(4)} POC ${p3(p.poc)} VAH ${p3(p.vah)} VAL ${p3(p.val)} | price ${px > p.vah ? "above value" : px < p.val ? "below value" : "in value"}`);
  }
  console.log("naked daily POCs:", nakedPocs(M15.bars, px).map((x) => `${x.d} ${p3(x.poc)} (${pc(x.poc, px)}%)`).join(", ") || "none");

  console.log("--- ACTIVE ZONES within 18%, tests are separate visits since creation");
  for (const f of [D, H4, H1]) {
    const n = f.b.n - 1;
    const zs = zonesAt(f.w, n).filter((z) => z.kind !== "FVG");
    const seen = new Set<string>();
    for (const z of zs.sort((a, b) => Math.abs((a.top + a.bottom) / 2 - px) - Math.abs((b.top + b.bottom) / 2 - px))) {
      const k = `${z.kind}${z.top}${z.bottom}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const dist = z.top < px ? (z.top / px - 1) * 100 : z.bottom > px ? (z.bottom / px - 1) * 100 : 0;
      if (Math.abs(dist) > 18) continue;
      console.log(`${f.tf.padEnd(3)} ${(z.side > 0 ? "DEMAND" : "SUPPLY")} ${z.kind.padEnd(3)} ${p3(z.bottom)}-${p3(z.top)} dist ${dist.toFixed(1)}% tests ${visits(f.b, z)} born ${when(f.bars[z.origin].t)}`);
    }
  }
  console.log("--- UNFILLED FVGs nearest price");
  for (const f of [H4, H1]) {
    const n = f.b.n - 1;
    const g = zonesAt(f.w, n).filter((z) => z.kind === "FVG").sort((a, b) => Math.abs((a.top + a.bottom) / 2 - px) - Math.abs((b.top + b.bottom) / 2 - px)).slice(0, 4);
    console.log(`${f.tf}: ${g.map((z) => `${z.side > 0 ? "bull" : "bear"} ${p3(z.bottom)}-${p3(z.top)}`).join(" | ") || "none"}`);
  }

  console.log("--- LIQUIDITY");
  for (const f of [H4, H1, M15]) {
    const n = f.b.n - 1;
    const ps = poolsAt(f.w, n).filter((p) => Math.abs(p.price / px - 1) < 0.15).sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px)).slice(0, 7);
    console.log(`${f.tf.padEnd(3)} ${ps.map((p) => `${p.high ? "H" : "L"} ${p3(p.price)}${p.touches > 1 ? ` x${p.touches}` : ""}`).join("  ")}`);
    const sw = f.w.sweeps.slice(-3).map((s) => `${s.dir > 0 ? "low" : "high"} ${p3(s.level)} swept ${when(f.bars[s.i].t)}`);
    console.log(`    recent sweeps: ${sw.join(" | ") || "none"}`);
  }

  console.log("--- DIVERGENCE");
  console.log([divergence(H4.b, H4.w, "4H"), divergence(H1.b, H1.w, "1H"), divergence(M15.b, M15.w, "15M")].join(" | "));

  console.log("--- LEG VOLUME AND CVD");
  const sw4 = H4.w.swings.slice(-5);
  for (let i = 1; i < sw4.length; i++) {
    const [a, z] = [sw4[i - 1], sw4[i]];
    if (a.high === z.high) continue;
    const seg = H4.bars.slice(a.i, z.i + 1);
    const q = seg.reduce((s, b) => s + b.q, 0);
    const d = seg.reduce((s, b) => s + (2 * b.tb - b.v) * b.c, 0);
    console.log(`${p3(a.price)} to ${p3(z.price)} (${pc(z.price, a.price)}%) ${seg.length} bars, vol per bar $${(q / seg.length / 1e6).toFixed(1)}M, CVD $${(d / 1e6).toFixed(1)}M`);
  }
  const cv = cvd(M15.bars.slice(-96));
  console.log(`15M CVD slope, last 24h: ${((cv[cv.length - 1] - cv[0]) / 1e6).toFixed(1)}M, last 6h: ${((cv[cv.length - 1] - cv[cv.length - 25]) / 1e6).toFixed(1)}M`);

  console.log("--- RELATIVE STRENGTH vs BTC");
  const bm = new Map(btcD.map((b) => [b.t, b.c]));
  const ratio = rd.filter((b) => bm.has(b.t)).map((b) => b.c / bm.get(b.t)!);
  const rr = Float64Array.from(ratio);
  const re = emaA(rr, 20);
  const n = rr.length - 1;
  console.log(`ratio change 1d ${pc(rr[n], rr[n - 1])}% 7d ${pc(rr[n], rr[n - 7])}% 30d ${pc(rr[n], rr[n - 30])}% | ${rr[n] > re[n] ? "above" : "below"} its 20d EMA`);
}
