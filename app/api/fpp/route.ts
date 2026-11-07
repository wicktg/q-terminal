import { cached, perpKlines, perpKlinesPaged } from "@/lib/data.ts";
import { FPP_SETUP, readFpp } from "@/lib/fpp.ts";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Future price prediction for one coin and timeframe. Heavy, so it is cached for a minute.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sym = (u.searchParams.get("sym") ?? "").toUpperCase();
  const tf = u.searchParams.get("tf") ?? "1h";
  if (!/^[A-Z0-9]{2,15}$/.test(sym) || !FPP_SETUP[tf]) return Response.json({ error: "bad params" }, { status: 400 });
  try {
    const read = await cached(`fpp:${sym}:${tf}`, 60e3, async () => {
      const { pages } = FPP_SETUP[tf];
      const [bars, daily, btc] = await Promise.all([
        perpKlinesPaged(sym, tf, pages),
        perpKlines(sym, "1d", 500),
        sym === "BTC" ? Promise.resolve([]) : perpKlinesPaged("BTC", tf, pages),
      ]);
      if (bars.length < 400) throw new Error("not enough history");
      return readFpp(sym, tf, bars, daily, btc);
    });
    return Response.json(read);
  } catch (e) {
    return Response.json({ error: `FPP needs Binance history for ${sym}. ${String(e).slice(0, 120)}` }, { status: 502 });
  }
}
