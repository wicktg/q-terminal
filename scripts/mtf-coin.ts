// One coin alone: the named strategies, then every variation searched on older data and judged on later months.
// Run: node --experimental-strip-types --no-warnings scripts/mtf-coin.ts HYPE
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAMILY, runCoin, TF_SEC, TFS, type Cfg, type Env, type Tf, type Trade } from "../lib/mtf.ts";
import { asOfOf, DAY, envs, loadCoin, OUT, summary } from "./mtf-lib.ts";

const sym = process.argv[2];
const btc = loadCoin("BTC")!;
const coin = sym === "BTC" ? btc : loadCoin(sym)!;
const asOf = asOfOf(btc);
const finalFrom = asOf - 30 * DAY;
const validFrom = asOf - 210 * DAY;
const start = coin.base.t[0];
const ENV = new Map<Tf, Env>();
const envOf = (tf: Tf) => {
  let e = ENV.get(tf);
  if (!e) ENV.set(tf, (e = envs([coin], btc, tf)[0]));
  return e;
};
const sigs = new Map<string, Int8Array>();
function trades(cfg: Cfg) {
  const e = envOf(cfg.tf);
  const k = `${cfg.tf}|${cfg.fam}|${JSON.stringify(cfg.p)}`;
  let s = sigs.get(k);
  if (!s) sigs.set(k, (s = FAMILY[cfg.fam].sig(e, cfg.p)));
  return runCoin(e, s, cfg, coin.fund, 0);
}
const fmt = (s: { n: number; avg: number; t: number; win: number }) => `${String(s.n).padStart(4)} trades ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)}R t ${s.t.toFixed(2).padStart(5)} win ${(s.win * 100).toFixed(0).padStart(3)}%`;
const periods = (tr: Trade[]) => [summary(tr, start, validFrom), summary(tr, validFrom, finalFrom), summary(tr, finalFrom, asOf + DAY)];
const when = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

console.log(`=== ${sym}: data from ${when(start)} to ${when(asOf)}`);
for (const [tf, id] of [["1h", "cascade|1h|3,0.03|0|vhi|1.5/1/0/0/0"], ["4h", "donch|4h|100|0|vlo|1.5/0/3/0/0"]] as [Tf, string][]) {
  const g = JSON.parse(readFileSync(resolve(OUT, `gates-${tf}-n-syn.json`), "utf8")) as { results: { id: string; cfg: Cfg }[] };
  const cfg = g.results.find((r) => r.id === id)!.cfg;
  const tr = trades(cfg);
  const [a, b, c] = periods(tr);
  console.log(`\n${FAMILY[cfg.fam].label} ${tf}`);
  console.log(`  older   ${fmt(a)}`);
  console.log(`  unseen  ${fmt(b)}`);
  console.log(`  last 30 ${fmt(c)}`);
  console.log("  latest trades:");
  for (const t of tr.slice(-5)) console.log(`    ${when(t.tIn)} ${t.side > 0 ? "LONG " : "SHORT"} ${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R closed ${when(t.tOut)}`);
  const e = envOf(tf as Tf);
  const open = tr.at(-1) && tr.at(-1)!.tOut >= e.b.t[e.b.n - 1];
  const sig = FAMILY[cfg.fam].sig(e, cfg.p);
  let lastI = e.b.n - 1;
  while (lastI > 0 && !sig[lastI]) lastI--;
  console.log(`  last raw signal ${when(e.b.t[lastI] + TF_SEC[e.tf])} ${sig[lastI] > 0 ? "LONG" : "SHORT"}${open ? ", position still open at the end of the data" : ", no open position"}`);
}

// Every variation on this coin alone.
type Row = { cfg: Cfg };
const files = [...TFS.map((x) => `search-${x}.json`), ...TFS.map((x) => `search-${x}-n.json`)].map((f) => resolve(OUT, f)).filter(existsSync);
const cfgs = files.flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as { rows: Row[] }).rows.map((r) => r.cfg));
const rows = cfgs.map((cfg) => {
  const tr = trades(cfg);
  const [a, b, c] = periods(tr);
  return { cfg, a, b, c };
});
const able = rows.filter((r) => r.a.n >= 20 && r.b.n >= 5);
const picks = able.filter((r) => r.a.avg >= 0.05 && r.a.t >= 2).sort((x, y) => y.a.t - x.a.t);
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
console.log(`\nvariations ${rows.length}, enough trades ${able.length}, picked on older data ${picks.length}`);
console.log(`unseen months, every variation: avg ${mean(able.map((r) => r.b.avg)).toFixed(3)}R, ${((able.filter((r) => r.b.avg > 0).length / (able.length || 1)) * 100).toFixed(0)}% positive`);
console.log(`unseen months, older-data picks: avg ${mean(picks.map((r) => r.b.avg)).toFixed(3)}R, ${((picks.filter((r) => r.b.avg > 0).length / (picks.length || 1)) * 100).toFixed(0)}% positive`);
const both = picks.filter((r) => r.b.avg > 0 && r.b.t >= 1);
console.log(`also cleared unseen months at t >= 1: ${both.length}, of those positive in the last 30 days: ${both.filter((r) => r.c.n && r.c.avg > 0).length}, last-30 avg ${mean(both.filter((r) => r.c.n).map((r) => r.c.avg)).toFixed(3)}R`);
const name = (c: Cfg) => `${c.tf} ${FAMILY[c.fam].label} ${JSON.stringify(c.p)} ${c.side === 0 ? "both" : c.side > 0 ? "long" : "short"} ${c.htf} ${c.ex.hours ? `${c.ex.stop}ATR ${c.ex.hours}h` : c.ex.target ? `${c.ex.stop}ATR ${c.ex.target}R` : `${c.ex.stop}ATR trail ${c.ex.trail}`}`;
console.log("\nbest ten on older data, and what they did next:");
for (const r of picks.slice(0, 10)) console.log(`${name(r.cfg).padEnd(62)} older ${r.a.n}/${r.a.avg.toFixed(2)}R t${r.a.t.toFixed(1)} | unseen ${r.b.n}/${r.b.avg.toFixed(2)}R t${r.b.t.toFixed(1)} | last30 ${r.c.n}/${r.c.avg.toFixed(2)}R`);
console.log("\nstrongest that cleared older data AND unseen months:");
for (const r of both.sort((x, y) => Math.min(y.a.t, y.b.t) - Math.min(x.a.t, x.b.t)).slice(0, 8)) console.log(`${name(r.cfg).padEnd(62)} older ${r.a.n}/${r.a.avg.toFixed(2)}R t${r.a.t.toFixed(1)} | unseen ${r.b.n}/${r.b.avg.toFixed(2)}R t${r.b.t.toFixed(1)} | last30 ${r.c.n}/${r.c.avg.toFixed(2)}R`);
