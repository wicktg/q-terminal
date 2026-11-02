import { labRead, type LabRead } from "@/lib/lab-live.ts";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const u = new URL(req.url);
  const syms = (u.searchParams.get("syms") ?? u.searchParams.get("sym") ?? "")
    .toUpperCase()
    .split(",")
    .filter((s) => /^[A-Z0-9]{2,15}$/.test(s))
    .slice(0, 30);
  if (!syms.length) return Response.json({ error: "bad symbol" }, { status: 400 });
  const out: LabRead[] = [];
  const queue = [...syms];
  await Promise.all(
    [0, 1, 2].map(async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          out.push(await labRead(s));
        } catch {
          // one failed coin must not sink the rest
        }
      }
    }),
  );
  return Response.json(out);
}
