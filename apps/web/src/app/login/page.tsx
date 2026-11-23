'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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
  // The phone and password fit accounts in several workspaces: which one.
  const [choices, setChoices] = useState<Array<{ tenantId: string; name: string }>>([]);
  const [tenantId, setTenantId] = useState('');

  // "Switch workspace" lands here with the identifier and the workspace chosen.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('id')) setIdentifier(q.get('id') ?? '');
    if (q.get('workspace')) setTenantId(q.get('workspace') ?? '');
  }, []);

  /** An email is sent as typed; a phone gets the country code. */
  function loginId(): string {
    return identifier.includes('@') ? identifier.trim() : toE164(countryCode, identifier);
  }
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e?: React.FormEvent, workspace = tenantId) {
    e?.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', {
        identifier: loginId(),
        password,
        ...(totpCode ? { totpCode } : {}),
        ...(workspace ? { tenantId: workspace } : {}),
      });
      if (data.chooseWorkspace?.length) {
        setChoices(data.chooseWorkspace);
        return;
      }
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
            <label className="mb-1 block text-sm font-medium">Phone number or email</label>
            <div className="flex gap-2">
              <select
                className="input"
                style={{ width: '8.5rem', flex: 'none' }}
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
                style={{ flex: 1, minWidth: 0 }}
                type="text"
                inputMode={identifier.includes('@') ? 'email' : 'tel'}
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
          {choices.length > 0 && !requires2fa && (
            <div>
              <p className="mb-2 text-sm font-medium">Which workspace?</p>
              <div className="flex flex-col gap-2">
                {choices.map((c) => (
                  <button
                    key={c.tenantId}
                    type="button"
                    className="btn btn-ghost w-full justify-start border"
                    style={{ borderColor: 'var(--border)' }}
                    disabled={loading}
                    onClick={() => {
                      setTenantId(c.tenantId);
                      submit(undefined, c.tenantId);
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}
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
