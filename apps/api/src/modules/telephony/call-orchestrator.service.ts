import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { redactPii, type AmdClass, type CallOutcome } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { Call, CallDocument } from '../../schemas/call.schema';
import { CampaignDocument } from '../../schemas/campaign.schema';
import { LeadDocument } from '../../schemas/lead.schema';
import { FlowExecutorService } from '../engine/flow-executor.service';
import { SimulationRuntime } from '../engine/simulation.runtime';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { FlowsService } from '../flows/flows.service';
import { LeadsService } from '../leads/leads.service';
import { PalService } from '../providers/pal.service';
import { RecordingsService } from '../recordings/recordings.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { TransfersService } from '../workspace/transfers.service';

/**
 * Runs one outbound call end-to-end: AMD → campaign voicemail/IVR policy →
 * flow execution (AI leg) → transfer or fallback → persistence, retry
 * matrix, recordings, webhooks, floor feed. The runtime is simulation in
 * dev (TELEPHONY_DRIVER=SIMULATION); the SIP runtime slots in behind the
 * same CallRuntime interface.
 */
@Injectable()
export class CallOrchestratorService {
  private readonly logger = new Logger(CallOrchestratorService.name);
  private readonly activeCalls = new Map<string, { campaignId: string; tenantId: string }>();

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    private readonly executor: FlowExecutorService,
    private readonly flows: FlowsService,
    private readonly leads: LeadsService,
    private readonly transfers: TransfersService,
    private readonly recordings: RecordingsService,
    private readonly webhooks: WebhooksService,
    private readonly packs: CountryPacksService,
    private readonly gateway: RealtimeGateway,
    private readonly pal: PalService,
  ) {}

  activeCallCount(campaignId: string): number {
    return [...this.activeCalls.values()].filter((c) => c.campaignId === campaignId).length;
  }

  totalActiveForTenant(tenantId: string): number {
    return [...this.activeCalls.values()].filter((c) => c.tenantId === tenantId).length;
  }

  /**
   * Place a call and report whether a human actually answered.
   *
   * The `answered` flag exists so the caller can feed CLI health accurately —
   * the dialer previously hardcoded `recordDial(cli, true)`, which meant the
   * answer-rate spam heuristic ("rest a number below 5% answer rate") could
   * never fire no matter how badly a number was performing.
   */
  async placeCall(campaign: CampaignDocument, lead: LeadDocument, cli: string | undefined, options?: { personaPrompt?: string; scriptedReplies?: string[]; amdClass?: AmdClass }): Promise<{ answered: boolean }> {
    const pack = await this.packs.getByCode(campaign.countryPackCode);
    const flowVersionId = this.pickFlowVersion(campaign);
    if (!flowVersionId) {
      this.logger.warn(`Campaign ${campaign.name} has no active flow version`);
      return { answered: false };
    }
    const graph = await this.flows.getPublishedGraph(flowVersionId);

    const call = await this.callModel.create({
      tenantId: campaign.tenantId,
      campaignId: campaign._id,
      leadId: lead._id,
      flowVersionId,
      cli,
      state: 'DIALING',
      startedAt: new Date(),
    });
    const callId = call._id.toString();
    this.activeCalls.set(callId, { campaignId: campaign._id.toString(), tenantId: campaign.tenantId.toString() });

    try {
      const runtime = new SimulationRuntime(
        {
          amdClass: options?.amdClass ?? 'HUMAN',
          scriptedReplies: options?.scriptedReplies,
          personaPrompt:
            options?.personaPrompt ??
            'You are an Australian homeowner receiving a solar sales call. Be initially hesitant but warm up if treated well.',
          tenantId: campaign.tenantId.toString(),
          preferRealLlmPersona: Boolean(
            config.providerKeys.anthropic || config.providerKeys.openai || config.providerKeys.google,
          ),
          onTransferRequest: async (input) => {
            call.state = 'TRANSFER_PENDING';
            await call.save();
            return this.transfers.requestTransfer({ callId, ...input });
          },
        },
        this.pal,
      );

      await this.runCall(call, campaign, lead, pack.disclosures, graph, runtime);
      return { answered: call.amdClass === 'HUMAN' };
    } finally {
      this.activeCalls.delete(callId);
      this.gateway.removeFloorCall(campaign.tenantId.toString(), callId);
    }
  }

  private pickFlowVersion(campaign: CampaignDocument): Types.ObjectId | null {
    // A/B assignment per FLOW-06: weighted pick across configured splits.
    if (campaign.abSplits.length > 0) {
      const roll = Math.random() * 100;
      let cumulative = 0;
      for (const split of campaign.abSplits) {
        cumulative += split.percent;
        if (roll < cumulative) return new Types.ObjectId(split.flowVersionId);
      }
    }
    return campaign.activeFlowVersionId ?? null;
  }

  private async runCall(
    call: CallDocument,
    campaign: CampaignDocument,
    lead: LeadDocument,
    disclosures: { recordingDisclosureText: string; aiIdentificationText: string },
    graph: Awaited<ReturnType<FlowsService['getPublishedGraph']>>,
    runtime: SimulationRuntime,
  ): Promise<void> {
    const callId = call._id.toString();
    const tenantId = call.tenantId.toString();
    const callStart = Date.now();

    // AMD per TEL-04, then campaign policy per TEL-05/06 before the flow runs.
    call.state = 'AMD_CLASSIFYING';
    const { amdClass, latencyMs } = await runtime.amdClassify();
    call.amdClass = amdClass;
    call.amdLatencyMs = latencyMs;
    call.answeredAt = new Date();

    if (amdClass === 'VOICEMAIL') {
      if (campaign.voicemailPolicy === 'PRERECORDED_DROP' && campaign.voicemailDropAssetId) {
        await runtime.playAsset(campaign.voicemailDropAssetId.toString());
      } else if (campaign.voicemailPolicy === 'AI_DROP') {
        const drop = `Hi, this is a quick message for ${lead.firstName ?? 'you'} about your power bill — we'll try you again soon.`;
        await runtime.say(drop);
      }
      await runtime.hangup();
      await this.finishCall(call, campaign, lead, 'ANSWERED_VOICEMAIL', callStart);
      return;
    }
    if (amdClass === 'FAX' || amdClass === 'SILENCE') {
      await runtime.hangup();
      await this.finishCall(call, campaign, lead, 'NO_ANSWER', callStart);
      return;
    }
    if (amdClass === 'IVR') {
      if (campaign.ivrPolicy.enabled) {
        await runtime.sendDtmf(campaign.ivrPolicy.digits);
      } else {
        await runtime.hangup();
        await this.finishCall(call, campaign, lead, 'ANSWERED_IVR', callStart);
        return;
      }
    }

    call.state = 'IN_CONVERSATION';
    await call.save();

    const agentIdRef = { current: null as string | null };
    const context = {
      callId,
      tenantId,
      campaignId: campaign._id.toString(),
      leadId: lead._id.toString(),
      vars: {
        firstName: lead.firstName ?? '',
        lastName: lead.lastName ?? '',
        suburb: lead.suburb ?? '',
        state: lead.state ?? '',
        phone: lead.phone,
        clientName: campaign.name,
        ...lead.facts,
      },
      facts: { ...lead.facts },
      score: lead.score,
      attempt: lead.attempts + 1,
      objections: [] as Array<{ label: string; recovered: boolean }>,
      startedAt: callStart,
    };

    const outcome = await this.executor.execute(
      graph,
      runtime,
      context,
      {
        scoring: campaign.scoring,
        rebuttals: campaign.rebuttals,
        aiSelfIdentification: campaign.aiSelfIdentification,
        aiIdentificationText: disclosures.aiIdentificationText,
        campaignPhone: call.cli ?? '',
        clientName: campaign.name,
        summaryTemplate: campaign.summaryTemplate,
        countryPackCode: campaign.countryPackCode,
      },
      {
        onLine: (speaker, text) => {
          const atMs = Date.now() - callStart;
          call.transcript.push({
            leg: 'AI',
            speaker,
            text,
            redactedText: redactPii(text),
            startMs: atMs,
            endMs: atMs,
          });
          this.gateway.streamTranscript(
            tenantId,
            agentIdRef.current,
            { callId, leg: 'AI', speaker: speaker === 'ai' ? 'ai' : 'customer', text: redactPii(text), startMs: atMs, endMs: atMs, final: true },
            campaign.transcriptionMode,
          );
        },
        onScore: (score, reason) => {
          call.scoreHistory.push({ atMs: Date.now() - callStart, score, reason });
          call.finalScore = score;
          this.gateway.updateFloorCall(tenantId, {
            callId,
            leadId: lead._id.toString(),
            campaignId: campaign._id.toString(),
            leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone,
            state: call.state,
            currentStage: 'conversation',
            score,
            startedAt: callStart,
            claimable: score >= campaign.scoring.thresholds.bookOnly,
          });
        },
        onCompliance: (kind, detail) => {
          call.complianceEvents.push({ atMs: Date.now() - callStart, kind: kind as never, detail });
        },
        onStage: () => undefined,
        onSummary: (summary) => {
          call.summary = summary;
          this.gateway.updateSummary(tenantId, agentIdRef.current, callId, summary);
        },
      },
    );

    // Persist structured capture per AI-06 back onto the lead.
    lead.facts = { ...lead.facts, ...context.facts };
    lead.score = context.score;
    call.objections = context.objections;
    call.finalScore = context.score;

    let callOutcome: CallOutcome;
    switch (outcome.kind) {
      case 'TRANSFERRED': {
        agentIdRef.current = call.agentId?.toString() ?? null;
        this.leads.transition(lead, 'TRANSFERRED', 'Warm transfer bridged');
        callOutcome = 'ANSWERED_HUMAN';
        await this.webhooks.dispatch(tenantId, 'lead.qualified', { leadId: lead._id.toString(), callId, score: context.score });
        await this.webhooks.dispatch(tenantId, 'transfer.accepted', { leadId: lead._id.toString(), callId });
        break;
      }
      case 'OPT_OUT':
        callOutcome = 'OPT_OUT';
        await this.webhooks.dispatch(tenantId, 'lead.optout', { leadId: lead._id.toString(), callId });
        break;
      case 'VOICEMAIL':
        callOutcome = 'ANSWERED_VOICEMAIL';
        break;
      case 'ABORTED':
        callOutcome = 'FAILED';
        break;
      case 'COMPLETED':
      default: {
        if (outcome.kind === 'COMPLETED' && outcome.endOutcome === 'QUALIFIED') {
          this.leads.transition(lead, 'QUALIFIED', 'Qualified, no transfer');
        } else if (outcome.kind === 'COMPLETED' && outcome.endOutcome === 'NURTURE') {
          this.leads.transition(lead, 'NURTURE', 'Nurture path');
        }
        callOutcome = 'ANSWERED_HUMAN';
        break;
      }
    }

    await lead.save();
    await this.finishCall(call, campaign, lead, callOutcome, callStart, outcome.kind === 'TRANSFERRED');
  }

  private async finishCall(
    call: CallDocument,
    campaign: CampaignDocument,
    lead: LeadDocument,
    outcome: CallOutcome,
    callStart: number,
    transferred = false,
  ): Promise<void> {
    // A bridged call stays open for the human leg; the agent's disposition
    // closes it per XFER-06. Everything else completes now.
    if (!transferred) {
      call.state = 'COMPLETED';
      call.endedAt = new Date();
    }
    call.outcome = outcome;
    // 100% auto-scoring per DASH-02.
    call.qaScore = this.autoScore(call);
    await call.save();

    await this.recordings.captureLeg({
      tenantId: call.tenantId.toString(),
      callId: call._id.toString(),
      leadId: lead._id.toString(),
      leg: 'AI',
      startedAt: new Date(callStart),
      transcript: call.transcript.filter((t) => t.leg === 'AI'),
    });

    if (!transferred) {
      await this.leads.applyOutcome(lead._id.toString(), outcome, call._id.toString());
      await this.webhooks.dispatch(call.tenantId.toString(), 'call.completed', {
        callId: call._id.toString(),
        leadId: lead._id.toString(),
        campaignId: campaign._id.toString(),
        outcome,
        score: call.finalScore,
      });
    }
  }

  /** Deterministic QA rubric: compliance lines present, no dead-air stall, objections addressed. */
  private autoScore(call: CallDocument): { total: number; breakdown: Record<string, number>; notes: string } {
    const breakdown: Record<string, number> = {};
    breakdown.compliance = call.complianceEvents.some((e) => e.kind === 'RECORDING_DISCLOSURE') ? 30 : 0;
    breakdown.engagement = Math.min(30, call.transcript.filter((t) => t.speaker === 'customer').length * 5);
    breakdown.objectionHandling = call.objections.length === 0 ? 20 : call.objections.every((o) => o.recovered) ? 20 : 8;
    breakdown.outcomeQuality = call.finalScore >= 70 ? 20 : call.finalScore >= 40 ? 12 : 5;
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const notes = breakdown.compliance === 0 ? 'Missing recording disclosure' : 'Auto-scored';
    return { total, breakdown, notes };
  }
}
