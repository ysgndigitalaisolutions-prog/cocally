'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface CallRow {
  _id: string;
  startedAt: string;
  state: string;
  amdClass?: string;
  outcome?: string;
  disposition?: string;
  finalScore: number;
  summary: string;
  qaScore?: { total: number; notes: string };
}

interface CallDetail extends CallRow {
  transcript: Array<{ speaker: string; text: string; leg: string }>;
  scoreHistory: Array<{ atMs: number; score: number; reason: string }>;
  complianceEvents: Array<{ atMs: number; kind: string; detail: string }>;
}

export default function CallsPage() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [detail, setDetail] = useState<CallDetail | null>(null);

  useEffect(() => {
    api
      .get('/calls')
      .then((r) => setCalls(r.data))
      .catch(() => undefined);
  }, []);

  async function openDetail(id: string) {
    const { data } = await api.get(`/calls/${id}`);
    setDetail(data);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Calls</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
                <th className="p-3">Started</th>
                <th className="p-3">AMD</th>
                <th className="p-3">Outcome</th>
                <th className="p-3">Disposition</th>
                <th className="p-3">Score</th>
                <th className="p-3">QA</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr
                  key={call._id}
                  onClick={() => openDetail(call._id)}
                  className="cursor-pointer border-t"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <td className="p-3">{new Date(call.startedAt).toLocaleString()}</td>
                  <td className="p-3">{call.amdClass ?? '—'}</td>
                  <td className="p-3">{call.outcome ?? call.state}</td>
                  <td className="p-3">{call.disposition ?? '—'}</td>
                  <td className="p-3 font-semibold">{call.finalScore}</td>
                  <td className="p-3">{call.qaScore?.total ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card p-6">
          {!detail ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
              Select a call for the deep-dive: transcript, score-over-time, compliance events (DASH-07).
            </p>
          ) : (
            <div className="space-y-4 text-sm">
              <h2 className="font-semibold">Call deep-dive</h2>
              {detail.summary && (
                <p className="rounded-lg p-3" style={{ background: 'var(--surface-2)' }}>
                  {detail.summary}
                </p>
              )}
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {detail.transcript.map((line, i) => (
                  <p key={i}>
                    <span
                      style={{
                        color: line.speaker === 'ai' ? 'var(--accent)' : line.speaker === 'agent' ? 'var(--good)' : 'var(--text-dim)',
                      }}
                    >
                      [{line.leg}] {line.speaker}:
                    </span>{' '}
                    {line.text}
                  </p>
                ))}
              </div>
              <div>
                <h3 className="mb-1 font-semibold">Score over time</h3>
                {detail.scoreHistory.map((point, i) => (
                  <p key={i} style={{ color: 'var(--text-dim)' }}>
                    +{(point.atMs / 1000).toFixed(1)}s → <span style={{ color: 'var(--text)' }}>{point.score}</span> ({point.reason})
                  </p>
                ))}
              </div>
              <div>
                <h3 className="mb-1 font-semibold">Compliance events</h3>
                {detail.complianceEvents.map((event, i) => (
                  <p key={i} style={{ color: 'var(--text-dim)' }}>
                    {event.kind}: {event.detail.slice(0, 80)}
                  </p>
                ))}
              </div>
              {detail.qaScore && (
                <p>
                  <span className="font-semibold">Auto-QA:</span> {detail.qaScore.total}/100 — {detail.qaScore.notes}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
