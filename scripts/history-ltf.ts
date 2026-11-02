// Downloads 5m bars, the base for every timeframe in the multi-timeframe simulations, plus funding and 1h OI.
// Watchlist coins are used for the search. Holdout coins (UNI and AERO) are never searched.
// Bars are stored as a flat Float64Array of [t,o,h,l,c,v,q,tb] rows. Finished coins are skipped, so a rerun resumes.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FAPI = "https://fapi.binance.com";
const BYBIT = "https://api.bybit.com";
const FIVE = 300e3;
const DAY = 86400e3;
const WATCH = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NEAR", "ENA", "LIT", "XRP", "DOGE", "BNB", "SUI", "LINK", "AVAX"];
const dir = resolve(import.meta.dirname, "../data/ltf");
mkdirSync(dir, { recursive: true });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get<T>(url: string, gap = 260): Promise<T | null> {
  for (let n = 0; n < 6; n++) {
    await wait(gap);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
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

const HOLD = ["UNI", "AERO"];
writeFileSync(resolve(dir, "universe.json"), JSON.stringify({ watch: WATCH, hold: HOLD }));
console.log("holdout coins:", HOLD.join(" "));

const now = Date.now();
const from = now - 700 * DAY;
for (const sym of [...WATCH, ...HOLD]) {
  const t0 = Date.now();
  const barsFile = resolve(dir, `${sym}.5m.bin`);
  if (!existsSync(barsFile)) {
    const chunks: number[] = [];
    let start = from;
    while (start < now) {
      const rows = await get<(string | number)[][]>(`${FAPI}/fapi/v1/klines?symbol=${sym}USDT&interval=5m&limit=1500&startTime=${start}`);
      if (!rows?.length) break;
      for (const k of rows) if (+k[6] < now) chunks.push(Math.floor(+k[0] / 1000), +k[1], +k[2], +k[3], +k[4], +k[5], +k[7], +k[9]);
      const next = +rows[rows.length - 1][0] + FIVE;
      if (rows.length < 1500 || next <= start) break;
      start = next;
    }
    writeFileSync(barsFile, Buffer.from(new Float64Array(chunks).buffer));
  }
  const fundFile = resolve(dir, `${sym}.funding.json`);
  if (!existsSync(fundFile)) {
    const out: { t: number; r: number }[] = [];
    let start = from;
    while (start < now) {
      const rows = await get<{ fundingTime: number; fundingRate: string }[]>(`${FAPI}/fapi/v1/fundingRate?symbol=${sym}USDT&limit=1000&startTime=${start}`, 650);
      if (!rows?.length) break;
      for (const x of rows) out.push({ t: Math.floor(x.fundingTime / 1000), r: +x.fundingRate });
      if (rows.length < 1000) break;
      start = rows[rows.length - 1].fundingTime + 1;
    }
    writeFileSync(fundFile, JSON.stringify(out));
  }
  const oiFile = resolve(dir, `${sym}.oi1h.json`);
  if (!existsSync(oiFile)) {
    const out: { t: number; v: number }[] = [];
    let cursor = "";
    for (let n = 0; n < 100; n++) {
      const r = await get<{ result: { list: { timestamp: string; openInterest: string }[]; nextPageCursor?: string } }>(
        `${BYBIT}/v5/market/open-interest?category=linear&symbol=${sym}USDT&intervalTime=1h&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        120,
      );
      const list = r?.result?.list;
      if (!list?.length) break;
      for (const x of list) out.push({ t: Math.floor(+x.timestamp / 1000), v: +x.openInterest });
      if (+list[list.length - 1].timestamp < from || !r?.result.nextPageCursor) break;
      cursor = r.result.nextPageCursor;
    }
    writeFileSync(oiFile, JSON.stringify(out.sort((a, b) => a.t - b.t)));
  }
  console.log(`${sym} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log("done");
