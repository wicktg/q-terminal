import { cached, perpKlines, perpKlinesPaged } from "@/lib/data.ts";
import { readWicks, SUB_TF } from "@/lib/wicks.ts";
export const dynamic = "force-dynamic";

// Wick flow needs a buy and sell split from smaller candles, which only the Binance perp feed carries.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sym = (u.searchParams.get("sym") ?? "").toUpperCase();
  const tf = u.searchParams.get("tf") ?? "1h";
  if (!/^[A-Z0-9]{2,15}$/.test(sym) || !SUB_TF[tf]) return Response.json({ error: "bad params" }, { status: 400 });
  try {
    const read = await cached(`wicks:${sym}:${tf}`, 20e3, async () => {
      const [subTf, pages] = SUB_TF[tf];
      const [bars, sub] = await Promise.all([perpKlines(sym, tf, 1000), perpKlinesPaged(sym, subTf, pages)]);
      return readWicks(sym, tf, bars, sub);
    });
    return Response.json(read);
  } catch (e) {
    return Response.json({ error: `No Binance data for ${sym}. ${String(e).slice(0, 120)}` }, { status: 502 });
  }
}
