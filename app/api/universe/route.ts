import { universe } from "@/lib/data.ts";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await universe());
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
