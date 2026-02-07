// client/src/pages/Plan.jsx
import { useState, useEffect } from 'react';
import axios from 'axios';

export default function Plan() {
  const [snapshot, setSnapshot] = useState({
    startingCapital: 0,
    currentlyInvested: 0,
    availableCash: 0,
    currentValue: 0,
    totalPnL: 0,
    totalPnLPercent: 0
  });
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCapitalModal, setShowCapitalModal] = useState(false);
  const [newCapital, setNewCapital] = useState('');
  const [updating, setUpdating] = useState(false);
  
  useEffect(() => {
    fetchSnapshot();
  }, []);
  
  const fetchSnapshot = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('Not authenticated');
      }
      
      const response = await axios.get('/api/plan/snapshot', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      setSnapshot(response.data);
      
    } catch (err) {
      console.error('Failed to fetch snapshot:', err);
      setError(err.response?.data?.error || 'Failed to load portfolio data');
    } finally {
      setLoading(false);
    }
  };
  
  const updateCapital = async () => {
    try {
      setUpdating(true);
      
      const capital = parseFloat(newCapital);
      if (isNaN(capital) || capital <= 0) {
        alert('Please enter a valid amount');
        return;
      }
      
      const token = localStorage.getItem('token');
      await axios.post('/api/plan/update-capital', 
        { capital },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      
      setShowCapitalModal(false);
      setNewCapital('');
      await fetchSnapshot(); // Refresh data
      
    } catch (err) {
      console.error('Failed to update capital:', err);
      alert('Failed to update capital. Please try again.');
    } finally {
      setUpdating(false);
    }
  };
  
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading your investment plan...</p>
        </div>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center max-w-md">
          <div className="text-red-500 text-5xl mb-4">⚠️</div>
          <h2 className="text-xl font-semibold text-gray-800 mb-2">Error Loading Data</h2>
          <p className="text-gray-600 mb-4">{error}</p>
          <button 
            onClick={fetchSnapshot}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }
  
  const isProfitable = snapshot.totalPnL >= 0;
  
  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 flex items-center gap-2">
            🎯 Your Investment Plan
          </h1>
          <p className="text-gray-600 mt-1">Personalized allocation based on your portfolio</p>
        </div>
        <button
          onClick={() => setShowCapitalModal(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
        >
          💰 Update Capital
        </button>
      </div>
      
      {/* Money Snapshot */}
      <div className="bg-gradient-to-r from-green-50 to-green-100 rounded-2xl p-8 mb-8 border border-green-200">
        <h2 className="text-xl font-semibold text-gray-800 mb-6 flex items-center gap-2">
          💵 Your Money Snapshot
        </h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Starting Capital */}
          <div className="bg-blue-50 rounded-xl p-6 border border-blue-200">
            <p className="text-sm text-gray-600 mb-2">Starting Capital</p>
            <p className="text-xl sm:text-2xl font-bold text-blue-700">
              ₹{snapshot.startingCapital.toLocaleString('en-IN')}
            </p>
          </div>
          
          {/* Currently Invested */}
          <div className="bg-purple-50 rounded-xl p-6 border border-purple-200">
            <p className="text-sm text-gray-600 mb-2">Currently Invested</p>
            <p className="text-xl sm:text-2xl font-bold text-purple-700">
              ₹{snapshot.currentlyInvested.toLocaleString('en-IN')}
            </p>
          </div>
          
          {/* Available Cash */}
          <div className="bg-green-50 rounded-xl p-6 border border-green-200">
            <p className="text-sm text-gray-600 mb-2">Available Cash</p>
            <p className="text-xl sm:text-2xl font-bold text-green-700">
              ₹{snapshot.availableCash.toLocaleString('en-IN')}
            </p>
          </div>
          
          {/* Total P&L */}
          <div className={`${isProfitable ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'} rounded-xl p-6 border`}>
            <p className="text-sm text-gray-600 mb-2">Total P&L</p>
            <p className={`text-2xl font-bold ${isProfitable ? 'text-green-700' : 'text-red-700'}`}>
              {isProfitable ? '📈' : '📉'} ₹{Math.abs(snapshot.totalPnL).toLocaleString('en-IN')}
            </p>
            <p className={`text-sm font-semibold mt-1 ${isProfitable ? 'text-green-600' : 'text-red-600'}`}>
              {snapshot.totalPnLPercent >= 0 ? '+' : ''}{snapshot.totalPnLPercent}%
            </p>
          </div>
        </div>
      </div>
      
      {/* Advice Section */}
      {snapshot.currentlyInvested === 0 ? (
        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-6 rounded-lg mb-8">
          <div className="flex items-start gap-3">
            <span className="text-3xl">💡</span>
            <div>
              <h3 className="font-semibold text-yellow-800 mb-2">Save More</h3>
              <p className="text-yellow-700">
                You have ₹{snapshot.availableCash.toLocaleString('en-IN')} available but haven't started investing yet. 
                Check the AI Recommendations page for investment opportunities!
              </p>
            </div>
          </div>
        </div>
      ) : snapshot.availableCash < snapshot.startingCapital * 0.1 ? (
        <div className="bg-blue-50 border-l-4 border-blue-400 p-6 rounded-lg mb-8">
          <div className="flex items-start gap-3">
            <span className="text-3xl">📊</span>
            <div>
              <h3 className="font-semibold text-blue-800 mb-2">Fully Invested</h3>
              <p className="text-blue-700">
                You've invested {((snapshot.currentlyInvested / snapshot.startingCapital) * 100).toFixed(1)}% 
                of your capital. Monitor your positions and rebalance as needed.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-green-50 border-l-4 border-green-400 p-6 rounded-lg mb-8">
          <div className="flex items-start gap-3">
            <span className="text-3xl">✅</span>
            <div>
              <h3 className="font-semibold text-green-800 mb-2">Good Balance</h3>
              <p className="text-green-700">
                You have ₹{snapshot.availableCash.toLocaleString('en-IN')} available for new opportunities 
                while maintaining {((snapshot.currentlyInvested / snapshot.startingCapital) * 100).toFixed(1)}% 
                invested. Check AI Recommendations for new ideas!
              </p>
            </div>
          </div>
        </div>
      )}
      
      {/* Capital Update Modal */}
      {showCapitalModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full mx-4">
            <h3 className="text-2xl font-bold text-gray-800 mb-4">Update Starting Capital</h3>
            <p className="text-gray-600 mb-6">
              Current capital: ₹{snapshot.startingCapital.toLocaleString('en-IN')}
            </p>
            
            <input
              type="number"
              value={newCapital}
              onChange={(e) => setNewCapital(e.target.value)}
              placeholder="Enter new capital amount"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg mb-6 text-lg"
              autoFocus
            />
            
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowCapitalModal(false);
                  setNewCapital('');
                }}
                className="flex-1 px-4 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition"
                disabled={updating}
              >
                Cancel
              </button>
              <button
                onClick={updateCapital}
                className="flex-1 px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition disabled:opacity-50"
                disabled={updating}
              >
                {updating ? 'Updating...' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}