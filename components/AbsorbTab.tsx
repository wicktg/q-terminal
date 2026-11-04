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
const name = (z: AbsorbZone) => `${z.tf} ${z.kind === "OB" ? "order block" : z.side > 0 ? "demand" : "supply"}`;
// What the zone soaks up: demand takes market sells, supply takes market buys.
const against = (z: AbsorbZone) => (z.side > 0 ? "selling" : "buying");
const withSide = (z: AbsorbZone) => (z.side > 0 ? "buying" : "selling");

function note(z: AbsorbZone) {
  const tests = `${z.touches} test${z.touches === 1 ? "" : "s"}`;
  const last = z.reactions[z.reactions.length - 1];
  const tail = z.partial ? " It formed before the data window, so earlier tests are missing." : "";
  if (z.status === "FRESH") return `Untested since it formed ${ago(z.bornT)}.${tail}`;
  if (z.status === "BROKEN") return `Broke ${ago(z.deadT ?? z.bornT)} after absorbing ${fmtUsd(z.absorbed)} of ${against(z)} across ${tests}.${tail}`;
  if (z.status === "TESTING" && z.now) {
    const winning = z.now.absorbed > z.now.opposing ? `more ${against(z)} than ${withSide(z)}, so it is being pressed` : `more ${withSide(z)} than ${against(z)}, so it is defending`;
    return `Price is inside now. This visit: ${fmtUsd(z.now.absorbed)} of ${against(z)} absorbed against ${fmtUsd(z.now.opposing)} of ${withSide(z)}, ${winning}.${tail}`;
  }
  if (z.weakening) return `Held ${tests}, but it keeps getting hit or the bounces are shrinking. Likely weakening.${tail}`;
  return `Held ${tests}.${last !== undefined ? ` Last bounce ${last.toFixed(1)}%.` : ""}${tail}`;
}

function ZoneCard({ z, max }: { z: AbsorbZone; max: number }) {
  const net = z.absorbed - z.opposing;
  const took = z.built ? z.absorbed / z.built : 0;
  return (
    <div className="zc">
      <div className="zc-top">
        <span className={z.side > 0 ? "up" : "down"}>{name(z)}</span>
        <span className="chip" data-s={z.status}>{z.status}</span>
        <span className="r">{fmtPx(z.bottom)} – {fmtPx(z.top)}</span>
        <span className="dim">{z.status === "BROKEN" ? "" : z.dist === 0 ? "here" : `${z.dist > 0 ? "+" : ""}${z.dist.toFixed(1)}%`}</span>
      </div>
      <div className="zc-bar" title={`${against(z)} absorbed vs ${withSide(z)} inside the zone`}>
        <span style={{ width: `${Math.min(100, (z.absorbed / max) * 100)}%`, background: z.side > 0 ? RED : GREEN }} />
        <span style={{ width: `${Math.min(100, (z.opposing / max) * 100)}%`, background: z.side > 0 ? GREEN : RED, opacity: 0.45 }} />
      </div>
      {z.touches ? (
        <>
          <div className="zc-k">
            Absorbed <b>{fmtUsd(z.absorbed)}</b> of {against(z)} · {withSide(z)} {fmtUsd(z.opposing)} · net <b className={net > 0 ? (z.side > 0 ? "down" : "up") : ""}>{fmtUsd(Math.abs(net))}</b> {net > 0 ? against(z) : withSide(z)}
          </div>
          <div className="zc-k">
            Tests {z.touches} · deepest {Math.round(z.deepest * 100)}% · built on {fmtUsd(z.built)}{took >= 0.05 ? ` · absorbed ${took.toFixed(2)}× that` : ""}
          </div>
        </>
      ) : (
        <div className="zc-k">No tests yet · built on {fmtUsd(z.built)}</div>
      )}
      <div className="zc-n">{note(z)}</div>
    </div>
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
    <svg viewBox={`0 0 ${W} ${H}`} className="ab-map" role="img" aria-label="Zones by price with the flow each absorbed">
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
          <g key={i} opacity={z.status === "BROKEN" ? 0.45 : 1}>
            <title>{`${name(z)} ${fmtPx(z.bottom)}–${fmtPx(z.top)}: absorbed ${fmtUsd(z.absorbed)}, ${z.status.toLowerCase()}`}</title>
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
      <span className={bullish ? "up" : "down"}>{bullish ? "Sellers absorbed" : "Buyers absorbed"}</span>
      <span className="r">{fmtUsd(Math.abs(e.delta))}</span>
      <span className="ev-sub">
        {fmtPx(e.lo)}–{fmtPx(e.hi)} · price {e.move >= 0 ? "+" : ""}{e.move.toFixed(2)}% · {e.held ? <span>level held</span> : <span className="faint">level since broken</span>}
      </span>
    </div>
  );
}

export default function AbsorbTab({ sym }: { sym: string }) {
  const { data, err } = useJson<AbsorbRead & { error?: string }>(`/api/absorb?sym=${sym}`, 30000);
  if (!data) return <div className="note">{err ? "Absorption feed unavailable for this coin. It needs Binance taker data. Retrying." : "Loading…"}</div>;
  if (data.error || !data.zones) return <div className="note">{data.error ?? "No data."}</div>;
  const live = data.zones.filter((z) => z.status !== "BROKEN");
  const max = Math.max(1, ...(live.length ? live : data.zones).map((z) => z.absorbed + z.opposing));
  const { sellers, buyers, nSellers, nBuyers } = data.day;
  const read =
    !sellers && !buyers
      ? "No heavy flow stalled in the last 24 hours."
      : sellers > buyers * 1.5
        ? "Passive buyers soaked up more selling than sellers soaked up buying. Leans bullish."
        : buyers > sellers * 1.5
          ? "Passive sellers soaked up more buying than buyers soaked up selling. Leans bearish."
          : "Both sides absorbed similar size. No clear edge.";
  return (
    <div className="ab">
      <div className="ab-sum">
        <div><i>SELLERS ABSORBED · 24H</i><b className="up">{fmtUsd(sellers)}</b><span className="dim">{nSellers} bar{nSellers === 1 ? "" : "s"} · bids held</span></div>
        <div><i>BUYERS ABSORBED · 24H</i><b className="down">{fmtUsd(buyers)}</b><span className="dim">{nBuyers} bar{nBuyers === 1 ? "" : "s"} · offers held</span></div>
        <div><i>READ</i><span>{read}</span></div>
      </div>
      <div className="grid2 ab-grid">
        <div>
          <div className="h">ZONE MAP<span>bar = flow absorbed</span></div>
          <ZoneMap r={data} />
          <div className="h">ABSORPTION EVENTS<span>15M, last 48H</span></div>
          {data.events.length ? data.events.map((e) => <EventRow key={e.t} e={e} />) : <div className="note">No heavy one-sided flow stalled in the last 48 hours.</div>}
        </div>
        <div>
          <div className="h">ZONES<span>1H and 4H, nearest first</span></div>
          {data.zones.length ? data.zones.map((z) => <ZoneCard key={`${z.tf}${z.kind}${z.top}${z.bottom}`} z={z} max={max} />) : <div className="note">No supply or demand zones within 15% of price.</div>}
        </div>
      </div>
      <div className="note">
        Absorbed means market orders that traded inside a zone against it: sells into demand, buys into supply. Each 15-minute bar&apos;s volume is split by how much of its range sat in the zone. Built is the volume of the candles that formed the zone, for scale. An absorption event is a bar in the heaviest tenth of one-sided flow where price still failed to move that way. None of this shows what is still resting in the book. Data: Binance perps{data.spot ? " and spot" : ""} taker flow.
      </div>
    </div>
  );
}
