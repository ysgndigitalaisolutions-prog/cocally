'use client';

import { useCallback, useEffect, useState } from 'react';
import TenantBillingAdmin from '@/components/billing/TenantBillingAdmin';
import { api } from '@/lib/api';
import type { TenantBilling } from '@/lib/billing';

/**
 * CoCally's own operator screen (PLATFORM_ADMIN_EMAILS only): what every
 * tenant used, what it cost us, what we bill, and the settings only we change.
 * Costs are usage × the rate card — estimates to check against real invoices.
 */

interface Usage {
  dials: number;
  answered: number;
  voicemail: number;
  transfers: number;
  manualDials: number;
  ringSeconds: number;
  aiSeconds: number;
  humanSeconds: number;
  recordedSeconds: number;
  ttsChars: number;
}

interface CostBreakdown {
  aiAgent: number;
  phoneLine: number;
  agentBrowser: number;
  stt: number;
  llm: number;
  tts: number;
  recording: number;
  carrier: number;
  total: number;
}

interface Voice {
  provider: 'elevenlabs' | 'cartesia' | 'deepgram';
  voiceId?: string;
}

interface Row {
  tenantId: string;
  name: string;
  slug: string;
  paused: boolean;
  usage: Usage;
  costUsd: CostBreakdown;
  costInr: number;
  billedInr: number;
  marginInr: number;
  billing: TenantBilling;
  billingSet: boolean;
  voice: Voice | null;
  creditBalanceInr: number;
}

type RateCard = Record<string, number>;

interface Overview {
  from: string;
  to: string;
  rateCard: RateCard;
  rows: Row[];
  totals: { dials: number; aiMinutes: number; humanMinutes: number; costInr: number; billedInr: number; fixedInr: number; marginInr: number };
}

interface TenantDetail {
  tenantId: string;
  name: string;
  paused: boolean;
  dailyDialQuota: number;
  voice: Voice | null;
  users: number;
}

const RANGES = [
  { key: 'month', label: 'This month' },
  { key: '30d', label: 'Last 30 days' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'today', label: 'Today' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

function rangeQuery(range: RangeKey): string {
  const to = new Date();
  const from = new Date();
  if (range === 'month') from.setDate(1);
  if (range === '30d') from.setDate(from.getDate() - 30);
  if (range === '7d') from.setDate(from.getDate() - 7);
  if (range !== '30d' && range !== '7d') from.setHours(0, 0, 0, 0);
  return `from=${from.toISOString()}&to=${to.toISOString()}`;
}

const inr = (n: number, digits = 0) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const mins = (s: number) => (s / 60).toLocaleString('en-IN', { maximumFractionDigits: 1 });

const COST_LABELS: Array<[keyof CostBreakdown, string]> = [
  ['tts', 'Voice (TTS)'],
  ['aiAgent', 'LiveKit AI agent'],
  ['stt', 'Speech-to-text'],
  ['llm', 'Language model'],
  ['phoneLine', 'LiveKit phone line'],
  ['recording', 'Recording'],
  ['agentBrowser', 'Agent browser'],
  ['carrier', 'Carrier'],
];

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

const VOICE_PROVIDERS: Array<[Voice['provider'], string, string]> = [
  ['elevenlabs', 'ElevenLabs Flash', 'Voice id from ElevenLabs, e.g. EXAVITQu4vr4xnSDxMaL'],
  ['cartesia', 'Cartesia Sonic', 'Cartesia voice id (needs CARTESIA_API_KEY on the worker)'],
  ['deepgram', 'Deepgram Aura', 'Aura model, e.g. aura-2-luna-en'],
];

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (Array.isArray(detail)) return detail.join(', ');
  return typeof detail === 'string' ? detail : fallback;
}

export default function PlatformPage() {
  const [range, setRange] = useState<RangeKey>('month');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Overview>(`/platform/overview?${rangeQuery(range)}`);
      setData(r.data);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Could not load platform data.'));
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const row = data?.rows.find((r) => r.tenantId === selected) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Platform</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Usage, cost and billing for every client. Costs are estimates from the rate card below.
          </p>
        </div>
        <select className="input max-w-[11rem]" value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
          {RANGES.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            <Stat label="Dials" value={data.totals.dials.toLocaleString('en-IN')} />
            <Stat label="AI minutes" value={data.totals.aiMinutes.toLocaleString('en-IN', { maximumFractionDigits: 1 })} />
            <Stat label="Agent minutes" value={data.totals.humanMinutes.toLocaleString('en-IN', { maximumFractionDigits: 1 })} />
            <Stat label="Usage cost" value={inr(data.totals.costInr)} />
            <Stat label="Billed (usage)" value={inr(data.totals.billedInr)} />
            <Stat
              label="Margin after fixed"
              value={inr(data.totals.marginInr)}
              hint={`Fixed ${inr(data.totals.fixedInr)} for this period`}
              tone={data.totals.marginInr >= 0 ? 'good' : 'bad'}
            />
          </div>

          <section className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-3 py-3 text-right">Dials</th>
                  <th className="px-3 py-3 text-right">Answered</th>
                  <th className="px-3 py-3 text-right">Voicemail</th>
                  <th className="px-3 py-3 text-right">Transfers</th>
                  <th className="px-3 py-3 text-right">AI min</th>
                  <th className="px-3 py-3 text-right">Agent min</th>
                  <th className="px-3 py-3 text-right">Cost</th>
                  <th className="px-3 py-3 text-right">Billed</th>
                  <th className="px-3 py-3 text-right">Margin</th>
                  <th className="px-3 py-3 text-right">Advance left</th>
                  <th className="px-4 py-3">Voice</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={r.tenantId}
                    className="cursor-pointer border-t"
                    style={{
                      borderColor: 'var(--border)',
                      background: r.tenantId === selected ? 'var(--surface-2)' : undefined,
                    }}
                    onClick={() => setSelected(r.tenantId === selected ? null : r.tenantId)}
                  >
                    <td className="px-4 py-3">
                      <span className="font-semibold">{r.name}</span>
                      {r.paused && (
                        <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: 'var(--bad)', color: '#0b1220' }}>
                          Paused
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.usage.dials.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.usage.answered.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.usage.voicemail.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.usage.transfers.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{mins(r.usage.aiSeconds)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{mins(r.usage.humanSeconds)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{inr(r.costInr)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{inr(r.billedInr)}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums" style={{ color: r.marginInr >= 0 ? 'var(--good)' : 'var(--bad)' }}>
                      {inr(r.marginInr)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{inr(r.creditBalanceInr)}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-dim)' }}>
                      {r.voice ? r.voice.provider : 'default'}
                    </td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-4 py-6 text-center" style={{ color: 'var(--text-dim)' }}>No clients yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          {row && <TenantTabs key={row.tenantId} row={row} inrPerUsd={data.rateCard.inrPerUsd ?? 98} onSaved={load} />}

          <RateCardEditor rateCard={data.rateCard} onSaved={load} />
          <SellerEditor />
        </>
      )}
    </div>
  );
}

function TenantTabs({ row, inrPerUsd, onSaved }: { row: Row; inrPerUsd: number; onSaved: () => Promise<void> }) {
  const [tab, setTab] = useState<'billing' | 'cost'>('billing');
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="mr-3 text-lg font-bold">{row.name}</h2>
        {(['billing', 'cost'] as const).map((t) => (
          <button
            key={t}
            className="btn text-sm"
            onClick={() => setTab(t)}
            style={
              tab === t
                ? { background: 'var(--accent)', color: '#0b1220' }
                : { background: 'var(--surface-2)', border: '1px solid var(--border)' }
            }
          >
            {t === 'billing' ? 'Billing & invoices' : 'Our cost & settings'}
          </button>
        ))}
      </div>
      {tab === 'billing' ? (
        <TenantBillingAdmin tenantId={row.tenantId} onChanged={() => void onSaved()} />
      ) : (
        <TenantPanel row={row} inrPerUsd={inrPerUsd} onSaved={onSaved} />
      )}
    </section>
  );
}

function SellerEditor() {
  const [seller, setSeller] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  useEffect(() => {
    void api.get<Record<string, string>>('/platform/seller').then((r) => setSeller(r.data));
  }, []);
  const field = (key: string, label: string, area = false) => (
    <label key={key} className="block text-xs" style={{ color: 'var(--text-dim)' }}>
      {label}
      {area ? (
        <textarea className="input mt-1 h-16" value={seller[key] ?? ''} onChange={(e) => setSeller({ ...seller, [key]: e.target.value })} />
      ) : (
        <input className="input mt-1" value={seller[key] ?? ''} onChange={(e) => setSeller({ ...seller, [key]: e.target.value })} />
      )}
    </label>
  );
  return (
    <details className="card p-5">
      <summary className="cursor-pointer select-none font-semibold">Invoice sender details (CoCally)</summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {field('name', 'Company name')}
        {field('gstin', 'GSTIN')}
        {field('email', 'Email')}
        {field('phone', 'Phone')}
        {field('address', 'Address', true)}
        {field('paymentDetails', 'Payment details (bank, IFSC, UPI)', true)}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          className="btn btn-primary"
          onClick={() =>
            void api
              .put('/platform/seller', seller)
              .then(() => setNote('Saved. New drafts use these details.'))
              .catch((err) => setNote(errorMessage(err, 'Could not save.')))
          }
        >
          Save sender details
        </button>
        {note && <span className="text-sm" style={{ color: 'var(--text-dim)' }}>{note}</span>}
      </div>
    </details>
  );
}

function TenantPanel({ row, inrPerUsd, onSaved }: { row: Row; inrPerUsd: number; onSaved: () => Promise<void> }) {
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [voiceProvider, setVoiceProvider] = useState<'' | Voice['provider']>('');
  const [voiceId, setVoiceId] = useState('');
  const [quota, setQuota] = useState(0);
  const [paused, setPaused] = useState(row.paused);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    void api.get<TenantDetail>(`/platform/tenants/${row.tenantId}`).then((r) => {
      setDetail(r.data);
      setVoiceProvider(r.data.voice?.provider ?? '');
      setVoiceId(r.data.voice?.voiceId ?? '');
      setQuota(r.data.dailyDialQuota);
      setPaused(r.data.paused);
    });
  }, [row.tenantId]);

  async function save() {
    setBusy(true);
    setNote('');
    try {
      await api.patch(`/platform/tenants/${row.tenantId}`, {
        voice: voiceProvider ? { provider: voiceProvider, voiceId: voiceId.trim() || undefined } : null,
        paused,
        dailyDialQuota: quota,
      });
      setNote('Saved. Voice changes apply from the next call.');
      await onSaved();
    } catch (err) {
      setNote(errorMessage(err, 'Could not save.'));
    } finally {
      setBusy(false);
    }
  }

  const aiMin = row.usage.aiSeconds / 60;
  const aiCostPerMin = aiMin > 0 ? ((row.costUsd.aiAgent + row.costUsd.stt + row.costUsd.llm + row.costUsd.tts) * inrPerUsd) / aiMin : null;
  const hint = VOICE_PROVIDERS.find(([p]) => p === voiceProvider)?.[2] ?? 'Uses the worker default (TTS_PROVIDER / TTS_VOICE)';

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <div className="card p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-semibold">{row.name} — cost breakdown</h2>
          {aiCostPerMin !== null && (
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
              AI minute ≈ <span className="font-semibold" style={{ color: 'var(--text)' }}>{inr(aiCostPerMin, 2)}</span>
            </span>
          )}
        </div>
        <ul className="space-y-1.5 text-sm">
          {COST_LABELS.map(([key, label]) => (
            <li key={key} className="flex justify-between">
              <span style={{ color: 'var(--text-dim)' }}>{label}</span>
              <span className="tabular-nums">{inr(row.costUsd[key] * inrPerUsd, 2)}</span>
            </li>
          ))}
          <li className="flex justify-between border-t pt-2 font-semibold" style={{ borderColor: 'var(--border)' }}>
            <span>Total</span>
            <span className="tabular-nums">{inr(row.costInr, 2)}</span>
          </li>
        </ul>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-dim)' }}>
          <dt>Ringing</dt><dd className="text-right tabular-nums">{mins(row.usage.ringSeconds)} min</dd>
          <dt>Recorded</dt><dd className="text-right tabular-nums">{mins(row.usage.recordedSeconds)} min</dd>
          <dt>AI speech</dt><dd className="text-right tabular-nums">{row.usage.ttsChars.toLocaleString('en-IN')} chars</dd>
          <dt>Manual dials</dt><dd className="text-right tabular-nums">{row.usage.manualDials.toLocaleString('en-IN')}</dd>
          {detail && (<><dt>Active users</dt><dd className="text-right tabular-nums">{detail.users}</dd></>)}
        </dl>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="font-semibold">Settings (CoCally only)</h2>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>AI voice</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="input" value={voiceProvider} onChange={(e) => setVoiceProvider(e.target.value as '' | Voice['provider'])}>
              <option value="">Default</option>
              {VOICE_PROVIDERS.map(([p, label]) => (
                <option key={p} value={p}>{label}</option>
              ))}
            </select>
            <input
              className="input"
              placeholder="Voice id (blank = provider default)"
              value={voiceId}
              disabled={!voiceProvider}
              onChange={(e) => setVoiceId(e.target.value)}
            />
          </div>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{hint}</p>
        </fieldset>

        <fieldset className="grid gap-2 sm:grid-cols-2">
          <NumberField label="Daily dial quota (0 = unlimited)" value={quota} step={100} onChange={(v) => setQuota(Math.max(0, Math.round(v)))} />
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
            <span style={{ color: paused ? 'var(--bad)' : undefined }}>Pause all dialling</span>
          </label>
        </fieldset>

        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={busy || !detail} onClick={() => void save()}>Save</button>
          {note && <span className="text-sm" style={{ color: 'var(--text-dim)' }}>{note}</span>}
        </div>
      </div>
    </section>
  );
}

function RateCardEditor({ rateCard, onSaved }: { rateCard: RateCard; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<RateCard>(rateCard);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => setDraft(rateCard), [rateCard]);

  async function save() {
    setBusy(true);
    setNote('');
    try {
      await api.put('/platform/rate-card', draft);
      setNote('Saved.');
      await onSaved();
    } catch (err) {
      setNote(errorMessage(err, 'Could not save.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card p-5">
      <summary className="cursor-pointer select-none font-semibold">Rate card (what each provider costs us)</summary>
      <p className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
        US dollars, from published price lists. Check against the LiveKit, ElevenLabs, Deepgram and Cerebras invoices each month.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {RATE_FIELDS.map(([key, label]) => (
          <NumberField key={key} label={label} value={draft[key] ?? 0} step={0.0005} onChange={(v) => setDraft({ ...draft, [key]: v })} />
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save rate card</button>
        {note && <span className="text-sm" style={{ color: 'var(--text-dim)' }}>{note}</span>}
      </div>
    </details>
  );
}

function NumberField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="block text-xs" style={{ color: 'var(--text-dim)' }}>
      {label}
      <input
        type="number"
        min={0}
        step={step}
        className="input mt-1"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-2xl font-bold tabular-nums" style={tone ? { color: tone === 'good' ? 'var(--good)' : 'var(--bad)' } : undefined}>
        {value}
      </p>
      {hint && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{hint}</p>}
    </div>
  );
}
