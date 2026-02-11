import { useState } from 'react';
import { X, DollarSign, TrendingUp, AlertCircle } from 'lucide-react';

export default function CapitalChangeModal({ 
  isOpen, 
  onClose, 
  portfolio, 
  onSuccess 
}) {
  const [newCapital, setNewCapital] = useState(portfolio?.startingCapital || 10000);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  if (!isOpen || !portfolio) return null;
  
  const currentCapital = portfolio.startingCapital;
  const difference = newCapital - currentCapital;
  const percentChange = ((difference / currentCapital) * 100).toFixed(1);
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    // Validation
    if (newCapital < 1000) {
      setError('Minimum capital is ₹1,000');
      return;
    }
    
    if (newCapital > 10000000) {
      setError('Maximum capital is ₹10,00,000');
      return;
    }
    
    if (newCapital === currentCapital) {
      setError('New capital must be different from current');
      return;
    }
    
    if (!reason.trim()) {
      setError('Please provide a reason for this change');
      return;
    }
    
    setLoading(true);
    
    try {
      const response = await fetch(`/api/portfolio/${portfolio.id}/update-capital`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          newCapital,
          reason: reason.trim()
        })
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update capital');
      }
      
      const data = await response.json();
      
      // Success!
      onSuccess(data.portfolio);
      onClose();
      
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <>
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black bg-opacity-50 z-40"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
                <DollarSign className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  Update Capital
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {portfolio.name}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          
          {/* Body */}
          <form onSubmit={handleSubmit} className="p-6 space-y-6">
            {/* Current Capital */}
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Current Capital</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                ₹{currentCapital.toLocaleString('en-IN')}
              </p>
            </div>
            
            {/* New Capital Input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                New Capital Amount *
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 dark:text-gray-400 font-semibold">
                  ₹
                </span>
                <input
                  type="number"
                  value={newCapital}
                  onChange={(e) => setNewCapital(parseFloat(e.target.value) || 0)}
                  className="w-full pl-8 pr-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="10000"
                  min="1000"
                  max="10000000"
                  step="100"
                  required
                />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Min: ₹1,000 • Max: ₹10,00,000
              </p>
            </div>
            
            {/* Change Preview */}
            {difference !== 0 && (
              <div className={`rounded-lg p-4 ${
                difference > 0 ? 'bg-green-50 dark:bg-green-900/30' : 'bg-red-50 dark:bg-red-900/30'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className={`w-5 h-5 ${
                    difference > 0 ? 'text-green-600' : 'text-red-600'
                  }`} />
                  <p className="font-semibold text-gray-900 dark:text-gray-100">
                    {difference > 0 ? 'Increasing' : 'Decreasing'} Capital
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-gray-600 dark:text-gray-400">Change Amount</p>
                    <p className={`font-bold ${
                      difference > 0 ? 'text-green-700' : 'text-red-700'
                    }`}>
                      {difference > 0 ? '+' : ''}₹{Math.abs(difference).toLocaleString('en-IN')}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-600 dark:text-gray-400">Percentage</p>
                    <p className={`font-bold ${
                      difference > 0 ? 'text-green-700' : 'text-red-700'
                    }`}>
                      {difference > 0 ? '+' : ''}{percentChange}%
                    </p>
                  </div>
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-3">
                  Available cash will {difference > 0 ? 'increase' : 'decrease'} by ₹{Math.abs(difference).toLocaleString('en-IN')}
                </p>
              </div>
            )}
            
            {/* Reason Input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Reason for Change *
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                placeholder="e.g., Added ₹5,000 from salary, Withdrew ₹2,000 for expenses"
                rows="3"
                required
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                This will be recorded in capital history
              </p>
            </div>
            
            {/* Error Message */}
            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}
            
            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 font-semibold rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                disabled={loading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 px-4 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={loading || difference === 0}
              >
                {loading ? 'Updating...' : 'Update Capital'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}