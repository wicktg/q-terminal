// Search stage. One process per timeframe. Only ever scores the DISCOVERY period on watchlist coins.
// Ten-day bins across everything before the last 30 days are stored, but only for overfitting statistics
// (PBO and the trial count behind deflated Sharpe). The shortlist never reads them.
// Run: node --experimental-strip-types --no-warnings scripts/mtf-search.ts 1h
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cfgId, EXITS, FAMILIES, NEW_FILTERS, NICHE, runCoin, type Cfg, type Tf, type Trade } from "../lib/mtf.ts";
import { asOfOf, DAY, envs, loadCoin, OUT, summary, universe, type Coin } from "./mtf-lib.ts";

const tf = process.argv[2] as Tf;
const only = process.argv[3]; // run one family and save it separately
const coins = universe.watch.map(loadCoin).filter((c): c is Coin => !!c);
const btc = coins.find((c) => c.sym === "BTC")!;
const asOf = asOfOf(btc);
const finalFrom = asOf - 30 * DAY;
const validFrom = asOf - 210 * DAY;
const start = btc.base.t[0];
const mid = (start + validFrom) / 2;
const es = envs(coins, btc, tf);
console.log(`${tf}: coins ${coins.length}, bars on BTC ${es.find((e) => e.sym === "BTC")?.b.n}`);

const SIDES = [0, 1, -1] as const;
const htfs = tf === "4h" || tf === "1d" ? ["none", "d50", "d2050", "btc50"] : ["none", "d50", "d2050", "btc50", "h4"];
const extraF = tf === "4h" || tf === "1d" ? ["wk", "vhi", "vlo"] : NEW_FILTERS;
const niche = only === "n"; // niche round: new families on every filter, old families on the new filters only
const BIN = 10 * DAY;
const nBins = Math.floor((finalFrom - start) / BIN);
const out: unknown[] = [];
let trials = 0;
const t0 = Date.now();
for (const fam of FAMILIES) {
  if (!fam.tfs.includes(tf)) continue;
  if (fam.id === "vote" && only !== "vote") continue;
  if (only === "lab" ? !fam.id.startsWith("lab") : only && !niche && fam.id !== only) continue;
  if (!only && fam.id.startsWith("lab")) continue;
  if (only === "n" && fam.id.startsWith("lab")) continue;
  if (!only && NICHE.has(fam.id)) continue;
  if (fam.id === "smc" && only !== "smc") continue;
  if (only === "n" && fam.id === "smc") continue;
  const filters = only === "smc" || only === "lab" ? ["none", "d50"] : !niche ? htfs : NICHE.has(fam.id) ? [...htfs, ...extraF] : extraF;
  for (const p of fam.grid) {
    const sigs = es.map((e) => fam.sig(e, p));
    for (const htf of filters)
      for (const side of SIDES)
        for (const ex of EXITS[fam.kind]) {
          const cfg: Cfg = { fam: fam.id, tf, p, side, htf, ex };
          const all: Trade[] = [];
          const perCoin: number[] = [];
          es.forEach((e, i) => {
            const tr = runCoin(e, sigs[i], cfg, coins[i].fund, i, { to: finalFrom });
            perCoin.push(tr.filter((x) => x.tIn < validFrom).reduce((s, x) => s + x.r, 0));
            for (const x of tr) all.push(x);
          });
          trials++;
          const d = summary(all, start, validFrom);
          if (!d.n) continue;
          const bins = new Array<number>(nBins).fill(0);
          for (const x of all) {
            const k = Math.floor((x.tOut - start) / BIN);
            if (k >= 0 && k < nBins) bins[k] += x.r;
          }
          out.push({
            id: cfgId(cfg),
            cfg,
            n: d.n,
            win: +d.win.toFixed(3),
            avg: +d.avg.toFixed(4),
            t: +d.t.toFixed(3),
            pos: perCoin.filter((v) => v > 0).length,
            h1: +summary(all, start, mid).avg.toFixed(4),
            h2: +summary(all, mid, validFrom).avg.toFixed(4),
            bins: bins.map((v) => +v.toFixed(2)),
          });
        }
    console.log(`${tf} ${fam.id} ${JSON.stringify(p)} done, trials ${trials}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, `search-${tf}${only ? `-${only}` : ""}.json`), JSON.stringify({ tf, trials, asOf, start, validFrom, finalFrom, nBins, rows: out }));
console.log(`${tf} finished: ${trials} trials`);
