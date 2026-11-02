// Live read for the LAB page. Runs the same range and pattern rules as the lab backtest on closed bars.
import type { Bar } from "./types.ts";
import { colsFromBars, Ind, TF_SEC, type Cols, type Env, type Tf } from "./mtf.ts";
import { LAB_INFO, labScan, rangeAt, type LabP } from "./lab.ts";
import { LAB_SETUPS } from "./lab-record.ts";
import { cached, perpKlines } from "./data.ts";

export type LabRange = { tf: string; hi: number; lo: number; impulse: "UP" | "DOWN"; at: "SWING HIGH" | "SWING LOW"; price: number; where: "INSIDE" | "ABOVE" | "BELOW"; plan: string };
export type LabSignal = { key: string; lane: string; fam: string; name: string; tf: string; side: "LONG" | "SHORT"; state: "ACTIVE" | "RECENT"; entry: number; stop: number; target: number | null; rr: number | null; exit: string; since: number };
export type LabRead = { sym: string; asOf: number; price: number; ranges: LabRange[]; signals: LabSignal[] };

const NAME: Record<string, string> = { "5m": "5M", "15m": "15M", "1h": "1H", "4h": "4H", "1d": "1D" };
const LIMIT: Record<string, number> = { "5m": 1000, "15m": 1000, "1h": 1000, "4h": 1000, "1d": 700 };
const closed = (b: Bar[]) => colsFromBars(b.slice(0, -1));
const env = (sym: string, tf: Tf, b: Cols): Env => ({ sym, tf, b, x: new Ind(b), btc: null, oi: null, bias: {} });

function liveSignal(e: Env, s: (typeof LAB_SETUPS)[number]): LabSignal | null {
  const r = labScan(s.fam, e, s.p as LabP);
  const n = e.b.n;
  for (let i = n - 1; i >= Math.max(0, n - 12); i--) {
    const d = r.sig[i];
    if (!d) continue;
    const at = Math.min(i + 1, n - 1);
    const entry = e.b.o[at];
    const stop = r.stop[i];
    const risk = Math.abs(entry - stop);
    if (!risk) return null;
    // Trailing setups have no fixed target. They run until the trail is hit.
    const tgt = s.trail ? NaN : s.r ? entry + d * s.r * risk : r.target[i];
    const target = Number.isFinite(tgt) ? tgt : null;
    // Stop or target already reached means this one has played out.
    let open = true;
    for (let k = at; k < n; k++) if ((d > 0 ? e.b.l[k] <= stop : e.b.h[k] >= stop) || (target !== null && (d > 0 ? e.b.h[k] >= target : e.b.l[k] <= target))) open = false;
    return { key: s.key, lane: s.lane, fam: s.fam, name: LAB_INFO[s.fam].name, tf: NAME[s.tf], side: d > 0 ? "LONG" : "SHORT", state: open ? "ACTIVE" : "RECENT", entry, stop, target, rr: target === null ? null : Math.abs(target - entry) / risk, exit: s.trail ? `${s.trail} ATR trail, breakeven at 1R` : "Fixed target", since: e.b.t[i] + TF_SEC[s.tf as Tf] };
  }
  return null;
}

export const labRead = (sym: string): Promise<LabRead> =>
  cached(`lab:${sym}`, 60e3, async () => {
    const tfs: Tf[] = ["1d", "4h", "1h", "15m", "5m"];
    const raw = await Promise.all(tfs.map((tf) => perpKlines(sym, tf, LIMIT[tf])));
    const es = new Map(tfs.map((tf, i) => [tf, env(sym, tf, closed(raw[i]))]));
    const fresh = raw[4];
    const price = fresh[fresh.length - 1].c;
    const ranges: LabRange[] = [];
    for (const tf of tfs) {
      const e = es.get(tf)!;
      const i = e.b.n - 1;
      if (i < 300) continue;
      const r = rangeAt(e, i, 24, 5) ?? rangeAt(e, i, 12, 5);
      if (!r) continue;
      const up = r.dir > 0;
      const where = price > r.hi ? "ABOVE" : price < r.lo ? "BELOW" : "INSIDE";
      ranges.push({
        tf: NAME[tf],
        hi: r.hi,
        lo: r.lo,
        impulse: up ? "UP" : "DOWN",
        at: r.pos >= 0.5 ? "SWING HIGH" : "SWING LOW",
        price,
        where,
        plan: up ? "Close above the high is continuation. Close below the low is reversal." : "Close below the low is continuation. Close above the high is reversal.",
      });
    }
    const signals = LAB_SETUPS.flatMap((s) => {
      const e = es.get(s.tf as Tf);
      return e && e.b.n > 300 ? (liveSignal(e, s) ?? []) : [];
    });
    return { sym, asOf: Date.now(), price, ranges, signals };
  });
