// Round 3: does cross-coin momentum survive without hindsight?
// Locked BEFORE this ever ran:
//   signal   average of the 14-day and 30-day return ranks
//   universe top 40 perps by trailing 30-day volume on that date, 45+ days of history
//   book     long the top 8, short the bottom 8, equal weight, rebalanced every 7 days
//   costs    0.08% per side traded, plus actual funding
// Pass marks, all required, judged on data before the last 30 days:
//   Sharpe >= 1 and t >= 2 / positive on at least 6 of 7 rebalance weekdays /
//   Sharpe >= 0.7 with double costs / Sharpe >= 0.7 with the five best coins removed
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAY = 86400;
const w = JSON.parse(readFileSync(resolve(import.meta.dirname, "../data/wide.json"), "utf8")) as {
  asOf: number;
  bars: Record<string, { t: number; c: number; q: number }[]>;
  funding: Record<string, { t: number; r: number }[]>;
  status: Record<string, string>;
};
const asOf = Math.floor(w.asOf / 1000);
const finalFrom = asOf - 30 * DAY;
const syms = Object.keys(w.bars);
// Keyed by close time, so a value at d was known at d.
const close: Record<string, Map<number, { c: number; q: number }>> = {};
for (const s of syms) close[s] = new Map(w.bars[s].map((b) => [b.t + DAY, b]));
const lastClose = Object.fromEntries(syms.map((s) => [s, w.bars[s][w.bars[s].length - 1].t + DAY]));
const firstDay = Math.min(...syms.map((s) => w.bars[s][0].t)) + 46 * DAY;
const fundingSum = (s: string, a: number, b: number) => (w.funding[s] ?? []).filter((f) => f.t > a && f.t <= b).reduce((x, f) => x + f.r, 0);

type Cfg = { rank: string; top: number; each: number; hold: number; cost: number; offset: number; skip: Set<string>; leg: "both" | "long" | "short"; look: number[]; from: number; to: number };
const LOCK: Cfg = { rank: process.argv[2] ?? "mom", top: 40, each: 8, hold: 7, cost: 0.0008, offset: 0, skip: new Set(), leg: "both", look: [14, 30], from: firstDay, to: finalFrom };

function backtest(cfg: Cfg) {
  const rets: { d: number; r: number }[] = [];
  const pnlBy: Record<string, number> = {};
  let prev = new Set<string>();
  for (let d = Math.ceil(cfg.from / DAY) * DAY + cfg.offset * DAY; d + cfg.hold * DAY <= cfg.to; d += cfg.hold * DAY) {
    const rows = syms.flatMap((s) => {
      if (cfg.skip.has(s)) return [];
      const now = close[s].get(d);
      if (!now || !cfg.look.every((L) => close[s].get(d - L * DAY)) || !close[s].get(d - 45 * DAY)) return [];
      let vol = 0;
      for (let k = 0; k < 30; k++) vol += close[s].get(d - k * DAY)?.q ?? 0;
      // A coin delisted during the hold exits at its final close.
      const end = Math.min(d + cfg.hold * DAY, lastClose[s]);
      const next = close[s].get(end);
      if (!next) return [];
      return [{ s, vol, now: now.c, ret: next.c / now.c - 1, fund: fundingSum(s, d, end), carry: fundingSum(s, d - 3 * DAY, d), moms: cfg.look.map((L) => now.c / close[s].get(d - L * DAY)!.c - 1) }];
    });
    rows.sort((a, b) => b.vol - a.vol);
    const uni = rows.slice(0, cfg.top);
    if (uni.length < cfg.top * 0.75) continue;
    const score = new Map(uni.map((x) => [x.s, 0]));
    // "carry" is Robot Wealth's ranking: long the coins paying least funding, short those paying most.
    if (cfg.rank !== "carry")
      cfg.look.forEach((_, k) => {
        [...uni].sort((a, b) => a.moms[k] - b.moms[k]).forEach((x, rank) => score.set(x.s, score.get(x.s)! + rank));
      });
    if (cfg.rank !== "mom") [...uni].sort((a, b) => b.carry - a.carry).forEach((x, rank) => score.set(x.s, score.get(x.s)! + rank * (cfg.rank === "both" ? cfg.look.length : 1)));
    uni.sort((a, b) => score.get(b.s)! - score.get(a.s)!);
    const longs = cfg.leg === "short" ? [] : uni.slice(0, cfg.each);
    const shorts = cfg.leg === "long" ? [] : uni.slice(-cfg.each);
    const n = longs.length + shorts.length;
    const book = new Set([...longs.map((x) => `L${x.s}`), ...shorts.map((x) => `S${x.s}`)]);
    const fresh = [...book].filter((x) => !prev.has(x)).length;
    const dropped = [...prev].filter((x) => !book.has(x)).length;
    prev = book;
    let pnl = -((fresh + dropped) / n) * cfg.cost;
    for (const x of longs) {
      const p = (x.ret - x.fund) / n;
      pnl += p;
      pnlBy[x.s] = (pnlBy[x.s] ?? 0) + p;
    }
    for (const x of shorts) {
      const p = (x.fund - x.ret) / n;
      pnl += p;
      pnlBy[x.s] = (pnlBy[x.s] ?? 0) + p;
    }
    rets.push({ d, r: pnl });
  }
  return { rets, pnlBy };
}

function perf(rets: { r: number }[], hold = 7) {
  const n = rets.length;
  if (!n) return { n, total: 0, sharpe: 0, t: 0, dd: 0, win: 0 };
  const m = rets.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x.r - m) ** 2, 0) / Math.max(1, n - 1));
  let [eq, peak, dd] = [0, 0, 0];
  for (const x of rets) {
    eq += x.r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return { n, total: eq, sharpe: sd ? (m / sd) * Math.sqrt(365 / hold) : 0, t: sd ? (m / sd) * Math.sqrt(n) : 0, dd, win: rets.filter((x) => x.r > 0).length / n };
}
const show = (l: string, p: ReturnType<typeof perf>) => console.log(`${l.padEnd(38)} n ${String(p.n).padStart(3)}  sum ${(p.total * 100).toFixed(1).padStart(7)}%  sharpe ${p.sharpe.toFixed(2).padStart(5)}  t ${p.t.toFixed(2).padStart(5)}  maxDD ${(p.dd * 100).toFixed(1)}%  win ${(p.win * 100).toFixed(0)}%`);

console.log(`perps ${syms.length}, not trading any more ${syms.filter((s) => w.status[s] !== "TRADING").length}`);
console.log("=== LOCKED CONFIG, everything before the last 30 days");
const main = backtest(LOCK);
const mp = perf(main.rets);
show("Locked", mp);
const half = Math.floor(main.rets.length / 2);
show("  first half", perf(main.rets.slice(0, half)));
show("  second half", perf(main.rets.slice(half)));
show("  long leg alone", perf(backtest({ ...LOCK, leg: "long" }).rets));
show("  short leg alone", perf(backtest({ ...LOCK, leg: "short" }).rets));

console.log("\n=== PASS MARKS");
const days = [0, 1, 2, 3, 4, 5, 6].map((o) => perf(backtest({ ...LOCK, offset: o }).rets));
days.forEach((p, i) => show(`  rebalance day +${i}`, p));
const dbl = perf(backtest({ ...LOCK, cost: 0.0016 }).rets);
show("  double costs", dbl);
const best = Object.entries(main.pnlBy).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log("  best contributors:", best.map(([s, v]) => `${s.replace("USDT", "")} ${(v * 100).toFixed(1)}%`).join(", "));
const noBest = perf(backtest({ ...LOCK, skip: new Set(best.map((x) => x[0])) }).rets);
show("  without the five best", noBest);
const checks: [string, boolean][] = [
  ["Sharpe >= 1 and t >= 2", mp.sharpe >= 1 && mp.t >= 2],
  ["positive on 6 of 7 weekdays", days.filter((p) => p.total > 0).length >= 6],
  ["Sharpe >= 0.7 at double costs", dbl.sharpe >= 0.7],
  ["Sharpe >= 0.7 without best five", noBest.sharpe >= 0.7],
];
for (const [l, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}`);
const passed = checks.every((c) => c[1]);
console.log(passed ? "  VERDICT: PASSED" : "  VERDICT: FAILED");

console.log("\n=== NEIGHBOURS, to see if the lock sits on a plateau or a spike");
for (const [look, each, hold] of [[[7], 8, 7], [[14], 8, 7], [[30], 8, 7], [[60], 8, 7], [[14, 30], 4, 7], [[14, 30], 12, 7], [[14, 30], 8, 3], [[14, 30], 8, 14]] as [number[], number, number][]) {
  show(`  look ${look.join("+")} each ${each} hold ${hold}`, perf(backtest({ ...LOCK, look, each, hold }).rets, hold));
}

console.log("\n=== FINAL: last 30 days, read once");
const f = backtest({ ...LOCK, from: finalFrom, to: asOf });
show("Locked, last 30 days", perf(f.rets));
f.rets.forEach((x) => console.log(`  ${new Date(x.d * 1000).toISOString().slice(0, 10)}  ${(x.r * 100).toFixed(2)}%`));
