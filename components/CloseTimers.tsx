"use client";
import { useEffect, useState } from "react";

const TF_SEC: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export const CLOSE_TFS = Object.keys(TF_SEC);

// Seconds until the forming candle on a timeframe closes. Binance and Hyperliquid candles are aligned to UTC,
// so every timeframe closes on a multiple of its length counted from midnight UTC.
export const closesIn = (tf: string, now = Date.now()) => {
  const p = TF_SEC[tf] ?? 3600;
  return Math.ceil(p - ((now / 1000) % p)) || p;
};
export const clock = (s: number) => {
  const two = (v: number) => String(v).padStart(2, "0");
  const [h, m, x] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return h ? `${h}:${two(m)}:${two(x)}` : `${m}:${two(x)}`;
};

// Time left on each timeframe's candle, ticking every second. The chart's timeframe is highlighted.
export default function CloseTimers({ active, className = "" }: { active?: string; className?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return null; // rendered after mount so the server and the browser agree
  return (
    <span className={`closes ${className}`} title="Time until each timeframe's current candle closes">
      <em>CLOSES IN</em>
      {CLOSE_TFS.map((t) => (
        <span key={t} data-on={t === active}>
          <i>{t.toUpperCase()}</i>
          {clock(closesIn(t, now))}
        </span>
      ))}
    </span>
  );
}
