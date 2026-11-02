// Stage 3: tuning rounds. Three separate periods, each with one job:
//   DISCOVERY  where ideas may be searched freely
//   VALIDATION decides which survivors are real; it is never searched
//   FINAL      the last 30 days, only read once a rule is locked
// Parameters are shared across coins: one coin has too few trades to tune alone.
import { run, stats, type Trade } from "../lib/backtest.ts";
import { FAMILIES } from "../lib/signals.ts";
import { load, row } from "./bt-load.ts";
import { variants } from "./variants.ts";

const DAY = 86400;
const { data, cands, asOf } = load();
const finalFrom = asOf - 30 * DAY;
const validFrom = asOf - 210 * DAY;
const start = cands[0].T;
const inPeriod = (a: number, b: number) => (t: Trade) => t.T >= a && t.T < b;
const disc = inPeriod(0, validFrom);
const valid = inPeriod(validFrom, finalFrom);
const { sig, tests } = variants(cands, start);

const line = (l: string, x: ReturnType<typeof stats>) => `${l.padEnd(62)} n ${String(x.n).padStart(4)} win ${(x.win * 100).toFixed(0).padStart(3)}% avg ${x.avg >= 0 ? "+" : ""}${x.avg.toFixed(3)}R t ${x.t.toFixed(2).padStart(5)} dd ${x.dd.toFixed(1)}`;
console.log(`round 1: ${tests.length} variations, discovery only`);
const scored = tests.map((t) => {
  const tr = run(t.pool, data, t.rule, t.pass);
  return { t, tr, s: stats(tr.filter(disc)) };
});
const ranked = scored.filter((x) => x.s.n >= 60).sort((a, b) => b.s.t - a.s.t);
console.log(`positive on discovery with 60+ trades: ${ranked.filter((x) => x.s.avg > 0).length} of ${scored.filter((x) => x.s.n >= 60).length}`);
const expectBest = Math.sqrt(2 * Math.log(tests.length));
console.log(`best t a pure-noise search of this size should reach by luck: about ${expectBest.toFixed(2)}`);
console.log(`\n--- top 25 on DISCOVERY, with what they then did on VALIDATION (never searched)`);
for (const x of ranked.slice(0, 25)) {
  const v = stats(x.tr.filter(valid));
  console.log(line(x.t.label, x.s));
  console.log(line("   validation", v));
}

// How much does a good discovery result tell you about validation?
const pairs = ranked.map((x) => [x.s.avg, stats(x.tr.filter(valid)).avg]).filter(([, v]) => Number.isFinite(v));
const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
let [sxy, sxx, syy] = [0, 0, 0];
for (const [a, b] of pairs) {
  sxy += (a - mx) * (b - my);
  sxx += (a - mx) ** 2;
  syy += (b - my) ** 2;
}
console.log(`\nrank link, discovery avg to validation avg across ${pairs.length} variations: corr ${(sxy / Math.sqrt(sxx * syy)).toFixed(2)}`);

// Survivors: must clear luck on discovery and stay positive on validation.
const hurdle = 2.5;
const survivors = ranked.filter((x) => x.s.t >= hurdle).map((x) => ({ ...x, v: stats(x.tr.filter(valid)) })).filter((x) => x.v.n >= 20 && x.v.avg > 0 && x.v.t >= 1);
console.log(`\n--- survivors: discovery t >= ${hurdle}, validation positive with t >= 1: ${survivors.length}`);
const seenFam = new Map<string, number>();
for (const x of survivors.sort((a, b) => b.v.t - a.v.t)) {
  const fam = x.t.label.split(" stop")[0];
  seenFam.set(fam, (seenFam.get(fam) ?? 0) + 1);
  if ((seenFam.get(fam) ?? 0) <= 4) {
    console.log(line(x.t.label, x.s));
    console.log(line("   validation", x.v));
  }
}
console.log("\nfamilies among survivors:", [...seenFam.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "none");

// Family table with one plain default, so a family's result does not depend on picking the best knob.
console.log(`\n--- plain default for each family (stop 1.5 ATR, target 2R, hold 72h)`);
for (const fam of FAMILIES) {
  const tr = run(sig, data, { entry: "limit", valid: 1, hold: 72, stopAtr: 1.5, target: 2 }, (c) => c.name === fam);
  console.log(row(`${fam} discovery`, tr.filter(disc)));
  console.log(row(`${fam} validation`, tr.filter(valid)));
}
