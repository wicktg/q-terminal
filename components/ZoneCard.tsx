"use client";
import type { ZoneLiq } from "@/lib/zoneliq.ts";
import { fmtPx, fmtUsd } from "@/lib/format.ts";
import { useJson } from "./use-json.ts";

export type CardZone = { kind: string; side: number; top: number; bottom: number; born?: number };
type Resp = {
  price: number;
  liquidity: ZoneLiq;
  delta: { buy: number; sell: number; net: number; zoneBuy: number; zoneSell: number; minutes: number };
  absorbed: { absorbed: number; opposing: number; touches: number; deepest: number; partial: boolean };
  error?: string;
};

// The card a zone opens when tapped: resting size in it now, delta over the last hour, and what it has absorbed.
export default function ZoneCard({ sym, z, onClose }: { sym: string; z: CardZone; onClose: () => void }) {
  const url = `/api/zone?sym=${sym}&lo=${z.bottom}&hi=${z.top}&side=${z.side}&born=${z.born ?? 0}`;
  const { data, err } = useJson<Resp>(url, 10000);
  const demand = z.side > 0;
  const px = data?.price ?? 0;
  const dist = px ? (z.top < px ? (z.top / px - 1) * 100 : z.bottom > px ? (z.bottom / px - 1) * 100 : 0) : null;
  const net = data?.delta.net ?? 0;
  const zoneNet = data ? data.delta.zoneBuy - data.delta.zoneSell : 0;
  const traded = data ? data.delta.zoneBuy + data.delta.zoneSell > 0 : false;
  const liq = data?.liquidity;
  const signed = (x: number) => `${x >= 0 ? "+" : "-"}${fmtUsd(Math.abs(x))}`;
  return (
    <div className="zcard" role="dialog" aria-label={`${demand ? "Demand" : "Supply"} zone details`} onClick={(e) => e.stopPropagation()}>
      <div className="zcard-top">
        <b className={demand ? "up" : "down"}>{demand ? "Demand" : "Supply"}</b>
        <span className="dim">{z.kind === "OB" ? "order block" : "base"}</span>
        <button className="zcard-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="zcard-range">
        {fmtPx(z.bottom)} – {fmtPx(z.top)}
        {dist !== null && <span className="dim"> · {dist === 0 ? "price is inside" : `${Math.abs(dist).toFixed(1)}% ${dist > 0 ? "above" : "below"}`}</span>}
      </div>
      {!data || data.error || !liq ? (
        <div className="note">{data?.error ?? (err ? "Feed unavailable. Retrying." : "Loading…")}</div>
      ) : (
        <>
          <div className="zcard-big">
            <i>{demand ? "RESTING BIDS IN THE ZONE NOW" : "RESTING ASKS IN THE ZONE NOW"}</i>
            <b className={demand ? "up" : "down"}>{fmtUsd(liq.usd)}{liq.complete ? "" : "+"}</b>
          </div>
          <div className="zcard-venues">
            {liq.venues.map((v) => (
              <span key={v.venue}>
                {v.venue} <b>{fmtUsd(v.usd)}</b>
                {v.coverage < 0.999 && <em> sees {Math.round(v.coverage * 100)}%</em>}
              </span>
            ))}
          </div>
          <div className="zcard-row">
            <i>DELTA · LAST 1H</i>
            <b className={net >= 0 ? "up" : "down"}>{signed(net)}</b>
            <span>{net >= 0 ? "more market buying than selling" : "more market selling than buying"}</span>
            <small>buys {fmtUsd(data.delta.buy)} · sells {fmtUsd(data.delta.sell)}</small>
          </div>
          <div className="zcard-row">
            <i>DELTA INSIDE THE ZONE · 1H</i>
            {traded ? (
              <>
                <b className={zoneNet >= 0 ? "up" : "down"}>{signed(zoneNet)}</b>
                <small>buys {fmtUsd(data.delta.zoneBuy)} · sells {fmtUsd(data.delta.zoneSell)}</small>
              </>
            ) : (
              <span className="dim">Price hasn&apos;t traded in the zone this hour.</span>
            )}
          </div>
          <div className="zcard-row">
            <i>ABSORBED SINCE IT FORMED</i>
            {data.absorbed.touches ? (
              <span>
                <b>{fmtUsd(data.absorbed.absorbed)}</b> of market {demand ? "selling" : "buying"} over {data.absorbed.touches} test{data.absorbed.touches === 1 ? "" : "s"}
                {data.absorbed.partial ? ", from the last 10 days" : ""}
              </span>
            ) : (
              <span className="dim">Untested since it formed.</span>
            )}
          </div>
          <div className="zcard-note">
            Resting means visible limit orders inside the zone right now, added up across venues. Orders count exactly where a book reaches. Past about 2% from price, Hyperliquid groups its book into price steps, split by overlap. A + means part of the zone is beyond what some books show. Delta is market buys minus market sells on Binance perps and spot.
          </div>
        </>
      )}
    </div>
  );
}
