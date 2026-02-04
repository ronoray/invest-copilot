import { Routes, Route, Link } from 'react-router-dom';
import { Home, Briefcase, Eye, Lightbulb, Receipt, Target, LogOut } from 'lucide-react';
import { useAuth } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Portfolio from './pages/Portfolio';
import Watchlist from './pages/Watchlist';
import Proposals from './pages/Proposals';
import AIRecommendations from './pages/AIRecommendations';
import TaxDashboard from './pages/TaxDashboard';
import YourPlan from './pages/YourPlan';

function App() {
  return (
    <Routes>
      {/* Public Route - Login */}
      <Route path="/login" element={<Login />} />

      {/* Protected Routes */}
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

function AppLayout() {
  const { user, logout } = useAuth();

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

            {/* User Menu */}
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-600">
                Welcome, {user?.name || 'User'}
              </span>
              <button
                onClick={logout}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <LogOut size={16} className="mr-2" />
                Logout
              </button>
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