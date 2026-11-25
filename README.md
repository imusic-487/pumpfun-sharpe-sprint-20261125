# Clean-Sharpe Launch Sniper

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/imusic-487/pumpfun-sharpe-sprint-20261125/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/imusic-487/pumpfun-sharpe-sprint-20261125/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on make.fun. It trades paper SOL on a 6-hour pump.fun bonding-curve replay and is ranked by hourly Sharpe ratio, so it aims for steady, controlled gains rather than one lucky moonshot.

## How it works

Measured on the kit's dev window before writing the strategy:

- **Only the first few slots matter.** A launch's price keeps running for about two trades after the opening tape (mean +13% over the next two trades at trade 0, fading to ~0 by trade 5). Entries later than that are negative-expectancy once the ~3% round-trip fee is paid, so the bot only ever buys a coin in its first few slots of life and never chases an old curve.
- **Tight buy slippage is a free filter.** The fill lands 2 slots after the decision, so a buy slippage of 2000 bps means a launch that verticals away in the latency is rejected for nothing instead of filled at the top.
- **Asymmetric exits.** Take-profit far (+15%), stop-loss near (−12%), a half take-profit at +10% with the rest trailed from breakeven, and a hard time cap. That shape caps downside variance per trade — what an hourly Sharpe ranking rewards — while keeping the right tail of runners.
- **Rug filters.** Skip a launch once its creator sells, cap the early crowd (too many distinct early buyers = a bundled dump in waiting), cap the run-up since creation, require real SOL in a band that shows genuine interest, and require recent net inflow.
- **Guardrail pacing.** If completed ≥ 0.01 SOL round trips lag the pace needed for 25 coins over the window, tiny probe round trips (0.010 SOL, sold as soon as they land) on liquid coins keep the entry above the 20-coin minimum bar.

Everything is deterministic: no clock, no randomness, no I/O, no network. The only entrypoint is `main.ts`; the strategy lives in `strategy.ts` and the SDK shim is the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte as `vendor/makefun-bot.ts`.

## Run it

Requires Node 22.18 or later (the grader runs Node 22.23.4; this repo was tested on Node 24):

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: it reads `hello` / `batch` / `done` lines and replies with one `reply` line per batch.

## Dev result

Graded locally with the kit's own grader (`grade-local --driver process`) on the dev window. See the run log in the build notes for the exact numbers; the entry is a deliberate small-stakes, high-selectivity design, so its dev edge is thin and it is reported honestly rather than tuned to a single lucky window.
