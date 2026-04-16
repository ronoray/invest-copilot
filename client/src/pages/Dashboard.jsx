import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, TrendingDown, AlertCircle, CheckCircle, Clock, Lightbulb, ArrowRight, RefreshCw, Loader2, Zap, ExternalLink, Camera } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import PortfolioCompletenessAlert from '../components/PortfolioCompletenessAlert';

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [portfolios, setPortfolios] = useState([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState('all');
  const [holdings, setHoldings] = useState([]);
  const [summary, setSummary] = useState(null);
  const [recommendations, setRecommendations] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pricesAt, setPricesAt] = useState(null);

  // Trade signals state
  const [signals, setSignals] = useState([]);
  const [recentExecuted, setRecentExecuted] = useState([]);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [executingSignalId, setExecutingSignalId] = useState(null);
  const [signalActionId, setSignalActionId] = useState(null);
  const [signalError, setSignalError] = useState(null);
  const [signalSuccess, setSignalSuccess] = useState(null);

  // Load portfolios on mount
  useEffect(() => {
    loadPortfolios();
    loadRecommendations();
  }, []);

  // Load holdings + signals when portfolio changes
  useEffect(() => {
    loadHoldings();
    if (selectedPortfolioId !== 'all') {
      loadSignals(selectedPortfolioId);
    } else {
      setSignals([]);
      setRecentExecuted([]);
    }
  }, [selectedPortfolioId]);

  // Auto-refresh holdings during market hours (IST 9:15–15:30, Mon–Fri)
  useEffect(() => {
    const isMarketHours = () => {
      const now = new Date();
      const day = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
      if (['Sat', 'Sun'].includes(day)) return false;
      const [h, m] = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }).split(':').map(Number);
      const mins = h * 60 + m;
      return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
    };
    if (!isMarketHours()) return;
    const id = setInterval(() => { if (isMarketHours()) loadHoldings(); }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [selectedPortfolioId]);

  const loadPortfolios = async () => {
    try {
      const data = await api.get('/portfolio?all=true');
      setPortfolios(data.portfolios || []);
    } catch (err) {
      console.error('Failed to load portfolios:', err);
    }
  };

  const loadHoldings = async () => {
    setLoading(true);
    try {
      if (selectedPortfolioId === 'all') {
        const data = await api.get('/portfolio');
        const h = data.holdings || [];
        setHoldings(h);
        setSummary(data.summary || null);
        if (h.length > 0) {
          const latest = h.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
          setPricesAt(new Date(latest.updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }));
        }
      } else {
        const data = await api.get(`/portfolio/${selectedPortfolioId}/holdings`);
        const holdingsData = data.holdings || [];
        setHoldings(holdingsData);
        const totalInvested = holdingsData.reduce((s, h) => s + h.investedAmount, 0);
        const totalCurrent = holdingsData.reduce((s, h) => s + h.currentValue, 0);
        const unrealizedPL = totalCurrent - totalInvested;
        setSummary({
          totalInvested,
          totalCurrent,
          unrealizedPL,
          plPercent: totalInvested > 0 ? ((unrealizedPL / totalInvested) * 100).toFixed(2) : '0.00'
        });
        if (holdingsData.length > 0) {
          const latest = holdingsData.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
          setPricesAt(new Date(latest.updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }));
        }
      }
    } catch (err) {
      console.error('Failed to load holdings:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadSignals = useCallback(async (portfolioId) => {
    setSignalsLoading(true);
    try {
      const data = await api.get(`/signals?portfolioId=${portfolioId}`);
      const allSignals = data.signals || [];
      // Split into pending/actionable and recently executed (last 24h)
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      setSignals(allSignals.filter(s => ['PENDING', 'SNOOZED', 'ACKED', 'PLACING'].includes(s.status)));
      setRecentExecuted(allSignals.filter(s =>
        s.status === 'EXECUTED' && new Date(s.updatedAt || s.createdAt).getTime() > oneDayAgo
      ));
    } catch (err) {
      console.error('Failed to load signals:', err);
    } finally {
      setSignalsLoading(false);
    }
  }, []);

  const loadRecommendations = async () => {
    try {
      const data = await api.get('/ai/recommendations');
      setRecommendations(data);
    } catch (err) {
      console.error('Failed to load recommendations:', err);
    }
  };

  const handleSyncPrices = async () => {
    setSyncing(true);
    try {
      await api.post('/portfolio/sync');
      await loadHoldings();
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handleExecuteSignal = async (signalId) => {
    setExecutingSignalId(signalId);
    setSignalError(null);
    setSignalSuccess(null);
    try {
      const data = await api.post(`/signals/${signalId}/execute`);
      setSignalSuccess(`Order placed: ${data.data?.orderId || 'OK'}. Verifying with exchange...`);
      // Reload signals + holdings after a short delay to allow polling
      setTimeout(async () => {
        await loadSignals(selectedPortfolioId);
        await loadHoldings();
        setSignalSuccess(null);
      }, 5000);
    } catch (err) {
      setSignalError(err.message || 'Failed to execute signal');
      setTimeout(() => setSignalError(null), 5000);
    } finally {
      setExecutingSignalId(null);
    }
  };

  const handleSignalAction = async (signalId, action) => {
    setSignalActionId(signalId);
    setSignalError(null);
    try {
      await api.post(`/signals/${signalId}/ack`, { action });
      await loadSignals(selectedPortfolioId);
    } catch (err) {
      setSignalError(err.message || `Failed to ${action.toLowerCase()} signal`);
      setTimeout(() => setSignalError(null), 5000);
    } finally {
      setSignalActionId(null);
    }
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  };

  const getMarketStatus = () => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + (istOffset - now.getTimezoneOffset() * 60 * 1000));
    const day = ist.getDay();
    const hours = ist.getHours();
    const minutes = ist.getMinutes();
    const timeInMinutes = hours * 60 + minutes;

    if (day >= 1 && day <= 5 && timeInMinutes >= 555 && timeInMinutes <= 930) {
      return { isOpen: true, label: 'OPEN' };
    }
    return { isOpen: false, label: 'CLOSED' };
  };

  const formatCurrency = (val) => {
    if (val == null || isNaN(val)) return '\u2014';
    return `\u20B9${Number(val).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const plColor = (val) => {
    if (val == null) return 'text-gray-600 dark:text-gray-400';
    return Number(val) >= 0 ? 'text-green-600' : 'text-red-600';
  };

  const plBg = (val) => {
    if (val == null) return 'from-gray-50 to-gray-100 border-gray-200 dark:from-gray-900 dark:to-gray-700 dark:border-gray-700';
    return Number(val) >= 0
      ? 'from-green-50 to-green-100 border-green-200 dark:from-green-900/30 dark:to-green-800/30 dark:border-green-700'
      : 'from-red-50 to-red-100 border-red-200 dark:from-red-900/30 dark:to-red-800/30 dark:border-red-700';
  };

  const getTriggerLabel = (signal) => {
    if (signal.triggerType === 'MARKET') return 'MARKET';
    if (signal.triggerType === 'LIMIT') return `LIMIT @ \u20B9${parseFloat(signal.triggerPrice || 0).toFixed(2)}`;
    if (signal.triggerType === 'ZONE') return `ZONE \u20B9${parseFloat(signal.triggerLow || 0).toFixed(2)}-\u20B9${parseFloat(signal.triggerHigh || 0).toFixed(2)}`;
    return signal.triggerType || 'MARKET';
  };

  const market = getMarketStatus();
  const userName = user?.name?.split(' ')[0] || 'Investor';
  const selectedPortfolio = portfolios.find(p => p.id === selectedPortfolioId);
  const isUpstoxPortfolio = selectedPortfolio?.broker === 'UPSTOX';

  // Total portfolio worth = holdings + cash (the real number, not just deployed capital)
  const activePorts = portfolios.filter(p => !p.isPaused);
  const totalCash = selectedPortfolioId === 'all'
    ? activePorts.reduce((sum, p) => sum + (parseFloat(p.availableCash) || 0), 0)
    : parseFloat(selectedPortfolio?.availableCash || 0);
  const totalPortfolioWorth = (summary?.totalCurrent || 0) + totalCash;

  // Overall P&L vs original starting capital
  const totalStartingCapital = selectedPortfolioId === 'all'
    ? activePorts.reduce((sum, p) => sum + (parseFloat(p.startingCapital) || 0), 0)
    : parseFloat(selectedPortfolio?.startingCapital || 0);
  const overallPL = totalStartingCapital > 0 ? totalPortfolioWorth - totalStartingCapital : null;
  const overallPLPct = totalStartingCapital > 0 ? ((overallPL / totalStartingCapital) * 100).toFixed(2) : null;

  // Aggregate all recommendations into a flat array
  const allRecs = recommendations
    ? [...(recommendations.categorized?.high || []), ...(recommendations.categorized?.medium || []), ...(recommendations.categorized?.low || [])]
    : [];

  return (
    <div className="space-y-6 pb-8">
      {/* Header with Portfolio Selector */}
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-xl p-6 text-white shadow-lg">
        <h1 className="text-2xl md:text-3xl font-bold mb-2">
          {getGreeting()}, {userName}!
        </h1>
        <p className="text-blue-100 mb-4">Here's your investment overview</p>

        {portfolios.length > 0 && (
          <select
            value={selectedPortfolioId}
            onChange={(e) => setSelectedPortfolioId(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
            className="w-full px-4 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <option value="all">All Portfolios</option>
            {portfolios.map(p => (
              <option key={p.id} value={p.id}>{p.displayName}</option>
            ))}
          </select>
        )}
      </div>

      {/* Portfolio Info Strip */}
      {selectedPortfolioId !== 'all' && (() => {
        const sp = portfolios.find(p => p.id === selectedPortfolioId);
        if (!sp) return null;
        const brokerLabel = (sp.broker || '').replace(/_/g, ' ');
        return (
          <>
            <div className="bg-white dark:bg-gray-800 rounded-xl px-4 py-3 shadow-sm border border-gray-200 dark:border-gray-700 flex items-center gap-3 flex-wrap text-sm">
              <span className="font-semibold text-gray-900 dark:text-gray-100">{sp.ownerName}</span>
              <span className="text-gray-400">|</span>
              <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 font-medium text-xs">{brokerLabel}</span>
              <span className={`px-2 py-0.5 rounded-full font-medium text-xs ${
                sp.riskProfile === 'AGGRESSIVE' ? 'bg-red-100 text-red-700' :
                sp.riskProfile === 'CONSERVATIVE' ? 'bg-green-100 text-green-700' :
                'bg-blue-100 text-blue-700'
              }`}>{sp.riskProfile}</span>
              {sp.investmentGoal && (
                <span className="text-gray-500 dark:text-gray-400">{sp.investmentGoal.replace(/_/g, ' ')}</span>
              )}
              <span className="text-gray-600 dark:text-gray-400">{sp.holdingsCount || 0} holdings</span>
              {sp.totalInvested > 0 && (
                <span className="font-semibold text-gray-800 dark:text-gray-100">
                  Invested: {formatCurrency(sp.totalInvested)}
                </span>
              )}
              {sp.totalInvested > 0 && (
                <span className={`font-semibold ${(sp.unrealizedPL || 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  P&L: {(sp.unrealizedPL || 0) >= 0 ? '+' : ''}{formatCurrency(sp.unrealizedPL)} ({sp.unrealizedPLPercent > 0 ? '+' : ''}{sp.unrealizedPLPercent || 0}%)
                </span>
              )}
              <span className="ml-auto text-green-700 font-medium">
                Cash: {formatCurrency(sp.availableCash)}
              </span>
            </div>
            <PortfolioCompletenessAlert portfolio={sp} linkToPortfolio={true} />
            {/* On Hold banner for paused portfolios */}
            {sp.isPaused && (
              <div className="bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-xl px-4 py-3 flex items-center gap-3 text-sm">
                <span className="text-xl">⏸</span>
                <div className="flex-1">
                  <span className="font-medium text-gray-700 dark:text-gray-300">Portfolio On Hold</span>
                  <span className="text-gray-500 dark:text-gray-400 ml-2">Signals, alerts, and AI analysis are paused. Focusing on Upstox only.</span>
                </div>
              </div>
            )}
            {/* Capital staleness warning for non-Upstox portfolios */}
            {!sp.isPaused && sp.broker !== 'UPSTOX' && (() => {
              const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
              const isStale = !sp.lastVerifiedAt || (Date.now() - new Date(sp.lastVerifiedAt).getTime() > twoDaysMs);
              if (!isStale) return null;
              const daysAgo = sp.lastVerifiedAt
                ? Math.floor((Date.now() - new Date(sp.lastVerifiedAt).getTime()) / (24 * 60 * 60 * 1000))
                : null;
              return (
                <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-xl px-4 py-3 flex items-center gap-3 text-sm">
                  <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                  <div className="flex-1">
                    <span className="font-medium text-amber-800 dark:text-amber-300">
                      Portfolio data not verified recently.
                    </span>
                    <span className="text-amber-700 dark:text-amber-400 ml-1">
                      {daysAgo !== null ? `Last verified ${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago.` : 'Never verified.'}
                      {' '}Signal generation is paused.
                    </span>
                  </div>
                  <button
                    onClick={() => navigate('/plan')}
                    className="flex items-center gap-1 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg transition-colors flex-shrink-0"
                  >
                    <Camera className="w-3 h-3" />
                    Upload Screenshot
                  </button>
                </div>
              );
            })()}
          </>
        );
      })()}

      {/* Loading */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <span className="ml-3 text-gray-600 dark:text-gray-400">Loading portfolio...</span>
        </div>
      ) : (
        <>
          {/* Portfolio Overview Cards (All Portfolios view) */}
          {selectedPortfolioId === 'all' && portfolios.length > 1 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {portfolios.map(p => {
                const brokerShort = (p.broker || '').replace(/_/g, ' ');
                const pl = p.unrealizedPL || 0;
                const plPct = p.unrealizedPLPercent || 0;
                const isProfit = pl >= 0;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedPortfolioId(p.id)}
                    className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 hover:border-blue-300 hover:shadow-md transition-all text-left"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">{p.ownerName}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{p.name}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ml-2 ${
                        p.riskProfile === 'AGGRESSIVE' ? 'bg-red-100 text-red-700' :
                        p.riskProfile === 'CONSERVATIVE' ? 'bg-green-100 text-green-700' :
                        'bg-blue-100 text-blue-700'
                      }`}>{p.riskProfile}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-2">
                      <span>{brokerShort}</span>
                      <span className="text-gray-300">|</span>
                      <span>{p.holdingsCount || 0} holdings</span>
                      <span className="text-green-600 ml-auto">Cash: {formatCurrency(p.availableCash)}</span>
                    </div>
                    {(p.totalInvested > 0) ? (
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-gray-800 dark:text-gray-100">Value: {formatCurrency(p.totalCurrentValue)}</span>
                        <span className={`font-semibold ${isProfit ? 'text-green-600' : 'text-red-600'}`}>
                          {isProfit ? '+' : ''}{formatCurrency(pl)} ({plPct > 0 ? '+' : ''}{plPct}%)
                        </span>
                      </div>
                    ) : (
                      <div className="text-xs text-gray-400">No holdings</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Quick Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total Portfolio Worth (holdings + cash) */}
            <div className={`bg-gradient-to-br ${overallPL !== null ? plBg(overallPL) : 'from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/30 border-blue-200 dark:border-blue-700'} rounded-xl p-6 border hover:shadow-lg transition-shadow`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-blue-700 dark:text-blue-300">Total Portfolio</h3>
                <TrendingUp className="w-5 h-5 text-blue-600" />
              </div>
              <p className="text-xl sm:text-3xl font-bold text-blue-900 dark:text-blue-100">{formatCurrency(totalPortfolioWorth || null)}</p>
              <div className="mt-1 space-y-0.5">
                {overallPL !== null && (
                  <p className={`text-sm font-semibold ${plColor(overallPL)}`}>
                    {overallPL >= 0 ? '+' : ''}{formatCurrency(overallPL)} vs start ({overallPLPct}%)
                  </p>
                )}
                <p className="text-xs text-blue-600 dark:text-blue-400">
                  Holdings {formatCurrency(summary?.totalCurrent)} + Cash {formatCurrency(totalCash)}
                </p>
              </div>
            </div>

            {/* Unrealized P&L (on open positions) */}
            <div className={`bg-gradient-to-br ${plBg(summary?.unrealizedPL)} rounded-xl p-6 border hover:shadow-lg transition-shadow`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className={`text-sm font-medium ${Number(summary?.unrealizedPL) >= 0 ? 'text-green-700' : 'text-red-700'}`}>Open Positions P&L</h3>
                {Number(summary?.unrealizedPL) >= 0 ? <TrendingUp className="w-5 h-5 text-green-600" /> : <TrendingDown className="w-5 h-5 text-red-600" />}
              </div>
              <p className={`text-3xl font-bold ${Number(summary?.unrealizedPL) >= 0 ? 'text-green-900 dark:text-green-100' : 'text-red-900 dark:text-red-100'}`}>
                {summary ? formatCurrency(Math.abs(summary.unrealizedPL)) : '\u2014'}
              </p>
              <p className={`text-sm mt-1 font-semibold ${plColor(summary?.unrealizedPL)}`}>
                {summary ? `${Number(summary.plPercent) >= 0 ? '+' : ''}${summary.plPercent}% on deployed` : '\u2014'}
              </p>
            </div>

            {/* Starting Capital */}
            <div className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/30 rounded-xl p-6 border border-purple-200 dark:border-purple-700 hover:shadow-lg transition-shadow">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-purple-700">Starting Capital</h3>
                <CheckCircle className="w-5 h-5 text-purple-600" />
              </div>
              <p className="text-xl sm:text-3xl font-bold text-purple-900 dark:text-purple-100">{formatCurrency(totalStartingCapital || null)}</p>
              <p className="text-sm text-purple-600 mt-1">
                {summary?.totalInvested ? `${formatCurrency(summary.totalInvested)} deployed` : 'Original investment'}
              </p>
            </div>

            {/* Holdings Count */}
            <div className="bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-900/30 dark:to-amber-800/30 rounded-xl p-6 border border-amber-200 dark:border-amber-700 hover:shadow-lg transition-shadow">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-amber-700">Holdings</h3>
                <CheckCircle className="w-5 h-5 text-amber-600" />
              </div>
              <p className="text-xl sm:text-3xl font-bold text-amber-900 dark:text-amber-100">{holdings.length}</p>
              <p className="text-sm text-amber-600 mt-1">
                {selectedPortfolioId === 'all' ? 'Across all portfolios' : 'In this portfolio'}
              </p>
            </div>
          </div>

          {/* Holdings Table */}
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-100">Holdings</h2>
            {holdings.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <AlertCircle className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p>No holdings yet. Add your first holding to get started.</p>
                <button
                  onClick={() => navigate('/portfolio')}
                  className="mt-4 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Add Holding
                </button>
              </div>
            ) : (
              <>
              {/* Mobile Card View */}
              <div className="md:hidden space-y-3">
                {holdings.map((h) => (
                  <div key={h.id} className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="font-semibold text-gray-900 dark:text-gray-100">{h.symbol}</p>
                        {selectedPortfolioId === 'all' && h.portfolioName && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">{h.portfolioName}</p>
                        )}
                      </div>
                      <div className={`text-right ${plColor(h.unrealizedPL)}`}>
                        <p className="font-semibold">{Number(h.unrealizedPL) >= 0 ? '+' : ''}{formatCurrency(h.unrealizedPL)}</p>
                        <p className="text-xs">{Number(h.plPercent) >= 0 ? '+' : ''}{h.plPercent}%</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-gray-500 dark:text-gray-400 text-xs">Qty</p>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{h.quantity}</p>
                      </div>
                      <div>
                        <p className="text-gray-500 dark:text-gray-400 text-xs">Current</p>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{'\u20B9'}{Number(h.currentPrice).toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-gray-500 dark:text-gray-400 text-xs">Invested</p>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{formatCurrency(h.investedAmount)}</p>
                      </div>
                      <div>
                        <p className="text-gray-500 dark:text-gray-400 text-xs">Value</p>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{formatCurrency(h.currentValue)}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop Table View */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b-2 border-gray-200 dark:border-gray-700">
                      <th className="text-left py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">Symbol</th>
                      {selectedPortfolioId === 'all' && (
                        <th className="text-left py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">Portfolio</th>
                      )}
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">Qty</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">Avg Price</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">Current</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">Invested</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">Value</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">P&L</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 dark:text-gray-300 text-sm">P&L %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => (
                      <tr key={h.id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700">
                        <td className="py-3 px-3 font-semibold text-gray-900 dark:text-gray-100">{h.symbol}</td>
                        {selectedPortfolioId === 'all' && (
                          <td className="py-3 px-3 text-gray-600 dark:text-gray-400 text-sm">{h.portfolioName || '\u2014'}</td>
                        )}
                        <td className="text-right py-3 px-3 text-gray-700 dark:text-gray-300">{h.quantity}</td>
                        <td className="text-right py-3 px-3 text-gray-700 dark:text-gray-300">{'\u20B9'}{Number(h.avgPrice).toFixed(2)}</td>
                        <td className="text-right py-3 px-3 text-gray-700 dark:text-gray-300">{'\u20B9'}{Number(h.currentPrice).toFixed(2)}</td>
                        <td className="text-right py-3 px-3 text-gray-700 dark:text-gray-300">{formatCurrency(h.investedAmount)}</td>
                        <td className="text-right py-3 px-3 text-gray-700 dark:text-gray-300">{formatCurrency(h.currentValue)}</td>
                        <td className={`text-right py-3 px-3 font-semibold ${plColor(h.unrealizedPL)}`}>
                          {Number(h.unrealizedPL) >= 0 ? '+' : ''}{formatCurrency(h.unrealizedPL)}
                        </td>
                        <td className={`text-right py-3 px-3 font-semibold ${plColor(h.unrealizedPL)}`}>
                          {Number(h.plPercent) >= 0 ? '+' : ''}{h.plPercent}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>

          {/* Trade Signals */}
          {selectedPortfolioId !== 'all' && (
            <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2 mb-4">
                <Zap className="w-6 h-6 text-yellow-500" />
                <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Trade Signals</h2>
                {signals.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded-full text-xs font-semibold">
                    {signals.filter(s => s.status === 'PENDING' || s.status === 'SNOOZED').length} pending
                  </span>
                )}
                <button
                  onClick={() => loadSignals(selectedPortfolioId)}
                  className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  title="Refresh signals"
                >
                  <RefreshCw className={`w-4 h-4 ${signalsLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {/* Toast messages */}
              {signalError && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300 text-sm">
                  {signalError}
                </div>
              )}
              {signalSuccess && (
                <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-300 text-sm">
                  {signalSuccess}
                </div>
              )}

              {signalsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-yellow-500" />
                  <span className="ml-2 text-gray-500 dark:text-gray-400 text-sm">Loading signals...</span>
                </div>
              ) : signals.length === 0 && recentExecuted.length === 0 ? (
                <div className="text-center py-6 text-gray-500 dark:text-gray-400">
                  <Zap className="w-10 h-10 mx-auto mb-2 text-gray-300 dark:text-gray-600" />
                  <p className="text-sm">No pending trade signals for this portfolio.</p>
                  <p className="text-xs mt-1">Signals are generated automatically by the AI cron job.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Pending signals */}
                  {signals.map(sig => (
                    <div key={sig.id} className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-100 dark:border-gray-700">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                            sig.side === 'BUY' ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400' :
                            'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400'
                          }`}>
                            {sig.side}
                          </span>
                          <span className="font-bold text-gray-900 dark:text-gray-100">{sig.symbol}</span>
                          <span className="text-gray-500 dark:text-gray-400 text-sm">{sig.quantity}x</span>
                          {sig.status === 'PLACING' && (
                            <span className="px-2 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400 rounded text-xs font-medium">
                              Placing...
                            </span>
                          )}
                          {sig.status === 'SNOOZED' && (
                            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 rounded text-xs font-medium">
                              Snoozed
                            </span>
                          )}
                        </div>
                        {sig.confidence && (
                          <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
                            {sig.confidence}%
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 mb-2">
                        <span className="px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded font-medium">
                          {getTriggerLabel(sig)}
                        </span>
                        <span>{sig.exchange}</span>
                        <span>{new Date(sig.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>

                      {sig.rationale && (
                        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3 line-clamp-2">{sig.rationale}</p>
                      )}

                      {/* Action buttons */}
                      {sig.status !== 'PLACING' && (
                        <div className="flex items-center gap-2">
                          {isUpstoxPortfolio && (
                            <button
                              onClick={() => handleExecuteSignal(sig.id)}
                              disabled={executingSignalId === sig.id}
                              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1"
                            >
                              {executingSignalId === sig.id ? (
                                <><Loader2 className="w-3 h-3 animate-spin" /> Executing...</>
                              ) : (
                                <><Zap className="w-3 h-3" /> Execute</>
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => handleSignalAction(sig.id, 'SNOOZE_30M')}
                            disabled={signalActionId === sig.id}
                            className="px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 dark:bg-amber-900/50 dark:hover:bg-amber-900/70 dark:text-amber-300 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
                          >
                            Snooze
                          </button>
                          <button
                            onClick={() => handleSignalAction(sig.id, 'DISMISS')}
                            disabled={signalActionId === sig.id}
                            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Recently executed signals */}
                  {recentExecuted.length > 0 && (
                    <>
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-3 mt-3">
                        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">Recently Executed (24h)</p>
                      </div>
                      {recentExecuted.map(sig => (
                        <div key={sig.id} className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 border border-green-100 dark:border-green-800/50 opacity-75">
                          <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-green-600" />
                            <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                              sig.side === 'BUY' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                            }`}>{sig.side}</span>
                            <span className="font-semibold text-gray-800 dark:text-gray-200 text-sm">{sig.symbol}</span>
                            <span className="text-gray-500 dark:text-gray-400 text-xs">{sig.quantity}x</span>
                            <span className="ml-auto text-xs text-green-600 font-medium">EXECUTED</span>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* AI Recommendations */}
          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 rounded-xl p-6 shadow-md border border-indigo-200 dark:border-indigo-700">
            <div className="flex items-center gap-2 mb-4">
              <Lightbulb className="w-6 h-6 text-indigo-600" />
              <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">AI Insights</h2>
              <span className="ml-auto text-sm text-indigo-600 font-medium">
                {allRecs.length > 0 ? `${allRecs.length} active` : 'None yet'}
              </span>
            </div>

            {allRecs.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-500 dark:text-gray-400 mb-4">No AI recommendations yet. Run a scan to get personalized insights.</p>
                <button
                  onClick={() => navigate('/recommendations')}
                  className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                >
                  Generate Recommendations
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {allRecs.slice(0, 4).map((rec, idx) => (
                  <div key={idx} className="bg-white dark:bg-gray-800 rounded-lg p-5 shadow-sm border border-indigo-100 dark:border-indigo-800 hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{rec.symbol || rec.stock}</h3>
                        <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold mt-1 ${
                          rec.action === 'BUY' ? 'bg-green-100 text-green-700' :
                          rec.action === 'SELL' ? 'bg-red-100 text-red-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>
                          {rec.action}
                        </span>
                      </div>
                      {rec.confidence && (
                        <div className="text-right">
                          <p className="text-sm text-gray-500 dark:text-gray-400">Confidence</p>
                          <p className="text-xl font-bold text-indigo-600">{rec.confidence}</p>
                        </div>
                      )}
                    </div>

                    {rec.price && (
                      <div className="space-y-2 mb-3">
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600 dark:text-gray-400">Price:</span>
                          <span className="font-semibold text-gray-900 dark:text-gray-100">{'\u20B9'}{rec.price}</span>
                        </div>
                        {rec.targetPrice && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-600 dark:text-gray-400">Target:</span>
                            <span className="font-semibold text-green-600">{'\u20B9'}{rec.targetPrice}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {rec.reasoning && (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-3 line-clamp-2">{rec.reasoning}</p>
                    )}

                    <button
                      onClick={() => navigate('/recommendations')}
                      className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      View Details
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Market Status */}
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-100">Market Status</h2>
            <div className="flex items-center flex-wrap gap-2 text-sm text-gray-600 dark:text-gray-400">
              <Clock className="w-4 h-4" />
              <span>Market Hours: 9:15 AM - 3:30 PM IST (Mon-Fri)</span>
              <span className={`ml-auto px-3 py-1 rounded-full font-medium text-xs ${
                market.isOpen
                  ? 'bg-green-100 text-green-700'
                  : 'bg-red-100 text-red-700'
              }`}>
                {market.label}
              </span>
            </div>
          </div>

          {/* Quick Actions */}
          <div className={`grid grid-cols-2 ${isUpstoxPortfolio ? 'md:grid-cols-5' : 'md:grid-cols-4'} gap-4`}>
            <button
              onClick={() => navigate('/portfolio')}
              className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border-2 border-gray-200 dark:border-gray-700 rounded-xl p-4 text-center transition-all hover:shadow-md"
            >
              <div className="text-2xl mb-2">+</div>
              <p className="font-semibold text-gray-900 dark:text-gray-100">Add Holding</p>
            </button>
            <button
              onClick={handleSyncPrices}
              disabled={syncing}
              className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border-2 border-gray-200 dark:border-gray-700 rounded-xl p-4 text-center transition-all hover:shadow-md disabled:opacity-50"
            >
              <div className="text-2xl mb-2">
                <RefreshCw className={`w-6 h-6 mx-auto ${syncing ? 'animate-spin' : ''}`} />
              </div>
              <p className="font-semibold text-gray-900 dark:text-gray-100">{syncing ? 'Syncing...' : 'Sync Prices'}</p>
              {pricesAt && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">as of {pricesAt}</p>}
            </button>
            <button
              onClick={() => navigate('/insights')}
              className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border-2 border-gray-200 dark:border-gray-700 rounded-xl p-4 text-center transition-all hover:shadow-md"
            >
              <div className="text-2xl mb-2">
                <TrendingUp className="w-6 h-6 mx-auto" />
              </div>
              <p className="font-semibold text-gray-900 dark:text-gray-100">View Reports</p>
            </button>
            <button
              onClick={() => navigate('/tax')}
              className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border-2 border-gray-200 dark:border-gray-700 rounded-xl p-4 text-center transition-all hover:shadow-md"
            >
              <div className="text-2xl mb-2">
                <CheckCircle className="w-6 h-6 mx-auto" />
              </div>
              <p className="font-semibold text-gray-900 dark:text-gray-100">Tax Dashboard</p>
            </button>
            {isUpstoxPortfolio && (
              <a
                href="https://pro.upstox.com/d/funds"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border-2 border-gray-200 dark:border-gray-700 rounded-xl p-4 text-center transition-all hover:shadow-md"
              >
                <div className="text-2xl mb-2">
                  <ExternalLink className="w-6 h-6 mx-auto text-green-600" />
                </div>
                <p className="font-semibold text-gray-900 dark:text-gray-100">Withdraw Funds</p>
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
