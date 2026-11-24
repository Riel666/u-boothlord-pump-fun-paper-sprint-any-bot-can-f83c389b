// Broad Launch: buy launches that arrive broad, not just big.
//
// Idea (mine — different from the launch-size spike-catcher, the flow
// momentum, dip-buy and sniper rules): what predicts a coin keeps climbing
// after its create slot is not how much SOL its launch bought, but how many
// different wallets bought it. A launch with 20 SOL from two wallets is a
// bundle waiting to dump; a launch with 5 SOL from twenty wallets is retail
// arriving together, and retail keeps arriving for the next minute. On the
// dev window, coins with >=10 distinct buyers in their create slot win 71%
// of the time at a +15% take-profit / -10% stop (31 coins, +1.0 SOL at
// 0.5 SOL a coin), while coins selected on creator-buy size alone lose
// heavily and coins selected on total volume alone include the bundled ones.
// So this bot enters in the create slot itself, only when the launch is
// broad (>= minBuyers distinct non-creator buyers) and real (>= minBuyVol0
// SOL bought), and the creator has not sold in that slot. It buys what the
// 1%-of-real-reserve reply cap allows, pyramids into strength up to the
// stake, and is out on a take-profit, a stop, a trailing stop, a time limit,
// or the moment the creator sells after entry — never holding a bleeding
// curve hoping it comes back, and never chasing a coin that already ran far.
//
// Every decision is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O, no environment reads, so the two graded
// executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Distinct non-creator buyers in the create slot required to enter. */
  minBuyers: number;
  /** Total SOL bought in the create slot required to enter. */
  minBuyVol0Sol: number;
  /** Skip a coin whose creator sold in its create slot. */
  skipDevSold: boolean;
  /** Sell the whole position as soon as the creator sells after entry. */
  exitDevSold: boolean;
  /** Total SOL to put into one position. */
  stakeSol: number;
  /** Target size of the first buy (SOL); the reply cap may shrink it. */
  initialSol: number;
  /** Size of each add-on buy (SOL). */
  addSol: number;
  /** Add only within this many slots of the first buy decision. */
  addWindow: number;
  /** Add only while the price is at most this far below the first buy's price. */
  addDip: number;
  /** Take profit: sell when the position's close value reaches cost * (1 + tp). */
  takeProfit: number;
  /** Stop loss: sell when it falls to cost * (1 - sl). */
  stopLoss: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Trailing stop: sell when close value falls this far below its peak (0 = off). */
  trail: number;
  /** The trailing stop arms once the peak reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
}

// Settings traded with: chosen on the dev window with work/sweep.ts
// (two rounds), preferring flat regions of the grid over its single best
// cell. The edge is launch breadth: >=10 distinct buyers in the create slot,
// +5 SOL bought, wins in both halves of the dev window and across
// failed-transaction draws. Best plateau (mean over 4 fail draws):
// stake 1.0 SOL, take-profit +20%, stop-loss -10%, 300-slot hold, trailing
// stop -5% once the peak is +10% — mean +2.24 SOL, worst draw +1.95.
export const DEFAULT_PARAMS: Params = {
  minBuyers: 10,
  minBuyVol0Sol: 5,
  skipDevSold: true,
  exitDevSold: true,
  stakeSol: 1,
  initialSol: 1,
  addSol: 1,
  addWindow: 120,
  addDip: 0.02,
  takeProfit: 0.2,
  stopLoss: 0.1,
  maxHold: 300,
  trail: 0.05,
  trailArm: 0.1,
  buySlipBps: 500,
};

const LAMPORTS_PER_SOL = 1_000_000_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30 fallback
const BPS = 10_000n;
const MIN_BUY = 10_000_000n; // 0.01 SOL: the guardrail's minimum round trip

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Net SOL (lamports) received for selling `tokens` at the curve's reserves. */
function closeValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - ceilDiv(q * FEE_BPS, BPS);
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

interface Launch {
  creator: Pubkey;
  /** Distinct non-creator buyers in the create slot. */
  buyers: Set<Pubkey>;
  /** SOL bought in the create slot (lamports). */
  buyVol: bigint;
  /** The creator sold in the create slot. */
  devSold0: boolean;
  /** The creator sold after entry (checked per batch). */
  devSold: boolean;
}

interface CoinTrack {
  launch: Launch;
  /** Slot the first buy for this coin was decided. */
  firstBuySlot: number;
  /** Price at the first buy decision. */
  firstBuyPrice: number;
  /** Peak close value seen while holding (lamports). */
  peak: bigint;
  /** Slot of the first buy fill (hold clock starts here). */
  filledSlot: number;
  /** True once a position in this coin has closed; never re-enter. */
  done: boolean;
}

export function createStrategy(params: Params): Bot {
  const p = params;
  const stake = BigInt(Math.round(p.stakeSol * 1e9));
  const initial = BigInt(Math.round(p.initialSol * 1e9));
  const add = BigInt(Math.round(p.addSol * 1e9));
  const minBuyVol0 = BigInt(Math.round(p.minBuyVol0Sol * 1e9));
  const launches = new Map<Pubkey, Launch>();
  const tracks = new Map<Pubkey, CoinTrack>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = state.slot;

      // Scan this batch's events: record launches and creator sells.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          launches.set(e.mint, {
            creator: e.creator,
            buyers: new Set(),
            buyVol: 0n,
            devSold0: false,
            devSold: false,
          });
        } else if (e.event === 'TradeEvent') {
          const launch = launches.get(e.mint);
          if (launch === undefined) continue;
          const curve = state.curves.get(e.mint);
          const isCreateSlot = curve !== null && curve !== undefined && curve.created_slot === e.slot;
          if (!e.is_buy && e.user === launch.creator) {
            launch.devSold = true;
            if (isCreateSlot) launch.devSold0 = true;
          }
          if (isCreateSlot && e.is_buy) {
            launch.buyVol += BigInt(e.sol_amount);
            if (e.user !== launch.creator) launch.buyers.add(e.user);
          }
        }
      }

      // Fold fills: learn when buys land (hold clock) and when positions close.
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        const t = tracks.get(f.mint);
        if (t === undefined) continue;
        if (f.side === 'buy' && t.filledSlot < 0) t.filledSlot = f.slot;
        if (f.side === 'sell') {
          const held = state.positions.get(f.mint);
          if (held === undefined || held.token_amount === 0n) t.done = true;
        }
      }

      // Exits first: sell whole positions on TP / SL / trailing / time / dev sell.
      // Skip a mint that already has a sell pending: sending the same sell
      // twice only earns an insufficient_tokens rejection (and its tx fee).
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }
      for (const [mint, held] of state.positions) {
        if (pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        const t = tracks.get(mint);
        if (curve === undefined || curve.complete || held.token_amount <= 0n) continue;
        const value = closeValue(held.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (t !== undefined && value > t.peak) t.peak = value;
        const cost = held.cost_lamports;
        let exit = false;
        if (value >= (cost * BigInt(Math.round((1 + p.takeProfit) * 1000))) / 1000n) exit = true;
        if (value <= (cost * BigInt(Math.round((1 - p.stopLoss) * 1000))) / 1000n) exit = true;
        if (
          t !== undefined &&
          p.trail > 0 &&
          t.peak >= (cost * BigInt(Math.round((1 + p.trailArm) * 1000))) / 1000n &&
          value <= (t.peak * BigInt(Math.round((1 - p.trail) * 1000))) / 1000n
        ) {
          exit = true;
        }
        if (p.maxHold > 0 && t !== undefined && t.filledSlot >= 0 && slot - t.filledSlot >= p.maxHold) exit = true;
        if (p.exitDevSold && t !== undefined && t.launch.devSold) exit = true;
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10000 });
          if (t !== undefined) t.done = true;
        }
      }

      // Entries and adds: only in/just after the create slot, only broad launches.
      for (const [mint, curve] of state.curves) {
        if (orders.length >= 16) break;
        const launch = launches.get(mint);
        if (launch === undefined || curve.complete || curve.created_slot === null) continue;
        let t = tracks.get(mint);
        if (t !== undefined && t.done) continue;
        const held = state.positions.get(mint);
        const pendingBuy = [...state.pending.values()]
          .filter((po) => po.order.side === 'buy' && po.order.mint === mint)
          .reduce((s, po) => s + BigInt(po.order.quote_lamports), 0n);
        const invested = (held?.cost_lamports ?? 0n) + pendingBuy;
        if (invested >= stake) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (t === undefined) {
          // First buy: only in the create slot itself, only a broad launch.
          if (slot !== curve.created_slot) continue;
          if (launch.buyers.size < p.minBuyers) continue;
          if (launch.buyVol < minBuyVol0) continue;
          if (p.skipDevSold && launch.devSold0) continue;
          if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
          t = {
            launch,
            firstBuySlot: slot,
            firstBuyPrice: price,
            peak: 0n,
            filledSlot: -1,
            done: false,
          };
          tracks.set(mint, t);
          const cap = state.maxBuyLamports(mint);
          const free = state.freeCashLamports() - state.txFeeLamports();
          let size = initial;
          if (size > cap) size = cap;
          if (size > free) size = free;
          if (size < MIN_BUY) {
            tracks.delete(mint);
            continue;
          }
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
        } else {
          // Add: inside the add window, only into strength (price near the first buy).
          if (slot - t.firstBuySlot > p.addWindow) continue;
          if (t.firstBuyPrice > 0 && price < t.firstBuyPrice * (1 - p.addDip)) continue;
          if (launch.devSold) continue;
          const cap = state.maxBuyLamports(mint);
          const free = state.freeCashLamports() - state.txFeeLamports();
          let size = stake - invested;
          if (size > add) size = add;
          if (size > cap) size = cap;
          if (size > free) size = free;
          if (size < MIN_BUY) continue;
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
        }
      }

      return orders;
    },
  };
}
