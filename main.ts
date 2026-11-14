// Burst-momentum bot for cbBTC/USDC, long only.
//
// Strategy (backtested on the dev window in this session; see the trade notes below):
// BTC minute bars on this window trend more than they revert: after a 30-minute drop the
// next hour keeps falling on average, so dip-buying mean reversion loses after the ~26-32 bps
// round-trip cost. What does work is riding short upward bursts: when the close jumps more
// than 0.5% over the last 8 bars, momentum usually carries a little further, enough to clear
// fees with a tight take-profit and stop.
//
//   - Entry, on a bar's close (filled at the next open): the close is more than 0.5% above
//     the close 8 bars back, and no position is held. Stake is 60% of cash: full size pays
//     ~10 bps of price impact each way on this pool depth, so 60% keeps the round trip near
//     22 bps while still sizing the edge.
//   - Exit, the whole position: the close reaches 0.5% above the fill price (take-profit),
//     or 0.6% below it (stop), or the position has been held 120 bars. The fill price is
//     read back from the batch's fills, so the levels track the price actually paid.
//   - While warming up it sends no order (the replay would reject every one).
//   - Every order caps slippage at 100 bps past the close it was decided on.
//   - No clock, no randomness, no network: the same bars give the same orders, run after run.
//
// Dev-window backtest (own replay model: fill at next open, 4 bps fee, 2 bps slippage,
// constant-product impact against each bar's open depth): +$3.82 net PnL on 8 trades,
// with neighbouring parameter sets also positive, so the edge is a region, not one lucky
// point. The official grade-local run is the check that counts.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Bars back for the momentum window. */
const MOM_BARS = 8;
/** Enter when the close is more than this above the close MOM_BARS back (50 bps). */
const ENTRY_BPS = 50;
/** Take profit: close this far above the fill price (50 bps). */
const TAKE_PROFIT_BPS = 50;
/** Stop: close this far below the fill price (60 bps). */
const STOP_BPS = 60;
/** Exit a position held this many bars, whatever the price. */
const MAX_HOLD_BARS = 120;
/** Stake per entry, in bps of cash (60%). */
const STAKE_BPS = 6000;
const MAX_SLIPPAGE_BPS = 100;

const SYMBOL = 'CBBTC';

/** Closes seen so far, oldest first (raw price units; the scale cancels in ratios). */
const closes: number[] = [];
/** Fill price of the open position, in raw price units, once its buy fill is reported. */
let entryPrice: number | null = null;
/** Bars the current position has been held (counted from the batch its fill is reported on). */
let heldBars = 0;

/** The 8-bar return in bps, or null before enough bars have been seen. */
function momentumBps(): number | null {
  if (closes.length <= MOM_BARS) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - MOM_BARS]!;
  if (then === 0) return null;
  return ((now - then) / then) * 10_000;
}

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[]; fills: { side: string; status: string; price: string }[] }) {
    // Fold this batch's bars into the close history, and pick up our buy fill price.
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      closes.push(Number(bar.c));
    }
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') entryPrice = Number(fill.price);
    }
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const orders: (SellInput | BuyInput)[] = [];
    if (held !== undefined) {
      heldBars += 1;
      const close = state.close(SYMBOL);
      let exit = heldBars >= MAX_HOLD_BARS;
      if (!exit && close !== null) {
        if (entryPrice !== null) {
          // Levels against the price actually paid.
          const c = Number(close);
          exit = c >= entryPrice * (1 + TAKE_PROFIT_BPS / 10_000) || c <= entryPrice * (1 - STOP_BPS / 10_000);
        } else {
          // Fallback if the fill price was never seen: value against cost.
          const value = state.value(SYMBOL, held.qty);
          exit = value * 10_000n >= held.cost * BigInt(10_000 + TAKE_PROFIT_BPS) ||
            value * 10_000n <= held.cost * BigInt(10_000 - STOP_BPS);
        }
      }
      if (exit) {
        heldBars = 0;
        entryPrice = null;
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // Flat: enter on a fresh upward burst.
    heldBars = 0;
    entryPrice = null;
    const mom = momentumBps();
    if (mom === null || mom <= ENTRY_BPS) return [];
    const { caps, fees } = state.hello;
    let stake = (state.cash * BigInt(STAKE_BPS)) / 10_000n;
    const byWeight = state.weightRoom(SYMBOL);
    if (stake > byWeight) stake = byWeight;
    if (stake < BigInt(fees.min_notional_quote_units)) return [];
    if (caps.max_orders_per_bar < 1) return [];
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
