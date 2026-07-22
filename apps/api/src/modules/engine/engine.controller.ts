import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { computeScore, redactPii, scoreAction } from '@cocally/shared';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { Model, Types } from 'mongoose';
import { Public } from '../../common/auth/public.decorator';
import { ServiceTokenGuard } from '../../common/auth/service-token.guard';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { FlowVersion, FlowVersionDocument } from '../../schemas/flow.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { PalService } from '../providers/pal.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { TransfersService } from '../workspace/transfers.service';
import { interpolate } from './runtime';

class TranscriptTurnDto {
  @IsIn(['ai', 'customer'])
  speaker: 'ai' | 'customer';

  @IsString()
  @IsNotEmpty()
  text: string;
}

class TransferRequestDto {
  @IsString()
  reason: string;
}

/**
 * Internal engine API for the LiveKit Agents worker (service-token auth, not a
 * user JWT). The worker fetches an authoritative "brief" per call so the
 * conversation content — the campaign author's prompt, the country-pack
 * disclosure, the rebuttal playbook — stays defined in one place (here), never
 * duplicated in the Python worker.
 *
 * This returns SPOKEN instructions (natural conversation), unlike
 * composeSystemPrompt() which formats the same content for the JSON-envelope
 * turn loop. The worker speaks these; NestJS records the transcript and scores
 * post-call. See claude-dev/2026-07-19-live-call-build-plan.md.
 */
@Controller('engine')
export class EngineController {
  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(FlowVersion.name) private readonly flowVersionModel: Model<FlowVersionDocument>,
    private readonly packs: CountryPacksService,
    private readonly gateway: RealtimeGateway,
    private readonly transfers: TransfersService,
    private readonly pal: PalService,
  ) {}

  @Public()
  @UseGuards(ServiceTokenGuard)
  @Get('calls/:id/brief')
  async brief(@Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).lean().exec();
    if (!call) throw new NotFoundException('Call not found');

    const [campaign, lead, flowVersion] = await Promise.all([
      this.campaignModel.findById(call.campaignId).lean().exec(),
      this.leadModel.findById(call.leadId).lean().exec(),
      call.flowVersionId ? this.flowVersionModel.findById(call.flowVersionId).lean().exec() : null,
    ]);
    if (!campaign || !lead) throw new NotFoundException('Call context missing');

    const vars: Record<string, unknown> = {
      firstName: lead.firstName ?? '',
      lastName: lead.lastName ?? '',
      suburb: lead.suburb ?? '',
      state: lead.state ?? '',
      clientName: campaign.name,
      ...lead.facts,
    };

    // Authoritative conversation prompt: the flow's AI_CONVERSATION node.
    const convoNode = flowVersion?.graph?.nodes?.find((n) => n.type === 'AI_CONVERSATION');
    const nodePrompt = convoNode?.config?.prompt ?? 'Qualify this lead in a friendly, natural way.';

    const pack = await this.packs.getByCode(campaign.countryPackCode).catch(() => null);
    const recordingDisclosure = pack?.disclosures?.recordingDisclosureText ?? 'This call may be recorded for quality and training purposes.';
    const aiDisclosure = interpolate(pack?.disclosures?.aiIdentificationText ?? "I'm a virtual assistant calling on behalf of {{clientName}}.", vars);

    const rebuttals = (campaign.rebuttals ?? []).map((r) => `- If they say "${r.objection}": ${r.rebuttal}`).join('\n');

    // Spoken instructions the worker's LLM speaks directly (no JSON envelope).
    const instructions = [
      interpolate(nodePrompt, vars),
      '',
      'CONVERSATION RULES:',
      '- Speak naturally, one short question at a time. Never sound like a form.',
      `- Your FIRST turn must disclose you are an AI and the call may be recorded: "${aiDisclosure} ${recordingDisclosure}" Then ask if now is a good time.`,
      '- Never re-ask something already answered.',
      '- If they object, acknowledge warmly and use the playbook below; never argue.',
      '- When the person clearly qualifies and wants to proceed, call the request_transfer tool to bring in a human specialist.',
      '- If they ask to stop or say do-not-call, apologise, confirm removal, and end the call.',
      rebuttals ? `\nOBJECTION PLAYBOOK:\n${rebuttals}` : '',
    ]
      .filter((l) => l !== '')
      .join('\n');

    return {
      callId: id,
      tenantId: call.tenantId.toString(),
      campaignId: campaign._id.toString(),
      leadId: lead._id.toString(),
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'there',
      leadPhone: lead.phone,
      clientName: campaign.name,
      transcriptionMode: campaign.transcriptionMode,
      transferAcceptWindowSeconds: campaign.transferAcceptWindowSeconds,
      firstTurnHint: `Greet ${vars.firstName || 'them'}, give the AI + recording disclosure in one sentence, and ask if now is a good moment.`,
      instructions,
    };
  }

  /**
   * Live-voice-demo turn stream: the worker posts each spoken line here so
   * the floor feed and a bridged agent's briefing see the same live summary
   * the simulation path produces via FlowExecutorService's `onLine`/`onSummary`
   * hooks — this is the LiveKit-worker equivalent of those hooks.
   */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/transcript')
  async transcript(@Param('id') id: string, @Body() dto: TranscriptTurnDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).exec();
    if (!call) throw new NotFoundException('Call not found');

    const atMs = Date.now() - call.startedAt.getTime();
    call.transcript.push({
      leg: call.agentId ? 'HUMAN' : 'AI',
      speaker: dto.speaker,
      text: dto.text,
      redactedText: redactPii(dto.text),
      startMs: atMs,
      endMs: atMs,
    });
    await call.save();

    const tenantId = call.tenantId.toString();
    const agentId = call.agentId?.toString() ?? null;
    this.gateway.streamTranscript(
      tenantId,
      agentId,
      { callId: id, leg: call.agentId ? 'HUMAN' : 'AI', speaker: dto.speaker, text: redactPii(dto.text), startMs: atMs, endMs: atMs, final: true },
      'BOTH',
    );

    // New facts only ever come from what the lead says — skip the extraction
    // call on the AI's own turns to halve the LLM traffic.
    // shouldTransfer mirrors the simulation path's gate exactly
    // (FlowExecutorService: `scoreAction(...) === 'TRANSFER'`) — the worker
    // must not decide "this lead qualifies" purely on the LLM's own vibes,
    // the same real campaign-weighted score gates both paths.
    const shouldTransfer = dto.speaker === 'customer' ? await this.recomposeSummary(call) : false;
    return { ok: true, shouldTransfer };
  }

  /**
   * Extracts the campaign's configured facts (`campaign.scoring.weights`
   * keys) from the transcript-so-far via the PAL `SUMMARY` LLM role, then
   * renders `campaign.summaryTemplate` exactly like
   * `FlowExecutorService.renderSummary` does for the simulation path — same
   * summary shape everywhere, not a raw transcript dump. Returns whether the
   * campaign's own scoring threshold now says this lead qualifies to transfer.
   */
  private async recomposeSummary(call: CallDocument): Promise<boolean> {
    const [lead, campaign] = await Promise.all([
      this.leadModel.findById(call.leadId).exec(),
      this.campaignModel.findById(call.campaignId).lean().exec(),
    ]);
    if (!lead || !campaign) return false;

    const factKeys = Object.keys(campaign.scoring.weights);
    // Several standard fact keys are double-negatives or otherwise ambiguous
    // from the bare key name alone (e.g. "noPanels: true" means the customer
    // does NOT have panels) — an unqualified key list led the extraction LLM
    // to silently drop `noPanels` even when the transcript clearly stated it,
    // under-scoring an otherwise-qualified lead below the transfer threshold.
    const FACT_GLOSSARY: Record<string, string> = {
      owner: 'true if the customer owns the home',
      noPanels: 'true if the customer does NOT already have solar panels installed (i.e. "no panels" is a good thing here — set true when they confirm they have none)',
      billHigh: 'true if the customer describes their power/electricity bill as high or expensive',
      dwellingHouse: 'true if the customer lives in a house (standalone dwelling), false/omit if apartment/unit',
      roofSuitable: 'true if the customer\'s roof is described as suitable for solar (unshaded, good condition, etc.)',
      appointmentInterest: 'true if the customer is willing to book a free assessment/appointment',
    };
    const factDescriptions = factKeys.map((k) => `- ${k}: ${FACT_GLOSSARY[k] ?? '(campaign-specific fact, infer from its name)'}`).join('\n');
    const transcriptText = call.transcript.map((t) => `${t.speaker === 'ai' ? 'AI' : 'Lead'}: ${t.redactedText}`).join('\n');
    const extractionPrompt = [
      'You are extracting structured facts from a live outbound sales call transcript so far.',
      'Facts to look for (booleans, only include a key if the transcript gives clear evidence either way) — read each definition carefully, some are double-negatives:',
      factDescriptions,
      'Also extract: objection (a short snake_case label for the customer\'s most recent unresolved objection, or null) and appointmentSlot (a short human time description if one was proposed, or null).',
      'Reply with ONLY a JSON object: {"facts": {...}, "objection": string|null, "appointmentSlot": string|null}. Omit fact keys with no evidence yet.',
    ].join('\n');

    let extracted: { facts?: Record<string, boolean>; objection?: string | null; appointmentSlot?: string | null };
    try {
      const completion = await this.pal.llm(
        { tenantId: call.tenantId.toString(), campaignId: call.campaignId.toString(), llmRole: 'SUMMARY' },
        {
          messages: [
            { role: 'system', content: extractionPrompt },
            { role: 'user', content: transcriptText },
          ],
          jsonMode: true,
          temperature: 0,
          maxTokens: 300,
        },
      );
      extracted = JSON.parse(completion.text);
    } catch {
      // A failed/unparseable extraction shouldn't break the call — the prior
      // summary just doesn't advance this turn.
      return false;
    }

    if (extracted.facts) {
      for (const [key, value] of Object.entries(extracted.facts)) {
        if (typeof value === 'boolean') lead.facts[key] = value;
      }
    }
    if (extracted.appointmentSlot) lead.facts['appointmentSlot'] = extracted.appointmentSlot;
    await lead.save();

    if (extracted.objection) {
      const known = call.objections.find((o) => o.label === extracted.objection);
      if (!known) call.objections.push({ label: extracted.objection, recovered: false });
    } else {
      for (const o of call.objections) o.recovered = true;
    }

    const score = computeScore(campaign.scoring, lead.facts);
    call.finalScore = score;

    const name = lead.firstName ?? 'there';
    const openObjection = call.objections.find((o) => !o.recovered)?.label ?? 'none';
    const opener = lead.facts['appointmentInterest']
      ? `Hi ${name}, I hear you're keen to find a time — let's lock one in.`
      : `Hi ${name}, thanks for your time — I can answer any questions and sort the details.`;
    call.summary = interpolate(campaign.summaryTemplate, {
      firstName: lead.firstName ?? '',
      suburb: lead.suburb ?? '',
      score,
      facts: Object.entries(lead.facts)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join('; '),
      objection: openObjection,
      opener,
    });
    await call.save();

    const tenantId = call.tenantId.toString();
    const agentId = call.agentId?.toString() ?? null;
    this.gateway.updateSummary(tenantId, agentId, call._id.toString(), call.summary);
    this.gateway.updateFloorCall(tenantId, {
      callId: call._id.toString(),
      leadId: lead._id.toString(),
      campaignId: campaign._id.toString(),
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone,
      state: call.state,
      currentStage: 'live-voice-demo',
      score,
      startedAt: call.startedAt.getTime(),
      claimable: score >= campaign.scoring.thresholds.bookOnly,
    });

    return scoreAction(campaign.scoring, score) === 'TRANSFER';
  }

  /**
   * Worker calls this when its `request_transfer` tool fires. Runs the exact
   * same cascade/card/bridge logic as the simulation path
   * (`TransfersService.requestTransfer`) so a live-voice-demo transfer looks
   * identical to the workspace UI.
   */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/transfer')
  async transfer(@Param('id') id: string, @Body() dto: TransferRequestDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).exec();
    if (!call) throw new NotFoundException('Call not found');
    const campaign = await this.campaignModel.findById(call.campaignId).lean().exec();
    if (!campaign) throw new NotFoundException('Campaign not found');

    call.state = 'TRANSFER_PENDING';
    await call.save();
    this.gateway.updateSummary(call.tenantId.toString(), null, id, `Transfer requested: ${dto.reason}`);

    const result = await this.transfers.requestTransfer({
      callId: id,
      whisperEnabled: campaign.whisperEnabled,
      acceptWindowSeconds: campaign.transferAcceptWindowSeconds,
    });
    return { result };
  }
}
