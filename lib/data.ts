// Server-side market data access with a small in-memory TTL cache.
// Binance USDT-M is the primary feed; Hyperliquid and Bybit add funding, OI and depth.
import { hlBar, hlName, spotName, type HlCandle } from "./format.ts";
import type { Bar } from "./types.ts";

const FAPI = "https://fapi.binance.com";
const SPOT = "https://api.binance.com";
const HL = "https://api.hyperliquid.xyz/info";
const BYBIT = "https://api.bybit.com";

type Entry = { exp: number; p: Promise<unknown> };
const store: Map<string, Entry> =
  ((globalThis as Record<string, unknown>).__qCache as Map<string, Entry>) ?? new Map();
(globalThis as Record<string, unknown>).__qCache = store;

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.p as Promise<T>;
  const p = fn().catch((e) => {
    store.delete(key);
    throw e;
  });
  store.set(key, { exp: now + ttlMs, p });
  return p;
}

async function json<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(12000), cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

const hl = <T,>(body: unknown) =>
  json<T>(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type RawKline = (string | number)[];
const toBar = (k: RawKline): Bar => ({
  t: Math.floor(Number(k[0]) / 1000),
  o: +k[1],
  h: +k[2],
  l: +k[3],
  c: +k[4],
  v: +k[5],
  q: +k[7],
  tb: +k[9],
});

const TTL: Record<string, number> = { "5m": 15e3, "15m": 20e3, "30m": 30e3, "1h": 30e3, "4h": 60e3, "1d": 120e3 };
// Short requests are the chart's live pulse, so they must not sit behind the history cache.
const ttlFor = (tf: string, limit: number) => (limit <= 5 ? 2e3 : (TTL[tf] ?? 30e3));

export const perpKlines = (sym: string, tf: string, limit: number) =>
  cached(`k:${sym}:${tf}:${limit}`, ttlFor(tf, limit), async () =>
    (await json<RawKline[]>(`${FAPI}/fapi/v1/klines?symbol=${sym}USDT&interval=${tf}&limit=${limit}`)).map(toBar),
  );

export const spotKlines = (sym: string, tf: string, limit: number) =>
  cached(`s:${sym}:${tf}:${limit}`, ttlFor(tf, limit), async () => {
    try {
      const l = Math.min(limit, 1000);
      return (await json<RawKline[]>(`${SPOT}/api/v3/klines?symbol=${spotName(sym)}USDT&interval=${tf}&limit=${l}`)).map(toBar);
    } catch {
      return [] as Bar[]; // no spot market on Binance
    }
  });

const TF_MS: Record<string, number> = { "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "4h": 144e5, "1d": 864e5 };

export const hlKlines = (sym: string, tf: string, limit: number) =>
  cached(`hlk:${sym}:${tf}:${limit}`, ttlFor(tf, limit), async () => {
    const endTime = Date.now();
    const req = { coin: hlName(sym), interval: tf, startTime: endTime - limit * TF_MS[tf], endTime };
    return (await hl<HlCandle[]>({ type: "candleSnapshot", req })).map(hlBar);
  });

type OiRow = { timestamp: number; sumOpenInterest: string; CMCCirculatingSupply?: string };
export const oiHist = (sym: string, period: string, limit: number) =>
  cached(`oi:${sym}:${period}:${limit}`, 60e3, () =>
    json<OiRow[]>(`${FAPI}/futures/data/openInterestHist?symbol=${sym}USDT&period=${period}&limit=${limit}`),
  );

export const lsRatio = (sym: string, kind: "global" | "top", limit = 500) =>
  cached(`ls:${sym}:${kind}`, 60e3, async () => {
    const path = kind === "global" ? "globalLongShortAccountRatio" : "topLongShortPositionRatio";
    const r = await json<{ longShortRatio: string }[]>(
      `${FAPI}/futures/data/${path}?symbol=${sym}USDT&period=1h&limit=${limit}`,
    );
    return r.map((x) => +x.longShortRatio);
  });

export const premiumIndex = (sym: string) =>
  cached(`pi:${sym}`, 15e3, () => json<{ lastFundingRate: string; markPrice: string }>(`${FAPI}/fapi/v1/premiumIndex?symbol=${sym}USDT`));

// Binance lists only the symbols that differ from the usual 8h funding cycle.
export const fundingHours = () =>
  cached("fundinfo", 3600e3, async () => {
    const rows = await json<{ symbol: string; fundingIntervalHours: number }[]>(`${FAPI}/fapi/v1/fundingInfo`);
    return new Map(rows.map((r) => [r.symbol, r.fundingIntervalHours]));
  });

type HlMeta = { universe: { name: string }[] };
type HlCtx = { funding: string; openInterest: string; premium: string | null; markPx: string };
export const hlCtxs = () =>
  cached("hl:ctx", 15e3, async () => {
    const [meta, ctx] = await hl<[HlMeta, HlCtx[]]>({ type: "metaAndAssetCtxs" });
    const out: Record<string, HlCtx> = {};
    meta.universe.forEach((u, i) => (out[u.name] = ctx[i]));
    return out;
  });

export type DepthSide = [number, number][]; // [price, usd]
export type Depth = { venue: string; bids: DepthSide; asks: DepthSide };
const usd = (rows: [string, string][]): DepthSide => rows.map(([p, q]) => [+p, +p * +q]);

export const depthAll = (sym: string) =>
  cached(`d:${sym}`, 3e3, async () => {
    const out: Depth[] = [];
    const jobs: Promise<void>[] = [
      json<{ bids: [string, string][]; asks: [string, string][] }>(`${FAPI}/fapi/v1/depth?symbol=${sym}USDT&limit=1000`).then((d) => {
        out.push({ venue: "Binance", bids: usd(d.bids), asks: usd(d.asks) });
      }),
      json<{ result: { b: [string, string][]; a: [string, string][] } }>(
        `${BYBIT}/v5/market/orderbook?category=linear&symbol=${sym}USDT&limit=500`,
      ).then((d) => {
        if (d.result?.b) out.push({ venue: "Bybit", bids: usd(d.result.b), asks: usd(d.result.a) });
      }),
      hl<{ levels: { px: string; sz: string }[][] }>({ type: "l2Book", coin: hlName(sym), nSigFigs: 3 }).then((d) => {
        if (d?.levels) {
          const side = (r: { px: string; sz: string }[]): DepthSide => r.map((x) => [+x.px, +x.px * +x.sz]);
          out.push({ venue: "Hyperliquid", bids: side(d.levels[0]), asks: side(d.levels[1]) });
        }
      }),
    ];
    await Promise.allSettled(jobs);
    return out;
  });

export const universe = () =>
  cached("uni", 10e3, async () => {
    const [tick, prem, info, hours] = await Promise.all([
      json<{ symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[]>(`${FAPI}/fapi/v1/ticker/24hr`),
      json<{ symbol: string; lastFundingRate: string }[]>(`${FAPI}/fapi/v1/premiumIndex`),
      cached("info", 3600e3, () =>
        json<{ symbols: { symbol: string; contractType: string; status: string; quoteAsset: string; baseAsset: string; filters?: { filterType: string; tickSize?: string }[] }[] }>(
          `${FAPI}/fapi/v1/exchangeInfo`,
        ),
      ),
      fundingHours(),
    ]);
    const fund = new Map(prem.map((p) => [p.symbol, +p.lastFundingRate]));
    // Decimals in the tick size, so "0.0010" is 3 and "0.10" is 1.
    const dp = new Map(
      info.symbols.map((s) => {
        const tick = s.filters?.find((f) => f.filterType === "PRICE_FILTER")?.tickSize;
        return [s.symbol, tick ? (tick.replace(/0+$/, "").split(".")[1] ?? "").length : undefined] as const;
      }),
    );
    const live = new Set(
      info.symbols
        .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING" && s.quoteAsset === "USDT")
        .map((s) => s.symbol),
    );
    return tick
      .filter((t) => live.has(t.symbol))
      .map((t) => ({
        sym: t.symbol.replace(/USDT$/, ""),
        price: +t.lastPrice,
        chg24h: +t.priceChangePercent,
        vol24hUsd: +t.quoteVolume,
        funding: ((fund.get(t.symbol) ?? 0) * 24 * 365 * 100) / (hours.get(t.symbol) ?? 8),
        dp: dp.get(t.symbol),
      }))
      .sort((a, b) => b.vol24hUsd - a.vol24hUsd);
  });
