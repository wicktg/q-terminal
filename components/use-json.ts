"use client";
import { useEffect, useState } from "react";

// Fetches JSON now and every `ms` after, keeping the last good result through a failed refresh.
export function useJson<T>(url: string | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!url) return;
    let dead = false;
    setData(null);
    const go = async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error();
        const j = (await r.json()) as T;
        if (!dead) {
          setData(j);
          setErr(false);
        }
      } catch {
        if (!dead) setErr(true);
      }
    };
    go();
    const id = setInterval(go, ms);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [url, ms]);
  return { data, err };
}
