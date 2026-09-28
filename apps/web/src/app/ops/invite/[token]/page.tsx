'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { opsApi, opsError } from '@/lib/ops-api';

/** One-time link for a new operator (or a reset) to set their own password. */
export default function OpsInvitePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<{ email: string; name: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    opsApi
      .get(`/auth/invite/${token}`)
      .then((r) => setInfo(r.data))
      .catch(() => setInvalid(true));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      await opsApi.post('/auth/invite/accept', { token, password });
      setDone(true);
    } catch (err) {
      setError(opsError(err, 'Could not set the password'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm space-y-4 p-6">
        <p className="text-xl font-bold">
          Co<span className="text-accent">Cally</span> <span className="text-sm font-semibold" style={{ color: 'var(--text-dim)' }}>Ops</span>
        </p>
        {invalid && <p style={{ color: 'var(--bad)' }}>This link is invalid or has expired. Ask another operator for a new one.</p>}
        {done && (
          <>
            <p>Password set for {info?.email}.</p>
            <Link href="/ops/login" className="btn btn-primary w-full text-center">Sign in</Link>
            <p className="text-xs" style={{ color: 'var(--text-dim)' }}>You will be asked to set up an authenticator app on first sign-in.</p>
          </>
        )}
        {info && !done && (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-sm">
              Hi {info.name}, set a password for <span className="font-semibold">{info.email}</span>. At least 12 characters, with letters and numbers.
            </p>
            <input className="input" type="password" autoComplete="new-password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <input className="input" type="password" autoComplete="new-password" placeholder="Repeat password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
            <button className="btn btn-primary w-full" disabled={busy}>Set password</button>
          </form>
        )}
      </div>
    </main>
  );
}
