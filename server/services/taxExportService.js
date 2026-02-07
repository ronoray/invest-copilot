import ExcelJS from 'exceljs';
import prisma from './prisma.js';
import logger from './logger.js';

/**
 * Generate GST-compliant tax report as Excel workbook
 * @param {number} userId
 * @param {string} financialYear - e.g. "2025" means FY 2025-26 (April 2025 - March 2026)
 * @returns {ExcelJS.Workbook}
 */
export async function generateTaxReport(userId, financialYear) {
  const year = parseInt(financialYear);
  const fyStart = new Date(year, 3, 1); // April 1
  const fyEnd = new Date(year + 1, 2, 31, 23, 59, 59); // March 31

  logger.info(`Generating tax report for user ${userId}, FY ${year}-${year + 1}`);

  // Fetch all trades in the financial year
  const trades = await prisma.trade.findMany({
    where: {
      portfolio: { userId },
      executedAt: { gte: fyStart, lte: fyEnd }
    },
    include: {
      portfolio: { select: { name: true, broker: true, ownerName: true } }
    },
    orderBy: { executedAt: 'asc' }
  });

  // Fetch current holdings
  const holdings = await prisma.holding.findMany({
    where: { portfolio: { userId } },
    include: {
      portfolio: { select: { name: true, broker: true } }
    },
    orderBy: { symbol: 'asc' }
  });

  // Fetch portfolios for summary
  const portfolios = await prisma.portfolio.findMany({
    where: { userId, isActive: true },
    include: { holdings: true }
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Investment Co-Pilot';
  workbook.created = new Date();

  // ========== Sheet 1: All Trades ==========
  const tradesSheet = workbook.addWorksheet('All Trades');

  tradesSheet.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Portfolio', key: 'portfolio', width: 25 },
    { header: 'Symbol', key: 'symbol', width: 12 },
    { header: 'Exchange', key: 'exchange', width: 8 },
    { header: 'Type', key: 'type', width: 6 },
    { header: 'Qty', key: 'quantity', width: 8 },
    { header: 'Price', key: 'price', width: 12 },
    { header: 'Fees', key: 'fees', width: 10 },
    { header: 'Total Value', key: 'totalValue', width: 14 },
    { header: 'P&L', key: 'profit', width: 12 },
    { header: 'Tax Type', key: 'taxType', width: 10 },
    { header: 'Source', key: 'source', width: 12 }
  ];

  // Style header row
  styleHeaderRow(tradesSheet);

  trades.forEach(trade => {
    const holdingMonths = trade.type === 'SELL'
      ? Math.floor((new Date(trade.executedAt) - new Date(trade.createdAt)) / (30.44 * 24 * 60 * 60 * 1000))
      : null;
    const taxType = holdingMonths !== null ? (holdingMonths >= 12 ? 'LTCG' : 'STCG') : '—';

    tradesSheet.addRow({
      date: new Date(trade.executedAt).toLocaleDateString('en-IN'),
      portfolio: trade.portfolio?.name || 'Unknown',
      symbol: trade.symbol,
      exchange: trade.exchange,
      type: trade.type,
      quantity: trade.quantity,
      price: trade.price,
      fees: trade.fees || 0,
      totalValue: trade.quantity * trade.price,
      profit: trade.profit || 0,
      taxType,
      source: trade.source
    });
  });

  // ========== Sheet 2: Portfolio Summary ==========
  const summarySheet = workbook.addWorksheet('Portfolio Summary');

  summarySheet.columns = [
    { header: 'Portfolio', key: 'portfolio', width: 25 },
    { header: 'Owner', key: 'owner', width: 20 },
    { header: 'Broker', key: 'broker', width: 18 },
    { header: 'Starting Capital', key: 'startingCapital', width: 18 },
    { header: 'Invested', key: 'invested', width: 16 },
    { header: 'Current Value', key: 'currentValue', width: 16 },
    { header: 'Available Cash', key: 'availableCash', width: 16 },
    { header: 'P&L', key: 'pl', width: 14 },
    { header: 'P&L %', key: 'plPercent', width: 10 },
    { header: 'Holdings Count', key: 'holdingsCount', width: 14 }
  ];

  styleHeaderRow(summarySheet);

  portfolios.forEach(p => {
    const invested = p.holdings.reduce((sum, h) => sum + (h.quantity * Number(h.avgPrice)), 0);
    const current = p.holdings.reduce((sum, h) => sum + (h.quantity * Number(h.currentPrice || h.avgPrice)), 0);
    const pl = current - invested;
    const plPercent = invested > 0 ? ((pl / invested) * 100).toFixed(2) : 0;

    summarySheet.addRow({
      portfolio: p.name,
      owner: p.ownerName,
      broker: p.broker,
      startingCapital: parseFloat(p.startingCapital),
      invested,
      currentValue: current,
      availableCash: parseFloat(p.availableCash),
      pl,
      plPercent: `${plPercent}%`,
      holdingsCount: p.holdings.length
    });
  });

  // ========== Sheet 3: Tax Summary (STCG/LTCG) ==========
  const taxSheet = workbook.addWorksheet('Tax Summary');

  // Calculate STCG and LTCG from sell trades
  let totalSTCG = 0;
  let totalLTCG = 0;

  const sellTrades = trades.filter(t => t.type === 'SELL' && t.profit);
  sellTrades.forEach(trade => {
    const holdingMonths = Math.floor(
      (new Date(trade.executedAt) - new Date(trade.createdAt)) / (30.44 * 24 * 60 * 60 * 1000)
    );
    if (holdingMonths >= 12) {
      totalLTCG += trade.profit;
    } else {
      totalSTCG += trade.profit;
    }
  });

  const ltcgExemptLimit = 125000;
  const taxableLTCG = Math.max(0, totalLTCG - ltcgExemptLimit);
  const ltcgTax = taxableLTCG * 0.125; // 12.5%
  const stcgTax = Math.max(0, totalSTCG) * 0.20; // 20%

  taxSheet.columns = [
    { header: 'Category', key: 'category', width: 30 },
    { header: 'Amount (INR)', key: 'amount', width: 20 }
  ];

  styleHeaderRow(taxSheet);

  const taxRows = [
    { category: 'Short Term Capital Gains (STCG)', amount: totalSTCG },
    { category: 'STCG Tax @20%', amount: stcgTax },
    { category: '', amount: '' },
    { category: 'Long Term Capital Gains (LTCG)', amount: totalLTCG },
    { category: 'LTCG Exempt (up to 1,25,000)', amount: Math.min(totalLTCG, ltcgExemptLimit) },
    { category: 'Taxable LTCG', amount: taxableLTCG },
    { category: 'LTCG Tax @12.5%', amount: ltcgTax },
    { category: '', amount: '' },
    { category: 'Total Tax Liability', amount: stcgTax + ltcgTax },
  ];

  taxRows.forEach(row => taxSheet.addRow(row));

  // Bold the total row
  const totalRow = taxSheet.lastRow;
  totalRow.font = { bold: true, size: 12 };

  // ========== Sheet 4: Quarterly Summary ==========
  const quarterlySheet = workbook.addWorksheet('Quarterly Summary');

  quarterlySheet.columns = [
    { header: 'Quarter', key: 'quarter', width: 20 },
    { header: 'Period', key: 'period', width: 25 },
    { header: 'Buy Trades', key: 'buyTrades', width: 12 },
    { header: 'Sell Trades', key: 'sellTrades', width: 12 },
    { header: 'Buy Value', key: 'buyValue', width: 16 },
    { header: 'Sell Value', key: 'sellValue', width: 16 },
    { header: 'Realized P&L', key: 'realizedPL', width: 14 },
    { header: 'STCG', key: 'stcg', width: 12 },
    { header: 'LTCG', key: 'ltcg', width: 12 }
  ];

  styleHeaderRow(quarterlySheet);

  const quarters = [
    { label: 'Q1', start: new Date(year, 3, 1), end: new Date(year, 5, 30) },
    { label: 'Q2', start: new Date(year, 6, 1), end: new Date(year, 8, 30) },
    { label: 'Q3', start: new Date(year, 9, 1), end: new Date(year, 11, 31) },
    { label: 'Q4', start: new Date(year + 1, 0, 1), end: new Date(year + 1, 2, 31) }
  ];

  quarters.forEach(q => {
    const qTrades = trades.filter(t => {
      const d = new Date(t.executedAt);
      return d >= q.start && d <= q.end;
    });

    const buyTrades = qTrades.filter(t => t.type === 'BUY');
    const sellTradesQ = qTrades.filter(t => t.type === 'SELL');
    const buyValue = buyTrades.reduce((s, t) => s + t.quantity * t.price, 0);
    const sellValue = sellTradesQ.reduce((s, t) => s + t.quantity * t.price, 0);
    const realizedPL = sellTradesQ.reduce((s, t) => s + (t.profit || 0), 0);

    let qSTCG = 0, qLTCG = 0;
    sellTradesQ.forEach(t => {
      const months = Math.floor((new Date(t.executedAt) - new Date(t.createdAt)) / (30.44 * 24 * 60 * 60 * 1000));
      if (months >= 12) qLTCG += (t.profit || 0);
      else qSTCG += (t.profit || 0);
    });

    quarterlySheet.addRow({
      quarter: q.label,
      period: `${q.start.toLocaleDateString('en-IN')} - ${q.end.toLocaleDateString('en-IN')}`,
      buyTrades: buyTrades.length,
      sellTrades: sellTradesQ.length,
      buyValue,
      sellValue,
      realizedPL,
      stcg: qSTCG,
      ltcg: qLTCG
    });
  });

  logger.info(`Tax report generated: ${trades.length} trades, ${portfolios.length} portfolios`);

  return workbook;
}

/**
 * Style the header row of a worksheet
 */
function styleHeaderRow(sheet) {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2563EB' }
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 24;
}
