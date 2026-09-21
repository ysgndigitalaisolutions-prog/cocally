'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface InviteInfo {
  name: string;
  identifier: string;
  purpose: 'INVITE' | 'RESET';
}

/**
 * Public page reached from a one-time invite or reset link. The person sets
 * their own password here; nothing is sent to them by an administrator.
 */
export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .get(`/auth/invite/${token}`)
      .then(({ data }) => setInfo(data))
      .catch(() => setInvalid(true));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post('/auth/invite/accept', { token, password });
      setDone(data.identifier);
    } catch (err) {
      const message =
        (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message ?? 'Could not set password';
      setError(Array.isArray(message) ? message.join(', ') : message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-md p-8">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold">
            Co<span style={{ color: 'var(--accent)' }}>Cally</span>
          </h1>
        </div>

        {invalid && (
          <div className="space-y-3 text-center">
            <p className="font-medium">This link is invalid or has expired.</p>
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Links work once and expire after 48 hours. Ask your administrator to send a new one.
            </p>
          </div>
        )}

        {done && (
          <div className="space-y-4 text-center">
            <p className="font-medium">Password set.</p>
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Sign in with <span className="font-mono">{done}</span> and your new password. If your role requires it, you
              will be asked to set up an authenticator app next.
            </p>
            <Link href="/login" className="btn btn-primary inline-block">
              Go to sign in
            </Link>
          </div>
        )}

        {info && !done && (
          <form onSubmit={submit} className="space-y-4">
            <div>
              <p className="font-medium">
                {info.purpose === 'INVITE' ? `Welcome, ${info.name}.` : `Reset password for ${info.name}`}
              </p>
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
                You will sign in as <span className="font-mono">{info.identifier}</span>.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">New password</label>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={12}
                required
              />
              <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
                At least 12 characters, with letters and numbers.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Confirm password</label>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={12}
                required
              />
            </div>
            {error && (
              <p className="text-sm" style={{ color: 'var(--bad)' }}>
                {error}
              </p>
            )}
            <button className="btn btn-primary w-full" disabled={loading}>
              {loading ? 'Saving…' : 'Set password'}
            </button>
          </form>
        )}

        {!info && !invalid && !done && (
          <p className="text-center text-sm" style={{ color: 'var(--text-dim)' }}>
            Checking link…
          </p>
        )}
      </div>
    </main>
  );
}
