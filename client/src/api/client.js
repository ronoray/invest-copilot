import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const apiClient = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Portfolio endpoints
export const portfolio = {
  getAll: () => apiClient.get('/portfolio'),
  add: (data) => apiClient.post('/portfolio', data),
  update: (id, data) => apiClient.put(`/portfolio/${id}`, data),
  delete: (id) => apiClient.delete(`/portfolio/${id}`),
  sync: () => apiClient.post('/portfolio/sync')
};

// Market data endpoints
export const market = {
  getPrice: (symbol, exchange = 'NSE') => 
    apiClient.get(`/market/price/${symbol}`, { params: { exchange } }),
  getIntraday: (symbol, exchange = 'NSE') => 
    apiClient.get(`/market/intraday/${symbol}`, { params: { exchange } }),
  search: (query) => 
    apiClient.get('/market/search', { params: { q: query } })
};

// Watchlist endpoints
export const watchlist = {
  getAll: () => apiClient.get('/watchlist'),
  add: (data) => apiClient.post('/watchlist', data),
  update: (id, data) => apiClient.put(`/watchlist/${id}`, data),
  delete: (id) => apiClient.delete(`/watchlist/${id}`),
  getSignals: () => apiClient.get('/watchlist/signals')
};

// Proposals endpoints
export const proposals = {
  getAll: (status) => apiClient.get('/proposals', { params: { status } }),
  get: (id) => apiClient.get(`/proposals/${id}`),
  create: (data) => apiClient.post('/proposals', data),
  approve: (id) => apiClient.put(`/proposals/${id}/approve`),
  reject: (id, reason) => apiClient.put(`/proposals/${id}/reject`, { reason }),
  delete: (id) => apiClient.delete(`/proposals/${id}`)
};

export default apiClient;
