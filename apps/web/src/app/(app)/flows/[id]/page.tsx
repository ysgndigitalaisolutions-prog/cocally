'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface FlowNode {
  id: string;
  type: string;
  label?: string;
  mandatory?: boolean;
  config: Record<string, unknown>;
  providerOverrides?: { tts?: string; stt?: string; llm?: string };
}

interface FlowEdge {
  id: string;
  from: string;
  to: string;
  priority?: number;
  conditions: Array<{ variable: string; operator: string; value?: unknown }>;
}

interface FlowGraph {
  entryNodeId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface FlowVersionMeta {
  _id: string;
  version: number;
  state: string;
}

interface PromptPreview {
  systemPrompt: string;
  messageAssembly: Array<{ role: string; content: string }>;
  notes: string[];
}

interface SimEvent {
  seq: number;
  kind: 'ai' | 'customer' | 'system';
  text: string;
}

interface TestDriveSnapshot {
  sessionId: string;
  events: SimEvent[];
  state: {
    score: number;
    facts: Record<string, unknown>;
    objections: Array<{ label: string; recovered: boolean }>;
    stage: string;
    summary: string;
    compliance: Array<{ kind: string; detail: string }>;
  };
  done: boolean;
  outcome: { kind: string; endOutcome?: string } | null;
}

/** Starter graph for a freshly created flow with no versions yet. */
const STARTER_GRAPH: FlowGraph = {
  entryNodeId: 'amd',
  nodes: [
    { id: 'amd', type: 'AMD_CLASSIFY', mandatory: false, config: {} },
    {
      id: 'disclosure',
      type: 'SPEAK',
      mandatory: true,
      config: {
        text: "Hi {{firstName}}, I'm an AI assistant calling on behalf of {{clientName}}. This call may be recorded for quality purposes.",
        interruptible: false,
      },
    },
    {
      id: 'qualify',
      type: 'AI_CONVERSATION',
      mandatory: false,
      config: {
        prompt:
          'You are a warm, natural outbound assistant. Describe your goal, what to qualify, and your tone here — one question at a time, brief, never pushy.',
        exitIntents: ['qualified', 'callback', 'not_interested', 'silence', 'max_turns'],
        captureVariables: ['owner', 'billHigh', 'appointmentInterest'],
        maxTurns: 16,
      },
    },
    {
      id: 'transfer',
      type: 'TRANSFER',
      mandatory: false,
      config: { strategy: 'LONGEST_IDLE', whisperEnabled: false, acceptWindowSeconds: 13 },
    },
    {
      id: 'fallback',
      type: 'SPEAK',
      mandatory: false,
      config: { text: 'All of our specialists are busy right now — we will call you back shortly to lock in a time. Thanks {{firstName}}!', interruptible: false },
    },
    { id: 'end-qualified', type: 'END', mandatory: false, config: { outcome: 'QUALIFIED' } },
    { id: 'end-nurture', type: 'END', mandatory: false, config: { outcome: 'NURTURE' } },
    { id: 'end', type: 'END', mandatory: false, config: { outcome: 'COMPLETE' } },
  ],
  edges: [
    { id: 'e1', from: 'amd', to: 'disclosure', conditions: [{ variable: 'amd.class', operator: 'eq', value: 'HUMAN' }], priority: 0 },
    { id: 'e2', from: 'amd', to: 'end', conditions: [], priority: 10 },
    { id: 'e3', from: 'disclosure', to: 'qualify', conditions: [], priority: 0 },
    { id: 'e4', from: 'qualify', to: 'transfer', conditions: [{ variable: 'intent', operator: 'eq', value: 'qualified' }], priority: 0 },
    { id: 'e5', from: 'qualify', to: 'end-nurture', conditions: [{ variable: 'intent', operator: 'eq', value: 'not_interested' }], priority: 1 },
    { id: 'e6', from: 'qualify', to: 'end', conditions: [], priority: 10 },
    { id: 'e7', from: 'transfer', to: 'fallback', conditions: [], priority: 0 },
    { id: 'e8', from: 'fallback', to: 'end-qualified', conditions: [], priority: 0 },
  ],
};

export default function FlowEditorPage() {
  const params = useParams<{ id: string }>();
  const [versions, setVersions] = useState<FlowVersionMeta[]>([]);
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [loadedFrom, setLoadedFrom] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [issues, setIssues] = useState<Array<{ severity: string; code: string; message: string }>>([]);
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const { data: versionList } = await api.get<FlowVersionMeta[]>(`/flows/${params.id}/versions`);
    setVersions(versionList);
    // Edit the draft if one exists, otherwise start from the newest version's
    // graph; a brand-new flow with no versions starts from the template.
    const draft = versionList.find((v) => v.state === 'DRAFT');
    const source = draft ?? versionList[0];
    if (source) {
      const { data: full } = await api.get(`/flows/versions/${source._id}`);
      setGraph(full.graph);
      setLoadedFrom(`v${source.version} (${source.state.toLowerCase()})`);
    } else {
      setGraph(structuredClone(STARTER_GRAPH));
      setLoadedFrom('starter template (unsaved — edit the AI prompt, then Save draft)');
      setDirty(true);
    }
  }, [params.id]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  function flash(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(''), 3500);
  }

  function updateNode(nodeId: string, patch: Partial<FlowNode> | { config: Record<string, unknown> }) {
    if (!graph) return;
    setGraph({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, ...patch, config: { ...n.config, ...('config' in patch ? patch.config : {}) } }
          : n,
      ),
    });
    setDirty(true);
  }

  async function saveDraft() {
    if (!graph) return;
    const { data } = await api.post(`/flows/${params.id}/draft`, { graph });
    setDirty(false);
    flash(`Draft v${data.version} saved.`);
    await load();
  }

  async function validate() {
    if (!graph) return;
    const { data } = await api.post('/flows/validate', { graph });
    setIssues(data.issues ?? []);
    flash(data.valid ? 'Graph is valid.' : 'Validation found errors — see below.');
  }

  async function publish() {
    try {
      const { data } = await api.post(`/flows/${params.id}/publish`, {});
      flash(`Published v${data.version}. Assign it to a campaign to go live.`);
      await load();
    } catch (err) {
      const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
      flash(typeof detail?.message === 'string' ? detail.message : 'Publish failed — save a draft first?');
    }
  }

  async function loadPreview(node: FlowNode) {
    const { data } = await api.post('/flows/prompt-preview', {
      prompt: String(node.config.prompt ?? ''),
      facts: { owner: true, billHigh: true },
    });
    setPreview(data);
  }

  const selectedNode = graph?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  // ── Interactive test-drive state ────────────────────────────────────────
  const [rightTab, setRightTab] = useState<'testdrive' | 'preview'>('testdrive');
  const [drive, setDrive] = useState<TestDriveSnapshot | null>(null);
  const [driveInput, setDriveInput] = useState('');
  const [driveBusy, setDriveBusy] = useState(false);

  async function startTestDrive() {
    // Test-drive runs a saved version; auto-save the draft first if dirty.
    setDriveBusy(true);
    try {
      if (dirty && graph) {
        await api.post(`/flows/${params.id}/draft`, { graph });
        setDirty(false);
      }
      const { data: versionList } = await api.get<FlowVersionMeta[]>(`/flows/${params.id}/versions`);
      setVersions(versionList);
      const target = versionList.find((v) => v.state === 'DRAFT') ?? versionList[0];
      if (!target) return;
      const { data } = await api.post(`/flows/versions/${target._id}/test-drive`, {});
      setDrive(data);
    } finally {
      setDriveBusy(false);
    }
  }

  async function sendDriveReply(e: React.FormEvent) {
    e.preventDefault();
    if (!drive || !driveInput.trim()) return;
    const text = driveInput.trim();
    setDriveInput('');
    setDriveBusy(true);
    try {
      const { data } = await api.post(`/flows/test-drive/${drive.sessionId}/reply`, { text });
      setDrive(data);
    } finally {
      setDriveBusy(false);
    }
  }

  async function endTestDrive() {
    if (drive && !drive.done) await api.post(`/flows/test-drive/${drive.sessionId}/end`).catch(() => undefined);
    setDrive(null);
  }

  if (!graph) return <p style={{ color: 'var(--text-dim)' }}>Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Flow editor</h1>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            Editing from {loadedFrom} · versions: {versions.map((v) => `v${v.version} ${v.state.toLowerCase()}`).join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {message && <span className="text-sm" style={{ color: 'var(--good)' }}>{message}</span>}
          <button className="btn btn-ghost text-sm" onClick={validate}>Validate</button>
          <button className="btn btn-ghost text-sm" onClick={saveDraft} disabled={!dirty}>
            {dirty ? 'Save draft *' : 'Draft saved'}
          </button>
          <button className="btn btn-primary text-sm" onClick={publish}>Publish</button>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="card p-4 text-sm">
          {issues.map((issue, i) => (
            <p key={i} style={{ color: issue.severity === 'error' ? 'var(--bad)' : 'var(--accent)' }}>
              [{issue.severity}] {issue.code}: {issue.message}
            </p>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Node list + edges */}
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Nodes</h2>
          <div className="space-y-1">
            {graph.nodes.map((node) => (
              <button
                key={node.id}
                onClick={() => {
                  setSelectedNodeId(node.id);
                  setPreview(null);
                }}
                className="block w-full rounded-lg px-3 py-2 text-left text-sm"
                style={
                  selectedNodeId === node.id
                    ? { background: 'var(--surface-2)', border: '1px solid var(--accent)' }
                    : { border: '1px solid var(--border)' }
                }
              >
                <span className="font-mono text-xs" style={{ color: 'var(--accent)' }}>{node.type}</span>
                {node.mandatory && <span className="ml-1 text-xs" style={{ color: 'var(--good)' }}>· mandatory</span>}
                <br />
                <span>{node.label ?? node.id}</span>
                {graph.entryNodeId === node.id && (
                  <span className="ml-1 text-xs" style={{ color: 'var(--text-dim)' }}>(entry)</span>
                )}
              </button>
            ))}
          </div>
          <h2 className="mb-2 mt-5 font-semibold">Edges</h2>
          <div className="space-y-1 text-xs" style={{ color: 'var(--text-dim)' }}>
            {graph.edges.map((edge) => (
              <p key={edge.id}>
                {edge.from} → {edge.to}
                {edge.conditions.length > 0 && (
                  <span> when {edge.conditions.map((c) => `${c.variable} ${c.operator} ${String(c.value ?? '')}`).join(' AND ')}</span>
                )}
              </p>
            ))}
          </div>
        </section>

        {/* Node editor */}
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Node editor</h2>
          {!selectedNode ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>Select a node to edit its configuration.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="font-mono text-xs" style={{ color: 'var(--accent)' }}>
                {selectedNode.type} · {selectedNode.id}
              </p>

              {selectedNode.type === 'SPEAK' && (
                <>
                  <label className="block">Text (supports {'{{variables}}'})</label>
                  <textarea
                    className="input h-28"
                    value={String(selectedNode.config.text ?? '')}
                    onChange={(e) => updateNode(selectedNode.id, { config: { text: e.target.value } })}
                  />
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.mandatory)}
                      onChange={(e) => updateNode(selectedNode.id, { mandatory: e.target.checked })}
                    />
                    Mandatory compliance line (cannot be removed when the country pack requires it — AI-08)
                  </label>
                </>
              )}

              {selectedNode.type === 'AI_CONVERSATION' && (
                <>
                  <label className="block font-semibold">Conversation prompt</label>
                  <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    This is YOUR authored brief for the AI: persona, goal, what to qualify, tone. The engine wraps it
                    with the answered-facts list, the rebuttal playbook, and the JSON reply contract — click
                    "Preview exact prompt" to see the final composed system prompt.
                  </p>
                  <textarea
                    className="input h-48"
                    value={String(selectedNode.config.prompt ?? '')}
                    onChange={(e) => updateNode(selectedNode.id, { config: { prompt: e.target.value } })}
                  />
                  <label className="block">Exit intents (comma-separated — drive the flow's edges)</label>
                  <input
                    className="input"
                    value={(selectedNode.config.exitIntents as string[] | undefined)?.join(', ') ?? ''}
                    onChange={(e) =>
                      updateNode(selectedNode.id, {
                        config: { exitIntents: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) },
                      })
                    }
                  />
                  <label className="block">Capture variables (structured facts per AI-06)</label>
                  <input
                    className="input"
                    value={(selectedNode.config.captureVariables as string[] | undefined)?.join(', ') ?? ''}
                    onChange={(e) =>
                      updateNode(selectedNode.id, {
                        config: { captureVariables: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) },
                      })
                    }
                  />
                  <label className="block">Max turns</label>
                  <input
                    className="input"
                    type="number"
                    value={Number(selectedNode.config.maxTurns ?? 20)}
                    onChange={(e) => updateNode(selectedNode.id, { config: { maxTurns: Number(e.target.value) } })}
                  />
                  <label className="block">LLM override for this node (PAL-04, optional)</label>
                  <select
                    className="input"
                    value={selectedNode.providerOverrides?.llm ?? ''}
                    onChange={(e) =>
                      updateNode(selectedNode.id, {
                        providerOverrides: { ...selectedNode.providerOverrides, llm: e.target.value || undefined },
                      } as Partial<FlowNode>)
                    }
                  >
                    <option value="">campaign default</option>
                    <option value="anthropic">Anthropic Claude</option>
                    <option value="openai">OpenAI GPT</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="self-hosted-llm">Self-hosted</option>
                  </select>
                  <button
                    className="btn btn-ghost text-xs"
                    onClick={() => {
                      setRightTab('preview');
                      void loadPreview(selectedNode);
                    }}
                  >
                    Preview exact prompt →
                  </button>
                </>
              )}

              {selectedNode.type === 'TRANSFER' && (
                <>
                  <label className="block">Routing strategy</label>
                  <select
                    className="input"
                    value={String(selectedNode.config.strategy ?? 'LONGEST_IDLE')}
                    onChange={(e) => updateNode(selectedNode.id, { config: { strategy: e.target.value } })}
                  >
                    {['LONGEST_IDLE', 'ROUND_ROBIN', 'LEAST_TALK_TIME', 'SKILL_PRIORITY', 'STICKY'].map((s) => (
                      <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                  <label className="block">Accept window (seconds)</label>
                  <input
                    className="input"
                    type="number"
                    value={Number(selectedNode.config.acceptWindowSeconds ?? 13)}
                    onChange={(e) => updateNode(selectedNode.id, { config: { acceptWindowSeconds: Number(e.target.value) } })}
                  />
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.config.whisperEnabled)}
                      onChange={(e) => updateNode(selectedNode.id, { config: { whisperEnabled: e.target.checked } })}
                    />
                    TTS whisper in agent's ear before bridge (XFER-05)
                  </label>
                </>
              )}

              {selectedNode.type === 'LISTEN_CAPTURE' && (
                <>
                  <label className="block">Prompt text</label>
                  <textarea
                    className="input h-20"
                    value={String(selectedNode.config.promptText ?? '')}
                    onChange={(e) => updateNode(selectedNode.id, { config: { promptText: e.target.value } })}
                  />
                  <label className="block">Variable name</label>
                  <input
                    className="input"
                    value={String(selectedNode.config.variable ?? '')}
                    onChange={(e) => updateNode(selectedNode.id, { config: { variable: e.target.value } })}
                  />
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.config.confirm)}
                      onChange={(e) => updateNode(selectedNode.id, { config: { confirm: e.target.checked } })}
                    />
                    Read-back confirmation
                  </label>
                </>
              )}

              {selectedNode.type === 'END' && (
                <>
                  <label className="block">Outcome</label>
                  <select
                    className="input"
                    value={String(selectedNode.config.outcome ?? 'COMPLETE')}
                    onChange={(e) => updateNode(selectedNode.id, { config: { outcome: e.target.value } })}
                  >
                    {['COMPLETE', 'QUALIFIED', 'NURTURE', 'RELEASE', 'OPT_OUT', 'VOICEMAIL_DROPPED'].map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </>
              )}

              {(selectedNode.type === 'AMD_CLASSIFY' || selectedNode.type === 'BRANCH') && (
                <p style={{ color: 'var(--text-dim)' }}>
                  This node has no editable settings — routing happens on its outgoing edges (see edge list).
                </p>
              )}
            </div>
          )}
        </section>

        {/* Test-drive / prompt preview */}
        <section className="card p-4">
          <div className="mb-3 flex gap-1">
            <button
              onClick={() => setRightTab('testdrive')}
              className="rounded-full px-3 py-1 text-xs font-semibold"
              style={rightTab === 'testdrive' ? { background: 'var(--accent)', color: '#0b1220' } : { background: 'var(--surface-2)', color: 'var(--text-dim)' }}
            >
              Live test-drive
            </button>
            <button
              onClick={() => setRightTab('preview')}
              className="rounded-full px-3 py-1 text-xs font-semibold"
              style={rightTab === 'preview' ? { background: 'var(--accent)', color: '#0b1220' } : { background: 'var(--surface-2)', color: 'var(--text-dim)' }}
            >
              Prompt preview
            </button>
          </div>

          {rightTab === 'testdrive' && (
            <div className="space-y-3">
              {!drive ? (
                <>
                  <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
                    Play the customer against the <b>real engine</b> — the same executor, prompt composition, scoring
                    and transfer logic as live calls. The AI opens (disclosure first, like a real dial); you type the
                    customer's side turn by turn.
                  </p>
                  <button className="btn btn-primary text-sm" onClick={startTestDrive} disabled={driveBusy}>
                    {driveBusy ? 'Starting…' : '☎ Answer the call'}
                  </button>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span style={{ color: 'var(--text-dim)' }}>
                      stage: {drive.state.stage || '—'} · score{' '}
                      <b style={{ color: drive.state.score >= 70 ? 'var(--good)' : 'var(--text)' }}>{drive.state.score}</b>
                    </span>
                    <button className="btn btn-ghost text-xs" onClick={endTestDrive}>
                      {drive.done ? 'New test-drive' : 'Hang up'}
                    </button>
                  </div>

                  <div className="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                    {drive.events.map((event) =>
                      event.kind === 'system' ? (
                        <p key={event.seq} className="text-center text-xs" style={{ color: 'var(--text-dim)' }}>
                          {event.text}
                        </p>
                      ) : (
                        <div
                          key={event.seq}
                          className="max-w-[85%] rounded-lg px-3 py-2 text-sm"
                          style={
                            event.kind === 'ai'
                              ? { background: 'var(--surface)', border: '1px solid var(--border)', alignSelf: 'flex-start' }
                              : { background: 'var(--accent)', color: '#0b1220', alignSelf: 'flex-end' }
                          }
                        >
                          {event.text}
                        </div>
                      ),
                    )}
                    {drive.done && (
                      <p className="text-center text-xs font-semibold" style={{ color: 'var(--good)' }}>
                        Call ended — {drive.outcome?.kind}
                        {drive.outcome?.endOutcome ? ` (${drive.outcome.endOutcome})` : ''}
                      </p>
                    )}
                  </div>

                  {!drive.done && (
                    <form onSubmit={sendDriveReply} className="flex gap-2">
                      <input
                        className="input flex-1"
                        placeholder="Type the customer's reply…"
                        value={driveInput}
                        onChange={(e) => setDriveInput(e.target.value)}
                        disabled={driveBusy}
                        autoFocus
                      />
                      <button className="btn btn-primary text-sm" disabled={driveBusy || !driveInput.trim()}>
                        {driveBusy ? '…' : 'Say'}
                      </button>
                    </form>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-xs" style={{ color: 'var(--text-dim)' }}>
                    <div>
                      <p className="font-semibold uppercase tracking-wide">Captured facts</p>
                      {Object.keys(drive.state.facts).length === 0 ? (
                        <p>none yet</p>
                      ) : (
                        Object.entries(drive.state.facts).map(([key, value]) => (
                          <p key={key}>
                            <span style={{ color: 'var(--good)' }}>✓</span> {key} = {String(value)}
                          </p>
                        ))
                      )}
                    </div>
                    <div>
                      <p className="font-semibold uppercase tracking-wide">Compliance</p>
                      {drive.state.compliance.length === 0 ? (
                        <p>none yet</p>
                      ) : (
                        drive.state.compliance.map((c, i) => <p key={i}>{c.kind}</p>)
                      )}
                      {drive.state.objections.length > 0 && (
                        <>
                          <p className="mt-1 font-semibold uppercase tracking-wide">Objections</p>
                          {drive.state.objections.map((o, i) => (
                            <p key={i}>
                              {o.label} {o.recovered ? '(recovered)' : '(open)'}
                            </p>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                  {drive.state.summary && (
                    <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                      <b>Live summary:</b> {drive.state.summary}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {rightTab === 'preview' && !preview && (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Select an AI conversation node and click "Preview exact prompt" to see the composed system prompt and how
              turn history is assembled into each LLM request.
            </p>
          )}
          {rightTab === 'preview' && preview && (
            <div className="space-y-4 text-xs">
              <div>
                <p className="mb-1 font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  System prompt (rebuilt every turn)
                </p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg p-3 font-mono" style={{ background: 'var(--surface-2)' }}>
                  {preview.systemPrompt}
                </pre>
              </div>
              <div>
                <p className="mb-1 font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                  Message assembly per turn
                </p>
                <div className="space-y-1 rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                  {preview.messageAssembly.map((m, i) => (
                    <p key={i}>
                      <span style={{ color: 'var(--accent)' }}>[{m.role}]</span>{' '}
                      <span style={{ color: m.role === 'system' ? 'var(--text-dim)' : 'var(--text)' }}>
                        {m.role === 'system' ? '«composed system prompt above»' : m.content}
                      </span>
                    </p>
                  ))}
                </div>
              </div>
              <ul className="list-disc space-y-1 pl-4" style={{ color: 'var(--text-dim)' }}>
                {preview.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
