/**
 * API Client for Portfolio Component
 * Wraps the api utility to match the expected interface
 */
import { api } from '../utils/api';

export const portfolio = {
  getAll: async () => {
    const data = await api.get('/portfolio');
    return { data };
  },

  getPortfolios: async () => {
    const data = await api.get('/portfolio?all=true');
    return data;
  },

  getPortfolioHoldings: async (id) => {
    const data = await api.get(`/portfolio/${id}/holdings`);
    return data;
  },

  createPortfolio: async (data) => {
    const result = await api.post('/portfolio/create', data);
    return result;
  },

  updatePortfolio: async (id, data) => {
    const result = await api.put(`/portfolio/${id}/settings`, data);
    return result;
  },

  deletePortfolio: async (id) => {
    const result = await api.delete(`/portfolio/${id}`);
    return result;
  },

  sync: async () => {
    const data = await api.post('/portfolio/sync');
    return { data };
  },

  addTransaction: async (transaction) => {
    const data = await api.post('/portfolio/transactions', transaction);
    return { data };
  },

  deleteTransaction: async (id) => {
    const data = await api.delete(`/portfolio/transactions/${id}`);
    return { data };
  }
};