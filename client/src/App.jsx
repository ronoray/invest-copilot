import { Routes, Route, Link } from 'react-router-dom';
import { useState } from 'react';
import { Home, Briefcase, Eye, Lightbulb, Receipt, Target, LogOut, Menu, X } from 'lucide-react';
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const toggleMobileMenu = () => {
    setMobileMenuOpen(!mobileMenuOpen);
  };

  const closeMobileMenu = () => {
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navigation */}
      <nav className="bg-white shadow-sm border-b sticky top-0 z-50">
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
                <NavLink to="/" icon={<Home size={18} />}>Dashboard</NavLink>
                <NavLink to="/portfolio" icon={<Briefcase size={18} />}>Portfolio</NavLink>
                <NavLink to="/plan" icon={<Target size={18} />}>Plan</NavLink>
                <NavLink to="/ai" icon={<Lightbulb size={18} />}>AI</NavLink>
                <NavLink to="/tax" icon={<Receipt size={18} />}>Tax</NavLink>
                <NavLink to="/watchlist" icon={<Eye size={18} />}>Watch</NavLink>
              </div>
            </div>

            {/* Desktop User Menu */}
            <div className="hidden md:flex items-center space-x-4">
              <span className="text-sm text-gray-600">
                {user?.name || 'User'}
              </span>
              <button
                onClick={logout}
                className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <LogOut size={16} className="mr-1" />
                Logout
              </button>
            </div>

            {/* Mobile Menu Button */}
            <div className="flex items-center md:hidden">
              <button
                onClick={toggleMobileMenu}
                className="inline-flex items-center justify-center p-2 rounded-md text-gray-700 hover:text-blue-600 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
              >
                {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-200 bg-white">
            <div className="px-2 pt-2 pb-3 space-y-1">
              <MobileNavLink to="/" icon={<Home size={20} />} onClick={closeMobileMenu}>
                Dashboard
              </MobileNavLink>
              <MobileNavLink to="/portfolio" icon={<Briefcase size={20} />} onClick={closeMobileMenu}>
                Portfolio
              </MobileNavLink>
              <MobileNavLink to="/plan" icon={<Target size={20} />} onClick={closeMobileMenu}>
                Your Plan
              </MobileNavLink>
              <MobileNavLink to="/ai" icon={<Lightbulb size={20} />} onClick={closeMobileMenu}>
                AI Insights
              </MobileNavLink>
              <MobileNavLink to="/tax" icon={<Receipt size={20} />} onClick={closeMobileMenu}>
                Tax
              </MobileNavLink>
              <MobileNavLink to="/watchlist" icon={<Eye size={20} />} onClick={closeMobileMenu}>
                Watchlist
              </MobileNavLink>
            </div>
            
            {/* Mobile User Section */}
            <div className="border-t border-gray-200 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">
                  {user?.name || 'User'}
                </span>
                <button
                  onClick={() => {
                    logout();
                    closeMobileMenu();
                  }}
                  className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
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
          <Route path="/ai" element={<AIRecommendations />} />
          <Route path="/tax" element={<TaxDashboard />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/proposals" element={<Proposals />} />
        </Routes>
      </main>
    </div>
  );
}

// Desktop Navigation Link
function NavLink({ to, icon, children }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center px-1 pt-1 border-b-2 border-transparent text-sm font-medium text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors whitespace-nowrap"
    >
      <span className="mr-1">{icon}</span>
      <span className="hidden lg:inline">{children}</span>
    </Link>
  );
}

// Mobile Navigation Link
function MobileNavLink({ to, icon, children, onClick }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className="flex items-center px-3 py-3 rounded-md text-base font-medium text-gray-700 hover:text-blue-600 hover:bg-gray-50 transition-colors"
    >
      <span className="mr-3">{icon}</span>
      {children}
    </Link>
  );
}

export default App;