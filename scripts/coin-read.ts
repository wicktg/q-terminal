// One-time structure read for a coin, straight from the libs, so it works without the server running.
import { analyze } from "../lib/analyze.ts";
import { labRead } from "../lib/lab-live.ts";

const sym = process.argv[2] ?? "ZEC";
const a = await analyze(sym);
console.log("price", a.price);
for (const f of a.ta.frames) console.log(f.tf, f.trend, f.event ? `${f.event.kind} ${f.event.dir > 0 ? "up" : "down"} at ${f.event.level} ${new Date(f.event.t * 1000).toISOString().slice(5, 16)}` : "-", "|", f.labels.join(" "), "| hi", f.hi, "lo", f.lo);
for (const s of a.ta.signals) console.log(s.lane, `${s.trigger}/${s.bias}`, s.state, s.side, `${s.score}/${s.max}`, "zone", s.zone?.label, s.zone?.bottom, s.zone?.top, "entry", s.entry, "stop", s.stop, "tgt", s.target, "rr", s.rr?.toFixed(2), "|", s.plan, "| on:", s.items.filter((i) => i.on).map((i) => i.label).join(", "));
console.log("zones");
for (const z of a.ta.zones) console.log(" ", z.tf, z.kind, z.side, z.bottom, z.top, `${z.dist.toFixed(1)}%`);
console.log("pools");
for (const p of a.ta.pools) console.log(" ", p.tf, p.side, p.price, p.touches, `${p.dist.toFixed(1)}%`);
const l = await labRead(sym);
console.log("LAB ranges", JSON.stringify(l.ranges));
console.log("LAB signals", JSON.stringify(l.signals));
