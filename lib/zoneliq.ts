// Resting size inside a price range, summed across venues. Pure, no I/O.
// Exact orders count when they sit in the range. A grouped level counts in proportion to how much of its
// bucket overlaps the range. Coverage says how much of the range a venue's book can see at all.
import type { DeepBook } from "./data.ts";

export type VenueLiq = { venue: string; usd: number; coverage: number };
export type ZoneLiq = { usd: number; complete: boolean; venues: VenueLiq[] };

const clamp = (x: number) => Math.max(0, Math.min(1, x));

// side 1 counts bids (demand), side -1 counts asks (supply).
export function liquidityIn(books: DeepBook[], lo: number, hi: number, side: 1 | -1): ZoneLiq {
  const span = Math.max(hi - lo, 1e-12);
  const venues = books.map((b) => {
    let usd = 0;
    for (const s of side > 0 ? b.bids : b.asks) {
      if (s.hi === s.lo) {
        if (s.lo >= lo && s.lo <= hi) usd += s.usd;
      } else {
        const ov = Math.min(s.hi, hi) - Math.max(s.lo, lo);
        if (ov > 0) usd += (s.usd * ov) / (s.hi - s.lo);
      }
    }
    // Bids exist from the best bid down to the book's reach, asks from the best ask up to it.
    const coverage = Number.isFinite(side > 0 ? b.bidReach : b.askReach) ? (side > 0 ? clamp((hi - Math.max(lo, b.bidReach)) / span) : clamp((Math.min(hi, b.askReach) - lo) / span)) : 0;
    return { venue: b.venue, usd, coverage };
  });
  return { usd: venues.reduce((s, v) => s + v.usd, 0), complete: venues.length > 0 && venues.every((v) => v.coverage >= 0.999), venues };
}
