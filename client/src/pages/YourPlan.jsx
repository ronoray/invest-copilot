import { useState, useEffect, useRef } from 'react';
import { Target, TrendingUp, DollarSign, PieChart, AlertCircle, CheckCircle, RefreshCw, ShoppingCart, Upload, X, Camera } from 'lucide-react';
import CapitalChangeModal from '../components/CapitalChangeModal';
import PortfolioCompletenessAlert from '../components/PortfolioCompletenessAlert';
import { api } from '../utils/api';

export default function YourPlan() {
  // Portfolio selection state
  const [portfolios, setPortfolios] = useState([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(null);
  
  // Plan data state
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  
  // Capital management state
  const [showCapitalModal, setShowCapitalModal] = useState(false);

  // Upstox order state
  const [orderModal, setOrderModal] = useState(null); // { stock, action }
  const [orderQuantity, setOrderQuantity] = useState(1);
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderResult, setOrderResult] = useState(null);

  // Screenshot upload state
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);
  const [screenshotFile, setScreenshotFile] = useState(null);
  const [screenshotPreview, setScreenshotPreview] = useState(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotResult, setScreenshotResult] = useState(null);
  const [editedTrades, setEditedTrades] = useState([]); // editable copy of extracted trades
  const fileInputRef = useRef(null);

  // Load portfolio list on mount
  useEffect(() => {
    loadPortfolioList();
  }, []);

  // Load plan when portfolio selection changes
  useEffect(() => {
    if (selectedPortfolioId) {
      loadPlan();
    }
  }, [selectedPortfolioId]);

  const loadPortfolioList = async () => {
    try {
      const data = await api.get('/portfolio?all=true');
      setPortfolios(data.portfolios || []);
      
      // Auto-select first portfolio
      if (data.portfolios && data.portfolios.length > 0) {
        setSelectedPortfolioId(data.portfolios[0].id);
      }
    } catch (error) {
      console.error('Failed to load portfolio list:', error);
      setError('Failed to load portfolios');
    }
  };

  const loadPlan = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/ai/portfolio-plan?portfolioId=${selectedPortfolioId}`);
      setPlan(data);
    } catch (error) {
      console.error('Failed to load plan:', error);
      setError('Failed to load plan');
    } finally {
      setLoading(false);
    }
  };

  const handlePortfolioChange = (e) => {
    setSelectedPortfolioId(parseInt(e.target.value));
  };

  const handleRefresh = () => {
    loadPlan();
  };

  const handleCapitalUpdated = (updatedPortfolio) => {
    // Refresh portfolio list to get updated capital
    loadPortfolioList();
    // Refresh plan with new capital
    loadPlan();
    // Show success message
    alert(`✅ Capital updated! New capital: ₹${updatedPortfolio.startingCapital.toLocaleString('en-IN')}`);
  };

  // Upstox order handlers
  const handlePlaceOrder = async () => {
    if (!orderModal || orderQuantity <= 0) return;
    setOrderLoading(true);
    try {
      const result = await api.post('/upstox/place-order', {
        symbol: orderModal.stock.symbol,
        transactionType: 'BUY',
        orderType: 'MARKET',
        quantity: orderQuantity,
        portfolioId: selectedPortfolioId
      });
      setOrderResult(result);
    } catch (err) {
      setOrderResult({ error: err.message || 'Order failed' });
    } finally {
      setOrderLoading(false);
    }
  };

  // Screenshot handlers
  const handleScreenshotSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setScreenshotFile(file);
    setScreenshotPreview(URL.createObjectURL(file));
    setScreenshotResult(null);
  };

  const handleScreenshotUpload = async () => {
    if (!screenshotFile) return;
    setScreenshotLoading(true);
    try {
      const formData = new FormData();
      formData.append('screenshot', screenshotFile);
      if (selectedPortfolioId) formData.append('portfolioId', selectedPortfolioId);

      const token = localStorage.getItem('accessToken');
      const response = await fetch('/api/ai/parse-screenshot', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed');
      setScreenshotResult(data);
      // Copy extracted trades into editable state
      setEditedTrades((data.trades || []).map(t => ({ ...t })));
    } catch (err) {
      setScreenshotResult({ error: err.message });
    } finally {
      setScreenshotLoading(false);
    }
  };

  const handleConfirmScreenshotTrade = async () => {
    if (!screenshotResult?.screenshotId || editedTrades.length === 0) return;
    setScreenshotLoading(true);
    try {
      await api.post('/ai/confirm-screenshot-trade', {
        screenshotId: screenshotResult.screenshotId,
        portfolioId: selectedPortfolioId,
        trades: editedTrades
      });
      alert('Trade(s) saved successfully!');
      setShowScreenshotModal(false);
      setScreenshotFile(null);
      setScreenshotPreview(null);
      setScreenshotResult(null);
      setEditedTrades([]);
      loadPlan(); // Refresh data
    } catch (err) {
      alert('Failed to save: ' + (err.message || 'Unknown error'));
    } finally {
      setScreenshotLoading(false);
    }
  };

  // Find selected portfolio details
  const selectedPortfolio = portfolios.find(p => p.id === selectedPortfolioId);

  if (loading && !plan) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Building your investment plan...</p>
        </div>
      </div>
    );
  }

  if (error && !plan) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-12 text-center">
        <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
        <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
        <button 
          onClick={loadPlan}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  const { portfolio, reinvestment, plan: investmentPlan, aiInsights } = plan || {};

  return (
    <div className="space-y-6 pb-8">
      {/* Header with Portfolio Selector */}
      <div className="bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl p-6 text-white shadow-lg">
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-3">
              <Target className="w-8 h-8" />
              Your Investment Plan
            </h1>
            {selectedPortfolio && (
              <div className="text-emerald-100 space-y-1">
                <p className="text-lg font-semibold">{selectedPortfolio.displayName}</p>
                <p className="text-sm">
                  {selectedPortfolio.broker.replace('_', ' ')} • {selectedPortfolio.riskProfile}
                  {selectedPortfolio.apiEnabled && ' • API Enabled ✓'}
                </p>
              </div>
            )}
          </div>
          
          {/* Buttons */}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh plan"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden md:inline">Refresh</span>
            </button>
            
            <button
              onClick={() => setShowScreenshotModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-colors"
              title="Upload trade screenshot"
            >
              <Camera className="w-5 h-5" />
              <span className="hidden md:inline">Screenshot</span>
            </button>

            <button
              onClick={() => setShowCapitalModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-white text-emerald-600 border border-white rounded-lg hover:bg-emerald-50 transition-colors"
              title="Change capital"
            >
              <DollarSign className="w-5 h-5" />
              <span className="hidden md:inline">Change Capital</span>
            </button>
          </div>
        </div>

        {/* Portfolio Selector Dropdown */}
        {portfolios.length > 1 && (
          <div className="mt-4">
            <label className="block text-sm text-emerald-100 mb-2">Switch Portfolio:</label>
            <select
              value={selectedPortfolioId || ''}
              onChange={handlePortfolioChange}
              className="w-full md:w-auto px-4 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-400"
            >
              {portfolios.map(p => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Portfolio Completeness Alert */}
      {selectedPortfolio && (
        <PortfolioCompletenessAlert
          portfolio={selectedPortfolio}
          linkToPortfolio={true}
        />
      )}

      {/* Money Snapshot */}
      {portfolio && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-green-600" />
            Your Money Snapshot
          </h2>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-blue-50 dark:bg-blue-900/30 rounded-lg p-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Starting Capital</p>
              <p className="text-lg sm:text-2xl font-bold text-blue-900">
                ₹{portfolio.startingCapital?.toLocaleString('en-IN')}
              </p>
            </div>
            <div className="bg-purple-50 dark:bg-purple-900/30 rounded-lg p-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Currently Invested</p>
              <p className="text-lg sm:text-2xl font-bold text-purple-900">
                ₹{portfolio.totalInvested?.toLocaleString('en-IN')}
              </p>
            </div>
            <div className="bg-green-50 dark:bg-green-900/30 rounded-lg p-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Available Cash</p>
              <p className="text-lg sm:text-2xl font-bold text-green-900">
                ₹{portfolio.availableCash?.toLocaleString('en-IN')}
              </p>
            </div>
            <div className="bg-yellow-50 dark:bg-yellow-900/30 rounded-lg p-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Total P&L</p>
              <p className={`text-lg sm:text-2xl font-bold ${portfolio.totalPL >= 0 ? 'text-green-900' : 'text-red-900'}`}>
                {portfolio.totalPL >= 0 ? '+' : ''}₹{portfolio.totalPL?.toLocaleString('en-IN')}
              </p>
              <p className={`text-sm ${portfolio.totalPLPercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {portfolio.totalPLPercent >= 0 ? '+' : ''}{portfolio.totalPLPercent?.toFixed(1)}%
              </p>
            </div>
          </div>

          {/* Reinvestment Section */}
          {reinvestment && (
            <div className={`p-4 rounded-lg ${reinvestment.shouldReinvest ? 'bg-green-50 dark:bg-green-900/30 border border-green-200' : 'bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200'}`}>
              <div className="flex items-start gap-3">
                {reinvestment.shouldReinvest ? (
                  <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0 mt-1" />
                ) : (
                  <AlertCircle className="w-6 h-6 text-yellow-600 flex-shrink-0 mt-1" />
                )}
                <div className="flex-1">
                  <p className={`font-semibold mb-1 ${reinvestment.shouldReinvest ? 'text-green-900' : 'text-yellow-900'}`}>
                    {reinvestment.shouldReinvest ? 'Ready to Invest!' : 'Save More'}
                  </p>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{reinvestment.reason}</p>
                  {reinvestment.shouldReinvest && (
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-gray-600 dark:text-gray-400">Invest Now:</p>
                        <p className="font-bold text-green-900">₹{reinvestment.recommendedAmount?.toLocaleString('en-IN')}</p>
                      </div>
                      <div>
                        <p className="text-gray-600 dark:text-gray-400">Keep as Buffer:</p>
                        <p className="font-bold text-gray-900 dark:text-gray-100">₹{reinvestment.bufferAmount?.toLocaleString('en-IN')}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recommended Allocation */}
      {reinvestment?.shouldReinvest && investmentPlan && (
        <>
          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-6 shadow-md border border-indigo-200">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-100 flex items-center gap-2">
              <PieChart className="w-6 h-6 text-indigo-600" />
              Recommended Allocation
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-white dark:bg-gray-800 rounded-lg p-5 border-2 border-red-200">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-3 h-3 rounded-full bg-red-500"></div>
                  <p className="font-semibold text-gray-900 dark:text-gray-100">High Risk</p>
                </div>
                <p className="text-3xl font-bold text-red-600">
                  ₹{investmentPlan.allocation?.highRisk?.toLocaleString('en-IN')}
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {((investmentPlan.allocation?.highRisk / investmentPlan.totalInvestment) * 100).toFixed(0)}% of plan
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Moon or bust - high volatility</p>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-lg p-5 border-2 border-yellow-200">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                  <p className="font-semibold text-gray-900 dark:text-gray-100">Medium Risk</p>
                </div>
                <p className="text-3xl font-bold text-yellow-600">
                  ₹{investmentPlan.allocation?.mediumRisk?.toLocaleString('en-IN')}
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {((investmentPlan.allocation?.mediumRisk / investmentPlan.totalInvestment) * 100).toFixed(0)}% of plan
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Growth focused - balanced</p>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-lg p-5 border-2 border-green-200">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-3 h-3 rounded-full bg-green-500"></div>
                  <p className="font-semibold text-gray-900 dark:text-gray-100">Low Risk</p>
                </div>
                <p className="text-3xl font-bold text-green-600">
                  ₹{investmentPlan.allocation?.lowRisk?.toLocaleString('en-IN')}
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {((investmentPlan.allocation?.lowRisk / investmentPlan.totalInvestment) * 100).toFixed(0)}% of plan
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Stable returns - safe bet</p>
              </div>
            </div>

            {/* Expected Outcomes */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-5">
              <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-3">Expected Outcome (30 days)</h3>
              <div className="space-y-2">
                <div className="flex justify-between items-center p-3 bg-green-50 dark:bg-green-900/30 rounded">
                  <span className="text-sm text-gray-700 dark:text-gray-300">🚀 Best Case:</span>
                  <div className="text-right">
                    <span className="font-bold text-green-700 text-lg">
                      ₹{investmentPlan.expectedOutcomes?.bestCase?.toLocaleString('en-IN')}
                    </span>
                    <span className="text-green-600 text-sm ml-2">
                      (+{investmentPlan.expectedOutcomes?.bestCasePercent}%)
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center p-3 bg-blue-50 dark:bg-blue-900/30 rounded">
                  <span className="text-sm text-gray-700 dark:text-gray-300">📊 Likely Case:</span>
                  <div className="text-right">
                    <span className="font-bold text-blue-700 text-lg">
                      ₹{investmentPlan.expectedOutcomes?.likelyCase?.toLocaleString('en-IN')}
                    </span>
                    <span className="text-blue-600 text-sm ml-2">
                      (+{investmentPlan.expectedOutcomes?.likelyCasePercent}%)
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center p-3 bg-red-50 dark:bg-red-900/30 rounded">
                  <span className="text-sm text-gray-700 dark:text-gray-300">📉 Worst Case:</span>
                  <div className="text-right">
                    <span className="font-bold text-red-700 text-lg">
                      ₹{investmentPlan.expectedOutcomes?.worstCase?.toLocaleString('en-IN')}
                    </span>
                    <span className="text-red-600 text-sm ml-2">
                      ({investmentPlan.expectedOutcomes?.worstCasePercent}%)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Specific Stock Recommendations */}
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-100">What to Buy Today</h2>
            <div className="space-y-3">
              {investmentPlan.stocks?.slice(0, 5).map((stock, index) => (
                <div key={index} className="flex items-center justify-between flex-wrap gap-2 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${
                      stock.riskCategory === 'high' ? 'bg-red-500' :
                      stock.riskCategory === 'medium' ? 'bg-yellow-500' :
                      'bg-green-500'
                    }`}></div>
                    <div>
                      <p className="font-bold text-gray-900 dark:text-gray-100">{stock.symbol}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">₹{stock.price?.toFixed(2)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="font-bold text-indigo-600">₹{stock.suggestedAmount?.toLocaleString('en-IN')}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{stock.riskCategory} risk</p>
                    </div>
                    {selectedPortfolio?.apiEnabled && (
                      <button
                        onClick={() => {
                          setOrderModal({ stock, action: 'BUY' });
                          setOrderQuantity(Math.max(1, Math.floor((stock.suggestedAmount || 0) / (stock.price || 1))));
                          setOrderResult(null);
                        }}
                        className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-1"
                      >
                        <ShoppingCart className="w-3 h-3" />
                        Buy
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <button className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-4 rounded-lg transition-colors flex items-center justify-center gap-2">
              <TrendingUp className="w-5 h-5" />
              View All Recommendations
            </button>
          </div>

          {/* AI Insights Section */}
          {aiInsights && (
            <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-md border border-gray-200 dark:border-gray-700">
              <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-100 flex items-center gap-2">
                <AlertCircle className="w-6 h-6 text-indigo-600" />
                AI Analysis
              </h2>

              {/* Rating Badge + Confidence */}
              <div className="flex items-center gap-4 mb-5">
                <span className={`px-4 py-2 rounded-full text-sm font-bold ${
                  aiInsights.overallRating === 'EXCELLENT' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' :
                  aiInsights.overallRating === 'GOOD' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' :
                  aiInsights.overallRating === 'MODERATE' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300' :
                  'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                }`}>
                  {aiInsights.overallRating}
                </span>
                {aiInsights.confidence && (
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          aiInsights.confidence >= 80 ? 'bg-green-500' :
                          aiInsights.confidence >= 60 ? 'bg-blue-500' :
                          'bg-yellow-500'
                        }`}
                        style={{ width: `${aiInsights.confidence}%` }}
                      />
                    </div>
                    <span className="text-sm text-gray-600 dark:text-gray-400">{aiInsights.confidence}% confidence</span>
                  </div>
                )}
              </div>

              {/* Key Insights */}
              {aiInsights.keyInsights?.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Key Insights</h3>
                  <ul className="space-y-1.5">
                    {aiInsights.keyInsights.map((insight, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <span className="text-blue-500 mt-0.5">&#x2022;</span>
                        {insight}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Warnings */}
              {aiInsights.warnings?.length > 0 && (
                <div className="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-2">Warnings</h3>
                  <ul className="space-y-1.5">
                    {aiInsights.warnings.map((warning, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
                        <span className="mt-0.5">&#x26A0;</span>
                        {warning}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Action Items */}
              {aiInsights.actionItems?.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Action Items</h3>
                  <ul className="space-y-1.5">
                    {aiInsights.actionItems.map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Personalized Advice */}
              {aiInsights.personalizedAdvice && (
                <div className="mb-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-indigo-800 dark:text-indigo-300 mb-1">Personalized Advice</h3>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{aiInsights.personalizedAdvice}</p>
                </div>
              )}

              {/* Risk Assessment */}
              {aiInsights.riskAssessment && (
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">Risk Assessment</h3>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{aiInsights.riskAssessment}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}
      
      {/* Capital Change Modal */}
      <CapitalChangeModal
        isOpen={showCapitalModal}
        onClose={() => setShowCapitalModal(false)}
        portfolio={selectedPortfolio}
        onSuccess={handleCapitalUpdated}
      />

      {/* Upstox Order Modal */}
      {orderModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">Buy via Upstox</h3>
              <button onClick={() => { setOrderModal(null); setOrderResult(null); }} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                <p className="font-bold text-lg text-gray-900 dark:text-gray-100">{orderModal.stock.symbol}</p>
                <p className="text-gray-600 dark:text-gray-400">₹{orderModal.stock.price?.toFixed(2)} per share</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantity</label>
                <input
                  type="number"
                  min="1"
                  value={orderQuantity}
                  onChange={(e) => setOrderQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                />
              </div>

              <div className="bg-green-50 dark:bg-green-900/30 rounded-lg p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">Estimated Cost:</span>
                  <span className="font-bold text-green-700">₹{(orderQuantity * (orderModal.stock.price || 0)).toLocaleString('en-IN')}</span>
                </div>
              </div>

              {orderResult && (
                <div className={`rounded-lg p-3 text-sm ${orderResult.error ? 'bg-red-50 dark:bg-red-900/30 text-red-700' : 'bg-green-50 dark:bg-green-900/30 text-green-700'}`}>
                  {orderResult.error ? `Error: ${orderResult.error}` : `Order placed! ID: ${orderResult.orderId}`}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => { setOrderModal(null); setOrderResult(null); }}
                  className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePlaceOrder}
                  disabled={orderLoading}
                  className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {orderLoading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShoppingCart className="w-4 h-4" />
                  )}
                  {orderLoading ? 'Placing...' : 'Place Order'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Screenshot Upload Modal */}
      {showScreenshotModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">Upload Trade Screenshot</h3>
              <button onClick={() => { setShowScreenshotModal(false); setScreenshotFile(null); setScreenshotPreview(null); setScreenshotResult(null); }} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* File input */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
              >
                {screenshotPreview ? (
                  <img src={screenshotPreview} alt="Preview" className="max-h-48 mx-auto rounded-lg" />
                ) : (
                  <>
                    <Upload className="w-10 h-10 mx-auto text-gray-400 mb-3" />
                    <p className="text-gray-600 dark:text-gray-400">Click to upload screenshot</p>
                    <p className="text-xs text-gray-400 mt-1">JPEG, PNG, WebP (max 10MB)</p>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={handleScreenshotSelect}
                className="hidden"
              />

              {/* Upload button */}
              {screenshotFile && !screenshotResult && (
                <button
                  onClick={handleScreenshotUpload}
                  disabled={screenshotLoading}
                  className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {screenshotLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Analyzing with AI...
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4" />
                      Extract Trade Data
                    </>
                  )}
                </button>
              )}

              {/* Results — editable review */}
              {screenshotResult && !screenshotResult.error && (
                <div className="space-y-3">
                  <div className="bg-green-50 dark:bg-green-900/30 rounded-lg p-4">
                    <p className="font-semibold text-green-800 mb-1">Review Extracted Trade(s)</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                      AI confidence: {Math.round((screenshotResult.confidence || 0) * 100)}%. Edit any incorrect values before confirming.
                    </p>

                    {editedTrades.map((t, i) => (
                      <div key={i} className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-3 border border-green-200 space-y-3">
                        {editedTrades.length > 1 && (
                          <p className="text-xs font-semibold text-gray-400 uppercase">Trade {i + 1}</p>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Symbol</label>
                            <input
                              type="text"
                              value={t.symbol || ''}
                              onChange={(e) => {
                                const updated = [...editedTrades];
                                updated[i] = { ...updated[i], symbol: e.target.value.toUpperCase() };
                                setEditedTrades(updated);
                              }}
                              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-semibold focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Type</label>
                            <select
                              value={t.tradeType || 'BUY'}
                              onChange={(e) => {
                                const updated = [...editedTrades];
                                updated[i] = { ...updated[i], tradeType: e.target.value };
                                setEditedTrades(updated);
                              }}
                              className={`w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-semibold focus:ring-2 focus:ring-green-500 focus:border-green-500 ${t.tradeType === 'BUY' ? 'text-green-700' : 'text-red-700'}`}
                            >
                              <option value="BUY">BUY</option>
                              <option value="SELL">SELL</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Quantity</label>
                            <input
                              type="number"
                              min="1"
                              value={t.quantity || ''}
                              onChange={(e) => {
                                const updated = [...editedTrades];
                                updated[i] = { ...updated[i], quantity: parseInt(e.target.value) || '' };
                                setEditedTrades(updated);
                              }}
                              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-semibold focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Price (INR)</label>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={t.price || ''}
                              onChange={(e) => {
                                const updated = [...editedTrades];
                                updated[i] = { ...updated[i], price: parseFloat(e.target.value) || '' };
                                setEditedTrades(updated);
                              }}
                              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-semibold focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            />
                          </div>
                        </div>
                        {t.broker && <p className="text-xs text-gray-400">Detected broker: {t.broker}</p>}
                      </div>
                    ))}
                  </div>

                  <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
                    Please verify the details above are correct. Confirming will add these trades to your portfolio.
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => { setScreenshotResult(null); setScreenshotFile(null); setScreenshotPreview(null); setEditedTrades([]); }}
                      className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Discard
                    </button>
                    <button
                      onClick={handleConfirmScreenshotTrade}
                      disabled={screenshotLoading || editedTrades.some(t => !t.symbol || !t.quantity || !t.price)}
                      className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-semibold"
                    >
                      {screenshotLoading ? 'Saving...' : 'Confirm & Add to Portfolio'}
                    </button>
                  </div>
                </div>
              )}

              {screenshotResult?.error && (
                <div className="bg-red-50 dark:bg-red-900/30 rounded-lg p-3 text-sm text-red-700">
                  Error: {screenshotResult.error}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}