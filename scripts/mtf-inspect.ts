// Close look at named strategies: where the result comes from, and a bootstrap projection of the next 90 days.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAMILY, runCoin, type Cfg, type Tf, type Trade } from "../lib/mtf.ts";
import { rng } from "../lib/model.ts";
import { asOfOf, dailySeries, DAY, envs, loadCoin, OUT, summary, universe, type Coin } from "./mtf-lib.ts";

const watch = universe.watch.map(loadCoin).filter((c): c is Coin => !!c);
const hold = universe.hold.map(loadCoin).filter((c): c is Coin => !!c);
const btc = watch.find((c) => c.sym === "BTC")!;
const asOf = asOfOf(btc);
const start = btc.base.t[0];
const finalFrom = asOf - 30 * DAY;
const validFrom = asOf - 210 * DAY;
for (const [tf, id] of [["1h", "cascade|1h|3,0.03|0|vhi|1.5/1/0/0/0"], ["4h", "donch|4h|100|0|vlo|1.5/0/3/0/0"]] as [Tf, string][]) {
  const g = JSON.parse(readFileSync(resolve(OUT, `gates-${tf}-n-syn.json`), "utf8")) as { results: { id: string; cfg: Cfg }[] };
  const cfg = g.results.find((r) => r.id === id)!.cfg;
  const coins = [...watch, ...hold];
  const es = envs(coins, btc, tf);
  const all: Trade[] = [];
  es.forEach((e, i) => all.push(...runCoin(e, FAMILY[cfg.fam].sig(e, cfg.p), cfg, coins[i].fund, i)));
  console.log(`\n=== ${FAMILY[cfg.fam].label} ${tf}: ${all.length} trades`);
  const line = (l: string, x: Trade[]) => {
    const s = summary(x, start, asOf + DAY);
    return `${l.padEnd(10)} n ${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(0).padStart(3)}%  avg ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)}R  total ${s.total >= 0 ? "+" : ""}${s.total.toFixed(1)}R`;
  };
  const q = new Map<string, Trade[]>();
  for (const t of all) {
    const d = new Date(t.tIn * 1000);
    const k = `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    q.set(k, [...(q.get(k) ?? []), t]);
  }
  for (const k of [...q.keys()].sort()) console.log(line(k, q.get(k)!));
  console.log("by side:");
  console.log(line("long", all.filter((t) => t.side > 0)));
  console.log(line("short", all.filter((t) => t.side < 0)));
  console.log("by coin:");
  coins.forEach((c, i) => console.log(line(c.sym, all.filter((t) => t.coin === i))));
  const sorted = [...all].sort((a, b) => b.r - a.r);
  console.log(`top 5 trades give ${sorted.slice(0, 5).reduce((s, t) => s + t.r, 0).toFixed(1)}R of ${all.reduce((s, t) => s + t.r, 0).toFixed(1)}R total; without them avg ${(sorted.slice(5).reduce((s, t) => s + t.r, 0) / (all.length - 5)).toFixed(3)}R`);
  console.log(`trades per month ${(all.length / ((asOf - start) / (30 * DAY))).toFixed(1)}`);
  // Next 90 days, resampling blocks of real days, all trades counted.
  const day = dailySeries(all, start, asOf + DAY);
  const r = rng(21);
  const totals: number[] = [];
  const dds: number[] = [];
  for (let n = 0; n < 20000; n++) {
    let [eq, peak, dd] = [0, 0, 0];
    let i = Math.floor(r() * day.length);
    for (let k = 0; k < 90; k++) {
      eq += day[i];
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak - eq);
      i = r() < 0.1 ? Math.floor(r() * day.length) : (i + 1) % day.length;
    }
    totals.push(eq);
    dds.push(dd);
  }
  totals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const qt = (a: number[], p: number) => a[Math.floor(p * a.length)].toFixed(1);
  console.log(`next 90 days if the past repeats: 5% ${qt(totals, 0.05)}R, median ${qt(totals, 0.5)}R, 95% ${qt(totals, 0.95)}R, chance of a losing quarter ${((totals.filter((x) => x <= 0).length / totals.length) * 100).toFixed(0)}%, typical max drawdown ${qt(dds, 0.5)}R, bad-case ${qt(dds, 0.95)}R`);
  console.log(`periods: earlier ${summary(all, start, validFrom).avg.toFixed(3)}R, unseen months ${summary(all, validFrom, finalFrom).avg.toFixed(3)}R, last 30 ${summary(all, finalFrom, asOf + DAY).avg.toFixed(3)}R`);
}
