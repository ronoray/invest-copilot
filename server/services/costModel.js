/**
 * costModel.js — Single source of truth for Indian equity transaction costs
 * and realized-P&L reconstruction from actual broker fills.
 *
 * WHY THIS EXISTS:
 *   The system traded ~₹4.1L turnover on a ₹20k account with ZERO cost awareness.
 *   A FIFO backtest of the real fills showed costs (₹3,415) turned a −₹647 gross
 *   result into −₹4,062 net — friction was 5× the gross loss. No signal was ever
 *   cost-gated. This module makes cost the first-class citizen it must be.
 *
 * SCOPE: Upstox CNC (equity delivery), NSE cash segment, FY2025-26 rates.
 *   - Brokerage: ₹20/order or 0.0025×value, whichever LOWER (Upstox delivery plan)
 *   - STT:       0.1% on BOTH buy and sell (delivery)
 *   - Exchange:  0.00297% (NSE txn charge)
 *   - SEBI:      0.0001% (₹10/crore)
 *   - Stamp:     0.015% on BUY only
 *   - GST:       18% on (brokerage + exchange + SEBI)
 *   - DP charge: ₹18.5 + GST ≈ ₹21.83 per SELL (per scrip/day; approximated per sell order)
 *
 * These are deliberately slightly conservative (real cost ≥ modelled). Tune the
 * RATES object if the Upstox plan changes — do NOT scatter cost math elsewhere.
 */

export const RATES = {
  brokerageFlat: 20.0,      // ₹ per order cap (Upstox delivery: min of ₹20 or 2.5%)
  brokeragePct: 0.025,      // 2.5%
  stt: 0.001,               // 0.1% both sides (delivery)
  exchange: 0.0000297,      // 0.00297%
  sebi: 0.000001,           // 0.0001%
  stampBuy: 0.00015,        // 0.015% buy only
  gst: 0.18,                // 18% on brokerage+exchange+sebi
  dpPerSell: 18.5 * 1.18,   // ₹21.83 per sell (DP debit + GST)
};

/**
 * Total transaction cost for a single order.
 * @param {number} value  order value = quantity × price
 * @param {'buy'|'sell'} side
 * @returns {number} cost in ₹
 */
export function orderCost(value, side) {
  if (!value || value <= 0) return 0;
  const s = String(side).toLowerCase();
  const brokerage = Math.min(RATES.brokerageFlat, RATES.brokeragePct * value);
  const stt = RATES.stt * value;
  const exchange = RATES.exchange * value;
  const sebi = RATES.sebi * value;
  const stamp = s === 'buy' ? RATES.stampBuy * value : 0;
  const gst = RATES.gst * (brokerage + exchange + sebi);
  const dp = s === 'sell' ? RATES.dpPerSell : 0;
  return brokerage + stt + exchange + sebi + stamp + gst + dp;
}

/**
 * Round-trip cost for a position of given value (buy then sell at ~same value).
 * Use this to cost-gate a signal: expected gross profit must exceed this.
 * @param {number} positionValue
 */
export function roundTripCost(positionValue) {
  return orderCost(positionValue, 'buy') + orderCost(positionValue, 'sell');
}

/**
 * Reconstruct realized P&L from actual broker fills using FIFO matching.
 * @param {Array<{symbol:string, side:string, quantity:number, price:number, date?:Date}>} fills
 *        Must be pre-sorted by time ascending for correct FIFO.
 * @returns {{
 *   grossPnl:number, totalCosts:number, netPnl:number,
 *   trips:Array, leftover:Array,
 *   buyTurnover:number, sellTurnover:number,
 *   wins:number, losses:number, winRate:number, profitFactor:number,
 *   avgWin:number, avgLoss:number, expectancy:number, tripCount:number
 * }}
 */
export function fifoRealized(fills) {
  const lots = new Map();   // symbol -> array of [qty, price]
  const trips = [];
  let totalCosts = 0;
  let buyTurnover = 0, sellTurnover = 0;

  for (const f of fills) {
    const qty = Number(f.quantity);
    const price = Number(f.price);
    if (!qty || qty <= 0 || !price || price <= 0) continue;
    const side = String(f.side).toLowerCase();
    const value = qty * price;
    totalCosts += orderCost(value, side);

    if (side === 'buy') {
      buyTurnover += value;
      if (!lots.has(f.symbol)) lots.set(f.symbol, []);
      lots.get(f.symbol).push([qty, price]);
    } else if (side === 'sell') {
      sellTurnover += value;
      let rem = qty;
      const q = lots.get(f.symbol) || [];
      while (rem > 0 && q.length > 0) {
        const lot = q[0];
        const m = Math.min(rem, lot[0]);
        trips.push({
          symbol: f.symbol, qty: m, buyPrice: lot[1], sellPrice: price,
          gross: (price - lot[1]) * m, date: f.date || null,
        });
        lot[0] -= m; rem -= m;
        if (lot[0] === 0) q.shift();
      }
      // rem > 0 → sold more than recorded buys (buy happened off-platform); ignore unmatched
    }
  }

  const grossPnl = trips.reduce((s, t) => s + t.gross, 0);
  const wins = trips.filter(t => t.gross > 0);
  const losses = trips.filter(t => t.gross < 0);
  const gw = wins.reduce((s, t) => s + t.gross, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.gross, 0));
  const tripCount = trips.length;

  const leftover = [];
  for (const [sym, q] of lots.entries()) {
    const qty = q.reduce((s, l) => s + l[0], 0);
    if (qty > 0) leftover.push({ symbol: sym, qty, costBasis: q.reduce((s, l) => s + l[0] * l[1], 0) });
  }

  return {
    grossPnl, totalCosts, netPnl: grossPnl - totalCosts,
    trips, leftover, buyTurnover, sellTurnover,
    wins: wins.length, losses: losses.length,
    winRate: tripCount ? (wins.length / tripCount) * 100 : 0,
    profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    avgWin: wins.length ? gw / wins.length : 0,
    avgLoss: losses.length ? -gl / losses.length : 0,
    expectancy: tripCount ? (grossPnl - totalCosts) / tripCount : 0,
    tripCount,
  };
}

export default { RATES, orderCost, roundTripCost, fifoRealized };
