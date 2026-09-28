import axios from 'axios';
import { API_URL } from './api';

/**
 * The ops console's own API client. Separate token key from the tenant app,
 * so being signed in to one never signs you in to the other, and a 401 here
 * goes to the ops login, not the tenant one.
 */
export const OPS_TOKEN_KEY = 'cocally.ops.token';
export const OPS_OPERATOR_KEY = 'cocally.ops.operator';

export const opsApi = axios.create({ baseURL: `${API_URL}/api/v1/operator` });

opsApi.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem(OPS_TOKEN_KEY);
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

opsApi.interceptors.response.use(
  (r) => r,
  (error) => {
    const onAuthPage = typeof window !== 'undefined' && /^\/ops\/(login|invite)/.test(window.location.pathname);
    if (error.response?.status === 401 && typeof window !== 'undefined' && !onAuthPage) {
      localStorage.removeItem(OPS_TOKEN_KEY);
      localStorage.removeItem(OPS_OPERATOR_KEY);
      window.location.href = '/ops/login';
    }
    return Promise.reject(error);
  },
);

export function opsError(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (Array.isArray(detail)) return detail.join(', ');
  return typeof detail === 'string' ? detail : fallback;
}

export interface OperatorProfile {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
}
