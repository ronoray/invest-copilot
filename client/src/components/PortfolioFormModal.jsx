import { useState, useEffect } from 'react';
import { X, Briefcase, AlertCircle } from 'lucide-react';
import { portfolio as portfolioApi } from '../api/client';

const BROKERS = [
  { value: 'SBI_SECURITIES', label: 'SBI Securities' },
  { value: 'HDFC_SECURITIES', label: 'HDFC Securities' },
  { value: 'UPSTOX', label: 'Upstox' },
  { value: 'ZERODHA', label: 'Zerodha' },
  { value: 'GROWW', label: 'Groww' },
  { value: 'ANGEL_ONE', label: 'Angel One' },
  { value: 'ICICI_DIRECT', label: 'ICICI Direct' },
  { value: 'KOTAK_SECURITIES', label: 'Kotak Securities' },
  { value: 'MOTILAL_OSWAL', label: 'Motilal Oswal' },
  { value: '5PAISA', label: '5paisa' },
  { value: 'OTHER', label: 'Other' },
];

const RISK_PROFILES = [
  { value: 'CONSERVATIVE', label: 'Conservative', desc: 'Capital preservation. Large-caps, bonds, FDs.' },
  { value: 'BALANCED', label: 'Balanced', desc: 'Mix of growth and stability.' },
  { value: 'AGGRESSIVE', label: 'Aggressive', desc: 'Maximum growth. Small/mid-caps, momentum.' },
];

const GOALS = [
  { value: 'RETIREMENT', label: 'Retirement' },
  { value: 'WEALTH_BUILDING', label: 'Wealth Building' },
  { value: 'INCOME', label: 'Regular Income' },
  { value: 'EDUCATION', label: 'Education Fund' },
  { value: 'EMERGENCY', label: 'Emergency Fund' },
  { value: 'SHORT_TERM_TRADING', label: 'Short-term Trading' },
];

const EXPERIENCE_LEVELS = [
  { value: 'BEGINNER', label: 'Beginner' },
  { value: 'INTERMEDIATE', label: 'Intermediate' },
  { value: 'EXPERT', label: 'Expert' },
];

export default function PortfolioFormModal({ isOpen, onClose, portfolio, onSuccess, mode = 'create' }) {
  const isEdit = mode === 'edit';

  const [form, setForm] = useState({
    name: '',
    ownerName: '',
    broker: '',
    riskProfile: 'BALANCED',
    investmentGoal: '',
    investmentExperience: '',
    startingCapital: 10000,
    monthlyIncome: '',
    age: '',
    markets: ['NSE'],
    apiEnabled: false,
    notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && isEdit && portfolio) {
      setForm({
        name: portfolio.name || '',
        ownerName: portfolio.ownerName || '',
        broker: portfolio.broker || '',
        riskProfile: portfolio.riskProfile || 'BALANCED',
        investmentGoal: portfolio.investmentGoal || '',
        investmentExperience: portfolio.investmentExperience || '',
        startingCapital: portfolio.startingCapital || 10000,
        monthlyIncome: portfolio.monthlyIncome || '',
        age: portfolio.age || '',
        markets: portfolio.markets || ['NSE'],
        apiEnabled: portfolio.apiEnabled || false,
        notes: portfolio.notes || '',
      });
    } else if (isOpen && !isEdit) {
      setForm({
        name: '', ownerName: '', broker: '', riskProfile: 'BALANCED',
        investmentGoal: '', investmentExperience: '', startingCapital: 10000,
        monthlyIncome: '', age: '', markets: ['NSE'], apiEnabled: false, notes: '',
      });
    }
    setError('');
  }, [isOpen, isEdit, portfolio]);

  if (!isOpen) return null;

  const updateField = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

  const toggleMarket = (market) => {
    setForm(prev => {
      const markets = prev.markets.includes(market)
        ? prev.markets.filter(m => m !== market)
        : [...prev.markets, market];
      return { ...prev, markets: markets.length > 0 ? markets : prev.markets };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!form.name.trim()) return setError('Portfolio name is required');
    if (!form.ownerName.trim()) return setError('Owner name is required');
    if (!form.broker) return setError('Please select a broker');
    if (!isEdit && form.startingCapital < 1000) return setError('Starting capital must be at least 1,000');

    setLoading(true);
    try {
      const payload = {
        name: form.name.trim(),
        ownerName: form.ownerName.trim(),
        broker: form.broker,
        riskProfile: form.riskProfile,
        markets: form.markets,
        apiEnabled: form.apiEnabled,
        notes: form.notes.trim() || null,
        investmentGoal: form.investmentGoal || null,
        investmentExperience: form.investmentExperience || null,
        monthlyIncome: form.monthlyIncome ? parseFloat(form.monthlyIncome) : null,
        age: form.age ? parseInt(form.age) : null,
      };

      if (!isEdit) {
        payload.startingCapital = form.startingCapital;
      }

      let result;
      if (isEdit) {
        result = await portfolioApi.updatePortfolio(portfolio.id, payload);
      } else {
        result = await portfolioApi.createPortfolio(payload);
      }

      onSuccess(result.portfolio);
      onClose();
    } catch (err) {
      setError(err.message || `Failed to ${isEdit ? 'update' : 'create'} portfolio`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-50 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800 rounded-t-xl z-10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
                <Briefcase className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {isEdit ? 'Edit Portfolio' : 'New Portfolio'}
                </h2>
                {isEdit && <p className="text-sm text-gray-600 dark:text-gray-400">{portfolio?.name}</p>}
              </div>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X className="w-6 h-6" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-6">
            {/* Identity Section */}
            <div>
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Identity</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Portfolio Name *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => updateField('name', e.target.value)}
                    placeholder="e.g., Mahua - SBI Securities"
                    className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Owner Name *</label>
                  <input
                    type="text"
                    value={form.ownerName}
                    onChange={(e) => updateField('ownerName', e.target.value)}
                    placeholder="e.g., Mahua Banerjee"
                    className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Broker *</label>
                  <select
                    value={form.broker}
                    onChange={(e) => updateField('broker', e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  >
                    <option value="">Select broker...</option>
                    {BROKERS.map(b => (
                      <option key={b.value} value={b.value}>{b.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Investment Profile */}
            <div>
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Investment Profile</h3>
              <div className="space-y-4">
                {/* Risk Profile Cards */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Risk Profile</label>
                  <div className="grid grid-cols-3 gap-2">
                    {RISK_PROFILES.map(rp => (
                      <button
                        key={rp.value}
                        type="button"
                        onClick={() => updateField('riskProfile', rp.value)}
                        className={`p-3 rounded-lg border-2 text-left transition-all ${
                          form.riskProfile === rp.value
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                      >
                        <p className={`font-semibold text-sm ${form.riskProfile === rp.value ? 'text-blue-700' : 'text-gray-900 dark:text-gray-100'}`}>
                          {rp.label}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-tight">{rp.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Investment Goal */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Investment Goal</label>
                  <select
                    value={form.investmentGoal}
                    onChange={(e) => updateField('investmentGoal', e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select goal...</option>
                    {GOALS.map(g => (
                      <option key={g.value} value={g.value}>{g.label}</option>
                    ))}
                  </select>
                </div>

                {/* Experience Level */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Experience Level</label>
                  <div className="flex gap-2">
                    {EXPERIENCE_LEVELS.map(exp => (
                      <button
                        key={exp.value}
                        type="button"
                        onClick={() => updateField('investmentExperience', form.investmentExperience === exp.value ? '' : exp.value)}
                        className={`flex-1 py-2 px-3 rounded-full text-sm font-medium border-2 transition-all ${
                          form.investmentExperience === exp.value
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700'
                            : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                      >
                        {exp.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Financial Details */}
            <div>
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Financial Details</h3>
              <div className="space-y-4">
                {!isEdit && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Starting Capital *</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 font-semibold">&#8377;</span>
                      <input
                        type="number"
                        value={form.startingCapital}
                        onChange={(e) => updateField('startingCapital', parseFloat(e.target.value) || 0)}
                        className="w-full pl-8 pr-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        min="1000"
                        step="1000"
                        required
                      />
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Minimum: &#8377;1,000</p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Monthly Income</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 font-semibold">&#8377;</span>
                      <input
                        type="number"
                        value={form.monthlyIncome}
                        onChange={(e) => updateField('monthlyIncome', e.target.value)}
                        className="w-full pl-8 pr-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="Optional"
                        min="0"
                      />
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Helps AI size SIPs</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Age</label>
                    <input
                      type="number"
                      value={form.age}
                      onChange={(e) => updateField('age', e.target.value)}
                      className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="Optional"
                      min="18"
                      max="100"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Helps calibrate risk</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Settings */}
            <div>
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Settings</h3>
              <div className="space-y-4">
                {/* Markets */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Markets</label>
                  <div className="flex gap-3">
                    {['NSE', 'BSE'].map(market => (
                      <label key={market} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.markets.includes(market)}
                          onChange={() => toggleMarket(market)}
                          className="w-4 h-4 text-blue-600 rounded border-gray-300 dark:border-gray-600 focus:ring-blue-500"
                        />
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{market}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* API Trading */}
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">API Trading</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Enable automated order placement</p>
                  </div>
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={form.apiEnabled}
                      onChange={(e) => updateField('apiEnabled', e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </div>
                </label>

                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => updateField('notes', e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                    rows="2"
                    placeholder="Any notes about this portfolio..."
                  />
                </div>
              </div>
            </div>

            {/* Error */}
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
                className="flex-1 px-4 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                disabled={loading}
              >
                {loading ? (isEdit ? 'Saving...' : 'Creating...') : (isEdit ? 'Save Changes' : 'Create Portfolio')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
