import { deepBooks } from "@/lib/data.ts";
import { liquidityIn } from "@/lib/zoneliq.ts";
export const dynamic = "force-dynamic";

// Resting dollars inside each zone, for the chart's zone labels. z = lo_hi_side,lo_hi_side,...
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sym = (u.searchParams.get("sym") ?? "").toUpperCase();
  const zones = (u.searchParams.get("z") ?? "")
    .split(",")
    .slice(0, 20)
    .map((x) => x.split("_").map(Number))
    .filter((v) => v.length === 3 && v.every(Number.isFinite) && v[1] > v[0]);
  if (!/^[A-Z0-9]{2,15}$/.test(sym) || !zones.length) return Response.json({ error: "bad params" }, { status: 400 });
  try {
    const books = await deepBooks(sym);
    return Response.json(zones.map(([lo, hi, side]) => {
      const r = liquidityIn(books, lo, hi, side > 0 ? 1 : -1);
      return { usd: r.usd, complete: r.complete };
    }));
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 160) }, { status: 502 });
  }
}
