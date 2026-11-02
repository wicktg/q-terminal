import { hlKlines, perpKlines, spotKlines } from "@/lib/data.ts";
import { delta } from "@/lib/quant.ts";
export const dynamic = "force-dynamic";
const TF = new Set(["5m", "15m", "1h", "4h", "1d"]);
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sym = (u.searchParams.get("sym") ?? "").toUpperCase();
  const tf = u.searchParams.get("tf") ?? "1h";
  const limit = Math.min(1500, Math.max(2, Number(u.searchParams.get("limit") ?? 1000)));
  if (!/^[A-Z0-9]{2,15}$/.test(sym) || !TF.has(tf)) return Response.json({ error: "bad params" }, { status: 400 });
  try {
    if (u.searchParams.get("venue") === "hl") return Response.json({ bars: await hlKlines(sym, tf, limit), spot: [] });
    const [bars, sp] = await Promise.all([perpKlines(sym, tf, limit), spotKlines(sym, tf, limit)]);
    return Response.json({ bars, spot: sp.map((b) => ({ t: b.t, d: delta(b) })) });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
