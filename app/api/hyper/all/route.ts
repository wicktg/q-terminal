import { cachedSticky } from "@/lib/data.ts";
import { readHyperAll } from "@/lib/hyper.ts";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Maker footprint for a list of coins, for the HYPERMODE strip.
export async function GET(req: Request) {
  const syms = (new URL(req.url).searchParams.get("syms") ?? "").toUpperCase().split(",").filter((s) => /^[A-Z0-9]{2,15}$/.test(s)).slice(0, 40);
  if (!syms.length) return Response.json({ error: "no symbols" }, { status: 400 });
  try {
    return Response.json(await cachedSticky(`hyperall:${syms.join(",")}`, 20e3, () => readHyperAll(syms), 3 * 60e3));
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 160) }, { status: 502 });
  }
}
