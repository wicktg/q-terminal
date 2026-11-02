// Who does this account talk to about trading, and what did he say in replies about technique?
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const user = process.argv[2] ?? "tradermatt";
const dir = resolve(import.meta.dirname, "../data/x", user);
type T = { id: string; text: string; createdAt: string; isReply?: boolean; inReplyToUsername?: string; likeCount?: number; quoted_tweet?: { text?: string; author?: { userName?: string; followers?: number } } | null; author?: { userName?: string } };
const d = JSON.parse(readFileSync(resolve(dir, "posts.json"), "utf8")) as { posts: T[]; threads: Record<string, T[]> };
const count = new Map<string, number>();
const add = (n?: string) => n && n.toLowerCase() !== user.toLowerCase() && count.set(n, (count.get(n) ?? 0) + 1);
for (const p of d.posts) {
  add(p.inReplyToUsername);
  add(p.quoted_tweet?.author?.userName);
}
console.log([...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k}:${v}`).join("  "));
const RE = /\b(stop|sl\b|base|breakdown|breakout|retest|deviat|sfp|trail|entry|enter|confirm|session|new york|\bny\b|volume|range|supply|demand|r:r|\d(\.\d)?r\b|candle|close|m1|m3|m5|m15|h1|h4|fib|engulf|structure|trend|higher high|lower low|barrier|flip|reclaim|level)/i;
const seen = new Set<string>();
const rows = d.posts
  .filter((p) => p.isReply && p.inReplyToUsername?.toLowerCase() !== user.toLowerCase() && RE.test(p.text) && p.text.replace(/@\S+|https\S+/g, "").trim().length > 40)
  .filter((p) => !seen.has(p.text) && !!seen.add(p.text))
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
const parent = new Map<string, string>();
for (const list of Object.values(d.threads)) for (const t of list) parent.set(String(t.id), t.text);
writeFileSync(resolve(dir, "digest-replies.txt"), rows.map((p) => `${new Date(p.createdAt).toISOString().slice(5, 10)} to @${p.inReplyToUsername}: ${p.text.replace(/\s+/g, " ")}`).join("\n"));
console.log(`technical replies ${rows.length}`);
