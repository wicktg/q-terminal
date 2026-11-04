import { hlKlines, perpKlines } from "@/lib/data.ts";
export const dynamic = "force-dynamic";

// 30-minute bars for Market Profile. Binance first, Hyperliquid for coins Binance does not list.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sym = (u.searchParams.get("sym") ?? "").toUpperCase();
  const days = Math.min(20, Math.max(2, Number(u.searchParams.get("days") ?? 12)));
  if (!/^[A-Z0-9]{2,15}$/.test(sym)) return Response.json({ error: "bad params" }, { status: 400 });
  const slim = (bars: { t: number; o: number; h: number; l: number; c: number }[]) => bars.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
  try {
    return Response.json({ venue: "Binance", bars: slim(await perpKlines(sym, "30m", days * 48)) });
  } catch {
    try {
      return Response.json({ venue: "Hyperliquid", bars: slim(await hlKlines(sym, "30m", days * 48)) });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  }
}
