'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { toE164 } from '@/lib/phone';
import { homeFor } from '@/lib/roles';

const COUNTRY_CODES = [
  { code: '+91', label: 'India' },
  { code: '+61', label: 'Australia' },
  { code: '+1', label: 'US/Canada' },
  { code: '+44', label: 'UK' },
];

export default function LoginPage() {
  const router = useRouter();
  const [countryCode, setCountryCode] = useState('+91');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requires2fa, setRequires2fa] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', {
        identifier: toE164(countryCode, identifier),
        password,
        ...(totpCode ? { totpCode } : {}),
      });
      if (data.requires2fa) {
        setRequires2fa(true);
        return;
      }
      localStorage.setItem('cocally.token', data.token);
      localStorage.setItem('cocally.user', JSON.stringify(data.user));
      router.push(homeFor(data.user));
    } catch (err) {
      const message =
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Login failed';
      setError(Array.isArray(message) ? message.join(', ') : message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-md p-8">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold">
            Co<span style={{ color: 'var(--accent)' }}>Cally</span>
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-dim)' }}>
            AI-first outbound contact centre
          </p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Phone number</label>
            <div className="flex gap-2">
              <select
                className="input w-32 shrink-0"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                aria-label="Country code"
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} {c.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="text"
                inputMode="tel"
                autoComplete="username"
                placeholder="98xxx xxxxx"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          {requires2fa && (
            <div>
              <label className="mb-1 block text-sm font-medium">Authenticator code</label>
              <input
                className="input"
                inputMode="numeric"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456"
                autoFocus
              />
            </div>
          )}
          {error && (
            <p className="text-sm" style={{ color: 'var(--bad)' }}>
              {error}
            </p>
          )}
          <button className="btn btn-primary w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
