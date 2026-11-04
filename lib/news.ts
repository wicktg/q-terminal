// News pipeline: fetch RSS feeds, drop spam, merge duplicate stories, rank by market impact.
// Classification is keyword rules, not an LLM, so it is instant, free and auditable.
// Feed text is untrusted: it is only ever rendered as plain text.
import { cached } from "./data.ts";
import type { NewsBias, NewsCategory, NewsItem, NewsResp } from "./types.ts";

const gnews = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// Google News is the fastest free source (5-15 min behind the wire) and carries Reuters, Bloomberg etc.
const FEEDS: { url: string; ttl: number }[] = [
  { url: gnews("bitcoin OR ethereum OR crypto market when:1d"), ttl: 30e3 },
  { url: gnews("crypto hack OR exploit OR stolen when:1d"), ttl: 30e3 },
  { url: gnews("SEC OR CFTC crypto regulation when:1d"), ttl: 45e3 },
  { url: gnews("bitcoin ETF inflows OR outflows when:1d"), ttl: 45e3 },
  { url: gnews("iran OR hormuz OR israel strike OR ceasefire when:1d"), ttl: 30e3 },
  { url: gnews("russia ukraine OR taiwan china military when:1d"), ttl: 60e3 },
  { url: gnews("fed OR fomc OR warsh rate decision when:1d"), ttl: 30e3 },
  { url: gnews("CPI OR inflation OR jobs report OR treasury yields when:1d"), ttl: 45e3 },
  { url: gnews("oil price brent OR opec when:1d"), ttl: 45e3 },
  { url: gnews("tariffs OR stocks selloff OR dollar index when:1d"), ttl: 60e3 },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", ttl: 30e3 },
  { url: "https://cointelegraph.com/rss", ttl: 30e3 },
  { url: "https://www.theblock.co/rss.xml", ttl: 30e3 },
  { url: "https://decrypt.co/feed", ttl: 45e3 },
  { url: "https://blockworks.co/feed", ttl: 45e3 },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", ttl: 30e3 },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", ttl: 30e3 },
  { url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362", ttl: 45e3 },
];

type Raw = { title: string; link: string; t: number; source: string };

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function clean(s: string) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRss(xml: string, fallbackSource: string): Raw[] {
  const out: Raw[] = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const it = m[0];
    const pick = (tag: string) => it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
    let title = clean(pick("title"));
    const link = clean(pick("link"));
    const t = Date.parse(clean(pick("pubDate"))) || Date.parse(clean(pick("dc:date")));
    const src = clean(pick("source"));
    if (src) title = title.replace(new RegExp(`\\s+[-–—]\\s+${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
    if (title && /^https?:\/\//.test(link) && t) out.push({ title, link, t, source: src || fallbackSource });
  }
  return out;
}

async function fetchFeed(f: { url: string; ttl: number }): Promise<Raw[]> {
  return cached(`news:${f.url}`, f.ttl, async () => {
    const r = await fetch(f.url, { signal: AbortSignal.timeout(8000), cache: "no-store", headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(String(r.status));
    return parseRss(await r.text(), new URL(f.url).hostname.replace(/^www\.|^feeds\.|^search\./, ""));
  });
}

const SPAM =
  /price prediction|price forecast|prediction market|must watch|\b\d+ stocks\b|\b\d+x\b|presale|pre-sale|best crypto|top \d+ (crypto|coins|altcoins)|coins? to (buy|watch)|could (reach|hit) \$|grok (ai )?predicts?|chatgpt predicts?|sponsored|press release|how to buy|horoscope|gta 6|\bsports?\b|\bnfl\b|\bnba\b|recipe|celebrity/i;

// HACK words are common outside crypto ("breach of the ceasefire"), so that rule needs a crypto target too.
const HACK_CTX = /\b(bitcoin|btc|ethereum|eth|crypto\w*|altcoins?|stablecoins?|tokens?|blockchain|binance|coinbase|bybit|okx|kraken|hyperliquid|solana|exchange|defi|protocol|bridge|wallets?)\b/i;

const RULES: { cat: NewsCategory; re: RegExp; base: number; why: string; need?: RegExp }[] = [
  { cat: "HACK", re: /\b(hack(s|ed|ers?)?|exploit(s|ed)?|drain(s|ed)?|stolen|breach(ed)?|attackers?|heist|insolven\w*|bankrupt\w*|(exchange|binance|bybit|okx|coinbase|protocol|bridge) incident)\b/i, base: 45, why: "Direct hit to crypto trust and liquidity", need: HACK_CTX },
  { cat: "WAR", re: /\b(iran|iranian|tehran|israel|hormuz|gaza|hezbollah|houthi|missile|airstrikes?|strikes?|ceasefire|peace (deal|talks)|invasion|military|russia|ukraine|taiwan|nuclear|troops|war)\b/i, base: 34, why: "Geopolitics moves oil, inflation and risk appetite" },
  { cat: "FED", re: /\b(fed|fomc|warsh|powell|rate (hike|cut|decision)|interest rates?|federal reserve|dot plot)\b/i, base: 34, why: "Rates set the price of risk" },
  { cat: "MACRO", re: /\b(cpi|inflation|pce|payrolls?|jobs report|unemployment|gdp|treasury yields?|bond yields?|dollar index|dxy|recession|tariffs?)\b/i, base: 28, why: "Shifts Fed expectations and liquidity" },
  { cat: "OIL", re: /\b(oil|brent|wti|crude|opec)\b/i, base: 22, why: "Oil feeds inflation, which feeds rate fears" },
  { cat: "REG", re: /\b(sec|cftc|lawsuit|regulat\w+|clarity act|senate|congress|treasury dept|sanction\w*|ban(s|ned)?)\b/i, base: 26, why: "Changes who can hold or trade crypto" },
  { cat: "FLOWS", re: /\b(etfs?|inflows?|outflows?|blackrock|ibit|microstrategy|strategy buys|whales?|treasury compan\w+)\b/i, base: 24, why: "Direct spot supply and demand" },
  { cat: "MARKET", re: /\b(liquidat\w+|short squeeze|selloff|sell-off|crash\w*|plunges?|surges?|s&p 500|nasdaq|wall street|stocks?)\b/i, base: 16, why: "Risk sentiment read-through" },
  { cat: "CRYPTO", re: /\b(bitcoin|btc|ethereum|ether|eth|crypto\w*|solana|stablecoins?|binance|coinbase|defi|hyperliquid|altcoins?|token)\b/i, base: 14, why: "Crypto-specific" },
];

const SEVERE: [RegExp, number][] = [
  [/\b(largest|biggest|record|historic|unprecedented)\b/i, 14],
  [/\$\s?\d+(\.\d+)?\s?(billion|bn|b)\b/i, 12],
  [/\b(emergency|halts?|suspend\w*|frozen|freezes?|withdrawals?)\b/i, 10],
  [/\b(breaking|just in|surprise|shock)\b/i, 8],
  [/\b(peace deal|ceasefire|invasion|declares?|attack(s|ed)?)\b/i, 10],
  [/\b(iran|iranian|tehran|hormuz)\b/i, 12], // active conflict around the main oil chokepoint
  [/\b(hormuz|uranium|nuclear (deal|talks|sites?|program\w*|weapons?)|major strike|major \w+ strike)\b/i, 12],
  [/\b(plunges?|crash\w*|soars?|surges?|tumbles?|liquidat\w+)\b/i, 6],
];

const CRYPTO_CTX = /\b(bitcoin|btc|ethereum|eth|crypto\w*|altcoins?|stablecoins?|token|blockchain|binance|coinbase|hyperliquid|solana)\b/i;

const COINS: [RegExp, string][] = [
  [/\b(bitcoin|btc)\b/i, "BTC"],
  [/\b(ethereum|ether|eth)\b/i, "ETH"],
  [/\b(solana|sol)\b/i, "SOL"],
  [/\b(hyperliquid|hype)\b/i, "HYPE"],
  [/\b(zcash|zec)\b/i, "ZEC"],
  [/\bnear (protocol|token)\b|\$NEAR\b/i, "NEAR"],
  [/\b(ethena|\$ena)\b/i, "ENA"],
  [/\b(lighter|\$lit)\b/i, "LIT"],
  [/\b(binance|bnb)\b/i, "BNB"],
  [/\b(xrp|ripple)\b/i, "XRP"],
  [/\b(dogecoin|doge)\b/i, "DOGE"],
  [/\bsui\b/i, "SUI"],
  [/\b(chainlink|link token)\b/i, "LINK"],
  [/\b(avalanche|avax)\b/i, "AVAX"],
  [/\bpepe\b/i, "1000PEPE"],
  [/\b(aerodrome|\$aero)\b/i, "AERO"],
  [/\bvenice (ai|token)\b|\$vvv\b/i, "VVV"],
  [/\b(uniswap|\$uni)\b/i, "UNI"],
  [/\b(layerzero|layer zero|zro)\b/i, "ZRO"],
];

// Crude headline polarity. Negation is checked first because "no ceasefire" reads bullish otherwise.
function biasOf(title: string, cat: NewsCategory): NewsBias {
  const t = title.toLowerCase();
  const failed = /\b(no|not|rejects?|collaps\w+|fails?|breaks?|stall\w*|ends?|scrap\w*|violat\w+|without)\b.{0,30}\b(ceasefire|peace|deal|talks)\b|\b(ceasefire|peace|deal|talks)\b.{0,30}\b(collaps\w+|fails?|stall\w*|broken|violat\w+)\b/;
  if (cat === "HACK") return "RISK-OFF";
  if (cat === "WAR" || cat === "OIL") {
    if (failed.test(t)) return "RISK-OFF";
    if (/\b(ceasefire|peace|truce|end(s|ing)? (the )?war|de-?escalat\w+|war will end|reopen\w*)\b/.test(t)) return "RISK-ON";
    if (/\b(sale|sells?|contract|greenlights?)\b/.test(t)) return "UNCLEAR"; // arms deals are not escalation
    if (/\b(strikes?|attack\w*|missile|escalat\w+|invasion|retaliat\w+|bomb\w*|killed)\b/.test(t)) return "RISK-OFF";
    if (cat === "OIL") return /\b(falls?|drops?|slides?|lowers?|tumbles?|plunges?)\b/.test(t) ? "RISK-ON" : /\b(jumps?|surges?|soars?|spikes?|rises?)\b/.test(t) ? "RISK-OFF" : "UNCLEAR";
  }
  if (cat === "FED" || cat === "MACRO") {
    if (/\b(hawk\w*|hikes?|higher for longer|hot(ter)?|accelerat\w+|rising inflation)\b/.test(t)) return "RISK-OFF";
    if (/\b(dov\w+|cuts?|cooling|cools|slows|easing|pause)\b/.test(t)) return "RISK-ON";
  }
  if (cat === "FLOWS") {
    if (/\boutflows?\b/.test(t)) return "RISK-OFF";
    if (/\b(inflows?|buys|bought|adds?)\b/.test(t)) return "RISK-ON";
  }
  if (/\b(plunges?|crash\w*|tumbles?|selloff|sell-off|slides?|sinks?)\b/.test(t)) return "RISK-OFF";
  if (/\b(surges?|soars?|rall(y|ies)|jumps?|record high)\b/.test(t)) return "RISK-ON";
  return "UNCLEAR";
}

const STOP = new Set("the a an of to in on for and or as at by with from is are was be after amid over into its it that this says say said new how why what will has have than but not you your s".split(" "));
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9$ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

function similar(a: Set<string>, b: Set<string>) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size || 1, b.size || 1);
}

const ruleFor = (title: string) => RULES.find((x) => x.re.test(title) && (!x.need || x.need.test(title)));
const VENUE = /\b(binance|coinbase|bybit|okx|kraken|hyperliquid|bitget|kucoin|gate\.io|upbit)\b/gi;
// Headlines on one hack share few words, so anything naming the same venue counts as one event.
// The last venue wins: "Coinbase leads selloff after Binance hack" is about Binance.
const hackEvent = (title: string) => (ruleFor(title)?.cat === "HACK" ? [...title.matchAll(VENUE)].at(-1)?.[0].toLowerCase() : undefined);

export function rank(raw: Raw[], now = Date.now()): NewsItem[] {
  const fresh = raw.filter((r) => now - r.t < 24 * 3600e3 && r.t <= now + 60e3 && !SPAM.test(r.title));
  fresh.sort((a, b) => a.t - b.t); // oldest first, so a story keeps its first-seen time
  const groups: { head: Raw; last: Raw; tk: Set<string>; event?: string; sources: Set<string>; latest: number }[] = [];
  for (const r of fresh) {
    const tk = tokens(r.title);
    const event = hackEvent(r.title);
    const g = groups.find((x) => similar(x.tk, tk) >= 0.6 || (event && x.event === event));
    if (g) {
      g.sources.add(r.source);
      g.last = r; // input is oldest first, so this is the newest headline so far
      g.latest = Math.max(g.latest, r.t);
    } else groups.push({ head: r, last: r, tk, event, sources: new Set([r.source]), latest: r.t });
  }
  const out: NewsItem[] = [];
  for (const g of groups) {
    const rule = ruleFor(g.head.title);
    if (!rule) continue; // not market-relevant
    const hasCrypto = CRYPTO_CTX.test(g.head.title);
    let score = rule.base;
    for (const [re, w] of SEVERE) if (re.test(g.head.title)) score += w;
    score += Math.min(g.sources.size - 1, 6) * 5; // many outlets on one story is the best signal we have
    if (hasCrypto && rule.cat !== "CRYPTO") score += 6;
    const ageH = (now - g.latest) / 3600e3;
    const hot = score * Math.exp(-ageH / 8);
    const coins = COINS.filter(([re]) => re.test(g.head.title)).map(([, c]) => c);
    out.push({
      id: `${g.head.t}-${g.head.title.slice(0, 24)}`,
      title: g.last.title,
      link: g.last.link,
      source: g.last.source,
      sources: g.sources.size,
      t: g.head.t,
      updated: g.latest,
      category: rule.cat,
      impact: score >= 58 ? "HIGH" : score >= 38 ? "MED" : "LOW",
      score,
      hot,
      bias: biasOf(g.last.title, rule.cat),
      why: rule.why,
      coins,
    });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export const getNews = (): Promise<NewsResp> =>
  cached("news:all", 15e3, async () => {
    const res = await Promise.allSettled(FEEDS.map(fetchFeed));
    const raw = res.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const items = rank(raw).slice(0, 150);
    return { asOf: Date.now(), feedsOk: res.filter((r) => r.status === "fulfilled").length, feedsTotal: FEEDS.length, items };
  });
