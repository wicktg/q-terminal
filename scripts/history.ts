// Downloads history for the backtest into data/history/<SYM>.json.
//   Binance: 1h perp and spot klines, funding, last 30 days of OI and long/short ratios.
//   Bybit: 4h OI and 1h account ratio, which go back much further than Binance keeps them.
// Run: node --experimental-strip-types --no-warnings scripts/history.ts [days] [SYM,SYM]
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FAPI = "https://fapi.binance.com";
const SPOT = "https://api.binance.com";
const BYBIT = "https://api.bybit.com";
const HOUR = 3600e3;
const LIST = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NEAR", "ENA", "LIT", "XRP", "DOGE", "BNB", "SUI", "LINK", "AVAX"];

const days = Number(process.argv[2] ?? 700);
const syms = process.argv[3]?.split(",") ?? LIST;
const OUT = resolve(import.meta.dirname, "../data/history");
mkdirSync(OUT, { recursive: true });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(url: string): Promise<T | null> {
  for (let n = 0; n < 5; n++) {
    await wait(220); // Binance allows 2400 weight a minute and a 1500-row kline costs 10
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) {
        await wait(5000 * (n + 1));
        continue;
      }
      if (!r.ok) return null; // no such market, or that history does not exist
      return (await r.json()) as T;
    } catch {
      await wait(2000 * (n + 1));
    }
  }
  return null;
}

type Row = (string | number)[];
const toBar = (k: Row) => ({ t: Math.floor(+k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], tb: +k[9] });

async function klines(base: string, path: string, sym: string, from: number, now: number) {
  const out: ReturnType<typeof toBar>[] = [];
  let start = from;
  while (start < now) {
    const rows = await get<Row[]>(`${base}${path}?symbol=${sym}USDT&interval=1h&limit=1000&startTime=${start}`);
    if (!rows?.length) break;
    for (const k of rows) if (+k[6] < now) out.push(toBar(k)); // closed bars only
    const next = +rows[rows.length - 1][0] + HOUR;
    if (rows.length < 1000 || next <= start) break;
    start = next;
  }
  return out;
}

async function funding(sym: string, from: number, now: number) {
  const out: { t: number; r: number }[] = [];
  let start = from;
  while (start < now) {
    const rows = await get<{ fundingTime: number; fundingRate: string }[]>(`${FAPI}/fapi/v1/fundingRate?symbol=${sym}USDT&limit=1000&startTime=${start}`);
    if (!rows?.length) break;
    for (const x of rows) out.push({ t: Math.floor(x.fundingTime / 1000), r: +x.fundingRate });
    if (rows.length < 1000) break;
    start = rows[rows.length - 1].fundingTime + 1;
  }
  return out;
}

// Binance only keeps about 30 days of these, one window of 500 rows at a time.
async function recent<T extends { timestamp: number }>(url: string, now: number) {
  const seen = new Map<number, T>();
  let end = now;
  for (let n = 0; n < 3; n++) {
    const rows = await get<T[]>(`${url}&period=1h&limit=500&endTime=${end}`);
    if (!rows?.length) break;
    for (const x of rows) seen.set(x.timestamp, x);
    end = rows[0].timestamp - 1;
  }
  return [...seen.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function bybitOi(sym: string, from: number) {
  const out: { t: number; v: number }[] = [];
  let cursor = "";
  for (let n = 0; n < 60; n++) {
    const r = await get<{ result: { list: { timestamp: string; openInterest: string }[]; nextPageCursor?: string } }>(
      `${BYBIT}/v5/market/open-interest?category=linear&symbol=${sym}USDT&intervalTime=4h&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const list = r?.result?.list;
    if (!list?.length) break;
    for (const x of list) out.push({ t: Math.floor(+x.timestamp / 1000), v: +x.openInterest });
    if (+list[list.length - 1].timestamp < from || !r?.result.nextPageCursor) break;
    cursor = r.result.nextPageCursor;
  }
  return out.filter((x) => x.t * 1000 >= from).sort((a, b) => a.t - b.t);
}

async function bybitRatio(sym: string, from: number) {
  const out: { t: number; r: number }[] = [];
  let cursor = "";
  for (let n = 0; n < 80; n++) {
    const r = await get<{ result: { list: { timestamp: string; buyRatio: string; sellRatio: string }[]; nextPageCursor?: string } }>(
      `${BYBIT}/v5/market/account-ratio?category=linear&symbol=${sym}USDT&period=4h&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const list = r?.result?.list;
    if (!list?.length) break;
    for (const x of list) out.push({ t: Math.floor(+x.timestamp / 1000), r: +x.buyRatio / (+x.sellRatio || 1) });
    if (+list[list.length - 1].timestamp < from || !r?.result.nextPageCursor) break;
    cursor = r.result.nextPageCursor;
  }
  return out.filter((x) => x.t * 1000 >= from).sort((a, b) => a.t - b.t);
}

const now = Date.now();
const from = now - days * 24 * HOUR;
for (const sym of syms) {
  const t0 = Date.now();
  const perp = await klines(FAPI, "/fapi/v1/klines", sym, from, now);
  const spot = await klines(SPOT, "/api/v3/klines", sym, from, now);
  const fund = await funding(sym, from, now);
  type OiRow = { timestamp: number; sumOpenInterest: string };
  type LsRow = { timestamp: number; longShortRatio: string };
  const oi = await recent<OiRow>(`${FAPI}/futures/data/openInterestHist?symbol=${sym}USDT`, now);
  const retail = await recent<LsRow>(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${sym}USDT`, now);
  const top = await recent<LsRow>(`${FAPI}/futures/data/topLongShortPositionRatio?symbol=${sym}USDT`, now);
  const byOi = await bybitOi(sym, from);
  const byRatio = await bybitRatio(sym, from);
  writeFileSync(
    resolve(OUT, `${sym}.json`),
    JSON.stringify({
      sym,
      asOf: now,
      perp,
      spot,
      funding: fund,
      oi: oi.map((x) => ({ t: Math.floor(x.timestamp / 1000), v: +x.sumOpenInterest })),
      retail: retail.map((x) => ({ t: Math.floor(x.timestamp / 1000), r: +x.longShortRatio })),
      top: top.map((x) => ({ t: Math.floor(x.timestamp / 1000), r: +x.longShortRatio })),
      bybitOi: byOi,
      bybitRatio: byRatio,
    }),
  );
  const d = (n: number) => (n / 24).toFixed(0);
  console.log(`${sym.padEnd(5)} perp ${d(perp.length)}d spot ${d(spot.length)}d funding ${fund.length} oi ${d(oi.length)}d retail ${d(retail.length)}d top ${d(top.length)}d bybitOi ${byOi.length} bybitRatio ${byRatio.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log("done");
