// Every rule variation the tuning rounds search over.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Bar } from "../lib/types.ts";
import type { Cand, Rule } from "../lib/backtest.ts";
import { FAMILIES, signalCands } from "../lib/signals.ts";
import { LIST } from "./bt-load.ts";

const DAY = 86400;

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

export type Test = { label: string; rule: Rule; pass: (c: Cand) => boolean; pool: Cand[] };

export function variants(cands: Cand[], start: number) {
  const sig: Cand[] = [];
  for (const sym of LIST) {
    const h = JSON.parse(readFileSync(resolve(import.meta.dirname, "../data/history", `${sym}.json`), "utf8"));
    sig.push(...signalCands(sym, aggregate(h.perp, 14400), aggregate(h.perp, DAY), h.funding, h.bybitOi, start));
  }
  sig.sort((a, b) => a.T - b.T);
  const tests: Test[] = [];
  for (const entry of ["limit", "confirm"] as const)
    for (const stopAtr of [null, 1, 1.5, 2])
      for (const target of ["level", 1, 1.5, 2, 3] as const)
        for (const hold of [48, 168])
          for (const valid of [24, 72])
            for (const name of ["Pullback long", "Rejection short", "Breakdown short", "Breakout-retest long"]) {
              const rule: Rule = { entry, valid, hold, stopAtr, target };
              const key = `${name} ${entry} stop${stopAtr ?? "eng"} tgt${target} hold${hold} valid${valid}`;
              tests.push({ label: key, rule, pass: (c) => c.name === name, pool: cands });
              tests.push({ label: `${key} withTrend`, rule, pass: (c) => c.name === name && c.side * c.flow.trend > 0.3, pool: cands });
              tests.push({ label: `${key} counterTrend`, rule, pass: (c) => c.name === name && c.side * c.flow.trend < -0.3, pool: cands });
              tests.push({ label: `${key} topOnly`, rule, pass: (c) => c.name === name && c.rank === 0, pool: cands });
            }
  for (const fam of FAMILIES)
    for (const stopAtr of [1, 1.5, 2, 3])
      for (const target of [1, 1.5, 2, 3, 5])
        for (const hold of [24, 72, 168]) {
          const rule: Rule = { entry: "limit", valid: 1, hold, stopAtr, target };
          const key = `${fam} stop${stopAtr} tgt${target} hold${hold}`;
          tests.push({ label: key, rule, pass: (c) => c.name === fam, pool: sig });
          tests.push({ label: `${key} long`, rule, pass: (c) => c.name === fam && c.side > 0, pool: sig });
          tests.push({ label: `${key} short`, rule, pass: (c) => c.name === fam && c.side < 0, pool: sig });
        }
  return { sig, tests };
}
