import { Body, Controller, Get, Logger, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AMD_CLASSES, computeScore, redactPii, scoreAction, type AmdClass } from '@cocally/shared';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Model, Types } from 'mongoose';
import { Public } from '../../common/auth/public.decorator';
import { ServiceTokenGuard } from '../../common/auth/service-token.guard';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { FlowVersion, FlowVersionDocument } from '../../schemas/flow.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { SuppressionService } from '../leads/suppression.service';
import { PalService } from '../providers/pal.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { TransfersService } from '../workspace/transfers.service';
import { SchedulingService } from '../leads/scheduling.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { interpolate } from './runtime';

/**
 * Server-side opt-out detection. Deliberately the SAME pattern as
 * `FlowExecutorService`'s, so the simulation path and the live LiveKit path
 * cannot drift into disagreeing about what "take me off your list" looks like.
 *
 * This exists because until now the live path had no opt-out rail at all: the
 * only thing standing between a customer saying "do not call me" and being
 * called again tomorrow was a single line in the LLM's prompt asking it to be
 * polite about it. A prompt is not a compliance control — it is a suggestion
 * with a temperature setting. This is the control.
 */
const OPT_OUT_PATTERN =
  /\b(don'?t (call|ring|contact|phone)( me)?( again| back)?|do not (call|ring|contact)|stop (calling|ringing)|remove me|take me off|unsubscribe|no more calls|delete my (number|details)|do[ -]not[ -]call (list|register)|not interested in (any|being) call)/i;

/** Spoken when an opt-out rail fires. Matches the simulation path's wording. */
const OPT_OUT_CLOSING_LINE =
  'Understood — I have removed you from our list. Sorry to have bothered you. Goodbye.';

/**
 * Keypad digit treated as "remove me from your list".
 *
 * Read from the environment rather than `config.ts` only because that file is
 * owned elsewhere this cycle — it belongs in `config.compliance.dtmfOptOutDigit`
 * next to the other floor settings. Default `9` matches the phrasing every AU
 * outbound script already uses ("press 9 to be removed").
 */
const DTMF_OPT_OUT_DIGIT = (process.env['DTMF_OPT_OUT_DIGIT'] ?? '9').trim() || '9';

class TranscriptTurnDto {
  @IsIn(['ai', 'customer'])
  speaker: 'ai' | 'customer';

  @IsString()
  @IsNotEmpty()
  text: string;
}

class TurnMetricsDto {
  @IsInt() @Min(0) eouDelayMs: number;
  @IsInt() @Min(0) transcriptionDelayMs: number;
  @IsInt() @Min(0) llmTtftMs: number;
  @IsInt() @Min(0) ttsTtfbMs: number;
  @IsInt() @Min(0) totalMs: number;
  @IsOptional() @IsString() @MaxLength(80) llmModel?: string;
  @IsOptional() @IsString() @MaxLength(40) ttsProvider?: string;
}

class ComplianceEventDto {
  @IsIn(['RECORDING_DISCLOSURE', 'AI_IDENTIFICATION', 'OPT_OUT_OFFERED', 'CONSENT'])
  kind: 'RECORDING_DISCLOSURE' | 'AI_IDENTIFICATION' | 'OPT_OUT_OFFERED' | 'CONSENT';

  @IsString()
  @MaxLength(500)
  detail: string;
}

class TransferRequestDto {
  @IsString()
  reason: string;
}

class DtmfDto {
  /** A single keypad symbol as the carrier reports it. */
  @IsString()
  @Matches(/^[0-9*#]$/, { message: 'digit must be a single keypad symbol (0-9, * or #)' })
  digit: string;
}

class AmdReportDto {
  @IsIn(AMD_CLASSES)
  amdClass: AmdClass;

  /** Ms from answer to classification. Optional so a late reclassification can omit it. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60_000)
  latencyMs?: number;
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
  private readonly logger = new Logger(EngineController.name);

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(FlowVersion.name) private readonly flowVersionModel: Model<FlowVersionDocument>,
    private readonly packs: CountryPacksService,
    private readonly gateway: RealtimeGateway,
    private readonly transfers: TransfersService,
    private readonly pal: PalService,
    private readonly suppression: SuppressionService,
    private readonly scheduling: SchedulingService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Public()
  @UseGuards(ServiceTokenGuard)
  @Get('calls/:id/brief')
  async brief(@Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).lean().exec();
    if (!call) throw new NotFoundException('Call not found');
    // A manual (human) dial or a predictive bridge has no AI leg. The worker
    // auto-joins every room LiveKit creates, so it must be told to leave
    // rather than speak its disclosure over a human agent's call.
    if (call.manual || call.agentId || !call.flowVersionId) {
      return { callId: id, manual: true, instructions: null };
    }

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
      /** Spoken verbatim by the worker before the LLM's first turn, and logged as a compliance event. */
      disclosureLine: `${campaign.aiSelfIdentification ? `Hi ${vars.firstName || 'there'}. ${aiDisclosure} ${recordingDisclosure}` : `Hi ${vars.firstName || 'there'}. ${recordingDisclosure}`} Is now a good moment for a quick chat?`,
      instructions,
    };
  }

  /**
   * Per-turn voice latency from the worker: end-of-utterance → LLM first
   * token → TTS first byte. Stored on the call so p50/p95 show on the
   * dashboard and a slow call can be found from the Calls page.
   */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/metrics')
  async metrics(@Param('id') id: string, @Body() dto: TurnMetricsDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const res = await this.callModel
      .updateOne(
        { _id: new Types.ObjectId(id) },
        {
          $push: {
            'timings.turnLatencies': dto.totalMs,
            'timings.turns': {
              $each: [{ at: new Date(), eou: dto.eouDelayMs, stt: dto.transcriptionDelayMs, llm: dto.llmTtftMs, tts: dto.ttsTtfbMs, total: dto.totalMs }],
              $slice: -200,
            },
          },
          $min: { 'timings.ttsFirstByte': dto.ttsTtfbMs, 'timings.sttFirstPartial': dto.transcriptionDelayMs },
          ...(dto.llmModel || dto.ttsProvider
            ? { $set: { ...(dto.llmModel ? { 'providersUsed.llm': dto.llmModel } : {}), ...(dto.ttsProvider ? { 'providersUsed.tts': dto.ttsProvider } : {}) } }
            : {}),
        },
      )
      .exec();
    if (res.matchedCount === 0) throw new NotFoundException('Call not found');
    if (dto.totalMs > 1500) this.logger.warn(`slow AI turn on call ${id}: ${dto.totalMs} ms (eou ${dto.eouDelayMs}, llm ${dto.llmTtftMs}, tts ${dto.ttsTtfbMs})`);
    return { ok: true };
  }

  /** Worker-reported compliance events (the scripted disclosure, an IVR opt-out prompt…). */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/compliance')
  async compliance(@Param('id') id: string, @Body() dto: ComplianceEventDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).select('startedAt').lean().exec();
    if (!call) throw new NotFoundException('Call not found');
    await this.callModel
      .updateOne(
        { _id: call._id },
        { $push: { complianceEvents: { atMs: Date.now() - call.startedAt.getTime(), kind: dto.kind, detail: dto.detail } } },
      )
      .exec();
    return { ok: true };
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
    const turn = {
      leg: call.agentId ? ('HUMAN' as const) : ('AI' as const),
      speaker: dto.speaker,
      text: dto.text,
      redactedText: redactPii(dto.text),
      startMs: atMs,
      endMs: atMs,
    };
    // Atomic append: the AI's and the customer's turns arrive concurrently,
    // and a load-modify-save on the same document raced into VersionErrors
    // that dropped turns (and the opt-out check for them).
    await this.callModel.updateOne({ _id: call._id }, { $push: { transcript: turn } }).exec();
    call.transcript.push(turn);

    const tenantId = call.tenantId.toString();
    const agentId = call.agentId?.toString() ?? null;
    this.gateway.streamTranscript(
      tenantId,
      agentId,
      { callId: id, leg: call.agentId ? 'HUMAN' : 'AI', speaker: dto.speaker, text: redactPii(dto.text), startMs: atMs, endMs: atMs, final: true },
      'BOTH',
    );

    // ── Opt-out rail ────────────────────────────────────────────────────
    // Evaluated on EVERY inbound customer turn, entirely server-side, and
    // ahead of the extraction/scoring work below so an opt-out never spends an
    // LLM call or gets a chance to be scored as a transfer. The suppression
    // write happens whether or not the LLM notices, whether or not it obeys
    // its prompt, and whether or not the worker is still healthy enough to act
    // on the response — the turn itself is already recorded above, so the
    // transcript still shows what the customer actually said.
    if (dto.speaker === 'customer' && OPT_OUT_PATTERN.test(dto.text)) {
      await this.recordOptOut(call, 'OPT_OUT_DETECTED', `utterance on call ${id}: "${redactPii(dto.text)}"`);
      return { ok: true, shouldTransfer: false, optOut: true, closingLine: OPT_OUT_CLOSING_LINE };
    }

    // New facts only ever come from what the lead says — skip the extraction
    // call on the AI's own turns to halve the LLM traffic.
    // shouldTransfer mirrors the simulation path's gate exactly
    // (FlowExecutorService: `scoreAction(...) === 'TRANSFER'`) — the worker
    // must not decide "this lead qualifies" purely on the LLM's own vibes,
    // the same real campaign-weighted score gates both paths.
    const shouldTransfer = dto.speaker === 'customer' ? await this.recomposeSummary(call) : false;
    return { ok: true, shouldTransfer, optOut: false, closingLine: null };
  }

  /**
   * Keypad opt-out rail.
   *
   * The spoken rail above still depends on STT hearing the words and on the
   * regex matching however the customer phrased it. This one depends on
   * nothing but a DTMF tone: the customer presses a digit, the carrier reports
   * it, we suppress. It is the only opt-out path on the platform with no
   * model, no transcription and no prompt anywhere in it — which is exactly
   * why an AU floor needs it.
   *
   * Non-opt-out digits are acknowledged and ignored: the worker also uses this
   * route for IVR navigation, and rejecting them would make it look broken.
   */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/dtmf')
  async dtmf(@Param('id') id: string, @Body() dto: DtmfDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).exec();
    if (!call) throw new NotFoundException('Call not found');

    if (dto.digit !== DTMF_OPT_OUT_DIGIT) {
      return { ok: true, optOut: false, closingLine: null };
    }

    await this.recordOptOut(call, 'DTMF_OPT_OUT', `customer pressed "${dto.digit}" on call ${id}`);
    return { ok: true, optOut: true, closingLine: OPT_OUT_CLOSING_LINE };
  }

  /**
   * Answering-machine detection result, reported by the worker.
   *
   * The worker classifies from the FIRST STT partial — roughly 400ms after
   * audio starts — instead of waiting 2-4s for a carrier-side classifier.
   * That difference is the whole ballgame on an outbound floor: a human who
   * hears two seconds of silence has already decided the call is a robocall.
   *
   * Persisting `amdClass`/`amdLatencyMs` is also what finally puts real data
   * behind the CLI health heuristics, which until now were reasoning about
   * answer rates with no idea whether the answers were humans or voicemail.
   */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/amd')
  async amd(@Param('id') id: string, @Body() dto: AmdReportDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).exec();
    if (!call) throw new NotFoundException('Call not found');

    call.amdClass = dto.amdClass;
    if (dto.latencyMs !== undefined) call.amdLatencyMs = dto.latencyMs;
    // The call state machine is owned by the orchestrator and the LiveKit
    // webhook receiver; this route only reports what answered, it does not
    // advance or terminate the call. Voicemail policy (drop / hang up) stays
    // with whoever owns the flow.
    await call.save();

    this.logger.log(`call ${id} AMD=${dto.amdClass}${dto.latencyMs !== undefined ? ` in ${dto.latencyMs}ms` : ''}`);
    return { ok: true, amdClass: call.amdClass, amdLatencyMs: call.amdLatencyMs ?? null };
  }

  /**
   * The shared tail of both opt-out rails: suppress the number, stamp the
   * compliance event, mark the outcome.
   *
   * The suppression write goes first and is awaited. If anything after it
   * throws, the customer is still suppressed — the ordering is chosen so the
   * only way to lose is to lose the audit trail, never the opt-out itself.
   */
  private async recordOptOut(
    call: CallDocument,
    kind: 'OPT_OUT_DETECTED' | 'DTMF_OPT_OUT',
    detail: string,
  ): Promise<void> {
    const lead = await this.leadModel.findById(call.leadId, { phone: 1 }).lean().exec();
    const tenantId = call.tenantId.toString();
    if (lead?.phone) {
      await this.suppression.optOut(tenantId, lead.phone, detail);
    } else {
      this.logger.error(`opt-out on call ${call._id.toString()} could not resolve a phone number — NOT suppressed`);
    }

    call.complianceEvents.push({ atMs: Date.now() - call.startedAt.getTime(), kind, detail });
    call.outcome = 'OPT_OUT';
    await call.save();
    this.logger.warn(`opt-out (${kind}) recorded on call ${call._id.toString()}`);
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
    // Objections still open, so the model can only ever mark one of THESE as
    // resolved — it cannot invent a rebuttal win for an objection that was
    // never raised.
    const openObjections = call.objections.filter((o) => !o.recovered).map((o) => o.label);
    const extractionPrompt = [
      'You are extracting structured facts from a live outbound sales call transcript so far.',
      'Facts to look for (booleans, only include a key if the transcript gives clear evidence either way) — read each definition carefully, some are double-negatives:',
      factDescriptions,
      'Also extract: objection (a short snake_case label for the customer\'s most recent unresolved objection, or null) and appointmentSlot (a short human time description if one was proposed, or null).',
      openObjections.length > 0
        ? `Currently unresolved objections: ${openObjections.join(', ')}. Set resolvedObjection to EXACTLY one of those labels only if the transcript shows the customer explicitly accepted the rebuttal or dropped that concern and moved on. Silence, a change of subject, or simply not repeating the objection is NOT resolution — return null in those cases.`
        : 'There are no unresolved objections yet; return null for resolvedObjection.',
      'Reply with ONLY a JSON object: {"facts": {...}, "objection": string|null, "resolvedObjection": string|null, "appointmentSlot": string|null}. Omit fact keys with no evidence yet.',
    ].join('\n');

    let extracted: {
      facts?: Record<string, boolean>;
      objection?: string | null;
      resolvedObjection?: string | null;
      appointmentSlot?: string | null;
    };
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
          // Structured extraction, not conversation: the small/fast model is
          // plenty and keeps the big model's rate limit for the live voice turn.
          speedTier: 'fast',
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
    }

    // ── Rebuttal win-rate, fixed ────────────────────────────────────────
    // This used to be `else { for (const o of call.objections) o.recovered = true; }`
    // — i.e. the moment a turn came back with no *current* objection, every
    // objection ever raised on the call was retroactively declared recovered.
    // Since a call almost always ends on a turn with no live objection, the
    // rebuttal win-rate on DASH-03 was structurally pinned at ~100% and told
    // nobody anything. "The customer stopped repeating it" is not a rebuttal
    // win; it is just as often the sound of someone giving up on the call.
    //
    // Recovery is now only recorded when the extraction names a specific
    // previously-open objection as explicitly accepted or dropped, chosen from
    // the list of open labels we hand it. Anything ambiguous stays
    // unrecovered — an under-reported win rate is a usable metric, an
    // always-100% one is not.
    if (extracted.resolvedObjection) {
      const resolved = call.objections.find((o) => o.label === extracted.resolvedObjection && !o.recovered);
      if (resolved) resolved.recovered = true;
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
    const tenantId = call.tenantId.toString();
    if (result === 'BRIDGED') {
      await this.webhooks.dispatch(tenantId, 'lead.qualified', { leadId: call.leadId.toString(), callId: id, score: call.finalScore });
      await this.webhooks.dispatch(tenantId, 'transfer.accepted', { leadId: call.leadId.toString(), callId: id });
    } else {
      // Nobody free: the AI promises a callback, so make it a real one the
      // closer worklist will surface, and put the call back in conversation
      // so the floor card stops showing a pending transfer.
      await this.callModel.updateOne({ _id: call._id, state: 'TRANSFER_PENDING' }, { state: 'IN_CONVERSATION' }).exec();
      await this.scheduling
        .scheduleCallback({
          tenantId,
          leadId: call.leadId.toString(),
          campaignId: call.campaignId.toString(),
          dueAt: new Date(Date.now() + 10 * 60_000),
          handler: 'HUMAN',
          notes: `AI-qualified (score ${call.finalScore}); no closer free at transfer time.`,
        })
        .catch((err: Error) => this.logger.warn(`could not schedule callback for call ${id}: ${err.message}`));
    }
    return { result };
  }
}
