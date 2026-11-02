// Lookahead test: every family, every timeframe, every HTF filter must give the same answer with the future deleted.
import { FAMILIES, TF_SEC, TFS, type Cols } from "../lib/mtf.ts";
import { barsAt, envs, loadCoin, type Coin } from "./mtf-lib.ts";

const coins = ["BTC", "ETH"].map(loadCoin).filter((c): c is Coin => !!c);
const cutBase = (b: Cols, T: number): Cols => {
  let n = 0;
  while (n < b.n && b.t[n] < T) n++;
  return { n, t: b.t.subarray(0, n), o: b.o.subarray(0, n), h: b.h.subarray(0, n), l: b.l.subarray(0, n), c: b.c.subarray(0, n), v: b.v.subarray(0, n), q: b.q.subarray(0, n), tb: b.tb.subarray(0, n) };
};
let checked = 0;
let bad = 0;
for (const tf of TFS) {
  const span = TF_SEC[tf];
  const full = envs(coins, coins[0], tf);
  const last = coins[0].base.t[coins[0].base.n - 1];
  // Cut points on this timeframe's bar edges, including UTC day boundaries.
  for (const T of [last - 200 * 86400, last - 77 * 86400 + 13 * 3600, last - 9 * 86400 + 5 * 3600].map((x) => x - (x % span))) {
    const cut = coins.map((c) => ({ ...c, base: cutBase(c.base, T), oi: c.oi.filter((x) => x.t + 3600 <= T) }));
    const part = envs(cut, cut[0], tf);
    for (let ci = 0; ci < coins.length; ci++) {
      const [a, b] = [full[ci], part[ci]];
      if (b.b.n < 300) continue;
      for (const fam of FAMILIES) {
        if (!fam.tfs.includes(tf) || (process.argv[2] && !fam.id.startsWith(process.argv[2]))) continue;
        for (const p of fam.grid) {
          const [sa, sb] = [fam.sig(a, p), fam.sig(b, p)];
          for (let i = 0; i < b.b.n; i++) {
            checked++;
            if (sa[i] !== sb[i]) {
              if (bad++ < 12) console.log(`LEAK ${coins[ci].sym} ${tf} ${fam.id} ${JSON.stringify(p)} bar ${i} of ${b.b.n}: ${sa[i]} vs ${sb[i]}`);
              break;
            }
          }
        }
      }
      for (const k of Object.keys(a.bias)) {
        for (let i = 0; i < b.b.n; i++) {
          checked++;
          if (a.bias[k][i] !== b.bias[k][i]) {
            if (bad++ < 12) console.log(`LEAK ${coins[ci].sym} ${tf} bias ${k} bar ${i} of ${b.b.n}`);
            break;
          }
        }
      }
    }
  }
}
console.log(bad ? `FAILED: ${bad} leaks` : `no lookahead: ${checked} values identical with the future removed`);
