import { cachedSticky } from "@/lib/data.ts";
import { readHyper } from "@/lib/hyper.ts";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// HYPERMODE for one coin: market makers on Hyperliquid read with structure and the analog range engine.
export async function GET(req: Request) {
  const sym = (new URL(req.url).searchParams.get("sym") ?? "").toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(sym)) return Response.json({ error: "bad symbol" }, { status: 400 });
  try {
    return Response.json(await cachedSticky(`hyper:${sym}`, 20e3, () => readHyper(sym), 3 * 60e3));
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 160) }, { status: 502 });
  }
}
