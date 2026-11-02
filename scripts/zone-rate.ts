// First-touch test: when price first returns to a fresh zone, does a limit order at the zone edge reach 2.5R before its stop?
// Compared with the same trade at random moments. Costs are 0.1% round trip. Stop checked first in every bar.
import { Ind, type Cols, type Tf } from "../lib/mtf.ts";
import { rng } from "../lib/model.ts";
import { walk } from "../lib/structure.ts";
import { barsAt, loadCoin, universe, type Coin } from "./mtf-lib.ts";

const R = 2.5;
const FEE = 0.001;
type Row = { r: number; side: number; kind: string; aligned: boolean; age: number };

function walkTrade(b: Cols, at: number, side: number, entry: number, stop: number) {
  const risk = side * (entry - stop);
  if (risk <= 0) return null;
  const target = entry + side * R * risk;
  const riskPct = risk / entry;
  for (let k = at; k < Math.min(b.n, at + 300); k++) {
    if (side > 0 ? b.l[k] <= stop : b.h[k] >= stop) return -1 - FEE / riskPct;
    if (k > at && (side > 0 ? b.h[k] >= target : b.l[k] <= target)) return R - FEE / riskPct;
  }
  const last = b.c[Math.min(b.n - 1, at + 299)];
  return (side * (last - entry)) / risk - FEE / riskPct;
}

function study(c: Coin, tf: Tf) {
  const b = barsAt(c.base, tf);
  const w = walk(b, 5);
  const up = walk(barsAt(c.base, "4h"), 5);
  const b4 = barsAt(c.base, "4h");
  const A = new Ind(b).atr();
  const rows: Row[] = [];
  const pl: number[] = [];
  const rand = rng(17);
  let k4 = 0;
  const seen = new Set<string>();
  for (const z of w.zones) {
    if (z.kind === "FVG") continue;
    const key = `${z.kind}${z.top}${z.bottom}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // First return to the zone: the first bar after creation that trades into its near edge.
    const edge = z.side > 0 ? z.top : z.bottom;
    let t = -1;
    for (let k = z.born + 1; k < Math.min(b.n, z.born + 400); k++) {
      if (k > z.dead) break;
      if (z.side > 0 ? b.l[k] <= edge : b.h[k] >= edge) {
        t = k;
        break;
      }
    }
    if (t < 1 || (z.side > 0 ? b.c[t - 1] <= edge : b.c[t - 1] >= edge)) continue;
    const stop = z.side > 0 ? z.bottom - 0.25 * A[t] : z.top + 0.25 * A[t];
    const r = walkTrade(b, t, z.side, edge, stop);
    if (r === null) continue;
    k4 = 0;
    while (k4 + 1 < b4.n && b4.t[k4 + 1] + 14400 <= b.t[t]) k4++;
    rows.push({ r, side: z.side, kind: z.kind, aligned: up.trend[k4] === z.side, age: t - z.born });
    // Same risk and side, at a random moment.
    const at = 250 + Math.floor(rand() * (b.n - 300));
    const pct = Math.abs(edge - stop) / edge;
    const e = b.o[at];
    const p = walkTrade(b, at, z.side, e, e * (1 - z.side * pct));
    if (p !== null) pl.push(p);
  }
  return { rows, pl };
}

const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
const line = (l: string, rows: Row[], pl?: number[]) => {
  const r = rows.map((x) => x.r);
  const wins = r.filter((x) => x > 1).length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - avg(r)) ** 2, 0) / Math.max(1, r.length - 1));
  console.log(`${l.padEnd(34)} n ${String(r.length).padStart(5)}  hit 2.5R ${((wins / (r.length || 1)) * 100).toFixed(0).padStart(3)}%  avg ${avg(r) >= 0 ? "+" : ""}${avg(r).toFixed(3)}R  t ${(sd ? (avg(r) / sd) * Math.sqrt(r.length) : 0).toFixed(2).padStart(5)}${pl ? `  random ${avg(pl).toFixed(3)}R` : ""}`);
};
console.log("break-even hit rate at 2.5R is about 29% before costs");
for (const tf of ["4h", "1h"] as Tf[]) {
  console.log(`\n=== ${tf} zones, first touch`);
  const all: Row[] = [];
  const allP: number[] = [];
  const by: Record<string, { rows: Row[]; pl: number[] }> = {};
  for (const s of [...universe.watch, ...universe.hold]) {
    const c = loadCoin(s);
    if (!c) continue;
    const r = study(c, tf);
    by[s] = r;
    all.push(...r.rows);
    allP.push(...r.pl);
  }
  line("All 16 coins", all, allP);
  line("  demand (long)", all.filter((x) => x.side > 0));
  line("  supply (short)", all.filter((x) => x.side < 0));
  line("  with the 4H trend", all.filter((x) => x.aligned));
  line("  against the 4H trend", all.filter((x) => !x.aligned));
  line("  order blocks", all.filter((x) => x.kind === "OB"));
  line("  supply/demand bases", all.filter((x) => x.kind === "SD"));
  for (const s of ["ZEC", "HYPE", "LIT"]) {
    const r = by[s];
    if (!r) continue;
    line(s, r.rows, r.pl);
    line(`  ${s} demand`, r.rows.filter((x) => x.side > 0));
    line(`  ${s} supply`, r.rows.filter((x) => x.side < 0));
    line(`  ${s} with 4H trend`, r.rows.filter((x) => x.aligned));
  }
}
