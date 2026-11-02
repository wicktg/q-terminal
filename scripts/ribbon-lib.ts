// Ribbon and taker-flow helpers shared by the single-coin strategy tests.
import type { Cols } from "../lib/mtf.ts";

// Ribbon at every bar, point in time: anchors are the high and low of the previous N bars.
export function ribbon(b: Cols, N: number) {
  const { n, h, l, c, v } = b;
  const pv = new Float64Array(n + 1);
  const vv = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    pv[i + 1] = pv[i] + ((h[i] + l[i] + c[i]) / 3) * v[i];
    vv[i + 1] = vv[i] + v[i];
  }
  const top = new Float64Array(n).fill(NaN);
  const bot = new Float64Array(n).fill(NaN);
  const dHi: number[] = [];
  const dLo: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dHi.length && dHi[0] <= i - N) dHi.shift();
    while (dLo.length && dLo[0] <= i - N) dLo.shift();
    while (dHi.length && h[dHi[dHi.length - 1]] <= h[i]) dHi.pop();
    while (dLo.length && l[dLo[dLo.length - 1]] >= l[i]) dLo.pop();
    dHi.push(i);
    dLo.push(i);
    if (i < N) continue;
    const at = (a: number) => (pv[i + 1] - pv[a]) / (vv[i + 1] - vv[a] || 1);
    const [x, y] = [at(dHi[0]), at(dLo[0])];
    top[i] = Math.max(x, y);
    bot[i] = Math.min(x, y);
  }
  return { top, bot };
}

export function deltaShare(b: Cols, k: number) {
  const a = new Float64Array(b.n);
  let [d, v] = [0, 0];
  for (let i = 0; i < b.n; i++) {
    d += 2 * b.tb[i] - b.v[i];
    v += b.v[i];
    if (i >= k) {
      d -= 2 * b.tb[i - k] - b.v[i - k];
      v -= b.v[i - k];
    }
    a[i] = v ? d / v : 0;
  }
  return a;
}
