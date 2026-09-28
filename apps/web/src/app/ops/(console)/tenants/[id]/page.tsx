'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import TenantBillingAdmin from '@/components/billing/TenantBillingAdmin';
import CallsTable from '@/components/ops/CallsTable';
import { fmtDate, fmtDateTime, LinkBox, Pill, tenantStatus } from '@/components/ops/ui';
import { inr, num } from '@/lib/billing';
import { opsApi, opsError } from '@/lib/ops-api';

interface Voice {
  provider: 'elevenlabs' | 'cartesia' | 'deepgram';
  voiceId?: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  region: string;
  active: boolean;
  paused: boolean;
  dailyDialQuota: number;
  retentionDays: number;
  voice: Voice | null;
  billingSet: boolean;
  createdAt: string | null;
  users: number;
  campaigns: number;
  clients: Array<{ id: string; name: string; active: boolean }>;
}

const TABS = [
  ['billing', 'Billing & invoices'],
  ['calls', 'Calls'],
  ['users', 'Users'],
  ['campaigns', 'Campaigns'],
  ['settings', 'Settings'],
  ['cost', 'Our cost'],
  ['audit', 'Audit'],
] as const;
type Tab = (typeof TABS)[number][0];

export default function OpsTenantPage() {
  const { id } = useParams<{ id: string }>();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tab, setTab] = useState<Tab>('billing');
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await opsApi.get<Tenant>(`/tenants/${id}`);
    setTenant(r.data);
  }, [id]);

  useEffect(() => {
    void load().catch(() => setNote({ text: 'Tenant not found.', bad: true }));
  }, [load]);

  async function patch(body: Record<string, unknown>, done: string) {
    try {
      await opsApi.patch(`/tenants/${id}`, body);
      setNote({ text: done });
      await load();
    } catch (err) {
      setNote({ text: opsError(err, 'That did not work.'), bad: true });
    }
  }

  if (!tenant) return <p style={{ color: note?.bad ? 'var(--bad)' : 'var(--text-dim)' }}>{note?.text ?? 'Loading…'}</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/ops/tenants" className="text-sm hover:underline" style={{ color: 'var(--text-dim)' }}>← Tenants</Link>
          <h1 className="flex items-center gap-3 text-2xl font-bold">
            {tenant.name} {tenantStatus(tenant)}
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            {tenant.slug} · {tenant.region.toUpperCase()} · {tenant.users} active users · {tenant.campaigns} campaigns · since {fmtDate(tenant.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tenant.active && (
            <button
              className="btn"
              style={tenant.paused ? { background: 'var(--good)', color: '#0b1220' } : { border: '1px solid var(--accent)', color: 'var(--accent)' }}
              onClick={() =>
                void patch({ paused: !tenant.paused }, tenant.paused ? 'Dialling resumed.' : 'All dialling paused for this tenant.')
              }
            >
              {tenant.paused ? 'Resume dialling' : 'Pause dialling'}
            </button>
          )}
          <button
            className={tenant.active ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={() => {
              const msg = tenant.active
                ? `Deactivate ${tenant.name}? Every user is signed out and cannot sign in, and no calls are placed. Data is kept.`
                : `Reactivate ${tenant.name}? Users can sign in again.`;
              if (window.confirm(msg)) void patch({ active: !tenant.active }, tenant.active ? 'Tenant deactivated.' : 'Tenant reactivated.');
            }}
          >
            {tenant.active ? 'Deactivate' : 'Reactivate'}
          </button>
        </div>
      </div>

      {note && <p className="text-sm" style={{ color: note.bad ? 'var(--bad)' : 'var(--good)' }}>{note.text}</p>}

      <div className="flex flex-wrap gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            className="px-3 py-2 text-sm"
            style={tab === key ? { borderBottom: '2px solid var(--accent)', color: 'var(--accent)', fontWeight: 600 } : { color: 'var(--text-dim)' }}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'billing' && <TenantBillingAdmin tenantId={id} onChanged={() => void load()} />}
      {tab === 'calls' && <CallsTable tenantId={id} showTenant={false} />}
      {tab === 'users' && <UsersTab tenantId={id} />}
      {tab === 'campaigns' && <CampaignsTab tenantId={id} />}
      {tab === 'settings' && <SettingsTab tenant={tenant} save={patch} />}
      {tab === 'cost' && <CostTab tenantId={id} />}
      {tab === 'audit' && <AuditTab tenantId={id} />}
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────

interface TenantUser {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  roles: string[];
  active: boolean;
  totpEnabled: boolean;
  passwordSet: boolean;
  presence: string;
  lastLoginAt: string | null;
}

const ROLE_CHOICES = ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA', 'AGENT'];

function UsersTab({ tenantId }: { tenantId: string }) {
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [link, setLink] = useState<{ title: string; url: string; expiresAt?: string } | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', roles: ['ADMIN'] as string[] });

  const load = useCallback(async () => {
    const r = await opsApi.get<TenantUser[]>(`/tenants/${tenantId}/users`);
    setUsers(r.data);
  }, [tenantId]);

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
    <div className="space-y-4">
      {link && <LinkBox title={link.title} url={link.url} expiresAt={link.expiresAt} onClose={() => setLink(null)} />}
      {note && <p className="text-sm" style={{ color: note.bad ? 'var(--bad)' : 'var(--good)' }}>{note.text}</p>}

      <section className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              <th className="px-4 py-3">Name</th>
              <th className="px-3 py-3">Sign-in</th>
              <th className="px-3 py-3">Roles</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Last sign-in</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                <td className="px-4 py-3 font-semibold">{u.name}</td>
                <td className="px-3 py-3 font-mono text-xs">
                  {u.phone}
                  {u.email && <span className="block" style={{ color: 'var(--text-dim)' }}>{u.email}</span>}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1">
                    {ROLE_CHOICES.map((r) => (
                      <label key={r} className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={u.roles.includes(r)}
                          onChange={(e) => {
                            const roles = e.target.checked ? [...u.roles, r] : u.roles.filter((x) => x !== r);
                            void run(() => opsApi.post(`/tenants/${tenantId}/users/${u.id}/roles`, { roles }), `Roles updated for ${u.name}. They are signed out.`);
                          }}
                        />
                        {r.toLowerCase()}
                      </label>
                    ))}
                  </div>
                </td>
                <td className="space-y-1 px-3 py-3">
                  <div>{u.active ? <Pill text="Active" tone="good" /> : <Pill text="Deactivated" tone="bad" />}</div>
                  <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    {u.passwordSet ? 'Password set' : 'Invite pending'} · {u.totpEnabled ? '2FA on' : '2FA off'}
                  </div>
                </td>
                <td className="px-3 py-3 text-xs" style={{ color: 'var(--text-dim)' }}>{fmtDateTime(u.lastLoginAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    <button
                      className="btn btn-ghost text-xs"
                      onClick={() =>
                        void run(
                          () => opsApi.post<{ purpose: string; invite: { url: string; expiresAt: string } }>(`/tenants/${tenantId}/users/${u.id}/link`),
                          'Link created.',
                          (r) => setLink({ title: `${r.data.purpose === 'RESET' ? 'Password reset' : 'Invite'} link for ${u.name}`, url: r.data.invite.url, expiresAt: r.data.invite.expiresAt }),
                        )
                      }
                    >
                      {u.passwordSet ? 'Reset password' : 'Resend invite'}
                    </button>
                    {u.totpEnabled && (
                      <button
                        className="btn btn-ghost text-xs"
                        onClick={() => {
                          if (window.confirm(`Clear ${u.name}'s authenticator? They will set it up again at next sign-in.`)) {
                            void run(() => opsApi.post(`/tenants/${tenantId}/users/${u.id}/reset-2fa`), '2FA reset. They are signed out.');
                          }
                        }}
                      >
                        Reset 2FA
                      </button>
                    )}
                    <button
                      className="btn btn-ghost text-xs"
                      style={u.active ? { color: 'var(--bad)' } : undefined}
                      onClick={() => void run(() => opsApi.post(`/tenants/${tenantId}/users/${u.id}/active`, { active: !u.active }), u.active ? 'User deactivated.' : 'User reactivated.')}
                    >
                      {u.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form
        className="card space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              opsApi.post<{ user: { name: string }; invite: { url: string; expiresAt: string } }>(`/tenants/${tenantId}/users`, {
                name: form.name,
                phone: form.phone,
                email: form.email || undefined,
                roles: form.roles,
              }),
            'User added.',
            (r) => {
              setLink({ title: `Invite link for ${r.data.user.name}`, url: r.data.invite.url, expiresAt: r.data.invite.expiresAt });
              setForm({ name: '', phone: '', email: '', roles: ['ADMIN'] });
            },
          );
        }}
      >
        <h2 className="font-semibold">Add a user</h2>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Usually just their owners and admins — they add their own agents.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <input className="input" required placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" required placeholder="Mobile +91… / +61…" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className="input" type="email" placeholder="Email (optional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="flex flex-wrap gap-3">
          {ROLE_CHOICES.map((r) => (
            <label key={r} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={form.roles.includes(r)}
                onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, r] : form.roles.filter((x) => x !== r) })}
              />
              {r.toLowerCase()}
            </label>
          ))}
        </div>
        <button className="btn btn-primary" disabled={!form.roles.length}>Add and create invite link</button>
      </form>
    </div>
  );
}

// ── Campaigns ────────────────────────────────────────────────────────────

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  country: string;
  dailyDialBudget: number | null;
  voicemailPolicy: string | null;
  monthDials: number;
  monthAnswered: number;
  monthTransfers: number;
  monthAiMinutes: number;
}

function CampaignsTab({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = useState<CampaignRow[]>([]);
  useEffect(() => {
    void opsApi.get<CampaignRow[]>(`/tenants/${tenantId}/campaigns`).then((r) => setRows(r.data));
  }, [tenantId]);
  return (
    <section className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
            <th className="px-4 py-3">Campaign</th>
            <th className="px-3 py-3">Status</th>
            <th className="px-3 py-3">Country</th>
            <th className="px-3 py-3">Voicemail</th>
            <th className="px-3 py-3 text-right">Daily budget</th>
            <th className="px-3 py-3 text-right">Dials (month)</th>
            <th className="px-3 py-3 text-right">Answered</th>
            <th className="px-3 py-3 text-right">Transfers</th>
            <th className="px-4 py-3 text-right">AI min</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="px-4 py-2 font-semibold">{c.name}</td>
              <td className="px-3 py-2"><Pill text={c.status.toLowerCase()} tone={c.status === 'ACTIVE' ? 'good' : 'dim'} /></td>
              <td className="px-3 py-2">{c.country}</td>
              <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-dim)' }}>{c.voicemailPolicy?.toLowerCase().replace(/_/g, ' ') ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{c.dailyDialBudget ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{num(c.monthDials)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{num(c.monthAnswered)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{num(c.monthTransfers)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{num(c.monthAiMinutes, 1)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-6 text-center" style={{ color: 'var(--text-dim)' }}>No campaigns yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="px-4 pb-3 pt-2 text-xs" style={{ color: 'var(--text-dim)' }}>Campaigns are built by the tenant&apos;s admins in their own app.</p>
    </section>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────

const VOICE_PROVIDERS: Array<[Voice['provider'], string, string]> = [
  ['elevenlabs', 'ElevenLabs Flash', 'Voice id from ElevenLabs, e.g. EXAVITQu4vr4xnSDxMaL'],
  ['cartesia', 'Cartesia Sonic', 'Cartesia voice id (needs CARTESIA_API_KEY on the worker)'],
  ['deepgram', 'Deepgram Aura', 'Aura model, e.g. aura-2-luna-en'],
];

function SettingsTab({ tenant, save }: { tenant: Tenant; save: (body: Record<string, unknown>, done: string) => Promise<void> }) {
  const [name, setName] = useState(tenant.name);
  const [provider, setProvider] = useState<'' | Voice['provider']>(tenant.voice?.provider ?? '');
  const [voiceId, setVoiceId] = useState(tenant.voice?.voiceId ?? '');
  const [quota, setQuota] = useState(tenant.dailyDialQuota);
  const [retention, setRetention] = useState(tenant.retentionDays);
  const hint = VOICE_PROVIDERS.find(([p]) => p === provider)?.[2] ?? 'The worker default (TTS_PROVIDER / TTS_VOICE on the server).';

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card space-y-3 p-5">
        <h2 className="font-semibold">Profile &amp; limits</h2>
        <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
          Name
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Daily dial limit (0 = none)
            <input className="input mt-1" type="number" min={0} value={quota} onChange={(e) => setQuota(Number(e.target.value))} />
          </label>
          <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
            Keep recordings &amp; transcripts (days)
            <input className="input mt-1" type="number" min={30} max={3650} value={retention} onChange={(e) => setRetention(Number(e.target.value))} />
          </label>
        </div>
        <button className="btn btn-primary" onClick={() => void save({ name, dailyDialQuota: quota, retentionDays: retention }, 'Saved.')}>
          Save
        </button>
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="font-semibold">AI voice</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as '' | Voice['provider'])}>
            <option value="">Default</option>
            {VOICE_PROVIDERS.map(([p, label]) => (
              <option key={p} value={p}>{label}</option>
            ))}
          </select>
          <input className="input" placeholder="Voice id (blank = provider default)" disabled={!provider} value={voiceId} onChange={(e) => setVoiceId(e.target.value)} />
        </div>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{hint}</p>
        <button
          className="btn btn-primary"
          onClick={() =>
            void save({ voice: provider ? { provider, voiceId: voiceId.trim() || undefined } : null }, 'Voice saved — applies from the next call.')
          }
        >
          Save voice
        </button>
      </section>

      <section className="card space-y-2 p-5 lg:col-span-2">
        <h2 className="font-semibold">Clients (brands they call for)</h2>
        <ul className="text-sm">
          {tenant.clients.map((c) => (
            <li key={c.id}>{c.name}{!c.active && ' (inactive)'}</li>
          ))}
        </ul>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>The tenant adds more clients from Campaigns in their own app.</p>
      </section>
    </div>
  );
}

// ── Our cost ─────────────────────────────────────────────────────────────

interface CostRow {
  tenantId: string;
  usage: { aiSeconds: number; humanSeconds: number; ringSeconds: number; recordedSeconds: number; ttsChars: number; dials: number };
  costUsd: Record<string, number>;
  costInr: number;
  billedInr: number;
  marginInr: number;
}

const COST_LABELS: Array<[string, string]> = [
  ['tts', 'Voice (TTS)'],
  ['aiAgent', 'LiveKit AI agent'],
  ['stt', 'Speech-to-text'],
  ['llm', 'Language model'],
  ['phoneLine', 'LiveKit phone line'],
  ['recording', 'Recording'],
  ['agentBrowser', 'Agent browser'],
  ['carrier', 'Carrier'],
];

function CostTab({ tenantId }: { tenantId: string }) {
  const [row, setRow] = useState<CostRow | null>(null);
  const [fx, setFx] = useState(98);
  useEffect(() => {
    const from = new Date();
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
    void opsApi
      .get<{ rows: CostRow[]; rateCard: { inrPerUsd: number } }>(`/overview?from=${from.toISOString()}&to=${new Date().toISOString()}`)
      .then((r) => {
        setRow(r.data.rows.find((x) => x.tenantId === tenantId) ?? null);
        setFx(r.data.rateCard.inrPerUsd);
      });
  }, [tenantId]);
  if (!row) return <p style={{ color: 'var(--text-dim)' }}>Loading…</p>;
  const aiMin = row.usage.aiSeconds / 60;
  const aiCost = (['aiAgent', 'stt', 'llm', 'tts'] as const).reduce((a, k) => a + (row.costUsd[k] ?? 0), 0) * fx;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-semibold">This month — what it cost us</h2>
          {aiMin > 0 && (
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
              AI minute ≈ <span className="font-semibold" style={{ color: 'var(--text)' }}>{inr(aiCost / aiMin)}</span>
            </span>
          )}
        </div>
        <ul className="space-y-1.5 text-sm">
          {COST_LABELS.map(([k, label]) => (
            <li key={k} className="flex justify-between">
              <span style={{ color: 'var(--text-dim)' }}>{label}</span>
              <span className="tabular-nums">{inr((row.costUsd[k] ?? 0) * fx)}</span>
            </li>
          ))}
          <li className="flex justify-between border-t pt-2 font-semibold" style={{ borderColor: 'var(--border)' }}>
            <span>Total</span>
            <span className="tabular-nums">{inr(row.costInr)}</span>
          </li>
        </ul>
      </section>
      <section className="card space-y-2 p-5 text-sm">
        <h2 className="font-semibold">Against what we bill</h2>
        <p className="flex justify-between"><span style={{ color: 'var(--text-dim)' }}>Billed for usage (before GST)</span><span className="tabular-nums">{inr(row.billedInr)}</span></p>
        <p className="flex justify-between"><span style={{ color: 'var(--text-dim)' }}>Our usage cost</span><span className="tabular-nums">{inr(row.costInr)}</span></p>
        <p className="flex justify-between border-t pt-2 font-semibold" style={{ borderColor: 'var(--border)', color: row.marginInr >= 0 ? 'var(--good)' : 'var(--bad)' }}>
          <span>Margin (before fixed costs)</span>
          <span className="tabular-nums">{inr(row.marginInr)}</span>
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 pt-3 text-xs" style={{ color: 'var(--text-dim)' }}>
          <dt>Ringing</dt><dd className="text-right tabular-nums">{num(row.usage.ringSeconds / 60, 1)} min</dd>
          <dt>Recorded</dt><dd className="text-right tabular-nums">{num(row.usage.recordedSeconds / 60, 1)} min</dd>
          <dt>AI speech</dt><dd className="text-right tabular-nums">{num(row.usage.ttsChars)} chars</dd>
        </dl>
        <p className="pt-2 text-xs" style={{ color: 'var(--text-dim)' }}>Estimates from the rate card (Settings). Check against provider invoices monthly.</p>
      </section>
    </div>
  );
}

// ── Audit ────────────────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  at: string;
  operatorEmail: string;
  action: string;
  entityType: string | null;
  after: Record<string, unknown> | null;
}

function AuditTab({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => {
    void opsApi.get<AuditRow[]>(`/tenants/${tenantId}/audit`).then((r) => setRows(r.data));
  }, [tenantId]);
  return (
    <section className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
            <th className="px-4 py-3">When</th>
            <th className="px-3 py-3">Operator</th>
            <th className="px-3 py-3">Action</th>
            <th className="px-4 py-3">Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
              <td className="whitespace-nowrap px-4 py-2">{fmtDateTime(r.at)}</td>
              <td className="px-3 py-2">{r.operatorEmail}</td>
              <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
              <td className="max-w-md truncate px-4 py-2 font-mono text-xs" style={{ color: 'var(--text-dim)' }} title={JSON.stringify(r.after)}>
                {r.after ? JSON.stringify(r.after) : ''}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center" style={{ color: 'var(--text-dim)' }}>Nothing yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="px-4 pb-3 pt-2 text-xs" style={{ color: 'var(--text-dim)' }}>CoCally actions only. The tenant&apos;s own activity is in their Audit log.</p>
    </section>
  );
}
