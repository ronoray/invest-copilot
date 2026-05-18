import prisma from './prisma.js';
import logger from './logger.js';

// ─── Equity Curve ───────────────────────────────────────────────────────────

/**
 * Build equity curve for a portfolio.
 * Priority: PortfolioSnapshot records → DailyTarget.earnedActual → Trade history fallback
 */
export async function getEquityCurve(portfolioId) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { capitalHistory: { orderBy: { createdAt: 'asc' } } }
  });
  if (!portfolio) throw new Error('Portfolio not found');

  const startingCapital = portfolio.startingCapital;

  // 1. Try PortfolioSnapshot (most accurate going forward)
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { portfolioId },
    orderBy: { date: 'asc' }
  });

  if (snapshots.length > 0) {
    return {
      source: 'snapshots',
      startingCapital,
      points: snapshots.map(s => ({
        date: s.date.toISOString().split('T')[0],
        equity: s.currentEquity,
        realizedPnl: s.realizedPnl,
        unrealizedPnl: s.unrealizedPnl,
        cashBalance: s.cashBalance,
        peakEquity: s.peakEquity,
        drawdownPct: s.drawdownPct,
      }))
    };
  }

  // 2. Build from DailyTarget.earnedActual (user-entered daily earnings)
  const dailyTargets = await prisma.dailyTarget.findMany({
    where: { portfolioId, earnedActual: { not: 0 } },
    orderBy: { date: 'asc' }
  });

  if (dailyTargets.length > 0) {
    let runningEquity = startingCapital;
    let peakEquity = startingCapital;
    const points = dailyTargets.map(dt => {
      runningEquity += dt.earnedActual;
      if (runningEquity > peakEquity) peakEquity = runningEquity;
      const drawdownPct = peakEquity > 0
        ? ((runningEquity - peakEquity) / peakEquity) * 100
        : 0;
      return {
        date: dt.date.toISOString().split('T')[0],
        equity: runningEquity,
        realizedPnl: runningEquity - startingCapital,
        unrealizedPnl: 0,
        cashBalance: null,
        peakEquity,
        drawdownPct,
      };
    });
    return { source: 'daily_targets', startingCapital, points };
  }

  // 3. Build from Trade records (SELL trades with profit)
  const trades = await prisma.trade.findMany({
    where: { portfolioId, type: 'SELL', status: 'COMPLETED' },
    orderBy: { executedAt: 'asc' }
  });

  if (trades.length > 0) {
    let runningPnl = 0;
    let peakEquity = startingCapital;
    const points = [];
    for (const t of trades) {
      runningPnl += t.profit || 0;
      const equity = startingCapital + runningPnl;
      if (equity > peakEquity) peakEquity = equity;
      const drawdownPct = peakEquity > 0
        ? ((equity - peakEquity) / peakEquity) * 100
        : 0;
      points.push({
        date: t.executedAt.toISOString().split('T')[0],
        equity,
        realizedPnl: runningPnl,
        unrealizedPnl: 0,
        cashBalance: null,
        peakEquity,
        drawdownPct,
      });
    }
    return { source: 'trades', startingCapital, points };
  }

  // 4. No data — return just today with starting capital
  return {
    source: 'none',
    startingCapital,
    points: [{
      date: new Date().toISOString().split('T')[0],
      equity: startingCapital,
      realizedPnl: 0,
      unrealizedPnl: 0,
      cashBalance: portfolio.availableCash,
      peakEquity: startingCapital,
      drawdownPct: 0,
    }]
  };
}

// ─── Summary Metrics ─────────────────────────────────────────────────────────

export async function getSummaryMetrics(portfolioId) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });
  if (!portfolio) throw new Error('Portfolio not found');

  const startingCapital = portfolio.startingCapital;

  // Realized P&L from SELL trades
  const sellTrades = await prisma.trade.findMany({
    where: { portfolioId, type: 'SELL', status: 'COMPLETED' }
  });
  const realizedPnl = sellTrades.reduce((sum, t) => sum + (t.profit || 0), 0);

  // Unrealized P&L from current holdings
  let investedValue = 0;
  let currentHoldingsValue = 0;
  for (const h of portfolio.holdings) {
    const cost = h.quantity * h.avgPrice;
    const current = h.quantity * (h.currentPrice || h.avgPrice);
    investedValue += cost;
    currentHoldingsValue += current;
  }
  const unrealizedPnl = currentHoldingsValue - investedValue;
  const totalPnl = realizedPnl + unrealizedPnl;
  const currentEquity = startingCapital + realizedPnl + unrealizedPnl;
  const returnPct = startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0;

  // Trade stats
  const allTrades = await prisma.trade.findMany({
    where: { portfolioId, type: 'SELL', status: 'COMPLETED' }
  });
  const wins = allTrades.filter(t => (t.profit || 0) > 0);
  const losses = allTrades.filter(t => (t.profit || 0) < 0);
  const winRate = allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0;
  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + (t.profit || 0), 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((s, t) => s + (t.profit || 0), 0) / losses.length
    : 0;

  const grossProfit = wins.reduce((s, t) => s + (t.profit || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.profit || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const winRateFraction = winRate / 100;
  const lossRateFraction = 1 - winRateFraction;
  const expectancy = (winRateFraction * avgWin) + (lossRateFraction * avgLoss);

  // Max drawdown
  const { maxDrawdown, currentDrawdown } = await computeDrawdown(portfolioId, startingCapital);

  // Signal stats
  const signals = await prisma.tradeSignal.findMany({
    where: { portfolioId, outcome: { not: null } }
  });
  const winSignals = signals.filter(s => s.outcome === 'PROFIT');
  const signalAccuracy = signals.length > 0
    ? (winSignals.length / signals.length) * 100
    : null;

  // Best/worst trade
  const bestTrade = allTrades.length > 0
    ? allTrades.reduce((a, b) => ((a.profit || 0) > (b.profit || 0) ? a : b))
    : null;
  const worstTrade = allTrades.length > 0
    ? allTrades.reduce((a, b) => ((a.profit || 0) < (b.profit || 0) ? a : b))
    : null;

  // Consecutive losses
  const sortedTrades = [...allTrades].sort(
    (a, b) => new Date(a.executedAt) - new Date(b.executedAt)
  );
  let maxConsecLosses = 0;
  let consecLosses = 0;
  for (const t of sortedTrades) {
    if ((t.profit || 0) < 0) {
      consecLosses++;
      if (consecLosses > maxConsecLosses) maxConsecLosses = consecLosses;
    } else {
      consecLosses = 0;
    }
  }

  return {
    startingCapital,
    currentEquity: round2(currentEquity),
    netPnl: round2(totalPnl),
    returnPct: round2(returnPct),
    realizedPnl: round2(realizedPnl),
    unrealizedPnl: round2(unrealizedPnl),
    investedValue: round2(investedValue),
    cashBalance: round2(portfolio.availableCash),
    maxDrawdown: round2(maxDrawdown),
    currentDrawdown: round2(currentDrawdown),
    winRate: round2(winRate),
    lossRate: round2(100 - winRate),
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    profitFactor: round2(profitFactor),
    expectancy: round2(expectancy),
    totalTrades: allTrades.length,
    winCount: wins.length,
    lossCount: losses.length,
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    bestTrade: bestTrade
      ? { symbol: bestTrade.symbol, profit: round2(bestTrade.profit || 0), date: bestTrade.executedAt }
      : null,
    worstTrade: worstTrade
      ? { symbol: worstTrade.symbol, profit: round2(worstTrade.profit || 0), date: worstTrade.executedAt }
      : null,
    maxConsecutiveLosses: maxConsecLosses,
    signalAccuracy: signalAccuracy !== null ? round2(signalAccuracy) : null,
    totalSignals: signals.length,
  };
}

// ─── Drawdown ─────────────────────────────────────────────────────────────────

async function computeDrawdown(portfolioId, startingCapital) {
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: { portfolioId },
    orderBy: { date: 'asc' }
  });

  if (snapshots.length > 0) {
    const maxDrawdown = Math.min(...snapshots.map(s => s.drawdownPct));
    const current = snapshots[snapshots.length - 1];
    return { maxDrawdown, currentDrawdown: current.drawdownPct };
  }

  // Fallback: from trade history
  const trades = await prisma.trade.findMany({
    where: { portfolioId, type: 'SELL', status: 'COMPLETED' },
    orderBy: { executedAt: 'asc' }
  });

  let peak = startingCapital;
  let equity = startingCapital;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.profit || 0;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
    if (dd < maxDD) maxDD = dd;
  }
  const currentDD = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
  return { maxDrawdown: maxDD, currentDrawdown: currentDD };
}

// ─── Monthly P&L ─────────────────────────────────────────────────────────────

export async function getMonthlyPnl(portfolioId) {
  const trades = await prisma.trade.findMany({
    where: { portfolioId, type: 'SELL', status: 'COMPLETED' },
    orderBy: { executedAt: 'asc' }
  });

  const monthly = {};
  for (const t of trades) {
    const key = t.executedAt.toISOString().substring(0, 7); // "YYYY-MM"
    monthly[key] = (monthly[key] || 0) + (t.profit || 0);
  }

  // Also pull from DailyTarget for more granular data
  const dailyTargets = await prisma.dailyTarget.findMany({
    where: { portfolioId, earnedActual: { not: 0 } },
    orderBy: { date: 'asc' }
  });
  const dtMonthly = {};
  for (const dt of dailyTargets) {
    const key = dt.date.toISOString().substring(0, 7);
    dtMonthly[key] = (dtMonthly[key] || 0) + dt.earnedActual;
  }

  // Merge — prefer DailyTarget data if available for month
  const allKeys = new Set([...Object.keys(monthly), ...Object.keys(dtMonthly)]);
  const result = Array.from(allKeys).sort().map(month => ({
    month,
    pnl: round2(dtMonthly[month] || monthly[month] || 0),
    source: dtMonthly[month] !== undefined ? 'daily_targets' : 'trades',
  }));

  return result;
}

// ─── Trade Journal ─────────────────────────────────────────────────────────

export async function getTradeJournal(portfolioId, filters = {}) {
  const { symbol, type, dateFrom, dateTo, page = 1, pageSize = 50 } = filters;

  const where = { portfolioId };
  if (symbol) where.symbol = { contains: symbol.toUpperCase() };
  if (type) where.type = type;
  if (dateFrom || dateTo) {
    where.executedAt = {};
    if (dateFrom) where.executedAt.gte = new Date(dateFrom);
    if (dateTo) where.executedAt.lte = new Date(dateTo);
  }

  const [trades, total] = await Promise.all([
    prisma.trade.findMany({
      where,
      orderBy: { executedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.trade.count({ where })
  ]);

  return {
    trades: trades.map(t => ({
      id: t.id,
      symbol: t.symbol,
      exchange: t.exchange,
      type: t.type,
      quantity: t.quantity,
      price: t.price,
      fees: t.fees,
      profit: t.type === 'SELL' ? t.profit : null,
      profitPct: t.type === 'SELL' && t.profit
        ? round2((t.profit / (t.price * t.quantity)) * 100)
        : null,
      executedAt: t.executedAt,
      source: t.source,
      notes: t.notes,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ─── Signal Quality ──────────────────────────────────────────────────────────

export async function getSignalQuality(portfolioId) {
  const signals = await prisma.tradeSignal.findMany({
    where: { portfolioId },
    orderBy: { createdAt: 'desc' }
  });

  const total = signals.length;
  const withOutcome = signals.filter(s => s.outcome !== null);
  const wins = withOutcome.filter(s => s.outcome === 'PROFIT');
  const losses = withOutcome.filter(s => s.outcome === 'LOSS');
  const executed = signals.filter(s => s.status === 'EXECUTED');
  const dismissed = signals.filter(s => s.status === 'DISMISSED');

  // Confidence vs outcome breakdown
  const highConf = withOutcome.filter(s => s.confidence >= 70);
  const medConf = withOutcome.filter(s => s.confidence >= 40 && s.confidence < 70);
  const lowConf = withOutcome.filter(s => s.confidence < 40);

  const confVsOutcome = [
    { band: 'High (70-100)', total: highConf.length, wins: highConf.filter(s => s.outcome === 'PROFIT').length },
    { band: 'Medium (40-69)', total: medConf.length, wins: medConf.filter(s => s.outcome === 'PROFIT').length },
    { band: 'Low (<40)', total: lowConf.length, wins: lowConf.filter(s => s.outcome === 'PROFIT').length },
  ];

  // Total realized PnL from signals
  const totalSignalPnl = withOutcome.reduce((s, sig) => s + (sig.realizedPnl || 0), 0);

  return {
    total,
    executed: executed.length,
    dismissed: dismissed.length,
    withOutcome: withOutcome.length,
    wins: wins.length,
    losses: losses.length,
    accuracy: withOutcome.length > 0 ? round2((wins.length / withOutcome.length) * 100) : null,
    totalSignalPnl: round2(totalSignalPnl),
    confVsOutcome,
    recentSignals: signals.slice(0, 20).map(s => ({
      id: s.id,
      symbol: s.symbol,
      side: s.side,
      confidence: s.confidence,
      status: s.status,
      outcome: s.outcome,
      realizedPnl: s.realizedPnl,
      executedPrice: s.executedPrice,
      exitPrice: s.exitPrice,
      createdAt: s.createdAt,
    })),
  };
}

// ─── Snapshots (create / backfill) ───────────────────────────────────────────

/**
 * Create a snapshot for today. Called manually or by cron.
 */
export async function createTodaySnapshot(portfolioId) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });
  if (!portfolio) throw new Error('Portfolio not found');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Realized P&L
  const sellTrades = await prisma.trade.findMany({
    where: { portfolioId, type: 'SELL', status: 'COMPLETED' }
  });
  const realizedPnl = sellTrades.reduce((s, t) => s + (t.profit || 0), 0);

  // Holdings
  let investedValue = 0;
  let currentHoldingsValue = 0;
  for (const h of portfolio.holdings) {
    investedValue += h.quantity * h.avgPrice;
    currentHoldingsValue += h.quantity * (h.currentPrice || h.avgPrice);
  }
  const unrealizedPnl = currentHoldingsValue - investedValue;
  const currentEquity = portfolio.startingCapital + realizedPnl + unrealizedPnl;
  const cashBalance = portfolio.availableCash;

  // Compute high-water mark
  const prevSnapshots = await prisma.portfolioSnapshot.findMany({
    where: { portfolioId },
    orderBy: { date: 'asc' }
  });
  const prevPeak = prevSnapshots.length > 0
    ? Math.max(...prevSnapshots.map(s => s.peakEquity))
    : portfolio.startingCapital;
  const peakEquity = Math.max(prevPeak, currentEquity);
  const drawdownPct = peakEquity > 0 ? ((currentEquity - peakEquity) / peakEquity) * 100 : 0;

  return prisma.portfolioSnapshot.upsert({
    where: { portfolioId_date: { portfolioId, date: today } },
    create: {
      portfolioId,
      date: today,
      startingCapital: portfolio.startingCapital,
      currentEquity,
      investedValue,
      cashBalance,
      realizedPnl,
      unrealizedPnl,
      peakEquity,
      drawdownPct,
    },
    update: {
      currentEquity,
      investedValue,
      cashBalance,
      realizedPnl,
      unrealizedPnl,
      peakEquity,
      drawdownPct,
    }
  });
}

// ─── Learning Ledger ─────────────────────────────────────────────────────────

export async function getLearningLedger(portfolioId) {
  const [mistakes, rules] = await Promise.all([
    prisma.mistakeLog.findMany({
      where: { portfolioId },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.learningRule.findMany({
      where: { portfolioId },
      orderBy: { createdAt: 'desc' }
    })
  ]);

  // Mistake category breakdown
  const categoryCount = {};
  for (const m of mistakes) {
    categoryCount[m.mistakeCategory] = (categoryCount[m.mistakeCategory] || 0) + 1;
  }
  const topMistakes = Object.entries(categoryCount)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));

  const totalLoss = mistakes.reduce((s, m) => s + (m.pnlImpact || 0), 0);

  return {
    mistakes,
    rules,
    topMistakes,
    totalMistakeLoss: round2(totalLoss),
    implementedRules: rules.filter(r => r.status === 'ACTIVE').length,
    pendingRules: rules.filter(r => r.status === 'PROPOSED').length,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(n) {
  if (!isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
