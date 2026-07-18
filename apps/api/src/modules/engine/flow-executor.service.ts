import { Injectable, Logger } from '@nestjs/common';
import {
  computeScore,
  scoreAction,
  type EdgeCondition,
  type FlowGraph,
  type FlowNode,
  type ScoringConfig,
} from '@cocally/shared';
import { PalService } from '../providers/pal.service';
import { SuppressionService } from '../leads/suppression.service';
import { composeSystemPrompt } from './prompt';
import { interpolate, type CallContext, type CallRuntime, type ExecutionOutcome } from './runtime';

export interface ExecutorHooks {
  /** Transcript sink: every AI/customer line, for recording + live feed. */
  onLine(speaker: 'ai' | 'customer', text: string): void;
  onScore(score: number, reason: string): void;
  onCompliance(kind: string, detail: string): void;
  onStage(stage: string): void;
  /** Incremental summary updates per PAL-11. */
  onSummary(summary: string): void;
}

export interface ExecutorConfig {
  scoring: ScoringConfig;
  rebuttals: Array<{ objection: string; rebuttal: string }>;
  aiSelfIdentification: boolean;
  aiIdentificationText: string;
  campaignPhone: string;
  clientName: string;
  summaryTemplate: string;
  countryPackCode: string;
}

const DISTRESS_PATTERN = /\b(fuck|shit|piss off|leave me alone|harass|stop it|angry|upset|crying)\b/i;
const OPT_OUT_PATTERN = /\b(don'?t call|do not call|stop calling|remove me|take me off|unsubscribe)\b/i;

interface LlmTurnEnvelope {
  reply: string;
  intent: 'continue' | 'qualified' | 'objection' | 'opt_out' | 'callback' | 'end';
  captured: Record<string, unknown>;
  objection: string | null;
}

/**
 * Flow executor per FLOW-01: walks the published graph node by node,
 * evaluating edge conditions against live call state. The AI conversation
 * loop (AI-01..AI-09) runs inside AI_CONVERSATION nodes.
 */
@Injectable()
export class FlowExecutorService {
  private readonly logger = new Logger(FlowExecutorService.name);

  constructor(
    private readonly pal: PalService,
    private readonly suppression: SuppressionService,
  ) {}

  async execute(
    graph: FlowGraph,
    runtime: CallRuntime,
    context: CallContext,
    config: ExecutorConfig,
    hooks: ExecutorHooks,
  ): Promise<ExecutionOutcome> {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    let currentId: string | undefined = graph.entryNodeId;
    let guard = 0;

    while (currentId) {
      guard += 1;
      if (guard > 200) return { kind: 'ABORTED', reason: 'node budget exceeded' };

      const node = nodes.get(currentId);
      if (!node) return { kind: 'ABORTED', reason: `missing node ${currentId}` };
      hooks.onStage(node.label ?? node.type);

      const result = await this.executeNode(node, runtime, context, config, hooks);
      if (result.terminal) return result.outcome;

      currentId = this.nextNode(graph, node.id, context, result.exitIntent);
      if (!currentId) {
        return { kind: 'COMPLETED', endOutcome: 'COMPLETE' };
      }
    }
    return { kind: 'COMPLETED', endOutcome: 'COMPLETE' };
  }

  private async executeNode(
    node: FlowNode,
    runtime: CallRuntime,
    context: CallContext,
    config: ExecutorConfig,
    hooks: ExecutorHooks,
  ): Promise<{ terminal: false; exitIntent?: string } | { terminal: true; outcome: ExecutionOutcome }> {
    switch (node.type) {
      case 'AMD_CLASSIFY': {
        const { amdClass, latencyMs } = await runtime.amdClassify();
        context.amdClass = amdClass;
        context.vars['amd'] = { class: amdClass, latencyMs };
        hooks.onCompliance('WINDOW_CHECK', `AMD classified ${amdClass} in ${latencyMs}ms`);
        return { terminal: false };
      }

      case 'PLAY_AUDIO': {
        await runtime.playAsset(node.config.assetId);
        if (node.mandatory) hooks.onCompliance('RECORDING_DISCLOSURE', `Played mandatory asset ${node.config.assetId}`);
        return { terminal: false };
      }

      case 'SPEAK': {
        const text = interpolate(node.config.text, context.vars);
        hooks.onLine('ai', text);
        await runtime.say(text, { interruptible: node.config.interruptible });
        if (node.mandatory) hooks.onCompliance('RECORDING_DISCLOSURE', text);
        return { terminal: false };
      }

      case 'SEND_DTMF': {
        await runtime.sendDtmf(node.config.digits);
        return { terminal: false };
      }

      case 'BRANCH':
        return { terminal: false };

      case 'LISTEN_CAPTURE': {
        return this.runListenCapture(node, runtime, context, config, hooks);
      }

      case 'AI_CONVERSATION': {
        return this.runConversation(node, runtime, context, config, hooks);
      }

      case 'TRANSFER': {
        const result = await runtime.requestTransfer({
          whisperEnabled: node.config.whisperEnabled,
          acceptWindowSeconds: node.config.acceptWindowSeconds,
        });
        if (result === 'BRIDGED') return { terminal: true, outcome: { kind: 'TRANSFERRED' } };
        // No agent free → availability fallback per XFER-03; edges keyed on
        // transfer.result let the flow book instead.
        context.vars['transfer'] = { result };
        return { terminal: false, exitIntent: 'transfer_failed' };
      }

      case 'WEBHOOK': {
        // Fire-and-forget CRM write per FLOW-02; delivery guarantees live in the webhook module.
        context.vars['webhook'] = { url: node.config.url, at: Date.now() };
        return { terminal: false };
      }

      case 'SET_RETRY': {
        context.vars['retry'] = { delayMinutes: node.config.delayMinutes, shiftTimeBand: node.config.shiftTimeBand };
        return { terminal: false };
      }

      case 'END': {
        await runtime.hangup();
        return {
          terminal: true,
          outcome: {
            kind: node.config.outcome === 'OPT_OUT' ? 'OPT_OUT' : 'COMPLETED',
            disposition: node.config.disposition,
            endOutcome: node.config.outcome,
          } as ExecutionOutcome,
        };
      }
    }
  }

  private async runListenCapture(
    node: Extract<FlowNode, { type: 'LISTEN_CAPTURE' }>,
    runtime: CallRuntime,
    context: CallContext,
    config: ExecutorConfig,
    hooks: ExecutorHooks,
  ): Promise<{ terminal: false; exitIntent?: string }> {
    const promptText = interpolate(node.config.promptText, context.vars);
    hooks.onLine('ai', promptText);
    await runtime.say(promptText);

    for (let attempt = 0; attempt <= node.config.maxRetries; attempt += 1) {
      const heard = await runtime.listen({ numberCapture: node.config.fieldType === 'phone' || node.config.fieldType === 'number' });
      if (!heard) continue;
      hooks.onLine('customer', heard);

      const value = this.coerceCapture(heard, node.config.fieldType);
      if (value === undefined) {
        await runtime.say("Sorry, I didn't quite catch that — could you repeat it?");
        continue;
      }

      if (node.config.confirm) {
        // Read-back confirmation per NFR accuracy.
        const confirmText = `Just to confirm, that's ${String(value)} — is that right?`;
        hooks.onLine('ai', confirmText);
        await runtime.say(confirmText);
        const confirmation = await runtime.listen();
        if (confirmation) hooks.onLine('customer', confirmation);
        if (!confirmation || !/\b(yes|yeah|yep|correct|right)\b/i.test(confirmation)) continue;
      }

      context.facts[node.config.variable] = value;
      context.vars[node.config.variable] = value;
      this.updateScore(context, config, hooks, `captured ${node.config.variable}`);
      return { terminal: false };
    }
    return { terminal: false, exitIntent: 'capture_failed' };
  }

  /**
   * AI conversation loop per AI-01..AI-06: state-aware qualification that
   * never re-asks answered questions, objection handling with the campaign
   * rebuttal library, live scoring, structured capture, and safety rails.
   */
  private async runConversation(
    node: Extract<FlowNode, { type: 'AI_CONVERSATION' }>,
    runtime: CallRuntime,
    context: CallContext,
    config: ExecutorConfig,
    hooks: ExecutorHooks,
  ): Promise<{ terminal: false; exitIntent?: string } | { terminal: true; outcome: ExecutionOutcome }> {
    const scope = {
      tenantId: context.tenantId,
      campaignId: context.campaignId,
      countryPackCode: config.countryPackCode,
      nodeProviderId: node.providerOverrides?.llm,
      llmRole: 'CONVERSATION' as const,
    };

    const history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: this.buildSystemPrompt(node.config.prompt, context, config) },
    ];

    for (let turn = 0; turn < node.config.maxTurns; turn += 1) {
      const heard = await runtime.listen();
      if (heard === null) {
        // Dead-air handling: one nudge, then exit gracefully — never pretend
        // "the line's cutting out" (explicit anti-pattern from the PRD).
        if (turn === 0) {
          const nudge = 'Hello, are you still there?';
          hooks.onLine('ai', nudge);
          await runtime.say(nudge);
          continue;
        }
        return { terminal: false, exitIntent: 'silence' };
      }
      hooks.onLine('customer', heard);

      // Safety rails per AI-09 evaluated before the model turn.
      if (OPT_OUT_PATTERN.test(heard)) {
        hooks.onCompliance('OPT_OUT_DETECTED', heard);
        await this.suppression.optOut(context.tenantId, String(context.vars['phone'] ?? ''), `utterance on call ${context.callId}`);
        const goodbye = 'Understood — I have removed you from our list. Sorry to have bothered you. Goodbye.';
        hooks.onLine('ai', goodbye);
        await runtime.say(goodbye);
        await runtime.hangup();
        return { terminal: true, outcome: { kind: 'OPT_OUT' } };
      }
      if (DISTRESS_PATTERN.test(heard)) {
        hooks.onCompliance('DISTRESS_EXIT', heard);
        const exit = 'I can hear this is not a good time. I will let you go — have a good day.';
        hooks.onLine('ai', exit);
        await runtime.say(exit);
        await runtime.hangup();
        return { terminal: true, outcome: { kind: 'COMPLETED', endOutcome: 'RELEASE' } };
      }

      history.push({ role: 'user', content: heard });
      // Rebuild the system prompt each turn so the ALREADY-ANSWERED list
      // reflects facts captured mid-call (AI-03: never re-ask).
      history[0] = { role: 'system', content: this.buildSystemPrompt(node.config.prompt, context, config) };
      const completion = await this.pal.llm(scope, {
        messages: history,
        jsonMode: true,
        temperature: 0.6,
        maxTokens: 400,
      });

      const envelope = this.parseEnvelope(completion.text);
      history.push({ role: 'assistant', content: completion.text });

      // Structured capture per AI-06.
      for (const [key, value] of Object.entries(envelope.captured)) {
        if (value !== null && value !== undefined) {
          context.facts[key] = value;
          context.vars[key] = value;
        }
      }

      if (envelope.objection) {
        const known = context.objections.find((o) => o.label === envelope.objection);
        if (!known) context.objections.push({ label: envelope.objection, recovered: false });
      } else if (context.objections.length > 0) {
        const last = context.objections[context.objections.length - 1];
        if (last && !last.recovered) last.recovered = true;
      }

      this.updateScore(context, config, hooks, `turn ${turn + 1}`);
      hooks.onSummary(this.renderSummary(context, config));

      hooks.onLine('ai', envelope.reply);
      await runtime.say(envelope.reply);

      const action = scoreAction(config.scoring, context.score);
      if (envelope.intent === 'qualified' || (action === 'TRANSFER' && envelope.intent !== 'objection')) {
        return { terminal: false, exitIntent: 'qualified' };
      }
      if (envelope.intent === 'callback') return { terminal: false, exitIntent: 'callback' };
      if (envelope.intent === 'end') return { terminal: false, exitIntent: 'not_interested' };
      if (node.config.exitIntents.includes(envelope.intent)) {
        return { terminal: false, exitIntent: envelope.intent };
      }
    }
    return { terminal: false, exitIntent: 'max_turns' };
  }

  private buildSystemPrompt(nodePrompt: string, context: CallContext, config: ExecutorConfig): string {
    return composeSystemPrompt({
      nodePrompt,
      vars: context.vars,
      facts: context.facts,
      rebuttals: config.rebuttals,
      aiSelfIdentification: config.aiSelfIdentification,
    });
  }

  private parseEnvelope(text: string): LlmTurnEnvelope {
    try {
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<LlmTurnEnvelope>;
      return {
        reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply : 'Could you tell me a little more about that?',
        intent: (['continue', 'qualified', 'objection', 'opt_out', 'callback', 'end'] as const).includes(
          parsed.intent as never,
        )
          ? (parsed.intent as LlmTurnEnvelope['intent'])
          : 'continue',
        captured: typeof parsed.captured === 'object' && parsed.captured !== null ? parsed.captured : {},
        objection: typeof parsed.objection === 'string' ? parsed.objection : null,
      };
    } catch {
      // Model returned plain prose — use it as the reply and keep going.
      return { reply: text.slice(0, 300), intent: 'continue', captured: {}, objection: null };
    }
  }

  private updateScore(context: CallContext, config: ExecutorConfig, hooks: ExecutorHooks, reason: string): void {
    const next = computeScore(config.scoring, context.facts);
    if (next !== context.score) {
      context.score = next;
      context.vars['score'] = next;
      hooks.onScore(next, reason);
    }
  }

  private renderSummary(context: CallContext, config: ExecutorConfig): string {
    const facts = Object.entries(context.facts)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join('; ');
    const lastObjection = context.objections[context.objections.length - 1]?.label ?? 'none';
    return interpolate(config.summaryTemplate, {
      ...context.vars,
      score: context.score,
      facts,
      objection: lastObjection,
      opener: this.suggestOpener(context),
    });
  }

  private suggestOpener(context: CallContext): string {
    const name = String(context.vars['firstName'] ?? 'there');
    if (context.facts['appointmentInterest']) {
      return `Hi ${name}, I hear you're keen to find a time — let's lock one in.`;
    }
    return `Hi ${name}, thanks for your time — I can answer any questions and sort the details.`;
  }

  private nextNode(graph: FlowGraph, fromId: string, context: CallContext, exitIntent?: string): string | undefined {
    const state: Record<string, unknown> = {
      ...context.vars,
      score: context.score,
      attempt: context.attempt,
      intent: exitIntent,
      'amd.class': context.amdClass,
    };
    const candidates = graph.edges
      .filter((e) => e.from === fromId)
      .sort((a, b) => a.priority - b.priority);

    for (const edge of candidates) {
      if (edge.conditions.length === 0) continue; // defaults evaluated last
      if (edge.conditions.every((c) => this.evalCondition(c, state))) return edge.to;
    }
    return candidates.find((e) => e.conditions.length === 0)?.to;
  }

  private evalCondition(condition: EdgeCondition, state: Record<string, unknown>): boolean {
    const value =
      state[condition.variable] ??
      condition.variable.split('.').reduce<unknown>((acc, part) => {
        if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
        return undefined;
      }, state);

    switch (condition.operator) {
      case 'exists':
        return value !== undefined && value !== null;
      case 'eq':
        return value === condition.value || String(value) === String(condition.value);
      case 'neq':
        return String(value) !== String(condition.value);
      case 'gt':
        return Number(value) > Number(condition.value);
      case 'gte':
        return Number(value) >= Number(condition.value);
      case 'lt':
        return Number(value) < Number(condition.value);
      case 'lte':
        return Number(value) <= Number(condition.value);
      case 'contains':
        return String(value ?? '').toLowerCase().includes(String(condition.value ?? '').toLowerCase());
      case 'in':
        return Array.isArray(condition.value) && condition.value.some((v) => String(v) === String(value));
      default:
        return false;
    }
  }

  private coerceCapture(
    heard: string,
    fieldType: 'text' | 'number' | 'phone' | 'yes_no' | 'datetime',
  ): unknown {
    switch (fieldType) {
      case 'text':
        return heard.trim();
      case 'number': {
        const match = heard.replace(/[,$]/g, '').match(/\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : undefined;
      }
      case 'phone': {
        const digits = heard.replace(/\D/g, '');
        return digits.length >= 8 ? digits : undefined;
      }
      case 'yes_no': {
        if (/\b(yes|yeah|yep|sure|correct|of course)\b/i.test(heard)) return true;
        if (/\b(no|nope|nah|not)\b/i.test(heard)) return false;
        return undefined;
      }
      case 'datetime':
        return heard.trim();
      default:
        return undefined;
    }
  }
}
