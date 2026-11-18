import { describe, expect, it } from 'vitest';
import { findAbnormalities, type AlertCall, type AlertCampaign } from '../abnormalities';

const t0 = new Date('2026-11-18T05:40:00Z');
let n = 0;
function call(p: Partial<AlertCall> = {}): AlertCall {
  n += 1;
  const startedAt = new Date(+t0 + n * 5000);
  return { id: `c${n}`, startedAt, endedAt: new Date(+startedAt + 20000), speakers: [], workerLog: [], events: [], outcome: 'ANSWERED_VOICEMAIL', ...p };
}
function campaign(calls: AlertCall[], p: Partial<AlertCampaign> = {}): AlertCampaign {
  return { id: 'k1', name: 'Victoria', status: 'ACTIVE', calls, callsInPreviousWindow: 50, ...p };
}
const checks = (k: AlertCampaign) => findAbnormalities(k).map((f) => `${f.check}:${f.severity}`);

describe('call abnormality checks', () => {
  it('a normal window finds nothing', () => {
    const calls = [
      ...Array.from({ length: 12 }, () => call()),
      call({ outcome: 'FAILED', sipStatusCode: 503 }),
      call({ outcome: 'ANSWERED_HUMAN', answeredAt: t0, speakers: ['ai', 'customer', 'ai'] }),
    ];
    expect(findAbnormalities(campaign(calls))).toEqual([]);
  });

  it('18 Nov: a run of SIP 480 "no answer" calls is a carrier outage', () => {
    const calls = [...Array.from({ length: 5 }, () => call()), ...Array.from({ length: 12 }, () => call({ outcome: 'NO_ANSWER', sipStatusCode: 480 }))];
    const f = findAbnormalities(campaign(calls));
    expect(f.map((x) => `${x.check}:${x.severity}`)).toEqual(['CARRIER_REFUSALS:CRITICAL']);
    expect(f[0]?.detail).toContain('480 ×12');
    expect(f[0]?.detail).toContain('Longest unbroken run of refused calls: 12');
  });

  it('a high share of 503 congestion is a warning', () => {
    const calls = [...Array.from({ length: 13 }, () => call()), ...Array.from({ length: 7 }, (_, i) => call({ outcome: 'FAILED', sipStatusCode: i % 2 ? 503 : 604 }))];
    // interleave so there is no long run
    calls.sort(() => 0);
    expect(checks(campaign(calls))).toEqual(['CARRIER_REFUSALS:WARNING']);
  });

  it('too few calls for a refusal rate stays quiet', () => {
    expect(checks(campaign([call({ outcome: 'FAILED', sipStatusCode: 503 }), call({ outcome: 'FAILED', sipStatusCode: 503 })]))).toEqual([]);
  });

  it('an answered call where the customer talked and the AI never spoke', () => {
    expect(checks(campaign([call({ outcome: 'ANSWERED_HUMAN', answeredAt: t0, speakers: ['customer', 'customer'] })]))).toEqual(['SILENT_AI:CRITICAL']);
  });

  it('a 2-second network message with no AI line is not a silent AI', () => {
    const startedAt = new Date(+t0 + 999_000);
    expect(
      checks(campaign([call({ startedAt, answeredAt: startedAt, endedAt: new Date(+startedAt + 1500), outcome: 'ANSWERED_HUMAN', speakers: ['customer'] })])),
    ).toEqual([]);
  });

  it("18 Nov: Geoffrey's transfer with nobody to take it", () => {
    const f = findAbnormalities(
      campaign([call({ outcome: 'ANSWERED_HUMAN', answeredAt: t0, speakers: ['ai', 'customer'], events: [{ kind: 'transfer', detail: 'NO_AGENT' }], leadLabel: 'GEOFFREY, MORWELL' })]),
    );
    expect(f.map((x) => x.check)).toEqual(['LOST_TRANSFER']);
    expect(f[0]?.detail).toContain('GEOFFREY, MORWELL (NO_AGENT)');
  });

  it('a bridged transfer is fine', () => {
    expect(checks(campaign([call({ bridgedAt: t0, events: [{ kind: 'transfer', detail: 'BRIDGED' }] })]))).toEqual([]);
  });

  it('voice and speech-to-text failovers', () => {
    const k = campaign([
      call({ workerLog: ['04:16:43 W agents: livekit.plugins.cartesia.tts.TTS failed, switching to next TTS: 402 out of credits'] }),
      call({ workerLog: ['W agents: livekit.plugins.deepgram.stt.STT failed, switching to next STT'] }),
    ]);
    expect(checks(k)).toEqual(['VOICE_FAILOVER:WARNING', 'STT_FAILOVER:CRITICAL']);
  });

  it('LLM failover only alerts when it is frequent', () => {
    const llm = "W agents: livekit.plugins.google.llm.LLM failed, switching to next LLM: message='gemini llm: client error', status_code=429";
    expect(checks(campaign([...Array.from({ length: 2 }, () => call({ workerLog: [llm] })), ...Array.from({ length: 20 }, () => call())]))).toEqual([]);
    expect(checks(campaign([...Array.from({ length: 6 }, () => call({ workerLog: [llm] })), ...Array.from({ length: 10 }, () => call())]))).toEqual(['LLM_FAILOVER:WARNING']);
  });

  it('an active campaign that stopped dialling', () => {
    expect(checks(campaign([], { callsInPreviousWindow: 40 }))).toEqual(['DIALLER_STALLED:CRITICAL']);
    expect(checks(campaign([], { callsInPreviousWindow: 0 }))).toEqual([]);
    expect(checks(campaign([], { status: 'PAUSED', callsInPreviousWindow: 40 }))).toEqual([]);
  });
});
