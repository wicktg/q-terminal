// Round 2: better ideas instead of more knobs. The last 30 days stay unread until a choice is locked,
// except the rolling method as requested (look back 30 days, trade the next 30), fixed in advance.
import { run, stats, type Cand, type Trade } from "../lib/backtest.ts";
import { load, row } from "./bt-load.ts";
import { aggregate, variants } from "./variants.ts";

const DAY = 86400;
const { data, cands, asOf } = load();
const finalFrom = asOf - 30 * DAY;
const validFrom = asOf - 210 * DAY;
const start = cands[0].T;
const syms = Object.keys(data);

// ---- 1. which flow readings predict the next few days? --------------------------------
console.log("=== 1. FLOW FEATURES: rank correlation with the next 72h return across coins");
const snaps = cands.filter((c) => c.rank === 0);
const fwd = (sym: string, T: number, h: number) => {
  const s = data[sym];
  const i = s.index.get(T);
  if (i === undefined || i + h >= s.bars.length) return null;
  return s.bars[i + h].c / s.bars[i].o - 1;
};
const spearman = (x: number[], y: number[]) => {
  const rank = (v: number[]) => {
    const o = v.map((a, i) => [a, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    o.forEach((p, i) => (r[p[1]] = i));
    return r;
  };
  const [a, b] = [rank(x), rank(y)];
  const n = x.length;
  const m = (n - 1) / 2;
  let [sab, saa, sbb] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    sab += (a[i] - m) * (b[i] - m);
    saa += (a[i] - m) ** 2;
    sbb += (b[i] - m) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
};
const period = (T: number) => (T < validFrom ? 0 : T < finalFrom ? 1 : 2);
console.log("feature       discovery        validation     sign holds?");
for (const f of ["trend", "cvd", "oi", "retail", "funding", "liq", "analog"]) {
  const out = [0, 1].map((p) => {
    const byT = new Map<number, Cand[]>();
    for (const c of snaps) if (period(c.T) === p && c.T % (3 * DAY) === 0) byT.set(c.T, [...(byT.get(c.T) ?? []), c]);
    const ics: number[] = [];
    for (const g of byT.values()) {
      const rows = g.map((c) => [c.flow[f], fwd(c.sym, c.T, 72)] as const).filter((r) => r[1] !== null);
      if (rows.length >= 8) ics.push(spearman(rows.map((r) => r[0]), rows.map((r) => r[1] as number)));
    }
    const m = ics.reduce((s, x) => s + x, 0) / (ics.length || 1);
    const sd = Math.sqrt(ics.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, ics.length - 1));
    return { m, t: sd ? (m / sd) * Math.sqrt(ics.length) : 0 };
  });
  console.log(`${f.padEnd(12)} ${out[0].m.toFixed(3).padStart(6)} (t ${out[0].t.toFixed(1).padStart(4)})  ${out[1].m.toFixed(3).padStart(6)} (t ${out[1].t.toFixed(1).padStart(4)})  ${Math.sign(out[0].m) === Math.sign(out[1].m) ? "yes" : "NO"}`);
}

// ---- 2. gates on the live setups ------------------------------------------------------
console.log("\n=== 2. GATES on the setup the terminal shows, waiting for the trigger");
const btcTrend = new Map(cands.filter((c) => c.sym === "BTC" && c.rank === 0).map((c) => [c.T, c.flow.trend]));
const RULE = { entry: "confirm" as const, valid: 48, hold: 168, stopAtr: null, target: "level" as const };
const bt = (c: Cand) => c.side * (btcTrend.get(c.T) ?? 0);
const gates: [string, (c: Cand) => boolean][] = [
  ["No gate", (c) => c.rank === 0],
  ["Grade A", (c) => c.rank === 0 && c.grade === "A"],
  ["With BTC trend", (c) => c.rank === 0 && bt(c) > 0.3],
  ["Against BTC trend", (c) => c.rank === 0 && bt(c) < -0.3],
  ["BTC flat", (c) => c.rank === 0 && Math.abs(btcTrend.get(c.T) ?? 0) <= 0.3],
  ["Grade A with BTC", (c) => c.rank === 0 && c.grade === "A" && bt(c) > 0.3],
  ["Coin and BTC trend agree", (c) => c.rank === 0 && bt(c) > 0.3 && c.side * c.flow.trend > 0.3],
  ["Model EV above 0.2R", (c) => c.rank === 0 && c.expR > 0.2],
];
for (const [label, pass] of gates) {
  const tr = run(cands, data, RULE, pass);
  console.log(row(`${label} disc`, tr.filter((t) => t.T < validFrom)));
  console.log(row(`${label} valid`, tr.filter((t) => t.T >= validFrom && t.T < finalFrom)));
}

// ---- 3. rolling re-tune ----------------------------------------------------------------
console.log("\n=== 3. ROLLING RE-TUNE: pick what worked over the last W days, trade it for the next S days, repeat");
const { tests } = variants(cands, start);
const all = tests.map((t) => ({ label: t.label, tr: run(t.pool, data, t.rule, t.pass).sort((a, b) => a.tOut - b.tOut) }));
console.log(`variations ready: ${all.length}`);
type Pick = { tr: Trade[]; used: string[]; idle: number };
function rolling(W: number, S: number, score: "avg" | "t", coin?: string): Pick {
  const tr: Trade[] = [];
  const used: string[] = [];
  let idle = 0;
  const minN = coin ? 4 : Math.max(10, W / 2);
  for (let d = start + W * DAY; d < asOf; d += S * DAY) {
    let best: (typeof all)[number] | null = null;
    let bestV = 0; // nothing positive means stand aside
    for (const v of all) {
      const past = v.tr.filter((x) => x.tOut <= d && x.T >= d - W * DAY && (!coin || x.sym === coin));
      if (past.length < minN) continue;
      const s = stats(past);
      const val = score === "avg" ? s.avg : s.t;
      if (val > bestV) {
        bestV = val;
        best = v;
      }
    }
    if (best) {
      used.push(best.label);
      tr.push(...best.tr.filter((x) => x.T >= d && x.T < d + S * DAY && (!coin || x.sym === coin)));
    } else idle++;
  }
  return { tr, used, idle };
}
const pre = (t: Trade) => t.T < finalFrom;
const metas: { W: number; S: number; by: "avg" | "t"; pre: ReturnType<typeof stats>; m: Pick }[] = [];
for (const W of [14, 30, 60, 90])
  for (const S of [7, 30])
    for (const by of ["avg", "t"] as const) {
      const m = rolling(W, S, by);
      const p = m.tr.filter(pre);
      const st = stats(p);
      metas.push({ W, S, by, pre: st, m });
      console.log(`${row(`look ${W}d trade ${S}d by ${by}`, p)}  rules ${new Set(m.used).size}, idle ${m.idle}`);
    }

// ---- 4. cross-coin momentum -------------------------------------------------------------
console.log("\n=== 4. CROSS-COIN MOMENTUM: long 3 strongest, short 3 weakest, equal weight, after costs and funding");
const closes: Record<string, Map<number, number>> = {};
for (const s of syms) closes[s] = new Map(aggregate(data[s].bars, DAY).map((b) => [b.t + DAY, b.c])); // keyed by close time
const fundBetween = (s: string, a: number, b: number) => data[s].funding.filter((f) => f.t > a && f.t <= b).reduce((x, f) => x + f.r, 0);
function momentum(L: number, S: number, from: number, to: number, sign: number) {
  const rets: number[] = [];
  let prev = new Set<string>();
  for (let d = Math.ceil(from / DAY) * DAY; d + S * DAY <= to; d += S * DAY) {
    const rows = syms.flatMap((s) => {
      const [now, past, next] = [closes[s].get(d), closes[s].get(d - L * DAY), closes[s].get(d + S * DAY)];
      return now && past && next ? [{ s, mom: now / past - 1, ret: next / now - 1 }] : [];
    });
    if (rows.length < 8) continue;
    rows.sort((a, b) => sign * (b.mom - a.mom));
    const longs = rows.slice(0, 3);
    const shorts = rows.slice(-3);
    const book = new Set([...longs.map((x) => `L${x.s}`), ...shorts.map((x) => `S${x.s}`)]);
    const turn = [...book].filter((x) => !prev.has(x)).length;
    prev = book;
    const cost = (turn / 6) * 2 * 0.0008; // out of the old leg, into the new one
    const leg = (x: { s: string; ret: number }) => x.ret - fundBetween(x.s, d, d + S * DAY);
    rets.push((longs.reduce((s, x) => s + leg(x), 0) - shorts.reduce((s, x) => s + leg(x), 0)) / 6 - cost);
  }
  const m = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, rets.length - 1));
  return { n: rets.length, total: rets.reduce((s, x) => s + x, 0), sharpe: sd ? (m / sd) * Math.sqrt(365 / S) : 0, t: sd ? (m / sd) * Math.sqrt(rets.length) : 0 };
}
const fmt = (x: ReturnType<typeof momentum>) => `sum ${(x.total * 100).toFixed(1).padStart(6)}%  sharpe ${x.sharpe.toFixed(2).padStart(5)}  t ${x.t.toFixed(2).padStart(5)}  n ${String(x.n).padStart(3)}`;
for (const sign of [1, -1])
  for (const L of [3, 7, 14, 30])
    for (const S of [3, 7]) console.log(`${sign > 0 ? "momentum" : "reversal"} look ${String(L).padStart(2)}d hold ${S}d | disc ${fmt(momentum(L, S, start, validFrom, sign))} | valid ${fmt(momentum(L, S, validFrom, finalFrom, sign))}`);

// ---- per coin and final read ------------------------------------------------------------
console.log("\n=== 5. PER-COIN rolling re-tune, look 90d trade 30d, earlier data only");
for (const s of syms) console.log(row(s, rolling(90, 30, "avg", s).tr.filter(pre)));

console.log("\n=== FINAL: last 30 days, read once");
const best = [...metas].sort((a, b) => b.pre.t - a.pre.t)[0];
const literal = metas.find((m) => m.W === 30 && m.S === 30 && m.by === "avg")!;
console.log(`best rolling on earlier data: look ${best.W}d trade ${best.S}d by ${best.by}, earlier t ${best.pre.t.toFixed(2)}`);
console.log(row("  last 30 days", best.m.tr.filter((t) => !pre(t))));
console.log("look 30d trade 30d, as requested:");
console.log(row("  last 30 days", literal.m.tr.filter((t) => !pre(t))));
console.log("  rules it chose lately:", literal.m.used.slice(-3).join(" | "));
