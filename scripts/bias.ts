import { analyze } from "../lib/analyze.ts";
const syms = ["BTC", "ETH", "SOL", "HYPE", "ZEC", "NEAR", "ENA", "LIT", "XRP", "DOGE", "BNB", "SUI", "LINK", "AVAX"];
const t0 = Date.now();
for (const s of syms) {
  const t = Date.now();
  const a = await analyze(s);
  const line = a.ta.signals.map((x) => `${x.lane} ${x.state.padEnd(6)} ${(x.side ?? "-").padEnd(5)} ${x.score}/${x.max}`).join(" | ");
  console.log(s.padEnd(5), `${Date.now() - t}ms`.padStart(7), a.ta.frames.map((f) => `${f.tf} ${f.trend}`).join(" "), "|", line);
}
console.log("total", Date.now() - t0, "ms");
