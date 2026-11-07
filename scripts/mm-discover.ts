// Finds market-maker-like accounts on Hyperliquid and writes lib/mm-seed.ts.
// An account counts when, over the last 14 days, at least 80% of its volume added liquidity (maker), that maker
// volume is at least $500M, and it is quoting both sides in at least five markets right now.
// Run: node --experimental-strip-types scripts/mm-discover.ts
import { writeFileSync } from "node:fs";

const HL = "https://api.hyperliquid.xyz/info";
const NAMED = new Set(["0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00"]); // Wintermute is tracked by name already
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function info<T>(body: unknown): Promise<T> {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return (await r.json()) as T;
    await wait(3000 * (a + 1));
  }
  throw new Error(`HL failed ${JSON.stringify(body)}`);
}

type Row = { ethAddress: string; accountValue: string; displayName: string | null; windowPerformances: [string, { vlm: string }][] };
const lb = (await (await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard")).json()) as { leaderboardRows: Row[] };
const vlm = (r: Row) => +(r.windowPerformances.find((x) => x[0] === "month")?.[1]?.vlm ?? 0);
const top = lb.leaderboardRows.sort((a, b) => vlm(b) - vlm(a)).slice(0, 60);

const out: { addr: string; name: string | null; maker: number; vol14: number; quoted: number; acct: number }[] = [];
for (const r of top) {
  await wait(1100); // userFees costs 20 of the 1,200 weight allowed per minute
  const f = await info<{ dailyUserVlm?: { userAdd: string; userCross: string }[] }>({ type: "userFees", user: r.ethAddress });
  let add = 0;
  let cross = 0;
  for (const d of f.dailyUserVlm ?? []) {
    add += +d.userAdd;
    cross += +d.userCross;
  }
  const maker = add / (add + cross || 1);
  if (maker < 0.8 || add < 5e8 || NAMED.has(r.ethAddress)) continue;
  await wait(1100);
  const oo = await info<{ coin: string; side: string; isTrigger: boolean }[]>({ type: "frontendOpenOrders", user: r.ethAddress });
  const sides = new Map<string, Set<string>>();
  for (const o of oo) if (!o.isTrigger) sides.set(o.coin, (sides.get(o.coin) ?? new Set()).add(o.side));
  const quoted = [...sides.values()].filter((s) => s.size === 2).length;
  console.log(`${r.ethAddress} maker ${(maker * 100).toFixed(0)}% $${(add / 1e6).toFixed(0)}M two-sided ${quoted}`);
  // Leaderboard names are self-chosen; one that looks like an email is personal, so it is dropped.
  const name = r.displayName && !r.displayName.includes("@") ? r.displayName : null;
  if (quoted >= 5) out.push({ addr: r.ethAddress, name, maker: +maker.toFixed(3), vol14: Math.round(add + cross), quoted, acct: Math.round(+r.accountValue) });
}
out.sort((a, b) => b.vol14 * b.maker - a.vol14 * a.maker);
const seed = { found: new Date().toISOString().slice(0, 10), makers: out.slice(0, 10) };
const body = `// Written by scripts/mm-discover.ts: market-maker-like accounts on Hyperliquid.\nexport const MM_SEED: { found: string; makers: { addr: string; name: string | null; maker: number; vol14: number; quoted: number; acct: number }[] } = ${JSON.stringify(seed, null, 2)};\n`;
writeFileSync(new URL("../lib/mm-seed.ts", import.meta.url), body);
console.log(`wrote ${seed.makers.length} makers`);
