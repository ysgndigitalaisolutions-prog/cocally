'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
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
        email,
        password,
        ...(totpCode ? { totpCode } : {}),
      });
      if (data.requires2fa) {
        setRequires2fa(true);
        return;
      }
      localStorage.setItem('cocally.token', data.token);
      localStorage.setItem('cocally.user', JSON.stringify(data.user));
      router.push('/dashboard');
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
            <label className="mb-1 block text-sm font-medium">Email or username</label>
            <input className="input" type="text" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={4}
            />
          </div>
          {requires2fa && (
            <div>
              <label className="mb-1 block text-sm font-medium">2FA code</label>
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
