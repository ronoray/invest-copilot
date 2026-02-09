import { useState, useEffect, useCallback } from 'react';
import { TrendingUp, TrendingDown, Target, RefreshCw, Loader2, CheckCircle, Clock, XCircle, AlertTriangle, Send, Zap } from 'lucide-react';
import { api } from '../utils/api';

export default function HoldingsAnalyzer() {
  const [portfolios, setPortfolios] = useState([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(null);
  const [holdings, setHoldings] = useState([]);
  const [dailyTarget, setDailyTarget] = useState(null);
  const [signals, setSignals] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastNotifiedAt, setLastNotifiedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshingAi, setRefreshingAi] = useState(false);
  const [generatingSignals, setGeneratingSignals] = useState(false);
  const [savingEarned, setSavingEarned] = useState(false);
  const [savingUserTarget, setSavingUserTarget] = useState(false);
  const [earnedInput, setEarnedInput] = useState('');
  const [userTargetInput, setUserTargetInput] = useState('');

  // Load portfolios
  useEffect(() => {
    loadPortfolios();
  }, []);

  // Load data when portfolio changes
  useEffect(() => {
    if (selectedPortfolioId) {
      loadAllData();
    }
  }, [selectedPortfolioId]);

  const loadPortfolios = async () => {
    try {
      const data = await api.get('/portfolio?all=true');
      const list = data.portfolios || [];
      setPortfolios(list);
      if (list.length > 0) {
        setSelectedPortfolioId(list[0].id);
      }
    } catch (err) {
      console.error('Failed to load portfolios:', err);
    }
  };

  const loadAllData = useCallback(async () => {
    if (!selectedPortfolioId) return;
    setLoading(true);
    try {
      const [holdingsData, targetData, signalsData] = await Promise.all([
        api.get(`/portfolio/${selectedPortfolioId}/holdings`),
        api.get(`/daily-target/today?portfolioId=${selectedPortfolioId}`),
        api.get(`/signals?portfolioId=${selectedPortfolioId}`)
      ]);

      setHoldings(holdingsData.holdings || []);

      if (targetData.data) {
        setDailyTarget(targetData.data);
        setEarnedInput(String(targetData.data.earnedActual || ''));
        setUserTargetInput(targetData.data.userTarget != null ? String(targetData.data.userTarget) : '');
      }

      if (signalsData.data) {
        setSignals(signalsData.data.signals || []);
        setPendingCount(signalsData.data.pendingCount || 0);
        setLastNotifiedAt(signalsData.data.lastNotifiedAt);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedPortfolioId]);

  const refreshAiTarget = async () => {
    setRefreshingAi(true);
    try {
      const data = await api.post('/daily-target/today/ai-refresh', { portfolioId: selectedPortfolioId });
      if (data.data) {
        setDailyTarget(data.data);
      }
    } catch (err) {
      console.error('Failed to refresh AI target:', err);
    } finally {
      setRefreshingAi(false);
    }
  };

  const saveEarnedActual = async () => {
    setSavingEarned(true);
    try {
      const data = await api.post('/daily-target/today', {
        portfolioId: selectedPortfolioId,
        earnedActual: parseFloat(earnedInput) || 0
      });
      if (data.data) {
        setDailyTarget(prev => ({ ...prev, ...data.data, gap: (prev?.aiTarget || 0) - (parseFloat(earnedInput) || 0) }));
      }
    } catch (err) {
      console.error('Failed to save earned:', err);
    } finally {
      setSavingEarned(false);
    }
  };

  const saveUserTarget = async () => {
    setSavingUserTarget(true);
    try {
      const val = userTargetInput.trim() === '' ? null : parseFloat(userTargetInput);
      const data = await api.post('/daily-target/today', {
        portfolioId: selectedPortfolioId,
        userTarget: val
      });
      if (data.data) {
        setDailyTarget(prev => ({ ...prev, ...data.data }));
      }
    } catch (err) {
      console.error('Failed to save user target:', err);
    } finally {
      setSavingUserTarget(false);
    }
  };

  const generateSignals = async () => {
    setGeneratingSignals(true);
    try {
      await api.post('/signals/generate', { portfolioId: selectedPortfolioId });
      // Reload signals
      const signalsData = await api.get(`/signals?portfolioId=${selectedPortfolioId}`);
      if (signalsData.data) {
        setSignals(signalsData.data.signals || []);
        setPendingCount(signalsData.data.pendingCount || 0);
      }
    } catch (err) {
      console.error('Failed to generate signals:', err);
    } finally {
      setGeneratingSignals(false);
    }
  };

  const ackSignal = async (signalId, action) => {
    try {
      await api.post(`/signals/${signalId}/ack`, { action });
      // Update local state
      setSignals(prev => prev.map(s =>
        s.id === signalId ? { ...s, status: action === 'ACK' ? 'ACKED' : action === 'SNOOZE_30M' ? 'SNOOZED' : 'DISMISSED' } : s
      ));
      setPendingCount(prev => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Failed to ack signal:', err);
    }
  };

  const formatINR = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const formatPrice = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Compute portfolio summary
  let totalValue = 0, totalInvested = 0;
  holdings.forEach(h => {
    totalInvested += h.quantity * parseFloat(h.avgPrice);
    totalValue += h.quantity * parseFloat(h.currentPrice || h.avgPrice);
  });
  const totalPL = totalValue - totalInvested;
  const totalPLPct = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

  const aiTarget = dailyTarget?.aiTarget || 0;
  const earned = dailyTarget?.earnedActual || 0;
  const gap = aiTarget - earned;
  const progressPct = aiTarget > 0 ? Math.min(100, (earned / aiTarget) * 100) : 0;

  // User target comparison
  const userTarget = dailyTarget?.userTarget;
  const showUserWarning = userTarget != null && userTarget > aiTarget;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Holdings Analyzer</h1>
          <p className="text-sm text-gray-500">Daily targets, trade signals, and portfolio performance</p>
        </div>

        {/* Portfolio Selector */}
        {portfolios.length > 0 && (
          <select
            value={selectedPortfolioId || ''}
            onChange={e => setSelectedPortfolioId(parseInt(e.target.value))}
            className="px-4 py-2 border rounded-lg text-sm bg-white"
          >
            {portfolios.map(p => (
              <option key={p.id} value={p.id}>
                {p.ownerName || p.name} - {(p.broker || '').replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-blue-500" size={32} />
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* AI Target */}
            <div className="bg-white rounded-xl shadow-sm border p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-500">AI Target</span>
                <button
                  onClick={refreshAiTarget}
                  disabled={refreshingAi}
                  className="text-blue-500 hover:text-blue-700 p-1"
                  title="Refresh AI target"
                >
                  {refreshingAi ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                </button>
              </div>
              <p className="text-2xl font-bold text-gray-900">{formatINR(aiTarget)}</p>
              {dailyTarget?.aiConfidence != null && (
                <p className="text-xs text-gray-400 mt-1">Confidence: {dailyTarget.aiConfidence}%</p>
              )}
              {dailyTarget?.aiRationale && (
                <p className="text-xs text-gray-500 mt-2 line-clamp-2">{dailyTarget.aiRationale}</p>
              )}
            </div>

            {/* User Target */}
            <div className="bg-white rounded-xl shadow-sm border p-4">
              <span className="text-sm font-medium text-gray-500">Your Target</span>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-lg text-gray-400">₹</span>
                <input
                  type="number"
                  value={userTargetInput}
                  onChange={e => setUserTargetInput(e.target.value)}
                  placeholder="Optional"
                  className="flex-1 px-2 py-1 border rounded text-lg font-bold w-full"
                />
                <button
                  onClick={saveUserTarget}
                  disabled={savingUserTarget}
                  className="px-2 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600 disabled:opacity-50"
                >
                  {savingUserTarget ? '...' : 'Set'}
                </button>
              </div>
              {showUserWarning && (
                <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                  <AlertTriangle size={12} />
                  AI suggests {formatINR(aiTarget)} is more realistic
                </p>
              )}
            </div>

            {/* Earned Actual */}
            <div className="bg-white rounded-xl shadow-sm border p-4">
              <span className="text-sm font-medium text-gray-500">Earned Today</span>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-lg text-gray-400">₹</span>
                <input
                  type="number"
                  value={earnedInput}
                  onChange={e => setEarnedInput(e.target.value)}
                  placeholder="0"
                  className="flex-1 px-2 py-1 border rounded text-lg font-bold w-full"
                />
                <button
                  onClick={saveEarnedActual}
                  disabled={savingEarned}
                  className="px-2 py-1 bg-green-500 text-white rounded text-sm hover:bg-green-600 disabled:opacity-50"
                >
                  {savingEarned ? '...' : 'Save'}
                </button>
              </div>
            </div>

            {/* Gap + Progress */}
            <div className="bg-white rounded-xl shadow-sm border p-4">
              <span className="text-sm font-medium text-gray-500">Gap</span>
              <p className={`text-2xl font-bold ${gap > 0 ? 'text-red-600' : gap < 0 ? 'text-green-600' : 'text-gray-900'}`}>
                {gap > 0 ? `-${formatINR(gap)}` : gap < 0 ? `+${formatINR(Math.abs(gap))}` : 'On target'}
              </p>
              <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${progressPct >= 100 ? 'bg-green-500' : progressPct >= 50 ? 'bg-blue-500' : 'bg-amber-500'}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">{progressPct.toFixed(0)}% of AI target</p>
            </div>
          </div>

          {/* Holdings Table */}
          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Holdings ({holdings.length})</h2>
              <div className="text-sm text-gray-500">
                Value: {formatPrice(totalValue)} | P&L:{' '}
                <span className={totalPL >= 0 ? 'text-green-600' : 'text-red-600'}>
                  {formatPrice(totalPL)} ({totalPLPct.toFixed(2)}%)
                </span>
              </div>
            </div>
            {holdings.length === 0 ? (
              <p className="px-4 py-8 text-center text-gray-400">No holdings in this portfolio</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-gray-500">Symbol</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500">Qty</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500">Avg Price</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500">Current</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500">P&L</th>
                      <th className="px-4 py-2 text-right font-medium text-gray-500">P&L %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {holdings.map(h => {
                      const invested = h.quantity * parseFloat(h.avgPrice);
                      const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
                      const pl = current - invested;
                      const plPct = invested > 0 ? (pl / invested) * 100 : 0;
                      return (
                        <tr key={h.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-medium">{h.symbol}</td>
                          <td className="px-4 py-2 text-right">{h.quantity}</td>
                          <td className="px-4 py-2 text-right">{formatPrice(h.avgPrice)}</td>
                          <td className="px-4 py-2 text-right">{formatPrice(h.currentPrice || h.avgPrice)}</td>
                          <td className={`px-4 py-2 text-right ${pl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatPrice(pl)}
                          </td>
                          <td className={`px-4 py-2 text-right ${plPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {plPct >= 0 ? '+' : ''}{plPct.toFixed(2)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recommendations Panel */}
          <div className="bg-white rounded-xl shadow-sm border">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Trade Signals</h2>
              <button
                onClick={generateSignals}
                disabled={generatingSignals}
                className="flex items-center gap-2 px-3 py-1.5 bg-blue-500 text-white rounded-lg text-sm hover:bg-blue-600 disabled:opacity-50"
              >
                {generatingSignals ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                {generatingSignals ? 'Generating...' : 'Generate Signals'}
              </button>
            </div>

            {signals.length === 0 ? (
              <p className="px-4 py-8 text-center text-gray-400">
                No signals yet. Click "Generate Signals" to get AI recommendations.
              </p>
            ) : (
              <div className="divide-y">
                {signals.map(sig => {
                  const isBuy = sig.side === 'BUY';
                  const isPending = sig.status === 'PENDING' || sig.status === 'SNOOZED';
                  return (
                    <div key={sig.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-bold text-white ${isBuy ? 'bg-green-500' : 'bg-red-500'}`}>
                            {sig.side}
                          </span>
                          <span className="font-semibold">{sig.symbol}</span>
                          <span className="text-xs text-gray-400">{sig.exchange}</span>
                          <span className="text-xs text-gray-400">Qty: {sig.quantity}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                          {sig.triggerType === 'MARKET' && <span>At Market</span>}
                          {sig.triggerType === 'LIMIT' && <span>Limit: {formatPrice(sig.triggerPrice)}</span>}
                          {sig.triggerType === 'ZONE' && <span>Zone: {formatPrice(sig.triggerLow)} - {formatPrice(sig.triggerHigh)}</span>}
                          <span>Confidence: {sig.confidence}%</span>
                        </div>
                        {sig.rationale && (
                          <p className="text-xs text-gray-500 mt-1">{sig.rationale}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {isPending ? (
                          <>
                            <button
                              onClick={() => ackSignal(sig.id, 'ACK')}
                              className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs hover:bg-green-200"
                            >
                              <CheckCircle size={12} className="inline mr-1" />ACK
                            </button>
                            <button
                              onClick={() => ackSignal(sig.id, 'SNOOZE_30M')}
                              className="px-2 py-1 bg-amber-100 text-amber-700 rounded text-xs hover:bg-amber-200"
                            >
                              <Clock size={12} className="inline mr-1" />Snooze
                            </button>
                            <button
                              onClick={() => ackSignal(sig.id, 'DISMISS')}
                              className="px-2 py-1 bg-red-100 text-red-700 rounded text-xs hover:bg-red-200"
                            >
                              <XCircle size={12} className="inline mr-1" />Dismiss
                            </button>
                          </>
                        ) : (
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            sig.status === 'ACKED' ? 'bg-green-100 text-green-700' :
                            sig.status === 'DISMISSED' ? 'bg-gray-100 text-gray-500' :
                            sig.status === 'EXPIRED' ? 'bg-gray-100 text-gray-400' :
                            'bg-amber-100 text-amber-700'
                          }`}>
                            {sig.status}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Telegram Status */}
          <div className="bg-white rounded-xl shadow-sm border p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Send size={18} className="text-blue-500" />
              <div>
                <p className="text-sm font-medium text-gray-700">Telegram Alerts</p>
                <p className="text-xs text-gray-400">
                  {pendingCount > 0
                    ? `${pendingCount} pending signal${pendingCount > 1 ? 's' : ''} (repeats every 30 min)`
                    : 'No pending signals'}
                  {lastNotifiedAt && ` | Last push: ${new Date(lastNotifiedAt).toLocaleTimeString('en-IN')}`}
                </p>
              </div>
            </div>
          </div>

          {/* Disclaimer */}
          <p className="text-xs text-gray-400 text-center">
            This is decision support, not financial advice. Always do your own research before trading.
          </p>
        </>
      )}
    </div>
  );
}
