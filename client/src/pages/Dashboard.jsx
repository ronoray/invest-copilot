import { useState, useEffect } from 'react';
import { LineChart, Line, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { TrendingUp, TrendingDown, AlertCircle, CheckCircle, Clock, Lightbulb, ArrowRight } from 'lucide-react';

export default function Dashboard() {
  const [portfolioData, setPortfolioData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Mock data - replace with API call
  const stats = {
    portfolioValue: 4480.84,
    investedValue: 2169.46,
    unrealizedPL: 2311.40,
    unrealizedPLPercent: 106.54,
    todayPL: -89.88,
    todayPLPercent: -1.97,
    realizedPL: 918.80
  };

  // Portfolio distribution (mock data)
  const portfolioDistribution = [
    { name: 'Technology', value: 35, color: '#3b82f6' },
    { name: 'Banking', value: 30, color: '#8b5cf6' },
    { name: 'FMCG', value: 20, color: '#10b981' },
    { name: 'Pharma', value: 15, color: '#f59e0b' }
  ];

  // Portfolio trend (mock data - last 30 days)
  const portfolioTrend = [
    { date: 'Jan 5', value: 3850 },
    { date: 'Jan 12', value: 4020 },
    { date: 'Jan 19', value: 3980 },
    { date: 'Jan 26', value: 4280 },
    { date: 'Feb 2', value: 4480.84 }
  ];

  // AI Recommendations (mock)
  const aiRecommendations = [
    {
      id: 1,
      stock: 'HDFCBANK',
      action: 'BUY',
      confidence: 78,
      price: 1680,
      target: 1850,
      reason: 'Strong Q4 results, FII buying, technical breakout',
      risk: 6
    },
    {
      id: 2,
      stock: 'RELIANCE',
      action: 'HOLD',
      confidence: 65,
      price: 2450,
      target: 2600,
      reason: 'Consolidation phase, wait for breakout confirmation',
      risk: 5
    }
  ];

  useEffect(() => {
    // Simulate API call
    setTimeout(() => setLoading(false), 500);
  }, []);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-xl p-6 text-white shadow-lg">
        <h1 className="text-2xl md:text-3xl font-bold mb-2">
          {getGreeting()}, Rono! ☀️
        </h1>
        <p className="text-blue-100">Here's your investment overview</p>
      </div>

      {/* Quick Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Portfolio Value */}
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-6 border border-blue-200 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-blue-700">Portfolio Value</h3>
            <TrendingUp className="w-5 h-5 text-blue-600" />
          </div>
          <p className="text-3xl font-bold text-blue-900">₹{stats.portfolioValue.toLocaleString('en-IN')}</p>
          <p className="text-sm text-green-600 mt-1 font-semibold">
            +₹{stats.unrealizedPL.toLocaleString('en-IN')} ({stats.unrealizedPLPercent}%)
          </p>
        </div>

        {/* Today's P&L */}
        <div className="bg-gradient-to-br from-red-50 to-red-100 rounded-xl p-6 border border-red-200 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-red-700">Today's P&L</h3>
            <TrendingDown className="w-5 h-5 text-red-600" />
          </div>
          <p className="text-3xl font-bold text-red-900">₹{Math.abs(stats.todayPL).toLocaleString('en-IN')}</p>
          <p className="text-sm text-red-600 mt-1 font-semibold">
            {stats.todayPLPercent}% today
          </p>
        </div>

        {/* Invested Amount */}
        <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-6 border border-purple-200 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-purple-700">Invested</h3>
            <CheckCircle className="w-5 h-5 text-purple-600" />
          </div>
          <p className="text-3xl font-bold text-purple-900">₹{stats.investedValue.toLocaleString('en-IN')}</p>
          <p className="text-sm text-purple-600 mt-1">Total capital</p>
        </div>

        {/* Realized P&L */}
        <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-6 border border-green-200 hover:shadow-lg transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-green-700">Realized P&L</h3>
            <CheckCircle className="w-5 h-5 text-green-600" />
          </div>
          <p className="text-3xl font-bold text-green-900">₹{stats.realizedPL.toLocaleString('en-IN')}</p>
          <p className="text-sm text-green-600 mt-1">Booked profit</p>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Portfolio Trend */}
        <div className="lg:col-span-2 bg-white rounded-xl p-6 shadow-md border border-gray-200">
          <h2 className="text-xl font-semibold mb-4 text-gray-800">Portfolio Trend (30 Days)</h2>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={portfolioTrend}>
              <XAxis dataKey="date" stroke="#9ca3af" />
              <YAxis stroke="#9ca3af" />
              <Tooltip 
                contentStyle={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                formatter={(value) => [`₹${value.toLocaleString('en-IN')}`, 'Portfolio']}
              />
              <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={3} dot={{ fill: '#3b82f6', r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Sector Distribution */}
        <div className="bg-white rounded-xl p-6 shadow-md border border-gray-200">
          <h2 className="text-xl font-semibold mb-4 text-gray-800">Sector Split</h2>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={portfolioDistribution}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={2}
                dataKey="value"
              >
                {portfolioDistribution.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => `${value}%`} />
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-4 space-y-2">
            {portfolioDistribution.map((sector) => (
              <div key={sector.name} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: sector.color }}></div>
                  <span className="text-gray-700">{sector.name}</span>
                </div>
                <span className="font-semibold text-gray-900">{sector.value}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* AI Recommendations */}
      <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-6 shadow-md border border-indigo-200">
        <div className="flex items-center gap-2 mb-4">
          <Lightbulb className="w-6 h-6 text-indigo-600" />
          <h2 className="text-xl font-semibold text-gray-800">AI Insights</h2>
          <span className="ml-auto text-sm text-indigo-600 font-medium">{aiRecommendations.length} active</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {aiRecommendations.map((rec) => (
            <div key={rec.id} className="bg-white rounded-lg p-5 shadow-sm border border-indigo-100 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{rec.stock}</h3>
                  <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold mt-1 ${
                    rec.action === 'BUY' ? 'bg-green-100 text-green-700' :
                    rec.action === 'SELL' ? 'bg-red-100 text-red-700' :
                    'bg-yellow-100 text-yellow-700'
                  }`}>
                    {rec.action}
                  </span>
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-500">Confidence</p>
                  <p className="text-xl font-bold text-indigo-600">{rec.confidence}%</p>
                </div>
              </div>

              <div className="space-y-2 mb-3">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Entry:</span>
                  <span className="font-semibold text-gray-900">₹{rec.price}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Target:</span>
                  <span className="font-semibold text-green-600">₹{rec.target}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Risk Score:</span>
                  <span className="font-semibold text-gray-900">{rec.risk}/10</span>
                </div>
              </div>

              <p className="text-sm text-gray-600 mb-3">{rec.reason}</p>

              <button className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2">
                View Details
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Market Status */}
      <div className="bg-white rounded-xl p-6 shadow-md border border-gray-200">
        <h2 className="text-xl font-semibold mb-4 text-gray-800">Market Status</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center gap-4 p-4 bg-green-50 rounded-lg border border-green-200">
            <div className="flex-1">
              <p className="text-sm text-gray-600 mb-1">NIFTY 50</p>
              <p className="text-2xl font-bold text-gray-900">21,456.32</p>
              <p className="text-sm text-green-600 font-semibold">+0.84% (+179.23)</p>
            </div>
            <TrendingUp className="w-8 h-8 text-green-600" />
          </div>

          <div className="flex items-center gap-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
            <div className="flex-1">
              <p className="text-sm text-gray-600 mb-1">SENSEX</p>
              <p className="text-2xl font-bold text-gray-900">70,842.25</p>
              <p className="text-sm text-green-600 font-semibold">+0.92% (+645.12)</p>
            </div>
            <TrendingUp className="w-8 h-8 text-blue-600" />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-sm text-gray-600">
          <Clock className="w-4 h-4" />
          <span>Market Hours: 9:15 AM - 3:30 PM IST</span>
          <span className="ml-auto px-3 py-1 bg-green-100 text-green-700 rounded-full font-medium text-xs">
            OPEN
          </span>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <button className="bg-white hover:bg-gray-50 border-2 border-gray-200 rounded-xl p-4 text-center transition-all hover:shadow-md">
          <div className="text-2xl mb-2">💰</div>
          <p className="font-semibold text-gray-900">Add Holding</p>
        </button>
        <button className="bg-white hover:bg-gray-50 border-2 border-gray-200 rounded-xl p-4 text-center transition-all hover:shadow-md">
          <div className="text-2xl mb-2">🔄</div>
          <p className="font-semibold text-gray-900">Sync Prices</p>
        </button>
        <button className="bg-white hover:bg-gray-50 border-2 border-gray-200 rounded-xl p-4 text-center transition-all hover:shadow-md">
          <div className="text-2xl mb-2">📊</div>
          <p className="font-semibold text-gray-900">View Reports</p>
        </button>
        <button className="bg-white hover:bg-gray-50 border-2 border-gray-200 rounded-xl p-4 text-center transition-all hover:shadow-md">
          <div className="text-2xl mb-2">🧾</div>
          <p className="font-semibold text-gray-900">Tax Dashboard</p>
        </button>
      </div>
    </div>
  );
}