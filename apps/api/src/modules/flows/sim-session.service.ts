import { Injectable, NotFoundException } from '@nestjs/common';
import { DEFAULT_SCORING_CONFIG, type AmdClass, type FlowGraph } from '@cocally/shared';
import { FlowExecutorService } from '../engine/flow-executor.service';
import type { CallRuntime } from '../engine/runtime';

/**
 * Interactive test-drive per FLOW-05, done properly: the REAL flow executor
 * runs server-side — same prompt composition, scoring, safety rails, and
 * transfer logic as live calls — and pauses at every listen(). The admin
 * plays the customer turn by turn from a chat UI. Nothing is mocked except
 * the phone line itself, so what you see in a test-drive is exactly what a
 * lead would experience.
 */

type SimEvent =
  | { seq: number; kind: 'ai'; text: string }
  | { seq: number; kind: 'customer'; text: string }
  | { seq: number; kind: 'system'; text: string };

interface SessionState {
  score: number;
  facts: Record<string, unknown>;
  objections: Array<{ label: string; recovered: boolean }>;
  stage: string;
  summary: string;
  compliance: Array<{ kind: string; detail: string }>;
}

interface SimSession {
  id: string;
  tenantId: string;
  runtime: InteractiveRuntime;
  events: SimEvent[];
  state: SessionState;
  done: boolean;
  outcome: unknown;
  createdAt: number;
  seq: number;
}

/**
 * CallRuntime that suspends on listen() until the admin's reply arrives.
 * say()/playAsset()/etc. buffer events; waitForIdle() resolves once the
 * executor either needs customer input again or has finished the call.
 */
class InteractiveRuntime implements CallRuntime {
  private pendingListen: ((text: string | null) => void) | null = null;
  private idleWaiters: Array<() => void> = [];
  private aborted = false;
  private dtmfSent = false;
  finished = false;

  constructor(
    private readonly session: { push: (kind: 'ai' | 'system', text: string) => void },
    private readonly amdClass: AmdClass,
    private readonly transferResult: 'BRIDGED' | 'NO_AGENT' | 'FAILED',
  ) {}

  /** Resolves when the executor is blocked on listen() or the call ended. */
  waitForIdle(): Promise<void> {
    if (this.pendingListen || this.finished) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }

  markFinished(): void {
    this.finished = true;
    this.notifyIdle();
  }

  provideReply(text: string): boolean {
    const resolve = this.pendingListen;
    if (!resolve) return false;
    this.pendingListen = null;
    resolve(text);
    return true;
  }

  abort(): void {
    this.aborted = true;
    const resolve = this.pendingListen;
    this.pendingListen = null;
    resolve?.(null);
  }

  async say(text: string): Promise<{ bargedIn: boolean }> {
    this.session.push('ai', text);
    return { bargedIn: false };
  }

  async playAsset(assetId: string): Promise<void> {
    this.session.push('system', `▶ plays recorded prompt "${assetId}"`);
  }

  async listen(): Promise<string | null> {
    if (this.aborted) return null;
    return new Promise<string | null>((resolve) => {
      this.pendingListen = resolve;
      this.notifyIdle();
    });
  }

  async amdClassify(): Promise<{ amdClass: AmdClass; latencyMs: number }> {
    // After an IVR keypress, the re-check finds a human — mirroring a real
    // "press 1 to connect" that bridges through to a person.
    const amdClass = this.dtmfSent ? 'HUMAN' : this.amdClass;
    this.session.push('system', `☎ ${this.dtmfSent ? 're-checked after keypress' : 'answered'} — AMD classified ${amdClass} (simulated)`);
    return { amdClass, latencyMs: 800 };
  }

  async sendDtmf(digits: string): Promise<void> {
    this.dtmfSent = true;
    this.session.push('system', `⌨ IVR detected — sends DTMF ${digits}`);
  }

  async hangup(): Promise<void> {
    this.session.push('system', '☎ call ended');
  }

  async requestTransfer(): Promise<'BRIDGED' | 'NO_AGENT' | 'FAILED'> {
    this.session.push(
      'system',
      this.transferResult === 'BRIDGED'
        ? '⇄ warm transfer requested → agent accepted, bridged (simulated)'
        : '⇄ warm transfer requested → no agent available, falling back',
    );
    return this.transferResult;
  }
}

@Injectable()
export class SimSessionService {
  private readonly sessions = new Map<string, SimSession>();
  private static readonly TTL_MS = 30 * 60 * 1000;

  constructor(private readonly executor: FlowExecutorService) {}

  private sweep(): void {
    const cutoff = Date.now() - SimSessionService.TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.createdAt < cutoff) {
        session.runtime.abort();
        this.sessions.delete(id);
      }
    }
  }

  async start(input: {
    tenantId: string;
    graph: FlowGraph;
    amdClass?: AmdClass;
    transferResult?: 'BRIDGED' | 'NO_AGENT' | 'FAILED';
    leadVars?: Record<string, unknown>;
    rebuttals?: Array<{ objection: string; rebuttal: string }>;
  }) {
    this.sweep();
    const id = Math.random().toString(36).slice(2, 12);

    const session: SimSession = {
      id,
      tenantId: input.tenantId,
      runtime: null as unknown as InteractiveRuntime,
      events: [],
      state: { score: 0, facts: {}, objections: [], stage: '', summary: '', compliance: [] },
      done: false,
      outcome: null,
      createdAt: Date.now(),
      seq: 0,
    };
    const push = (kind: 'ai' | 'system', text: string) => {
      session.events.push({ seq: session.seq++, kind, text });
    };
    const runtime = new InteractiveRuntime({ push }, input.amdClass ?? 'HUMAN', input.transferResult ?? 'BRIDGED');
    session.runtime = runtime;
    this.sessions.set(id, session);

    const context = {
      callId: `sim-${id}`,
      tenantId: input.tenantId,
      campaignId: 'test-drive',
      leadId: 'test-drive',
      vars: { firstName: 'Sam', suburb: 'Richmond', phone: '+61400000000', clientName: 'Aurora Solar', ...input.leadVars },
      facts: {},
      score: 0,
      attempt: 1,
      objections: [],
      startedAt: Date.now(),
    };

    void this.executor
      .execute(
        input.graph,
        runtime,
        context,
        {
          scoring: DEFAULT_SCORING_CONFIG,
          rebuttals: input.rebuttals ?? [],
          aiSelfIdentification: true,
          aiIdentificationText: "I'm a virtual assistant.",
          campaignPhone: '+61390000000',
          clientName: 'Aurora Solar',
          summaryTemplate: 'Score {{score}}. Facts: {{facts}}. Objection: {{objection}}.',
          countryPackCode: 'AU',
        },
        {
          onLine: (speaker, text) => {
            // AI lines are already pushed by runtime.say(); record customer lines here.
            if (speaker === 'customer') session.events.push({ seq: session.seq++, kind: 'customer', text });
            session.state.score = context.score;
            session.state.facts = { ...context.facts };
            session.state.objections = [...context.objections];
          },
          onScore: (score, reason) => {
            session.state.score = score;
            session.events.push({ seq: session.seq++, kind: 'system', text: `score → ${score} (${reason})` });
          },
          onCompliance: (kind, detail) => session.state.compliance.push({ kind, detail }),
          onStage: (stage) => {
            session.state.stage = stage;
          },
          onSummary: (summary) => {
            session.state.summary = summary;
          },
        },
      )
      .then((outcome) => {
        session.done = true;
        session.outcome = outcome;
        session.state.facts = { ...context.facts };
        session.state.score = context.score;
        runtime.markFinished();
      })
      .catch((err: Error) => {
        session.done = true;
        session.outcome = { kind: 'ABORTED', reason: err.message };
        runtime.markFinished();
      });

    await runtime.waitForIdle();
    return this.snapshot(session);
  }

  async reply(tenantId: string, sessionId: string, text: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId) throw new NotFoundException('Test-drive session not found or expired');
    if (session.done) return this.snapshot(session);

    const accepted = session.runtime.provideReply(text);
    if (!accepted) return this.snapshot(session);
    await session.runtime.waitForIdle();
    return this.snapshot(session);
  }

  end(tenantId: string, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.tenantId === tenantId) {
      session.runtime.abort();
      this.sessions.delete(sessionId);
    }
  }

  private snapshot(session: SimSession) {
    return {
      sessionId: session.id,
      events: session.events,
      state: session.state,
      done: session.done,
      outcome: session.outcome,
      waitingForCustomer: !session.done,
    };
  }
}
