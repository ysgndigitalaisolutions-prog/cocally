'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { fmtDateTime, LinkBox, Pill } from '@/components/ops/ui';
import { OPS_OPERATOR_KEY, OPS_TOKEN_KEY, opsApi, opsError, type OperatorProfile } from '@/lib/ops-api';

type Confidence = 'PUBLISHED' | 'ESTIMATE' | 'NOT_OURS';

/** Measured on real AI calls, 5 Nov 2026 (15 calls, 15 AI minutes): a small sample. */
const VOICE_CHARS_PER_AI_MIN = 638;
const RING_SHARE_PER_AI_MIN = 0.3;

const RATE_ROWS: Array<{ key: string; vendor: string; item: string; unit: string; confidence: Confidence; basis: string; perAiMin?: (v: number) => number }> = [
  { key: 'sttPerMin', vendor: 'Deepgram', item: 'Speech-to-text (Nova-3)', unit: 'per AI min', confidence: 'PUBLISHED', basis: 'Pay-as-you-go streaming list price', perAiMin: (v) => v },
  { key: 'llmPerMin', vendor: 'Google', item: 'Gemini 2.5 Flash', unit: 'per AI min', confidence: 'ESTIMATE', basis: '3.5 requests a minute × 1,824 tokens at $0.30 per 1M, plus a little output', perAiMin: (v) => v },
  { key: 'ttsPer1kChars', vendor: 'Cartesia', item: 'Voice (Sonic)', unit: 'per 1,000 chars', confidence: 'ESTIMATE', basis: 'About 1 credit a character; $49 for 1.25M. Your plan may differ', perAiMin: (v) => (v * VOICE_CHARS_PER_AI_MIN) / 1000 },
  { key: 'livekitAgentPerMin', vendor: 'LiveKit', item: 'Agent session', unit: 'per AI min', confidence: 'ESTIMATE', basis: '$0.01 is the Cloud agent rate. Our worker runs on our own server, so check the invoice', perAiMin: (v) => v },
  { key: 'livekitSipPerMin', vendor: 'LiveKit', item: 'Phone line (SIP)', unit: 'per phone min', confidence: 'ESTIMATE', basis: 'From a forum reply, not a price list; ringing counts too. Check the invoice', perAiMin: (v) => v * (1 + RING_SHARE_PER_AI_MIN) },
  { key: 'livekitWebrtcPerMin', vendor: 'LiveKit', item: 'Agent browser', unit: 'per human min', confidence: 'ESTIMATE', basis: 'Old value, not rechecked' },
  { key: 'recordingPerMin', vendor: 'LiveKit', item: 'Recording', unit: 'per recorded min', confidence: 'ESTIMATE', basis: 'Old value, not rechecked', perAiMin: (v) => v },
  { key: 'telcoPerMin', vendor: 'Telvoq', item: 'Phone carrier', unit: 'per connected min', confidence: 'NOT_OURS', basis: 'Not billed to us', perAiMin: (v) => v },
  { key: 'fixedMonthlyUsd', vendor: 'All', item: 'Server, database, plans', unit: 'per month', confidence: 'ESTIMATE', basis: 'Old figure; add up the real invoices' },
  { key: 'inrPerUsd', vendor: 'Exchange rate', item: 'Rupees per US dollar', unit: '₹ per $', confidence: 'ESTIMATE', basis: 'Old value, not rechecked' },
];

const CONFIDENCE: Record<Confidence, { label: string; color: string }> = {
  PUBLISHED: { label: 'Published price', color: 'var(--good)' },
  ESTIMATE: { label: 'Estimate', color: 'var(--accent)' },
  NOT_OURS: { label: 'Not our cost', color: 'var(--text-dim)' },
};

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
  const perAiMin = RATE_ROWS.reduce((sum, r) => sum + (r.perAiMin?.(draft[r.key] ?? 0) ?? 0), 0);
  const costInr = perAiMin * (draft.inrPerUsd ?? 0);
  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold">What each provider costs us</h2>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          US dollars, checked 5 Nov 2026. These drive every cost and margin figure. The invoices are the final word.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Our cost per AI minute</p>
          <p className="text-2xl font-bold tabular-nums">${perAiMin.toFixed(3)}</p>
        </div>
        <div className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>In rupees</p>
          <p className="text-2xl font-bold tabular-nums">₹{costInr.toFixed(2)}</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="text-left text-xs" style={{ color: 'var(--text-dim)' }}>
              <th className="pb-2 font-medium">Provider</th>
              <th className="pb-2 font-medium">Rate</th>
              <th className="pb-2 text-right font-medium">Per AI minute</th>
              <th className="pb-2 pl-4 font-medium">How sure</th>
              <th className="pb-2 font-medium">Based on</th>
            </tr>
          </thead>
          <tbody>
            {RATE_ROWS.map((r) => (
              <tr key={r.key} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                <td className="py-2 pr-3">
                  <p className="font-medium">{r.vendor}</p>
                  <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{r.item}</p>
                </td>
                <td className="py-2 pr-3">
                  <input
                    type="number"
                    min={0}
                    step={0.0005}
                    aria-label={`${r.vendor} ${r.item}`}
                    className="input"
                    style={{ width: '7rem' }}
                    value={draft[r.key] ?? 0}
                    onChange={(e) => setDraft({ ...draft, [r.key]: Number(e.target.value) })}
                  />
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-dim)' }}>{r.unit}</p>
                </td>
                <td className="py-2 text-right tabular-nums">{r.perAiMin ? `$${r.perAiMin(draft[r.key] ?? 0).toFixed(4)}` : '—'}</td>
                <td className="py-2 pl-4 text-xs font-semibold" style={{ color: CONFIDENCE[r.confidence].color }}>{CONFIDENCE[r.confidence].label}</td>
                <td className="py-2 text-xs" style={{ color: 'var(--text-dim)' }}>{r.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
          Save rates
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
