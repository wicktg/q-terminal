// Daily bars for every Binance USDT perp, delisted ones included, so a momentum test
// is not flattered by only looking at coins that survived and won.
// Funding is fetched only for coins that ever reach the top 40 by trailing volume.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FAPI = "https://fapi.binance.com";
const DAY = 86400e3;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(url: string, gap: number): Promise<T | null> {
  for (let n = 0; n < 5; n++) {
    await wait(gap);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) {
        await wait(8000 * (n + 1));
        continue;
      }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      await wait(2000 * (n + 1));
    }
  }
  return null;
}

type Info = { symbol: string; baseAsset: string; contractType: string; quoteAsset: string; status: string; onboardDate: number };
const info = await get<{ symbols: Info[] }>(`${FAPI}/fapi/v1/exchangeInfo`, 0);
if (!info) throw new Error("no exchange info");
const perps = info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && !/^(USDC|FDUSD|TUSD|BUSD|USDP|DAI)$/.test(s.baseAsset));
console.log(`perps ${perps.length}, trading ${perps.filter((s) => s.status === "TRADING").length}, not trading ${perps.filter((s) => s.status !== "TRADING").length}`);

const now = Date.now();
const from = now - 700 * DAY;
type Row = (string | number)[];
const bars: Record<string, { t: number; c: number; q: number }[]> = {};
for (const s of perps) {
  if (s.onboardDate > now - 60 * DAY) continue;
  const rows = await get<Row[]>(`${FAPI}/fapi/v1/klines?symbol=${s.symbol}&interval=1d&limit=1000&startTime=${from}`, 130);
  if (rows?.length) bars[s.symbol] = rows.filter((k) => +k[6] < now).map((k) => ({ t: Math.floor(+k[0] / 1000), c: +k[4], q: +k[7] }));
}
console.log(`coins with bars ${Object.keys(bars).length}`);

// Which coins ever rank in the top 40 by trailing 30-day volume at a weekly check?
const everTop = new Set<string>();
const days = [...new Set(Object.values(bars).flat().map((b) => b.t))].sort((a, b) => a - b);
for (let i = 45; i < days.length; i += 7) {
  const d = days[i];
  const rows = Object.entries(bars).flatMap(([s, b]) => {
    const w = b.filter((x) => x.t <= d && x.t > d - 30 * 86400);
    return w.length >= 25 ? [{ s, v: w.reduce((a, x) => a + x.q, 0) }] : [];
  });
  rows.sort((a, b) => b.v - a.v);
  rows.slice(0, 40).forEach((r) => everTop.add(r.s));
}
console.log(`ever in the top 40: ${everTop.size}`);

const funding: Record<string, { t: number; r: number }[]> = {};
for (const s of everTop) {
  const out: { t: number; r: number }[] = [];
  let start = from;
  while (start < now) {
    const rows = await get<{ fundingTime: number; fundingRate: string }[]>(`${FAPI}/fapi/v1/fundingRate?symbol=${s}&limit=1000&startTime=${start}`, 450); // this endpoint allows 500 calls per 5 minutes
    if (!rows?.length) break;
    for (const x of rows) out.push({ t: Math.floor(x.fundingTime / 1000), r: +x.fundingRate });
    if (rows.length < 1000) break;
    start = rows[rows.length - 1].fundingTime + 1;
  }
  funding[s] = out;
}
const dir = resolve(import.meta.dirname, "../data");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "wide.json"), JSON.stringify({ asOf: now, bars, funding, status: Object.fromEntries(perps.map((s) => [s.symbol, s.status])) }));
console.log("done");
