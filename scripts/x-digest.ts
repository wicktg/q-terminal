// Turns a pulled account into a readable digest: his own posts and threads, newest first, with images and engagement.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const user = process.argv[2] ?? "tradermatt";
const dir = resolve(import.meta.dirname, "../data/x", user);
type T = { id: string; text: string; createdAt: string; likeCount?: number; viewCount?: number; retweetCount?: number; isReply?: boolean; inReplyToUsername?: string; conversationId?: string; url?: string; author?: { userName?: string }; quoted_tweet?: { text?: string; author?: { userName?: string } } | null; retweeted_tweet?: unknown };
const d = JSON.parse(readFileSync(resolve(dir, "posts.json"), "utf8")) as { posts: T[]; threads: Record<string, T[]>; media: { id: string; file: string }[]; info: Record<string, unknown>; from: string; to: string };
const ms = (t: T) => Date.parse(t.createdAt);
const posts = [...d.posts].sort((a, b) => ms(b) - ms(a));
console.log(`pulled ${posts.length}, from ${new Date(ms(posts.at(-1)!)).toISOString().slice(0, 16)} to ${new Date(ms(posts[0])).toISOString().slice(0, 16)}, asked from ${d.from.slice(0, 16)}`);
const byDay = new Map<string, number>();
for (const p of posts) byDay.set(new Date(ms(p)).toISOString().slice(0, 10), (byDay.get(new Date(ms(p)).toISOString().slice(0, 10)) ?? 0) + 1);
console.log([...byDay.entries()].sort().map(([k, v]) => `${k.slice(5)}:${v}`).join(" "));
const media = new Map<string, string[]>();
for (const m of d.media) media.set(m.id, [...(media.get(m.id) ?? []), m.file]);
const own = posts.filter((p) => !p.retweeted_tweet && !/^RT @/.test(p.text));
const replies = own.filter((p) => p.isReply);
console.log(`own ${own.length}, of which replies ${replies.length}, top-level ${own.length - replies.length}, with images ${own.filter((p) => media.has(String(p.id))).length}`);
const RE = /\b(ltf|htf|setup|setups|pattern|structure|bos|choch|mss|sfp|swing fail|sweep|swept|liquidity|fvg|imbalance|order ?block|\bob\b|supply|demand|range|deviation|deviate|\bdev\b|reclaim|retest|flip|s\/r|support|resistance|trend ?line|wyckoff|accumulation|distribution|spring|utad|upthrust|divergence|\bdiv\b|vwap|fib|fibonacci|ote|golden pocket|\bgp\b|ema|ma\b|volume|cvd|delta|absorption|stop ?loss|invalidation|\br\b|risk|entry|entries|target|tp|confluence|timeframe|4h|1h|15m|5m|1d|daily|weekly|monthly|hourly)\b/i;
const line = (p: T) => {
  const date = new Date(ms(p)).toISOString().slice(5, 16).replace("T", " ");
  const q = p.quoted_tweet?.text ? `\n   [quoting @${p.quoted_tweet.author?.userName}: ${p.quoted_tweet.text.replace(/\s+/g, " ").slice(0, 200)}]` : "";
  const img = media.get(String(p.id));
  return `#${p.id} ${date} likes ${p.likeCount ?? 0} views ${p.viewCount ?? 0}${p.isReply ? ` reply to @${p.inReplyToUsername}` : ""}${img ? ` IMAGES ${img.join(",")}` : ""}\n   ${p.text.replace(/\s+/g, " ")}${q}`;
};
const top = own.filter((p) => !p.isReply);
const keyed = own.filter((p) => RE.test(p.text) || media.has(String(p.id)));
writeFileSync(resolve(dir, "digest-all.txt"), own.map(line).join("\n\n"));
writeFileSync(resolve(dir, "digest-key.txt"), keyed.map(line).join("\n\n"));
console.log(`digest: all ${own.length}, relevant ${keyed.length}, top-level ${top.length}`);
// His own posts inside threads that were not in the search results, plus the questions he was answering.
const known = new Set(own.map((p) => String(p.id)));
const extra: string[] = [];
for (const [id, list] of Object.entries(d.threads)) {
  const rows = [...list].sort((a, b) => ms(a) - ms(b));
  const mine = rows.filter((t) => t.author?.userName?.toLowerCase() === user.toLowerCase());
  if (!mine.length) continue;
  const head = rows[0];
  const missing = mine.filter((t) => !known.has(String(t.id)));
  extra.push(`THREAD ${id} (${rows.length} posts, ${mine.length} his, ${missing.length} new)\n   OPENED BY @${head.author?.userName}: ${head.text.replace(/\s+/g, " ").slice(0, 280)}${missing.map((t) => `\n   HIS: ${t.text.replace(/\s+/g, " ")}`).join("")}`);
}
writeFileSync(resolve(dir, "digest-threads.txt"), extra.join("\n\n"));
console.log(`threads with his posts ${extra.length}`);
const liked = [...own].sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0)).slice(0, 8);
for (const p of liked) console.log(`${p.likeCount} likes: ${p.text.replace(/\s+/g, " ").slice(0, 130)}`);
