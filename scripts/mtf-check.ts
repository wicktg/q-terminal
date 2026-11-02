// Does a strategy found on one coin work anywhere else, and how much of it is the coin simply trending?
import { FAMILY, EXITS, runCoin, type Cfg, type Exit } from "../lib/mtf.ts";
import { asOfOf, barsAt, DAY, envs, loadCoin, summary, universe, type Coin } from "./mtf-lib.ts";

const coins = [...universe.watch, ...universe.hold].map(loadCoin).filter((c): c is Coin => !!c);
const btc = coins.find((c) => c.sym === "BTC")!;
const asOf = asOfOf(btc);
const finalFrom = asOf - 30 * DAY;
const validFrom = asOf - 210 * DAY;
const start = btc.base.t[0];
const price = (c: Coin, T: number) => {
  const d = barsAt(c.base, "1d");
  let i = 0;
  while (i + 1 < d.n && d.t[i + 1] <= T) i++;
  return d.c[i];
};
for (const sym of ["ZEC", "HYPE"]) {
  const c = coins.find((x) => x.sym === sym)!;
  const [a, b, e] = [price(c, Math.max(start, c.base.t[0])), price(c, validFrom), price(c, finalFrom)];
  console.log(`${sym}: start ${a.toFixed(2)}, start of unseen months ${b.toFixed(2)}, end of unseen months ${e.toFixed(2)} (${((e / b - 1) * 100).toFixed(0)}%), now ${price(c, asOf).toFixed(2)}`);
}
const ex = (stop: number, hours: number): Exit => EXITS.clock.find((x) => x.stop === stop && x.hours === hours)!;
const tests: [string, Cfg][] = [
  ["Saturday 15:00 UTC long, above weekly trend, 24h exit", { fam: "clock", tf: "1h", p: { dow: 6, hour: 15 }, side: 1, htf: "wk", ex: ex(3, 24) }],
  ["Williams 0.7 breakout, above daily 50, 24h exit", { fam: "lwbreak", tf: "15m", p: { k: 0.7, noise: 0 }, side: 0, htf: "d50", ex: ex(3, 24) }],
];
for (const [label, cfg] of tests) {
  console.log(`\n${label}`);
  const es = envs(coins, btc, cfg.tf);
  let pos = 0;
  let tot = 0;
  es.forEach((e, i) => {
    const tr = runCoin(e, FAMILY[cfg.fam].sig(e, cfg.p), cfg, coins[i].fund, i);
    const [o, u, l] = [summary(tr, start, validFrom), summary(tr, validFrom, finalFrom), summary(tr, finalFrom, asOf + DAY)];
    if (u.n) {
      tot++;
      if (u.avg > 0) pos++;
    }
    console.log(`  ${coins[i].sym.padEnd(5)} older ${String(o.n).padStart(3)} ${o.avg.toFixed(2).padStart(6)}R | unseen ${String(u.n).padStart(3)} ${u.avg.toFixed(2).padStart(6)}R | last 30 ${String(l.n).padStart(2)} ${l.avg.toFixed(2).padStart(6)}R`);
  });
  console.log(`  positive on unseen months: ${pos} of ${tot} coins`);
}
