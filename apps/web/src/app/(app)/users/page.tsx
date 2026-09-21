'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';

interface UserRow {
  id: string;
  phone?: string;
  email?: string;
  name: string;
  roles: string[];
  totpEnabled: boolean;
  active: boolean;
  passwordSet: boolean;
  lastLoginAt?: string;
  lastLoginIp?: string;
}

interface AuditRow {
  _id: string;
  actorLabel: string;
  action: string;
  ip?: string;
  after?: { reason?: string; userAgent?: string; totp?: boolean };
  createdAt: string;
}

const ROLE_OPTIONS = ['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT', 'QA'] as const;
const ACCESS_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.invite_accepted',
  'auth.password_changed',
  'auth.password_reset',
  'auth.2fa_enabled',
  'user.create',
  'user.deactivate',
  'user.invite_created',
  'user.reset_link_created',
  'user.2fa_reset',
].join(',');

const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.invite_accepted': 'Invite accepted',
  'auth.password_changed': 'Password changed',
  'auth.password_reset': 'Password reset',
  'auth.2fa_enabled': 'Authenticator enabled',
  'user.create': 'User created',
  'user.deactivate': 'User deactivated',
  'user.invite_created': 'Invite link issued',
  'user.reset_link_created': 'Reset link issued',
  'user.2fa_reset': 'Authenticator reset',
};

function errText(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (!message) return fallback;
  return Array.isArray(message) ? message.join(', ') : message;
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Owner/Admin: invite people, hand out one-time links, deactivate, and watch who signs in. */
export default function UsersPage() {
  const { user: me } = useAppStore();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [log, setLog] = useState<AuditRow[]>([]);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['AGENT']);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string; who: string; purpose: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [u, a] = await Promise.all([api.get('/users'), api.get(`/audit?actions=${ACCESS_ACTIONS}&limit=100`)]);
    setUsers(u.data);
    setLog(a.data);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(errText(err, 'Could not load users')));
  }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post('/users', { name, phone, email: email || undefined, roles });
      setLink({ url: data.invite.url, expiresAt: data.invite.expiresAt, who: data.user.name, purpose: 'invite' });
      setCopied(false);
      setName('');
      setPhone('');
      setEmail('');
      setRoles(['AGENT']);
      await load();
    } catch (err) {
      setError(errText(err, 'Could not create user'));
    } finally {
      setBusy(false);
    }
  }

  async function reissue(u: UserRow) {
    setError('');
    try {
      const { data } = await api.post(`/users/${u.id}/link`);
      setLink({ url: data.invite.url, expiresAt: data.invite.expiresAt, who: u.name, purpose: data.purpose.toLowerCase() });
      setCopied(false);
      await load();
    } catch (err) {
      setError(errText(err, 'Could not issue link'));
    }
  }

  async function setActive(u: UserRow, active: boolean) {
    if (!active && !confirm(`Deactivate ${u.name}? They are signed out immediately.`)) return;
    setError('');
    try {
      await api.patch(`/users/${u.id}`, { active });
      await load();
    } catch (err) {
      setError(errText(err, 'Could not update user'));
    }
  }

  async function reset2fa(u: UserRow) {
    if (!confirm(`Reset the authenticator for ${u.name}? They will enrol again at next sign-in.`)) return;
    setError('');
    try {
      await api.post(`/users/${u.id}/2fa/reset`);
      await load();
    } catch (err) {
      setError(errText(err, 'Could not reset authenticator'));
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const isOwner = me?.roles.includes('OWNER');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Users &amp; access</h1>

      {error && (
        <p className="text-sm" style={{ color: 'var(--bad)' }}>
          {error}
        </p>
      )}

      {link && (
        <div className="card space-y-2 p-4" style={{ borderColor: 'var(--accent)' }}>
          <p className="font-medium">
            One-time {link.purpose} link for {link.who}. It is shown once and expires {fmtTime(link.expiresAt)}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded px-2 py-1 text-xs" style={{ background: 'var(--surface-2)' }}>
              {link.url}
            </code>
            <button className="btn text-sm" onClick={copyLink}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn text-sm" onClick={() => setLink(null)}>
              Dismiss
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            Send it to the person directly, for example over WhatsApp. They set their own password; you never see it.
          </p>
        </div>
      )}

      <section className="card p-6">
        <h2 className="mb-4 font-semibold">Invite a user</h2>
        <form onSubmit={invite} className="grid gap-3 md:grid-cols-4">
          <input className="input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input
            className="input"
            placeholder="Mobile, e.g. 0412 000 104"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <input
            className="input"
            placeholder="Email (optional)"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create and get link'}
          </button>
          <div className="flex flex-wrap gap-3 md:col-span-4">
            {ROLE_OPTIONS.filter((r) => r !== 'OWNER' || isOwner).map((r) => (
              <label key={r} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))}
                />
                {r}
              </label>
            ))}
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
              Owner, Admin, Supervisor and QA must set up an authenticator app at first sign-in.
            </span>
          </div>
        </form>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="p-6 pb-0 font-semibold">Members</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-3 pl-6">Name</th>
              <th className="p-3">Phone</th>
              <th className="p-3">Roles</th>
              <th className="p-3">Status</th>
              <th className="p-3">2FA</th>
              <th className="p-3">Last sign-in</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t" style={{ borderColor: 'var(--border)', opacity: u.active ? 1 : 0.6 }}>
                <td className="p-3 pl-6">
                  <p className="font-medium">{u.name}</p>
                  {u.email && (
                    <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                      {u.email}
                    </p>
                  )}
                </td>
                <td className="p-3 font-mono text-xs">{u.phone ?? '—'}</td>
                <td className="p-3">{u.roles.join(', ')}</td>
                <td className="p-3">{!u.active ? 'Deactivated' : u.passwordSet ? 'Active' : 'Invited, no password yet'}</td>
                <td className="p-3">{u.totpEnabled ? 'Enabled' : '—'}</td>
                <td className="p-3">
                  <p>{fmtTime(u.lastLoginAt)}</p>
                  {u.lastLoginIp && (
                    <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                      {u.lastLoginIp}
                    </p>
                  )}
                </td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-1">
                    {u.active && (
                      <button className="btn text-xs" onClick={() => reissue(u)}>
                        {u.passwordSet ? 'Reset link' : 'New invite link'}
                      </button>
                    )}
                    {u.active && u.totpEnabled && u.id !== me?.id && (
                      <button className="btn text-xs" onClick={() => reset2fa(u)}>
                        Reset 2FA
                      </button>
                    )}
                    {u.id !== me?.id && (
                      <button className="btn text-xs" onClick={() => setActive(u, !u.active)}>
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="p-6 pb-0 font-semibold">Access log</h2>
        <p className="px-6 pt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
          Every sign-in, failed attempt, password and authenticator event. Append-only.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="p-3 pl-6">When</th>
              <th className="p-3">Who</th>
              <th className="p-3">Event</th>
              <th className="p-3">IP</th>
              <th className="p-3">Detail</th>
            </tr>
          </thead>
          <tbody>
            {log.map((r) => (
              <tr key={r._id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="p-3 pl-6 whitespace-nowrap">{fmtTime(r.createdAt)}</td>
                <td className="p-3 font-mono text-xs">{r.actorLabel}</td>
                <td className="p-3" style={{ color: r.action === 'auth.login_failed' ? 'var(--bad)' : undefined }}>
                  {ACTION_LABEL[r.action] ?? r.action}
                </td>
                <td className="p-3 font-mono text-xs">{r.ip ?? '—'}</td>
                <td className="p-3 text-xs" style={{ color: 'var(--text-dim)' }}>
                  {r.after?.reason ?? ''} {r.after?.userAgent ? `· ${r.after.userAgent.slice(0, 60)}` : ''}
                </td>
              </tr>
            ))}
            {log.length === 0 && (
              <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td colSpan={5} className="p-6 text-sm" style={{ color: 'var(--text-dim)' }}>
                  No access events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
