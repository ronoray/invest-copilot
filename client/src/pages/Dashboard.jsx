import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, TrendingDown, AlertCircle, CheckCircle, Clock, Lightbulb, ArrowRight, RefreshCw, Loader2 } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';

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

  // Load portfolios on mount
  useEffect(() => {
    loadPortfolios();
    loadRecommendations();
  }, []);

  // Load holdings when portfolio changes
  useEffect(() => {
    loadHoldings();
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
        setHoldings(data.holdings || []);
        setSummary(data.summary || null);
      } else {
        const data = await api.get(`/portfolio/${selectedPortfolioId}/holdings`);
        const holdingsData = data.holdings || [];
        setHoldings(holdingsData);
        // Calculate summary from holdings
        const totalInvested = holdingsData.reduce((s, h) => s + h.investedAmount, 0);
        const totalCurrent = holdingsData.reduce((s, h) => s + h.currentValue, 0);
        const unrealizedPL = totalCurrent - totalInvested;
        setSummary({
          totalInvested,
          totalCurrent,
          unrealizedPL,
          plPercent: totalInvested > 0 ? ((unrealizedPL / totalInvested) * 100).toFixed(2) : '0.00'
        });
      }
    } catch (err) {
      console.error('Failed to load holdings:', err);
    } finally {
      setLoading(false);
    }
  };

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
    if (val == null || isNaN(val)) return '—';
    return `₹${Number(val).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const plColor = (val) => {
    if (val == null) return 'text-gray-600';
    return Number(val) >= 0 ? 'text-green-600' : 'text-red-600';
  };

  const plBg = (val) => {
    if (val == null) return 'from-gray-50 to-gray-100 border-gray-200';
    return Number(val) >= 0
      ? 'from-green-50 to-green-100 border-green-200'
      : 'from-red-50 to-red-100 border-red-200';
  };

  const market = getMarketStatus();
  const userName = user?.name?.split(' ')[0] || 'Investor';

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
            className="px-4 py-2 bg-white text-gray-900 rounded-lg font-semibold focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <option value="all">All Portfolios</option>
            {portfolios.map(p => (
              <option key={p.id} value={p.id}>{p.displayName}</option>
            ))}
          </select>
        )}
      </div>

      {/* Loading */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <span className="ml-3 text-gray-600">Loading portfolio...</span>
        </div>
      ) : (
        <>
          {/* Quick Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Portfolio Value */}
            <div className={`bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-6 border border-blue-200 hover:shadow-lg transition-shadow`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-blue-700">Portfolio Value</h3>
                <TrendingUp className="w-5 h-5 text-blue-600" />
              </div>
              <p className="text-3xl font-bold text-blue-900">{formatCurrency(summary?.totalCurrent)}</p>
              {summary && (
                <p className={`text-sm mt-1 font-semibold ${plColor(summary.unrealizedPL)}`}>
                  {Number(summary.unrealizedPL) >= 0 ? '+' : ''}{formatCurrency(summary.unrealizedPL)} ({summary.plPercent}%)
                </p>
              )}
            </div>

            {/* Unrealized P&L */}
            <div className={`bg-gradient-to-br ${plBg(summary?.unrealizedPL)} rounded-xl p-6 border hover:shadow-lg transition-shadow`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className={`text-sm font-medium ${Number(summary?.unrealizedPL) >= 0 ? 'text-green-700' : 'text-red-700'}`}>Unrealized P&L</h3>
                {Number(summary?.unrealizedPL) >= 0 ? <TrendingUp className="w-5 h-5 text-green-600" /> : <TrendingDown className="w-5 h-5 text-red-600" />}
              </div>
              <p className={`text-3xl font-bold ${Number(summary?.unrealizedPL) >= 0 ? 'text-green-900' : 'text-red-900'}`}>
                {summary ? formatCurrency(Math.abs(summary.unrealizedPL)) : '—'}
              </p>
              <p className={`text-sm mt-1 font-semibold ${plColor(summary?.unrealizedPL)}`}>
                {summary ? `${Number(summary.plPercent) >= 0 ? '+' : ''}${summary.plPercent}%` : '—'}
              </p>
            </div>

            {/* Invested Amount */}
            <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-6 border border-purple-200 hover:shadow-lg transition-shadow">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-purple-700">Invested</h3>
                <CheckCircle className="w-5 h-5 text-purple-600" />
              </div>
              <p className="text-3xl font-bold text-purple-900">{formatCurrency(summary?.totalInvested)}</p>
              <p className="text-sm text-purple-600 mt-1">Total capital deployed</p>
            </div>

            {/* Holdings Count */}
            <div className="bg-gradient-to-br from-amber-50 to-amber-100 rounded-xl p-6 border border-amber-200 hover:shadow-lg transition-shadow">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-amber-700">Holdings</h3>
                <CheckCircle className="w-5 h-5 text-amber-600" />
              </div>
              <p className="text-3xl font-bold text-amber-900">{holdings.length}</p>
              <p className="text-sm text-amber-600 mt-1">
                {selectedPortfolioId === 'all' ? 'Across all portfolios' : 'In this portfolio'}
              </p>
            </div>
          </div>

          {/* Holdings Table */}
          <div className="bg-white rounded-xl p-6 shadow-md border border-gray-200">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">Holdings</h2>
            {holdings.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
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
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b-2 border-gray-200">
                      <th className="text-left py-3 px-3 font-semibold text-gray-700 text-sm">Symbol</th>
                      {selectedPortfolioId === 'all' && (
                        <th className="text-left py-3 px-3 font-semibold text-gray-700 text-sm">Portfolio</th>
                      )}
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 text-sm">Qty</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 text-sm">Avg Price</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 text-sm">Current</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 text-sm">Invested</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 text-sm">Value</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 text-sm">P&L</th>
                      <th className="text-right py-3 px-3 font-semibold text-gray-700 text-sm">P&L %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => (
                      <tr key={h.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="py-3 px-3 font-semibold text-gray-900">{h.symbol}</td>
                        {selectedPortfolioId === 'all' && (
                          <td className="py-3 px-3 text-gray-600 text-sm">{h.portfolioName || '—'}</td>
                        )}
                        <td className="text-right py-3 px-3 text-gray-700">{h.quantity}</td>
                        <td className="text-right py-3 px-3 text-gray-700">₹{Number(h.avgPrice).toFixed(2)}</td>
                        <td className="text-right py-3 px-3 text-gray-700">₹{Number(h.currentPrice).toFixed(2)}</td>
                        <td className="text-right py-3 px-3 text-gray-700">{formatCurrency(h.investedAmount)}</td>
                        <td className="text-right py-3 px-3 text-gray-700">{formatCurrency(h.currentValue)}</td>
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
            )}
          </div>

          {/* AI Recommendations */}
          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-6 shadow-md border border-indigo-200">
            <div className="flex items-center gap-2 mb-4">
              <Lightbulb className="w-6 h-6 text-indigo-600" />
              <h2 className="text-xl font-semibold text-gray-800">AI Insights</h2>
              <span className="ml-auto text-sm text-indigo-600 font-medium">
                {allRecs.length > 0 ? `${allRecs.length} active` : 'None yet'}
              </span>
            </div>

            {allRecs.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-500 mb-4">No AI recommendations yet. Run a scan to get personalized insights.</p>
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
                  <div key={idx} className="bg-white rounded-lg p-5 shadow-sm border border-indigo-100 hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="text-lg font-bold text-gray-900">{rec.symbol || rec.stock}</h3>
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
                          <p className="text-sm text-gray-500">Confidence</p>
                          <p className="text-xl font-bold text-indigo-600">{rec.confidence}</p>
                        </div>
                      )}
                    </div>

                    {rec.price && (
                      <div className="space-y-2 mb-3">
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">Price:</span>
                          <span className="font-semibold text-gray-900">₹{rec.price}</span>
                        </div>
                        {rec.targetPrice && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-600">Target:</span>
                            <span className="font-semibold text-green-600">₹{rec.targetPrice}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {rec.reasoning && (
                      <p className="text-sm text-gray-600 mb-3 line-clamp-2">{rec.reasoning}</p>
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
          <div className="bg-white rounded-xl p-6 shadow-md border border-gray-200">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">Market Status</h2>
            <div className="flex items-center gap-2 text-sm text-gray-600">
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <button
              onClick={() => navigate('/portfolio')}
              className="bg-white hover:bg-gray-50 border-2 border-gray-200 rounded-xl p-4 text-center transition-all hover:shadow-md"
            >
              <div className="text-2xl mb-2">+</div>
              <p className="font-semibold text-gray-900">Add Holding</p>
            </button>
            <button
              onClick={handleSyncPrices}
              disabled={syncing}
              className="bg-white hover:bg-gray-50 border-2 border-gray-200 rounded-xl p-4 text-center transition-all hover:shadow-md disabled:opacity-50"
            >
              <div className="text-2xl mb-2">
                <RefreshCw className={`w-6 h-6 mx-auto ${syncing ? 'animate-spin' : ''}`} />
              </div>
              <p className="font-semibold text-gray-900">{syncing ? 'Syncing...' : 'Sync Prices'}</p>
            </button>
            <button
              onClick={() => navigate('/insights')}
              className="bg-white hover:bg-gray-50 border-2 border-gray-200 rounded-xl p-4 text-center transition-all hover:shadow-md"
            >
              <div className="text-2xl mb-2">
                <TrendingUp className="w-6 h-6 mx-auto" />
              </div>
              <p className="font-semibold text-gray-900">View Reports</p>
            </button>
            <button
              onClick={() => navigate('/tax')}
              className="bg-white hover:bg-gray-50 border-2 border-gray-200 rounded-xl p-4 text-center transition-all hover:shadow-md"
            >
              <div className="text-2xl mb-2">
                <CheckCircle className="w-6 h-6 mx-auto" />
              </div>
              <p className="font-semibold text-gray-900">Tax Dashboard</p>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
