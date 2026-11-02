// Shared loading and reporting for the backtest scripts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Bar } from "../lib/types.ts";
import { COST, HOUR, series, stats, type Cand, type Series, type Trade } from "../lib/backtest.ts";
import { rng } from "../lib/model.ts";

export const LIST = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NEAR", "ENA", "LIT", "XRP", "DOGE", "BNB", "SUI", "LINK", "AVAX"];
const dir = resolve(import.meta.dirname, "../data");

export function load(syms = LIST) {
  const data: Record<string, Series> = {};
  const cands: Cand[] = [];
  let asOf = 0;
  for (const sym of syms) {
    const hf = resolve(dir, "history", `${sym}.json`);
    const rf = resolve(dir, "replay", `${sym}.json`);
    if (!existsSync(hf) || !existsSync(rf)) continue;
    const h = JSON.parse(readFileSync(hf, "utf8"));
    asOf = Math.max(asOf, Math.floor(h.asOf / 1000));
    data[sym] = series(h.perp as Bar[], h.funding);
    type Snap = Omit<Cand, "sym" | "rank" | "name" | "side" | "zone" | "entry" | "stop" | "t1" | "score" | "grade" | "expR" | "pWin" | "pReach"> & { tr: string[]; setups: Pick<Cand, "name" | "side" | "zone" | "entry" | "stop" | "t1" | "score" | "grade" | "expR" | "pWin" | "pReach">[] };
    for (const s of JSON.parse(readFileSync(rf, "utf8")) as Snap[]) {
      s.setups.forEach((x, rank) => cands.push({ sym, T: s.T, rank, px: s.px, a4: s.a4, flow: s.flow, regime: s.regime, levels: s.levels, tr: s.tr, ...x } as Cand));
    }
  }
  cands.sort((a, b) => a.T - b.T || a.rank - b.rank);
  return { data, cands, asOf };
}

export const row = (label: string, tr: Trade[]) => {
  const s = stats(tr);
  return `${label.padEnd(26)} n ${String(s.n).padStart(5)}  win ${(s.win * 100).toFixed(0).padStart(3)}%  avg ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(3)}R  total ${s.total >= 0 ? "+" : ""}${s.total.toFixed(1).padStart(6)}R  pf ${s.pf.toFixed(2)}  t ${s.t.toFixed(2).padStart(5)}  dd ${s.dd.toFixed(1)}R`;
};

export function groupRows(title: string, tr: Trade[], key: (t: Trade) => string) {
  console.log(`\n--- ${title}`);
  const g = new Map<string, Trade[]>();
  for (const t of tr) g.set(key(t), [...(g.get(key(t)) ?? []), t]);
  for (const k of [...g.keys()].sort()) console.log(row(k, g.get(k)!));
}

// Same coin, same direction, same stop distance and reward, same holding time, but a random moment.
// What is left over beats chance only if the setup picked better moments than a coin flip on timing.
export function nullTest(tr: Trade[], data: Record<string, Series>, from: number, to: number, runs = 300, seed = 11) {
  const r = rng(seed);
  const actual = stats(tr).avg;
  const means: number[] = [];
  const fee = COST.taker + COST.slip + COST.maker;
  for (let n = 0; n < runs; n++) {
    let sum = 0;
    let cnt = 0;
    for (const t of tr) {
      const s = data[t.sym];
      const lo = s.bars.findIndex((b) => b.t >= from);
      let hi = s.bars.length - 1;
      while (hi > 0 && s.bars[hi].t > to) hi--;
      if (lo < 0 || hi <= lo) continue;
      const i = lo + Math.floor(r() * (hi - lo));
      const e = s.bars[i].o;
      const riskPct = Math.abs(t.entry - t.stop) / t.entry;
      const stop = e * (1 - t.side * riskPct);
      const tgt = e * (1 + (t.side * riskPct * Math.abs(t.target - t.entry)) / Math.abs(t.entry - t.stop));
      const end = Math.min(s.bars.length - 1, i + Math.round((t.tOut - t.tIn) / HOUR));
      let exit = s.bars[end].c;
      for (let k = i; k <= end; k++) {
        const b = s.bars[k];
        if (t.side > 0 ? b.l <= stop : b.h >= stop) {
          exit = stop;
          break;
        }
        if (k > i && (t.side > 0 ? b.h >= tgt : b.l <= tgt)) {
          exit = tgt;
          break;
        }
      }
      sum += (t.side * (exit / e - 1) - fee) / riskPct;
      cnt++;
    }
    if (cnt) means.push(sum / cnt);
  }
  means.sort((a, b) => a - b);
  return { mean: means.reduce((s, x) => s + x, 0) / (means.length || 1), p: means.filter((x) => x >= actual).length / (means.length || 1), q95: means[Math.floor(means.length * 0.95)] ?? 0 };
}
