// Lookahead test: a snapshot built with the future deleted must equal the same snapshot built with it present.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "../data");
const sym = process.argv[2] ?? "BTC";
const run = (s: string) => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", resolve(import.meta.dirname, "replay.ts"), s, "30"], { stdio: "pipe" });
run(sym);
const full = JSON.parse(readFileSync(resolve(dir, "replay", `${sym}.json`), "utf8"));
const h = JSON.parse(readFileSync(resolve(dir, "history", `${sym}.json`), "utf8"));
const FAKE = "ZZTEST";
let checked = 0;
for (const idx of [40, 90, 140, 175]) {
  const snap = full[idx];
  const T = snap.T;
  // Keep only what existed at T. Bars are dated by open time, so a bar opening at T is already the future.
  const cut = {
    ...h,
    sym: FAKE,
    asOf: T * 1000,
    perp: h.perp.filter((x: { t: number }) => x.t < T),
    spot: h.spot.filter((x: { t: number }) => x.t < T),
    funding: h.funding.filter((x: { t: number }) => x.t <= T),
    oi: h.oi.filter((x: { t: number }) => x.t <= T),
    retail: h.retail.filter((x: { t: number }) => x.t <= T),
    top: h.top.filter((x: { t: number }) => x.t <= T),
    bybitOi: h.bybitOi.filter((x: { t: number }) => x.t <= T),
    bybitRatio: h.bybitRatio.filter((x: { t: number }) => x.t <= T),
  };
  writeFileSync(resolve(dir, "history", `${FAKE}.json`), JSON.stringify(cut));
  run(FAKE);
  const r = JSON.parse(readFileSync(resolve(dir, "replay", `${FAKE}.json`), "utf8"));
  const got = r[r.length - 1];
  if (got.T !== T) throw new Error(`last snapshot ${got.T} is not ${T}`);
  for (const k of ["px", "a4", "regime"]) if (JSON.stringify(got[k]) !== JSON.stringify(snap[k])) throw new Error(`LEAK in ${k} at ${T}: ${got[k]} vs ${snap[k]}`);
  if (JSON.stringify(got.flow) !== JSON.stringify(snap.flow)) throw new Error(`LEAK in flow at ${T}: ${JSON.stringify(got.flow)} vs ${JSON.stringify(snap.flow)}`);
  if (JSON.stringify(got.levels) !== JSON.stringify(snap.levels)) throw new Error(`LEAK in levels at ${T}`);
  checked++;
}
rmSync(resolve(dir, "history", `${FAKE}.json`));
rmSync(resolve(dir, "replay", `${FAKE}.json`));
console.log(`no lookahead: ${checked} snapshots identical with the future removed`);
