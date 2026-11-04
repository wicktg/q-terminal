"use client";
import type { AbsorbEvent, AbsorbRead, AbsorbZone } from "@/lib/absorb.ts";
import { fmtPx, fmtUsd } from "@/lib/format.ts";
import { useJson } from "./use-json.ts";

const RED = "#e5534b";
const GREEN = "#2bbf85";

const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const kindOf = (z: AbsorbZone) => (z.side > 0 ? "Demand" : "Supply");
const shape = (z: AbsorbZone) => (z.kind === "OB" ? "order block" : "base");
// What a zone soaks up: demand takes market selling, supply takes market buying.
const against = (z: AbsorbZone) => (z.side > 0 ? "selling" : "buying");
const withSide = (z: AbsorbZone) => (z.side > 0 ? "buying" : "selling");
const where = (z: AbsorbZone) => (z.status === "TESTING" || z.dist === 0 ? "price is inside" : `${Math.abs(z.dist).toFixed(1)}% ${z.dist > 0 ? "above" : "below"}`);
const STATUS: Record<AbsorbZone["status"], string> = { TESTING: "BEING TESTED", HOLDING: "HELD", FRESH: "UNTESTED", BROKEN: "BROKEN" };

// One plain sentence on what the zone has done.
function story(z: AbsorbZone) {
  const tests = `${z.touches} time${z.touches === 1 ? "" : "s"}`;
  const last = z.reactions[z.reactions.length - 1];
  const early = z.partial ? " It formed before the data starts, so older tests are missing." : "";
  if (z.status === "FRESH") return `Not touched since it formed ${ago(z.bornT)}. Untested zones usually react hardest on the first visit.${early}`;
  if (z.status === "BROKEN") return `Gave way ${ago(z.deadT ?? z.bornT)} after soaking up ${fmtUsd(z.absorbed)} of ${against(z)}. It may now act from the other side.${early}`;
  if (z.status === "TESTING" && z.now) {
    const pressed = z.now.absorbed > z.now.opposing;
    return `Price is in it now. This visit, ${fmtUsd(z.now.absorbed)} of ${against(z)} has hit it against ${fmtUsd(z.now.opposing)} of ${withSide(z)}. ${pressed ? "It is being pressed, so watch for a break." : "It is defending so far."}${early}`;
  }
  if (z.weakening) return `Held ${tests}, but it keeps getting hit or the bounces are shrinking, so it is likely weakening.${early}`;
  return `Held ${tests}.${last !== undefined ? ` The last bounce from it was ${last.toFixed(1)}%.` : ""}${early}`;
}

function ZoneCard({ z, max }: { z: AbsorbZone; max: number }) {
  const net = z.absorbed - z.opposing;
  return (
    <div className="zc" data-s={z.status}>
      <div className="zc-top">
        <b className={z.side > 0 ? "up" : "down"}>{kindOf(z)}</b>
        <span className="dim">{z.tf} {shape(z)}</span>
        <span className="r zc-range">{fmtPx(z.bottom)} – {fmtPx(z.top)}</span>
      </div>
      <div className="zc-where">
        <span className="chip" data-s={z.status}>{STATUS[z.status]}</span>
        <span className="dim">{z.status === "BROKEN" ? ago(z.deadT ?? z.bornT) : where(z)}</span>
      </div>
      {z.touches > 0 && (
        <>
          <div className="zc-bar" title={`${against(z)} soaked up, then ${withSide(z)} inside the zone`}>
            <span style={{ width: `${Math.min(100, (z.absorbed / max) * 100)}%`, background: z.side > 0 ? RED : GREEN }} />
            <span style={{ width: `${Math.min(100, (z.opposing / max) * 100)}%`, background: z.side > 0 ? GREEN : RED, opacity: 0.4 }} />
          </div>
          <div className="zc-flow">
            Soaked up <b>{fmtUsd(z.absorbed)}</b> of {against(z)}
            <span className="dim"> · {fmtUsd(z.opposing)} of {withSide(z)} · net {fmtUsd(Math.abs(net))} {net > 0 ? against(z) : withSide(z)}</span>
          </div>
        </>
      )}
      <div className="zc-n">{story(z)}</div>
      <div className="zc-k">
        {z.touches > 0 ? `Deepest dip into it ${Math.round(Math.min(z.deepest, 1) * 100)}% · ` : ""}built on {fmtUsd(z.built)} of volume
      </div>
    </div>
  );
}

function Group({ title, note, zones, max }: { title: string; note: string; zones: AbsorbZone[]; max: number }) {
  if (!zones.length) return null;
  return (
    <>
      <div className="h">{title}<span>{note}</span></div>
      {zones.map((z) => <ZoneCard key={`${z.tf}${z.kind}${z.top}${z.bottom}`} z={z} max={max} />)}
    </>
  );
}

function ZoneMap({ r }: { r: AbsorbRead }) {
  const zones = r.zones;
  const W = 320;
  const H = 300;
  const prices = [r.price, ...zones.flatMap((z) => [z.top, z.bottom])];
  const span = Math.max(...prices) - Math.min(...prices) || r.price * 0.02;
  const hi = Math.max(...prices) + span * 0.04;
  const lo = Math.min(...prices) - span * 0.04;
  const y = (p: number) => 10 + ((hi - p) / (hi - lo)) * (H - 20);
  // Live zones set the scale. A broken zone can have soaked up far more, and would flatten every other bar.
  const live = zones.filter((z) => z.status !== "BROKEN");
  const max = Math.max(1, ...(live.length ? live : zones).map((z) => z.absorbed));
  const ticks = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ab-map" role="img" aria-label="Zones by price with the flow each soaked up">
      {ticks.map((p) => (
        <g key={p}>
          <line x1={58} x2={W} y1={y(p)} y2={y(p)} stroke="#141414" />
          <text x={2} y={y(p) + 3} fontSize="9" fill="#555">{fmtPx(p)}</text>
        </g>
      ))}
      {zones.map((z, i) => {
        const top = y(z.top);
        const h = Math.max(2, y(z.bottom) - top);
        const color = z.side > 0 ? GREEN : RED;
        const bar = Math.min(1, z.absorbed / max) * 90; // leaves room for the label inside the 320-wide map
        return (
          <g key={i} opacity={z.status === "BROKEN" ? 0.4 : 1}>
            <title>{`${kindOf(z)} ${fmtPx(z.bottom)}–${fmtPx(z.top)}: soaked up ${fmtUsd(z.absorbed)}, ${STATUS[z.status].toLowerCase()}`}</title>
            <rect x={60} y={top} width={110} height={h} fill={color} fillOpacity={z.kind === "OB" ? 0.28 : 0.14} stroke={color} strokeOpacity={0.8} strokeDasharray={z.status === "BROKEN" ? "3 3" : undefined} />
            {bar > 0.5 && <rect x={176} y={top} width={bar} height={h} fill="#f5a623" fillOpacity={0.75} />}
            {bar > 0.5 && <text x={180 + bar} y={top + Math.min(h, 12) - 2} fontSize="9" fill="#d9d9d9">{fmtUsd(z.absorbed)}</text>}
          </g>
        );
      })}
      <line x1={58} x2={W} y1={y(r.price)} y2={y(r.price)} stroke="#e8e8e8" strokeDasharray="4 3" />
      <rect x={0} y={y(r.price) - 7} width={56} height={14} fill="#e8e8e8" />
      <text x={3} y={y(r.price) + 3} fontSize="9" fontWeight="600" fill="#000">{fmtPx(r.price)}</text>
    </svg>
  );
}

function EventRow({ e }: { e: AbsorbEvent }) {
  const bullish = e.absorbed === "sellers";
  return (
    <div className="ev">
      <span className="dim">{ago(e.t)}</span>
      <span>
        <b className={bullish ? "up" : "down"}>{bullish ? "Buyers held" : "Sellers held"}</b> {fmtPx(e.lo)}–{fmtPx(e.hi)} against <b>{fmtUsd(Math.abs(e.delta))}</b> of market {bullish ? "selling" : "buying"}
      </span>
      <span className="ev-sub">
        Price only moved {e.move >= 0 ? "+" : ""}{e.move.toFixed(2)}%. {e.held ? "The level has held since." : "The level has since broken."}
      </span>
    </div>
  );
}

export default function AbsorbTab({ sym }: { sym: string }) {
  const { data, err } = useJson<AbsorbRead & { error?: string }>(`/api/absorb?sym=${sym}`, 30000);
  if (!data) return <div className="note">{err ? "Absorption feed unavailable for this coin. It needs Binance taker data. Retrying." : "Loading…"}</div>;
  if (data.error || !data.zones) return <div className="note">{data.error ?? "No data."}</div>;
  const zones = data.zones;
  const liveZones = zones.filter((z) => z.status !== "BROKEN");
  const max = Math.max(1, ...(liveZones.length ? liveZones : zones).map((z) => z.absorbed + z.opposing));
  const inside = zones.filter((z) => z.status === "TESTING" || (z.status !== "BROKEN" && z.dist === 0));
  const above = zones.filter((z) => z.status !== "BROKEN" && !inside.includes(z) && z.dist > 0).sort((a, b) => a.dist - b.dist);
  const below = zones.filter((z) => z.status !== "BROKEN" && !inside.includes(z) && z.dist < 0).sort((a, b) => b.dist - a.dist);
  const broken = zones.filter((z) => z.status === "BROKEN");
  const { sellers, buyers, nSellers, nBuyers } = data.day;
  const read =
    !sellers && !buyers
      ? "No heavy flow stalled in the last 24 hours, so neither side has shown its hand."
      : sellers > buyers * 1.5
        ? "Market selling kept getting soaked up by resting buyers. That leans bullish: buyers are defending."
        : buyers > sellers * 1.5
          ? "Market buying kept getting soaked up by resting sellers. That leans bearish: sellers are defending."
          : "Both sides soaked up similar size, so there is no clear edge.";
  return (
    <div className="ab">
      <div className="ab-sum">
        <div><i>BUYERS DEFENDED · 24H</i><b className="up">{fmtUsd(sellers)}</b><span className="dim">of selling soaked up, {nSellers} bar{nSellers === 1 ? "" : "s"}</span></div>
        <div><i>SELLERS DEFENDED · 24H</i><b className="down">{fmtUsd(buyers)}</b><span className="dim">of buying soaked up, {nBuyers} bar{nBuyers === 1 ? "" : "s"}</span></div>
        <div className="ab-read"><i>WHAT IT MEANS</i><span>{read}</span></div>
      </div>
      <div className="grid2 ab-grid">
        <div>
          <Group title="PRICE IS INSIDE" note="being tested now" zones={inside} max={max} />
          <Group title="ABOVE PRICE" note="supply, where selling may appear" zones={above} max={max} />
          <Group title="BELOW PRICE" note="demand, where buying may appear" zones={below} max={max} />
          <Group title="RECENTLY BROKEN" note="last 3 days" zones={broken} max={max} />
          {!zones.length && <div className="note">No supply or demand zones within 15% of price.</div>}
        </div>
        <div>
          <div className="h">ZONE MAP<span>green demand, red supply, amber bar = flow soaked up</span></div>
          <ZoneMap r={data} />
          <div className="h">ABSORPTION EVENTS<span>15M bars, last 48H</span></div>
          {data.events.length ? data.events.map((e) => <EventRow key={e.t} e={e} />) : <div className="note">No heavy one-sided flow stalled in the last 48 hours.</div>}
        </div>
      </div>
      <div className="note">
        Soaked up means market orders that traded inside a zone against it: sells into demand, buys into supply. Each 15-minute bar&apos;s volume is split by how much of its range sat in the zone. An event is a bar in the heaviest tenth of one-sided flow where price still failed to move. This shows flow that traded, not orders still resting in the book. Data: Binance perps{data.spot ? " and spot" : ""}.
      </div>
    </div>
  );
}
