import { analyze } from "@/lib/analyze.ts";
import type { ScreenerRow } from "@/lib/types.ts";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const syms = (new URL(req.url).searchParams.get("syms") ?? "")
    .toUpperCase()
    .split(",")
    .filter((s) => /^[A-Z0-9]{2,15}$/.test(s))
    .slice(0, 30);
  const out: ScreenerRow[] = [];
  const queue = [...syms];
  await Promise.all(
    [0, 1].map(async () => {
      for (let sym = queue.shift(); sym; sym = queue.shift()) {
        try {
          const a = await analyze(sym);
          const e = a.ta.frames.at(-1)?.event;
          out.push({
            sym,
            price: a.price,
            chg24h: a.stats.chg24h,
            frames: a.ta.frames.map((f) => ({ tf: f.tf, trend: f.trend })),
            event: e ? `${e.kind} ${e.dir > 0 ? "up" : "down"}` : "none",
          });
        } catch {
          // one failed coin must not sink the table
        }
      }
    }),
  );
  return Response.json(out.sort((a, b) => syms.indexOf(a.sym) - syms.indexOf(b.sym)));
}
