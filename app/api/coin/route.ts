import { analyze } from "@/lib/analyze.ts";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const sym = (new URL(req.url).searchParams.get("sym") ?? "").toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(sym)) return Response.json({ error: "bad symbol" }, { status: 400 });
  try {
    return Response.json(await analyze(sym));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
