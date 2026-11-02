// Structure confluence results: the shortlist, plus how the score itself relates to outcomes.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT } from "./mtf-lib.ts";

type S = { n: number; avg: number; t: number; win: number };
type R = { id: string; disc: S; valid: S; hold: S; final: S; gates: Record<string, boolean>; passedCount: number; detail: Record<string, number> };
for (const tf of ["4h", "1h", "15m"]) {
  const f = resolve(OUT, `gates-${tf}-smc.json`);
  if (!existsSync(f)) continue;
  const g = JSON.parse(readFileSync(f, "utf8")) as { shortlist: number; pbo: Record<string, number>; results: R[] };
  const s = JSON.parse(readFileSync(resolve(OUT, `search-${tf}-smc.json`), "utf8")) as { rows: { id: string; n: number; avg: number; t: number; pos: number; h1: number; h2: number }[] };
  const pos = s.rows.filter((r) => r.n >= 60 && r.avg > 0);
  console.log(`\n=== ${tf}: scored ${s.rows.length}, positive with 60+ trades ${pos.length}, shortlisted ${g.shortlist}, PBO ${g.pbo.smc}`);
  for (const r of [...s.rows].filter((x) => x.n >= 60).sort((a, b) => b.t - a.t).slice(0, 5)) console.log(`  older best ${r.id.padEnd(40)} n ${r.n} avg ${r.avg.toFixed(3)} t ${r.t.toFixed(2)} coins+ ${r.pos} halves ${r.h1.toFixed(2)}/${r.h2.toFixed(2)}`);
  for (const r of g.results.sort((a, b) => b.passedCount - a.passedCount).slice(0, 8)) console.log(`  ${r.passedCount}/12 ${r.id.padEnd(38)} older ${r.disc.n}/${r.disc.avg.toFixed(2)} unseen ${r.valid.n}/${r.valid.avg.toFixed(2)} t${r.valid.t.toFixed(1)} coins ${r.hold.n}/${r.hold.avg.toFixed(2)} last30 ${r.final.n}/${r.final.avg.toFixed(2)} fail ${Object.entries(r.gates).filter(([, v]) => !v).map(([k]) => k).join(" ")}`);
}
