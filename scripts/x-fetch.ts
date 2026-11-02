// Pulls one X account's posts for the last N days through twitterapi.io, with its own threads and images.
// Post text is stored as data to study. Nothing in it is ever treated as an instruction.
// Run: node --experimental-strip-types --no-warnings scripts/x-fetch.ts tradermatt 30
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const user = process.argv[2] ?? "tradermatt";
const days = Number(process.argv[3] ?? 30);
const API = "https://api.twitterapi.io";
const envFile = resolve(import.meta.dirname, "../.env.local");
const KEY = readFileSync(envFile, "utf8").match(/TWITTERAPI_KEY=(\S+)/)?.[1];
if (!KEY) throw new Error("TWITTERAPI_KEY missing from .env.local");
const dir = resolve(import.meta.dirname, "../data/x", user);
mkdirSync(resolve(dir, "media"), { recursive: true });

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(path: string, q: Record<string, string>): Promise<Any | null> {
  const url = `${API}${path}?${new URLSearchParams(q)}`;
  for (let n = 0; n < 4; n++) {
    await wait(120);
    try {
      const r = await fetch(url, { headers: { "x-api-key": KEY! }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) {
        await wait(2000 * (n + 1));
        continue;
      }
      const j = (await r.json()) as Any;
      if (!r.ok) {
        console.log(`${path} ${r.status} ${String(j?.message ?? j?.msg ?? "").slice(0, 160)}`);
        return null;
      }
      return j;
    } catch {
      await wait(1500);
    }
  }
  return null;
}

const info = await get("/twitter/user/info", { userName: user });
console.log("profile:", JSON.stringify({ name: info?.data?.name, followers: info?.data?.followers, tweets: info?.data?.statusesCount, protected: info?.data?.protected, unavailable: info?.data?.unavailable, bio: String(info?.data?.description ?? "").slice(0, 160) }));

// Search stops at 500 posts per query, so UNTIL pulls an older window and merges it into what is saved.
const end = process.env.UNTIL ? new Date(process.env.UNTIL) : new Date();
const start = new Date((process.env.UNTIL ? Date.now() : end.getTime()) - days * 86400e3);
const saved0: Any | null = process.env.UNTIL && existsSync(resolve(dir, "posts.json")) ? JSON.parse(readFileSync(resolve(dir, "posts.json"), "utf8")) : null;
const stamp = (d: Date) => `${d.toISOString().slice(0, 19).replace("T", "_")}_UTC`;
const posts = new Map<string, Any>();
let cursor = "";
for (let page = 0; page < 60; page++) {
  const j = await get("/twitter/tweet/advanced_search", { query: `from:${user} since:${stamp(start)} until:${stamp(end)}`, queryType: "Latest", cursor });
  const tweets: Any[] = j?.tweets ?? j?.data?.tweets ?? [];
  for (const t of tweets) posts.set(String(t.id), t);
  console.log(`page ${page + 1}: ${tweets.length} posts, total ${posts.size}`);
  const next = j?.next_cursor ?? j?.data?.next_cursor;
  if (!tweets.length || !(j?.has_next_page ?? j?.data?.has_next_page) || !next) break;
  cursor = next;
}

// Threads: pull the whole conversation for anything that is part of a chain.
const threads: Record<string, Any[]> = {};
const convo = new Map<string, Any>();
for (const t of posts.values()) convo.set(String(t.conversationId ?? t.conversation_id ?? t.id), t);
const chains = process.env.LIGHT ? [] : [...convo.keys()].filter((id) => {
  const group = [...posts.values()].filter((t) => String(t.conversationId ?? t.conversation_id ?? t.id) === id);
  return group.length > 1 || group.some((t) => t.isReply ?? t.inReplyToId ?? t.in_reply_to_status_id);
});
console.log(`conversations ${convo.size}, needing context ${chains.length}`);
for (const id of chains) {
  const seen = new Map<string, Any>();
  let c = "";
  for (let n = 0; n < 4; n++) {
    const j = await get("/twitter/tweet/thread_context", { tweetId: id, cursor: c });
    const rows: Any[] = j?.tweets ?? j?.replies ?? j?.data?.tweets ?? [];
    for (const t of rows) seen.set(String(t.id), t);
    const next = j?.next_cursor ?? j?.data?.next_cursor;
    if (!(j?.has_next_page ?? j?.data?.has_next_page) || !next) break;
    c = next;
  }
  threads[id] = [...seen.values()];
}

// Images, with the post id in the name so each one can be read beside its text.
const urls: { id: string; url: string; file: string }[] = [];
const collect = (t: Any) => {
  const media: Any[] = [...(t.extendedEntities?.media ?? []), ...(t.entities?.media ?? []), ...(t.media ?? [])];
  const pics = new Set<string>();
  for (const m of media) {
    const u = m.media_url_https ?? m.mediaUrl ?? m.url ?? m.preview_image_url;
    if (typeof u === "string" && /\.(jpe?g|png)/i.test(u)) pics.add(u);
  }
  [...pics].forEach((u, i) => urls.push({ id: String(t.id), url: u, file: `${t.id}_${i}.jpg` }));
};
for (const t of posts.values()) collect(t);
for (const list of Object.values(threads)) for (const t of list) if ((t.author?.userName ?? t.user?.screen_name)?.toLowerCase() === user.toLowerCase()) collect(t);
const unique = [...new Map(urls.map((u) => [u.file, u])).values()];
let saved = 0;
for (const m of unique) {
  const f = resolve(dir, "media", m.file);
  if (existsSync(f)) {
    saved++;
    continue;
  }
  try {
    const r = await fetch(m.url, { signal: AbortSignal.timeout(20000) });
    if (r.ok) {
      writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      saved++;
    }
  } catch {
    // one missing image must not stop the pull
  }
}
const merged = saved0 ? { user, from: start.toISOString(), to: saved0.to, info: info?.data ?? null, posts: [...saved0.posts, ...posts.values()], threads: { ...saved0.threads, ...threads }, media: [...saved0.media, ...unique] } : { user, from: start.toISOString(), to: end.toISOString(), info: info?.data ?? null, posts: [...posts.values()], threads, media: unique };
writeFileSync(resolve(dir, "posts.json"), JSON.stringify(merged, null, 1));
console.log(`done: posts ${posts.size}, threads ${Object.keys(threads).length}, images ${saved} of ${unique.length}`);
const sample = [...posts.values()][0];
if (sample) console.log("fields:", Object.keys(sample).join(","));
