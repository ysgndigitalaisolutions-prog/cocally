import axios from 'axios';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export const api = axios.create({ baseURL: `${API_URL}/api/v1` });

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('cocally.token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * Offset between the API server's clock and this browser's, in milliseconds.
 *
 * Every timer on the agent desktop (call duration, wrap-up countdown, transfer
 * accept window, shift/pause totals) is anchored to an epoch-ms value MINTED BY
 * THE SERVER. Subtracting a local `Date.now()` from a server timestamp is only
 * correct if the two clocks agree, and agent laptops routinely do not — a
 * five-minute-fast machine would show a call that started "5:00" ago the second
 * it connects, and a wrap-up timer that has already expired.
 *
 * The `Date` response header is CORS-safelisted, so it is readable without any
 * server change and every API call refreshes the estimate for free.
 */
let clockSkewMs = 0;

/** `Date.now()` corrected onto the API server's clock. Use this, not Date.now(), for anything compared against a server timestamp. */
export function serverNow(): number {
  return Date.now() + clockSkewMs;
}

/** Seconds elapsed since a server epoch-ms instant, never negative. */
export function secondsSince(serverEpochMs: number): number {
  return Math.max(0, Math.round((serverNow() - serverEpochMs) / 1000));
}

/** Seconds remaining until a server epoch-ms deadline, never negative. */
export function secondsUntil(serverEpochMs: number): number {
  return Math.max(0, Math.round((serverEpochMs - serverNow()) / 1000));
}

api.interceptors.response.use(
  (response) => {
    // `Date` only has one-second resolution and this ignores network latency,
    // so a sub-second "skew" is noise, not drift. Only adopt a correction once
    // it is big enough to be a real clock difference — otherwise the timers
    // would jitter by a second on every request.
    const header = response.headers?.['date'];
    if (typeof header === 'string') {
      const serverMs = Date.parse(header);
      if (Number.isFinite(serverMs)) {
        const diff = serverMs - Date.now();
        clockSkewMs = Math.abs(diff) > 2000 ? diff : 0;
      }
    }
    return response;
  },
  (error) => {
    if (
      error.response?.status === 403 &&
      error.response?.data?.code === 'TWO_FACTOR_REQUIRED' &&
      typeof window !== 'undefined' &&
      !window.location.pathname.startsWith('/security')
    ) {
      window.location.href = '/security';
      return Promise.reject(error);
    }
    if (error.response?.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      localStorage.removeItem('cocally.token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);
