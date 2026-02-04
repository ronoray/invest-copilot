import logger from './logger.js';

// Tax rules for equity (as of FY 2025-26)
const TAX_RULES = {
  LTCG: {
    holdingPeriod: 12, // months
    exemptLimit: 125000, // ₹1.25 lakh per year
    taxRate: 12.5, // 12.5% above exempt limit
  },
  STCG: {
    taxRate: 20, // 20% flat
  },
};

/**
 * Determine if holding is LTCG or STCG
 * @param {Date} purchaseDate
 * @returns {string} 'LTCG' or 'STCG'
 */
export function determineCapitalGainType(purchaseDate) {
  const months = getHoldingPeriodInMonths(purchaseDate);
  return months >= TAX_RULES.LTCG.holdingPeriod ? 'LTCG' : 'STCG';
}

/**
 * Get holding period in months
 * @param {Date} purchaseDate
 * @returns {number} months
 */
export function getHoldingPeriodInMonths(purchaseDate) {
  const now = new Date();
  const purchase = new Date(purchaseDate);
  const months = (now.getFullYear() - purchase.getFullYear()) * 12 + (now.getMonth() - purchase.getMonth());
  return months;
}

/**
 * Calculate tax on a specific trade/holding
 * @param {number} gain - Capital gain amount
 * @param {Date} purchaseDate
 * @param {number} ltcgUsed - LTCG exemption already used this FY
 * @returns {object} Tax calculation details
 */
export function calculateTaxOnTrade(gain, purchaseDate, ltcgUsed = 0) {
  const type = determineCapitalGainType(purchaseDate);
  
  if (type === 'LTCG') {
    const remainingExemption = Math.max(0, TAX_RULES.LTCG.exemptLimit - ltcgUsed);
    const exemptGain = Math.min(gain, remainingExemption);
    const taxableGain = Math.max(0, gain - exemptGain);
    const tax = (taxableGain * TAX_RULES.LTCG.taxRate) / 100;
    
    return {
      type: 'LTCG',
      gain,
      exemptGain,
      taxableGain,
      taxRate: TAX_RULES.LTCG.taxRate,
      tax: Math.round(tax),
      holdingPeriod: getHoldingPeriodInMonths(purchaseDate),
    };
  } else {
    // STCG
    const tax = (gain * TAX_RULES.STCG.taxRate) / 100;
    
    return {
      type: 'STCG',
      gain,
      exemptGain: 0,
      taxableGain: gain,
      taxRate: TAX_RULES.STCG.taxRate,
      tax: Math.round(tax),
      holdingPeriod: getHoldingPeriodInMonths(purchaseDate),
    };
  }
}

/**
 * Calculate total tax liability for all holdings
 * @param {array} holdings - Array of holdings with unrealized gains
 * @param {array} realizedTrades - Already realized trades this FY
 * @returns {object} Complete tax breakdown
 */
export function calculatePortfolioTax(holdings, realizedTrades = []) {
  // Calculate realized gains/taxes
  let ltcgRealized = 0;
  let stcgRealized = 0;
  let ltcgUsed = 0;

  realizedTrades.forEach(trade => {
    const taxCalc = calculateTaxOnTrade(trade.gain, trade.purchaseDate, ltcgUsed);
    if (taxCalc.type === 'LTCG') {
      ltcgRealized += taxCalc.gain;
      ltcgUsed += taxCalc.exemptGain;
    } else {
      stcgRealized += taxCalc.gain;
    }
  });

  // Calculate unrealized gains/taxes
  let ltcgUnrealized = 0;
  let stcgUnrealized = 0;
  let ltcgTaxIfRealized = 0;
  let stcgTaxIfRealized = 0;

  const holdingsWithTax = holdings.map(holding => {
    const gain = holding.currentValue - holding.investedValue;
    const taxCalc = calculateTaxOnTrade(gain, holding.purchaseDate, ltcgUsed);
    
    if (taxCalc.type === 'LTCG') {
      ltcgUnrealized += gain;
      ltcgTaxIfRealized += taxCalc.tax;
    } else {
      stcgUnrealized += gain;
      stcgTaxIfRealized += taxCalc.tax;
    }

    return {
      ...holding,
      taxInfo: taxCalc,
    };
  });

  // Tax optimization opportunities
  const opportunities = findTaxOptimizationOpportunities(holdingsWithTax, ltcgUsed);

  return {
    ltcg: {
      realized: ltcgRealized,
      unrealized: ltcgUnrealized,
      exemptLimit: TAX_RULES.LTCG.exemptLimit,
      exemptUsed: ltcgUsed,
      exemptRemaining: Math.max(0, TAX_RULES.LTCG.exemptLimit - ltcgUsed),
      taxIfRealized: ltcgTaxIfRealized,
    },
    stcg: {
      realized: stcgRealized,
      unrealized: stcgUnrealized,
      taxRate: TAX_RULES.STCG.taxRate,
      taxIfRealized: stcgTaxIfRealized,
    },
    totalTaxLiability: ltcgTaxIfRealized + stcgTaxIfRealized,
    holdings: holdingsWithTax,
    opportunities,
  };
}

/**
 * Find tax optimization opportunities
 * @param {array} holdings
 * @param {number} ltcgUsed
 * @returns {array} Optimization suggestions
 */
export function findTaxOptimizationOpportunities(holdings, ltcgUsed) {
  const opportunities = [];
  const remainingExemption = Math.max(0, TAX_RULES.LTCG.exemptLimit - ltcgUsed);

  holdings.forEach(holding => {
    const gain = holding.currentValue - holding.investedValue;
    
    // Opportunity 1: LTCG holdings with tax-free potential
    if (holding.taxInfo.type === 'LTCG' && gain > 0 && remainingExemption > 0) {
      const harvestableAmount = Math.min(gain, remainingExemption);
      opportunities.push({
        type: 'LTCG_HARVEST',
        priority: 'HIGH',
        stock: holding.stock,
        holding,
        suggestion: `Sell to harvest ₹${harvestableAmount.toLocaleString('en-IN')} tax-free before March 31`,
        taxSaving: 0, // It's already tax-free
        action: 'SELL',
      });
    }

    // Opportunity 2: STCG holdings close to 12 months
    if (holding.taxInfo.type === 'STCG' && gain > 0) {
      const monthsRemaining = 12 - holding.taxInfo.holdingPeriod;
      if (monthsRemaining <= 4) {
        const taxSaving = (gain * TAX_RULES.STCG.taxRate) / 100;
        opportunities.push({
          type: 'CONVERT_TO_LTCG',
          priority: monthsRemaining <= 2 ? 'HIGH' : 'MEDIUM',
          stock: holding.stock,
          holding,
          suggestion: `Hold for ${monthsRemaining} more month(s) to convert to LTCG and save ₹${taxSaving.toLocaleString('en-IN')}`,
          taxSaving,
          action: 'HOLD',
        });
      }
    }

    // Opportunity 3: STCG holdings with losses (tax loss harvesting)
    if (holding.taxInfo.type === 'STCG' && gain < 0) {
      opportunities.push({
        type: 'TAX_LOSS_HARVEST',
        priority: 'LOW',
        stock: holding.stock,
        holding,
        suggestion: `Realize loss of ₹${Math.abs(gain).toLocaleString('en-IN')} to offset STCG gains`,
        taxSaving: (Math.abs(gain) * TAX_RULES.STCG.taxRate) / 100,
        action: 'SELL',
      });
    }
  });

  return opportunities.sort((a, b) => {
    const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}

/**
 * Calculate time to LTCG conversion
 * @param {Date} purchaseDate
 * @returns {number} months remaining
 */
export function monthsUntilLTCG(purchaseDate) {
  const holding = getHoldingPeriodInMonths(purchaseDate);
  return Math.max(0, 12 - holding);
}

export default {
  determineCapitalGainType,
  getHoldingPeriodInMonths,
  calculateTaxOnTrade,
  calculatePortfolioTax,
  findTaxOptimizationOpportunities,
  monthsUntilLTCG,
  TAX_RULES,
};