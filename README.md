# Q Terminal

Crypto market terminal. Next.js, TypeScript, lightweight-charts. Public feeds only, no API keys.

    npm install
    npm run build && npm start     # http://localhost:3100
    npm run dev                    # development, same port

    node --experimental-strip-types --no-warnings scripts/smoke.ts HYPE SOL   # engine check on live data
    node --experimental-strip-types --no-warnings scripts/bias.ts             # long/short balance across the list

Keys: `1`-`5` switch tabs, `/` focuses search.

## Layout of the code

- `lib/quant.ts`: pure indicators (EMA, RSI, ATR, CVD, AVWAP, order blocks, volume profile, OLS, liquidation model). Runs on client and server.
- `lib/model.ts`: forecast (bootstrap paths, analogs, walk-forward test) and the setup engine.
- `lib/analyze.ts`: joins feeds and models into one per-coin bundle.
- `lib/data.ts`: Binance, Hyperliquid and Bybit access with a TTL cache.
- `lib/tpo.ts` and `lib/absorb.ts`: Market Profile and zone absorption, each pure and separate.
- `components/Chart.tsx`: live chart. `components/TpoTab.tsx` and `components/AbsorbTab.tsx`: the TPO and ABSORB tabs. `components/Terminal.tsx`: everything else.

## Honest limits

- Liquidation clusters are modelled from open-interest changes, not exchange data.
- The website shows structure, zones and liquidity, not trade signals. The signal engine stays in `lib/` for research, and it has no proven edge.
- Deploy outside the US. Binance rejects US servers with error 451, so `vercel.json` pins the functions to Mumbai.
- HL FLOW switches the chart to Hyperliquid only: candles, fills and order book. Fills are grouped into orders, filtered by a dollar minimum and animated by `components/flow-layer.ts`. The depth rail shows the live book. The CVD pane stays on Binance taker flow, because Hyperliquid publishes no taker history, and the side panels still use the main feed.

## Backtest

The live engine and the replay share `lib/engine.ts`, so what gets tested is what runs. Run these from `terminal/`, each with `node --experimental-strip-types --no-warnings`:

1. `scripts/history.ts 700` downloads history for the watchlist into `data/history/`.
2. `scripts/replay.ts SYM 640` rebuilds every 4h snapshot for one coin into `data/replay/`.
3. `scripts/leak-test.ts BTC` proves no snapshot can see the future.
4. `scripts/baseline.ts` scores the engine as it stands.
5. `scripts/tune.ts` and `scripts/round2.ts` are the tuning rounds. `scripts/history-wide.ts` then `scripts/round3.ts` run the locked momentum test on every perp, delisted ones included.
6. `scripts/calibrate.ts` rewrites `lib/record.ts`, the tested results and win-rate correction shown on the SETUP tab.

Fills use each setup's trigger. A bar that touches both stop and target counts as a stop. Costs are 0.02% maker, 0.05% taker, 0.03% slippage, plus actual funding. Discovery, validation and the last 30 days are kept separate.

## Multi-timeframe search

`lib/mtf.ts` holds 14 strategy families, a consensus strategy, trailing exits and HTF filters on 5m to 1D. `lib/members.ts` lists the discovery shortlist the consensus votes from. Neither is used by the live terminal, because nothing has passed all the gates. Run from `terminal/`:

1. `scripts/history-ltf.ts` downloads 5m bars, funding and 1h OI into `data/ltf/`.
2. `scripts/mtf-leak.ts` proves no strategy can see the future.
3. `scripts/mtf-search.ts <tf>` searches one timeframe on the watchlist, older data only. `scripts/mtf-search.ts 1h vote` searches the consensus.
4. `scripts/mtf-gates.ts <tf>` runs the 12 gates locked at the top of that file. Add `vote` for the consensus.
5. `scripts/mtf-report.ts` prints the intersection.

Result on 2026-10-31: 12,780 variations, 40 shortlisted, none passed all 12. Unseen coins are UNI and AERO.

Niche round the same day: `scripts/history-extra.ts`, then `scripts/mtf-search.ts <tf> n` and `scripts/mtf-gates.ts <tf> n`, with `scripts/mtf-inspect.ts` for a close look at named strategies. About 35,500 variations in all, 78 shortlisted, none passed all 12. Closest at 10 of 12: 1h Market cascade fade and 4h Range breakout, both failing unseen coins and deflated Sharpe. `scripts/listings.ts` (short new listings) and `scripts/round3.ts carry` and `both` (funding carry) failed their own locked marks.

## Technical signals

The terminal runs on market structure. `lib/structure.ts` finds swings, BOS, CHoCH, MSS, order blocks, supply and demand zones, FVGs, liquidity pools and sweeps. `lib/ta.ts` scores a structure break against its bias timeframe. `lib/live-ta.ts` turns that into the HTF and LTF lanes, and `lib/lanes.ts` holds their settings.

OI, funding, liquidation clusters and long/short ratios are collected and shown on the CONTEXT tab, but they are not inputs to signals, zones or the forecast. CVD and order book walls are allowed inputs. Book walls have no history, so they add a live-only point outside the tested score.

To retest: `scripts/mtf-search.ts <tf> smc` and `scripts/mtf-gates.ts <tf> smc` for 4h, 1h and 15m, then `scripts/ta-peek.ts` to read them and `scripts/ta-record.ts` to refresh `lib/lanes.ts` and `lib/ta-record.ts`.

## Range rules

Range rules from public trader posts live in `lib/lab.ts`, and the multi-timeframe search tests them (`scripts/mtf-search.ts <tf> lab`). The LAB page that showed them live has been removed from the site. To pull posts again, put `TWITTERAPI_KEY` in `.env.local`, then run `scripts/x-fetch.ts <user> 30` and `scripts/x-digest.ts <user>`.

## TPO

The TPO tab draws a Market Profile for each UTC day from 30-minute bars: one letter per 30-minute period at every price it traded. It shows POC, value area (70% of time), initial balance, single prints, tails, poor highs and lows, profile shape, a 5-day composite and POCs price has not revisited. `lib/tpo.ts` holds the maths and `components/TpoTab.tsx` the view. The chart's TPO button draws the live POC, value area and nearby untested POCs as lines. Row size comes from the last three days, so the tab and the chart agree.

## Absorption

The ABSORB tab measures how much aggressive flow each 1H and 4H zone has soaked up: market sells into demand, market buys into supply. It uses Binance perp and spot taker data on 15-minute bars, split by how much of each bar sat in the zone. It also lists bars in the heaviest tenth of one-sided flow where price still failed to move, which shows passive orders absorbing. `lib/absorb.ts` holds the maths and `components/AbsorbTab.tsx` the view. It cannot see what is still resting in the book.

## Wicks

The chart's WICKS button reads candle wicks two ways. Wick flow measures market buying and selling inside each meaningful wick from smaller perp candles (1-minute for 5M and 15M charts, 5-minute for 1H, 15-minute for 4H, hourly for 1D), so a wick reads as buyers or sellers trapped, an active rejection, a thin poke, or two-way. The sweep detector flags wicks that ran through a swing high or low, equal highs or lows, or the prior day's high or low and closed back inside, and tracks whether price has stayed back since. The side panel lists the latest reads and a track record: how often each pattern moved price its way within 8 candles on that coin and timeframe, against how often price moved that way anyway. `lib/wicks.ts` holds the maths and `app/api/wicks` serves it. The track record is descriptive and unvalidated, and small samples are anecdotal.

## Measure

The chart's MEASURE button is a ruler: click or tap a start and an end point to see the move in price, percent, bars and elapsed time. On desktop, Shift-click measures without turning the mode on, a plain click clears a finished measure, and Esc clears everything. Clicks are read from the browser rather than the chart library, because the library drops a quick second click.

