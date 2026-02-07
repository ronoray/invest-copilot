import { useState, useEffect } from 'react';
import { Lightbulb, TrendingUp, AlertTriangle, Target, RefreshCw, Flame, Shield, Zap } from 'lucide-react';
import { api } from '../utils/api';

export default function AIRecommendations() {
  const [loading, setLoading] = useState(false);
  const [opportunities, setOpportunities] = useState({ high: [], medium: [], low: [] });
  const [summary, setSummary] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');

  useEffect(() => {
    loadRecommendations();
  }, []);

  const loadRecommendations = async () => {
    try {
      const data = await api.get('/ai/recommendations');
      
      if (data.categorized) {
        setOpportunities(data.categorized);
      }
    } catch (error) {
      console.error('Failed to load recommendations:', error);
    }
  };

  const handleScan = async () => {
    setLoading(true);
    try {
      const data = await api.post('/ai/scan', { 
        perCategory: 5, 
        baseAmount: 10000 
      });
      
      if (data.opportunities) {
        setOpportunities(data.opportunities);
        setSummary(data.summary);
      }
    } catch (error) {
      console.error('Scan failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const getRiskColor = (category) => {
    switch(category) {
      case 'high': return 'from-red-600 via-red-500 to-orange-500';
      case 'medium': return 'from-amber-600 via-amber-500 to-yellow-500';
      case 'low': return 'from-emerald-600 via-emerald-500 to-teal-500';
      default: return 'from-slate-600 to-slate-500';
    }
  };

  const getRiskBg = (category) => {
    switch(category) {
      case 'high': return 'from-red-50 to-orange-50';
      case 'medium': return 'from-amber-50 to-yellow-50';
      case 'low': return 'from-emerald-50 to-teal-50';
      default: return 'from-slate-50 to-slate-100';
    }
  };

  const getRiskBorder = (category) => {
    switch(category) {
      case 'high': return 'border-red-200';
      case 'medium': return 'border-amber-200';
      case 'low': return 'border-emerald-200';
      default: return 'border-slate-200';
    }
  };

  const getRiskIcon = (category) => {
    switch(category) {
      case 'high': return <Flame className="w-5 h-5" />;
      case 'medium': return <Zap className="w-5 h-5" />;
      case 'low': return <Shield className="w-5 h-5" />;
      default: return <Target className="w-5 h-5" />;
    }
  };

  const getRiskLabel = (category) => {
    switch(category) {
      case 'high': return { title: 'High Risk', subtitle: 'Aggressive Growth', emoji: '🔥' };
      case 'medium': return { title: 'Medium Risk', subtitle: 'Balanced Growth', emoji: '⚡' };
      case 'low': return { title: 'Low Risk', subtitle: 'Stable Returns', emoji: '🛡️' };
      default: return { title: 'Unknown', subtitle: '', emoji: '❓' };
    }
  };

  const allStocks = [...opportunities.high, ...opportunities.medium, ...opportunities.low];
  const filteredStocks = activeFilter === 'all' 
    ? allStocks 
    : opportunities[activeFilter] || [];

  return (
    <div className="space-y-6 pb-8">
      {/* Sophisticated Header */}
      <div className="bg-gradient-to-r from-slate-700 via-slate-600 to-slate-500 rounded-xl p-6 text-white shadow-xl">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-3">
              <Lightbulb className="w-8 h-8" />
              AI Stock Recommendations
            </h1>
            <p className="text-slate-200">Sophisticated analysis, explained simply</p>
          </div>
          <button 
            onClick={handleScan}
            disabled={loading}
            className="bg-white text-slate-700 px-6 py-3 rounded-lg font-semibold hover:bg-slate-50 transition-all flex items-center gap-2 disabled:opacity-50 shadow-lg"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Analyzing Market...' : 'Deep Market Scan'}
          </button>
        </div>
      </div>

      {/* Elegant Summary Stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl p-4 border-2 border-slate-200 shadow-md">
            <p className="text-sm text-slate-600 mb-1 font-medium">Total Opportunities</p>
            <p className="text-xl sm:text-3xl font-bold text-slate-900">{summary.total}</p>
          </div>
          <div className="bg-gradient-to-br from-red-50 to-orange-50 rounded-xl p-4 border-2 border-red-200 shadow-md">
            <p className="text-sm text-red-700 mb-1 flex items-center gap-1 font-medium">
              <Flame className="w-4 h-4" />
              High Risk
            </p>
            <p className="text-xl sm:text-3xl font-bold text-red-900">{summary.highRisk}</p>
          </div>
          <div className="bg-gradient-to-br from-amber-50 to-yellow-50 rounded-xl p-4 border-2 border-amber-200 shadow-md">
            <p className="text-sm text-amber-700 mb-1 flex items-center gap-1 font-medium">
              <Zap className="w-4 h-4" />
              Medium Risk
            </p>
            <p className="text-xl sm:text-3xl font-bold text-amber-900">{summary.mediumRisk}</p>
          </div>
          <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl p-4 border-2 border-emerald-200 shadow-md">
            <p className="text-sm text-emerald-700 mb-1 flex items-center gap-1 font-medium">
              <Shield className="w-4 h-4" />
              Low Risk
            </p>
            <p className="text-xl sm:text-3xl font-bold text-emerald-900">{summary.lowRisk}</p>
          </div>
        </div>
      )}

      {/* Refined Filter Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {['all', 'high', 'medium', 'low'].map((filter) => (
          <button
            key={filter}
            onClick={() => setActiveFilter(filter)}
            className={`px-5 py-2.5 rounded-lg font-semibold whitespace-nowrap transition-all shadow-sm ${
              activeFilter === filter 
                ? 'bg-slate-700 text-white shadow-md' 
                : 'bg-white text-slate-700 border-2 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
            }`}
          >
            {filter === 'all' ? 'ALL PICKS' : getRiskLabel(filter).title.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Sophisticated Stock Cards */}
      <div className="space-y-5">
        {filteredStocks.map((stock, index) => {
          const riskInfo = getRiskLabel(stock.riskCategory);
          
          return (
            <div 
              key={index} 
              className={`bg-white rounded-xl shadow-lg border-2 ${getRiskBorder(stock.riskCategory)} overflow-hidden hover:shadow-xl transition-all`}
            >
              {/* Premium Header */}
              <div className={`bg-gradient-to-r ${getRiskColor(stock.riskCategory)} p-5 text-white`}>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    <div className="bg-white/20 p-2 rounded-lg backdrop-blur-sm">
                      {getRiskIcon(stock.riskCategory)}
                    </div>
                    <div>
                      <h3 className="text-xl sm:text-2xl font-bold">{stock.symbol}</h3>
                      <p className="text-sm opacity-90">{riskInfo.subtitle}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm opacity-90 font-medium">Current Price</p>
                    <p className="text-xl sm:text-3xl font-bold">₹{stock.price?.toFixed(2)}</p>
                    <p className={`text-sm font-semibold ${stock.changePercent >= 0 ? 'text-green-200' : 'text-red-200'}`}>
                      {stock.changePercent >= 0 ? '+' : ''}{stock.changePercent?.toFixed(2)}% today
                    </p>
                  </div>
                </div>
              </div>

              {/* Premium Body */}
              <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Investment Details */}
                  <div className="space-y-3">
                    <div className={`bg-gradient-to-br ${getRiskBg(stock.riskCategory)} rounded-xl p-4 border ${getRiskBorder(stock.riskCategory)}`}>
                      <p className="text-sm text-slate-600 mb-1 font-medium">Suggested Investment</p>
                      <p className="text-2xl font-bold text-slate-900">₹{stock.suggestedAmount?.toLocaleString('en-IN')}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-lg p-3 border-2 border-emerald-200">
                        <p className="text-xs text-slate-600 font-medium">🎯 Target</p>
                        <p className="text-lg font-bold text-emerald-700">₹{stock.targetPrice?.toFixed(0)}</p>
                      </div>
                      <div className="bg-gradient-to-br from-red-50 to-orange-50 rounded-lg p-3 border-2 border-red-200">
                        <p className="text-xs text-slate-600 font-medium">🛑 Stop Loss</p>
                        <p className="text-lg font-bold text-red-700">₹{stock.stopLoss?.toFixed(0)}</p>
                      </div>
                    </div>
                  </div>

                  {/* Simple Explanation */}
                  <div>
                    <h4 className="text-lg font-bold text-slate-900 mb-3 flex items-center gap-2">
                      <Lightbulb className="w-5 h-5 text-amber-500" />
                      Why This Stock?
                    </h4>
                    <ul className="space-y-2">
                      {stock.simpleWhy?.map((reason, i) => (
                        <li key={i} className="flex items-start gap-2 text-slate-700">
                          <span className="text-emerald-600 font-bold mt-0.5">✓</span>
                          <span className="text-sm">{reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Expected Returns */}
                <div className="mt-5 bg-gradient-to-r from-slate-50 to-slate-100 rounded-xl p-4 border-2 border-slate-200">
                  <h4 className="text-sm font-bold text-slate-700 mb-3">Expected Returns</h4>
                  <div className="grid grid-cols-3 gap-3 text-center text-sm">
                    <div>
                      <p className="text-slate-600 mb-1">🚀 Best Case</p>
                      <p className="text-lg font-bold text-emerald-600">{stock.expectedReturns?.best}</p>
                    </div>
                    <div>
                      <p className="text-slate-600 mb-1">📊 Likely</p>
                      <p className="text-lg font-bold text-slate-700">{stock.expectedReturns?.likely}</p>
                    </div>
                    <div>
                      <p className="text-slate-600 mb-1">📉 Worst</p>
                      <p className="text-lg font-bold text-red-600">{stock.expectedReturns?.worst}</p>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-3 mt-5">
                  <button className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 rounded-lg transition-all shadow-md">
                    Add to Portfolio
                  </button>
                  <button className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 px-6 rounded-lg transition-all border-2 border-slate-200">
                    ⭐ Watchlist
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Elegant Empty State */}
      {filteredStocks.length === 0 && !loading && (
        <div className="bg-gradient-to-br from-slate-50 to-slate-100 rounded-xl p-12 text-center border-2 border-slate-200 shadow-lg">
          <Lightbulb className="w-16 h-16 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-700 text-lg font-semibold mb-2">No opportunities yet</p>
          <p className="text-slate-500 text-sm mb-5">Run a deep market scan to find investment opportunities</p>
          <button 
            onClick={handleScan}
            className="bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-8 rounded-lg transition-all shadow-md"
          >
            Start Deep Scan
          </button>
        </div>
      )}

      {/* Professional Disclaimer */}
      <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4 text-sm">
        <p className="text-amber-900">
          <strong className="font-semibold">⚠️ Important:</strong> AI recommendations are for informational purposes only. 
          Always conduct your own research and consult a financial advisor before investing.
        </p>
      </div>
    </div>
  );
}