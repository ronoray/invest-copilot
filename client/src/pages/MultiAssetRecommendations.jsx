import { useState, useEffect } from 'react';
import { Layers, RefreshCw, ChevronDown, ChevronUp, TrendingUp, Shield, Flame, Zap, Target, PieChart, AlertCircle, BookOpen } from 'lucide-react';
import { api } from '../utils/api';

const TABS = [
  { key: 'stocks', label: 'Stocks' },
  { key: 'mutualFunds', label: 'Mutual Funds' },
  { key: 'commodities', label: 'Commodities' },
  { key: 'fixedIncome', label: 'Fixed Income' },
  { key: 'alternatives', label: 'Alternatives' },
];

const RISK_FILTERS = ['ALL', 'LOW', 'MEDIUM', 'HIGH'];

const riskColors = {
  LOW: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200', gradient: 'from-green-50 to-emerald-50' },
  MEDIUM: { bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-200', gradient: 'from-yellow-50 to-amber-50' },
  HIGH: { bg: 'bg-red-100', text: 'text-red-700', border: 'border-red-200', gradient: 'from-red-50 to-orange-50' },
};

const riskIcons = {
  LOW: <Shield className="w-4 h-4" />,
  MEDIUM: <Zap className="w-4 h-4" />,
  HIGH: <Flame className="w-4 h-4" />,
};

export default function MultiAssetRecommendations() {
  const [portfolios, setPortfolios] = useState([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(null);
  const [activeTab, setActiveTab] = useState('stocks');
  const [riskFilter, setRiskFilter] = useState('ALL');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expandedGuides, setExpandedGuides] = useState({});

  // Config
  const [capital, setCapital] = useState(100000);
  const [riskProfile, setRiskProfile] = useState('MODERATE');
  const [timeHorizon, setTimeHorizon] = useState('MEDIUM');

  useEffect(() => {
    loadPortfolios();
  }, []);

  const loadPortfolios = async () => {
    try {
      const result = await api.get('/portfolio?all=true');
      setPortfolios(result.portfolios || []);
      if (result.portfolios?.length > 0) {
        setSelectedPortfolioId(result.portfolios[0].id);
      }
    } catch (err) {
      console.error('Failed to load portfolios:', err);
    }
  };

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.post('/ai/multi-asset/scan', {
        portfolioId: selectedPortfolioId,
        riskProfile,
        capital,
        timeHorizon,
      });
      setData(result.recommendations || result);
    } catch (err) {
      setError(err.message || 'Failed to generate recommendations');
    } finally {
      setLoading(false);
    }
  };

  const toggleGuide = (key) => {
    setExpandedGuides(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const formatCurrency = (val) => {
    if (val == null || isNaN(val)) return '—';
    return `₹${Number(val).toLocaleString('en-IN')}`;
  };

  // Get items for active tab, applying risk filter
  const getFilteredItems = () => {
    if (!data?.recommendations) return [];

    let items = [];
    const recs = data.recommendations;

    switch (activeTab) {
      case 'stocks':
        items = [...(recs.stocks || []), ...(recs.etfs || [])];
        break;
      case 'mutualFunds':
        items = recs.mutualFunds || [];
        break;
      case 'commodities':
        items = recs.commodities || [];
        break;
      case 'fixedIncome':
        items = recs.fixedIncome || [];
        break;
      case 'alternatives':
        items = recs.alternatives || [];
        break;
      default:
        items = [];
    }

    if (riskFilter !== 'ALL') {
      items = items.filter(item => item.riskLevel === riskFilter);
    }

    return items;
  };

  const filteredItems = getFilteredItems();
  const allocation = data?.allocation;

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 rounded-xl p-6 text-white shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-3">
              <Layers className="w-8 h-8" />
              Multi-Asset Invest
            </h1>
            <p className="text-indigo-100 mt-1 text-sm sm:text-base">Stocks, Mutual Funds, Commodities, Bonds & more</p>
          </div>
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="bg-white text-indigo-700 px-5 py-3 rounded-lg font-semibold hover:bg-indigo-50 transition-all flex items-center gap-2 disabled:opacity-50 shadow-lg whitespace-nowrap"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Generating...' : 'Generate Plan'}
          </button>
        </div>

        {/* Config row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {portfolios.length > 0 && (
            <select
              value={selectedPortfolioId || ''}
              onChange={(e) => setSelectedPortfolioId(parseInt(e.target.value))}
              className="px-3 py-2 bg-white text-gray-900 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              {portfolios.map(p => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          )}
          <input
            type="number"
            value={capital}
            onChange={(e) => setCapital(Number(e.target.value))}
            placeholder="Capital"
            className="px-3 py-2 bg-white text-gray-900 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <select
            value={riskProfile}
            onChange={(e) => setRiskProfile(e.target.value)}
            className="px-3 py-2 bg-white text-gray-900 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="CONSERVATIVE">Conservative</option>
            <option value="MODERATE">Moderate</option>
            <option value="AGGRESSIVE">Aggressive</option>
          </select>
          <select
            value={timeHorizon}
            onChange={(e) => setTimeHorizon(e.target.value)}
            className="px-3 py-2 bg-white text-gray-900 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="SHORT">Short (0-1y)</option>
            <option value="MEDIUM">Medium (1-3y)</option>
            <option value="LONG">Long (3y+)</option>
          </select>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {/* Allocation Overview */}
      {allocation && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-md border border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2 mb-4">
            <PieChart className="w-5 h-5 text-indigo-600" />
            Recommended Allocation
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {[
              { key: 'equity', label: 'Equity', color: 'blue' },
              { key: 'mutualFunds', label: 'Mutual Funds', color: 'purple' },
              { key: 'commodities', label: 'Commodities', color: 'amber' },
              { key: 'fixedIncome', label: 'Fixed Income', color: 'green' },
              { key: 'alternatives', label: 'Alternatives', color: 'pink' },
            ].map(({ key, label, color }) => (
              <div key={key} className={`bg-${color}-50 rounded-lg p-3 border border-${color}-200`}>
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">{label}</p>
                <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{allocation[key]?.percentage || 0}%</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{formatCurrency(allocation[key]?.amount)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      {data && (
        <>
          <div className="flex overflow-x-auto gap-1 pb-1 -mx-1 px-1">
            {TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setRiskFilter('ALL'); }}
                className={`px-4 py-2.5 rounded-lg font-semibold text-sm whitespace-nowrap transition-all ${
                  activeTab === tab.key
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:border-indigo-300 hover:text-indigo-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Risk Filter Pills */}
          <div className="flex gap-2 flex-wrap">
            {RISK_FILTERS.map(filter => (
              <button
                key={filter}
                onClick={() => setRiskFilter(filter)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                  riskFilter === filter
                    ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200'
                }`}
              >
                {filter === 'ALL' ? 'All Risk Levels' : `${filter} Risk`}
              </button>
            ))}
          </div>

          {/* Recommendation Cards */}
          <div className="space-y-4">
            {filteredItems.length === 0 ? (
              <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-8 text-center border border-gray-200 dark:border-gray-700">
                <Target className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 dark:text-gray-400">No recommendations for this filter combination</p>
              </div>
            ) : (
              filteredItems.map((item, idx) => {
                const risk = riskColors[item.riskLevel] || riskColors.MEDIUM;
                const guideKey = `${activeTab}-${idx}`;
                const isGuideOpen = expandedGuides[guideKey];
                const name = item.symbol || item.name || item.ticker || item.instrument || item.type;

                return (
                  <div key={idx} className={`bg-white dark:bg-gray-800 rounded-xl shadow-md border-2 ${risk.border} overflow-hidden`}>
                    {/* Card Header */}
                    <div className="p-4 sm:p-5">
                      <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{name}</h3>
                          {item.sector && (
                            <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full text-xs font-medium">
                              {item.sector}
                            </span>
                          )}
                          {item.category && (
                            <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs font-medium">
                              {item.category}
                            </span>
                          )}
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold flex items-center gap-1 ${risk.bg} ${risk.text}`}>
                            {riskIcons[item.riskLevel]}
                            {item.riskLevel}
                          </span>
                        </div>
                        {item.allocation && (
                          <p className="text-lg font-bold text-indigo-600">{formatCurrency(item.allocation)}</p>
                        )}
                      </div>

                      {/* Metrics Grid — varies by type */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-3">
                        {item.currentPrice != null && (
                          <Metric label="Price" value={formatCurrency(item.currentPrice)} />
                        )}
                        {item.targetPrice != null && (
                          <Metric label="Target" value={formatCurrency(item.targetPrice)} color="text-green-600" />
                        )}
                        {item.stopLoss != null && (
                          <Metric label="Stop Loss" value={formatCurrency(item.stopLoss)} color="text-red-600" />
                        )}
                        {item.returns1y && (
                          <Metric label="1Y Return" value={item.returns1y} color="text-green-600" />
                        )}
                        {item.returns3y && (
                          <Metric label="3Y Return" value={item.returns3y} color="text-green-600" />
                        )}
                        {item.returns5y && (
                          <Metric label="5Y Return" value={item.returns5y} color="text-green-600" />
                        )}
                        {item.expenseRatio && (
                          <Metric label="Expense Ratio" value={item.expenseRatio} />
                        )}
                        {item.minSip != null && (
                          <Metric label="Min SIP" value={formatCurrency(item.minSip)} />
                        )}
                        {item.amc && (
                          <Metric label="AMC" value={item.amc} />
                        )}
                        {item.yieldPercent != null && (
                          <Metric label="Yield" value={`${item.yieldPercent}%`} color="text-green-600" />
                        )}
                        {item.tenure && (
                          <Metric label="Tenure" value={item.tenure} />
                        )}
                        {item.rating && (
                          <Metric label="Rating" value={item.rating} />
                        )}
                        {item.expectedYield && (
                          <Metric label="Expected Yield" value={item.expectedYield} color="text-green-600" />
                        )}
                        {item.minInvestment != null && (
                          <Metric label="Min Investment" value={formatCurrency(item.minInvestment)} />
                        )}
                        {item.currentTrend && (
                          <Metric label="Trend" value={item.currentTrend} color={item.currentTrend === 'Bullish' ? 'text-green-600' : 'text-red-600'} />
                        )}
                        {item.recommendation && (
                          <Metric label="Signal" value={item.recommendation} color={item.recommendation === 'BUY' ? 'text-green-600' : 'text-red-600'} />
                        )}
                        {item.outlook && (
                          <div className="col-span-2">
                            <Metric label="Outlook" value={item.outlook} />
                          </div>
                        )}
                      </div>

                      {/* Why this? */}
                      {item.reasoning && (
                        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 mb-3">
                          <p className="text-sm text-gray-700 dark:text-gray-300">
                            <span className="font-semibold text-gray-900 dark:text-gray-100">Why: </span>
                            {item.reasoning}
                          </p>
                        </div>
                      )}

                      {/* Instruments (for commodities) */}
                      {item.instruments && item.instruments.length > 0 && (
                        <div className="space-y-2 mb-3">
                          {item.instruments.map((inst, i) => (
                            <div key={i} className="flex items-center justify-between bg-indigo-50 dark:bg-indigo-900/30 rounded-lg px-3 py-2 text-sm">
                              <span className="font-medium text-gray-900 dark:text-gray-100">{inst.name}</span>
                              <div className="text-right">
                                <span className="font-bold text-indigo-600">{formatCurrency(inst.allocation)}</span>
                                {inst.why && <p className="text-xs text-gray-500 dark:text-gray-400">{inst.why}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* How to Invest Accordion */}
                      {item.guide && (
                        <button
                          onClick={() => toggleGuide(guideKey)}
                          className="w-full flex items-center justify-between p-3 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg text-sm font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
                        >
                          <span className="flex items-center gap-2">
                            <BookOpen className="w-4 h-4" />
                            {isGuideOpen ? 'Hide Guide' : 'How to Invest (Beginner Guide)'}
                          </span>
                          {isGuideOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      )}

                      {isGuideOpen && item.guide && (
                        <div className="mt-3 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg p-4 space-y-3">
                          <h4 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">{item.guide.title}</h4>

                          {/* Steps */}
                          <ol className="list-decimal list-inside space-y-1.5 text-sm text-gray-700 dark:text-gray-300">
                            {item.guide.steps?.map((step, i) => (
                              <li key={i}>{step}</li>
                            ))}
                          </ol>

                          {/* Tips */}
                          {item.guide.tips?.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-1">Tips</p>
                              <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
                                {item.guide.tips.map((tip, i) => (
                                  <li key={i} className="flex items-start gap-1.5">
                                    <span className="text-green-600 mt-0.5">*</span>
                                    {tip}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Platforms */}
                          {item.guide.platforms?.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-1">Platforms</p>
                              <div className="flex flex-wrap gap-2">
                                {item.guide.platforms.map((platform, i) => (
                                  <span key={i} className="px-2.5 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-full text-xs font-medium border border-gray-200 dark:border-gray-700">
                                    {platform}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* SIP Recommendation (Mutual Funds tab) */}
          {activeTab === 'mutualFunds' && data?.recommendations?.sipRecommendation && (
            <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-xl p-5 border border-purple-200">
              <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-3 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-purple-600" />
                SIP Recommendation
              </h3>
              <p className="text-lg font-bold text-purple-700 mb-3">
                Total Monthly SIP: {formatCurrency(data.recommendations.sipRecommendation.totalMonthly)}
              </p>
              <div className="space-y-2">
                {data.recommendations.sipRecommendation.distribution?.map((d, i) => (
                  <div key={i} className="flex justify-between items-center bg-white dark:bg-gray-800 rounded-lg px-4 py-2 text-sm">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{d.fund}</span>
                    <span className="font-bold text-purple-600">{formatCurrency(d.monthly)}/mo</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 rounded-xl p-12 text-center border-2 border-gray-200 dark:border-gray-700">
          <Layers className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-700 dark:text-gray-300 text-lg font-semibold mb-2">Your Multi-Asset Investment Plan</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm mb-5">
            Configure your capital, risk profile, and time horizon above, then generate your personalized plan across stocks, mutual funds, commodities, bonds, and alternatives.
          </p>
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 px-8 rounded-lg transition-all shadow-md"
          >
            Generate Recommendations
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-12">
          <RefreshCw className="w-10 h-10 animate-spin text-indigo-600 mb-4" />
          <p className="text-gray-600 dark:text-gray-400 font-medium">Analyzing markets across asset classes...</p>
          <p className="text-gray-400 text-sm mt-1">This may take 15-30 seconds</p>
        </div>
      )}

      {/* Disclaimer */}
      <div className="bg-amber-50 dark:bg-yellow-900/30 border-2 border-amber-200 rounded-xl p-4 text-xs sm:text-sm">
        <p className="text-amber-900">
          <strong>Disclaimer:</strong> These AI-generated recommendations are for informational purposes only.
          They do not constitute financial advice. Past performance does not guarantee future results.
          Always conduct your own research and consult a SEBI-registered financial advisor before investing.
          Investments in securities are subject to market risks.
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value, color = 'text-gray-900 dark:text-gray-100' }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-2">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-sm font-semibold ${color} truncate`}>{value}</p>
    </div>
  );
}
