// Merges the gate results and prints the intersection.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAMILY, TFS, type Cfg } from "../lib/mtf.ts";
import { OUT } from "./mtf-lib.ts";

type S = { n: number; win: number; avg: number; t: number; total: number };
type R = { id: string; cfg: Cfg; disc: S; valid: S; hold: S; final: S; finalHold: S; gates: Record<string, boolean>; detail: Record<string, number>; passed: boolean; passedCount: number };
const files = [...TFS.map((x) => resolve(OUT, `gates-${x}.json`)), resolve(OUT, "gates-1h-vote.json"), ...TFS.map((x) => resolve(OUT, `gates-${x}-n.json`)), ...TFS.map((x) => resolve(OUT, `gates-${x}-smc.json`)), ...TFS.map((x) => resolve(OUT, `gates-${x}-lab.json`))].filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")) as { tf: string; totalTrials: number; rho: number; N: number; shortlist: number; results: R[] });
const all = files.flatMap((f) => f.results);
const NAMES: Record<string, string> = { G1: "unseen months", G2: "unseen coins", G3: "time blocks", G4: "overfit probability", G5: "deflated Sharpe", G6: "double cost and late entry", G7: "parameter jitter", G8: "both BTC regimes", G9: "alpha beyond BTC", G10: "block bootstrap", G11: "random timing", G12: "synthetic paths" };
console.log(`trials ${files[0]?.totalTrials}, average correlation ${files[0]?.rho.toFixed(2)}, effective trials ${files[0]?.N.toFixed(0)}, shortlisted ${all.length}`);
console.log("\n--- by timeframe");
for (const f of files) console.log(`${f.tf.padEnd(4)} shortlisted ${String(f.shortlist).padStart(3)}  all 12 passed ${f.results.filter((r) => r.passed).length}  best ${Math.max(0, ...f.results.map((r) => r.passedCount))}/12`);
console.log("\n--- how many pass each gate alone");
for (const [k, v] of Object.entries(NAMES)) console.log(`${k.padEnd(4)} ${v.padEnd(28)} ${String(all.filter((r) => r.gates[k]).length).padStart(4)} of ${all.length}`);
const label = (r: R) => {
  const c = r.cfg;
  const dir = c.side === 0 ? "both" : c.side > 0 ? "long" : "short";
  const ex = c.ex.hours ? `${c.ex.stop}ATR stop, exit after ${c.ex.hours}h` : c.ex.target ? `${c.ex.stop}ATR stop, ${c.ex.target}R target` : `${c.ex.stop}ATR stop, ${c.ex.trail}ATR trail${c.ex.be ? ", breakeven at 1R" : ""}`;
  return `${c.tf} ${FAMILY[c.fam].label} ${JSON.stringify(c.p)} ${dir} filter ${c.htf} | ${ex}`;
};
const show = (r: R) => {
  const d = r.detail;
  console.log(`\n${r.passedCount}/12  ${label(r)}`);
  console.log(`  discovery ${r.disc.n} trades ${r.disc.avg.toFixed(3)}R t ${r.disc.t.toFixed(2)} | unseen months ${r.valid.n} trades ${r.valid.avg.toFixed(3)}R t ${r.valid.t.toFixed(2)} | unseen coins ${r.hold.n} trades ${r.hold.avg.toFixed(3)}R t ${r.hold.t.toFixed(2)} (${d.holdPos}/${d.holdCoins} positive)`);
  console.log(`  blocks ${d.blocksPos}/8  PBO ${d.pbo}  DSR ${d.dsr}  2x cost ${d.costAvg}R  late entry ${d.delayAvg}R  jitter ${d.jitterPos} med ${d.jitterMed}  BTC up ${d.upAvg}R/${d.upN} down ${d.dnAvg}R/${d.dnN}  alpha t ${d.alphaT} beta ${d.beta}  boot p ${d.bootP}  rand95 ${d.rand95} vs ${d.actual}  syn90 ${d.syn90 ?? "-"}`);
  console.log(`  last 30 days: watchlist ${r.final.n} trades ${r.final.avg.toFixed(3)}R, unseen coins ${r.finalHold.n} trades ${r.finalHold.avg.toFixed(3)}R`);
  console.log(`  failed: ${Object.entries(r.gates).filter(([, ok]) => !ok).map(([k]) => NAMES[k]).join(", ") || "nothing"}`);
};
const survivors = all.filter((r) => r.passed);
console.log(`\n=== SURVIVORS: ${survivors.length}`);
survivors.sort((a, b) => b.hold.t - a.hold.t).forEach(show);
console.log("\n=== CLOSEST");
[...all].filter((r) => !r.passed).sort((a, b) => b.passedCount - a.passedCount || b.hold.t - a.hold.t).slice(0, 12).forEach(show);
