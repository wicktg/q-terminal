// Market maker footprint on Hyperliquid, read from public account data.
// For each tracked market maker: what it holds, where its resting quotes sit, and how it traded in its most recent
// fills. Rolled up per coin into net inventory, quote skew, aggressive and passive flow, and one pressure score.
// Open interest, funding, liquidations and long/short ratios are not used.
import { cachedSticky } from "./data.ts";
import { MM_SEED } from "./mm-seed.ts";

const HL = "https://api.hyperliquid.xyz/info";
const HLP_VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const HLP_FALLBACK = ["0x010461c14e146ac35fe42271bdc1134ee31c703a", "0x31ca8395cf837de08b24da3f660e77761dfb974b"];
const BAND = 0.02; // quotes within 2% of mid count toward skew
const MAKER_FILLS = 4; // fills cost the most request weight (about 120 each), so only this many makers get them

export type Maker = { id: string; name: string; kind: "named" | "protocol" | "detected"; note: string; fills: boolean };
type Pos = { szi: number; entry: number; upnl: number };
type Ord = { side: 1 | -1; px: number; sz: number };
type Fl = { buy: number; sell: number; tBuy: number; tSell: number; start: number };
type AddrState = { pos: Record<string, Pos>; orders: Record<string, Ord[]> };
type AddrFills = { t0: number; t1: number; by: Record<string, Fl> };
export type MakerData = { maker: Maker; states: AddrState[]; fills: AddrFills | null };

async function info<T>(body: unknown): Promise<T> {
  for (let a = 0; ; a++) {
    const r = await fetch(HL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (r.ok) return (await r.json()) as T;
    // Rate limits and hiccups get three tries with backoff; anything else fails at once.
    if (a >= 2 || (r.status !== 429 && r.status < 500)) throw new Error(`Hyperliquid ${r.status}`);
    await new Promise((s) => setTimeout(s, 700 * 2 ** a));
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const bn = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${Math.round(x / 1e6)}M`);
export const MAKERS: Maker[] = [
  { id: "0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00", name: "Wintermute", kind: "named", note: "Address you supplied", fills: true },
  { id: "hlp", name: "HLP", kind: "protocol", note: "Hyperliquid's own market-making vault", fills: false },
  ...MM_SEED.makers.map((m, i): Maker => ({
    id: m.addr,
    name: m.name ? `${m.name} ${short(m.addr)}` : short(m.addr),
    kind: "detected",
    note: `${Math.round(m.maker * 100)}% maker over 14 days, ${bn(m.vol14)} volume, quoting both sides in ${m.quoted} markets (found ${MM_SEED.found})`,
    fills: i < MAKER_FILLS - 1,
  })),
];

// HLP quotes through child accounts; only the ones holding positions or orders matter.
const hlpAddrs = () =>
  cachedSticky("mm:hlp", 12 * 3600e3, async () => {
    const v = await info<{ relationship?: { data?: { childAddresses?: string[] } } }>({ type: "vaultDetails", vaultAddress: HLP_VAULT }).catch(() => null);
    const kids = v?.relationship?.data?.childAddresses ?? [];
    if (!kids.length) return HLP_FALLBACK;
    const live = await Promise.all(
      kids.map(async (k) => {
        const st = await info<{ assetPositions: unknown[] }>({ type: "clearinghouseState", user: k }).catch(() => null);
        return st && st.assetPositions.length ? k : null;
      }),
    );
    return live.filter((x): x is string => !!x);
  });

const addrState = (addr: string) =>
  cachedSticky(`mm:s:${addr}`, 45e3, async (): Promise<AddrState> => {
    type St = { assetPositions: { position: { coin: string; szi: string; entryPx: string; unrealizedPnl: string } }[] };
    type Oo = { coin: string; side: string; limitPx: string; sz: string; isTrigger: boolean }[];
    const [st, oo] = await Promise.all([info<St>({ type: "clearinghouseState", user: addr }), info<Oo>({ type: "frontendOpenOrders", user: addr })]);
    const pos: AddrState["pos"] = {};
    for (const { position: p } of st.assetPositions) pos[p.coin] = { szi: +p.szi, entry: +p.entryPx, upnl: +p.unrealizedPnl };
    const orders: AddrState["orders"] = {};
    for (const o of oo) {
      if (o.isTrigger) continue;
      (orders[o.coin] ??= []).push({ side: o.side === "B" ? 1 : -1, px: +o.limitPx, sz: +o.sz });
    }
    return { pos, orders };
  });

// The latest 2,000 fills. For a busy maker that is minutes; for a quieter one, hours. The window is reported.
const addrFills = (addr: string) =>
  cachedSticky(`mm:f:${addr}`, 90e3, async (): Promise<AddrFills | null> => {
    type F = { coin: string; px: string; sz: string; side: string; time: number; startPosition: string; crossed: boolean };
    const rows = await info<F[]>({ type: "userFills", user: addr, aggregateByTime: true });
    if (!rows.length) return null;
    const by: AddrFills["by"] = {};
    for (const f of [...rows].reverse()) {
      if (f.coin.startsWith("@") || f.coin.includes(":")) continue; // spot and builder markets
      const usd = +f.px * +f.sz;
      const x = (by[f.coin] ??= { buy: 0, sell: 0, tBuy: 0, tSell: 0, start: +f.startPosition });
      if (f.side === "B") {
        x.buy += usd;
        if (f.crossed) x.tBuy += usd;
      } else {
        x.sell += usd;
        if (f.crossed) x.tSell += usd;
      }
    }
    return { t0: rows[rows.length - 1].time, t1: rows[0].time, by };
  });

export async function loadMakers(): Promise<MakerData[]> {
  const hlp = await hlpAddrs().catch(() => HLP_FALLBACK);
  return Promise.all(
    MAKERS.map(async (maker) => {
      const addrs = maker.id === "hlp" ? hlp : [maker.id];
      const states = (await Promise.all(addrs.map((a) => addrState(a).catch(() => null)))).filter((s): s is AddrState => !!s);
      const fills = maker.fills ? await addrFills(maker.id).catch(() => null) : null;
      return { maker, states, fills };
    }),
  );
}

// Mid price, 24h volume and prior-day price for every Hyperliquid perp.
export type Ctx = { mid: number; dayVlm: number; prev: number };
export const hlMarket = () =>
  cachedSticky("mm:ctx", 15e3, async () => {
    type R = [{ universe: { name: string }[] }, { midPx: string | null; markPx: string; dayNtlVlm: string; prevDayPx: string }[]];
    const [meta, ctxs] = await info<R>({ type: "metaAndAssetCtxs" });
    const out: Record<string, Ctx> = {};
    meta.universe.forEach((u, i) => {
      const c = ctxs[i];
      if (c) out[u.name] = { mid: +(c.midPx ?? c.markPx), dayVlm: +c.dayNtlVlm, prev: +c.prevDayPx };
    });
    return out;
  });

export type MakerCoin = {
  name: string;
  kind: Maker["kind"];
  note: string;
  pos: { coins: number; usd: number; entry: number; upnl: number } | null;
  quotes: { bid: number; ask: number; n: number; bestBid: number | null; bestAsk: number | null; skew: number; center: number | null } | null;
  flow: { minutes: number; net: number; taker: number; takerNet: number; maker: number; makerNet: number; dCoins: number } | null;
};
export type Wall = { name: string; side: 1 | -1; px: number; usd: number };
export type MmRead = {
  coin: string;
  mid: number;
  makers: MakerCoin[];
  net: { coins: number; usd: number };
  quotes: { bid: number; ask: number; skew: number };
  flow: { minutes: [number, number] | null; taker: number; takerNet: number; maker: number; makerNet: number; dCoins: number; scale: number };
  parts: { quote: number; aggressive: number; passive: number }; // each -1..1, positive pushes up
  pressure: number; // -100..100
  orders: Ord[]; // every maker order within reach, for depth and walls
  walls: Wall[];
};

// One maker's quotes in one coin: size and distance on each side within the band, and their lean.
function quoteRead(orders: Ord[], mid: number) {
  let [bid, ask, dB, dA] = [0, 0, 0, 0];
  let [bestBid, bestAsk] = [null as number | null, null as number | null];
  for (const o of orders) {
    const d = Math.abs(o.px / mid - 1);
    if (o.side > 0) bestBid = bestBid === null ? o.px : Math.max(bestBid, o.px);
    else bestAsk = bestAsk === null ? o.px : Math.min(bestAsk, o.px);
    if (d > BAND) continue;
    const usd = o.px * o.sz;
    if (o.side > 0) {
      bid += usd;
      dB += usd * d;
    } else {
      ask += usd;
      dA += usd * d;
    }
  }
  if (bid + ask === 0) return { bid, ask, n: orders.length, bestBid, bestAsk, skew: 0, center: null };
  // Bigger and closer on the bid means they would rather buy; on the ask, rather sell.
  const size = (bid - ask) / (bid + ask);
  const [mb, ma] = [bid ? dB / bid : 0, ask ? dA / ask : 0];
  const dist = !bid ? -1 : !ask ? 1 : (ma - mb) / (ma + mb || 1);
  const center = bestBid !== null && bestAsk !== null ? ((bestBid + bestAsk) / 2 / mid - 1) * 1e4 : null;
  return { bid, ask, n: orders.length, bestBid, bestAsk, skew: 0.5 * size + 0.5 * dist, center };
}

const clamp = (x: number) => Math.max(-1, Math.min(1, x));

export function readMm(coin: string, ctx: Ctx, data: MakerData[], reach = 0.05): MmRead {
  const mid = ctx.mid;
  const rows: MakerCoin[] = [];
  const all: Ord[] = [];
  const walls: Wall[] = [];
  let [netCoins, qBid, qAsk, qSkewW, taker, takerNet, mk, mkNet, dCoins] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const spans: number[] = [];
  for (const { maker, states, fills } of data) {
    let pos: MakerCoin["pos"] = null;
    const orders: Ord[] = [];
    for (const s of states) {
      const p = s.pos[coin];
      if (p) {
        pos ??= { coins: 0, usd: 0, entry: 0, upnl: 0 };
        // Size-weighted entry across child accounts.
        const tot = Math.abs(pos.coins) + Math.abs(p.szi);
        pos.entry = tot ? (pos.entry * Math.abs(pos.coins) + p.entry * Math.abs(p.szi)) / tot : p.entry;
        pos.coins += p.szi;
        pos.upnl += p.upnl;
      }
      orders.push(...(s.orders[coin] ?? []));
    }
    if (pos) pos.usd = pos.coins * mid;
    const q = orders.length ? quoteRead(orders, mid) : null;
    let flow: MakerCoin["flow"] = null;
    if (fills) {
      const minutes = (fills.t1 - fills.t0) / 6e4;
      spans.push(minutes);
      const f = fills.by[coin];
      if (f) {
        const now = pos?.coins ?? 0;
        flow = { minutes, net: f.buy - f.sell, taker: f.tBuy + f.tSell, takerNet: f.tBuy - f.tSell, maker: f.buy + f.sell - f.tBuy - f.tSell, makerNet: f.buy - f.tBuy - (f.sell - f.tSell), dCoins: now - f.start };
      } else flow = { minutes, net: 0, taker: 0, takerNet: 0, maker: 0, makerNet: 0, dCoins: 0 };
    }
    if (!pos && !q && !(flow && flow.taker + flow.maker > 0)) continue;
    rows.push({ name: maker.name, kind: maker.kind, note: maker.note, pos, quotes: q, flow });
    netCoins += pos?.coins ?? 0;
    if (q) {
      qBid += q.bid;
      qAsk += q.ask;
      qSkewW += q.skew * (q.bid + q.ask);
    }
    if (flow) {
      taker += flow.taker;
      takerNet += flow.takerNet;
      mk += flow.maker;
      mkNet += flow.makerNet;
      dCoins += flow.dCoins;
    }
    for (const o of orders) {
      if (Math.abs(o.px / mid - 1) > reach) continue;
      all.push(o);
      walls.push({ name: maker.name, side: o.side, px: o.px, usd: o.px * o.sz });
    }
  }
  rows.sort((a, b) => Math.abs(b.pos?.usd ?? 0) + (b.quotes ? b.quotes.bid + b.quotes.ask : 0) - (Math.abs(a.pos?.usd ?? 0) + (a.quotes ? a.quotes.bid + a.quotes.ask : 0)));

  // Flow counts fully once it is about 2% of the coin's usual volume over the same window.
  const win = spans.length ? Math.max(...spans) : 0;
  const scale = Math.max(1e4, (ctx.dayVlm * win) / 1440 * 0.02);
  const quote = qBid + qAsk > 5e3 ? clamp(qSkewW / (qBid + qAsk)) : 0;
  const aggressive = taker ? clamp((takerNet / taker) * Math.min(1, taker / scale)) : 0;
  // Passive buying means takers were selling into the makers. That flow is usually informed, and the makers will
  // lean to unload it, so it counts against the direction they bought.
  const passive = mk ? clamp((mkNet / mk) * Math.min(1, mk / (2 * scale))) : 0;
  const pressure = Math.round(100 * clamp(0.5 * quote + 0.35 * aggressive - 0.15 * passive));
  walls.sort((a, b) => b.usd - a.usd);
  return {
    coin,
    mid,
    makers: rows,
    net: { coins: netCoins, usd: netCoins * mid },
    quotes: { bid: qBid, ask: qAsk, skew: quote },
    flow: { minutes: spans.length ? [Math.min(...spans), Math.max(...spans)] : null, taker, takerNet, maker: mk, makerNet: mkNet, dCoins, scale },
    parts: { quote, aggressive, passive: -passive },
    pressure,
    orders: all,
    walls: walls.slice(0, 6),
  };
}
