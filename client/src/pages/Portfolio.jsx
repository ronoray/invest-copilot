import { useState, useEffect } from 'react';
import { RefreshCw, Plus, TrendingUp, TrendingDown, Settings, Trash2, DollarSign, Loader2 } from 'lucide-react';
import { api } from '../utils/api';
import { portfolio as portfolioApi } from '../api/client';
import PortfolioFormModal from '../components/PortfolioFormModal';
import PortfolioCompletenessAlert from '../components/PortfolioCompletenessAlert';
import CapitalChangeModal from '../components/CapitalChangeModal';

const BROKER_LABELS = {
  SBI_SECURITIES: 'SBI', HDFC_SECURITIES: 'HDFC', UPSTOX: 'Upstox', ZERODHA: 'Zerodha',
  GROWW: 'Groww', ANGEL_ONE: 'Angel One', ICICI_DIRECT: 'ICICI', KOTAK_SECURITIES: 'Kotak',
  MOTILAL_OSWAL: 'Motilal', '5PAISA': '5paisa', OTHER: 'Other',
};

const RISK_COLORS = {
  CONSERVATIVE: 'bg-green-100 text-green-700',
  BALANCED: 'bg-blue-100 text-blue-700',
  AGGRESSIVE: 'bg-red-100 text-red-700',
};

const GOAL_LABELS = {
  RETIREMENT: 'Retirement', WEALTH_BUILDING: 'Wealth Building', INCOME: 'Regular Income',
  EDUCATION: 'Education', EMERGENCY: 'Emergency', SHORT_TERM_TRADING: 'Trading',
};

export default function Portfolio() {
  const [portfolios, setPortfolios] = useState([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(null);
  const [holdings, setHoldings] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showCapitalModal, setShowCapitalModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { loadPortfolios(); }, []);

  useEffect(() => {
    if (selectedPortfolioId) loadHoldings();
  }, [selectedPortfolioId]);

  const loadPortfolios = async () => {
    try {
      const data = await api.get('/portfolio?all=true');
      const list = data.portfolios || [];
      setPortfolios(list);
      if (list.length > 0 && !selectedPortfolioId) {
        setSelectedPortfolioId(list[0].id);
      } else if (list.length > 0 && !list.find(p => p.id === selectedPortfolioId)) {
        setSelectedPortfolioId(list[0].id);
      }
    } catch (err) {
      console.error('Failed to load portfolios:', err);
    }
  };

  const loadHoldings = async () => {
    setLoading(true);
    try {
      const data = await api.get(`/portfolio/${selectedPortfolioId}/holdings`);
      const h = data.holdings || [];
      setHoldings(h);
      const totalInvested = h.reduce((s, x) => s + x.investedAmount, 0);
      const totalCurrent = h.reduce((s, x) => s + x.currentValue, 0);
      const unrealizedPL = totalCurrent - totalInvested;
      setSummary({
        totalInvested, totalCurrent, unrealizedPL,
        plPercent: totalInvested > 0 ? ((unrealizedPL / totalInvested) * 100).toFixed(2) : '0.00'
      });
    } catch (err) {
      console.error('Failed to load holdings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
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

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this portfolio? Holdings will be preserved but hidden.')) return;
    setDeleting(true);
    try {
      await portfolioApi.deletePortfolio(selectedPortfolioId);
      setSelectedPortfolioId(null);
      await loadPortfolios();
    } catch (err) {
      alert(err.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  const handlePortfolioCreated = () => { loadPortfolios(); };
  const handlePortfolioUpdated = () => { loadPortfolios(); };
  const handleCapitalUpdated = () => { loadPortfolios(); loadHoldings(); };

  const selectedPortfolio = portfolios.find(p => p.id === selectedPortfolioId);
  const isProfit = summary && summary.unrealizedPL >= 0;

  const formatCurrency = (val) => {
    if (val == null || isNaN(val)) return '--';
    return `\u20B9${Number(val).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-3 sm:justify-between sm:items-center">
        <h1 className="text-2xl sm:text-3xl font-bold">Portfolio</h1>
        <div className="flex gap-2 sm:gap-3">
          <button onClick={handleSync} disabled={syncing} className="btn btn-secondary flex items-center gap-2">
            <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Sync Prices</span>
          </button>
          <button onClick={() => setShowCreateModal(true)} className="btn btn-primary flex items-center gap-2">
            <Plus size={18} />
            New Portfolio
          </button>
        </div>
      </div>

      {/* Portfolio Cards Row */}
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
        {portfolios.map(p => (
          <button
            key={p.id}
            onClick={() => setSelectedPortfolioId(p.id)}
            className={`flex-shrink-0 min-w-[180px] max-w-[240px] rounded-xl p-4 border-2 text-left transition-all ${
              p.id === selectedPortfolioId
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 shadow-md'
                : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow'
            }`}
          >
            <p className="font-semibold text-gray-900 dark:text-gray-100 text-sm truncate">{p.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{p.ownerName}</p>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 font-medium">
                {BROKER_LABELS[p.broker] || p.broker}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RISK_COLORS[p.riskProfile] || 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
                {p.riskProfile}
              </span>
            </div>
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100 mt-2">
              {formatCurrency(p.startingCapital)}
            </p>
          </button>
        ))}
        {/* Add card */}
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex-shrink-0 min-w-[120px] rounded-xl p-4 border-2 border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-all"
        >
          <Plus className="w-8 h-8 text-gray-400 dark:text-gray-500" />
        </button>
      </div>

      {/* Completeness Alert */}
      {selectedPortfolio && (
        <PortfolioCompletenessAlert
          portfolio={selectedPortfolio}
          onEdit={() => setShowEditModal(true)}
        />
      )}

      {/* Portfolio Settings Strip */}
      {selectedPortfolio && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className={`text-xs px-3 py-1 rounded-full font-semibold ${RISK_COLORS[selectedPortfolio.riskProfile] || ''}`}>
                {selectedPortfolio.riskProfile}
              </span>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {BROKER_LABELS[selectedPortfolio.broker] || selectedPortfolio.broker}
              </span>
              {selectedPortfolio.investmentGoal && (
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  {GOAL_LABELS[selectedPortfolio.investmentGoal] || selectedPortfolio.investmentGoal}
                </span>
              )}
              {selectedPortfolio.investmentExperience && (
                <span className="text-sm text-gray-600 dark:text-gray-400">{selectedPortfolio.investmentExperience}</span>
              )}
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                Capital: {formatCurrency(selectedPortfolio.startingCapital)}
              </span>
              <span className="text-sm text-green-700 font-medium">
                Cash: {formatCurrency(selectedPortfolio.availableCash)}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowEditModal(true)}
                className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1.5"
              >
                <Settings size={14} /> Edit
              </button>
              <button
                onClick={() => setShowCapitalModal(true)}
                className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1.5"
              >
                <DollarSign size={14} /> Capital
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting || portfolios.length <= 1}
                className="px-3 py-1.5 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <span className="ml-3 text-gray-600 dark:text-gray-400">Loading holdings...</span>
        </div>
      ) : (
        <>
          {/* Summary Card */}
          {summary && (
            <div className="card bg-gradient-to-r from-blue-500 to-blue-600 text-white">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div>
                  <p className="text-blue-100 text-sm mb-1">Total Invested</p>
                  <p className="text-xl sm:text-3xl font-bold">{formatCurrency(summary.totalInvested)}</p>
                </div>
                <div>
                  <p className="text-blue-100 text-sm mb-1">Current Value</p>
                  <p className="text-xl sm:text-3xl font-bold">{formatCurrency(summary.totalCurrent)}</p>
                </div>
                <div>
                  <p className="text-blue-100 text-sm mb-1">Unrealized P&L</p>
                  <div className="flex items-center gap-2">
                    <p className="text-xl sm:text-3xl font-bold">{formatCurrency(summary.unrealizedPL)}</p>
                    {isProfit ? <TrendingUp size={24} /> : <TrendingDown size={24} />}
                  </div>
                </div>
                <div>
                  <p className="text-blue-100 text-sm mb-1">Returns</p>
                  <p className={`text-3xl font-bold ${isProfit ? 'text-green-300' : 'text-red-300'}`}>
                    {summary.plPercent}%
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Holdings Table */}
          {holdings.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-500 dark:text-gray-400 text-lg mb-4">No holdings in this portfolio</p>
            </div>
          ) : (
            <div className="card overflow-hidden">
              {/* Mobile Card View */}
              <div className="md:hidden space-y-3 p-4">
                {holdings.map((holding) => {
                  const isProfitable = holding.unrealizedPL >= 0;
                  return (
                    <div key={holding.id} className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <p className="font-semibold text-gray-900 dark:text-gray-100">{holding.symbol}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{holding.exchange}</p>
                        </div>
                        <div className={`text-right ${isProfitable ? 'text-green-600' : 'text-red-600'}`}>
                          <p className="font-semibold">{isProfitable ? '+' : ''}{formatCurrency(holding.unrealizedPL)}</p>
                          <p className="text-xs">({holding.plPercent}%)</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <p className="text-gray-500 dark:text-gray-400 text-xs">Qty</p>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{holding.quantity}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 dark:text-gray-400 text-xs">Current</p>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{formatCurrency(holding.currentPrice)}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 dark:text-gray-400 text-xs">Invested</p>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{formatCurrency(holding.investedAmount)}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 dark:text-gray-400 text-xs">Value</p>
                          <p className="font-medium text-gray-900 dark:text-gray-100">{formatCurrency(holding.currentValue)}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop Table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Stock</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Qty</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Avg Price</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Current</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Invested</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Value</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">P&L</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {holdings.map((holding) => {
                      const isProfitable = holding.unrealizedPL >= 0;
                      return (
                        <tr key={holding.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{holding.symbol}</div>
                            <div className="text-sm text-gray-500 dark:text-gray-400">{holding.exchange}</div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">{holding.quantity}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">{formatCurrency(holding.avgPrice)}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100">{formatCurrency(holding.currentPrice)}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">{formatCurrency(holding.investedAmount)}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100">{formatCurrency(holding.currentValue)}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                            <div className={isProfitable ? 'text-green-600' : 'text-red-600'}>
                              <div className="font-medium">{isProfitable ? '+' : ''}{formatCurrency(holding.unrealizedPL)}</div>
                              <div className="text-xs">({holding.plPercent}%)</div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Modals */}
      <PortfolioFormModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={handlePortfolioCreated}
        mode="create"
      />

      <PortfolioFormModal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        portfolio={selectedPortfolio}
        onSuccess={handlePortfolioUpdated}
        mode="edit"
      />

      <CapitalChangeModal
        isOpen={showCapitalModal}
        onClose={() => setShowCapitalModal(false)}
        portfolio={selectedPortfolio}
        onSuccess={handleCapitalUpdated}
      />
    </div>
  );
}
