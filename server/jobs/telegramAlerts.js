import cron from 'node-cron';
import prisma from '../services/prisma.js';
import Anthropic from '@anthropic-ai/sdk';
import { getCurrentPrice, fetchMarketContext } from '../services/marketData.js';
import { ANALYST_IDENTITY, MARKET_DATA_INSTRUCTION, buildAccountabilityScorecard } from '../services/analystPrompts.js';
import { scanMarketForOpportunities, buildProfileBrief } from '../services/advancedScreener.js';
import { sendAlert, broadcastMessage, getBot } from '../services/telegramBot.js';
import { generateTradeSignals } from '../services/signalGenerator.js';
import logger from '../services/logger.js';
import { isTradingDay, isMarketHoliday } from '../utils/marketHolidays.js';

// Initialize Claude
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Telegram Alert System with Per-Portfolio AI Analyses
 * Schedule: 3 times daily with deep insights, skips market holidays
 */

// ============================================
// HELPER: Get User Portfolios with Holdings
// ============================================

async function getUserPortfolios(userId) {
  return prisma.portfolio.findMany({
    where: { userId, isActive: true },
    include: { holdings: true }
  });
}

// ============================================
// HELPER: Compute portfolio value summary
// ============================================

function getPortfolioValueSummary(portfolio) {
  let totalValue = 0;
  let totalInvested = 0;

  for (const h of portfolio.holdings || []) {
    const invested = h.quantity * parseFloat(h.avgPrice);
    const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
    totalInvested += invested;
    totalValue += current;
  }

  const totalPL = totalValue - totalInvested;
  const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

  return { totalValue, totalInvested, totalPL, totalPLPercent };
}

// ============================================
// HELPER: Get AI Analysis
// ============================================

async function getAIAnalysis(prompt, maxTokens = 1500) {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    return message.content[0].text;
  } catch (error) {
    logger.error('Claude API error:', error.message);
    return 'AI analysis unavailable. Please try again later.';
  }
}

// ============================================
// HELPER: Save Analysis to Database
// ============================================

async function saveAnalysis(userId, category, analysis, metadata = {}) {
  try {
    await prisma.aiAnalysis.create({
      data: {
        userId,
        analysisType: category,
        category,
        analysis,
        metadata
      }
    });
    logger.info(`Saved analysis: ${category} for user ${userId}`);
  } catch (error) {
    logger.error(`Failed to save analysis ${category}:`, error.message);
  }
}

// ============================================
// HELPER: Send long message (split if > 4000 chars)
// ============================================

async function sendTelegramMessage(chatId, text, options = {}) {
  const bot = getBot();
  if (!bot) return;

  if (text.length <= 4000) {
    await bot.sendMessage(chatId, text, options);
    return;
  }

  // Split on section dividers first, then by newlines
  const parts = [];
  let current = '';
  const lines = text.split('\n');

  for (const line of lines) {
    if (current.length + line.length + 1 > 3900) {
      if (current.trim()) parts.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (let i = 0; i < parts.length; i++) {
    const partText = parts.length > 1 ? `${parts[i]}\n\n_(${i + 1}/${parts.length})_` : parts[i];
    await bot.sendMessage(chatId, partText, options);
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 300));
  }
}

// ============================================
// HELPER: Portfolio display label
// ============================================

function portfolioLabel(p) {
  const risk = p.riskProfile ? ` (${p.riskProfile})` : '';
  return `${p.ownerName || p.name} - ${(p.broker || 'Unknown').replace(/_/g, ' ')}${risk}`;
}

// ============================================
// MORNING DEEP DIVE (9:00 AM)
// Per-portfolio: Market Analysis + Diversification + Risk Management
// ============================================

async function sendMorningDeepDive() {
  if (!isTradingDay(new Date())) {
    const holiday = isMarketHoliday(new Date());
    logger.info(`Market holiday${holiday.name ? ' (' + holiday.name + ')' : ''} — skipping morning alerts`);
    return;
  }

  try {
    logger.info('Generating Morning Deep Dive...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false,
        preferences: { path: ['dailyDigest'], equals: true }
      },
      include: { user: true }
    });

    // Fetch market data once for shared context
    let sharedMarketData = '';
    try {
      sharedMarketData = await fetchMarketContext([]);
    } catch (e) {
      logger.warn('Could not fetch market context for morning overview:', e.message);
    }

    // Shared market overview (1 API call for all users)
    const marketOverview = await getAIAnalysis(
      `${ANALYST_IDENTITY}

${sharedMarketData}
${MARKET_DATA_INSTRUCTION}

MORNING BATTLE PLAN — this portfolio is MY responsibility. I need to set up today for maximum profit.

1. MARKET STRUCTURE: Where is Nifty RIGHT NOW? Key levels where I expect institutional support/resistance. Is the trend my friend today or do I need to be defensive?
2. SECTOR ROTATION: Where is smart money flowing? I need to position my portfolios AHEAD of the move, not after it. Name specific sectors
3. TODAY'S PRIORITY: The single most important action I need my investor to take before 10 AM. Be specific — stock, price, size

This is not a newspaper report. This is MY game plan for making money today. Under 150 words.`, 600
    );

    for (const telegramUser of users) {
      try {
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        if (portfolios.length === 0) continue;

        const chatId = parseInt(telegramUser.telegramId);
        const sections = [];

        for (const portfolio of portfolios) {
          const profileBrief = buildProfileBrief(portfolio);
          const { totalValue, totalPL, totalPLPercent } = getPortfolioValueSummary(portfolio);
          const holdingsText = (portfolio.holdings || [])
            .map(h => `${h.symbol}: ${h.quantity} @ ${parseFloat(h.avgPrice).toFixed(0)} (${((h.quantity * parseFloat(h.currentPrice || h.avgPrice) - h.quantity * parseFloat(h.avgPrice)) / (h.quantity * parseFloat(h.avgPrice)) * 100).toFixed(1)}%)`)
            .join(', ');

          // Fetch portfolio-specific market data
          let portfolioMarketData = '';
          try {
            portfolioMarketData = await fetchMarketContext(portfolio.holdings || []);
          } catch (e) {
            logger.warn(`Could not fetch market context for portfolio ${portfolio.id}:`, e.message);
          }

          // Build accountability scorecard for this portfolio
          let scorecard = '';
          try {
            scorecard = await buildAccountabilityScorecard(portfolio.id);
          } catch (e) {
            logger.warn(`Could not build scorecard for portfolio ${portfolio.id}:`, e.message);
          }

          // Per-portfolio analysis (deep, conviction-based)
          const analysisPrompt = `${ANALYST_IDENTITY}

${portfolioMarketData}
${MARKET_DATA_INSTRUCTION}

${scorecard}

${profileBrief}

THIS PORTFOLIO IS MY RESPONSIBILITY. Here's my morning assessment:

1. PORTFOLIO GRADE (A-F): Be brutally honest. If it's a C, say it's a C and say exactly what drags it down. Concentration risk? Weak holdings? Missing sectors?
2. IMMEDIATE ACTIONS: What do I need the investor to execute BEFORE 10 AM? List specific orders: BUY/SELL, symbol, quantity, price. These are not suggestions — these are instructions from the portfolio manager
3. UNDERWATER POSITIONS: Any holding that's losing money — what's my recovery plan? Hold and average down? Cut and rotate? Specific price levels and replacement stocks
4. NEW OPPORTUNITIES I'M TRACKING: 2-3 stocks from my full market scan that this portfolio NEEDS. Entry price, target, stop-loss, position size in ₹. Don't just name blue chips — find the best risk-reward across ALL market caps
5. RISK ORDERS: Stop-loss for EVERY holding. If I'm wrong about any position, I need to know exactly where I admit defeat

${scorecard ? 'MY TRACK RECORD: I own every call above. For losses: here\'s what I got wrong and here\'s EXACTLY how I\'m recovering the money. For wins: should we add more or book profit?' : ''}

I cannot allow this portfolio to fail. Every word must serve that goal. Under 350 words.`;

          const analysis = await getAIAnalysis(analysisPrompt, 800);
          await saveAnalysis(telegramUser.user.id, 'MORNING_ANALYSIS', analysis, { time: 'morning', portfolioId: portfolio.id });

          const header = portfolios.length > 1 ? `\n📁 *${portfolioLabel(portfolio)}*\n` : '';
          const snapshot = `Value: ${formatINR(totalValue)} | P&L: ${totalPL >= 0 ? '📈' : '📉'} ${formatINR(Math.abs(totalPL))} (${totalPLPercent.toFixed(1)}%)`;

          sections.push(`${header}${snapshot}\n\n${analysis}`);
        }

        const morningMsg = `☀️ *MORNING BATTLE PLAN*
━━━━━━━━━━━━━━━━━━━

*🎯 MY MARKET READ*

${marketOverview}

━━━━━━━━━━━━━━━━━━━
*📊 PORTFOLIO ORDERS*

${sections.join('\n\n━━━━━━━━━━━━━━━━━━━\n\n')}

━━━━━━━━━━━━━━━━━━━
I've set today's plan. Execute the actions above. I'm tracking everything.`;

        await sendTelegramMessage(chatId, morningMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`Morning Deep Dive sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`Morning digest failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`Morning Deep Dive sent to ${users.length} users`);
  } catch (error) {
    logger.error('Morning Deep Dive error:', error);
  }
}

// ============================================
// EVENING PORTFOLIO REVIEW (6:00 PM)
// Per-portfolio: Technical + Economic + Value + Sentiment
// ============================================

async function sendEveningReview() {
  if (!isTradingDay(new Date())) {
    const holiday = isMarketHoliday(new Date());
    logger.info(`Market holiday${holiday.name ? ' (' + holiday.name + ')' : ''} — skipping evening alerts`);
    return;
  }

  try {
    logger.info('Generating Evening Portfolio Review...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false,
        preferences: { path: ['eveningSummary'], equals: true }
      },
      include: { user: true }
    });

    for (const telegramUser of users) {
      try {
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        if (portfolios.length === 0) continue;

        const chatId = parseInt(telegramUser.telegramId);
        const sections = [];

        for (const portfolio of portfolios) {
          const profileBrief = buildProfileBrief(portfolio);
          const { totalValue, totalPL, totalPLPercent } = getPortfolioValueSummary(portfolio);
          const top3 = (portfolio.holdings || []).slice(0, 3);
          const top3Text = top3.map(h => `${h.symbol} (${h.quantity} @ ${parseFloat(h.currentPrice || h.avgPrice).toFixed(0)})`).join(', ');

          // Fetch portfolio-specific market data for evening
          let eveningMarketData = '';
          try {
            eveningMarketData = await fetchMarketContext(portfolio.holdings || []);
          } catch (e) {
            logger.warn(`Could not fetch evening market context for portfolio ${portfolio.id}:`, e.message);
          }

          // Build accountability scorecard
          let eveningScorecard = '';
          try {
            eveningScorecard = await buildAccountabilityScorecard(portfolio.id);
          } catch (e) {
            logger.warn(`Could not build evening scorecard for portfolio ${portfolio.id}:`, e.message);
          }

          const analysisPrompt = `${ANALYST_IDENTITY}

${eveningMarketData}
${MARKET_DATA_INSTRUCTION}

${eveningScorecard}

${profileBrief}

EVENING P&L REPORT — I own today's results. Here's my honest assessment:

1. TODAY'S DAMAGE/GAIN REPORT: Calculate today's estimated P&L. If we lost money, I take responsibility. Specifically: which of MY recommended holdings or signals contributed to the loss? Which made money? Net P&L estimate in ₹
2. HOLDING-BY-HOLDING VERDICT: For EVERY position — grade A-F, and my updated call:
   - HOLD: thesis intact, I'm confident, here's why
   - ADD MORE: it's working, increase position by ₹X at ₹Y
   - EXIT TOMORROW: thesis is broken, I got this wrong. Exit at open, here's what replaces it
3. LOSS RECOVERY (if applicable): If we're down today, here's my SPECIFIC plan to recover the ₹ amount by [day]. Stock X at price Y, expected move Z. I don't accept losses without a recovery trade
4. TOMORROW'S SETUP: Based on today's close and global cues, what am I expecting? Am I positioned correctly or do I need to adjust overnight exposure?

${eveningScorecard ? 'MY SCORECARD: I track every call I make. Wins get compounded, losses get recovered. Here\'s my updated track record and what I\'m changing in my approach if I\'m losing.' : ''}

This is MY portfolio to protect and grow. If we had a bad day, the evening review is where I course-correct — not where I make excuses. Under 400 words.`;

          const analysis = await getAIAnalysis(analysisPrompt, 1000);
          await saveAnalysis(telegramUser.user.id, 'EVENING_REVIEW', analysis, { time: 'evening', portfolioId: portfolio.id });

          const header = portfolios.length > 1 ? `\n📁 *${portfolioLabel(portfolio)}*\n` : '';
          const snapshot = `Value: ${formatINR(totalValue)} | P&L: ${totalPL >= 0 ? '📈' : '📉'} ${formatINR(Math.abs(totalPL))} (${totalPLPercent.toFixed(1)}%)`;

          sections.push(`${header}${snapshot}\n\n${analysis}`);
        }

        const eveningMsg = `🌙 *EVENING P&L REPORT*
━━━━━━━━━━━━━━━━━━━

${sections.join('\n\n━━━━━━━━━━━━━━━━━━━\n\n')}

━━━━━━━━━━━━━━━━━━━
I've reviewed everything. Losses will be recovered. Wins will be compounded. Tomorrow's plan is being prepared.`;

        await sendTelegramMessage(chatId, eveningMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`Evening Review sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`Evening review failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`Evening Review sent to ${users.length} users`);
  } catch (error) {
    logger.error('Evening Review error:', error);
  }
}

// ============================================
// TOMORROW'S GAME PLAN (9:00 PM)
// Per-portfolio: Earnings + Strategy + Global + Personalized Watchlist
// ============================================

async function sendTomorrowGamePlan() {
  if (!isTradingDay(new Date())) {
    const holiday = isMarketHoliday(new Date());
    logger.info(`Market holiday${holiday.name ? ' (' + holiday.name + ')' : ''} — skipping game plan alerts`);
    return;
  }

  try {
    logger.info('Generating Tomorrow\'s Game Plan...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false
      },
      include: { user: true }
    });

    // Fetch shared market data for game plan
    let gameplanMarketData = '';
    try {
      gameplanMarketData = await fetchMarketContext([]);
    } catch (e) {
      logger.warn('Could not fetch market context for game plan:', e.message);
    }

    // Shared global macro analysis
    const globalOverview = await getAIAnalysis(
      `${ANALYST_IDENTITY}

${gameplanMarketData}
${MARKET_DATA_INSTRUCTION}

GLOBAL MACRO — I need to position my portfolios correctly for tomorrow. Connect the dots:

1. MONEY FLOWS: Where is global institutional money moving tonight? US yields, DXY, EM flows — and EXACTLY what it means for my Indian equity positions tomorrow morning
2. COMMODITY IMPACT: Crude, gold, copper at current levels — which of my portfolio sectors benefit or suffer? Specific stocks affected
3. MY MACRO TRADE FOR TOMORROW: One specific, actionable thesis with a stock pick. Not "markets may be volatile" — "Weak DXY + falling crude = NBFC tailwind, I'm adding BAJFINANCE at ₹7,200 tomorrow"

I don't report the news — I position ahead of it. Under 120 words.`, 500
    );

    for (const telegramUser of users) {
      try {
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        if (portfolios.length === 0) continue;

        const chatId = parseInt(telegramUser.telegramId);
        const sections = [];

        for (const portfolio of portfolios) {
          const profileBrief = buildProfileBrief(portfolio);
          const holdingSymbols = (portfolio.holdings || []).map(h => h.symbol).join(', ');

          // Fetch portfolio-specific market data for game plan
          let portfolioGameplanData = '';
          try {
            portfolioGameplanData = await fetchMarketContext(portfolio.holdings || []);
          } catch (e) {
            logger.warn(`Could not fetch game plan market context for portfolio ${portfolio.id}:`, e.message);
          }

          // Build scorecard for game plan
          let gameplanScorecard = '';
          try {
            gameplanScorecard = await buildAccountabilityScorecard(portfolio.id);
          } catch (e) {
            logger.warn(`Could not build game plan scorecard for portfolio ${portfolio.id}:`, e.message);
          }

          // Per-portfolio strategy analysis
          const strategyPrompt = `${ANALYST_IDENTITY}

${portfolioGameplanData}
${MARKET_DATA_INSTRUCTION}

${gameplanScorecard}

${profileBrief}

TOMORROW'S BATTLE PLAN — I will not let this portfolio underperform.

1. TOMORROW'S ₹ TARGET: Set a specific rupee target for tomorrow based on current positions and planned trades. Example: "Target ₹3,500 from: ₹1,200 INFY swing + ₹1,300 BAJFINANCE momentum + ₹1,000 new NTPC entry"
2. PRE-MARKET ORDERS: Exactly what I need the investor to execute at open. Symbol, quantity, price, order type. These are not "considerations" — these are my instructions as portfolio manager
3. OVERNIGHT RISK: What global events could gap us down? How am I hedged? If I'm NOT hedged, say why I'm comfortable with the exposure
4. SECTOR ROTATION TRADES: If momentum is shifting, I need to rotate AHEAD of the crowd. Specific exit + entry: "Sell X at ₹Y, buy Z at ₹W. Reason: sector momentum shifting from A to B"
5. MULTI-ASSET DEPLOYMENT: Should any cash move to gold (which SGB/ETF?), MFs (which scheme?), or fixed income (which instrument?) right now? Specific ₹ amounts
6. WEEKLY PROGRESS CHECK: Are we on track for our weekly/monthly target? If behind, what's the specific acceleration plan?

${gameplanScorecard ? 'MY TRACK RECORD: I own every call. If my win rate is below 60%, I\'m tightening my criteria tomorrow. If I\'m in the red, every recommendation must include a recovery component.' : ''}

This is not a suggestion list — it's a business plan for tomorrow's profits. I am accountable for these numbers. Under 300 words.`;

          const strategyAnalysis = await getAIAnalysis(strategyPrompt, 700);
          await saveAnalysis(telegramUser.user.id, 'GAME_PLAN', strategyAnalysis, { time: 'night', portfolioId: portfolio.id });

          // Per-portfolio watchlist scan (personalized to risk profile)
          let watchlistText = '';
          try {
            const opportunities = await scanMarketForOpportunities({
              portfolio,
              targetCount: { high: 2, medium: 2, low: 2 },
              baseAmount: parseFloat(portfolio.availableCash || 10000)
            });
            const topPicks = [...(opportunities.high || []), ...(opportunities.medium || []), ...(opportunities.low || [])].slice(0, 3);
            if (topPicks.length > 0) {
              watchlistText = '\n\n*Watchlist:*\n' + topPicks.map(s => `• ${s.symbol} - ₹${s.price?.toFixed(0) || '?'} (${s.riskCategory})`).join('\n');
            }
          } catch (e) {
            logger.error(`Watchlist scan failed for portfolio ${portfolio.id}:`, e.message);
          }

          const header = portfolios.length > 1 ? `\n📁 *${portfolioLabel(portfolio)}*\n` : '';
          sections.push(`${header}${strategyAnalysis}${watchlistText}`);
        }

        const gameplanMsg = `🎯 *TOMORROW'S BATTLE PLAN*
━━━━━━━━━━━━━━━━━━━

*🌍 MY MACRO POSITIONING*

${globalOverview}

━━━━━━━━━━━━━━━━━━━
*📊 PORTFOLIO BATTLE ORDERS*

${sections.join('\n\n━━━━━━━━━━━━━━━━━━━\n\n')}

━━━━━━━━━━━━━━━━━━━
Tomorrow's plan is set. I'll be tracking from market open. Execute the actions above — I'm accountable for these calls.`;

        await sendTelegramMessage(chatId, gameplanMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`Tomorrow's Game Plan sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`Game plan failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`Tomorrow's Game Plan sent to ${users.length} users`);
  } catch (error) {
    logger.error(`Tomorrow's Game Plan error:`, error);
  }
}

// ============================================
// PRICE MONITORING (during market hours)
// ============================================

async function checkPriceAlerts() {
  if (!isTradingDay(new Date())) {
    logger.info('Market holiday — skipping price alerts');
    return;
  }

  try {
    const holdings = await prisma.holding.findMany({
      include: {
        portfolio: {
          include: {
            user: {
              include: { telegramUser: true }
            }
          }
        }
      }
    });

    for (const holding of holdings) {
      if (!holding.portfolio?.user?.telegramUser) continue;

      try {
        const currentPrice = await getCurrentPrice(holding.symbol, holding.exchange);

        await prisma.holding.update({
          where: { id: holding.id },
          data: { currentPrice: currentPrice.price }
        });

        // Target hit
        if (holding.targetPrice && currentPrice.price >= holding.targetPrice * 0.98) {
          const alertMsg = `🎯 *TARGET ALERT*

*${holding.symbol}* hit target!
Current: ₹${currentPrice.price.toFixed(2)}
Target: ₹${holding.targetPrice}

Consider booking profit! 💰`;

          const chatId = parseInt(holding.portfolio.user.telegramUser.telegramId);
          await getBot()?.sendMessage(chatId, alertMsg, { parse_mode: 'Markdown' });
        }

        // Stop loss
        if (holding.stopLoss && currentPrice.price <= holding.stopLoss) {
          const alertMsg = `🛑 *STOP LOSS TRIGGERED*

*${holding.symbol}* hit stop loss!
Current: ₹${currentPrice.price.toFixed(2)}
Stop Loss: ₹${holding.stopLoss}

Exit now to limit losses! ⚠️`;

          const chatId = parseInt(holding.portfolio.user.telegramUser.telegramId);
          await getBot()?.sendMessage(chatId, alertMsg, { parse_mode: 'Markdown' });
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error(`Price check failed for ${holding.symbol}:`, error.message);
      }
    }

    logger.info('Price alerts check completed');
  } catch (error) {
    logger.error('Price monitoring error:', error);
  }
}

// ============================================
// DAILY TARGET INCOME TRACKING (Fix 3)
// ============================================

async function checkDailyTargetProgress() {
  if (!isTradingDay(new Date())) return;

  try {
    logger.info('Checking daily target progress...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find all portfolios with a DailyTarget for today
    const targets = await prisma.dailyTarget.findMany({
      where: { date: today },
      include: {
        portfolio: {
          include: {
            holdings: true,
            user: {
              include: { telegramUser: true }
            }
          }
        }
      }
    });

    if (targets.length === 0) {
      logger.info('No daily targets set for today');
      return;
    }

    const now = new Date();
    const hours = now.getHours();
    const marketCloseHour = 15; // 3 PM IST
    const minutesLeft = (marketCloseHour * 60 + 30) - (hours * 60 + now.getMinutes());

    for (const target of targets) {
      const portfolio = target.portfolio;
      if (!portfolio?.user?.telegramUser?.isActive || portfolio.user.telegramUser.isMuted) continue;

      try {
        // Fetch live prices for top 8 holdings by invested value
        const sortedHoldings = [...(portfolio.holdings || [])]
          .sort((a, b) => (b.quantity * parseFloat(b.avgPrice)) - (a.quantity * parseFloat(a.avgPrice)))
          .slice(0, 8);

        let intradayPL = 0;
        const holdingUpdates = [];

        for (const h of sortedHoldings) {
          try {
            const priceData = await getCurrentPrice(h.symbol, h.exchange || 'NSE');
            if (priceData?.price) {
              const storedPrice = parseFloat(h.currentPrice || h.avgPrice);
              const pl = (priceData.price - storedPrice) * h.quantity;
              intradayPL += pl;
              holdingUpdates.push(`${h.symbol}: ${pl >= 0 ? '+' : ''}₹${pl.toFixed(0)}`);
            }
            await new Promise(r => setTimeout(r, 12000)); // Rate limit
          } catch (e) {
            logger.warn(`Price fetch failed for ${h.symbol} in target check:`, e.message);
          }
        }

        // Update DailyTarget
        await prisma.dailyTarget.update({
          where: { id: target.id },
          data: {
            earnedActual: intradayPL,
            earnedUpdatedAt: new Date()
          }
        });

        const effectiveTarget = parseFloat(target.userTarget || target.aiTarget || 0);
        const gap = effectiveTarget - intradayPL;

        // Target met — celebrate and push for more
        if (gap <= 0) {
          logger.info(`Portfolio ${portfolio.id}: Target met (earned ${intradayPL.toFixed(0)} vs target ${effectiveTarget})`);
          const chatId = parseInt(portfolio.user.telegramUser.telegramId);
          const surplus = Math.abs(gap);
          const targetMetMsg = `✅ *TARGET HIT — WE DID IT*
━━━━━━━━━━━━━━━━━━━
📁 *${portfolioLabel(portfolio)}*

🎯 Target: ₹${effectiveTarget.toFixed(0)}
📊 Earned: +₹${intradayPL.toFixed(0)}${surplus > 0 ? ` (₹${surplus.toFixed(0)} ABOVE target)` : ''}

${holdingUpdates.join('\n')}

My analysis delivered today. ${surplus > 100 ? `The surplus of ₹${surplus.toFixed(0)} builds our buffer for tougher days.` : 'Let\'s keep this momentum going.'} I\'m already planning tomorrow's targets.`;
          await sendTelegramMessage(chatId, targetMetMsg, { parse_mode: 'Markdown' });
          continue;
        }

        // Find pending/unfollowed signals for this portfolio
        const pendingSignals = await prisma.tradeSignal.findMany({
          where: {
            portfolioId: portfolio.id,
            status: { in: ['PENDING', 'SNOOZED'] },
            createdAt: { gte: today }
          }
        });

        const signalsList = pendingSignals.length > 0
          ? pendingSignals.map(s => `• ${s.side} ${s.quantity}x ${s.symbol} (${s.confidence}% confidence)`).join('\n')
          : 'No pending signals';

        // Time urgency message
        let urgency = '';
        if (minutesLeft <= 90) {
          urgency = '🔥 *Market closes in less than 90 minutes!*';
        } else if (minutesLeft <= 180) {
          urgency = '⏰ *Less than 3 hours to market close*';
        }

        const chatId = parseInt(portfolio.user.telegramUser.telegramId);
        const { totalValue } = getPortfolioValueSummary(portfolio);

        const pctAchieved = effectiveTarget > 0 ? ((intradayPL / effectiveTarget) * 100).toFixed(0) : 0;

        const alertMsg = `🚨 *I'M TRACKING YOUR TARGET*
━━━━━━━━━━━━━━━━━━━
📁 *${portfolioLabel(portfolio)}*

🎯 Today's Target: ₹${effectiveTarget.toFixed(0)}
📊 Current P&L: ${intradayPL >= 0 ? '+' : ''}₹${intradayPL.toFixed(0)} (${pctAchieved}% achieved)
🔻 *Gap: ₹${gap.toFixed(0)} — I need to close this*
${urgency ? '\n' + urgency : ''}

*Position P&L:*
${holdingUpdates.join('\n') || 'No data available'}

${pendingSignals.length > 0 ? `*MY PENDING SIGNALS (EXECUTE THESE):*\n${signalsList}\n\nI generated these signals for a reason. Each one is designed to help close the ₹${gap.toFixed(0)} gap. Execute them NOW.` : `*No pending signals.* I need to generate new opportunities. Use /scan and I will find the trades to close this gap.`}

${minutesLeft <= 90 ? 'We are running out of time. Every minute counts. Act on the signals above or tell me to scan for alternatives.' : `We have ${Math.floor(minutesLeft / 60)}h ${minutesLeft % 60}m until close. That is enough time to recover — but only if you act.`}`;

        await sendTelegramMessage(chatId, alertMsg, { parse_mode: 'Markdown' });
        logger.info(`Daily target alert sent for portfolio ${portfolio.id}: gap ₹${gap.toFixed(0)}`);

        // Auto-generate recovery signals if behind target, no pending signals, and past 11 AM
        if (gap > 0 && pendingSignals.length === 0 && hours >= 11) {
          try {
            const recoveryContext = `URGENT RECOVERY: Portfolio is ₹${gap.toFixed(0)} behind today's target of ₹${effectiveTarget.toFixed(0)} with ${minutesLeft} minutes until market close. Generate recovery trades specifically targeting this ₹${gap.toFixed(0)} gap. Prioritize high-probability, short-duration trades on liquid stocks.`;
            const recoverySignals = await generateTradeSignals(portfolio.id, recoveryContext);

            if (recoverySignals.length > 0) {
              const signalNames = recoverySignals.map(s => `${s.side} ${s.symbol}`).join(', ');
              await sendTelegramMessage(chatId,
                `⚡ *RECOVERY SIGNALS GENERATED*\n\nI've auto-generated ${recoverySignals.length} recovery trade(s) to close the ₹${gap.toFixed(0)} gap: ${signalNames}\n\nThese will appear in your signal notifications shortly. Execute them to get back on track.`,
                { parse_mode: 'Markdown' }
              );
              logger.info(`Auto-generated ${recoverySignals.length} recovery signals for portfolio ${portfolio.id}`);
            }
          } catch (recoveryErr) {
            logger.error(`Recovery signal generation failed for portfolio ${portfolio.id}:`, recoveryErr.message);
          }
        }

        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.error(`Daily target check failed for portfolio ${portfolio.id}:`, err.message);
      }
    }

    logger.info(`Daily target progress check complete (${targets.length} targets)`);
  } catch (error) {
    logger.error('Daily target progress error:', error);
  }
}

// ============================================
// END-OF-DAY TARGET REVIEW (3:35 PM)
// Final P&L update + carryover note for tomorrow
// ============================================

async function sendEndOfDayTargetReview() {
  if (!isTradingDay(new Date())) return;

  try {
    logger.info('Running end-of-day target review...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const targets = await prisma.dailyTarget.findMany({
      where: { date: today },
      include: {
        portfolio: {
          include: {
            holdings: true,
            user: {
              include: { telegramUser: true }
            }
          }
        }
      }
    });

    if (targets.length === 0) {
      logger.info('No daily targets to review at EOD');
      return;
    }

    for (const target of targets) {
      const portfolio = target.portfolio;
      if (!portfolio?.user?.telegramUser?.isActive || portfolio.user.telegramUser.isMuted) continue;

      try {
        // Final price fetch for all holdings (up to 8)
        const sortedHoldings = [...(portfolio.holdings || [])]
          .sort((a, b) => (b.quantity * parseFloat(b.avgPrice)) - (a.quantity * parseFloat(a.avgPrice)))
          .slice(0, 8);

        let finalPL = 0;
        const holdingResults = [];

        for (const h of sortedHoldings) {
          try {
            const priceData = await getCurrentPrice(h.symbol, h.exchange || 'NSE');
            if (priceData?.price) {
              const storedPrice = parseFloat(h.currentPrice || h.avgPrice);
              const pl = (priceData.price - storedPrice) * h.quantity;
              finalPL += pl;
              holdingResults.push({
                symbol: h.symbol,
                pl,
                pctMove: storedPrice > 0 ? ((priceData.price - storedPrice) / storedPrice * 100) : 0
              });
            }
            await new Promise(r => setTimeout(r, 12000));
          } catch (e) {
            logger.warn(`EOD price fetch failed for ${h.symbol}:`, e.message);
          }
        }

        // Update final earned amount
        await prisma.dailyTarget.update({
          where: { id: target.id },
          data: {
            earnedActual: finalPL,
            earnedUpdatedAt: new Date()
          }
        });

        const effectiveTarget = parseFloat(target.userTarget || target.aiTarget || 0);
        const gap = effectiveTarget - finalPL;
        const chatId = parseInt(portfolio.user.telegramUser.telegramId);
        const pName = portfolioLabel(portfolio);

        // Sort holdings by P&L contribution
        holdingResults.sort((a, b) => b.pl - a.pl);
        const winners = holdingResults.filter(h => h.pl > 0);
        const losers = holdingResults.filter(h => h.pl < 0);

        const winnersText = winners.length > 0
          ? winners.map(h => `✅ ${h.symbol}: +₹${h.pl.toFixed(0)} (${h.pctMove >= 0 ? '+' : ''}${h.pctMove.toFixed(1)}%)`).join('\n')
          : 'No winners today';
        const losersText = losers.length > 0
          ? losers.map(h => `❌ ${h.symbol}: ₹${h.pl.toFixed(0)} (${h.pctMove.toFixed(1)}%)`).join('\n')
          : 'No losers today';

        if (gap <= 0) {
          // Target met!
          const surplus = Math.abs(gap);
          const msg = `🏆 *END OF DAY — TARGET ACHIEVED*
━━━━━━━━━━━━━━━━━━━
📁 *${pName}*

🎯 Target: ₹${effectiveTarget.toFixed(0)}
📊 Final P&L: +₹${finalPL.toFixed(0)}${surplus > 0 ? ` (₹${surplus.toFixed(0)} ABOVE target)` : ''}

*Winners:*
${winnersText}

*Losers:*
${losersText}

I delivered today. ${surplus > 100 ? `The ₹${surplus.toFixed(0)} surplus builds our buffer.` : ''} Tomorrow's target will be computed at 9:16 AM with this momentum factored in.`;

          await sendTelegramMessage(chatId, msg, { parse_mode: 'Markdown' });
        } else {
          // Target missed
          const msg = `📉 *END OF DAY — TARGET MISSED*
━━━━━━━━━━━━━━━━━━━
📁 *${pName}*

🎯 Target: ₹${effectiveTarget.toFixed(0)}
📊 Final P&L: ${finalPL >= 0 ? '+' : ''}₹${finalPL.toFixed(0)}
🔻 *Deficit: ₹${gap.toFixed(0)}*

*Winners:*
${winnersText}

*Losers (what dragged us down):*
${losersText}

I own this miss. ${losers.length > 0 ? `${losers[0].symbol} was the biggest drag at ₹${losers[0].pl.toFixed(0)}.` : ''} I'll factor this ₹${gap.toFixed(0)} deficit into tomorrow's recovery plan. Tomorrow's target will include recovery — I don't leave money on the table.`;

          await sendTelegramMessage(chatId, msg, { parse_mode: 'Markdown' });
        }

        logger.info(`EOD review sent for portfolio ${portfolio.id}: ${gap <= 0 ? 'TARGET MET' : `missed by ₹${gap.toFixed(0)}`}`);
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.error(`EOD target review failed for portfolio ${portfolio.id}:`, err.message);
      }
    }

    logger.info(`End-of-day target review complete (${targets.length} targets)`);
  } catch (error) {
    logger.error('End-of-day target review error:', error);
  }
}

// ============================================
// HELPER: Format INR
// ============================================

function formatINR(amount) {
  return `₹${parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// ============================================
// CRON JOB SETUP
// ============================================

export function initTelegramAlerts() {
  logger.info('Initializing Telegram AI Alert System...');

  // Price alerts every few hours during market hours (9:00 AM - 3:30 PM IST, Mon-Fri)
  cron.schedule('0 9,11,13,15 * * 1-5', async () => {
    await checkPriceAlerts();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Morning Deep Dive at 9:00 AM (Mon-Fri, skips holidays)
  cron.schedule('0 9 * * 1-5', async () => {
    await sendMorningDeepDive();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Evening Portfolio Review at 6:00 PM (Mon-Fri, skips holidays)
  cron.schedule('0 18 * * 1-5', async () => {
    await sendEveningReview();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Tomorrow's Game Plan at 9:00 PM (Mon-Fri, skips holidays)
  cron.schedule('0 21 * * 1-5', async () => {
    await sendTomorrowGamePlan();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Daily Target Income Check — hourly during market hours (10 AM - 3 PM IST)
  cron.schedule('0 10,11,12,13,14,15 * * 1-5', async () => {
    await checkDailyTargetProgress();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // End-of-day target review at 3:35 PM IST (after market close)
  cron.schedule('35 15 * * 1-5', async () => {
    await sendEndOfDayTargetReview();
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('Telegram AI Alert System initialized');
  logger.info('Schedule:');
  logger.info('  9:00 AM - Morning Deep Dive (per-portfolio market + diversification + risk)');
  logger.info('  10-3 PM - Daily Target Income Check (hourly)');
  logger.info('  3:35 PM - End-of-Day Target Review (final P&L + carryover)');
  logger.info('  6:00 PM - Evening Review (per-portfolio technical + value + sentiment)');
  logger.info('  9:00 PM - Game Plan (per-portfolio strategy + personalized watchlist)');
  logger.info('  Skips NSE market holidays automatically');
}

export default {
  checkPriceAlerts,
  checkDailyTargetProgress,
  sendEndOfDayTargetReview,
  sendMorningDeepDive,
  sendEveningReview,
  sendTomorrowGamePlan,
  initTelegramAlerts
};
