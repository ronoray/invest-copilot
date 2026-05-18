import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, PieChart, Pie, Cell, Legend
} from 'recharts';
import {
  TrendingUp, TrendingDown, AlertTriangle, Target, Award, BookOpen,
  Plus, Trash2, ChevronDown, ChevronUp, RefreshCw, CheckCircle, Clock,
  XCircle, BarChart2, Loader2
} from 'lucide-react';
import { api } from '../utils/api';

const MISTAKE_CATEGORIES = [
  'BAD_ENTRY', 'LATE_ENTRY', 'EARLY_EXIT', 'LATE_EXIT',
  'STOP_LOSS_TOO_WIDE', 'STOP_LOSS_TOO_TIGHT', 'NO_STOP_LOSS',
  'OVERTRADING', 'POOR_RISK_REWARD', 'IGNORED_TREND',
  'NEWS_RISK', 'LOW_CONFIDENCE_TRADE', 'CLAUDE_REASONING_ERROR',
  'DATA_QUALITY', 'USER_OVERRIDE', 'UNKNOWN',
];

const PIE_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];

export default function Performance() {
  const [portfolios, setPortfolios] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Data
  const [metrics, setMetrics] = useState(null);
  const [equityCurve, setEquityCurve] = useState(null);
  const [monthlyPnl, setMonthlyPnl] = useState([]);
  const [trades, setTrades] = useState([]);
  const [tradesMeta, setTradesMeta] = useState({ total: 0, page: 1, totalPages: 1 });
  const [signalQuality, setSignalQuality] = useState(null);
  const [learning, setLearning] = useState(null);

  // Trade filters
  const [tradeFilter, setTradeFilter] = useState({ symbol: '', type: '', dateFrom: '', dateTo: '', page: 1 });

  // Mistake form
  const [showMistakeForm, setShowMistakeForm] = useState(false);
  const [mistakeForm, setMistakeForm] = useState({
    symbol: '', mistakeCategory: 'BAD_ENTRY', description: '', reason: '', lesson: '', pnlImpact: ''
  });

  // Rule form
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState({ title: '', description: '' });

  const [saving, setSaving] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);

  useEffect(() => {
    loadPortfolios();
  }, []);

  useEffect(() => {
    if (selectedId) loadAll();
  }, [selectedId]);

  useEffect(() => {
    if (selectedId && tab === 'trades') loadTrades();
  }, [selectedId, tab, tradeFilter]);

  async function loadPortfolios() {
    try {
      const data = await api.get('/portfolio?all=true');
      const list = data.portfolios || [];
      setPortfolios(list);
      if (list.length > 0) setSelectedId(list[0].id);
    } catch (e) {
      setError('Failed to load portfolios');
    }
  }

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [m, ec, mp, sq, lrn] = await Promise.all([
        api.get(`/performance/${selectedId}/overview`),
        api.get(`/performance/${selectedId}/equity-curve`),
        api.get(`/performance/${selectedId}/monthly-pnl`),
        api.get(`/performance/${selectedId}/signal-quality`),
        api.get(`/performance/${selectedId}/learning`),
      ]);
      setMetrics(m);
      setEquityCurve(ec);
      setMonthlyPnl(mp.monthly || []);
      setSignalQuality(sq);
      setLearning(lrn);
    } catch (e) {
      setError('Failed to load performance data');
    } finally {
      setLoading(false);
    }
  }

  async function loadTrades() {
    try {
      const params = new URLSearchParams({
        page: tradeFilter.page,
        pageSize: 50,
        ...(tradeFilter.symbol && { symbol: tradeFilter.symbol }),
        ...(tradeFilter.type && { type: tradeFilter.type }),
        ...(tradeFilter.dateFrom && { dateFrom: tradeFilter.dateFrom }),
        ...(tradeFilter.dateTo && { dateTo: tradeFilter.dateTo }),
      });
      const data = await api.get(`/performance/${selectedId}/trades?${params}`);
      setTrades(data.trades || []);
      setTradesMeta({ total: data.total, page: data.page, totalPages: data.totalPages });
    } catch (e) {
      console.error('Trade load error:', e);
    }
  }

  async function takeSnapshot() {
    setSnapshotting(true);
    try {
      await api.post(`/performance/${selectedId}/snapshot`, {});
      await loadAll();
    } catch (e) {
      alert('Snapshot failed: ' + (e.message || 'Unknown error'));
    } finally {
      setSnapshotting(false);
    }
  }

  async function submitMistake(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/performance/${selectedId}/mistakes`, {
        ...mistakeForm,
        pnlImpact: mistakeForm.pnlImpact ? -Math.abs(parseFloat(mistakeForm.pnlImpact)) : null,
      });
      setShowMistakeForm(false);
      setMistakeForm({ symbol: '', mistakeCategory: 'BAD_ENTRY', description: '', reason: '', lesson: '', pnlImpact: '' });
      await loadAll();
    } catch (e) {
      alert('Failed to save: ' + (e.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  }

  async function deleteMistake(id) {
    if (!confirm('Delete this mistake entry?')) return;
    try {
      await api.delete(`/performance/${selectedId}/mistakes/${id}`);
      await loadAll();
    } catch (e) {
      alert('Delete failed');
    }
  }

  async function submitRule(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/performance/${selectedId}/rules`, ruleForm);
      setShowRuleForm(false);
      setRuleForm({ title: '', description: '' });
      await loadAll();
    } catch (e) {
      alert('Failed to save: ' + (e.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  }

  async function updateRuleStatus(id, status) {
    try {
      await api.put(`/performance/${selectedId}/rules/${id}`, { status });
      await loadAll();
    } catch (e) {
      alert('Update failed');
    }
  }

  async function deleteRule(id) {
    if (!confirm('Delete this rule?')) return;
    try {
      await api.delete(`/performance/${selectedId}/rules/${id}`);
      await loadAll();
    } catch (e) {
      alert('Delete failed');
    }
  }

  const fmt = (n, decimals = 2) => {
    if (n === null || n === undefined) return '–';
    return new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
  };

  const fmtCur = (n) => {
    if (n === null || n === undefined) return '–';
    return '₹' + fmt(n);
  };

  const pnlColor = (v) => v > 0 ? 'text-green-600 dark:text-green-400' : v < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400';
  const pnlBg = (v) => v > 0 ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : v < 0 ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700';

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Performance &amp; Learning</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Equity curve, trade analysis, signal quality, and learning ledger</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedId || ''}
            onChange={e => setSelectedId(parseInt(e.target.value))}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          >
            {portfolios.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={takeSnapshot}
            disabled={!selectedId || snapshotting}
            className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {snapshotting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Snapshot Today
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-blue-600" />
        </div>
      )}

      {!loading && metrics && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard label="Starting Capital" value={fmtCur(metrics.startingCapital)} icon={<Target size={16} />} />
            <MetricCard label="Current Equity" value={fmtCur(metrics.currentEquity)} icon={<TrendingUp size={16} />} highlight={metrics.netPnl >= 0 ? 'green' : 'red'} />
            <MetricCard label="Net P&L" value={fmtCur(metrics.netPnl)} sub={fmt(metrics.returnPct) + '%'} highlight={metrics.netPnl >= 0 ? 'green' : 'red'} icon={metrics.netPnl >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} />
            <MetricCard label="Max Drawdown" value={fmt(metrics.maxDrawdown) + '%'} highlight="red" icon={<AlertTriangle size={16} />} />
            <MetricCard label="Win Rate" value={fmt(metrics.winRate) + '%'} sub={`${metrics.winCount}W / ${metrics.lossCount}L`} icon={<Award size={16} />} />
            <MetricCard label="Profit Factor" value={isFinite(metrics.profitFactor) ? fmt(metrics.profitFactor) : '∞'} icon={<BarChart2 size={16} />} highlight={metrics.profitFactor >= 1.5 ? 'green' : metrics.profitFactor >= 1 ? 'yellow' : 'red'} />
            <MetricCard label="Avg Win" value={fmtCur(metrics.avgWin)} highlight="green" />
            <MetricCard label="Avg Loss" value={fmtCur(Math.abs(metrics.avgLoss))} highlight="red" />
            <MetricCard label="Expectancy/Trade" value={fmtCur(metrics.expectancy)} highlight={metrics.expectancy >= 0 ? 'green' : 'red'} />
            <MetricCard label="Signal Accuracy" value={metrics.signalAccuracy !== null ? fmt(metrics.signalAccuracy) + '%' : '–'} sub={`${metrics.totalSignals} signals`} icon={<BookOpen size={16} />} />
            <MetricCard label="Max Consec. Losses" value={metrics.maxConsecutiveLosses} highlight="red" />
            <MetricCard label="Total Trades" value={metrics.totalTrades} />
          </div>

          {/* Tabs */}
          <div className="border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
            <nav className="flex -mb-px gap-0 min-w-max">
              {[['overview', 'Equity & P&L'], ['trades', 'Trade Journal'], ['signals', 'Signal Quality'], ['learning', 'Learning']].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                    tab === key
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* TAB: OVERVIEW */}
          {tab === 'overview' && (
            <div className="space-y-6">
              {/* Equity Curve */}
              <ChartCard title="Equity Curve" subtitle={equityCurve ? `Source: ${equityCurve.source}` : ''}>
                {equityCurve && equityCurve.points.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={equityCurve.points} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" strokeOpacity={0.3} />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d.slice(5)} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={v => '₹' + (v >= 1000 ? Math.round(v / 1000) + 'k' : v)} />
                      <Tooltip
                        formatter={(v, name) => ['₹' + fmt(v), name]}
                        labelFormatter={l => 'Date: ' + l}
                        contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px', fontSize: '12px' }}
                        labelStyle={{ color: '#9ca3af' }}
                      />
                      <ReferenceLine y={equityCurve.startingCapital} stroke="#6b7280" strokeDasharray="4 4" label={{ value: 'Start', fill: '#6b7280', fontSize: 11 }} />
                      <Line type="monotone" dataKey="equity" stroke="#3b82f6" strokeWidth={2} dot={false} name="Equity" />
                      <Line type="monotone" dataKey="peakEquity" stroke="#22c55e" strokeWidth={1} strokeDasharray="3 3" dot={false} name="Peak" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState msg="No equity data. Record daily earnings in Your Plan, or take a snapshot." />
                )}
              </ChartCard>

              {/* Drawdown */}
              {equityCurve && equityCurve.points.length > 0 && equityCurve.points.some(p => p.drawdownPct < 0) && (
                <ChartCard title="Drawdown" subtitle="% below peak equity">
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={equityCurve.points} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" strokeOpacity={0.3} />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d.slice(5)} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={v => v + '%'} />
                      <Tooltip
                        formatter={(v) => [fmt(v) + '%', 'Drawdown']}
                        contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px', fontSize: '12px' }}
                      />
                      <Bar dataKey="drawdownPct" fill="#ef4444" fillOpacity={0.7} name="Drawdown" />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              )}

              {/* Monthly P&L */}
              <ChartCard title="Monthly P&L">
                {monthlyPnl.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={monthlyPnl} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" strokeOpacity={0.3} />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={v => '₹' + v} />
                      <Tooltip
                        formatter={(v) => ['₹' + fmt(v), 'P&L']}
                        contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px', fontSize: '12px' }}
                      />
                      <ReferenceLine y={0} stroke="#6b7280" />
                      <Bar dataKey="pnl" name="P&L" isAnimationActive={false}>
                        {monthlyPnl.map((entry, index) => (
                          <Cell key={index} fill={entry.pnl >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={0.8} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState msg="No monthly P&L data yet." />
                )}
              </ChartCard>

              {/* Win/Loss Breakdown */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <ChartCard title="Trade Distribution">
                  {metrics.totalTrades > 0 ? (
                    <div className="flex items-center gap-6">
                      <PieChart width={140} height={140}>
                        <Pie
                          data={[
                            { name: 'Wins', value: metrics.winCount },
                            { name: 'Losses', value: metrics.lossCount },
                          ]}
                          cx={65} cy={65} innerRadius={40} outerRadius={65}
                          dataKey="value"
                        >
                          <Cell fill="#22c55e" />
                          <Cell fill="#ef4444" />
                        </Pie>
                        <Tooltip contentStyle={{ fontSize: '12px' }} />
                      </PieChart>
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full bg-green-500 inline-block" />
                          <span className="text-gray-700 dark:text-gray-300">Wins: {metrics.winCount} ({fmt(metrics.winRate)}%)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full bg-red-500 inline-block" />
                          <span className="text-gray-700 dark:text-gray-300">Losses: {metrics.lossCount} ({fmt(metrics.lossRate)}%)</span>
                        </div>
                        <div className="text-gray-500 dark:text-gray-400 pt-1 border-t border-gray-200 dark:border-gray-700">
                          <div>Gross Profit: <span className="text-green-600">₹{fmt(metrics.grossProfit)}</span></div>
                          <div>Gross Loss: <span className="text-red-600">₹{fmt(metrics.grossLoss)}</span></div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <EmptyState msg="No completed trades yet." />
                  )}
                </ChartCard>

                <ChartCard title="Notable Trades">
                  <div className="space-y-3 text-sm">
                    {metrics.bestTrade && (
                      <div className="flex items-center justify-between p-2 bg-green-50 dark:bg-green-900/20 rounded-lg">
                        <div>
                          <div className="font-medium text-gray-900 dark:text-white">Best: {metrics.bestTrade.symbol}</div>
                          <div className="text-xs text-gray-500">{new Date(metrics.bestTrade.date).toLocaleDateString('en-IN')}</div>
                        </div>
                        <span className="font-bold text-green-600">+₹{fmt(metrics.bestTrade.profit)}</span>
                      </div>
                    )}
                    {metrics.worstTrade && (
                      <div className="flex items-center justify-between p-2 bg-red-50 dark:bg-red-900/20 rounded-lg">
                        <div>
                          <div className="font-medium text-gray-900 dark:text-white">Worst: {metrics.worstTrade.symbol}</div>
                          <div className="text-xs text-gray-500">{new Date(metrics.worstTrade.date).toLocaleDateString('en-IN')}</div>
                        </div>
                        <span className="font-bold text-red-600">₹{fmt(metrics.worstTrade.profit)}</span>
                      </div>
                    )}
                    {!metrics.bestTrade && !metrics.worstTrade && (
                      <EmptyState msg="No trade history." />
                    )}
                  </div>
                </ChartCard>
              </div>
            </div>
          )}

          {/* TAB: TRADES */}
          {tab === 'trades' && (
            <div className="space-y-4">
              {/* Filters */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <input type="text" placeholder="Symbol" value={tradeFilter.symbol}
                  onChange={e => setTradeFilter(f => ({ ...f, symbol: e.target.value, page: 1 }))}
                  className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
                <select value={tradeFilter.type}
                  onChange={e => setTradeFilter(f => ({ ...f, type: e.target.value, page: 1 }))}
                  className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="">All Types</option>
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                </select>
                <input type="date" value={tradeFilter.dateFrom}
                  onChange={e => setTradeFilter(f => ({ ...f, dateFrom: e.target.value, page: 1 }))}
                  className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
                <input type="date" value={tradeFilter.dateTo}
                  onChange={e => setTradeFilter(f => ({ ...f, dateTo: e.target.value, page: 1 }))}
                  className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{tradesMeta.total} trades</div>

              {/* Table */}
              <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-800">
                    <tr>
                      {['Date', 'Symbol', 'Type', 'Qty', 'Price', 'P&L', 'P&L %', 'Source'].map(h => (
                        <th key={h} className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {trades.map(t => (
                      <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                        <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">
                          {new Date(t.executedAt).toLocaleDateString('en-IN')}
                        </td>
                        <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-white">{t.symbol}</td>
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${t.type === 'BUY' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'}`}>
                            {t.type}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-700 dark:text-gray-300">{t.quantity}</td>
                        <td className="px-3 py-2.5 text-gray-700 dark:text-gray-300">₹{fmt(t.price)}</td>
                        <td className={`px-3 py-2.5 font-medium ${t.profit != null ? pnlColor(t.profit) : 'text-gray-400'}`}>
                          {t.profit != null ? (t.profit >= 0 ? '+' : '') + '₹' + fmt(t.profit) : '–'}
                        </td>
                        <td className={`px-3 py-2.5 ${t.profitPct != null ? pnlColor(t.profitPct) : 'text-gray-400'}`}>
                          {t.profitPct != null ? (t.profitPct >= 0 ? '+' : '') + fmt(t.profitPct) + '%' : '–'}
                        </td>
                        <td className="px-3 py-2.5 text-gray-400 text-xs">{t.source}</td>
                      </tr>
                    ))}
                    {trades.length === 0 && (
                      <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400 text-sm">No trades found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {tradesMeta.totalPages > 1 && (
                <div className="flex items-center justify-between text-sm">
                  <button onClick={() => setTradeFilter(f => ({ ...f, page: f.page - 1 }))} disabled={tradeFilter.page <= 1}
                    className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40">
                    Previous
                  </button>
                  <span className="text-gray-500">Page {tradesMeta.page} of {tradesMeta.totalPages}</span>
                  <button onClick={() => setTradeFilter(f => ({ ...f, page: f.page + 1 }))} disabled={tradeFilter.page >= tradesMeta.totalPages}
                    className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40">
                    Next
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB: SIGNALS */}
          {tab === 'signals' && signalQuality && (
            <div className="space-y-6">
              {/* Signal summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard label="Total Signals" value={signalQuality.total} />
                <MetricCard label="Executed" value={signalQuality.executed} />
                <MetricCard label="With Outcome" value={signalQuality.withOutcome} />
                <MetricCard label="Signal Accuracy" value={signalQuality.accuracy !== null ? fmt(signalQuality.accuracy) + '%' : '–'} highlight={signalQuality.accuracy >= 50 ? 'green' : 'red'} />
                <MetricCard label="Wins" value={signalQuality.wins} highlight="green" />
                <MetricCard label="Losses" value={signalQuality.losses} highlight="red" />
                <MetricCard label="Signal P&L" value={fmtCur(signalQuality.totalSignalPnl)} highlight={signalQuality.totalSignalPnl >= 0 ? 'green' : 'red'} />
                <MetricCard label="Dismissed" value={signalQuality.dismissed} />
              </div>

              {/* Confidence vs outcome */}
              {signalQuality.confVsOutcome.some(c => c.total > 0) && (
                <ChartCard title="Confidence Band vs Outcome">
                  <div className="space-y-3">
                    {signalQuality.confVsOutcome.map(band => (
                      <div key={band.band} className="flex items-center gap-3">
                        <span className="w-28 text-xs text-gray-500 shrink-0">{band.band}</span>
                        <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-5 overflow-hidden">
                          {band.total > 0 && (
                            <div
                              className="h-full bg-green-500 rounded-full transition-all"
                              style={{ width: `${(band.wins / band.total) * 100}%` }}
                            />
                          )}
                        </div>
                        <span className="text-xs text-gray-500 w-20 text-right">
                          {band.total > 0 ? `${band.wins}/${band.total} (${Math.round(band.wins / band.total * 100)}%)` : 'No data'}
                        </span>
                      </div>
                    ))}
                  </div>
                </ChartCard>
              )}

              {/* Recent signals */}
              <ChartCard title="Recent Signals">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700">
                        {['Date', 'Symbol', 'Side', 'Conf.', 'Status', 'Outcome', 'P&L'].map(h => (
                          <th key={h} className="text-left pb-2 px-2 text-xs text-gray-500 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {signalQuality.recentSignals.map(s => (
                        <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                          <td className="px-2 py-2 text-gray-400 text-xs whitespace-nowrap">{new Date(s.createdAt).toLocaleDateString('en-IN')}</td>
                          <td className="px-2 py-2 font-medium text-gray-900 dark:text-white">{s.symbol}</td>
                          <td className="px-2 py-2">
                            <span className={`text-xs font-medium ${s.side === 'BUY' ? 'text-green-600' : 'text-red-600'}`}>{s.side}</span>
                          </td>
                          <td className="px-2 py-2 text-gray-600 dark:text-gray-400">{s.confidence}%</td>
                          <td className="px-2 py-2">
                            <StatusBadge status={s.status} />
                          </td>
                          <td className="px-2 py-2">
                            {s.outcome ? <OutcomeBadge outcome={s.outcome} /> : <span className="text-gray-400 text-xs">–</span>}
                          </td>
                          <td className={`px-2 py-2 text-xs font-medium ${s.realizedPnl != null ? pnlColor(s.realizedPnl) : 'text-gray-400'}`}>
                            {s.realizedPnl != null ? (s.realizedPnl >= 0 ? '+' : '') + '₹' + fmt(s.realizedPnl) : '–'}
                          </td>
                        </tr>
                      ))}
                      {signalQuality.recentSignals.length === 0 && (
                        <tr><td colSpan={7} className="px-2 py-6 text-center text-gray-400 text-sm">No signals found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </ChartCard>
            </div>
          )}

          {/* TAB: LEARNING */}
          {tab === 'learning' && learning && (
            <div className="space-y-6">
              {/* Summary row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard label="Total Mistakes Logged" value={learning.mistakes.length} />
                <MetricCard label="Total Loss from Mistakes" value={fmtCur(Math.abs(learning.totalMistakeLoss))} highlight="red" />
                <MetricCard label="Active Rules" value={learning.implementedRules} highlight="green" />
                <MetricCard label="Pending Rules" value={learning.pendingRules} />
              </div>

              {/* Top mistake categories */}
              {learning.topMistakes.length > 0 && (
                <ChartCard title="Most Common Mistakes">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      {learning.topMistakes.slice(0, 8).map((m, i) => (
                        <div key={m.category} className="flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white"
                            style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}>
                            {i + 1}
                          </span>
                          <span className="flex-1 text-sm text-gray-700 dark:text-gray-300">{m.category.replace(/_/g, ' ')}</span>
                          <span className="text-sm font-medium text-gray-900 dark:text-white">{m.count}</span>
                        </div>
                      ))}
                    </div>
                    <PieChart width={200} height={200}>
                      <Pie
                        data={learning.topMistakes.slice(0, 7).map(m => ({ name: m.category, value: m.count }))}
                        cx={95} cy={95} outerRadius={80} dataKey="value"
                      >
                        {learning.topMistakes.slice(0, 7).map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v, n) => [v, n.replace(/_/g, ' ')]} contentStyle={{ fontSize: '11px' }} />
                    </PieChart>
                  </div>
                </ChartCard>
              )}

              {/* Mistake Ledger */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-gray-900 dark:text-white">Mistake Ledger</h3>
                  <button onClick={() => setShowMistakeForm(!showMistakeForm)}
                    className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700">
                    <Plus size={14} /> Log Mistake
                  </button>
                </div>

                {showMistakeForm && (
                  <form onSubmit={submitMistake} className="mb-4 p-4 border border-red-200 dark:border-red-800 rounded-xl bg-red-50 dark:bg-red-900/10 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input required placeholder="Symbol *" value={mistakeForm.symbol}
                        onChange={e => setMistakeForm(f => ({ ...f, symbol: e.target.value }))}
                        className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <select value={mistakeForm.mistakeCategory}
                        onChange={e => setMistakeForm(f => ({ ...f, mistakeCategory: e.target.value }))}
                        className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500">
                        {MISTAKE_CATEGORIES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                      </select>
                    </div>
                    <textarea required placeholder="What happened? *" value={mistakeForm.description}
                      onChange={e => setMistakeForm(f => ({ ...f, description: e.target.value }))}
                      rows={2} className="input-field w-full" />
                    <textarea placeholder="Why did it happen?" value={mistakeForm.reason}
                      onChange={e => setMistakeForm(f => ({ ...f, reason: e.target.value }))}
                      rows={2} className="input-field w-full" />
                    <textarea placeholder="Rule to prevent this next time" value={mistakeForm.lesson}
                      onChange={e => setMistakeForm(f => ({ ...f, lesson: e.target.value }))}
                      rows={2} className="input-field w-full" />
                    <input type="number" placeholder="Loss amount ₹ (positive number)" value={mistakeForm.pnlImpact}
                      onChange={e => setMistakeForm(f => ({ ...f, pnlImpact: e.target.value }))}
                      className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <div className="flex gap-2">
                      <button type="submit" disabled={saving}
                        className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50">
                        {saving ? 'Saving...' : 'Save Mistake'}
                      </button>
                      <button type="button" onClick={() => setShowMistakeForm(false)}
                        className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm">
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                <div className="space-y-3">
                  {learning.mistakes.length === 0 && (
                    <div className="py-8 text-center text-gray-400 text-sm border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
                      No mistakes logged yet. Start recording to learn from losses.
                    </div>
                  )}
                  {learning.mistakes.map(m => (
                    <MistakeCard key={m.id} m={m} onDelete={() => deleteMistake(m.id)} />
                  ))}
                </div>
              </section>

              {/* Learning Rules */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-gray-900 dark:text-white">Rules Generated From Losses</h3>
                  <button onClick={() => setShowRuleForm(!showRuleForm)}
                    className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
                    <Plus size={14} /> Add Rule
                  </button>
                </div>

                {showRuleForm && (
                  <form onSubmit={submitRule} className="mb-4 p-4 border border-blue-200 dark:border-blue-800 rounded-xl bg-blue-50 dark:bg-blue-900/10 space-y-3">
                    <input required placeholder="Rule title *" value={ruleForm.title}
                      onChange={e => setRuleForm(f => ({ ...f, title: e.target.value }))}
                      className="input-field w-full" />
                    <textarea required placeholder="Description — what to do / not do *" value={ruleForm.description}
                      onChange={e => setRuleForm(f => ({ ...f, description: e.target.value }))}
                      rows={3} className="input-field w-full" />
                    <div className="flex gap-2">
                      <button type="submit" disabled={saving}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                        {saving ? 'Saving...' : 'Save Rule'}
                      </button>
                      <button type="button" onClick={() => setShowRuleForm(false)}
                        className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm">
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                <div className="space-y-3">
                  {learning.rules.length === 0 && (
                    <div className="py-8 text-center text-gray-400 text-sm border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
                      No rules yet. Add rules to track what changes after each loss.
                    </div>
                  )}
                  {learning.rules.map(r => (
                    <RuleCard key={r.id} r={r} onStatusChange={(s) => updateRuleStatus(r.id, s)} onDelete={() => deleteRule(r.id)} />
                  ))}
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, icon, highlight }) {
  const highlightClass = {
    green: 'border-green-200 dark:border-green-800',
    red: 'border-red-200 dark:border-red-800',
    yellow: 'border-yellow-200 dark:border-yellow-800',
  }[highlight] || 'border-gray-200 dark:border-gray-700';

  return (
    <div className={`bg-white dark:bg-gray-800 rounded-xl border p-3 sm:p-4 ${highlightClass}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
        {icon && <span className="text-gray-400">{icon}</span>}
      </div>
      <div className="text-base sm:text-lg font-bold text-gray-900 dark:text-white">{value}</div>
      {sub && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, subtitle, children }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="mb-3">
        <h3 className="font-semibold text-gray-900 dark:text-white">{title}</h3>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ msg }) {
  return (
    <div className="py-8 text-center text-sm text-gray-400">
      {msg}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    PENDING: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    EXECUTED: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    DISMISSED: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
    EXPIRED: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-500',
    SNOOZED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  };
  return <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${map[status] || 'bg-gray-100 text-gray-600'}`}>{status}</span>;
}

function OutcomeBadge({ outcome }) {
  const map = {
    PROFIT: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    LOSS: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    BREAKEVEN: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  };
  return <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${map[outcome] || ''}`}>{outcome}</span>;
}

function MistakeCard({ m, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const categoryLabel = m.mistakeCategory.replace(/_/g, ' ');
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 shrink-0">
            {categoryLabel}
          </span>
          <span className="font-medium text-sm text-gray-900 dark:text-white shrink-0">{m.symbol}</span>
          <span className="text-sm text-gray-500 dark:text-gray-400 truncate hidden sm:block">{m.description.slice(0, 60)}{m.description.length > 60 ? '…' : ''}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {m.pnlImpact != null && (
            <span className="text-xs font-medium text-red-600">₹{Math.abs(m.pnlImpact).toLocaleString('en-IN')}</span>
          )}
          {m.ruleImplemented && <CheckCircle size={14} className="text-green-500" />}
          {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-700 p-3 space-y-2 bg-gray-50 dark:bg-gray-800/30">
          <Field label="What happened" value={m.description} />
          {m.reason && <Field label="Why" value={m.reason} />}
          {m.lesson && <Field label="Lesson / Rule" value={m.lesson} highlight />}
          <div className="flex items-center gap-2 pt-1">
            <span className={`text-xs px-2 py-0.5 rounded ${m.ruleImplemented ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
              {m.ruleImplemented ? 'Rule implemented' : 'Rule not yet implemented'}
            </span>
            <button onClick={onDelete} className="ml-auto text-red-400 hover:text-red-600 p-1">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleCard({ r, onStatusChange, onDelete }) {
  const statusConfig = {
    PROPOSED: { icon: <Clock size={14} />, color: 'text-yellow-600', bg: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800' },
    ACTIVE: { icon: <CheckCircle size={14} />, color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' },
    REJECTED: { icon: <XCircle size={14} />, color: 'text-gray-400', bg: 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700' },
  };
  const cfg = statusConfig[r.status] || statusConfig.PROPOSED;
  return (
    <div className={`border rounded-xl p-3 ${cfg.bg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={cfg.color}>{cfg.icon}</span>
            <span className="font-medium text-sm text-gray-900 dark:text-white">{r.title}</span>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300">{r.description}</p>
          {r.impact != null && (
            <p className="text-xs text-green-600 mt-1">Impact: +{r.impact}% improvement</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {r.status !== 'ACTIVE' && (
            <button onClick={() => onStatusChange('ACTIVE')}
              className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700">
              Activate
            </button>
          )}
          {r.status === 'PROPOSED' && (
            <button onClick={() => onStatusChange('REJECTED')}
              className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300">
              Reject
            </button>
          )}
          <button onClick={onDelete} className="text-red-400 hover:text-red-600 p-1">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, highlight }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-400 mb-0.5">{label}</div>
      <div className={`text-sm ${highlight ? 'text-blue-700 dark:text-blue-300 font-medium' : 'text-gray-700 dark:text-gray-300'}`}>{value}</div>
    </div>
  );
}
