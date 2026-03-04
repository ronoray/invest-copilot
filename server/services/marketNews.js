/**
 * server/services/marketNews.js
 *
 * Pre-market intelligence feed. Fetched once per trading day, cached in memory.
 * Injected into every signal generation call so Claude reasons with today's
 * actual market reality — not just technicals on stale data.
 *
 * Sources (all public, no paid APIs):
 *   - India VIX         — NSE allIndices (fear/complacency gauge)
 *   - FII / DII net     — NSE fiidiiTradeReact (institutional flow)
 *   - Corporate events  — NSE announcements filtered for held symbols
 *
 * If any source fails, the others still flow. Partial intelligence beats silence.
 */

import axios from 'axios';
import logger from './logger.js';

// ─── NSE session management ──────────────────────────────────────────────────
// NSE requires a browser-like session (cookie) before API calls will respond.
// We establish it once per day and reuse across all fetches.

const NSE_BASE   = 'https://www.nseindia.com';
const NSE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://www.nseindia.com/',
  'Origin':          'https://www.nseindia.com',
  'Connection':      'keep-alive',
};

let _nseSession    = null;   // Cookie string for the day
let _nseSessionDay = null;   // 'YYYY-MM-DD' IST

async function getNSESession() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (_nseSession && _nseSessionDay === today) return _nseSession;

  try {
    const resp = await axios.get(NSE_BASE + '/', {
      headers: NSE_HEADERS,
      timeout: 12000,
    });
    const raw = resp.headers['set-cookie'] || [];
    _nseSession    = raw.map(c => c.split(';')[0]).join('; ');
    _nseSessionDay = today;
    logger.info('[MarketNews] NSE session established');
  } catch (err) {
    logger.warn(`[MarketNews] NSE session failed: ${err.message}`);
    _nseSession    = '';
    _nseSessionDay = today;
  }
  return _nseSession;
}

async function nseGet(path) {
  const cookie = await getNSESession();
  return axios.get(`${NSE_BASE}${path}`, {
    headers: { ...NSE_HEADERS, Cookie: cookie },
    timeout: 12000,
  });
}

// ─── Per-day cache ────────────────────────────────────────────────────────────
let _newsCache    = null;   // { text, vix, fiiNet, diiNet, fetchedAt }
let _newsCacheDay = null;

function getISTDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// ─── India VIX ────────────────────────────────────────────────────────────────

async function fetchVIX() {
  try {
    const resp = await nseGet('/api/allIndices');
    const indices = resp.data?.data || [];
    const vix = indices.find(i => i.index === 'INDIA VIX');
    if (!vix) return null;
    return {
      value:   parseFloat(vix.last),
      change:  parseFloat(vix.percentChange || 0),
      level:
        vix.last >= 22 ? 'HIGH STRESS — institutional fear elevated, expect sharp moves' :
        vix.last >= 16 ? 'ELEVATED — uncertainty present, size down on new entries' :
                         'CALM — market confident, normal sizing appropriate',
    };
  } catch (err) {
    logger.warn(`[MarketNews] VIX fetch failed: ${err.message}`);
    return null;
  }
}

// ─── FII / DII flow ───────────────────────────────────────────────────────────

async function fetchFIIDII() {
  try {
    const resp = await nseGet('/api/fiidiiTradeReact');
    const rows = resp.data;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    // Take the most recent date's rows
    const latest = rows[0];
    const fii = rows.find(r => r.category?.toUpperCase().includes('FII') ||
                               r.category?.toUpperCase().includes('FOREIGN')) || {};
    const dii = rows.find(r => r.category?.toUpperCase().includes('DII') ||
                               r.category?.toUpperCase().includes('DOMESTIC')) || {};

    const fiiNet = parseFloat(fii.netValue || fii.net_value || 0);
    const diiNet = parseFloat(dii.netValue || dii.net_value || 0);

    return {
      fiiNet,
      diiNet,
      date: latest.date || 'yesterday',
      interpretation:
        fiiNet < -2000
          ? `FIIs heavy SELLERS (₹${Math.abs(fiiNet).toFixed(0)} cr) — supply pressure, expect volatility`
          : fiiNet < -500
          ? `FIIs net SELLERS (₹${Math.abs(fiiNet).toFixed(0)} cr) — mild headwind`
          : fiiNet > 2000
          ? `FIIs strong BUYERS (₹${fiiNet.toFixed(0)} cr) — institutional conviction, favour longs`
          : fiiNet > 500
          ? `FIIs net BUYERS (₹${fiiNet.toFixed(0)} cr) — mild tailwind`
          : `FIIs roughly NEUTRAL (₹${fiiNet.toFixed(0)} cr)`,
    };
  } catch (err) {
    logger.warn(`[MarketNews] FII/DII fetch failed: ${err.message}`);
    return null;
  }
}

// ─── Corporate announcements ──────────────────────────────────────────────────

async function fetchAnnouncements(symbols = []) {
  if (symbols.length === 0) return [];
  try {
    const today     = new Date();
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const fmt = d => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;

    const resp = await nseGet(
      `/api/corporate-announcements?index=equities&from_date=${fmt(yesterday)}&to_date=${fmt(today)}`
    );

    const all = resp.data || [];
    const upper = symbols.map(s => s.toUpperCase());

    const relevant = all
      .filter(a => upper.includes((a.symbol || '').toUpperCase()))
      .map(a => ({
        symbol:  a.symbol,
        subject: a.subject || a.desc || 'Announcement',
        date:    a.sort_date || a.broadcast_date_time || '',
      }))
      .slice(0, 10); // Cap to avoid overwhelming the prompt

    return relevant;
  } catch (err) {
    logger.warn(`[MarketNews] Announcements fetch failed: ${err.message}`);
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch and format the day's pre-market intelligence block.
 * Cached per trading day — safe to call multiple times.
 *
 * @param {string[]} holdingSymbols - Symbols currently held (e.g. ['BHARTIARTL', 'TECHM'])
 * @returns {Promise<string>} Formatted text block for injection into signal prompt
 */
export async function fetchPreMarketNews(holdingSymbols = []) {
  const today = getISTDate();

  if (_newsCache && _newsCacheDay === today) {
    return _newsCache.text;
  }

  const timeStr = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
  });

  // Fetch all sources in parallel — failures are handled inside each fetcher
  const [vix, flow, announcements] = await Promise.all([
    fetchVIX(),
    fetchFIIDII(),
    fetchAnnouncements(holdingSymbols),
  ]);

  const lines = [`=== TODAY'S MARKET INTELLIGENCE (${timeStr} IST) ===`];

  // VIX
  if (vix) {
    const dir = vix.change >= 0 ? `↑${vix.change.toFixed(1)}%` : `↓${Math.abs(vix.change).toFixed(1)}%`;
    lines.push(`\n📊 INDIA VIX: ${vix.value.toFixed(2)} ${dir}`);
    lines.push(`   ${vix.level}`);
  } else {
    lines.push(`\n📊 INDIA VIX: unavailable`);
  }

  // FII/DII
  if (flow) {
    const diiSign = flow.diiNet >= 0 ? '+' : '';
    lines.push(`\n💰 INSTITUTIONAL FLOW (${flow.date}):`);
    lines.push(`   FII: ₹${flow.fiiNet >= 0 ? '+' : ''}${flow.fiiNet.toFixed(0)} cr  |  DII: ₹${diiSign}${flow.diiNet.toFixed(0)} cr`);
    lines.push(`   ${flow.interpretation}`);
    if (flow.fiiNet < -500 && flow.diiNet > 500) {
      lines.push(`   → DII absorbing FII selling — typical stabilisation pattern. Watch for reversal.`);
    }
  } else {
    lines.push(`\n💰 INSTITUTIONAL FLOW: unavailable`);
  }

  // Corporate announcements
  lines.push(`\n🗞️ ANNOUNCEMENTS (stocks you hold):`);
  if (announcements.length > 0) {
    for (const a of announcements) {
      lines.push(`   • ${a.symbol}: ${a.subject}`);
    }
    lines.push(`   ⚠️ Check above announcements before trading those stocks today.`);
  } else {
    lines.push(`   No material announcements for held stocks today.`);
  }

  lines.push(`\n=== END MARKET INTELLIGENCE ===`);

  const text = lines.join('\n');

  _newsCache    = { text, vix, fiiNet: flow?.fiiNet, diiNet: flow?.diiNet, fetchedAt: new Date() };
  _newsCacheDay = today;

  logger.info(`[MarketNews] Intelligence block built (VIX: ${vix?.value ?? 'n/a'}, FII: ${flow?.fiiNet ?? 'n/a'}, announcements: ${announcements.length})`);
  return text;
}

/**
 * Returns cached news block without refetching. Empty string if not yet fetched today.
 */
export function getCachedNews() {
  const today = getISTDate();
  if (_newsCache && _newsCacheDay === today) return _newsCache.text;
  return '';
}

// ─── Recent IPO intelligence ──────────────────────────────────────────────────
// NSE lists recently listed IPOs at /api/allIpo.
// We fetch once per day, cache, and inject into every signal call so Claude
// can evaluate these as swing trading opportunities.

let _ipoCache    = null;  // formatted string or ''
let _ipoCacheDay = null;

/**
 * Parse issue price string from NSE (e.g. "₹150 to ₹160", "150-160", "₹225")
 * Returns the upper bound (more conservative for premium calculation).
 */
function parseIssuePrice(raw) {
  if (!raw) return 0;
  const nums = String(raw).replace(/[^\d.–\-]/g, ' ').trim().split(/[\s–\-]+/).map(Number).filter(n => !isNaN(n) && n > 0);
  return nums.length > 0 ? Math.max(...nums) : 0;
}

/**
 * Fetch recently listed IPOs from NSE (last 90 days) and format as signal context.
 * Cached once per trading day. Gracefully returns '' if NSE is unreachable.
 */
export async function fetchRecentIPOContext() {
  const today = getISTDate();
  if (_ipoCache !== null && _ipoCacheDay === today) return _ipoCache;

  try {
    const resp = await nseGet('/api/allIpo');
    const data = resp.data || {};

    // NSE returns nested structure — normalise across known response shapes
    const rawList = [
      ...(Array.isArray(data) ? data : []),
      ...(Array.isArray(data.recentlyListed)   ? data.recentlyListed   : []),
      ...(Array.isArray(data.data?.recentlyListed) ? data.data.recentlyListed : []),
    ];

    if (rawList.length === 0) {
      _ipoCache    = '';
      _ipoCacheDay = today;
      return '';
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const now = Date.now();

    const ipos = [];
    for (const item of rawList) {
      const symbol       = (item.symbol || item.tradingSymbol || '').trim().toUpperCase();
      const name         = item.companyName || item.name || symbol;
      const listDateRaw  = item.listingDate || item.listing_date || item.listDate || '';
      const issuePrice   = parseIssuePrice(item.issuePrice || item.issue_price || item.ipoPrice || '');

      if (!symbol || !listDateRaw) continue;

      // Parse listing date — NSE uses DD-Mon-YYYY or YYYY-MM-DD
      const listDate = new Date(listDateRaw);
      if (isNaN(listDate.getTime()) || listDate < cutoff) continue;

      const daysListed = Math.floor((now - listDate.getTime()) / 86400000);
      ipos.push({ symbol, name, listDate, listDateRaw, issuePrice, daysListed });
    }

    if (ipos.length === 0) {
      _ipoCache    = '';
      _ipoCacheDay = today;
      return '';
    }

    // Sort by most recent first
    ipos.sort((a, b) => b.listDate - a.listDate);

    const lines = ['\n=== RECENTLY LISTED IPOs — PRICE DISCOVERY OPPORTUNITIES ==='];
    lines.push(`${ipos.length} stocks listed on NSE in the last 90 days. These are in active price discovery — high volatility, institutional positioning still in flux.\n`);

    for (const ipo of ipos) {
      const issueTxt   = ipo.issuePrice > 0 ? `  Issue price: ₹${ipo.issuePrice}` : '';
      const ageTxt     = `${ipo.daysListed} days listed`;

      let riskFlags = '';
      if (ipo.daysListed < 10) {
        riskFlags = '  ⚠️ SKIP — < 10 days listed, insufficient price history for pattern recognition';
      } else if (ipo.daysListed >= 25 && ipo.daysListed <= 38) {
        riskFlags = '  ⚠️ 30-DAY ANCHOR LOCK-IN WINDOW — anchor investors can sell now. Avoid new longs until distribution clears';
      } else if (ipo.daysListed >= 80 && ipo.daysListed <= 92) {
        riskFlags = '  ⚠️ Near 90-day QIB lock-in expiry — potential supply overhang';
      }

      const knowledgeTxt = ipo.listDate > new Date('2025-08-01')
        ? '  [Post-Aug 2025: fundamentals unknown — price action only]'
        : '';

      lines.push(`• ${ipo.symbol} (${ipo.name}) — ${ageTxt}${issueTxt}${knowledgeTxt}${riskFlags}`);
    }

    lines.push(`
IPO SWING TRADING FRAMEWORK:
Knowledge boundary — Your training data covers fundamentals of companies listed BEFORE August 2025.
For companies listed AFTER August 2025: evaluate ONLY from price action, volume, sector context.
Do NOT fabricate fundamental narratives for post-Aug 2025 IPOs. Price action is your only edge.

Setup criteria:
• Listing premium >15% holding above listing price → institutional validation. Pullback to listing price = swing buy.
• Listed below issue price, day 20–40 with reversal volume → capitulation exhaustion. Contrarian long.
• Tight consolidation (< 3% daily range) after strong listing → accumulation. Breakout = momentum entry.
• Wide daily swings (> 6% ADR) → price discovery chaos. Wait for range to narrow before entry.

Lock-in calendar (flags above):
• Day 30: Anchor investors (HNI allottees) free to sell
• Month 6: Promoter shares unlock (massive supply risk for richly valued IPOs)
• Year 1: Employee ESOP lock-in expires
Check listing date against these windows before recommending. A stock at the 30-day window with weak price action = distribution underway.

=== END IPO INTELLIGENCE ===`);

    const text = lines.join('\n');
    _ipoCache    = text;
    _ipoCacheDay = today;
    logger.info(`[MarketNews] IPO intelligence: ${ipos.length} recently listed stocks cached`);
    return text;

  } catch (err) {
    logger.warn(`[MarketNews] IPO intelligence fetch failed: ${err?.message || String(err)}`);
    _ipoCache    = '';
    _ipoCacheDay = today;
    return '';
  }
}
