'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface CredentialField {
  key: string;
  label: string;
  type: 'secret' | 'text' | 'url' | 'json';
  required: boolean;
  help?: string;
  placeholder?: string;
}

interface ProviderInfo {
  id: string;
  label: string;
  capability: 'TTS' | 'STT' | 'LLM';
  unitCost: { amountCentsPer: number; unit: string };
  credentialSchema: CredentialField[];
  models?: string[];
  languages?: string[];
  params?: Array<{ key: string; label: string; type: string; default: number | string; min?: number; max?: number; step?: number }>;
  configured: boolean;
}

interface ChainEntry {
  providerId: string;
  model?: string;
}

interface Registry {
  tts: ProviderInfo[];
  stt: ProviderInfo[];
  llm: ProviderInfo[];
  chains: {
    TTS: ChainEntry[];
    STT: ChainEntry[];
    LLM: { CONVERSATION: ChainEntry[]; SUMMARY: ChainEntry[]; SCORING: ChainEntry[] };
  };
}

const LLM_ROLES = ['CONVERSATION', 'SUMMARY', 'SCORING'] as const;

export default function ProvidersPage() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [credDraft, setCredDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [llmRole, setLlmRole] = useState<(typeof LLM_ROLES)[number]>('CONVERSATION');

  const load = useCallback(async () => {
    const { data } = await api.get('/providers');
    setRegistry(data);
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  function flash(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(''), 3500);
  }

  async function saveCredentials(provider: ProviderInfo) {
    await api.post('/providers/secrets', { providerId: provider.id, credentials: credDraft });
    setOpenProvider(null);
    setCredDraft({});
    flash(`Credentials saved for ${provider.label} (encrypted in the vault; never shown again).`);
    await load();
  }

  async function moveChainEntry(
    capability: 'TTS' | 'STT' | 'LLM',
    chain: ChainEntry[],
    index: number,
    direction: -1 | 1,
  ) {
    const next = [...chain];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const a = next[index]!;
    next[index] = next[target]!;
    next[target] = a;
    await api.put('/providers/chains', {
      capability,
      ...(capability === 'LLM' ? { llmRole } : {}),
      chain: next,
    });
    flash(`${capability} fallback order updated.`);
    await load();
  }

  async function setChainModel(capability: 'LLM', chain: ChainEntry[], index: number, model: string) {
    const next = chain.map((entry, i) => (i === index ? { ...entry, model: model || undefined } : entry));
    await api.put('/providers/chains', { capability, llmRole, chain: next });
    flash('Model updated for chain entry.');
    await load();
  }

  if (!registry) return <p style={{ color: 'var(--text-dim)' }}>Loading…</p>;

  const sections: Array<{ capability: 'TTS' | 'STT' | 'LLM'; title: string; providers: ProviderInfo[]; chain: ChainEntry[] }> = [
    { capability: 'TTS', title: 'Text-to-speech', providers: registry.tts, chain: registry.chains.TTS },
    { capability: 'STT', title: 'Speech-to-text', providers: registry.stt, chain: registry.chains.STT },
    { capability: 'LLM', title: `LLM — ${llmRole.toLowerCase()} role`, providers: registry.llm, chain: registry.chains.LLM[llmRole] },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Provider abstraction layer</h1>
        {message && <p className="text-sm" style={{ color: 'var(--good)' }}>{message}</p>}
      </div>
      <p className="max-w-3xl text-sm" style={{ color: 'var(--text-dim)' }}>
        Each capability runs through an ordered <b>fallback chain</b>: the first healthy configured provider serves the
        call; on failure the next takes over automatically mid-campaign (PAL-05). Credentials differ per provider —
        each form below shows exactly what that provider needs — and are AES-256-GCM encrypted per tenant (PAL-12).
        The LLM has three independently configurable roles: conversation, summary, and scoring (PAL-03).
      </p>

      {sections.map((section) => (
        <section key={section.capability} className="card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            {section.capability === 'LLM' && (
              <div className="flex gap-1">
                {LLM_ROLES.map((role) => (
                  <button
                    key={role}
                    onClick={() => setLlmRole(role)}
                    className="rounded-full px-3 py-1 text-xs font-semibold"
                    style={
                      llmRole === role
                        ? { background: 'var(--accent)', color: '#0b1220' }
                        : { background: 'var(--surface-2)', color: 'var(--text-dim)' }
                    }
                  >
                    {role.toLowerCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mb-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
              Active fallback chain (first = primary)
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {section.chain.map((entry, index) => {
                const info = section.providers.find((p) => p.id === entry.providerId);
                return (
                  <div key={`${entry.providerId}-${index}`} className="flex items-center gap-1 rounded-lg px-3 py-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                    <span className="text-xs font-bold" style={{ color: 'var(--accent)' }}>{index + 1}</span>
                    <span className="text-sm">{info?.label ?? entry.providerId}</span>
                    {section.capability === 'LLM' && info?.models && info.models.length > 0 && (
                      <select
                        className="ml-1 rounded border-0 bg-transparent text-xs"
                        style={{ color: 'var(--text-dim)' }}
                        value={entry.model ?? ''}
                        onChange={(e) => setChainModel('LLM', section.chain, index, e.target.value)}
                      >
                        <option value="">{info.models[0]} (default)</option>
                        {info.models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    )}
                    {!info?.configured && !entry.providerId.startsWith('sim-') && (
                      <span className="ml-1 text-xs" style={{ color: 'var(--bad)' }} title="No credentials — this hop will be skipped">
                        ⚠ no creds
                      </span>
                    )}
                    <span className="ml-1 flex flex-col">
                      <button className="text-xs leading-none" style={{ color: 'var(--text-dim)' }} onClick={() => moveChainEntry(section.capability, section.chain, index, -1)}>▲</button>
                      <button className="text-xs leading-none" style={{ color: 'var(--text-dim)' }} onClick={() => moveChainEntry(section.capability, section.chain, index, 1)}>▼</button>
                    </span>
                    {index < section.chain.length - 1 && <span style={{ color: 'var(--text-dim)' }}>→</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
            Providers
          </p>
          <div className="space-y-2">
            {section.providers.map((provider) => (
              <div key={provider.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{provider.label}</span>
                    {provider.configured ? (
                      <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: 'var(--good)', color: '#0b1220' }}>
                        configured
                      </span>
                    ) : provider.credentialSchema.length > 0 ? (
                      <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
                        needs credentials
                      </span>
                    ) : null}
                    {provider.models && provider.models.length > 0 && (
                      <span className="text-xs" style={{ color: 'var(--text-dim)' }}>models: {provider.models.join(', ')}</span>
                    )}
                    {provider.languages && (
                      <span className="text-xs" style={{ color: 'var(--text-dim)' }}>langs: {provider.languages.join(', ')}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                      {provider.unitCost.amountCentsPer === 0 ? 'free' : `${provider.unitCost.amountCentsPer}¢ / ${provider.unitCost.unit.replace('_', ' ')}`}
                    </span>
                    {provider.credentialSchema.length > 0 && (
                      <button
                        className="btn btn-ghost text-xs"
                        onClick={() => {
                          setOpenProvider(openProvider === provider.id ? null : provider.id);
                          setCredDraft({});
                        }}
                      >
                        {openProvider === provider.id ? 'Close' : provider.configured ? 'Rotate credentials' : 'Configure'}
                      </button>
                    )}
                  </div>
                </div>

                {openProvider === provider.id && (
                  <form
                    className="mt-3 space-y-3 border-t pt-3"
                    style={{ borderColor: 'var(--border)' }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveCredentials(provider);
                    }}
                  >
                    {provider.credentialSchema.map((field) => (
                      <div key={field.key}>
                        <label className="mb-1 block text-sm">
                          {field.label}
                          {field.required && <span style={{ color: 'var(--bad)' }}> *</span>}
                        </label>
                        {field.type === 'json' ? (
                          <textarea
                            className="input h-28 font-mono text-xs"
                            placeholder={field.placeholder}
                            required={field.required}
                            value={credDraft[field.key] ?? ''}
                            onChange={(e) => setCredDraft({ ...credDraft, [field.key]: e.target.value })}
                          />
                        ) : (
                          <input
                            className="input"
                            type={field.type === 'secret' ? 'password' : 'text'}
                            placeholder={field.placeholder}
                            required={field.required}
                            value={credDraft[field.key] ?? ''}
                            onChange={(e) => setCredDraft({ ...credDraft, [field.key]: e.target.value })}
                          />
                        )}
                        {field.help && (
                          <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>{field.help}</p>
                        )}
                      </div>
                    ))}
                    {provider.params && provider.params.length > 0 && (
                      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                        Voice/params ({provider.params.map((p) => p.label).join(', ')}) are set per campaign in the
                        campaign's provider overrides.
                      </p>
                    )}
                    <button className="btn btn-primary text-sm">Save to vault</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
