import { analyze, buildBook } from "@/lib/analyze.ts";
import { depthAll } from "@/lib/data.ts";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const sym = (new URL(req.url).searchParams.get("sym") ?? "").toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(sym)) return Response.json({ error: "bad symbol" }, { status: 400 });
  try {
    const [depth, a] = await Promise.all([depthAll(sym), analyze(sym)]);
    if (!depth.length) return Response.json({ error: "no depth" }, { status: 502 });
    return Response.json(buildBook(depth, a.price, a.liq.clusters));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
