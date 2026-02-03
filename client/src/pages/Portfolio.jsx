import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { portfolio } from '../api/client';
import { RefreshCw, Plus, TrendingUp, TrendingDown } from 'lucide-react';
import { useState } from 'react';

export default function Portfolio() {
  const [showAddForm, setShowAddForm] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['portfolio'],
    queryFn: async () => {
      const res = await portfolio.getAll();
      return res.data;
    }
  });

  const syncMutation = useMutation({
    mutationFn: () => portfolio.sync(),
    onSuccess: () => {
      queryClient.invalidateQueries(['portfolio']);
    }
  });

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card bg-red-50 border border-red-200">
        <p className="text-red-700">Error loading portfolio: {error.message}</p>
      </div>
    );
  }

  const { holdings = [], summary = {} } = data || {};
  const isProfit = summary.unrealizedPL >= 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Portfolio</h1>
        <div className="flex gap-3">
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="btn btn-secondary flex items-center gap-2"
          >
            <RefreshCw size={18} className={syncMutation.isPending ? 'animate-spin' : ''} />
            Sync Prices
          </button>
          <button
            onClick={() => setShowAddForm(true)}
            className="btn btn-primary flex items-center gap-2"
          >
            <Plus size={18} />
            Add Holding
          </button>
        </div>
      </div>

      {/* Summary Card */}
      <div className="card bg-gradient-to-r from-blue-500 to-blue-600 text-white">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div>
            <p className="text-blue-100 text-sm mb-1">Total Invested</p>
            <p className="text-3xl font-bold">₹{summary.totalInvested?.toFixed(2) || 0}</p>
          </div>
          <div>
            <p className="text-blue-100 text-sm mb-1">Current Value</p>
            <p className="text-3xl font-bold">₹{summary.totalCurrent?.toFixed(2) || 0}</p>
          </div>
          <div>
            <p className="text-blue-100 text-sm mb-1">Unrealized P&L</p>
            <div className="flex items-center gap-2">
              <p className="text-3xl font-bold">₹{summary.unrealizedPL?.toFixed(2) || 0}</p>
              {isProfit ? <TrendingUp size={24} /> : <TrendingDown size={24} />}
            </div>
          </div>
          <div>
            <p className="text-blue-100 text-sm mb-1">Returns</p>
            <p className={`text-3xl font-bold ${isProfit ? 'text-green-300' : 'text-red-300'}`}>
              {summary.plPercent || 0}%
            </p>
          </div>
        </div>
      </div>

      {/* Holdings Table */}
      {holdings.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500 text-lg mb-4">No holdings yet</p>
          <button onClick={() => setShowAddForm(true)} className="btn btn-primary">
            Add Your First Stock
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Stock
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Qty
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Avg Price
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Current
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Invested
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Current Value
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    P&L
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {holdings.map((holding) => {
                  const isProfitable = holding.unrealizedPL >= 0;
                  return (
                    <tr key={holding.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              {holding.symbol}
                            </div>
                            <div className="text-sm text-gray-500">{holding.exchange}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                        {holding.quantity}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                        ₹{holding.avgPrice.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900">
                        ₹{holding.currentPrice.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-900">
                        ₹{holding.investedAmount.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium text-gray-900">
                        ₹{holding.currentValue.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                        <div className={isProfitable ? 'text-green-600' : 'text-red-600'}>
                          <div className="font-medium">
                            {isProfitable ? '+' : ''}₹{holding.unrealizedPL.toFixed(2)}
                          </div>
                          <div className="text-xs">
                            ({holding.plPercent}%)
                          </div>
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

      {/* Add Holding Modal - Placeholder */}
      {showAddForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <h2 className="text-xl font-bold mb-4">Add New Holding</h2>
            <p className="text-gray-600 mb-4">Form coming soon...</p>
            <button onClick={() => setShowAddForm(false)} className="btn btn-secondary">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
