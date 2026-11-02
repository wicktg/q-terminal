// Correlation between two coins: raw, with BTC removed, rolling, lead-lag, and on big moves.
export {};
// Run: node --experimental-strip-types --no-warnings scripts/pair-corr.ts HYPE LIT
const [A, B] = [process.argv[2] ?? "HYPE", process.argv[3] ?? "LIT"];
type K = { t: number; c: number };
async function kl(sym: string, tf: string, need: number) {
  const span = { "15m": 900e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 }[tf]!;
  const out: K[] = [];
  let start = Date.now() - need * span;
  while (out.length < need) {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=${tf}&limit=1500&startTime=${start}`, { signal: AbortSignal.timeout(20000) });
    const rows = (await r.json()) as (string | number)[][];
    if (!rows.length) break;
    for (const k of rows) if (+k[6] < Date.now()) out.push({ t: +k[0], c: +k[4] });
    if (rows.length < 1500) break;
    start = +rows[rows.length - 1][0] + span;
  }
  return out;
}
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
function corr(x: number[], y: number[]) {
  const [mx, my] = [mean(x), mean(y)];
  let [xy, xx, yy] = [0, 0, 0];
  x.forEach((v, i) => {
    xy += (v - mx) * (y[i] - my);
    xx += (v - mx) ** 2;
    yy += (y[i] - my) ** 2;
  });
  return xx && yy ? xy / Math.sqrt(xx * yy) : 0;
}
const beta = (y: number[], x: number[]) => {
  const [mx, my] = [mean(x), mean(y)];
  let [xy, xx] = [0, 0];
  x.forEach((v, i) => {
    xy += (v - mx) * (y[i] - my);
    xx += (v - mx) ** 2;
  });
  return xx ? xy / xx : 0;
};
// Rows where all three coins have a bar, as log returns.
function align(a: K[], b: K[], c: K[]) {
  const [mb, mc] = [new Map(b.map((x) => [x.t, x.c])), new Map(c.map((x) => [x.t, x.c]))];
  const rows = a.filter((x) => mb.has(x.t) && mc.has(x.t)).map((x) => ({ t: x.t, a: x.c, b: mb.get(x.t)!, c: mc.get(x.t)! }));
  const out: { t: number; ra: number; rb: number; rc: number }[] = [];
  for (let i = 1; i < rows.length; i++) out.push({ t: rows[i].t, ra: Math.log(rows[i].a / rows[i - 1].a), rb: Math.log(rows[i].b / rows[i - 1].b), rc: Math.log(rows[i].c / rows[i - 1].c) });
  return out;
}
const pick = (r: ReturnType<typeof align>, n: number) => r.slice(-n);
function line(label: string, r: ReturnType<typeof align>) {
  const [a, b, c] = [r.map((x) => x.ra), r.map((x) => x.rb), r.map((x) => x.rc)];
  const [ea, eb] = [a.map((v, i) => v - beta(a, c) * c[i]), b.map((v, i) => v - beta(b, c) * c[i])];
  console.log(`${label.padEnd(16)} n ${String(r.length).padStart(5)}  raw ${corr(a, b).toFixed(2).padStart(5)}  BTC removed ${corr(ea, eb).toFixed(2).padStart(5)}  ${A}/BTC ${corr(a, c).toFixed(2)}  ${B}/BTC ${corr(b, c).toFixed(2)}  beta ${B} on ${A} ${beta(b, a).toFixed(2)}`);
}

const need = { "15m": 2900, "1h": 7500, "4h": 1900, "1d": 330 };
const load = (tf: keyof typeof need) => Promise.all([kl(A, tf, need[tf]), kl(B, tf, need[tf]), kl("BTC", tf, need[tf])]);
const [m15, h1, h4, d1] = [await load("15m"), await load("1h"), await load("4h"), await load("1d")];
const [r15, r1, r4, rd] = [align(...m15), align(...h1), align(...h4), align(...d1)];
console.log(`${A} vs ${B}, ${new Date(rd[0].t).toISOString().slice(0, 10)} to ${new Date(r15[r15.length - 1].t).toISOString().slice(0, 16)} UTC`);
console.log("=== BY TIMEFRAME AND WINDOW");
line("15M, 30h", pick(r15, 120));
line("15M, 7d", pick(r15, 672));
line("15M, 30d", pick(r15, 2880));
line("1H, 7d", pick(r1, 168));
line("1H, 30d", pick(r1, 720));
line("1H, 90d", pick(r1, 2160));
line("1H, all", r1);
line("4H, 30d", pick(r4, 180));
line("4H, 90d", pick(r4, 540));
line("1D, 30d", pick(rd, 30));
line("1D, 90d", pick(rd, 90));
line("1D, all", rd);

console.log("\n=== ROLLING 7-DAY, 1H RETURNS, BTC REMOVED, weekly steps");
const rows: string[] = [];
for (let e = r1.length; e >= 168 && rows.length < 14; e -= 168) {
  const w = r1.slice(e - 168, e);
  const [a, b, c] = [w.map((x) => x.ra), w.map((x) => x.rb), w.map((x) => x.rc)];
  const [ea, eb] = [a.map((v, i) => v - beta(a, c) * c[i]), b.map((v, i) => v - beta(b, c) * c[i])];
  rows.push(`${new Date(w[w.length - 1].t).toISOString().slice(5, 10)}: raw ${corr(a, b).toFixed(2)}, ex-BTC ${corr(ea, eb).toFixed(2)}`);
}
console.log(rows.reverse().join("  |  "));

console.log("\n=== WHO LEADS, 15M returns, 30d (positive lag: first coin moves first)");
const w = pick(r15, 2880);
for (const lag of [-4, -2, -1, 0, 1, 2, 4]) {
  const x = w.map((r) => r.ra);
  const y = w.map((r) => r.rb);
  const [p, q] = lag >= 0 ? [x.slice(0, x.length - lag), y.slice(lag)] : [x.slice(-lag), y.slice(0, y.length + lag)];
  console.log(`lag ${String(lag).padStart(2)} bars (${lag * 15}m): ${corr(p, q).toFixed(3)}`);
}

console.log(`\n=== WHEN ONE MOVES BIG, 1H, last 90d`);
const r = pick(r1, 2160);
const sd = (v: number[]) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));
for (const [name, get, other] of [[A, (x: (typeof r)[number]) => x.ra, (x: (typeof r)[number]) => x.rb], [B, (x: (typeof r)[number]) => x.rb, (x: (typeof r)[number]) => x.ra]] as const) {
  const s = sd(r.map(get));
  const up = r.filter((x) => get(x) > 2 * s);
  const dn = r.filter((x) => get(x) < -2 * s);
  const same = (l: typeof r, d: number) => l.filter((x) => d * other(x) > 0).length / (l.length || 1);
  console.log(`${name} up 2sd: ${up.length} hours, other coin same way ${(same(up, 1) * 100).toFixed(0)}%, avg ${(mean(up.map(other)) * 100).toFixed(2)}% | down 2sd: ${dn.length} hours, same way ${(same(dn, -1) * 100).toFixed(0)}%, avg ${(mean(dn.map(other)) * 100).toFixed(2)}%`);
}
const cum = (rs: number[]) => (Math.exp(rs.reduce((s, x) => s + x, 0)) - 1) * 100;
console.log(`\n=== RETURNS: 7d ${A} ${cum(pick(rd, 7).map((x) => x.ra)).toFixed(1)}%, ${B} ${cum(pick(rd, 7).map((x) => x.rb)).toFixed(1)}%, BTC ${cum(pick(rd, 7).map((x) => x.rc)).toFixed(1)}% | 30d ${A} ${cum(pick(rd, 30).map((x) => x.ra)).toFixed(1)}%, ${B} ${cum(pick(rd, 30).map((x) => x.rb)).toFixed(1)}%, BTC ${cum(pick(rd, 30).map((x) => x.rc)).toFixed(1)}%`);
const last = pick(r15, 72);
console.log(`last 18h: ${A} ${cum(last.map((x) => x.ra)).toFixed(1)}%, ${B} ${cum(last.map((x) => x.rb)).toFixed(1)}%, BTC ${cum(last.map((x) => x.rc)).toFixed(1)}%`);
