// Shared types. Everything the API returns is plain JSON described here.

export type Bar = {
  t: number; // open time, seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // base volume
  q: number; // quote volume (USDT)
  tb: number; // taker-buy base volume
};

export type Tone = "up" | "down" | "flat";

export type OrderBlock = {
  side: "bull" | "bear";
  t: number; // time of the origin candle
  top: number;
  bottom: number;
  tests: number;
};

export type Profile = {
  poc: number;
  vah: number;
  val: number;
  rows: { price: number; vol: number }[];
};

export type LiqCluster = { price: number; side: "long" | "short"; usd: number };

export type Level = { price: number; label: string; weight: number };

export type Signal = { key: string; value: string; note: string; tone: Tone };

export type Horizon = {
  label: string;
  days: number;
  q05: number;
  q25: number;
  q50: number;
  q75: number;
  q95: number;
  pUp: number;
};

export type Touch = { price: number; label: string; p3d: number; p7d: number };

export type Forecast = {
  direction: "UP" | "DOWN" | "NEUTRAL";
  pUp3d: number;
  sigmaDay: number;
  driftDay: number;
  horizons: Horizon[];
  touches: Touch[];
  analogs: { n: number; pUp: number; base: number; medianRet: number };
  backtest: { calls: number; hitRate: number; horizonDays: number };
  history: { t: number; c: number }[];
  drivers: string[];
};

export type Setup = {
  name: string;
  side: "LONG" | "SHORT";
  grade: "A" | "B" | "C";
  score: number;
  zone: [number, number];
  trigger: string;
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  rr1: number;
  rr2: number;
  pReach: number;
  pWin: number; // corrected against the backtest
  expR: number;
  rawWin: number; // the simulation's uncorrected figures
  rawEv: number;
  confluence: string[];
  why: string[];
  invalid: string;
};

export type ConfItem = { label: string; pts: number; on: boolean };
export type TaSignal = {
  lane: "HTF" | "LTF";
  trigger: string; // trigger timeframe
  bias: string; // bias timeframe
  state: "ACTIVE" | "WATCH" | "NONE";
  side: "LONG" | "SHORT" | null;
  score: number;
  max: number;
  items: ConfItem[];
  wall: { price: number; usd: number; venue: string } | null; // live only, never in the tested score
  zone: { label: string; top: number; bottom: number } | null;
  entry: number;
  stop: number;
  target: number | null;
  rr: number | null;
  plan: string;
  invalid: string;
  since: number | null; // when the signal fired, seconds
};
export type Frame = {
  tf: string;
  trend: "UP" | "DOWN" | "RANGE";
  event: { kind: string; dir: number; level: number; t: number } | null;
  hi: number | null; // last swing high
  lo: number | null; // last swing low
  labels: string[]; // latest swing labels, oldest first
};
export type TaZone = { tf: string; kind: string; side: "DEMAND" | "SUPPLY"; top: number; bottom: number; dist: number };
export type TaPool = { tf: string; side: "HIGH" | "LOW"; price: number; touches: number; dist: number };

export type Analysis = {
  sym: string;
  asOf: number;
  price: number;
  stats: {
    chg1h: number;
    chg4h: number;
    chg24h: number;
    chg7d: number;
    chg30d: number;
    vol24hUsd: number;
    fundingBinance: number | null;
    fundingHL: number | null;
    premiumHL: number | null;
    oiUsd: number;
    oiChg1h: number | null;
    oiChg4h: number | null;
    oiChg24h: number | null;
    oiToMcap: number | null;
    rsi1h: number;
    rsi4h: number;
    rsi1d: number;
    atrDayPct: number;
    vol30dAnn: number;
    trend1h: Tone;
    trend4h: Tone;
    trend1d: Tone;
    alpha30: number;
    alpha30t: number;
    beta30: number;
    beta90: number;
    corr90: number;
    excess7d: number;
    cvdPerp1h: number;
    cvdPerp4h: number;
    cvdPerp24h: number;
    cvdSpot24h: number | null;
    retailLS: number | null;
    retailLSChg: number | null;
    topLS: number | null;
    topLSChg: number | null;
    regime: string;
  };
  signals: Signal[];
  ribbon: { hiT: number; loT: number; hi: number; lo: number; state: string };
  orderBlocks: OrderBlock[];
  profile: Profile;
  liq: { clusters: LiqCluster[]; shortsAbove: number; longsBelow: number; skew: number };
  forecast: Forecast;
  ta: { signals: TaSignal[]; frames: Frame[]; zones: TaZone[]; pools: TaPool[] };
};

export type BookRow = {
  price: number;
  bid: number;
  ask: number;
  liqLong: number;
  liqShort: number;
};

export type Book = {
  mid: number;
  spreadBp: number;
  imb1: number;
  imb2: number;
  bid2: number;
  ask2: number;
  rows: BookRow[];
  walls: { side: "bid" | "ask"; price: number; usd: number; venue: string }[];
  venues: string[];
};

export type UniverseCoin = {
  sym: string;
  price: number;
  chg24h: number;
  vol24hUsd: number;
  funding: number;
};

export type ScreenerRow = {
  sym: string;
  price: number;
  chg24h: number;
  frames: { tf: string; trend: string }[];
  event: string; // latest structure event on the lowest timeframe
};

export type KlinesResp = { bars: Bar[]; spot: { t: number; d: number }[] };

export type NewsCategory = "HACK" | "WAR" | "FED" | "MACRO" | "OIL" | "REG" | "FLOWS" | "MARKET" | "CRYPTO";
export type NewsBias = "RISK-ON" | "RISK-OFF" | "UNCLEAR";
export type NewsItem = {
  id: string;
  title: string;
  link: string;
  source: string;
  sources: number; // distinct outlets carrying the story
  t: number; // first seen, ms
  updated: number;
  category: NewsCategory;
  impact: "HIGH" | "MED" | "LOW";
  score: number;
  hot: number; // score decayed by age
  bias: NewsBias;
  why: string;
  coins: string[];
};
export type NewsResp = { asOf: number; feedsOk: number; feedsTotal: number; items: NewsItem[] };
