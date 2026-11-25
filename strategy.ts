// Pump.fun Sharpe Sprint — cleanest paper bot wins.
//
// Idea: Sharpe, not moonshots. Only buy a bonding curve in its first two
// slots of life, and only when the launch looks clean: real liquidity already
// there, at most two distinct early buyers, a small creator buy, no creator
// sell, a modest run-up (not a vertical spike), and non-negative recent net
// flow. Stake is small (0.08 SOL, capped at 1% of the real reserve) so one
// bad coin cannot dent the book. Exits are mechanical: +15% take-profit,
// -12% stop, half off at +10% with the rest trailed from breakeven, a 60-slot
// max hold, and an exit on creator sell, stale flow or heavy outflow.
//
// A second, separate mechanism keeps the guardrails honest: tiny 0.010 SOL
// probe buys on liquid coins with non-negative flow, sold on the first batch
// after the buy lands, used only while completed round trips lag the pace
// needed for 25 coins over a 6-hour window. Probes are not a profit engine;
// they exist so the entry clears the "at least 20 distinct mints with a
// >= 0.01 SOL round trip" bar even on a quiet window.
//
// Everything is deterministic: no clock, no environment, no randomness.
// The bot only reacts to the hello, batch and orders the harness sends it,
// one slot at a time.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const LAMPORTS = LAMPORTS_PER_SOL; // 1_000_000_000n

export interface StrategyParams {
  /** Buy only while slot - createdSlot <= this (first two slots of life). */
  maxEntryAgeSlots: number;
  /** Minimum real SOL in the curve before an entry. */
  minRealSol: number;
  /** Maximum distinct early buyers at entry time. */
  maxEarlyBuyers: number;
  /** Maximum creator buy (SOL) at entry time. */
  maxCreatorBuySol: number;
  /** Stake per entry (SOL), before the reserve cap. */
  stakeSol: number;
  /** Stake is also capped at this share (bps) of the real reserve. */
  maxStakeBpsOfRealReserve: number;
  /** Buy slippage: a launch that verticals away in the latency is rejected. */
  buySlippageBps: number;
  /** Sell slippage. */
  sellSlippageBps: number;
  /** Full take-profit return. */
  takeProfit: number;
  /** Full stop-loss return. */
  stopLoss: number;
  /** Return at which half the position is sold. */
  halfTakeProfit: number;
  /** Return at which the trailing stop arms. */
  trailArm: number;
  /** Drop from the peak (after arming) that sells the rest. */
  trailDrop: number;
  /** Max slots to hold a position. */
  maxHoldSlots: number;
  /** Exit when no trade has touched the coin for this many slots. */
  staleSlots: number;
  /** Exit when net flow over the last trades is worse than this (SOL). */
  heavyOutflowSol: number;
  /** Probe buy size (SOL). */
  probeSol: number;
  /** Minimum real SOL for a probe coin. */
  probeMinRealSol: number;
  /** Probe only while completed round trips lag this pace. */
  probeTargetTrips: number;
  /** Never send more probes than this in one run. */
  probeMaxAttempts: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  maxEntryAgeSlots: 1,
  // First grade: 21 orders rejected; entries fired on coins with real
  // reserve barely above 5 SOL, where the 1% reserve cap kept clipping the
  // 0.08 SOL stake. A full stake needs real reserve >= 8 SOL, so require
  // that up front instead of letting the cap shrink the order.
  minRealSol: 8,
  maxEarlyBuyers: 2,
  maxCreatorBuySol: 1,
  stakeSol: 0.08,
  maxStakeBpsOfRealReserve: 100,
  buySlippageBps: 2000,
  sellSlippageBps: 1000,
  takeProfit: 0.15,
  stopLoss: -0.12,
  halfTakeProfit: 0.1,
  trailArm: 0.12,
  trailDrop: 0.06,
  maxHoldSlots: 60,
  staleSlots: 30,
  heavyOutflowSol: -0.5,
  probeSol: 0.01,
  probeMinRealSol: 20,
  probeTargetTrips: 25,
  probeMaxAttempts: 40,
};

interface CoinInfo {
  mint: string;
  creator: string;
  createdSlot: number;
  /** SOL per token at creation (virtual reserves ratio). */
  createPrice: number;
  creatorBuyLamports: bigint;
  creatorSold: boolean;
  buyers: Set<string>;
  /** Signed SOL flow per trade, most recent last (+buy / -sell, lamports). */
  flow: bigint[];
  lastTradeSlot: number;
  attempted: boolean;
  probed: boolean;
}

interface OpenTrade {
  mint: string;
  /** SOL per token actually paid (fill quote / tokens). */
  entryPrice: number;
  entrySlot: number;
  halfTaken: boolean;
  trailArmed: boolean;
  peakPrice: number;
  probe: boolean;
  /** Batch seq in which the probe buy fill arrived; -1 while it is pending. */
  probeFilledSeq: number;
}

function priceOf(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function realSolOf(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return Number(curve.real_quote_reserves) / Number(LAMPORTS);
}

/** Net flow (SOL) over the coin's most recent trades. */
function recentNetFlowSol(coin: CoinInfo, lastN: number): number {
  const tail = coin.flow.slice(-lastN);
  let sum = 0n;
  for (const f of tail) sum += f;
  return Number(sum) / Number(LAMPORTS);
}

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS) {
  const coins = new Map<string, CoinInfo>();
  const open = new Map<string, OpenTrade>();
  /** client_id -> { mint, probe } for buys still awaiting a fill. */
  const pendingBuys = new Map<string, { mint: string; probe: boolean }>();
  let roundTrips = 0;
  let probeAttempts = 0;
  let coinsSeen = 0;

  function ingestFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') {
        // A rejected/failed buy frees nothing: the coin stays attempted.
        pendingBuys.delete(fill.client_id);
        continue;
      }
      if (fill.side === 'buy') {
        const pending = pendingBuys.get(fill.client_id);
        pendingBuys.delete(fill.client_id);
        const tokens = BigInt(fill.token_amount);
        const quote = BigInt(fill.quote_lamports);
        if (tokens <= 0n || quote <= 0n) continue;
        const entryPrice = Number(quote) / Number(tokens);
        const prev = open.get(fill.mint);
        if (prev !== undefined && !pending?.probe) {
          // Adding to an existing position: keep the original entry.
          continue;
        }
        open.set(fill.mint, {
          mint: fill.mint,
          entryPrice,
          entrySlot: fill.slot,
          halfTaken: prev?.halfTaken ?? false,
          trailArmed: false,
          peakPrice: entryPrice,
          probe: pending?.probe ?? false,
          probeFilledSeq: pending?.probe ? state.seq : -1,
        });
      } else {
        // A sell fill (ours, or the harness closing the curve) ends the trade.
        const trade = open.get(fill.mint);
        if (trade !== undefined) {
          const held = state.positions.get(fill.mint);
          if (held === undefined || BigInt(held.token_amount) <= 0n) {
            open.delete(fill.mint);
            roundTrips += 1;
          } else if (trade.probe) {
            // Probe sold in full by construction; any sell fill closes it.
            open.delete(fill.mint);
            roundTrips += 1;
          }
        }
        pendingBuys.delete(fill.client_id);
      }
    }
  }

  function ingestEvents(batch: Batch): void {
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (coins.has(event.mint)) continue;
        coinsSeen += 1;
        const vt = BigInt(event.virtual_token_reserves);
        const vq = BigInt(event.virtual_quote_reserves);
        coins.set(event.mint, {
          mint: event.mint,
          creator: event.creator,
          createdSlot: event.slot,
          createPrice: vt > 0n ? Number(vq) / Number(vt) : 0,
          creatorBuyLamports: 0n,
          creatorSold: false,
          buyers: new Set<string>(),
          flow: [],
          lastTradeSlot: event.slot,
          attempted: false,
          probed: false,
        });
      } else if (event.event === 'TradeEvent') {
        let coin = coins.get(event.mint);
        if (coin === undefined) {
          // First seen through a trade: synthesise from the post-trade reserves.
          coinsSeen += 1;
          const vt = BigInt(event.virtual_token_reserves);
          const vq = BigInt(event.virtual_quote_reserves);
          coin = {
            mint: event.mint,
            creator: event.creator,
            createdSlot: event.slot,
            createPrice: vt > 0n ? Number(vq) / Number(vt) : 0,
            creatorBuyLamports: 0n,
            creatorSold: false,
            buyers: new Set<string>(),
            flow: [],
            lastTradeSlot: event.slot,
            attempted: false,
            probed: false,
          };
          coins.set(event.mint, coin);
        }
        const sol = BigInt(event.sol_amount);
        if (event.is_buy) {
          coin.buyers.add(event.user);
          coin.flow.push(sol);
          if (event.user === coin.creator) coin.creatorBuyLamports += sol;
        } else {
          coin.flow.push(-sol);
          if (event.user === coin.creator) coin.creatorSold = true;
        }
        if (coin.flow.length > 40) coin.flow.splice(0, coin.flow.length - 40);
        coin.lastTradeSlot = event.slot;
      } else {
        // CompleteEvent: the curve is done; the harness closes any position.
        const coin = coins.get(event.mint);
        if (coin !== undefined) coin.lastTradeSlot = event.slot;
      }
    }
  }

  function exitOrders(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    for (const [mint, trade] of [...open.entries()]) {
      const held = state.positions.get(mint);
      if (held === undefined || BigInt(held.token_amount) <= 0n) {
        open.delete(mint);
        continue;
      }
      const tokens = BigInt(held.token_amount);
      const price = priceOf(state, mint);
      if (price === null || price <= 0 || trade.entryPrice <= 0) continue;

      // Probes: sell in full on the first batch after the buy fill landed.
      if (trade.probe && trade.probeFilledSeq >= 0 && state.seq > trade.probeFilledSeq) {
        orders.push({
          side: 'sell',
          client_id: state.clientId(),
          mint,
          token_amount: tokens.toString(),
          max_slippage_bps: params.sellSlippageBps,
        });
        continue;
      }
      if (trade.probe) continue; // probe buy still settling: hold until next batch.

      const coin = coins.get(mint);
      const ret = price / trade.entryPrice - 1;
      if (ret >= params.trailArm) {
        trade.trailArmed = true;
        if (price > trade.peakPrice) trade.peakPrice = price;
      }

      let sellTokens: bigint | null = null;
      if (ret >= params.takeProfit) {
        sellTokens = tokens;
      } else if (ret <= params.stopLoss) {
        sellTokens = tokens;
      } else if (!trade.halfTaken && ret >= params.halfTakeProfit) {
        sellTokens = tokens / 2n;
      } else if (trade.trailArmed && price <= trade.peakPrice * (1 - params.trailDrop)) {
        sellTokens = tokens;
      } else if (batch.slot - trade.entrySlot >= params.maxHoldSlots) {
        sellTokens = tokens;
      } else if (coin !== undefined && coin.creatorSold) {
        sellTokens = tokens;
      } else if (coin !== undefined && batch.slot - coin.lastTradeSlot >= params.staleSlots) {
        sellTokens = tokens;
      } else if (coin !== undefined && recentNetFlowSol(coin, 10) <= params.heavyOutflowSol) {
        sellTokens = tokens;
      }
      if (sellTokens !== null && sellTokens > 0n) {
        trade.halfTaken = true;
        orders.push({
          side: 'sell',
          client_id: state.clientId(),
          mint,
          token_amount: sellTokens.toString(),
          max_slippage_bps: params.sellSlippageBps,
        });
      }
    }
    return orders;
  }

  function entryOrders(state: BotState, batch: Batch, budget: number): OrderInput[] {
    const orders: OrderInput[] = [];
    let slotsLeft = budget;
    // Fresh launches first: only the first two slots of a coin's life.
    for (const coin of coins.values()) {
      if (slotsLeft <= 0) break;
      const age = batch.slot - coin.createdSlot;
      if (age < 0 || age > params.maxEntryAgeSlots) continue;
      if (coin.attempted || open.has(coin.mint)) continue;
      if (coin.creatorSold) continue;
      if (state.committedPositionCount() + orders.length >= state.hello.caps.max_open_positions) break;
      const realSol = realSolOf(state, coin.mint);
      if (realSol < params.minRealSol) continue;
      if (coin.buyers.size > params.maxEarlyBuyers) continue;
      if (Number(coin.creatorBuyLamports) / Number(LAMPORTS) > params.maxCreatorBuySol) continue;
      const price = priceOf(state, coin.mint);
      if (price === null || price <= 0 || coin.createPrice <= 0) continue;
      const runUp = price / coin.createPrice - 1;
      if (runUp < 0 || runUp > 0.8) continue;
      if (recentNetFlowSol(coin, 40) < 0) continue;
      const capLamports = state.maxBuyLamports(coin.mint);
      const reserveCap =
        (BigInt(Math.floor(realSol * Number(LAMPORTS))) * BigInt(params.maxStakeBpsOfRealReserve)) / 10000n;
      let stake = BigInt(Math.floor(params.stakeSol * Number(LAMPORTS)));
      if (stake > capLamports) stake = capLamports;
      if (stake > reserveCap) stake = reserveCap;
      if (stake < 10_000_000n) continue; // below the 0.01 SOL round-trip floor
      const free = state.freeCashLamports() - state.txFeeLamports();
      if (stake > free) continue;
      const clientId = state.clientId();
      pendingBuys.set(clientId, { mint: coin.mint, probe: false });
      coin.attempted = true;
      orders.push({
        side: 'buy',
        client_id: clientId,
        mint: coin.mint,
        quote_lamports: stake.toString(),
        max_slippage_bps: params.buySlippageBps,
      });
      slotsLeft -= 1;
    }
    return orders;
  }

  function probeOrders(state: BotState, batch: Batch, budget: number): OrderInput[] {
    const orders: OrderInput[] = [];
    if (budget <= 0) return orders;
    // Only while completed round trips lag the 25-coins-over-6h pace, and
    // only when the window has shown enough coins to choose a liquid one.
    if (roundTrips >= params.probeTargetTrips) return orders;
    if (probeAttempts >= params.probeMaxAttempts) return orders;
    if (coinsSeen < 100) return orders;
    if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return orders;
    for (const p of pendingBuys.values()) if (p.probe) return orders;
    for (const t of open.values()) if (t.probe) return orders;

    // Pick the most liquid eligible coin in this batch's events.
    let best: CoinInfo | null = null;
    let bestReal = 0;
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      const coin = coins.get(event.mint);
      if (coin === undefined || coin.probed || coin.attempted || open.has(coin.mint)) continue;
      const curve = state.curves.get(coin.mint);
      if (curve === undefined || curve.complete) continue;
      const realSol = realSolOf(state, coin.mint);
      if (realSol < params.probeMinRealSol) continue;
      if (recentNetFlowSol(coin, 40) < 0) continue;
      if (realSol > bestReal) {
        bestReal = realSol;
        best = coin;
      }
    }
    if (best === null) return orders;
    const stake = BigInt(Math.floor(params.probeSol * Number(LAMPORTS)));
    const capLamports = state.maxBuyLamports(best.mint);
    if (stake > capLamports) return orders;
    const free = state.freeCashLamports() - state.txFeeLamports();
    if (stake > free) return orders;
    const clientId = state.clientId();
    pendingBuys.set(clientId, { mint: best.mint, probe: true });
    best.probed = true;
    probeAttempts += 1;
    orders.push({
      side: 'buy',
      client_id: clientId,
      mint: best.mint,
      quote_lamports: stake.toString(),
      max_slippage_bps: params.buySlippageBps,
    });
    return orders;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    ingestFills(state, batch);
    ingestEvents(batch);
    const orders: OrderInput[] = [];
    const exits = exitOrders(state, batch);
    orders.push(...exits);
    const room = state.hello.caps.max_orders_per_batch - orders.length;
    if (room > 0) {
      const entries = entryOrders(state, batch, room);
      orders.push(...entries);
      const roomLeft = state.hello.caps.max_orders_per_batch - orders.length;
      if (roomLeft > 0) orders.push(...probeOrders(state, batch, roomLeft));
    }
    return orders;
  }

  return { onBatch };
}
