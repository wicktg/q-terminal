import { readAbsorb } from "@/lib/absorb.ts";
import { cached, perpKlines, spotKlines } from "@/lib/data.ts";
export const dynamic = "force-dynamic";

// Absorption needs a buy and sell split per bar, which only the Binance feeds carry.
export async function GET(req: Request) {
  const sym = (new URL(req.url).searchParams.get("sym") ?? "").toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(sym)) return Response.json({ error: "bad params" }, { status: 400 });
  try {
    const read = await cached(`absorb:${sym}`, 30e3, async () => {
      const [p15, s15, h1, h4] = await Promise.all([perpKlines(sym, "15m", 1000), spotKlines(sym, "15m", 1000), perpKlines(sym, "1h", 1000), perpKlines(sym, "4h", 500)]);
      return readAbsorb(sym, p15, s15, h1, h4);
    });
    return Response.json(read);
  } catch (e) {
    return Response.json({ error: `No Binance taker data for ${sym}. ${String(e).slice(0, 120)}` }, { status: 502 });
  }
}
