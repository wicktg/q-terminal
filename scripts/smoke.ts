// Run the whole analysis pipeline against live feeds, outside Next, to catch logic errors early.
import { analyze, buildBook } from "../lib/analyze.ts";
import { depthAll } from "../lib/data.ts";
import { atr, cvd, ema, orderBlocks, rsi, volumeProfile } from "../lib/quant.ts";
import type { Bar } from "../lib/types.ts";

// deterministic unit checks
const bars: Bar[] = Array.from({ length: 120 }, (_, i) => {
  const c = 100 + Math.sin(i / 6) * 8 + i * 0.05;
  return { t: i * 3600, o: c - 0.3, h: c + 1, l: c - 1, c, v: 100, q: 100 * c, tb: 60 };
});
const assert = (ok: boolean, msg: string) => {
  if (!ok) throw new Error("FAILED: " + msg);
};
assert(Math.abs(ema([1, 1, 1, 1], 3)[3] - 1) < 1e-9, "ema of constant");
const r = rsi(bars.map((b) => b.c));
assert(r.every((x) => x === null || (x >= 0 && x <= 100)), "rsi range");
assert(atr(bars)[119] > 0, "atr positive");
assert(cvd(bars)[119] > 0, "cvd rises with 60% taker buys");
const vp = volumeProfile(bars);
assert(vp.val <= vp.poc && vp.poc <= vp.vah, "profile ordering");
orderBlocks(bars);
console.log("unit checks passed");

for (const sym of process.argv.slice(2).length ? process.argv.slice(2) : ["HYPE", "SOL", "BTC"]) {
  const t0 = Date.now();
  const a = await analyze(sym);
  const s = a.stats;
  console.log(`\n=== ${sym} ${a.price} (${Date.now() - t0}ms)`);
  console.log(`chg 24h ${s.chg24h.toFixed(2)} 7d ${s.chg7d.toFixed(2)} | beta30 ${s.beta30.toFixed(2)} alpha30 ${s.alpha30.toFixed(2)} t ${s.alpha30t.toFixed(2)} | rsi4h ${s.rsi4h.toFixed(0)} | oi $${(s.oiUsd / 1e6).toFixed(0)}M regime ${s.regime}`);
  console.log("signals:", a.signals.map((x) => `${x.key}: ${x.value} [${x.tone}]`).join(" | "));
  console.log(`OBs ${a.orderBlocks.length}: ${a.orderBlocks.map((o) => `${o.side} ${o.bottom}-${o.top}`).join(", ")}`);
  console.log(`profile POC ${a.profile.poc.toFixed(3)} VAL ${a.profile.val.toFixed(3)} VAH ${a.profile.vah.toFixed(3)} | ribbon ${a.ribbon.state} ${a.ribbon.lo.toFixed(3)}/${a.ribbon.hi.toFixed(3)}`);
  console.log(`liq clusters ${a.liq.clusters.length} shortsAbove $${(a.liq.shortsAbove / 1e6).toFixed(0)}M longsBelow $${(a.liq.longsBelow / 1e6).toFixed(0)}M skew ${a.liq.skew.toFixed(2)}`);
  const f = a.forecast;
  console.log(`forecast ${f.direction} pUp3d ${(f.pUp3d * 100).toFixed(1)}% sigmaDay ${(f.sigmaDay * 100).toFixed(2)}% analogs n=${f.analogs.n} pUp ${(f.analogs.pUp * 100).toFixed(0)}% base ${(f.analogs.base * 100).toFixed(0)}% | backtest calls ${f.backtest.calls} hit ${(f.backtest.hitRate * 100).toFixed(0)}%`);
  console.log("7d cone:", f.horizons[2].q05.toFixed(3), f.horizons[2].q50.toFixed(3), f.horizons[2].q95.toFixed(3));
  for (const f of a.ta.frames) console.log(`${f.tf.padEnd(4)} ${f.trend.padEnd(6)} ${f.event ? `${f.event.kind} ${f.event.dir > 0 ? "up" : "down"} at ${f.event.level}` : "no event"} | ${f.labels.join(" ")}`);
  for (const x of a.ta.signals) console.log(`${x.lane} ${x.trigger}/${x.bias} ${x.state} ${x.side ?? "-"} ${x.score}/${x.max} zone ${x.zone?.label ?? "-"} entry ${x.entry} stop ${x.stop} target ${x.target} rr ${x.rr?.toFixed(2)} | ${x.plan}`);
  console.log(`zones ${a.ta.zones.length}, pools ${a.ta.pools.length}`);
  const b = buildBook(await depthAll(sym), a.price, a.liq.clusters);
  console.log(`book mid ${b.mid} spread ${b.spreadBp.toFixed(2)}bp imb1 ${b.imb1.toFixed(2)} imb2 ${b.imb2.toFixed(2)} venues ${b.venues.join("/")} rows ${b.rows.length} wall ${b.walls[0]?.price} $${((b.walls[0]?.usd ?? 0) / 1e6).toFixed(1)}M`);
}
