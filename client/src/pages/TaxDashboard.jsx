import { useState } from 'react';
import { Receipt, TrendingUp, Calendar, AlertCircle, CheckCircle, Target, FileText } from 'lucide-react';

export default function TaxDashboard() {
  const [selectedYear, setSelectedYear] = useState('2025-26');

  // Mock tax data - will be calculated from actual trades
  const taxData = {
    ltcg: {
      realized: 65000,
      unrealized: 180000,
      exempt: 125000,
      remaining: 60000,
      taxable: 0,
      taxAmount: 0
    },
    stcg: {
      realized: 15000,
      unrealized: 45000,
      taxRate: 20, // 20% for STCG in equity
      taxAmount: 3000
    },
    totalTaxLiability: 3000,
    opportunities: [
      {
        id: 1,
        stock: 'TCS',
        currentValue: 85000,
        purchaseValue: 35000,
        gain: 50000,
        holdingPeriod: 14, // months
        type: 'LTCG',
        suggestion: 'Sell before March 31 to harvest tax-free LTCG',
        taxSaving: 0,
        priority: 'high'
      },
      {
        id: 2,
        stock: 'WIPRO',
        currentValue: 42000,
        purchaseValue: 32000,
        gain: 10000,
        holdingPeriod: 8, // months
        type: 'STCG',
        suggestion: 'Hold for 4 more months to convert to LTCG',
        taxSaving: 2000,
        priority: 'medium'
      }
    ]
  };

  const holdings = [
    {
      id: 1,
      stock: 'HDFCBANK',
      quantity: 5,
      avgPrice: 1642,
      currentPrice: 1680,
      currentValue: 8400,
      investedValue: 8210,
      unrealizedGain: 190,
      purchaseDate: '2025-06-15',
      holdingPeriod: 8,
      type: 'STCG',
      taxOnExit: 38 // 20% of 190
    },
    {
      id: 2,
      stock: 'RELIANCE',
      quantity: 2,
      avgPrice: 2350,
      currentPrice: 2450,
      currentValue: 4900,
      investedValue: 4700,
      unrealizedGain: 200,
      purchaseDate: '2024-12-10',
      holdingPeriod: 14,
      type: 'LTCG',
      taxOnExit: 0 // Within exempt limit
    },
    {
      id: 3,
      stock: 'INFY',
      quantity: 3,
      avgPrice: 1750,
      currentPrice: 1820,
      currentValue: 5460,
      investedValue: 5250,
      unrealizedGain: 210,
      purchaseDate: '2025-08-20',
      holdingPeriod: 6,
      type: 'STCG',
      taxOnExit: 42
    }
  ];

  const getHoldingBadgeColor = (type) => {
    return type === 'LTCG' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700';
  };

  const getPriorityColor = (priority) => {
    switch(priority) {
      case 'high': return 'bg-red-100 text-red-700 border-red-300';
      case 'medium': return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'low': return 'bg-green-100 text-green-700 border-green-300';
      default: return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  const calculateTimeToLTCG = (months) => {
    const remaining = 12 - months;
    if (remaining <= 0) return 'Already LTCG';
    if (remaining === 1) return '1 month';
    return `${remaining} months`;
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl p-6 text-white shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-3">
              <Receipt className="w-8 h-8" />
              Tax Dashboard
            </h1>
            <p className="text-emerald-100">Track LTCG/STCG and optimize tax liability</p>
          </div>
          <select 
            value={selectedYear}
            onChange={(e) => setSelectedYear(e.target.value)}
            className="bg-white text-gray-900 px-4 py-2 rounded-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-300"
          >
            <option value="2025-26">FY 2025-26</option>
            <option value="2024-25">FY 2024-25</option>
            <option value="2023-24">FY 2023-24</option>
          </select>
        </div>
      </div>

      {/* Tax Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* LTCG Exempt Used */}
        <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl p-6 border-2 border-green-200">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-green-700">LTCG Exempt Used</h3>
            <CheckCircle className="w-5 h-5 text-green-600" />
          </div>
          <p className="text-3xl font-bold text-green-900">₹{taxData.ltcg.realized.toLocaleString('en-IN')}</p>
          <div className="mt-2 bg-green-200 rounded-full h-2">
            <div 
              className="bg-green-600 rounded-full h-2" 
              style={{ width: `${(taxData.ltcg.realized / taxData.ltcg.exempt) * 100}%` }}
            ></div>
          </div>
          <p className="text-xs text-green-700 mt-1">
            of ₹{taxData.ltcg.exempt.toLocaleString('en-IN')} limit
          </p>
        </div>

        {/* LTCG Remaining */}
        <div className="bg-gradient-to-br from-blue-50 to-cyan-50 rounded-xl p-6 border-2 border-blue-200">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-blue-700">LTCG Remaining</h3>
            <Target className="w-5 h-5 text-blue-600" />
          </div>
          <p className="text-3xl font-bold text-blue-900">₹{taxData.ltcg.remaining.toLocaleString('en-IN')}</p>
          <p className="text-sm text-blue-600 mt-1 font-semibold">
            Tax-free opportunity
          </p>
        </div>

        {/* STCG Tax Paid */}
        <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-xl p-6 border-2 border-orange-200">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-orange-700">STCG Tax</h3>
            <Receipt className="w-5 h-5 text-orange-600" />
          </div>
          <p className="text-3xl font-bold text-orange-900">₹{taxData.stcg.taxAmount.toLocaleString('en-IN')}</p>
          <p className="text-sm text-orange-600 mt-1">
            @20% on ₹{taxData.stcg.realized.toLocaleString('en-IN')}
          </p>
        </div>

        {/* Total Tax Liability */}
        <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-xl p-6 border-2 border-purple-200">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-purple-700">Total Tax Liability</h3>
            <FileText className="w-5 h-5 text-purple-600" />
          </div>
          <p className="text-3xl font-bold text-purple-900">₹{taxData.totalTaxLiability.toLocaleString('en-IN')}</p>
          <p className="text-sm text-purple-600 mt-1">
            Current FY
          </p>
        </div>
      </div>

      {/* Tax Rules Info */}
      <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-5">
        <div className="flex gap-3">
          <AlertCircle className="w-6 h-6 text-blue-600 flex-shrink-0 mt-1" />
          <div className="text-sm text-blue-900">
            <p className="font-semibold mb-2">Tax Rules (Equity):</p>
            <ul className="space-y-1">
              <li><strong>LTCG</strong> (held &gt; 12 months): First ₹1,25,000 exempt, then 12.5% tax</li>
              <li><strong>STCG</strong> (held ≤ 12 months): 20% flat tax</li>
              <li><strong>Year End</strong>: March 31 - Plan your exits before this date</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Tax Optimization Opportunities */}
      <div className="bg-white rounded-xl p-6 shadow-md border border-gray-200">
        <h2 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-emerald-600" />
          Tax Optimization Opportunities
        </h2>
        
        <div className="space-y-4">
          {taxData.opportunities.map((opp) => (
            <div key={opp.id} className={`border-2 rounded-lg p-5 ${getPriorityColor(opp.priority)}`}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">{opp.stock}</h3>
                  <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold mt-1 ${
                    opp.type === 'LTCG' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {opp.type}
                  </span>
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-600">Unrealized Gain</p>
                  <p className="text-xl font-bold text-green-600">₹{opp.gain.toLocaleString('en-IN')}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-3 text-sm">
                <div>
                  <p className="text-gray-600">Current Value</p>
                  <p className="font-semibold text-gray-900">₹{opp.currentValue.toLocaleString('en-IN')}</p>
                </div>
                <div>
                  <p className="text-gray-600">Purchase Value</p>
                  <p className="font-semibold text-gray-900">₹{opp.purchaseValue.toLocaleString('en-IN')}</p>
                </div>
                <div>
                  <p className="text-gray-600">Holding Period</p>
                  <p className="font-semibold text-gray-900">{opp.holdingPeriod} months</p>
                </div>
                <div>
                  <p className="text-gray-600">Potential Saving</p>
                  <p className="font-semibold text-emerald-600">₹{opp.taxSaving.toLocaleString('en-IN')}</p>
                </div>
              </div>

              <div className="bg-white rounded-lg p-3 mb-3">
                <p className="text-gray-900 font-medium">{opp.suggestion}</p>
              </div>

              <div className="flex gap-2">
                <button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors">
                  Execute Strategy
                </button>
                <button className="bg-white hover:bg-gray-50 text-gray-700 font-semibold py-2 px-4 rounded-lg border-2 border-gray-300 transition-colors">
                  Learn More
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Current Holdings with Tax Impact */}
      <div className="bg-white rounded-xl p-6 shadow-md border border-gray-200">
        <h2 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
          <Calendar className="w-6 h-6 text-blue-600" />
          Holdings Tax Breakdown
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-gray-200">
                <th className="text-left py-3 px-4 font-semibold text-gray-700">Stock</th>
                <th className="text-right py-3 px-4 font-semibold text-gray-700">Qty</th>
                <th className="text-right py-3 px-4 font-semibold text-gray-700">Invested</th>
                <th className="text-right py-3 px-4 font-semibold text-gray-700">Current</th>
                <th className="text-right py-3 px-4 font-semibold text-gray-700">Gain</th>
                <th className="text-center py-3 px-4 font-semibold text-gray-700">Type</th>
                <th className="text-center py-3 px-4 font-semibold text-gray-700">Holding</th>
                <th className="text-right py-3 px-4 font-semibold text-gray-700">Tax on Exit</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((holding) => (
                <tr key={holding.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 px-4 font-semibold text-gray-900">{holding.stock}</td>
                  <td className="text-right py-3 px-4 text-gray-700">{holding.quantity}</td>
                  <td className="text-right py-3 px-4 text-gray-700">₹{holding.investedValue.toLocaleString('en-IN')}</td>
                  <td className="text-right py-3 px-4 text-gray-700">₹{holding.currentValue.toLocaleString('en-IN')}</td>
                  <td className="text-right py-3 px-4 text-green-600 font-semibold">+₹{holding.unrealizedGain}</td>
                  <td className="text-center py-3 px-4">
                    <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getHoldingBadgeColor(holding.type)}`}>
                      {holding.type}
                    </span>
                  </td>
                  <td className="text-center py-3 px-4 text-gray-700 text-sm">
                    {holding.holdingPeriod}m
                    {holding.type === 'STCG' && (
                      <p className="text-xs text-gray-500 mt-1">
                        {calculateTimeToLTCG(holding.holdingPeriod)} to LTCG
                      </p>
                    )}
                  </td>
                  <td className="text-right py-3 px-4">
                    {holding.taxOnExit === 0 ? (
                      <span className="text-green-600 font-semibold">₹0</span>
                    ) : (
                      <span className="text-orange-600 font-semibold">₹{holding.taxOnExit}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-gray-300 bg-gray-50">
              <tr>
                <td colSpan="4" className="py-3 px-4 font-bold text-gray-900">Total Tax on Exit</td>
                <td colSpan="4" className="text-right py-3 px-4 font-bold text-orange-600 text-lg">
                  ₹{holdings.reduce((sum, h) => sum + h.taxOnExit, 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Export Reports */}
      <div className="flex gap-4">
        <button className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2 border-2 border-gray-300">
          <FileText className="w-5 h-5" />
          Download Tax Report (PDF)
        </button>
        <button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2">
          <Calendar className="w-5 h-5" />
          Year-End Tax Planning
        </button>
      </div>
    </div>
  );
}