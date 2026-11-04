// Market Profile (TPO) from 30-minute bars. Pure, no I/O, so it runs in the browser and on the server.
// Each UTC day is a session. Each 30-minute period is a letter, printed at every price row it traded through.
export type TpoBar = { t: number; o: number; h: number; l: number; c: number };
export type Range = { lo: number; hi: number };
export type TpoRow = { k: number; letters: number[] }; // the row covers k*step up to (k+1)*step
export type Shape = "D" | "P" | "b" | "Trend" | "Double";
export type Session = {
  start: number;
  end: number;
  live: boolean;
  step: number;
  open: number;
  high: number;
  low: number;
  close: number;
  periods: number;
  tpos: number;
  rows: TpoRow[]; // lowest row first
  pocK: number;
  vahK: number;
  valK: number;
  poc: number;
  vah: number;
  val: number;
  ib: Range | null;
  ext: "up" | "down" | "both" | "none";
  singles: Range[];
  tailHigh: Range | null;
  tailLow: Range | null;
  poorHigh: boolean;
  poorLow: boolean;
  shape: Shape;
};
export type Value = { poc: number; vah: number; val: number };

export const PERIOD_SEC = 1800;
export const DAY_SEC = 86400;
export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv";
export const SHAPE_NOTE: Record<Shape, string> = {
  D: "Balanced. Value is accepted, so expect rotation inside it.",
  P: "Value built near the top. Often short covering rather than new buying.",
  b: "Value built near the bottom. Often long liquidation rather than new selling.",
  Trend: "Thin and stretched. One side was in control all session.",
  Double: "Two distributions split by single prints. Price moved to a new value area.",
};

// Rounds a raw row size to 1, 2, 2.5 or 5 times a power of ten.
export function niceStep(raw: number) {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return [1, 2, 2.5, 5, 10].find((x) => x >= m - 1e-9)! * pow;
}

// The CBOT value area: start at the POC and add the heavier pair of rows above or below until 70% is covered.
function valueArea(counts: number[]) {
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(...counts);
  const mid = (counts.length - 1) / 2;
  let poc = -1; // on a tie, the row nearest the middle of the range
  counts.forEach((c, i) => {
    if (c === max && (poc < 0 || Math.abs(i - mid) < Math.abs(poc - mid))) poc = i;
  });
  let [lo, hi] = [poc, poc];
  let acc = counts[poc];
  while (acc < 0.7 * total && (lo > 0 || hi < counts.length - 1)) {
    const up = (counts[hi + 1] ?? 0) + (counts[hi + 2] ?? 0);
    const dn = (counts[lo - 1] ?? 0) + (counts[lo - 2] ?? 0);
    if (hi < counts.length - 1 && (up >= dn || lo === 0)) {
      const add = Math.min(2, counts.length - 1 - hi);
      for (let j = 1; j <= add; j++) acc += counts[hi + j];
      hi += add;
    } else {
      const add = Math.min(2, lo);
      for (let j = 1; j <= add; j++) acc += counts[lo - j];
      lo -= add;
    }
  }
  return { poc, lo, hi };
}

const kOf = (x: number, step: number) => Math.floor(x / step + 1e-9);

function buildSession(bars: TpoBar[], start: number, step: number, now: number): Session {
  const kLo = kOf(Math.min(...bars.map((b) => b.l)), step);
  const kHi = kOf(Math.max(...bars.map((b) => b.h)), step);
  const rows: TpoRow[] = Array.from({ length: kHi - kLo + 1 }, (_, i) => ({ k: kLo + i, letters: [] }));
  for (const b of bars) {
    const p = Math.floor((b.t - start) / PERIOD_SEC);
    for (let k = kOf(b.l, step); k <= kOf(b.h, step); k++) rows[k - kLo].letters.push(p);
  }
  const counts = rows.map((r) => r.letters.length);
  const tpos = counts.reduce((a, b) => a + b, 0);
  const va = valueArea(counts);
  const n = rows.length;
  const price = (i: number) => rows[i].k * step;
  const span = (a: number, b: number): Range => ({ lo: price(a), hi: price(b) + step });

  // Single prints: runs of one-letter rows. Runs at an extreme are tails, the rest are internal.
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (counts[i] !== 1) continue;
    let j = i;
    while (j + 1 < n && counts[j + 1] === 1) j++;
    if (j > i) runs.push([i, j]);
    i = j;
  }
  const tailLow = runs.find(([a]) => a === 0);
  const tailHigh = runs.find(([, b]) => b === n - 1);
  const singles = runs.filter((r) => r !== tailLow && r !== tailHigh).map(([a, b]) => span(a, b));

  const ibBars = bars.filter((b) => b.t - start < 2 * PERIOD_SEC);
  const ib = ibBars.length ? { lo: Math.min(...ibBars.map((b) => b.l)), hi: Math.max(...ibBars.map((b) => b.h)) } : null;
  const high = Math.max(...bars.map((b) => b.h));
  const low = Math.min(...bars.map((b) => b.l));
  const extUp = !!ib && high > ib.hi;
  const extDn = !!ib && low < ib.lo;

  const upper = counts.slice(Math.ceil(n / 2)).reduce((a, b) => a + b, 0) / tpos;
  const lower = counts.slice(0, Math.floor(n / 2)).reduce((a, b) => a + b, 0) / tpos;
  const pos = n > 1 ? va.poc / (n - 1) : 0.5;
  const split = singles.some((s) => {
    const k = kOf(s.lo, step) - kLo;
    const below = counts.slice(0, k).reduce((a, b) => a + b, 0) / tpos;
    return below >= 0.25 && below <= 0.75;
  });
  const thin = counts.filter((c) => c <= 2).length / n;
  const shape: Shape = split ? "Double" : thin >= 0.6 && n >= 12 ? "Trend" : pos >= 0.6 && upper >= 0.58 ? "P" : pos <= 0.4 && lower >= 0.58 ? "b" : "D";

  return {
    start,
    end: start + DAY_SEC,
    live: start + DAY_SEC > now,
    step,
    open: bars[0].o,
    high,
    low,
    close: bars[bars.length - 1].c,
    periods: Math.floor((bars[bars.length - 1].t - start) / PERIOD_SEC) + 1,
    tpos,
    rows,
    pocK: rows[va.poc].k,
    vahK: rows[va.hi].k,
    valK: rows[va.lo].k,
    poc: price(va.poc) + step / 2,
    vah: price(va.hi) + step,
    val: price(va.lo),
    ib,
    ext: extUp && extDn ? "both" : extUp ? "up" : extDn ? "down" : "none",
    singles,
    tailHigh: tailHigh ? span(...tailHigh) : null,
    tailLow: tailLow ? span(...tailLow) : null,
    poorHigh: !tailHigh && counts[n - 1] >= 2,
    poorLow: !tailLow && counts[0] >= 2,
    shape,
  };
}

// Groups bars into UTC-day sessions, oldest first.
export function sessions(bars: TpoBar[], step: number, now = Date.now() / 1000): Session[] {
  const days = new Map<number, TpoBar[]>();
  for (const b of bars) {
    const d = Math.floor(b.t / DAY_SEC) * DAY_SEC;
    const list = days.get(d);
    if (list) list.push(b);
    else days.set(d, [b]);
  }
  return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([d, list]) => buildSession(list, d, step, now));
}

// One value area across several sessions, for a multi-day view of where the market accepted price.
export function composite(list: Session[]): Value | null {
  if (!list.length) return null;
  const step = list[0].step;
  const counts = new Map<number, number>();
  for (const s of list) for (const r of s.rows) counts.set(r.k, (counts.get(r.k) ?? 0) + r.letters.length);
  const ks = [...counts.keys()].sort((a, b) => a - b);
  const filled = Array.from({ length: ks[ks.length - 1] - ks[0] + 1 }, (_, i) => counts.get(ks[0] + i) ?? 0);
  const va = valueArea(filled);
  return { poc: (ks[0] + va.poc + 0.5) * step, vah: (ks[0] + va.hi + 1) * step, val: (ks[0] + va.lo) * step };
}

// POCs of finished sessions that price has not traded back through since. Price is often drawn back to them.
export function nakedPocs(list: Session[], bars: TpoBar[]) {
  return list
    .filter((s) => !s.live)
    .filter((s) => !bars.some((b) => b.t >= s.end && b.l <= s.poc && b.h >= s.poc))
    .map((s) => ({ start: s.start, poc: s.poc }));
}

// Where a session opened against the previous session's value.
export function openVsValue(s: Session, prev: Session | undefined) {
  if (!prev) return null;
  return s.open > prev.vah ? "above" : s.open < prev.val ? "below" : "inside";
}

// Row size that gives roughly `rows` rows across the given price range.
export function stepFor(bars: TpoBar[], rows: number) {
  const hi = Math.max(...bars.map((b) => b.h));
  const lo = Math.min(...bars.map((b) => b.l));
  return niceStep((hi - lo) / rows);
}

// One row size for every view of a coin, set by the last three days, so the tab and the chart agree.
export const defaultStep = (bars: TpoBar[]) => stepFor(bars.slice(-48 * 3), 60);

// The levels worth drawing on a price chart: the live session's value area and nearby untested POCs.
export function tpoLevels(bars: TpoBar[], price: number) {
  if (bars.length < 4) return null;
  const list = sessions(bars, defaultStep(bars));
  const now = list[list.length - 1];
  const naked = nakedPocs(list, bars)
    .filter((p) => Math.abs(p.poc / price - 1) <= 0.12)
    .sort((a, b) => Math.abs(a.poc - price) - Math.abs(b.poc - price))
    .slice(0, 3);
  return { poc: now.poc, vah: now.vah, val: now.val, naked };
}
