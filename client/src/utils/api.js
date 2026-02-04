/**
 * API Client
 * Handles all API requests with automatic token injection
 */

const API_BASE = '/api';

/**
 * Make authenticated API request
 */
async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('accessToken');
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Add Authorization header if token exists
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const config = {
    ...options,
    headers,
  };

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, config);

    // Handle 401 - token expired or invalid
    if (response.status === 401) {
      // Clear tokens
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      
      // Redirect to login
      window.location.href = '/login';
      throw new Error('Authentication required');
    }

    // Parse response
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }

    return data;
  } catch (error) {
    console.error('API Request failed:', error);
    throw error;
  }
}

/**
 * API Methods
 */
export const api = {
  // GET request
  get: (endpoint, options = {}) => {
    return apiRequest(endpoint, {
      method: 'GET',
      ...options,
    });
  },

  // POST request
  post: (endpoint, data, options = {}) => {
    return apiRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
      ...options,
    });
  },

  // PUT request
  put: (endpoint, data, options = {}) => {
    return apiRequest(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
      ...options,
    });
  },

  // PATCH request
  patch: (endpoint, data, options = {}) => {
    return apiRequest(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
      ...options,
    });
  },

  // DELETE request
  delete: (endpoint, options = {}) => {
    return apiRequest(endpoint, {
      method: 'DELETE',
      ...options,
    });
  },
};

/**
 * Auth API
 */
export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  register: (data) => api.post('/auth/register', data),
  forgotPassword: (email) => api.post('/auth/forgot-password', { email }),
  resetPassword: (token, password) => api.post('/auth/reset-password', { token, password }),
};

/**
 * Portfolio API
 */
export const portfolioApi = {
  getPortfolio: () => api.get('/portfolio'),
  addTransaction: (data) => api.post('/portfolio/transactions', data),
  getTransactions: () => api.get('/portfolio/transactions'),
  deleteTransaction: (id) => api.delete(`/portfolio/transactions/${id}`),
};

/**
 * Stocks API
 */
export const stocksApi = {
  search: (query) => api.get(`/stocks/search?q=${query}`),
  getQuote: (symbol) => api.get(`/stocks/quote/${symbol}`),
  getHistory: (symbol, period = '1M') => api.get(`/stocks/history/${symbol}?period=${period}`),
};

/**
 * Watchlist API
 */
export const watchlistApi = {
  getWatchlist: () => api.get('/watchlist'),
  addStock: (symbol) => api.post('/watchlist', { symbol }),
  removeStock: (id) => api.delete(`/watchlist/${id}`),
};

/**
 * Alerts API
 */
export const alertsApi = {
  getAlerts: () => api.get('/alerts'),
  createAlert: (data) => api.post('/alerts', data),
  updateAlert: (id, data) => api.put(`/alerts/${id}`, data),
  deleteAlert: (id) => api.delete(`/alerts/${id}`),
};

/**
 * AI Recommendations API
 */
export const aiApi = {
  getRecommendations: () => api.get('/ai/recommendations'),
  analyzeStock: (symbol) => api.post('/ai/analyze', { symbol }),
};

/**
 * Tax API
 */
export const taxApi = {
  getTaxReport: (year) => api.get(`/tax/report/${year}`),
  getCapitalGains: (year) => api.get(`/tax/capital-gains/${year}`),
};

export default api;