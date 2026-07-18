'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface FlowVersionMeta {
  _id: string;
  version: number;
  state: string;
}

interface Flow {
  _id: string;
  name: string;
  direction: string;
  versions: FlowVersionMeta[];
}

interface SimResult {
  outcome: { kind: string; endOutcome?: string };
  transcript: Array<{ speaker: string; text: string }>;
  scoreHistory: Array<{ score: number; reason: string }>;
  complianceEvents: Array<{ kind: string; detail: string }>;
  summary: string;
}

export default function FlowsPage() {
  const router = useRouter();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [genName, setGenName] = useState('');
  const [genDescription, setGenDescription] = useState('');
  const [voicemailStep, setVoicemailStep] = useState(true);
  const [ivrKeypressStep, setIvrKeypressStep] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<string>('');
  const [replies, setReplies] = useState('Hello?\nYes I own my house\nAbout 600 a quarter\nYes sure\nYes');
  const [persona, setPersona] = useState('');
  const [result, setResult] = useState<SimResult | null>(null);
  const [running, setRunning] = useState(false);
  const [newFlowName, setNewFlowName] = useState('');

  async function load() {
    const { data } = await api.get('/flows');
    setFlows(data);
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  async function createFlow(e: React.FormEvent) {
    e.preventDefault();
    await api.post('/flows', { name: newFlowName });
    setNewFlowName('');
    await load();
  }

  async function simulate() {
    if (!selectedVersion) return;
    setRunning(true);
    setResult(null);
    try {
      const body = persona.trim()
        ? { personaPrompt: persona.trim() }
        : { scriptedReplies: replies.split('\n').map((r) => r.trim()).filter(Boolean) };
      const { data } = await api.post(`/flows/versions/${selectedVersion}/simulate`, body);
      setResult(data);
    } finally {
      setRunning(false);
    }
  }

  async function generateFlow(e: React.FormEvent) {
    e.preventDefault();
    setGenerating(true);
    setGenError('');
    try {
      const { data } = await api.post('/flows/generate', {
        name: genName,
        description: genDescription,
        voicemailStep,
        ivrKeypressStep,
      });
      router.push(`/flows/${data.flowId}`);
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setGenError(typeof detail === 'string' ? detail : 'Generation failed');
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Call flows</h1>

      <form onSubmit={generateFlow} className="card space-y-3 p-6" style={{ border: '1px solid var(--accent-dim)' }}>
        <h2 className="font-semibold">
          <span style={{ color: 'var(--accent)' }}>✨ Generate a flow from a prompt</span>
        </h2>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Describe the campaign in plain language — who you're calling, what to qualify, what counts as a win. A
          complete editable workflow is generated (nodes, prompts, responses) and saved as a draft.
        </p>
        <div className="flex gap-3">
          <input
            className="input flex-1"
            placeholder="Flow name, e.g. NSW Battery Rebate Qualification"
            value={genName}
            onChange={(e) => setGenName(e.target.value)}
            required
          />
        </div>
        <textarea
          className="input h-28"
          placeholder="e.g. We're calling NSW homeowners about the new battery rebate. Qualify: do they own the home, do they already have solar panels, average quarterly bill, and interest in a free assessment. Book a visit from a specialist if they're keen."
          value={genDescription}
          onChange={(e) => setGenDescription(e.target.value)}
          required
          minLength={30}
        />
        <div className="flex flex-wrap items-center gap-5 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={voicemailStep} onChange={(e) => setVoicemailStep(e.target.checked)} />
            Default step: voicemail drop message
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={ivrKeypressStep} onChange={(e) => setIvrKeypressStep(e.target.checked)} />
            Default step: IVR "press 1" keypress + re-check
          </label>
        </div>
        {genError && <p className="text-sm" style={{ color: 'var(--bad)' }}>{genError}</p>}
        <button className="btn btn-primary" disabled={generating}>
          {generating ? 'Generating…' : 'Generate workflow'}
        </button>
      </form>

      <form onSubmit={createFlow} className="card flex items-end gap-3 p-4">
        <div className="flex-1">
          <label className="mb-1 block text-sm">Or create a blank flow</label>
          <input className="input" value={newFlowName} onChange={(e) => setNewFlowName(e.target.value)} required />
        </div>
        <button className="btn btn-ghost">Create flow</button>
      </form>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-6">
          <h2 className="mb-4 font-semibold">Flows &amp; versions</h2>
          {flows.map((flow) => (
            <div key={flow._id} className="mb-4">
              <p className="font-medium">
                {flow.name}{' '}
                <a href={`/flows/${flow._id}`} className="text-xs" style={{ color: 'var(--accent)' }}>
                  open editor →
                </a>
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                {flow.versions.length === 0 && (
                  <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    no versions yet
                  </span>
                )}
                {flow.versions.map((version) => (
                  <button
                    key={version._id}
                    onClick={() => setSelectedVersion(version._id)}
                    className="rounded-full px-3 py-1 text-xs font-semibold"
                    style={
                      selectedVersion === version._id
                        ? { background: 'var(--accent)', color: '#0b1220' }
                        : {
                            background: 'var(--surface-2)',
                            color: version.state === 'PUBLISHED' ? 'var(--good)' : 'var(--text-dim)',
                            border: '1px solid var(--border)',
                          }
                    }
                  >
                    v{version.version} · {version.state}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="card p-6">
          <h2 className="mb-4 font-semibold">Simulator</h2>
          <p className="mb-3 text-xs" style={{ color: 'var(--text-dim)' }}>
            Test-drive the selected version against a fake customer before any real dial (FLOW-05).
          </p>
          <label className="mb-1 block text-sm">Scripted customer replies (one per line)</label>
          <textarea className="input mb-3 h-28" value={replies} onChange={(e) => setReplies(e.target.value)} />
          <label className="mb-1 block text-sm">…or persona prompt (overrides script)</label>
          <input
            className="input mb-3"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="e.g. You are a hostile customer who was called yesterday already"
          />
          <button className="btn btn-primary" onClick={simulate} disabled={!selectedVersion || running}>
            {running ? 'Running…' : 'Run simulation'}
          </button>

          {result && (
            <div className="mt-4 space-y-3 text-sm">
              <p>
                <span className="font-semibold">Outcome:</span> {result.outcome.kind}
                {result.outcome.endOutcome ? ` (${result.outcome.endOutcome})` : ''}
              </p>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                {result.transcript.map((line, i) => (
                  <p key={i}>
                    <span style={{ color: line.speaker === 'ai' ? 'var(--accent)' : 'var(--text-dim)' }}>
                      {line.speaker}:
                    </span>{' '}
                    {line.text}
                  </p>
                ))}
              </div>
              {result.summary && (
                <p>
                  <span className="font-semibold">Summary:</span> {result.summary}
                </p>
              )}
              <p style={{ color: 'var(--text-dim)' }}>
                Compliance: {result.complianceEvents.map((e) => e.kind).join(', ') || 'none'} · Score:{' '}
                {result.scoreHistory.at(-1)?.score ?? 0}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
