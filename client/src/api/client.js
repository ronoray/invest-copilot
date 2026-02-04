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