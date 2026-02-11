import { AlertCircle, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function PortfolioCompletenessAlert({ portfolio, linkToPortfolio = false, onEdit }) {
  if (!portfolio) return null;

  const critical = [];
  const recommended = [];

  // Critical checks
  if (!portfolio.name || !portfolio.name.trim()) critical.push('Portfolio name');
  if (!portfolio.ownerName || !portfolio.ownerName.trim()) critical.push('Owner name');
  if (!portfolio.broker || !portfolio.broker.trim()) critical.push('Broker');
  if (!portfolio.startingCapital || portfolio.startingCapital <= 0) critical.push('Starting capital');

  // Recommended checks
  if (portfolio.riskProfile === 'BALANCED' && !portfolio.investmentExperience) {
    recommended.push('Risk profile not confirmed');
  }
  if (!portfolio.investmentGoal) recommended.push('Investment goal');
  if (!portfolio.investmentExperience) recommended.push('Experience level');

  // No alert if all critical + recommended are present
  if (critical.length === 0 && recommended.length === 0) return null;

  const actionElement = linkToPortfolio ? (
    <Link to="/portfolio" className="underline font-semibold hover:opacity-80">
      Complete setup
    </Link>
  ) : onEdit ? (
    <button onClick={onEdit} className="underline font-semibold hover:opacity-80">
      Edit settings
    </button>
  ) : null;

  return (
    <div className="space-y-2">
      {critical.length > 0 && (
        <div className="flex items-start gap-2 px-4 py-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-sm">
          <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className="text-red-800">
              Portfolio incomplete — missing: <strong>{critical.join(', ')}</strong>.
              {' '}Complete setup to get accurate AI recommendations.
            </span>
            {actionElement && <span className="ml-2 text-red-700">{actionElement}</span>}
          </div>
        </div>
      )}
      {critical.length === 0 && recommended.length > 0 && (
        <div className="flex items-start gap-2 px-4 py-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className="text-amber-800">
              Improve AI accuracy — add: <strong>{recommended.join(', ')}</strong>
            </span>
            {actionElement && <span className="ml-2 text-amber-700">{actionElement}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
