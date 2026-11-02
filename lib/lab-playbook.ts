// The setups in plain language, with where each rule came from. Post ids are @tradermatt's public posts.
export type PlayStep = { label: string; text: string };
export type Play = { fam: string; title: string; tag: string; idea: string; steps: PlayStep[]; source: string[] };

const post = (id: string) => `https://x.com/tradermatt/status/${id}`;

export const PLAYBOOK: Play[] = [
  {
    fam: "labcont",
    title: "Continuation range break",
    tag: "Trend continues",
    idea: "Impulse, base, then a close through the same side. His main pattern, from rally-base-rally on M1 up to the daily.",
    steps: [
      { label: "Location", text: "The base sits at a swing high after an impulse up, or a swing low after an impulse down. Never mid-swing." },
      { label: "Range", text: "Sideways price touching both edges at least twice." },
      { label: "Entry", text: "Next open after a close beyond the range, or the retest that holds." },
      { label: "Stop", text: "Opposite side of the range." },
      { label: "Target", text: "At least 2.5R, or skip the trade." },
    ],
    source: [post("2112894420635054356"), post("2110756326989078828"), post("2115376950571098468")],
  },
  {
    fam: "labrev",
    title: "Reversal range failure",
    tag: "Trend turns",
    idea: "Same base, but it fails and closes through the far side, usually after taking out a higher-timeframe zone.",
    steps: [
      { label: "Location", text: "A base at the end of an impulse, ideally after hitting a higher-timeframe zone." },
      { label: "Trigger", text: "A close through the far side of the range." },
      { label: "Entry", text: "Next open, or the retest from the other side." },
      { label: "Stop", text: "The far side of the range." },
      { label: "Target", text: "At least 2.5R, or skip the trade." },
    ],
    source: [post("2112894420635054356"), post("2113213271675396286")],
  },
  {
    fam: "labdev",
    title: "Range deviation",
    tag: "Fake break",
    idea: "A wick through the range that closes back inside. Less confirmation and a lower strike rate, but much more reward.",
    steps: [
      { label: "Location", text: "A valid range at a swing extreme." },
      { label: "Trigger", text: "A wick through one edge and a close back inside. This is failed acceptance." },
      { label: "Entry", text: "Next open." },
      { label: "Stop", text: "Beyond the wick." },
      { label: "Target", text: "The other side of the range, at least 2.5R away." },
    ],
    source: [post("2113980578634608951")],
  },
  {
    fam: "labmtf",
    title: "HTF range, LTF reversal",
    tag: "HTF map, LTF entry",
    idea: "The higher-timeframe range is the map. At its edge, drop down and take a reversal pattern back to the other side.",
    steps: [
      { label: "Map", text: "A 4H or 1D range. Stay out of the middle of it." },
      { label: "Location", text: "Price at the top or bottom fifth of that range." },
      { label: "Trigger", text: "A lower-timeframe range forms and closes through the side facing back into the range." },
      { label: "Stop", text: "Far side of the lower-timeframe range." },
      { label: "Target", text: "Other side of the higher-timeframe range, at least 2.5R away." },
    ],
    source: [post("2114715420045488505"), post("2114358317669548456")],
  },
];

export const RULES: PlayStep[] = [
  { label: "Where", text: "Only trade at swing highs, swing lows, or the level that preceded a break. The middle is noise." },
  { label: "Patience", text: "Mark where you want the pattern. Wait. If it doesn't form, no trade today." },
  { label: "Confirmation", text: "Enter on closes. If it looks like it will break but doesn't close, there is no trade." },
  { label: "Low volume", text: "When the market is dead, wait for range extremes to break before doing anything." },
  { label: "Days", text: "No weekends. No FOMC days, even for an A+ setup. Monday is his worst day." },
  { label: "Intraday", text: "Trade the New York session, and skip the first hour until volume shows up. No overnight holds." },
  { label: "Loss limit", text: "Daily loss limit with no exceptions. Most damage comes from revenge after a double stop-out." },
  { label: "Failure", text: "If a pattern fails, the failure is often the trade. Flip only if the read supports it." },
  { label: "Measure", text: "Judge in R, not dollars. Journal which setups, days and coins actually pay." },
];

export const PEERS: PlayStep[] = [
  { label: "semtrades", text: "Trades swing failure patterns: where was the sweep, did price fail and close back inside, is the stop beyond the failed extreme? Entry from the reaction, stop from invalidation, target from structure. In the lab: the deviation setup." },
  { label: "semtrades", text: "Not every swept level carries the same weight. Ask which structure a level belongs to, and keep the target tied to that. In the lab: the HTF range as the map." },
  { label: "Stnxbt", text: "Looks for a key HTF level plus an LTF compression to trade from, thinks in expected value, and treats several no-trade days before one +5R trade as a good week." },
  { label: "Trader_XO", text: "Frames areas with market profile, VWAP, ATR and ADR, then executes on flow. Monthly VWAP acts as a line in the sand, and a failed hold above it is a short. In the lab: the monthly VWAP filter." },
  { label: "Trader_XO", text: "Distance from the bands gives mean reversion. Riding the bands gives continuation. Stay aligned with the current auction." },
  { label: "TraderMagus", text: "Works from order flow and VWAP, and says most traders would do better not identifying as a bull or a bear. Matt agreed: ask what the risk to reward favours. In the lab: the taker-flow check on the base." },
];
