import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { Home, Briefcase, Eye, Lightbulb, Receipt, Target, LogOut, Menu, X, Brain, Layers, BarChart3, Sun, Moon } from 'lucide-react';
import { useAuth } from './context/AuthContext';
import { useTheme } from './context/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Portfolio from './pages/Portfolio';
import Watchlist from './pages/Watchlist';
import Proposals from './pages/Proposals';
import AIRecommendations from './pages/AIRecommendations';
import AIInsights from './pages/AIInsights';
import TaxDashboard from './pages/TaxDashboard';
import YourPlan from './pages/YourPlan';
import MultiAssetRecommendations from './pages/MultiAssetRecommendations';
import HoldingsAnalyzer from './pages/HoldingsAnalyzer';

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
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const toggleMobileMenu = () => {
    setMobileMenuOpen(!mobileMenuOpen);
  };

  const closeMobileMenu = () => {
    setMobileMenuOpen(false);
  };

  const isActive = (path) => {
    return location.pathname === path;
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Navigation */}
      <nav className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            {/* Logo + Desktop Nav */}
            <div className="flex items-center">
              <Link to="/" className="flex items-center px-2 text-lg sm:text-xl font-bold text-blue-600">
                📈 <span className="hidden sm:inline ml-1">Investment Co-Pilot</span>
                <span className="sm:hidden ml-1">IC</span>
              </Link>

              {/* Desktop Navigation */}
              <div className="hidden md:ml-6 md:flex md:space-x-4 lg:space-x-8">
                <NavLink to="/" icon={<Home size={18} />} active={isActive('/')}>Dashboard</NavLink>
                <NavLink to="/portfolio" icon={<Briefcase size={18} />} active={isActive('/portfolio')}>Portfolio</NavLink>
                <NavLink to="/plan" icon={<Target size={18} />} active={isActive('/plan')}>Plan</NavLink>
                <NavLink to="/holdings" icon={<BarChart3 size={18} />} active={isActive('/holdings')}>Holdings</NavLink>
                <NavLink to="/invest" icon={<Layers size={18} />} active={isActive('/invest')}>Invest</NavLink>
                <NavLink to="/ai" icon={<Lightbulb size={18} />} active={isActive('/ai')}>AI</NavLink>
                <NavLink to="/insights" icon={<Brain size={18} />} active={isActive('/insights')}>Insights</NavLink>
                <NavLink to="/tax" icon={<Receipt size={18} />} active={isActive('/tax')}>Tax</NavLink>
              </div>
            </div>

            {/* Desktop User Menu */}
            <div className="hidden md:flex items-center space-x-3">
              <button
                onClick={toggleTheme}
                className="p-2 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {user?.name || 'User'}
              </span>
              <button
                onClick={logout}
                className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <LogOut size={16} className="mr-1" />
                Logout
              </button>
            </div>

            {/* Mobile Menu Button */}
            <div className="flex items-center md:hidden">
              <button
                onClick={toggleMobileMenu}
                className="inline-flex items-center justify-center p-2 rounded-md text-gray-700 dark:text-gray-300 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
                aria-label="Toggle menu"
              >
                {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <div className="px-2 pt-2 pb-3 space-y-1">
              <MobileNavLink to="/" icon={<Home size={20} />} onClick={closeMobileMenu} active={isActive('/')}>Dashboard</MobileNavLink>
              <MobileNavLink to="/portfolio" icon={<Briefcase size={20} />} onClick={closeMobileMenu} active={isActive('/portfolio')}>Portfolio</MobileNavLink>
              <MobileNavLink to="/plan" icon={<Target size={20} />} onClick={closeMobileMenu} active={isActive('/plan')}>Your Plan</MobileNavLink>
              <MobileNavLink to="/holdings" icon={<BarChart3 size={20} />} onClick={closeMobileMenu} active={isActive('/holdings')}>Holdings Analyzer</MobileNavLink>
              <MobileNavLink to="/invest" icon={<Layers size={20} />} onClick={closeMobileMenu} active={isActive('/invest')}>Multi-Asset Invest</MobileNavLink>
              <MobileNavLink to="/ai" icon={<Lightbulb size={20} />} onClick={closeMobileMenu} active={isActive('/ai')}>AI Recommendations</MobileNavLink>
              <MobileNavLink to="/insights" icon={<Brain size={20} />} onClick={closeMobileMenu} active={isActive('/insights')}>AI Insights</MobileNavLink>
              <MobileNavLink to="/tax" icon={<Receipt size={18} />} onClick={closeMobileMenu} active={isActive('/tax')}>Tax Dashboard</MobileNavLink>
              <MobileNavLink to="/watchlist" icon={<Eye size={20} />} onClick={closeMobileMenu} active={isActive('/watchlist')}>Watchlist</MobileNavLink>
            </div>

            {/* Mobile User Section */}
            <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {user?.name || 'User'}
                  </span>
                  <button
                    onClick={toggleTheme}
                    className="p-2 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    aria-label="Toggle theme"
                  >
                    {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                  </button>
                </div>
                <button
                  onClick={() => { logout(); closeMobileMenu(); }}
                  className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                >
                  <LogOut size={16} className="mr-1" />
                  Logout
                </button>
              </div>
            </div>
          </div>
        )}
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/plan" element={<YourPlan />} />
          <Route path="/holdings" element={<HoldingsAnalyzer />} />
          <Route path="/invest" element={<MultiAssetRecommendations />} />
          <Route path="/ai" element={<AIRecommendations />} />
          <Route path="/insights" element={<AIInsights />} />
          <Route path="/tax" element={<TaxDashboard />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/proposals" element={<Proposals />} />
        </Routes>
      </main>
    </div>
  );
}

// Desktop Navigation Link
function NavLink({ to, icon, children, active }) {
  return (
    <Link
      to={to}
      title={children}
      className={`inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium whitespace-nowrap transition-colors ${
        active
          ? 'border-blue-500 text-blue-600'
          : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
      }`}
    >
      <span className="mr-1">{icon}</span>
      <span className="hidden lg:inline">{children}</span>
    </Link>
  );
}

// Mobile Navigation Link
function MobileNavLink({ to, icon, children, onClick, active }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`flex items-center px-3 py-3 rounded-md text-base font-medium transition-colors ${
        active
          ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/30'
          : 'text-gray-700 dark:text-gray-300 hover:text-blue-600 hover:bg-gray-50 dark:hover:bg-gray-700'
      }`}
    >
      <span className="mr-3">{icon}</span>
      {children}
    </Link>
  );
}

export default App;
