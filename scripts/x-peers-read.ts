// Best technical posts from the peer accounts, to set beside the main account's method.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type T = { text: string; likeCount?: number; isReply?: boolean; retweeted_tweet?: unknown; id: string; createdAt: string };
const RE = /\b(range|deviat\w*|sfp|swing fail\w*|reclaim\w*|retest\w*|breakout|fakeout|sweep\w*|supply|demand|continuation|reversal|m1|m5|m15|ltf|htf|session|new york|london|asia\w*|invalidation|stop loss|r:r|\d(\.\d)?r|structure|bos|choch|flip\w*|absorption|market profile|value area|poc|vah|val|vwap|cvd|delta|naked|auction|balance|imbalance|acceptance|rejection)\b/i;
const out: string[] = [];
for (const u of ["Trader_XO", "TraderMagus", "Stnxbt", "semtrades", "CastilloTrading"]) {
  const f = resolve(import.meta.dirname, "../data/x", u, "posts.json");
  if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, "utf8")) as { posts: T[] };
  const p = d.posts.filter((t) => !t.retweeted_tweet && !t.text.startsWith("RT @") && t.text.replace(/https\S+|@\S+/g, "").trim().length > 90 && RE.test(t.text)).sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0));
  out.push(`\n===== ${u}: ${d.posts.length} posts, usable ${p.length}`);
  for (const t of p.slice(0, 16)) out.push(`[${t.likeCount}] ${t.createdAt.slice(4, 10)} ${t.id}: ${t.text.replace(/\s+/g, " ").slice(0, 560)}`);
}
writeFileSync(resolve(import.meta.dirname, "../data/x/peers.txt"), out.join("\n"));
console.log(out.join("\n"));
