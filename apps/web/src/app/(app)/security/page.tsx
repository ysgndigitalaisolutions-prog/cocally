'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';
import { homeFor } from '@/lib/roles';

interface Profile {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  roles: string[];
  totpEnabled: boolean;
  twoFactorSetupRequired: boolean;
}

function errText(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (!message) return fallback;
  return Array.isArray(message) ? message.join(', ') : message;
}

/** Own account: authenticator enrolment (required for privileged roles) and password change. */
export default function SecurityPage() {
  const router = useRouter();
  const { setUser } = useAppStore();
  const [profile, setProfile] = useState<Profile | null>(null);

  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [totpMsg, setTotpMsg] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  const load = useCallback(async (): Promise<Profile> => {
    const { data } = await api.get('/auth/me');
    setProfile(data);
    const stored = localStorage.getItem('cocally.user');
    const merged = { ...(stored ? JSON.parse(stored) : {}), ...data };
    localStorage.setItem('cocally.user', JSON.stringify(merged));
    setUser(merged);
    return data;
  }, [setUser]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  async function beginSetup() {
    setTotpMsg('');
    try {
      const { data } = await api.post('/auth/2fa/setup');
      setOtpauthUrl(data.otpauthUrl);
      setSecret(data.secret);
      setQr(await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 200 }));
    } catch (err) {
      setTotpMsg(errText(err, 'Could not start setup'));
    }
  }

  async function confirmSetup(e: React.FormEvent) {
    e.preventDefault();
    setTotpMsg('');
    try {
      await api.post('/auth/2fa/confirm', { code });
      setOtpauthUrl(null);
      setSecret(null);
      setQr(null);
      setCode('');
      const fresh = await load();
      setTotpMsg('Authenticator enabled.');
      // Route on the profile just fetched, not the stale one: it still says
      // setup is required and would send them straight back here.
      if (profile?.twoFactorSetupRequired) router.push(homeFor(fresh));
    } catch (err) {
      setTotpMsg(errText(err, 'Code not accepted'));
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg('');
    if (newPassword !== confirm) {
      setPwMsg('New passwords do not match');
      return;
    }
    try {
      const { data } = await api.post('/auth/password', { currentPassword, newPassword });
      // Other sessions are signed out; this one continues with the fresh token.
      localStorage.setItem('cocally.token', data.token);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setPwMsg('Password changed. Other sessions have been signed out.');
    } catch (err) {
      setPwMsg(errText(err, 'Could not change password'));
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">My security</h1>

      {profile?.twoFactorSetupRequired && (
        <div className="card p-4" style={{ borderColor: 'var(--accent)' }}>
          <p className="font-medium">Set up an authenticator app to continue.</p>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Your role ({profile.roles.join(', ')}) requires two-factor authentication. Nothing else is available until
            it is enabled.
          </p>
        </div>
      )}

      <section className="card space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Two-factor authentication</h2>
          <span
            className="rounded-full px-3 py-1 text-xs font-medium"
            style={{
              background: profile?.totpEnabled ? 'var(--good)' : 'var(--surface-2)',
              color: profile?.totpEnabled ? '#fff' : 'var(--text-dim)',
            }}
          >
            {profile?.totpEnabled ? 'Enabled' : 'Not set up'}
          </span>
        </div>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          Uses a time-based code from an authenticator app such as Google Authenticator, Microsoft Authenticator or
          1Password. No SMS is involved.
        </p>

        {!profile?.totpEnabled && !otpauthUrl && (
          <button className="btn btn-primary" onClick={beginSetup}>
            Set up authenticator
          </button>
        )}

        {otpauthUrl && (
          <form onSubmit={confirmSetup} className="space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Open your authenticator app and choose “Add account”.</li>
              <li>
                Scan this code, or enter the key manually: <span className="font-mono">{secret}</span>
              </li>
              <li>Enter the six-digit code the app shows.</li>
            </ol>
            {qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="Authenticator QR code" width={200} height={200} className="rounded bg-white p-2" />
            )}
            <div className="flex gap-2">
              <input
                className="input max-w-[12rem]"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
              <button className="btn btn-primary">Confirm</button>
            </div>
          </form>
        )}

        {totpMsg && <p className="text-sm">{totpMsg}</p>}
        {profile?.totpEnabled && (
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            Lost your device? An administrator can reset your authenticator from Users &amp; access.
          </p>
        )}
      </section>

      <section className="card space-y-4 p-6">
        <h2 className="font-semibold">Change password</h2>
        <form onSubmit={changePassword} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Current password</label>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">New password</label>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
              At least 12 characters, with letters and numbers.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Confirm new password</label>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          {pwMsg && <p className="text-sm">{pwMsg}</p>}
          <button className="btn btn-primary">Change password</button>
        </form>
      </section>

      {profile && (
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Signed in as {profile.name} · {profile.phone ?? profile.email} · {profile.roles.join(', ')}
        </p>
      )}
    </div>
  );
}
