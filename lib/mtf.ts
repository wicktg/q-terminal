// Multi-timeframe strategy engine. Pure, no I/O: the search, the gates and the live terminal all run this file.
// A signal fires on a closed bar and enters at the next open.
import type { Bar } from "./types.ts";
import { MEMBERS } from "./members.ts";
import { scanSmc } from "./ta.ts";
import { LAB_INFO, labGrid, labScan, type LabP } from "./lab.ts";

export const TF_SEC = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 } as const;
export type Tf = keyof typeof TF_SEC;
export const TFS = Object.keys(TF_SEC) as Tf[];

export type Cols = { n: number; t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array; q: Float64Array; tb: Float64Array };

const blank = (n: number): Cols => ({ n, t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n), q: new Float64Array(n), tb: new Float64Array(n) });

export function colsFromRows(a: Float64Array): Cols {
  const n = Math.floor(a.length / 8);
  const b = blank(n);
  for (let i = 0; i < n; i++) {
    const k = i * 8;
    b.t[i] = a[k];
    b.o[i] = a[k + 1];
    b.h[i] = a[k + 2];
    b.l[i] = a[k + 3];
    b.c[i] = a[k + 4];
    b.v[i] = a[k + 5];
    b.q[i] = a[k + 6];
    b.tb[i] = a[k + 7];
  }
  return b;
}

export function colsFromBars(bars: Bar[]): Cols {
  const b = blank(bars.length);
  bars.forEach((x, i) => {
    b.t[i] = x.t;
    b.o[i] = x.o;
    b.h[i] = x.h;
    b.l[i] = x.l;
    b.c[i] = x.c;
    b.v[i] = x.v;
    b.q[i] = x.q;
    b.tb[i] = x.tb;
  });
  return b;
}

// Only finished bars survive, so a higher timeframe can never peek at a bar still forming.
export function resample(b: Cols, span: number, base: number): Cols {
  const out = blank(Math.ceil(b.n / Math.max(1, Math.floor(span / base))) + 2);
  const need = 0.8 * (span / base);
  let m = 0;
  let i = 0;
  while (i < b.n) {
    const key = b.t[i] - (b.t[i] % span);
    let j = i;
    let [h, l, v, q, tb] = [b.h[i], b.l[i], 0, 0, 0];
    while (j < b.n && b.t[j] - (b.t[j] % span) === key) {
      if (b.h[j] > h) h = b.h[j];
      if (b.l[j] < l) l = b.l[j];
      v += b.v[j];
      q += b.q[j];
      tb += b.tb[j];
      j++;
    }
    if (j - i >= need && key + span <= b.t[b.n - 1] + base) {
      out.t[m] = key;
      out.o[m] = b.o[i];
      out.h[m] = h;
      out.l[m] = l;
      out.c[m] = b.c[j - 1];
      out.v[m] = v;
      out.q[m] = q;
      out.tb[m] = tb;
      m++;
    }
    i = j;
  }
  return { n: m, t: out.t.subarray(0, m), o: out.o.subarray(0, m), h: out.h.subarray(0, m), l: out.l.subarray(0, m), c: out.c.subarray(0, m), v: out.v.subarray(0, m), q: out.q.subarray(0, m), tb: out.tb.subarray(0, m) };
}

// ---- indicators ----------------------------------------------------------------------

export function emaA(v: Float64Array, n: number) {
  const k = 2 / (n + 1);
  const out = new Float64Array(v.length);
  let e = v[0];
  for (let i = 0; i < v.length; i++) out[i] = e = i ? v[i] * k + e * (1 - k) : v[0];
  return out;
}

export function atrA(b: Cols, n = 14) {
  const out = new Float64Array(b.n);
  let a = 0;
  for (let i = 0; i < b.n; i++) {
    const tr = i ? Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) : b.h[i] - b.l[i];
    a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}

export function rsiA(c: Float64Array, n: number) {
  const out = new Float64Array(c.length).fill(50);
  let up = 0;
  let dn = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const [u, w] = [Math.max(d, 0), Math.max(-d, 0)];
    if (i <= n) {
      up += u / n;
      dn += w / n;
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + w) / n;
    }
    if (i >= n) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

// Highest value of the previous n bars, the current bar excluded.
export function priorMax(v: Float64Array, n: number, sign = 1) {
  const out = new Float64Array(v.length).fill(NaN);
  const q = new Int32Array(v.length);
  let a = 0;
  let z = 0;
  for (let i = 0; i < v.length; i++) {
    while (a < z && q[a] < i - n) a++;
    if (i >= n) out[i] = v[q[a]];
    while (a < z && sign * v[q[z - 1]] <= sign * v[i]) z--;
    q[z++] = i;
  }
  return out;
}

export function smaA(v: Float64Array, n: number) {
  const out = new Float64Array(v.length);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    out[i] = s / Math.min(i + 1, n);
  }
  return out;
}

export class Ind {
  b: Cols;
  private m = new Map<string, Float64Array>();
  constructor(b: Cols) {
    this.b = b;
  }
  private memo(k: string, f: () => Float64Array) {
    let a = this.m.get(k);
    if (!a) this.m.set(k, (a = f()));
    return a;
  }
  ema = (n: number) => this.memo(`e${n}`, () => emaA(this.b.c, n));
  atr = () => this.memo("atr", () => atrA(this.b));
  rsi = (n: number) => this.memo(`r${n}`, () => rsiA(this.b.c, n));
  hi = (n: number) => this.memo(`hi${n}`, () => priorMax(this.b.h, n, 1));
  lo = (n: number) => this.memo(`lo${n}`, () => priorMax(this.b.l, n, -1));
  volAvg = () => this.memo("va", () => smaA(this.b.q, 20));
  // Taker buys minus taker sells as a share of volume.
  dr = () =>
    this.memo("dr", () => {
      const { n, tb, v } = this.b;
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = v[i] ? (2 * tb[i] - v[i]) / v[i] : 0;
      return a;
    });
  cvd = () =>
    this.memo("cvd", () => {
      const { n, tb, v, c } = this.b;
      const a = new Float64Array(n);
      let s = 0;
      for (let i = 0; i < n; i++) a[i] = s += (2 * tb[i] - v[i]) * c[i];
      return a;
    });
  vwapDay = () =>
    this.memo("vw", () => {
      const { n, t, h, l, c, v } = this.b;
      const a = new Float64Array(n);
      let [pv, vol, day] = [0, 0, -1];
      for (let i = 0; i < n; i++) {
        const d = Math.floor(t[i] / 86400);
        if (d !== day) {
          day = d;
          pv = 0;
          vol = 0;
        }
        pv += ((h[i] + l[i] + c[i]) / 3) * v[i];
        vol += v[i];
        a[i] = vol ? pv / vol : c[i];
      }
      return a;
    });
  // Bollinger width and where the previous bar's width ranks against the last 200 bars.
  bb = () =>
    this.memo("bbsd", () => {
      const { n, c } = this.b;
      const a = new Float64Array(n);
      let [s, s2] = [0, 0];
      for (let i = 0; i < n; i++) {
        s += c[i];
        s2 += c[i] * c[i];
        if (i >= 20) {
          s -= c[i - 20];
          s2 -= c[i - 20] * c[i - 20];
        }
        const m = Math.min(i + 1, 20);
        a[i] = Math.sqrt(Math.max(0, s2 / m - (s / m) ** 2));
      }
      return a;
    });
  bbRank = () =>
    this.memo("bbr", () => {
      const sd = this.bb();
      const m = smaA(this.b.c, 20);
      const n = sd.length;
      const a = new Float64Array(n).fill(1);
      const w = new Float64Array(n);
      for (let i = 0; i < n; i++) w[i] = m[i] ? sd[i] / m[i] : 0;
      for (let i = 201; i < n; i++) {
        let below = 0;
        for (let k = i - 200; k < i - 1; k += 4) if (w[k] < w[i - 1]) below++; // a sample of the window is enough
        a[i] = below / 50;
      }
      return a;
    });
}

// ---- strategy families ----------------------------------------------------------------

export type Params = Record<string, number>;
export type Env = {
  sym: string;
  tf: Tf;
  b: Cols;
  x: Ind;
  btc: Float64Array | null; // BTC close on this coin's bars, null for BTC itself
  oi: Float64Array | null; // OI known at each bar's close
  fund?: Float64Array | null; // latest settled funding rate known at each close
  spotC?: Float64Array | null; // spot close known at each bar's close
  spotD?: Float64Array | null; // spot taker delta over the last 24h, as a share of volume
  cb?: Float64Array | null; // Coinbase minus Binance BTC premium known at each close
  bias: Record<string, Int8Array>;
};
type Family = { id: string; label: string; kind: "trend" | "revert" | "clock" | "smc" | "lab"; tfs: Tf[]; grid: Params[]; sig: (e: Env, p: Params) => Int8Array };

const LTF: Tf[] = ["5m", "15m", "1h"];
const ALL: Tf[] = TFS;

export const FAMILIES: Family[] = [
  {
    id: "donch",
    label: "Range breakout",
    kind: "trend",
    tfs: ALL,
    grid: [{ n: 20 }, { n: 55 }, { n: 100 }],
    sig(e, p) {
      const { c, n } = e.b;
      const [hi, lo] = [e.x.hi(p.n), e.x.lo(p.n)];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (c[i] > hi[i] && c[i - 1] <= hi[i - 1]) s[i] = 1;
        else if (c[i] < lo[i] && c[i - 1] >= lo[i - 1]) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "pull",
    label: "Trend pullback",
    kind: "trend",
    tfs: ALL,
    grid: [{ f: 20, s: 50 }, { f: 50, s: 200 }],
    sig(e, p) {
      const { c, o, h, l, n } = e.b;
      const [ef, es, A] = [e.x.ema(p.f), e.x.ema(p.s), e.x.atr()];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (ef[i] > es[i] && l[i] <= ef[i] + 0.2 * A[i] && c[i] > ef[i] && c[i] > o[i]) s[i] = 1;
        else if (ef[i] < es[i] && h[i] >= ef[i] - 0.2 * A[i] && c[i] < ef[i] && c[i] < o[i]) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "squeeze",
    label: "Squeeze breakout",
    kind: "trend",
    tfs: ALL,
    grid: [{ rank: 0.1 }, { rank: 0.2 }, { rank: 0.3 }],
    sig(e, p) {
      const { c, n } = e.b;
      const [sd, m, r] = [e.x.bb(), smaA(c, 20), e.x.bbRank()];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (r[i] > p.rank) continue;
        if (c[i] > m[i] + 2 * sd[i]) s[i] = 1;
        else if (c[i] < m[i] - 2 * sd[i]) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "rsirev",
    label: "RSI snapback",
    kind: "revert",
    tfs: ALL,
    grid: [{ th: 5 }, { th: 10 }, { th: 15 }],
    sig(e, p) {
      const { c, n } = e.b;
      const [R, e200] = [e.x.rsi(2), e.x.ema(200)];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (c[i] > e200[i] && R[i] < p.th) s[i] = 1;
        else if (c[i] < e200[i] && R[i] > 100 - p.th) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "vwap",
    label: "VWAP stretch",
    kind: "revert",
    tfs: LTF,
    grid: [{ k: 2 }, { k: 3 }, { k: 4 }],
    sig(e, p) {
      const { c, n } = e.b;
      const [V, A] = [e.x.vwapDay(), e.x.atr()];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        const d = (c[i] - V[i]) / (A[i] || 1);
        const dp = (c[i - 1] - V[i - 1]) / (A[i - 1] || 1);
        if (d <= -p.k && dp > -p.k) s[i] = 1;
        else if (d >= p.k && dp < p.k) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "orb",
    label: "Session range break",
    kind: "trend",
    tfs: ["5m", "15m"],
    grid: [{ hour: 0, mins: 60 }, { hour: 8, mins: 60 }, { hour: 13.5, mins: 30 }, { hour: 13.5, mins: 60 }],
    sig(e, p) {
      const { c, h, l, t, n } = e.b;
      const tf = TF_SEC[e.tf];
      const s = new Int8Array(n);
      const start = p.hour * 3600;
      const span = p.mins * 60;
      let [day, hi, lo, done] = [-1, 0, 0, true];
      for (let i = 0; i < n; i++) {
        const d = Math.floor(t[i] / 86400);
        const sec = t[i] - d * 86400;
        if (d !== day) {
          day = d;
          hi = -Infinity;
          lo = Infinity;
          done = false;
        }
        if (sec >= start && sec + tf <= start + span) {
          hi = Math.max(hi, h[i]);
          lo = Math.min(lo, l[i]);
        } else if (!done && sec >= start + span && sec < start + span + 6 * 3600 && hi > -Infinity) {
          if (c[i] > hi) {
            s[i] = 1;
            done = true;
          } else if (c[i] < lo) {
            s[i] = -1;
            done = true;
          }
        }
      }
      return s;
    },
  },
  {
    id: "flush",
    label: "Flush reversal",
    kind: "revert",
    tfs: ALL,
    grid: [{ k: 2, vm: 2 }, { k: 2.5, vm: 3 }, { k: 3.5, vm: 3 }],
    sig(e, p) {
      const { o, h, l, c, q, n } = e.b;
      const [A, va] = [e.x.atr(), e.x.volAvg()];
      const s = new Int8Array(n);
      for (let i = 2; i < n; i++) {
        const r = h[i] - l[i];
        if (r < p.k * A[i - 1] || q[i] < p.vm * va[i - 1]) continue;
        if (o[i] - l[i] > 0.6 * r && (c[i] - l[i]) / r >= 0.35) s[i] = 1;
        else if (h[i] - o[i] > 0.6 * r && (h[i] - c[i]) / r >= 0.35) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "sweep",
    label: "Sweep and reclaim",
    kind: "revert",
    tfs: ALL,
    grid: [{ n: 30 }, { n: 60 }, { n: 96 }],
    sig(e, p) {
      const { h, l, c, n } = e.b;
      const [hi, lo] = [e.x.hi(p.n), e.x.lo(p.n)];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (l[i] < lo[i] && c[i] > lo[i]) s[i] = 1;
        else if (h[i] > hi[i] && c[i] < hi[i]) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "cvddiv",
    label: "CVD divergence",
    kind: "revert",
    tfs: ALL,
    grid: [{ n: 24 }, { n: 48 }, { n: 96 }],
    sig(e, p) {
      const { o, h, l, c, n } = e.b;
      const [hi, lo, C] = [e.x.hi(p.n), e.x.lo(p.n), e.x.cvd()];
      const [cHi, cLo] = [priorMax(C, p.n, 1), priorMax(C, p.n, -1)];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (l[i] < lo[i] && C[i] > cLo[i] && c[i] > o[i]) s[i] = 1;
        else if (h[i] > hi[i] && C[i] < cHi[i] && c[i] < o[i]) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "thrust",
    label: "Taker thrust",
    kind: "trend",
    tfs: ALL,
    grid: [{ n: 20, dr: 0.08 }, { n: 20, dr: 0.15 }, { n: 55, dr: 0.08 }],
    sig(e, p) {
      const { c, q, n } = e.b;
      const [hi, lo, D, va] = [e.x.hi(p.n), e.x.lo(p.n), e.x.dr(), e.x.volAvg()];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        if (q[i] < 1.5 * va[i - 1]) continue;
        if (c[i] > hi[i] && D[i] >= p.dr) s[i] = 1;
        else if (c[i] < lo[i] && D[i] <= -p.dr) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "lag",
    label: "BTC catch-up",
    kind: "trend",
    tfs: LTF,
    grid: [{ look: 3, z: 2 }, { look: 6, z: 2 }, { look: 6, z: 3 }],
    sig(e, p) {
      const { c, n } = e.b;
      const s = new Int8Array(n);
      const btc = e.btc;
      if (!btc) return s;
      let v = 0;
      for (let i = p.look; i < n; i++) {
        const br = Math.log(btc[i] / btc[i - p.look]);
        const cr = Math.log(c[i] / c[i - p.look]);
        v = i < 200 ? v + (br * br) / 200 : 0.995 * v + 0.005 * br * br;
        if (i < 200 || !Number.isFinite(br)) continue;
        const z = br / Math.sqrt(v || 1);
        if (z >= p.z && cr < 0.5 * br) s[i] = 1;
        else if (z <= -p.z && cr > 0.5 * br) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "oiflush",
    label: "OI flush",
    kind: "revert",
    tfs: ["15m", "1h", "4h"],
    grid: [{ drop: 0.03 }, { drop: 0.05 }, { drop: 0.08 }],
    sig(e, p) {
      const { c, n } = e.b;
      const s = new Int8Array(n);
      const oi = e.oi;
      if (!oi) return s;
      const A = e.x.atr();
      const look = Math.max(1, Math.round(14400 / TF_SEC[e.tf]));
      for (let i = look; i < n; i++) {
        if (!oi[i] || !oi[i - look]) continue;
        const ch = oi[i] / oi[i - look] - 1;
        const mv = (c[i] - c[i - look]) / (A[i] * Math.sqrt(look));
        if (ch <= -p.drop && mv <= -1.5) s[i] = 1;
        else if (ch <= -p.drop && mv >= 1.5) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "oibreak",
    label: "OI-backed breakout",
    kind: "trend",
    tfs: ["15m", "1h", "4h"],
    grid: [{ n: 20, up: 0.02 }, { n: 20, up: 0.04 }, { n: 55, up: 0.02 }],
    sig(e, p) {
      const { c, n } = e.b;
      const s = new Int8Array(n);
      const oi = e.oi;
      if (!oi) return s;
      const [hi, lo] = [e.x.hi(p.n), e.x.lo(p.n)];
      const look = Math.max(1, Math.round(14400 / TF_SEC[e.tf]));
      for (let i = look + 1; i < n; i++) {
        if (!oi[i] || !oi[i - look] || oi[i] / oi[i - look] - 1 < p.up) continue;
        if (c[i] > hi[i] && c[i - 1] <= hi[i - 1]) s[i] = 1;
        else if (c[i] < lo[i] && c[i - 1] >= lo[i - 1]) s[i] = -1;
      }
      return s;
    },
  },
  {
    id: "retest",
    label: "Break and retest",
    kind: "trend",
    tfs: ALL,
    grid: [{ piv: 5, wait: 12 }, { piv: 10, wait: 12 }, { piv: 10, wait: 24 }],
    sig(e, p) {
      const { h, l, c, n } = e.b;
      const A = e.x.atr();
      const s = new Int8Array(n);
      const k = p.piv;
      let [ph, pl] = [NaN, NaN]; // latest confirmed pivots
      let [up, upAt, dn, dnAt] = [NaN, -1, NaN, -1];
      for (let i = 2 * k; i < n; i++) {
        const m = i - k;
        let [isH, isL] = [true, true];
        for (let j = m - k; j <= m + k; j++) {
          if (j === m) continue;
          if (h[j] >= h[m]) isH = false;
          if (l[j] <= l[m]) isL = false;
        }
        if (isH) ph = h[m];
        if (isL) pl = l[m];
        if (c[i] > ph && c[i - 1] <= ph) {
          up = ph;
          upAt = i;
        }
        if (c[i] < pl && c[i - 1] >= pl) {
          dn = pl;
          dnAt = i;
        }
        if (upAt >= 0 && i > upAt && i - upAt <= p.wait && l[i] <= up + 0.1 * A[i] && c[i] > up) {
          s[i] = 1;
          upAt = -1;
        } else if (dnAt >= 0 && i > dnAt && i - dnAt <= p.wait && h[i] >= dn - 0.1 * A[i] && c[i] < dn) {
          s[i] = -1;
          dnAt = -1;
        }
      }
      return s;
    },
  },
];

// ---- niche families, from practitioner sources ------------------------------------------

const dowOf = (t: number) => (Math.floor(t / 86400) + 4) % 7; // 0 is Sunday, UTC
const hourOf = (t: number) => Math.floor((t % 86400) / 3600);
const weekOf = (t: number) => Math.floor((t / 86400 + 3) / 7); // weeks start on Monday, UTC

function rollDelta(b: Cols, look: number) {
  const a = new Float64Array(b.n);
  let [d, v] = [0, 0];
  for (let i = 0; i < b.n; i++) {
    d += 2 * b.tb[i] - b.v[i];
    v += b.v[i];
    if (i >= look) {
      d -= 2 * b.tb[i - look] - b.v[i - look];
      v -= b.v[i - look];
    }
    a[i] = v ? d / v : 0;
  }
  return a;
}

FAMILIES.push(
  {
    // Concretum: intraday trend pays most from about Sunday 7pm New York for 24 hours, the Monday Asia open.
    id: "asiaopen",
    label: "Monday Asia open trend",
    kind: "trend",
    tfs: ["15m", "1h"],
    grid: [{ n: 8 }, { n: 12 }, { n: 24 }],
    sig(e, p) {
      const { c, t, n } = e.b;
      const span = TF_SEC[e.tf];
      const [hi, lo] = [e.x.hi(p.n), e.x.lo(p.n)];
      const s = new Int8Array(n);
      for (let i = 1; i < n; i++) {
        const T = t[i] + span;
        const [dw, hr] = [dowOf(T), hourOf(T)];
        if (!((dw === 0 && hr >= 23) || (dw === 1 && hr < 23))) continue;
        if (c[i] > hi[i] && c[i - 1] <= hi[i - 1]) s[i] = 1;
        else if (c[i] < lo[i] && c[i - 1] >= lo[i - 1]) s[i] = -1;
      }
      return s;
    },
  },
  {
    // Quantpedia: buying 21:00 and selling 23:00 UTC. Padysak and Vojtko: weekends behave differently. dow -1 means every day.
    id: "clock",
    label: "Clock window",
    kind: "clock",
    tfs: ["1h"],
    grid: [{ dow: -1, hour: 21 }, { dow: 5, hour: 21 }, { dow: 0, hour: 23 }, { dow: 6, hour: 15 }, { dow: 0, hour: 15 }, { dow: -1, hour: 13 }],
    sig(e, p) {
      const { t, n } = e.b;
      const s = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        const T = t[i] + 3600;
        if (hourOf(T) === p.hour && (p.dow < 0 || dowOf(T) === p.dow)) s[i] = 1;
      }
      return s;
    },
  },
  {
    // Trader lore: weekend price away from the CME Friday close gets pulled back. CME closes 21:00 UTC and reopens 23:00 UTC Sunday.
    id: "cmegap",
    label: "CME gap fade",
    kind: "revert",
    tfs: ["1h"],
    grid: [{ x: 0.01 }, { x: 0.02 }, { x: 0.03 }],
    sig(e, p) {
      const { c, t, n } = e.b;
      const s = new Int8Array(n);
      let friday = 0;
      for (let i = 0; i < n; i++) {
        const T = t[i] + 3600;
        const [dw, hr] = [dowOf(T), hourOf(T)];
        if (dw === 5 && hr === 21) friday = c[i];
        if (dw === 0 && hr === 23 && friday) {
          const g = c[i] / friday - 1;
          if (g >= p.x) s[i] = -1;
          else if (g <= -p.x) s[i] = 1;
        }
      }
      return s;
    },
  },
  {
    // ICT and smart-money traders: a stop run through the previous day or week extreme that closes back inside.
    id: "sweephl",
    label: "Prior high/low sweep",
    kind: "revert",
    tfs: ["15m", "1h", "4h"],
    grid: [{ per: 1 }, { per: 7 }],
    sig(e, p) {
      const { h, l, c, t, n } = e.b;
      const s = new Int8Array(n);
      const key = (x: number) => (p.per >= 7 ? weekOf(x) : Math.floor(x / 86400));
      let [cur, curH, curL, prevH, prevL] = [-1, -Infinity, Infinity, NaN, NaN];
      let [didL, didH] = [false, false];
      for (let i = 0; i < n; i++) {
        const k = key(t[i]);
        if (k !== cur) {
          if (cur >= 0) {
            prevH = curH;
            prevL = curL;
          }
          cur = k;
          curH = -Infinity;
          curL = Infinity;
          didL = didH = false;
        }
        if (!didL && l[i] < prevL && c[i] > prevL) {
          s[i] = 1;
          didL = true;
        } else if (!didH && h[i] > prevH && c[i] < prevH) {
          s[i] = -1;
          didH = true;
        }
        curH = Math.max(curH, h[i]);
        curL = Math.min(curL, l[i]);
      }
      return s;
    },
  },
  {
    // Larry Williams breakout as used by Korean exchange bots: day open plus k times yesterday's range.
    // With noise set, k adapts to the 20-day noise ratio (1 minus body over range).
    id: "lwbreak",
    label: "Williams volatility breakout",
    kind: "clock",
    tfs: ["15m", "1h"],
    grid: [{ k: 0.5, noise: 0 }, { k: 0.7, noise: 0 }, { k: 1, noise: 1 }],
    sig(e, p) {
      const { o, h, l, c, t, n } = e.b;
      const s = new Int8Array(n);
      let [day, dO, dH, dL, prevR, target, done] = [-1, 0, 0, 0, 0, 0, false];
      const noise: number[] = [];
      for (let i = 0; i < n; i++) {
        const d = Math.floor(t[i] / 86400);
        if (d !== day) {
          if (day >= 0 && dH > dL) {
            noise.push(1 - Math.abs(c[i - 1] - dO) / (dH - dL));
            if (noise.length > 20) noise.shift();
            prevR = dH - dL;
          }
          day = d;
          dO = o[i];
          dH = h[i];
          dL = l[i];
          done = false;
          target = p.noise ? p.k * (noise.reduce((a, x) => a + x, 0) / (noise.length || 1)) : p.k;
        }
        dH = Math.max(dH, h[i]);
        dL = Math.min(dL, l[i]);
        if (done || !prevR) continue;
        if (c[i] > dO + target * prevR) {
          s[i] = 1;
          done = true;
        } else if (c[i] < dO - target * prevR) {
          s[i] = -1;
          done = true;
        }
      }
      return s;
    },
  },
  {
    // Santiment and trader guides: deep negative funding with rising OI is squeeze fuel. Mirrored for crowded longs.
    id: "fundsq",
    label: "Funding squeeze",
    kind: "trend",
    tfs: ["1h", "4h"],
    grid: [{ z: 1.5 }, { z: 2 }, { z: 3 }],
    sig(e, p) {
      const { c, n } = e.b;
      const s = new Int8Array(n);
      const [f, oi] = [e.fund, e.oi];
      if (!f || !oi) return s;
      const e20 = e.x.ema(20);
      const look = Math.max(1, Math.round(14400 / TF_SEC[e.tf]));
      const win = Math.round((90 * 86400) / TF_SEC[e.tf]);
      const [m, m2] = [smaA(f, win), smaA(Float64Array.from(f, (x) => x * x), win)];
      let prev = 0;
      for (let i = look; i < n; i++) {
        const sd = Math.sqrt(Math.max(0, m2[i] - m[i] ** 2));
        const z = sd ? (f[i] - m[i]) / sd : 0;
        const rising = oi[i] && oi[i - look] && oi[i] / oi[i - look] - 1 >= 0.02;
        const now = rising && z <= -p.z && f[i] < 0 && c[i] > e20[i] ? 1 : rising && z >= p.z && f[i] > 0 && c[i] < e20[i] ? -1 : 0;
        if (now && now !== prev) s[i] = now;
        prev = now;
      }
      return s;
    },
  },
  {
    // Settlement flows: fading whoever is paying, in the hour before funding is charged.
    id: "fundset",
    label: "Funding settlement fade",
    kind: "clock",
    tfs: ["1h"],
    grid: [{ min: 0.0001 }, { min: 0.0003 }, { min: 0.0006 }],
    sig(e, p) {
      const { t, n } = e.b;
      const s = new Int8Array(n);
      const f = e.fund;
      if (!f) return s;
      for (let i = 0; i < n; i++) {
        const hr = hourOf(t[i] + 3600);
        if (hr % 8 === 7 && Math.abs(f[i]) >= p.min) s[i] = f[i] > 0 ? -1 : 1;
      }
      return s;
    },
  },
  {
    // Coins that refuse to fall when BTC does tend to lead the next leg, and the reverse.
    id: "rsdown",
    label: "Strength on BTC down days",
    kind: "trend",
    tfs: ["4h", "1d"],
    grid: [{ x: 0.02 }, { x: 0.03 }, { x: 0.05 }],
    sig(e, p) {
      const { c, n } = e.b;
      const s = new Int8Array(n);
      const btc = e.btc;
      if (!btc) return s;
      const look = Math.round(86400 / TF_SEC[e.tf]);
      for (let i = look; i < n; i++) {
        const b = btc[i] / btc[i - look] - 1;
        const r = c[i] / c[i - look] - 1;
        if (b <= -p.x && r >= 0) s[i] = 1;
        else if (b >= p.x && r <= 0) s[i] = -1;
      }
      return s;
    },
  },
  {
    // A market-wide move with OI falling on the coin: forced exits across the board, not one coin's news.
    id: "cascade",
    label: "Market cascade fade",
    kind: "revert",
    tfs: ["1h", "4h"],
    grid: [{ z: 2, drop: 0.03 }, { z: 3, drop: 0.03 }, { z: 2, drop: 0.06 }],
    sig(e, p) {
      const { n } = e.b;
      const s = new Int8Array(n);
      const [btc, oi] = [e.btc, e.oi];
      if (!btc || !oi) return s;
      const look = Math.max(1, Math.round(14400 / TF_SEC[e.tf]));
      let v = 0;
      for (let i = look; i < n; i++) {
        const br = Math.log(btc[i] / btc[i - look]);
        v = i < 200 ? v + (br * br) / 200 : 0.995 * v + 0.005 * br * br;
        if (i < 200 || !oi[i] || !oi[i - look]) continue;
        const z = br / Math.sqrt(v || 1);
        const ch = oi[i] / oi[i - look] - 1;
        if (z <= -p.z && ch <= -p.drop) s[i] = 1;
        else if (z >= p.z && ch <= -p.drop) s[i] = -1;
      }
      return s;
    },
  },
  {
    // Perp below spot while price rises is a spot-led move. Perp above spot while price falls is the reverse.
    id: "basis",
    label: "Spot-led basis",
    kind: "trend",
    tfs: ["1h", "4h"],
    grid: [{ x: 0.0005 }, { x: 0.001 }, { x: 0.002 }],
    sig(e, p) {
      const { c, n } = e.b;
      const s = new Int8Array(n);
      const sp = e.spotC;
      if (!sp) return s;
      const look = Math.round(86400 / TF_SEC[e.tf]);
      let prev = 0;
      for (let i = look; i < n; i++) {
        if (!sp[i]) continue;
        const b = c[i] / sp[i] - 1;
        const now = c[i] > c[i - look] && b <= -p.x ? 1 : c[i] < c[i - look] && b >= p.x ? -1 : 0;
        if (now && now !== prev) s[i] = now;
        prev = now;
      }
      return s;
    },
  },
  {
    // Spot takers buying while perp takers sell, with price holding up: real demand under the move.
    id: "spotcvd",
    label: "Spot vs perp CVD",
    kind: "trend",
    tfs: ["1h", "4h"],
    grid: [{ x: 0.01 }, { x: 0.02 }, { x: 0.04 }],
    sig(e, p) {
      const { c, n } = e.b;
      const s = new Int8Array(n);
      const sd = e.spotD;
      if (!sd) return s;
      const pd = rollDelta(e.b, Math.round(86400 / TF_SEC[e.tf]));
      const e20 = e.x.ema(20);
      let prev = 0;
      for (let i = 1; i < n; i++) {
        const now = sd[i] >= p.x && pd[i] <= 0 && c[i] > e20[i] ? 1 : sd[i] <= -p.x && pd[i] >= 0 && c[i] < e20[i] ? -1 : 0;
        if (now && now !== prev) s[i] = now;
        prev = now;
      }
      return s;
    },
  },
  {
    // Coinbase premium flipping sign: US spot demand returning or leaving.
    id: "cbprem",
    label: "Coinbase premium flip",
    kind: "trend",
    tfs: ["1h", "4h"],
    grid: [{ x: 0.0002 }, { x: 0.0005 }, { x: 0.001 }],
    sig(e, p) {
      const { n } = e.b;
      const s = new Int8Array(n);
      if (!e.cb) return s;
      const m = emaA(e.cb, Math.max(2, Math.round(43200 / TF_SEC[e.tf])));
      let state = 0;
      for (let i = 1; i < n; i++) {
        if (m[i] >= p.x && state <= 0) {
          s[i] = 1;
          state = 1;
        } else if (m[i] <= -p.x && state >= 0) {
          s[i] = -1;
          state = -1;
        }
      }
      return s;
    },
  },
);

export const NICHE = new Set(["asiaopen", "clock", "cmegap", "sweephl", "lwbreak", "fundsq", "fundset", "rsdown", "cascade", "basis", "spotcvd", "cbprem"]);

// Consensus: when each member fired on this coin, on the 1h timeline. Members keep their own side and HTF filter.
const votesMemo = new WeakMap<Env, { fam: string; j: number; side: number }[]>();
function memberVotes(e: Env) {
  const hit = votesMemo.get(e);
  if (hit) return hit;
  const out: { fam: string; j: number; side: number }[] = [];
  const index = new Map<number, number>();
  for (let j = 0; j < e.b.n; j++) index.set(e.b.t[j] + 3600, j); // keyed by close time
  const byTf = new Map<Tf, Env>();
  for (const m of MEMBERS) {
    const fam = FAMILIES.find((f) => f.id === m.fam);
    if (!fam) continue;
    let sub = byTf.get(m.tf);
    if (!sub) {
      const b = m.tf === "1h" ? e.b : resample(e.b, TF_SEC[m.tf], 3600);
      const oi = e.oi ? new Float64Array(b.n) : null;
      if (oi) for (let i = 0; i < b.n; i++) oi[i] = e.oi![index.get(b.t[i] + TF_SEC[m.tf]) ?? 0];
      sub = { sym: e.sym, tf: m.tf, b, x: new Ind(b), btc: null, oi, bias: {} };
      byTf.set(m.tf, sub);
    }
    const sig = fam.sig(sub, m.p);
    const span = TF_SEC[m.tf];
    for (let i = 0; i < sub.b.n; i++) {
      const v = sig[i];
      if (!v || (m.side && v !== m.side)) continue;
      const j = index.get(sub.b.t[i] + span);
      if (j === undefined) continue;
      if (m.htf !== "none" && e.bias[m.htf][j] !== v) continue;
      out.push({ fam: m.fam, j, side: v });
    }
  }
  out.sort((a, b) => a.j - b.j);
  votesMemo.set(e, out);
  return out;
}

FAMILIES.push({
  id: "vote",
  label: "Consensus",
  kind: "trend",
  tfs: ["1h"],
  grid: [{ k: 2, w: 6 }, { k: 2, w: 12 }, { k: 2, w: 24 }, { k: 2, w: 48 }, { k: 3, w: 6 }, { k: 3, w: 12 }, { k: 3, w: 24 }, { k: 3, w: 48 }],
  sig(e, p) {
    const s = new Int8Array(e.b.n);
    const votes = memberVotes(e);
    const lastL = new Map<string, number>();
    const lastS = new Map<string, number>();
    let [v, prevL, prevS] = [0, 0, 0];
    for (let j = 0; j < e.b.n; j++) {
      while (v < votes.length && votes[v].j === j) {
        (votes[v].side > 0 ? lastL : lastS).set(votes[v].fam, j);
        v++;
      }
      const count = (m: Map<string, number>) => {
        let c = 0;
        for (const at of m.values()) if (j - at < p.w) c++;
        return c;
      };
      const [L, S] = [count(lastL), count(lastS)];
      if (L >= p.k && S === 0 && prevL < p.k) s[j] = 1;
      else if (S >= p.k && L === 0 && prevS < p.k) s[j] = -1;
      prevL = L;
      prevS = S;
    }
    return s;
  },
});

// Structure signals carry their own stop and target for each bar.
export const LEVELS = new WeakMap<Int8Array, { stop: Float64Array; target: Float64Array }>();
const smcGrid: Params[] = [];
for (const min of [5, 6, 7, 8]) for (const k of [8, 16]) for (const L of [3, 5]) for (const b of [1, 4, 24]) smcGrid.push({ min, k, L, b });
FAMILIES.push({
  id: "smc",
  label: "Structure confluence",
  kind: "smc",
  tfs: ["15m", "1h", "4h"],
  grid: smcGrid,
  sig(e, p) {
    if (p.b * 3600 <= TF_SEC[e.tf]) return new Int8Array(e.b.n);
    const r = scanSmc(e.b, e.tf, p as { min: number; k: number; L: number; b: number });
    LEVELS.set(r.sig, { stop: r.stop, target: r.target });
    return r.sig;
  },
});

for (const [id, info] of Object.entries(LAB_INFO))
  FAMILIES.push({
    id,
    label: info.name,
    kind: "lab",
    tfs: info.tfs,
    grid: labGrid(id) as unknown as Params[],
    sig(e, p) {
      const r = labScan(id, e, p as unknown as LabP);
      LEVELS.set(r.sig, { stop: r.stop, target: r.target });
      return r.sig;
    },
  });

export const FAMILY = Object.fromEntries(FAMILIES.map((f) => [f.id, f])) as Record<string, Family>;

// ---- exits and simulation -------------------------------------------------------------

export type Exit = { stop: number; target: number; trail: number; be: number; run: boolean; hours?: number; minR?: number };
export const EXITS: Record<"trend" | "revert" | "clock" | "smc" | "lab", Exit[]> = {
  // Lab: fixed 2.5R is his stated minimum. minR skips a structural target closer than that.
  lab: [
    { stop: 0, target: 2.5, trail: 0, be: 0, run: true },
    { stop: 0, target: 3.5, trail: 0, be: 0, run: true },
    { stop: 0, target: 0, trail: 0, be: 0, run: true, minR: 2.5 },
    { stop: 0, target: 0, trail: 3, be: 1, run: true },
    { stop: 0.25, target: 2.5, trail: 0, be: 0, run: true },
  ],
  // For structure signals, stop is the buffer past the structural stop. A target of 0 means the next liquidity.
  smc: [
    { stop: 0, target: 0, trail: 0, be: 0, run: true },
    { stop: 0.25, target: 0, trail: 0, be: 0, run: true },
    { stop: 0, target: 2, trail: 0, be: 0, run: true },
    { stop: 0, target: 3, trail: 0, be: 0, run: true },
    { stop: 0, target: 0, trail: 3, be: 1, run: true },
  ],
  clock: [
    { stop: 2, target: 0, trail: 0, be: 0, run: false, hours: 2 },
    { stop: 2, target: 0, trail: 0, be: 0, run: false, hours: 6 },
    { stop: 3, target: 0, trail: 0, be: 0, run: false, hours: 12 },
    { stop: 3, target: 0, trail: 0, be: 0, run: false, hours: 24 },
    { stop: 4, target: 0, trail: 0, be: 0, run: false, hours: 72 },
  ],
  trend: [
    { stop: 1.5, target: 0, trail: 3, be: 0, run: true },
    { stop: 2, target: 0, trail: 4.5, be: 0, run: true },
    { stop: 1.5, target: 0, trail: 2.5, be: 1, run: true },
    { stop: 2, target: 3, trail: 0, be: 0, run: false },
    { stop: 1.5, target: 2, trail: 0, be: 0, run: false },
  ],
  revert: [
    { stop: 1, target: 1, trail: 0, be: 0, run: false },
    { stop: 1.5, target: 1, trail: 0, be: 0, run: false },
    { stop: 1.5, target: 2, trail: 0, be: 0, run: false },
    { stop: 1, target: 1.5, trail: 0, be: 0, run: false },
    { stop: 2, target: 1.5, trail: 0, be: 0, run: false },
  ],
};
const MAX_BARS: Record<Tf, [number, number]> = { "5m": [288, 576], "15m": [192, 384], "1h": [168, 336], "4h": [120, 180], "1d": [60, 120] };
export const maxBars = (tf: Tf, ex: Exit) => (ex.hours ? Math.round((ex.hours * 3600) / TF_SEC[tf]) : MAX_BARS[tf][ex.run ? 1 : 0]);

export const COST = { taker: 0.0008, maker: 0.0002 }; // taker includes slippage

export type Cfg = { fam: string; tf: Tf; p: Params; side: 0 | 1 | -1; htf: string; ex: Exit };
export const cfgId = (c: Cfg) => `${c.fam}|${c.tf}|${Object.values(c.p).join(",")}|${c.side}|${c.htf}|${c.ex.stop}/${c.ex.target}/${c.ex.trail}/${c.ex.be}/${c.ex.hours ?? 0}`;

export type Fund = { t: Float64Array; cum: Float64Array };
export function fundCum(rows: { t: number; r: number }[]): Fund {
  const t = new Float64Array(rows.length);
  const cum = new Float64Array(rows.length);
  let s = 0;
  rows.forEach((x, i) => {
    t[i] = x.t;
    cum[i] = s += x.r;
  });
  return { t, cum };
}
const fundAt = (f: Fund, T: number) => {
  let [a, b] = [0, f.t.length];
  while (a < b) {
    const m = (a + b) >> 1;
    if (f.t[m] <= T) a = m + 1;
    else b = m;
  }
  return a ? f.cum[a - 1] : 0;
};

export type Trade = { coin: number; tIn: number; tOut: number; r: number; side: number; hit: number };

// Stop is checked before target on every bar. A trailing stop set at one close applies from the next bar.
export function simOne(e: Env, i0: number, side: number, ex: Exit, fund: Fund, costMult: number, delay: number, lv?: { stop: Float64Array; target: Float64Array }): Trade | null {
  const { o, h, l, c, t, n } = e.b;
  const A = e.x.atr();
  const at = i0 + 1 + delay;
  if (at >= n || !A[i0]) return null;
  const entry = o[at];
  let risk = ex.stop * A[i0];
  let sl = entry - side * risk;
  if (lv) {
    sl = lv.stop[i0] - side * ex.stop * A[i0];
    risk = side * (entry - sl);
    if (!(risk >= 0.25 * A[i0]) || risk > 6 * A[i0]) return null; // too tight for costs, or too far to size
  }
  const riskPct = risk / entry;
  let tgt = ex.target ? entry + side * ex.target * risk : NaN;
  if (lv && !ex.target && !ex.trail) {
    tgt = lv.target[i0];
    if (!(side * (tgt - entry) >= (ex.minR ?? 1.5) * risk)) return null; // no room to the next liquidity
  }
  const end = Math.min(n - 1, at + maxBars(e.tf, ex));
  let best = entry;
  let exit = NaN;
  let last = end;
  let fee = COST.taker;
  for (let k = at; k <= end; k++) {
    if (side > 0 ? l[k] <= sl : h[k] >= sl) {
      exit = side > 0 ? Math.min(sl, o[k]) : Math.max(sl, o[k]);
      last = k;
      break;
    }
    if (!Number.isNaN(tgt) && k > at && (side > 0 ? h[k] >= tgt : l[k] <= tgt)) {
      exit = tgt;
      last = k;
      fee = COST.maker;
      break;
    }
    if (side > 0 ? h[k] > best : l[k] < best) best = side > 0 ? h[k] : l[k];
    if (ex.be && side * (best - entry) >= ex.be * risk) sl = side > 0 ? Math.max(sl, entry) : Math.min(sl, entry);
    if (ex.trail) {
      const tr = best - side * ex.trail * A[k];
      sl = side > 0 ? Math.max(sl, tr) : Math.min(sl, tr);
    }
  }
  if (Number.isNaN(exit)) exit = c[end];
  const span = TF_SEC[e.tf];
  const tIn = t[at];
  const tOut = t[last] + span;
  const paid = side * (fundAt(fund, tOut) - fundAt(fund, tIn));
  const move = side * (exit / entry - 1);
  return { coin: 0, tIn, tOut, r: (move - (COST.taker + fee) * costMult - paid) / riskPct, side, hit: 0 };
}

// One position per coin per strategy. Returns the trades for one coin.
export function runCoin(e: Env, sig: Int8Array, cfg: Cfg, fund: Fund, coin: number, opts: { cost?: number; delay?: number; from?: number; to?: number } = {}) {
  const out: Trade[] = [];
  const bias = cfg.htf === "none" ? null : e.bias[cfg.htf];
  const { cost = 1, delay = 0, from = 0, to = Infinity } = opts;
  const lv = LEVELS.get(sig);
  let free = 0;
  for (let i = 210; i < e.b.n - 1; i++) {
    const s = sig[i];
    if (!s || e.b.t[i] < free) continue;
    if (cfg.side && s !== cfg.side) continue;
    if (bias && bias[i] !== s && bias[i] !== 2) continue; // 2 means the filter allows either side
    const T = e.b.t[i] + TF_SEC[e.tf];
    if (T < from || T >= to) continue;
    const tr = simOne(e, i, s, cfg.ex, fund, cost, delay, lv);
    if (tr) {
      tr.coin = coin;
      out.push(tr);
      free = tr.tOut;
    }
  }
  return out;
}

// ---- environment ----------------------------------------------------------------------

// HTF direction known at each bar's close: only finished higher-timeframe bars are used.
function alignBias(b: Cols, span: number, h: Cols, up: Uint8Array, dn: Uint8Array, hSpan: number) {
  const out = new Int8Array(b.n);
  let k = -1;
  for (let i = 0; i < b.n; i++) {
    const closeT = b.t[i] + span;
    while (k + 1 < h.n && h.t[k + 1] + hSpan <= closeT) k++;
    if (k >= 0) out[i] = up[k] ? 1 : dn[k] ? -1 : 0;
  }
  return out;
}

function dirs(h: Cols, mode: "above" | "cross") {
  const e20 = emaA(h.c, 20);
  const e50 = emaA(h.c, 50);
  const up = new Uint8Array(h.n);
  const dn = new Uint8Array(h.n);
  for (let i = 50; i < h.n; i++) {
    if (mode === "above") {
      up[i] = h.c[i] > e50[i] ? 1 : 0;
      dn[i] = h.c[i] < e50[i] ? 1 : 0;
    } else {
      up[i] = h.c[i] > e20[i] && e20[i] > e50[i] ? 1 : 0;
      dn[i] = h.c[i] < e20[i] && e20[i] < e50[i] ? 1 : 0;
    }
  }
  return { up, dn };
}

export const HTF_KEYS = ["none", "d50", "d2050", "btc50", "h4"];
export const NEW_FILTERS = ["wk", "vhi", "vlo", "asia", "eu", "us"];

export type Extra = { fund?: { t: number; r: number }[]; spot?: { t: number; c: number; v: number; tb: number }[]; cb?: { t: number; c: number }[] };

// The latest value known at each bar's close. A 1h print is only trusted once its hour has closed.
function alignLast(b: Cols, span: number, ts: Float64Array, vs: Float64Array, wait: number) {
  const out = new Float64Array(b.n);
  let k = -1;
  for (let i = 0; i < b.n; i++) {
    while (k + 1 < ts.length && ts[k + 1] + wait <= b.t[i] + span) k++;
    out[i] = k >= 0 ? vs[k] : 0;
  }
  return out;
}

export function makeEnv(sym: string, tf: Tf, b: Cols, d: Cols, h4: Cols, btcD: Cols, btcTf: Cols | null, oiRows: { t: number; v: number }[] | null, extra: Extra = {}): Env {
  const span = TF_SEC[tf];
  const dA = dirs(d, "above");
  const dC = dirs(d, "cross");
  const bA = dirs(btcD, "above");
  const hC = dirs(h4, "cross");
  const bias: Record<string, Int8Array> = {
    d50: alignBias(b, span, d, dA.up, dA.dn, 86400),
    d2050: alignBias(b, span, d, dC.up, dC.dn, 86400),
    btc50: alignBias(b, span, btcD, bA.up, bA.dn, 86400),
    h4: alignBias(b, span, h4, hC.up, hC.dn, 14400),
  };
  // Weekly trend: daily close against a ten-week average.
  const e70 = emaA(d.c, 70);
  const wUp = new Uint8Array(d.n);
  const wDn = new Uint8Array(d.n);
  for (let i = 70; i < d.n; i++) {
    wUp[i] = d.c[i] > e70[i] ? 1 : 0;
    wDn[i] = d.c[i] < e70[i] ? 1 : 0;
  }
  bias.wk = alignBias(b, span, d, wUp, wDn, 86400);
  // Volatility state: daily range against its own 60-day average.
  const aD = atrA(d);
  const rel = new Float64Array(d.n);
  for (let i = 0; i < d.n; i++) rel[i] = d.c[i] ? aD[i] / d.c[i] : 0;
  const base = smaA(rel, 60);
  const [hiV, loV] = [new Int8Array(b.n), new Int8Array(b.n)];
  let vk = -1;
  for (let i = 0; i < b.n; i++) {
    while (vk + 1 < d.n && d.t[vk + 1] + 86400 <= b.t[i] + span) vk++;
    if (vk >= 60) {
      hiV[i] = rel[vk] > base[vk] ? 2 : 0;
      loV[i] = rel[vk] <= base[vk] ? 2 : 0;
    }
  }
  bias.vhi = hiV;
  bias.vlo = loV;
  // Session of the bar that just closed, UTC.
  const [asia, eu, us] = [new Int8Array(b.n), new Int8Array(b.n), new Int8Array(b.n)];
  for (let i = 0; i < b.n; i++) {
    const hr = Math.floor((b.t[i] % 86400) / 3600);
    if (hr < 8) asia[i] = 2;
    else if (hr < 14) eu[i] = 2;
    else if (hr < 21) us[i] = 2;
  }
  bias.asia = asia;
  bias.eu = eu;
  bias.us = us;
  let btc: Float64Array | null = null;
  if (btcTf && sym !== "BTC") {
    btc = new Float64Array(b.n);
    let k = 0;
    for (let i = 0; i < b.n; i++) {
      while (k + 1 < btcTf.n && btcTf.t[k + 1] <= b.t[i]) k++;
      btc[i] = btcTf.c[k];
    }
  }
  let oi: Float64Array | null = null;
  if (oiRows?.length) {
    oi = new Float64Array(b.n);
    let k = -1;
    for (let i = 0; i < b.n; i++) {
      // An hourly OI print is only trusted one hour after its timestamp.
      while (k + 1 < oiRows.length && oiRows[k + 1].t + 3600 <= b.t[i] + span) k++;
      oi[i] = k >= 0 ? oiRows[k].v : 0;
    }
  }
  const env: Env = { sym, tf, b, x: new Ind(b), btc, oi, bias };
  if (extra.fund?.length) env.fund = alignLast(b, span, Float64Array.from(extra.fund, (x) => x.t), Float64Array.from(extra.fund, (x) => x.r), 0);
  if (extra.spot && extra.spot.length > 48) {
    const sp = extra.spot;
    const ts = Float64Array.from(sp, (x) => x.t);
    env.spotC = alignLast(b, span, ts, Float64Array.from(sp, (x) => x.c), 3600);
    const sc: Cols = { n: sp.length, t: ts, o: new Float64Array(0), h: new Float64Array(0), l: new Float64Array(0), c: new Float64Array(0), v: Float64Array.from(sp, (x) => x.v), q: new Float64Array(0), tb: Float64Array.from(sp, (x) => x.tb) };
    env.spotD = alignLast(b, span, ts, rollDelta(sc, 24), 3600);
  }
  if (extra.cb?.length && btcTf) {
    const pts = new Float64Array(extra.cb.length);
    const vals = new Float64Array(extra.cb.length);
    let k = 0;
    extra.cb.forEach((x, i) => {
      while (k + 1 < btcTf.n && btcTf.t[k + 1] <= x.t) k++;
      pts[i] = x.t;
      vals[i] = x.c / btcTf.c[k] - 1;
    });
    env.cb = alignLast(b, span, pts, vals, 3600);
  }
  return env;
}
