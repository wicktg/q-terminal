// Stage 2: how did the engine as it stands actually do? No tuning here.
import { run, type Rule, type Trade } from "../lib/backtest.ts";
import { groupRows, load, nullTest, row } from "./bt-load.ts";

const { data, cands, asOf } = load();
const DAY = 86400;
const cut = asOf - 30 * DAY;
const start = cands[0].T;
console.log(`coins ${Object.keys(data).length}, candidates ${cands.length}, from ${new Date(start * 1000).toISOString().slice(0, 10)} to ${new Date(asOf * 1000).toISOString().slice(0, 10)}`);

const LIMIT: Rule = { entry: "limit", valid: 48, hold: 168, stopAtr: null, target: "level" };
const CONFIRM: Rule = { ...LIMIT, entry: "confirm" };
const month = (t: Trade) => new Date(t.T * 1000).toISOString().slice(0, 7);
const top = (c: { rank: number }) => c.rank === 0;

for (const [label, rule] of [["LIMIT AT ZONE", LIMIT], ["WAIT FOR THE TRIGGER", CONFIRM]] as const) {
  const all = run(cands, data, rule, top);
  const recent = all.filter((t) => t.T >= cut);
  const older = all.filter((t) => t.T < cut);
  console.log(`\n================ ${label}: the setup the terminal shows`);
  console.log(row("All history", all));
  console.log(row("Before last 30 days", older));
  console.log(row("Last 30 days", recent));
  const nAll = nullTest(all, data, start, asOf, 100);
  const nRec = nullTest(recent, data, cut, asOf, 200);
  console.log(`Random timing, all: avg ${nAll.mean.toFixed(3)}R, 95th pct ${nAll.q95.toFixed(3)}R, odds of luck ${(nAll.p * 100).toFixed(1)}%`);
  console.log(`Random timing, last 30: avg ${nRec.mean.toFixed(3)}R, 95th pct ${nRec.q95.toFixed(3)}R, odds of luck ${(nRec.p * 100).toFixed(1)}%`);
  groupRows("By setup", all, (t) => t.name);
  groupRows("By grade", all, (t) => t.cand.grade);
  groupRows("By exit", all, (t) => t.how);
  groupRows("By coin", all, (t) => t.sym);
  groupRows("By month", all, month);
  groupRows("Last 30 days by setup", recent, (t) => t.name);
  groupRows("Last 30 days by coin", recent, (t) => t.sym);
}
