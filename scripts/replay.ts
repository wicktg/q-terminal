// Stage 1 of the backtest: rebuild what the live engine would have said at every 4h close.
// Each snapshot only sees data dated before that moment.
// Run: node --experimental-strip-types --no-warnings scripts/replay.ts SYM [days]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Bar } from "../lib/types.ts";
import { readMarket } from "../lib/engine.ts";
import { buildSetups, clamp, driftOf } from "../lib/model.ts";

const H4 = 14400;
const DAY = 86400;
const round = (x: number) => +x.toFixed(4);

export function aggregate(bars: Bar[], span: number) {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = b.t - (b.t % span);
    const l = out[out.length - 1];
    if (l && l.t === t) {
      l.h = Math.max(l.h, b.h);
      l.l = Math.min(l.l, b.l);
      l.c = b.c;
      l.v += b.v;
      l.q += b.q;
      l.tb += b.tb;
    } else out.push({ ...b, t });
  }
  return out;
}

// Rows dated at or before T: the last index found with a moving pointer.
function upTo<T extends { t: number }>(rows: T[], T: number, from: number) {
  let i = from;
  while (i + 1 < rows.length && rows[i + 1].t <= T) i++;
  return i;
}

const sym = process.argv[2];
const days = Number(process.argv[3] ?? 400);
const dir = resolve(import.meta.dirname, "../data");
const h = JSON.parse(readFileSync(resolve(dir, "history", `${sym}.json`), "utf8"));
const perp: Bar[] = h.perp;
const spot: Bar[] = h.spot;
const b4All = aggregate(perp, H4).filter((b, i, a) => i < a.length - 1 || (b.t + H4) * 1000 <= h.asOf);
const fullBars = new Map<number, number>();
for (const b of perp) fullBars.set(b.t - (b.t % H4), (fullBars.get(b.t - (b.t % H4)) ?? 0) + 1);
const dayAll = aggregate(perp, DAY);
const start = h.asOf / 1000 - days * DAY;

const oiRows: { t: number; v: number }[] = h.oi;
const by: { t: number; v: number }[] = h.bybitOi;
const retailB: { t: number; r: number }[] = h.retail;
const topB: { t: number; r: number }[] = h.top;
const retailY: { t: number; r: number }[] = h.bybitRatio;
const fund: { t: number; r: number }[] = h.funding;

const out: unknown[] = [];
let [p, sp, oiP, byP, rP, tP, yP, fP, dP] = [-1, -1, -1, -1, -1, -1, -1, -1, -1];
const t0 = Date.now();
for (let i = 0; i < b4All.length; i++) {
  const T = b4All[i].t + H4;
  p = upTo(perp, T - 3600, p);
  sp = upTo(spot, T - 3600, sp);
  oiP = upTo(oiRows, T, oiP);
  byP = upTo(by, T, byP);
  rP = upTo(retailB, T, rP);
  tP = upTo(topB, T, tP);
  yP = upTo(retailY, T, yP);
  fP = upTo(fund, T, fP);
  while (dP + 1 < dayAll.length && dayAll[dP + 1].t + DAY <= T) dP++;
  if (i < 300 || T < start || fullBars.get(b4All[i].t) !== 4) continue;

  const b1 = perp.slice(Math.max(0, p - 499), p + 1);
  const b4 = b4All.slice(Math.max(0, i - 1499), i + 1);
  // The live daily series always ends in a day still forming, so rebuild that candle.
  const today = perp.slice(Math.max(0, p - 24), p + 1).filter((b) => b.t >= T - (T % DAY));
  const forming = aggregate(today, DAY);
  const lastC = perp[p].c;
  const bd = [...dayAll.slice(Math.max(0, dP - 198), dP + 1), ...(forming.length ? forming : [{ t: T, o: lastC, h: lastC, l: lastC, c: lastC, v: 0, q: 0, tb: 0 }])];
  const spot1 = sp >= 47 ? spot.slice(sp - 47, sp + 1) : [];

  let oi4: { t: number; v: number }[] | null = null;
  let oi1: number[] | null = null;
  if (oiP >= 120) {
    oi1 = oiRows.slice(oiP - 29, oiP + 1).map((x) => x.v);
    oi4 = oiRows.slice(Math.max(0, oiP - 1079), oiP + 1).filter((x) => x.t % H4 === 0).slice(-180);
  } else if (byP >= 30) {
    oi4 = by.slice(Math.max(0, byP - 179), byP + 1);
    const [a, b] = [by[byP - 1].v, by[byP].v];
    oi1 = [0, 1, 2, 3, 4].map((k) => a + ((b - a) * k) / 4); // only 4h steps exist before Binance's window
  }
  const retail = rP >= 48 ? retailB.slice(Math.max(0, rP - 499), rP + 1).map((x) => x.r) : yP >= 30 ? retailY.slice(Math.max(0, yP - 499), yP + 1).map((x) => x.r) : null;
  const top = tP >= 25 ? topB.slice(Math.max(0, tP - 499), tP + 1).map((x) => x.r) : null;
  const perDay = fP >= 1 ? Math.round(DAY / (fund[fP].t - fund[fP - 1].t)) || 3 : 3; // some coins fund every 4h or 1h
  const fundingApr = fP >= 0 ? fund[fP].r * perDay * 365 * 100 : null;

  const r = readMarket({ b4, b1, bd, spot1, oi4, oi1, retail, top, fundingApr, hlOi: 0 });
  const seed = (sym.split("").reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7) + b4[b4.length - 1].t) >>> 0;
  const { sim, trust, a } = driftOf(b4, r.flow, seed);
  r.flow.analog = trust * clamp(((a?.pUp ?? 0.5) - (a?.base ?? 0.5)) / 0.15);
  const setups = buildSetups(r.px, r.a4, r.levels, r.flow, sim, (x) => String(x), 300);
  out.push({
    T,
    px: r.px,
    a4: r.a4,
    regime: r.regime,
    flow: Object.fromEntries(Object.entries(r.flow).map(([k, v]) => [k, round(v)])),
    tr: [r.t1, r.t4, r.tD],
    levels: r.levels.map((l) => ({ price: l.price, label: l.label, weight: l.weight })),
    setups: setups.map((s) => ({ name: s.name, side: s.side === "LONG" ? 1 : -1, zone: s.zone, entry: s.entry, stop: s.stop, t1: s.t1, score: s.score, grade: s.grade, expR: round(s.rawEv), pWin: round(s.rawWin), pReach: round(s.pReach) })),
  });
}
mkdirSync(resolve(dir, "replay"), { recursive: true });
writeFileSync(resolve(dir, "replay", `${sym}.json`), JSON.stringify(out));
console.log(`${sym} snapshots ${out.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
