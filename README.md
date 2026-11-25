[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532 · rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Junior-Coding-ID/pump-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532 · reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Junior-Coding-ID/pump-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Pump.fun Sharpe Sprint — "Tetes Stabil"

Paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty (`agent-fun/replay/v2`, Node 22, stdin/stdout). Ranked by **hourly Sharpe ratio**, not wild PnL — so this bot grinds small, disciplined, diversified round trips instead of chasing one moonshot.

## Strategy: pure accumulation + creator backing

Offline research on the kit's dev dataset (128,058 events, 1,222 mints) showed that every reactive price signal (momentum-chasing, dip-buying, trailing stops) has **negative** expectancy once the harness's 2-slot fill latency is accounted for: a pump.fun pump lasts ~2–5 trades and the fill lands after it. The one signal family that survived realistic fill modelling:

- **Enter only when a coin's first 10 trades are ALL buys** (pure accumulation — no seller has shown up yet) **and** its real SOL reserve is already ≥ 1 SOL (so the 1%-of-reserve buy cap allows a ≥ 0.01 SOL round trip).
- **Creator backing:** if the coin's creator bought ≥ 0.3 SOL across those first 10 trades, the trade gets a wider take-profit (+20% vs +15%) and up to 0.05 SOL size; plain qualifiers get 0.011 SOL (just above the guardrail floor — their gross edge is below round-trip fees, so size is kept minimal while still counting toward the 20-mint guardrail).

**Exits (disciplined):** take-profit +15% (+20% creator-backed), stop-loss −5%, max hold 300 batches. Sell slippage is deliberately loose (10%) because in testing, tight sell slippage got repeatedly rejected during dumps and positions rode to −15% instead of exiting near −5%.

**Determinism:** 100% deterministic — no clock, no unseeded randomness; every decision comes from batch data and named constants. The two grading executions reproduce byte for byte.

## Dev-window grade (local, `grade-local --driver process`)

| metric | value |
|---|---|
| net PnL | +0.0299 SOL |
| Sharpe (hourly) | +0.065 |
| Sortino | +0.104 |
| return | +0.30% |
| max drawdown | 1.02% |
| win rate | 36.7% |
| round trips / distinct mints | 109 / 109 |
| guardrails | met (109 ≥ 20 mints, drawdown ok) |

## How to test

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/pump-sharpe-sprint --driver process --worktree
node cli/makefun.mjs grade-local --kit . --bot /path/to/pump-sharpe-sprint --driver process --worktree --stress
```

## Layout

- `main.ts` — the whole strategy (Node-only, no dependencies, no network).
- `vendor/makefun-bot.ts` — the kit's own `agent-fun/replay/v2` shim, vendored unchanged.
- `LICENSE` — MIT.
