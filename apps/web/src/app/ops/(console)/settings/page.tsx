'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { fmtDateTime, LinkBox, Pill } from '@/components/ops/ui';
import { OPS_OPERATOR_KEY, OPS_TOKEN_KEY, opsApi, opsError, type OperatorProfile } from '@/lib/ops-api';

const RATE_FIELDS: Array<[string, string]> = [
  ['livekitAgentPerMin', 'LiveKit AI agent, $/min'],
  ['livekitSipPerMin', 'LiveKit phone line, $/min'],
  ['livekitWebrtcPerMin', 'LiveKit agent browser, $/min'],
  ['sttPerMin', 'Speech-to-text, $/AI min'],
  ['llmPerMin', 'Language model, $/AI min'],
  ['ttsPer1kChars', 'Voice, $/1,000 chars'],
  ['recordingPerMin', 'Recording, $/min'],
  ['telcoPerMin', 'Carrier, $/min (0 = client pays)'],
  ['fixedMonthlyUsd', 'Fixed, $/month'],
  ['inrPerUsd', '₹ per US$'],
];

const SELLER_FIELDS: Array<[string, string, boolean?]> = [
  ['name', 'Company name'],
  ['gstin', 'GSTIN (optional)'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['address', 'Address', true],
  ['paymentDetails', 'Payment details (bank, IFSC, UPI)', true],
];

function Note({ note }: { note: { text: string; bad?: boolean } | null }) {
  if (!note) return null;
  return <span className="text-sm" style={{ color: note.bad ? 'var(--bad)' : 'var(--good)' }}>{note.text}</span>;
}

export default function OpsSettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <RateCard />
      <Seller />
      <Operators />
      <MyAccount />
    </div>
  );
}

function RateCard() {
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    void opsApi.get<Record<string, number>>('/rate-card').then((r) => setDraft(r.data));
  }, []);
  if (!draft) return null;
  return (
    <section className="card space-y-3 p-5">
      <div>
        <h2 className="font-semibold">Rate card — what each provider costs us</h2>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          US dollars. Drives every cost and margin figure. Check against the LiveKit, ElevenLabs, Deepgram, Cerebras, Google Cloud and Atlas invoices each month.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {RATE_FIELDS.map(([k, label]) => (
          <label key={k} className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            {label}
            <input type="number" min={0} step={0.0005} className="input mt-1" value={draft[k] ?? 0} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          className="btn btn-primary"
          onClick={() =>
            void opsApi
              .put('/rate-card', draft)
              .then(() => setNote({ text: 'Saved.' }))
              .catch((err) => setNote({ text: opsError(err, 'Could not save.'), bad: true }))
          }
        >
          Save rate card
        </button>
        <Note note={note} />
      </div>
    </section>
  );
}

function Seller() {
  const [seller, setSeller] = useState<Record<string, string> | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    void opsApi.get<Record<string, string>>('/seller').then((r) => setSeller(r.data));
  }, []);
  if (!seller) return null;
  return (
    <section className="card space-y-3 p-5">
      <div>
        <h2 className="font-semibold">Invoice sender details</h2>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Printed on every new draft. Invoices say “Tax invoice” only when a GSTIN is set.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {SELLER_FIELDS.map(([k, label, area]) => (
          <label key={k} className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            {label}
            {area ? (
              <textarea className="input mt-1 h-16" value={seller[k] ?? ''} onChange={(e) => setSeller({ ...seller, [k]: e.target.value })} />
            ) : (
              <input className="input mt-1" value={seller[k] ?? ''} onChange={(e) => setSeller({ ...seller, [k]: e.target.value })} />
            )}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          className="btn btn-primary"
          onClick={() =>
            void opsApi
              .put('/seller', seller)
              .then(() => setNote({ text: 'Saved. New drafts use these details.' }))
              .catch((err) => setNote({ text: opsError(err, 'Could not save.'), bad: true }))
          }
        >
          Save sender details
        </button>
        <Note note={note} />
      </div>
    </section>
  );
}

interface OperatorRow {
  id: string;
  email: string;
  name: string;
  active: boolean;
  totpEnabled: boolean;
  passwordSet: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
}

function Operators() {
  const [rows, setRows] = useState<OperatorRow[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [link, setLink] = useState<{ title: string; url: string; expiresAt?: string } | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const me = typeof window !== 'undefined' ? (JSON.parse(localStorage.getItem(OPS_OPERATOR_KEY) ?? 'null') as OperatorProfile | null) : null;

  const load = useCallback(async () => {
    const r = await opsApi.get<OperatorRow[]>('/operators');
    setRows(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(fn: () => Promise<T>, ok: string, after?: (r: T) => void) {
    setNote(null);
    try {
      const r = await fn();
      setNote({ text: ok });
      after?.(r);
      await load();
    } catch (err) {
      setNote({ text: opsError(err, 'That did not work.'), bad: true });
    }
  }

  return (
    <section className="card space-y-3 p-5">
      <div>
        <h2 className="font-semibold">Operators</h2>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>CoCally staff with access to this console. Every operator must use an authenticator app.</p>
      </div>
      {link && <LinkBox title={link.title} url={link.url} expiresAt={link.expiresAt} onClose={() => setLink(null)} />}
      <table className="w-full text-sm">
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="py-2 pr-3">
                <span className="font-semibold">{o.name}</span>
                <span className="block text-xs" style={{ color: 'var(--text-dim)' }}>{o.email}</span>
              </td>
              <td className="py-2 pr-3">
                {o.active ? <Pill text="Active" tone="good" /> : <Pill text="Deactivated" tone="bad" />}{' '}
                <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  {o.passwordSet ? '' : 'invite pending · '}{o.totpEnabled ? '2FA on' : '2FA not set up'}
                </span>
              </td>
              <td className="py-2 pr-3 text-xs" style={{ color: 'var(--text-dim)' }}>{fmtDateTime(o.lastLoginAt)} {o.lastLoginIp ?? ''}</td>
              <td className="py-2">
                <div className="flex flex-wrap justify-end gap-1">
                  <button
                    className="btn btn-ghost text-xs"
                    onClick={() =>
                      void run(
                        () => opsApi.post<{ url: string; expiresAt: string }>(`/operators/${o.id}/link`),
                        'Link created.',
                        (r) => setLink({ title: `${o.passwordSet ? 'Password reset' : 'Invite'} link for ${o.name}`, url: r.data.url, expiresAt: r.data.expiresAt }),
                      )
                    }
                  >
                    {o.passwordSet ? 'Reset password' : 'New invite link'}
                  </button>
                  {o.totpEnabled && o.id !== me?.id && (
                    <button
                      className="btn btn-ghost text-xs"
                      onClick={() => {
                        if (window.confirm(`Clear ${o.name}'s authenticator? They set it up again at next sign-in.`)) {
                          void run(() => opsApi.post(`/operators/${o.id}/reset-2fa`), '2FA reset.');
                        }
                      }}
                    >
                      Reset 2FA
                    </button>
                  )}
                  {o.id !== me?.id && (
                    <button
                      className="btn btn-ghost text-xs"
                      style={o.active ? { color: 'var(--bad)' } : undefined}
                      onClick={() => void run(() => opsApi.post(`/operators/${o.id}/active`, { active: !o.active }), o.active ? 'Operator deactivated.' : 'Operator reactivated.')}
                    >
                      {o.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="flex flex-wrap items-end gap-2 border-t pt-3"
        style={{ borderColor: 'var(--border)' }}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => opsApi.post<{ operator: { name: string }; invite: { url: string; expiresAt: string } }>('/operators', { email, name }),
            'Operator added.',
            (r) => {
              setLink({ title: `Invite link for ${r.data.operator.name}`, url: r.data.invite.url, expiresAt: r.data.invite.expiresAt });
              setEmail('');
              setName('');
            },
          );
        }}
      >
        <input className="input max-w-xs" required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input max-w-xs" required type="email" placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn btn-primary">Add operator</button>
        <Note note={note} />
      </form>
    </section>
  );
}

function MyAccount() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  return (
    <section className="card space-y-3 p-5">
      <h2 className="font-semibold">My account</h2>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void opsApi
            .post<{ token: string; operator: OperatorProfile }>('/auth/password', { currentPassword: current, newPassword: next })
            .then((r) => {
              localStorage.setItem(OPS_TOKEN_KEY, r.data.token);
              setNote({ text: 'Password changed. Other sessions are signed out.' });
              setCurrent('');
              setNext('');
            })
            .catch((err) => setNote({ text: opsError(err, 'Could not change the password.'), bad: true }));
        }}
      >
        <input className="input max-w-xs" type="password" autoComplete="current-password" required placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className="input max-w-xs" type="password" autoComplete="new-password" required placeholder="New password (12+ chars)" value={next} onChange={(e) => setNext(e.target.value)} />
        <button className="btn btn-primary">Change password</button>
      </form>
      <div className="flex items-center gap-3">
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (!window.confirm('Sign out of the ops console on every device, including this one?')) return;
            void opsApi.post('/auth/sign-out-everywhere').finally(() => {
              localStorage.removeItem(OPS_TOKEN_KEY);
              localStorage.removeItem(OPS_OPERATOR_KEY);
              router.replace('/ops/login');
            });
          }}
        >
          Sign out everywhere
        </button>
        <Note note={note} />
      </div>
    </section>
  );
}
