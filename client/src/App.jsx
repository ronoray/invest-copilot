import { Routes, Route, Link } from 'react-router-dom';
import { Home, Briefcase, Eye, FileText, Lightbulb, Receipt, Target } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Portfolio from './pages/Portfolio';
import Watchlist from './pages/Watchlist';
import Proposals from './pages/Proposals';
import AIRecommendations from './pages/AIRecommendations';
import TaxDashboard from './pages/TaxDashboard';
import YourPlan from './pages/YourPlan';

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navigation */}
      <nav className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <Link to="/" className="flex items-center px-2 text-xl font-bold text-blue-600">
                📈 Investment Co-Pilot
              </Link>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                <NavLink to="/" icon={<Home size={18} />}>Dashboard</NavLink>
                <NavLink to="/portfolio" icon={<Briefcase size={18} />}>Portfolio</NavLink>
                <NavLink to="/plan" icon={<Target size={18} />}>Your Plan</NavLink>
                <NavLink to="/ai" icon={<Lightbulb size={18} />}>AI Insights</NavLink>
                <NavLink to="/tax" icon={<Receipt size={18} />}>Tax</NavLink>
                <NavLink to="/watchlist" icon={<Eye size={18} />}>Watchlist</NavLink>
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/plan" element={<YourPlan />} />
          <Route path="/ai" element={<AIRecommendations />} />
          <Route path="/tax" element={<TaxDashboard />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/proposals" element={<Proposals />} />
        </Routes>
      </main>
    </div>
  );
}

function NavLink({ to, icon, children }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center px-1 pt-1 border-b-2 border-transparent text-sm font-medium text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors"
    >
      <span className="mr-2">{icon}</span>
      {children}
    </Link>
  );
}

export default App;