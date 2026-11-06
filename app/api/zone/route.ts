import { flows, measure, overlap } from "@/lib/absorb.ts";
import { deepBooks, perpKlines, spotKlines } from "@/lib/data.ts";
import { liquidityIn } from "@/lib/zoneliq.ts";
export const dynamic = "force-dynamic";

// Everything the zone card shows: resting size by venue, delta over the last hour, and flow absorbed since it formed.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sym = (u.searchParams.get("sym") ?? "").toUpperCase();
  const [lo, hi, side, born] = ["lo", "hi", "side", "born"].map((k) => Number(u.searchParams.get(k)));
  if (!/^[A-Z0-9]{2,15}$/.test(sym) || !(hi > lo) || !Number.isFinite(side)) return Response.json({ error: "bad params" }, { status: 400 });
  const s = side > 0 ? 1 : -1;
  try {
    const [books, p1, s1, p15, s15] = await Promise.all([deepBooks(sym), perpKlines(sym, "1m", 61), spotKlines(sym, "1m", 61), perpKlines(sym, "15m", 1000), spotKlines(sym, "15m", 1000)]);
    const price = p1[p1.length - 1].c;
    // Delta: market buys minus market sells over the last 60 minutes, and the part that traded inside the zone.
    const cut = p1[p1.length - 1].t - 59 * 60;
    const F1 = flows(p1, s1).filter((f) => f.t >= cut);
    let [buy, sell, zBuy, zSell] = [0, 0, 0, 0];
    for (const f of F1) {
      buy += f.buy;
      sell += f.sell;
      const k = overlap(f, hi, lo);
      zBuy += f.buy * k;
      zSell += f.sell * k;
    }
    const F15 = flows(p15, s15);
    const from = Number.isFinite(born) && born > 0 ? born : F15[0]?.t ?? 0;
    const m = measure(F15, s, hi, lo, from, Infinity, price);
    return Response.json({
      price,
      liquidity: liquidityIn(books, lo, hi, s),
      delta: { buy, sell, net: buy - sell, zoneBuy: zBuy, zoneSell: zSell, minutes: F1.length },
      absorbed: { absorbed: m.absorbed, opposing: m.opposing, touches: m.touches, deepest: m.deepest, partial: from < (F15[0]?.t ?? 0) },
    });
  } catch (e) {
    return Response.json({ error: `No data for ${sym}. ${String(e).slice(0, 120)}` }, { status: 502 });
  }
}
