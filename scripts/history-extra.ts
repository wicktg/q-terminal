// Extra data for the niche round: spot bars for UNI and AERO, Coinbase BTC, and every perp listed in the window.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FAPI = "https://fapi.binance.com";
const SPOT = "https://api.binance.com";
const DAY = 86400e3;
const dir = resolve(import.meta.dirname, "../data");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get<T>(url: string, gap = 240): Promise<T | null> {
  for (let n = 0; n < 6; n++) {
    await wait(gap);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { "user-agent": "Mozilla/5.0" } });
      if (r.status === 429 || r.status === 418 || r.status >= 500) {
        await wait(10000 * (n + 1));
        continue;
      }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      await wait(3000 * (n + 1));
    }
  }
  return null;
}
const now = Date.now();
const from = now - 700 * DAY;
type Row = (string | number)[];

// Spot 1h, in one format for all 16 coins.
const { watch, hold } = JSON.parse(readFileSync(resolve(dir, "ltf/universe.json"), "utf8")) as { watch: string[]; hold: string[] };
for (const sym of [...watch, ...hold]) {
  const f = resolve(dir, "ltf", `${sym}.spot1h.json`);
  if (existsSync(f)) continue;
  const hist = resolve(dir, "history", `${sym}.json`);
  let rows: { t: number; c: number; v: number; tb: number }[] = [];
  if (existsSync(hist)) rows = (JSON.parse(readFileSync(hist, "utf8")).spot as { t: number; c: number; v: number; tb: number }[]).map(({ t, c, v, tb }) => ({ t, c, v, tb }));
  else {
    let start = from;
    while (start < now) {
      const k = await get<Row[]>(`${SPOT}/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=1000&startTime=${start}`);
      if (!k?.length) break;
      for (const x of k) if (+x[6] < now) rows.push({ t: Math.floor(+x[0] / 1000), c: +x[4], v: +x[5], tb: +x[9] });
      if (k.length < 1000) break;
      start = +k[k.length - 1][0] + 3600e3;
    }
  }
  writeFileSync(f, JSON.stringify(rows));
  console.log(`spot ${sym} ${rows.length}`);
}

// Coinbase BTC-USD, 1h. The API serves 300 rows per call.
const cbFile = resolve(dir, "ltf/coinbase-btc.json");
if (!existsSync(cbFile)) {
  const seen = new Map<number, number>();
  for (let end = now; end > from; end -= 300 * 3600e3) {
    const start = end - 300 * 3600e3;
    const k = await get<number[][]>(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`, 200);
    for (const x of k ?? []) seen.set(x[0], x[4]);
  }
  const rows = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => ({ t, c }));
  writeFileSync(cbFile, JSON.stringify(rows));
  console.log(`coinbase ${rows.length}`);
}

// Every USDT perp listed in the window, delisted ones included: 4h bars from listing, plus funding.
const lf = resolve(dir, "listings.json");
if (!existsSync(lf)) {
  type Info = { symbol: string; contractType: string; quoteAsset: string; status: string; onboardDate: number; underlyingType?: string };
  const info = await get<{ symbols: Info[] }>(`${FAPI}/fapi/v1/exchangeInfo`, 0);
  const list = (info?.symbols ?? []).filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.onboardDate >= from && s.onboardDate < now - 20 * DAY && (s.underlyingType ?? "COIN") === "COIN");
  console.log(`listings ${list.length}`);
  const out: Record<string, unknown> = {};
  for (const s of list) {
    const k = await get<Row[]>(`${FAPI}/fapi/v1/klines?symbol=${s.symbol}&interval=4h&limit=1000&startTime=${s.onboardDate}`, 130);
    const f = await get<{ fundingTime: number; fundingRate: string }[]>(`${FAPI}/fapi/v1/fundingRate?symbol=${s.symbol}&limit=1000&startTime=${s.onboardDate}`, 620);
    if (!k?.length) continue;
    out[s.symbol] = {
      on: Math.floor(s.onboardDate / 1000),
      status: s.status,
      bars: k.filter((x) => +x[6] < now).map((x) => [Math.floor(+x[0] / 1000), +x[1], +x[2], +x[3], +x[4], +x[7]]),
      funding: (f ?? []).map((x) => [Math.floor(x.fundingTime / 1000), +x.fundingRate]),
    };
  }
  writeFileSync(lf, JSON.stringify({ asOf: now, coins: out }));
  console.log(`saved ${Object.keys(out).length}`);
}
console.log("done");
