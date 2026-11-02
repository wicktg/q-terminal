import { getNews } from "@/lib/news.ts";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await getNews());
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
