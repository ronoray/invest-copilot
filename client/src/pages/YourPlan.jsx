import { useState, useEffect } from 'react';
import { Target, TrendingUp, DollarSign, PieChart, AlertCircle, CheckCircle } from 'lucide-react';
import { api } from '../utils/api';

export default function YourPlan() {
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState(null);

  useEffect(() => {
    loadPlan();
  }, []);

  const loadPlan = async () => {
    setLoading(true);
    try {
      const data = await api.get('/ai/portfolio-plan');
      setPlan(data);
    } catch (error) {
      console.error('Failed to load plan:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Building your investment plan...</p>
        </div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="bg-white rounded-xl p-12 text-center">
        <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
        <p className="text-gray-600">Failed to load plan</p>
      </div>
    );
  }

  const { portfolio, reinvestment, plan: investmentPlan } = plan;

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl p-6 text-white shadow-lg">
        <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-3">
          <Target className="w-8 h-8" />
          Your Investment Plan
        </h1>
        <p className="text-emerald-100">Personalized allocation based on your portfolio</p>
      </div>

      {/* Money Snapshot */}
      <div className="bg-white rounded-xl p-6 shadow-md border border-gray-200">
        <h2 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
          <DollarSign className="w-6 h-6 text-green-600" />
          Your Money Snapshot
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-blue-50 rounded-lg p-4">
            <p className="text-sm text-gray-600 mb-1">Starting Capital</p>
            <p className="text-2xl font-bold text-blue-900">
              ₹{portfolio.startingCapital?.toLocaleString('en-IN')}
            </p>
          </div>
          <div className="bg-purple-50 rounded-lg p-4">
            <p className="text-sm text-gray-600 mb-1">Currently Invested</p>
            <p className="text-2xl font-bold text-purple-900">
              ₹{portfolio.totalInvested?.toLocaleString('en-IN')}
            </p>
          </div>
          <div className="bg-green-50 rounded-lg p-4">
            <p className="text-sm text-gray-600 mb-1">Available Cash</p>
            <p className="text-2xl font-bold text-green-900">
              ₹{portfolio.availableCash?.toLocaleString('en-IN')}
            </p>
          </div>
          <div className="bg-yellow-50 rounded-lg p-4">
            <p className="text-sm text-gray-600 mb-1">Total P&L</p>
            <p className={`text-2xl font-bold ${portfolio.totalPL >= 0 ? 'text-green-900' : 'text-red-900'}`}>
              {portfolio.totalPL >= 0 ? '+' : ''}₹{portfolio.totalPL?.toLocaleString('en-IN')}
            </p>
            <p className={`text-sm ${portfolio.totalPLPercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {portfolio.totalPLPercent >= 0 ? '+' : ''}{portfolio.totalPLPercent?.toFixed(1)}%
            </p>
          </div>
        </div>

        {/* Reinvestment Section */}
        <div className={`p-4 rounded-lg ${reinvestment.shouldReinvest ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}>
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
              <p className="text-sm text-gray-700">{reinvestment.reason}</p>
              {reinvestment.shouldReinvest && (
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-gray-600">Invest Now:</p>
                    <p className="font-bold text-green-900">₹{reinvestment.recommendedAmount?.toLocaleString('en-IN')}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Keep as Buffer:</p>
                    <p className="font-bold text-gray-900">₹{reinvestment.bufferAmount?.toLocaleString('en-IN')}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Recommended Allocation */}
      {reinvestment.shouldReinvest && investmentPlan && (
        <>
          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-6 shadow-md border border-indigo-200">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
              <PieChart className="w-6 h-6 text-indigo-600" />
              Recommended Allocation
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-white rounded-lg p-5 border-2 border-red-200">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-3 h-3 rounded-full bg-red-500"></div>
                  <p className="font-semibold text-gray-900">High Risk</p>
                </div>
                <p className="text-3xl font-bold text-red-600">
                  ₹{investmentPlan.allocation?.highRisk?.toLocaleString('en-IN')}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {((investmentPlan.allocation?.highRisk / investmentPlan.totalInvestment) * 100).toFixed(0)}% of plan
                </p>
                <p className="text-xs text-gray-500 mt-2">Moon or bust - high volatility</p>
              </div>

              <div className="bg-white rounded-lg p-5 border-2 border-yellow-200">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                  <p className="font-semibold text-gray-900">Medium Risk</p>
                </div>
                <p className="text-3xl font-bold text-yellow-600">
                  ₹{investmentPlan.allocation?.mediumRisk?.toLocaleString('en-IN')}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {((investmentPlan.allocation?.mediumRisk / investmentPlan.totalInvestment) * 100).toFixed(0)}% of plan
                </p>
                <p className="text-xs text-gray-500 mt-2">Growth focused - balanced</p>
              </div>

              <div className="bg-white rounded-lg p-5 border-2 border-green-200">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-3 h-3 rounded-full bg-green-500"></div>
                  <p className="font-semibold text-gray-900">Low Risk</p>
                </div>
                <p className="text-3xl font-bold text-green-600">
                  ₹{investmentPlan.allocation?.lowRisk?.toLocaleString('en-IN')}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {((investmentPlan.allocation?.lowRisk / investmentPlan.totalInvestment) * 100).toFixed(0)}% of plan
                </p>
                <p className="text-xs text-gray-500 mt-2">Stable returns - safe bet</p>
              </div>
            </div>

            {/* Expected Outcomes */}
            <div className="bg-white rounded-lg p-5">
              <h3 className="font-semibold text-gray-900 mb-3">Expected Outcome (30 days)</h3>
              <div className="space-y-2">
                <div className="flex justify-between items-center p-3 bg-green-50 rounded">
                  <span className="text-sm text-gray-700">🚀 Best Case:</span>
                  <div className="text-right">
                    <span className="font-bold text-green-700 text-lg">
                      ₹{investmentPlan.expectedOutcomes?.bestCase?.toLocaleString('en-IN')}
                    </span>
                    <span className="text-green-600 text-sm ml-2">
                      (+{investmentPlan.expectedOutcomes?.bestCasePercent}%)
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center p-3 bg-blue-50 rounded">
                  <span className="text-sm text-gray-700">📊 Likely Case:</span>
                  <div className="text-right">
                    <span className="font-bold text-blue-700 text-lg">
                      ₹{investmentPlan.expectedOutcomes?.likelyCase?.toLocaleString('en-IN')}
                    </span>
                    <span className="text-blue-600 text-sm ml-2">
                      (+{investmentPlan.expectedOutcomes?.likelyCasePercent}%)
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center p-3 bg-red-50 rounded">
                  <span className="text-sm text-gray-700">📉 Worst Case:</span>
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
          <div className="bg-white rounded-xl p-6 shadow-md border border-gray-200">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">What to Buy Today</h2>
            <div className="space-y-3">
              {investmentPlan.stocks?.slice(0, 5).map((stock, index) => (
                <div key={index} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${
                      stock.riskCategory === 'high' ? 'bg-red-500' :
                      stock.riskCategory === 'medium' ? 'bg-yellow-500' :
                      'bg-green-500'
                    }`}></div>
                    <div>
                      <p className="font-bold text-gray-900">{stock.symbol}</p>
                      <p className="text-sm text-gray-600">₹{stock.price?.toFixed(2)}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-indigo-600">₹{stock.suggestedAmount?.toLocaleString('en-IN')}</p>
                    <p className="text-xs text-gray-500">{stock.riskCategory} risk</p>
                  </div>
                </div>
              ))}
            </div>

            <button className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-4 rounded-lg transition-colors flex items-center justify-center gap-2">
              <TrendingUp className="w-5 h-5" />
              View All Recommendations
            </button>
          </div>
        </>
      )}
    </div>
  );
}