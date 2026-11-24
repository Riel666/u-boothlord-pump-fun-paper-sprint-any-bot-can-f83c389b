# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Riel666/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Riel666/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun bonding-curve replay (agent-fun/replay/v2). It trades 10 SOL of paper money on 24 hours of recorded pump.fun activity.

## Strategy

Most coins spike in their create slot and then bleed back below their entry price, so buying the average launch loses money. What predicts a coin keeps climbing is not how much SOL its launch bought, but how many different wallets bought it: a launch with 20 SOL from two wallets is a bundle waiting to dump, while a launch with 5 SOL from twenty wallets is retail arriving together — and retail keeps arriving for the next minute. On the dev window, coins with **at least 10 distinct buyers in their create slot** win 71% of the time, while coins selected on creator-buy size alone lose heavily. So the bot:

1. Watches every coin from its `CreateEvent` and counts distinct non-creator buyers (and total SOL bought) in the create slot.
2. Buys a coin **in its create slot** only when that count is ≥ 10 and at least 5 SOL was bought, and the creator has not sold in that slot.
3. **Buys as much as the reply cap allows** (1% of real SOL reserves per reply) and pyramids into strength up to 1 SOL per coin — a slow pyramid chases the peak and loses the edge.
4. Sells the whole position at **+20% take-profit, −10% stop-loss, a trailing stop once the peak is +10% (exit 5% below the peak), or after 300 slots** — and immediately if the creator sells after entry. A single slot can dump a coin 70%, so exits have to be fast; never holding a bleeding curve hoping it comes back.

Everything is a pure function of the batches the harness sends: no clock, no randomness, no network, no I/O, so the two graded executions produce byte-identical action logs.

## Local result (dev window)

`grade-local` on the kit's dev data: **net PnL +2.323 SOL** (+23.23% on 10 SOL), 27 round trips over 27 coins, 66.7% win rate, max drawdown 2.6%, guardrails met; without the 3 best coins still +1.23 SOL, and at 2x fees still +1.645 SOL. For comparison: hold-cash 0, equal-weight −0.019 SOL, sniper −0.47 SOL, reversion −4.00 SOL, momentum −9.49 SOL. The edge also holds in both halves of the dev window (+0.87 / +1.45 SOL) and across failed-transaction draws.

## Run it

```sh
node main.ts
# speaks agent-fun/replay/v2 on stdin/stdout; run by the grader as `node /bot/main.ts`
```

## Grade it locally

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process --worktree
```

The strategy lives in `strategy.ts`; the SDK shim is vendored byte for byte in `vendor/` (a copy of the kit's `sdk/ts/makefun-bot.ts`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=nrw7bbqr&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
