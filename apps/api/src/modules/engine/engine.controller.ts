import { Body, Controller, Get, Logger, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AMD_CLASSES, computeScore, redactPii, scoreAction, type AmdClass } from '@cocally/shared';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Model, Types } from 'mongoose';
import { Public } from '../../common/auth/public.decorator';
import { ServiceTokenGuard } from '../../common/auth/service-token.guard';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { FlowVersion, FlowVersionDocument } from '../../schemas/flow.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { Client, ClientDocument, Tenant, TenantDocument } from '../../schemas/tenant.schema';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { SuppressionService } from '../leads/suppression.service';
import { PalService } from '../providers/pal.service';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { TransfersService } from '../workspace/transfers.service';
import { SchedulingService } from '../leads/scheduling.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { OPT_OUT_CLOSING_LINE, OPT_OUT_PATTERN } from './lines';
import { interpolate } from './runtime';

/**
 * Server-side opt-out detection (pattern shared with the simulation path, see
 * `lines.ts`). A prompt is not a compliance control — it is a suggestion with
 * a temperature setting. This is the control.
 */
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
  @IsOptional() @IsString() @MaxLength(40) sttModel?: string;
  /** Provider/model that actually produced this turn (differs from llmModel when a fallback served it). */
  @IsOptional() @IsString() @MaxLength(80) llmServed?: string;
  @IsOptional() @IsInt() @Min(0) promptTokens?: number;
  /** Provider/model that produced the voice for this turn. */
  @IsOptional() @IsString() @MaxLength(80) ttsServed?: string;
  /** Customer stops speaking → AI's first audio, measured directly (stages overlap, so this is less than their sum). */
  @IsOptional() @IsInt() @Min(0) heardMs?: number;
}

export const CALL_EVENT_KINDS = ['answered', 'greeting', 'stall_guard', 'transfer', 'llm_fallback', 'net_provider', 'net_media', 'worker_log', 'out_of_area'] as const;

class CallEventDto {
  @IsIn(CALL_EVENT_KINDS) kind: (typeof CALL_EVENT_KINDS)[number];
  @IsOptional() @IsInt() @Min(0) @Max(3_600_000) ms?: number;
  @IsOptional() @IsString() @MaxLength(200) detail?: string;
  /** Network samples: provider host / pipeline stage, media jitter and inbound packet loss. */
  @IsOptional() @IsString() @MaxLength(80) host?: string;
  @IsOptional() @IsIn(['stt', 'llm', 'tts']) stage?: 'stt' | 'llm' | 'tts';
  @IsOptional() @IsNumber() @Min(0) @Max(60_000) jitterMs?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) lossPct?: number;
  /** worker_log only: a batch of log lines, so the worker posts once a second, not once a line. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(200, { each: true }) lines?: string[];
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

class CallbackRequestDto {
  /** ISO 8601 with offset, in the customer's local time, e.g. 2026-10-13T17:00:00+05:30. */
  @IsString()
  @IsNotEmpty()
  when: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

class OptOutRequestDto {
  /** What the customer said, in the model's words (for the audit trail). */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
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
 * post-call. See claude-dev/archive/2026-07/2026-07-19-live-call-build-plan.md.
 */
@Controller('engine')
export class EngineController {
  private readonly logger = new Logger(EngineController.name);

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(FlowVersion.name) private readonly flowVersionModel: Model<FlowVersionDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
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

    // The AI introduces itself "on behalf of {{clientName}}". That is the
    // client's brand, never the campaign name — otherwise it says "calling on
    // behalf of Wendy test (India)" to a real customer.
    const client = campaign.clientId ? await this.clientModel.findById(campaign.clientId).select('name').lean().exec() : null;
    const clientName = client?.name ?? campaign.name;
    const address = [lead.suburb, lead.state, lead.postcode].filter(Boolean).join(', ');
    const vars: Record<string, unknown> = {
      firstName: lead.firstName ?? '',
      lastName: lead.lastName ?? '',
      suburb: lead.suburb ?? '',
      state: lead.state ?? '',
      postcode: lead.postcode ?? '',
      // Suburb/state/postcode only — leads carry no street line, so the read-back is a locality check.
      address,
      clientName,
      ...lead.facts,
    };

    // Authoritative conversation prompt: the flow's AI_CONVERSATION node.
    const convoNode = flowVersion?.graph?.nodes?.find((n) => n.type === 'AI_CONVERSATION');
    const nodePrompt = convoNode?.config?.prompt ?? 'Qualify this lead in a friendly, natural way.';

    const pack = await this.packs.getByCode(campaign.countryPackCode).catch(() => null);
    const recordingDisclosure = pack?.disclosures?.recordingDisclosureText ?? 'This call may be recorded for quality and training purposes.';
    const aiDisclosure = interpolate(pack?.disclosures?.aiIdentificationText ?? "I'm a virtual assistant calling on behalf of {{clientName}}.", vars);

    const rebuttals = (campaign.rebuttals ?? []).map((r) => `- If they say "${r.objection}": ${r.rebuttal}`).join('\n');
    const promptText = interpolate(nodePrompt, vars);
    // Tagged script lines (`[S2] "..."` in the flow prompt or the playbook).
    // The model answers with the tag and the worker speaks the line itself,
    // word for word: an LLM asked to copy a sentence paraphrases it, and a
    // stalled stream cut lines off mid-word (7 Oct, "One more - do").
    const scriptLines: Record<string, string> = {};
    for (const m of `${promptText}\n${rebuttals}`.matchAll(/\[([A-Z]\d{1,2}Q?)\]\s*"([^"]+)"/g)) {
      scriptLines[m[1]!] ??= m[2]!.trim();
    }

    // The flow owns the words. Its mandatory SPEAK node (the one publishing
    // requires) is the opening line, and the TRANSFER node's `announceText` is
    // the hand-off line; both are spoken verbatim by the worker. Without them
    // the pack's generic disclosure and the worker's default hand-off apply.
    const graphNodes = (flowVersion?.graph?.nodes ?? []) as Array<{ type: string; mandatory?: boolean; config?: Record<string, unknown> }>;
    const openingText = graphNodes.find((n) => n.mandatory && n.type === 'SPEAK' && typeof n.config?.text === 'string')?.config?.text as string | undefined;
    const openingLine = openingText ? interpolate(openingText, vars).trim() : null;
    const announceText = graphNodes.find((n) => n.type === 'TRANSFER')?.config?.announceText;
    const transferLine = typeof announceText === 'string' && announceText.trim() ? interpolate(announceText, vars).trim() : null;
    const tz = lead.timezone || 'UTC';
    let localNow: string;
    // The offset in words ("UTC+11:00"): left to work it out from the zone
    // name, the model booked Melbourne callbacks at +10:30 (25 Oct eval).
    let utcOffset = 'UTC';
    try {
      localNow = new Intl.DateTimeFormat('en-AU', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
      const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value;
      if (part) utcOffset = part.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC+00:00');
    } catch {
      localNow = new Date().toISOString();
    }

    // Spoken instructions the worker's LLM speaks directly (no JSON envelope).
    const instructions = [
      promptText,
      '',
      'CONVERSATION RULES:',
      '- Speak naturally, one short question at a time. Never sound like a form.',
      // The worker speaks the scripted disclosure itself before the LLM's first
      // turn (see `disclosureLine`). Telling the model to disclose "on its first
      // turn" made it re-introduce itself on turn two of real calls (28 Sep).
      // Keep the client/campaign name out of this line: with it in, the model
      // addressed the customer by the campaign name ("Are you Wendy Test India
      // who looks after…", 28 Sep). The person is `firstName`, nobody else.
      openingLine
        ? `- The person you are speaking to is ${vars.firstName || 'the customer'}. You have ALREADY said: "${openingLine}" Never repeat that opening line.`
        : `- The person you are speaking to is ${vars.firstName || 'the customer'}. You have ALREADY greeted them, said you are an AI assistant and that the call may be recorded. Never repeat that introduction unless they ask who you are; if they do, answer in one short sentence: "${aiDisclosure}"`,
      '- Say scripted lines word for word. Anything you say off-script stays under 25 words: at most one short acknowledgement, then the next scripted step.',
      '- Never re-ask something already answered.',
      '- If they object, acknowledge warmly and use the playbook below; never argue.',
      transferLine
        ? '- When the script says to connect them, call the request_transfer tool and say nothing yourself: the hand-off line is spoken for you.'
        : '- When the person clearly qualifies and wants to proceed, call the request_transfer tool to bring in a human specialist.',
      `- To book a callback, call schedule_callback with the time they chose as ISO 8601 including their UTC offset. Only once THEY have said a day or time; never suggest or guess one. It is now ${localNow} for them (${tz}, ${utcOffset}); use offset ${utcOffset.replace('UTC', '')}. Confirm the time back to them in words.`,
      '- When the script ends the call (after your goodbye line), call the end_call tool.',
      "- If they ask not to be called, mention the Do Not Call Register, or threaten a complaint, call the opt_out tool and say nothing yourself: the closing line is spoken for you and their number is suppressed.",
      Object.keys(scriptLines).length
        ? `- SCRIPTED LINES ARE TAGGED like [S2]. To say one, output ONLY its tag, e.g. [S2], and nothing else; it is spoken for you word for word. To answer a question and then carry on, output both tags, e.g. [Q1] [S3]. Never output two S tags in one turn: say one step, then wait for their answer. Write your own words only when no tagged line fits, and keep them under 25 words.`
        : '',
      rebuttals ? `\nOBJECTION PLAYBOOK:\n${rebuttals}` : '',
    ]
      .filter((l) => l !== '')
      .join('\n');

    const tenant = await this.tenantModel.findById(call.tenantId).select('voice').lean().exec();

    return {
      callId: id,
      tenantId: call.tenantId.toString(),
      campaignId: campaign._id.toString(),
      leadId: lead._id.toString(),
      leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'there',
      leadPhone: lead.phone,
      clientName,
      transcriptionMode: campaign.transcriptionMode,
      transferAcceptWindowSeconds: campaign.transferAcceptWindowSeconds,
      firstTurnHint: `Greet ${vars.firstName || 'them'}, give the AI + recording disclosure in one sentence, and ask if now is a good moment.`,
      /** Spoken verbatim by the worker before the LLM's first turn, and logged as a compliance event. */
      disclosureLine: openingLine ?? `${campaign.aiSelfIdentification ? `Hi ${vars.firstName || 'there'}. ${aiDisclosure} ${recordingDisclosure}` : `Hi ${vars.firstName || 'there'}. ${recordingDisclosure}`} Is now a good moment for a quick chat?`,
      instructions,
      /** Spoken verbatim by the worker when the transfer starts; null = its default line. */
      transferLine,
      /** Tag -> exact wording; the worker speaks these when the model outputs the tag. */
      scriptLines,
      /** Campaign words the STT should favour (retailer names etc). */
      sttKeywords: campaign.sttKeywords ?? [],
      /** Retailers to close politely instead of transferring, and the line for it. */
      outOfArea: (campaign.outOfAreaRetailers ?? []).length
        ? { retailers: campaign.outOfAreaRetailers, line: campaign.outOfAreaLine || 'Thank you, we cannot cater to your area. Bye, take care.' }
        : null,
      /** Said once to a call-screening assistant; null = none. */
      screeningLine: campaign.screeningLine || null,
      /** Tenant's AI voice (Platform screen); null = the worker's default. */
      voice: tenant?.voice ?? null,
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
              $each: [
                {
                  at: new Date(),
                  eou: dto.eouDelayMs,
                  stt: dto.transcriptionDelayMs,
                  llm: dto.llmTtftMs,
                  tts: dto.ttsTtfbMs,
                  total: dto.totalMs,
                  ...(dto.llmServed ? { llmServed: dto.llmServed } : {}),
                  ...(dto.promptTokens !== undefined ? { promptTokens: dto.promptTokens } : {}),
                  ...(dto.ttsServed ? { ttsServed: dto.ttsServed } : {}),
                  ...(dto.heardMs !== undefined ? { heard: dto.heardMs } : {}),
                },
              ],
              $slice: -200,
            },
          },
          $min: { 'timings.ttsFirstByte': dto.ttsTtfbMs, 'timings.sttFirstPartial': dto.transcriptionDelayMs },
          ...(dto.llmModel || dto.ttsProvider || dto.sttModel
            ? {
                $set: {
                  ...(dto.llmModel ? { 'providersUsed.llm': dto.llmModel } : {}),
                  ...(dto.ttsProvider ? { 'providersUsed.tts': dto.ttsProvider } : {}),
                  ...(dto.sttModel ? { 'providersUsed.stt': dto.sttModel } : {}),
                },
              }
            : {}),
        },
      )
      .exec();
    if (res.matchedCount === 0) throw new NotFoundException('Call not found');
    if (dto.totalMs > 1500) this.logger.warn(`slow AI turn on call ${id}: ${dto.totalMs} ms (eou ${dto.eouDelayMs}, llm ${dto.llmTtftMs}, tts ${dto.ttsTtfbMs})`);
    return { ok: true };
  }

  /**
   * Call timeline events from the worker (answered, greeting, stall guard,
   * transfer). Shown with the per-turn timings in the ops console.
   */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/events')
  async events(@Param('id') id: string, @Body() dto: CallEventDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    if (dto.kind === 'worker_log') {
      // The worker's own INFO+ log lines for this call, so a failed test call
      // can be read from the call record without ssh to the VM. Own array,
      // last 500 lines: it must not crowd the 100-event timeline.
      const res = await this.callModel
        .updateOne(
          { _id: new Types.ObjectId(id) },
          {
            $push: {
              'timings.workerLog': {
                $each: (dto.lines?.length ? dto.lines : [dto.detail ?? '']).map((detail) => ({ at: new Date(), detail })),
                $slice: -500,
              },
            },
          },
        )
        .exec();
      if (res.matchedCount === 0) throw new NotFoundException('Call not found');
      return { ok: true };
    }
    const res = await this.callModel
      .updateOne(
        { _id: new Types.ObjectId(id) },
        {
          $push: {
            'timings.events': {
              $each: [
                {
                  at: new Date(),
                  kind: dto.kind,
                  ...(dto.ms !== undefined ? { ms: dto.ms } : {}),
                  ...(dto.detail ? { detail: dto.detail } : {}),
                  ...(dto.host ? { host: dto.host } : {}),
                  ...(dto.stage ? { stage: dto.stage } : {}),
                  ...(dto.jitterMs !== undefined ? { jitterMs: dto.jitterMs } : {}),
                  ...(dto.lossPct !== undefined ? { lossPct: dto.lossPct } : {}),
                },
              ],
              $slice: -100,
            },
          },
        },
      )
      .exec();
    if (res.matchedCount === 0) throw new NotFoundException('Call not found');
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
    // Keep the in-memory copy current for the extraction below, but tell
    // Mongoose the array is NOT dirty: `recomposeSummary` and `recordOptOut`
    // both `call.save()`, and a save after an in-memory push re-issues the
    // `$push` — every turn was landing in the transcript twice.
    call.transcript.push(turn);
    call.unmarkModified('transcript');

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
   * Model-initiated opt-out. The transcript rail above only catches phrasings
   * the regex knows; the model's playbook tells it to call `opt_out` for any
   * do-not-call request, so a paraphrase still suppresses the number. Same
   * tail as the other rails: suppress first, then the closing line.
   */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/opt-out')
  async optOut(@Param('id') id: string, @Body() dto: OptOutRequestDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).exec();
    if (!call) throw new NotFoundException('Call not found');
    if (call.outcome !== 'OPT_OUT') {
      await this.recordOptOut(call, 'OPT_OUT_DETECTED', `AI opt_out on call ${id}: ${redactPii(dto.reason ?? 'no reason given')}`);
    }
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
    // webhook receiver; this route does not terminate the call itself. It
    // tells the worker whether to hang up, per the campaign's voicemail policy.
    await call.save();

    // A mailbox is not a prospect: every second the AI keeps talking to one is
    // paid for (agent, STT, TTS, LLM, recording) and earns nothing. Hang up at
    // once unless the campaign wants the AI to leave a message. Neither
    // prerecorded drop nor AI drop plays on the live path yet, so only AI_DROP
    // keeps the AI on the line (it will speak to the tone like any turn).
    // Silence (nothing said for 10 s after our opening line) always hangs up.
    let hangup = dto.amdClass === 'SILENCE';
    if (dto.amdClass === 'VOICEMAIL') {
      const campaign = await this.campaignModel.findById(call.campaignId).select('voicemailPolicy').lean().exec();
      hangup = campaign?.voicemailPolicy !== 'AI_DROP';
    }

    this.logger.log(
      `call ${id} AMD=${dto.amdClass}${dto.latencyMs !== undefined ? ` in ${dto.latencyMs}ms` : ''}${hangup ? ' → hanging up' : ''}`,
    );
    return { ok: true, amdClass: call.amdClass, amdLatencyMs: call.amdLatencyMs ?? null, hangup };
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
  /**
   * What the customer actually said to the qualifying questions, for the
   * specialist's transfer card, so they do not re-ask ("I've already told the
   * guy all this", client call recordings 27 Oct). Only for flows that capture
   * a `retailer` (the energy script); null otherwise or on any failure.
   */
  private async handoffAnswers(call: CallDocument): Promise<Record<string, string> | null> {
    const flow = call.flowVersionId ? await this.flowVersionModel.findById(call.flowVersionId).lean().exec() : null;
    const node = flow?.graph?.nodes?.find((n) => n.type === 'AI_CONVERSATION');
    const capture = (node?.config?.captureVariables ?? []) as string[];
    if (!capture.includes('retailer')) return null;
    const transcriptText = call.transcript.map((t) => `${t.speaker === 'ai' ? 'AI' : 'Customer'}: ${t.redactedText}`).join('\n');
    if (!transcriptText.trim()) return null;
    const prompt = [
      "Extract the customer's answers from this Australian energy call transcript (speech-to-text, so names may be misheard).",
      'Reply with ONLY a JSON object of strings; omit a key the customer has not answered:',
      '- accountHolder: do they look after the electricity account ("Yes" / "No" / their words).',
      '- fuel: "Electricity only" or "Electricity and gas" (or their words).',
      '- bill: the amount and period in plain words, e.g. "About $400 per month". If they gave rates instead of a bill, the rates.',
      '- retailer: their current energy retailer, corrected for likely mishearings (PowerShell = Powershop, Simple Energy = Simply Energy, IGL = AGL, First Synergy / for Synergy = 1st Energy, Energy Australia = EnergyAustralia). If they named a network distributor (Jemena, CitiPower, Powercor, AusNet, United Energy, Ausgrid, Endeavour, Essential, SA Power Networks, Energex) write "<name> (distributor; retailer not known)". If they do not know, "Not sure".',
      '- retailerHeard: their exact words for the retailer, as transcribed.',
      '- other: anything else the specialist should know in under 20 words (a question they asked, solar, a second property, recently switched), or omit.',
    ].join('\n');
    const completion = await Promise.race([
      this.pal.llm(
        { tenantId: call.tenantId.toString(), campaignId: call.campaignId.toString(), llmRole: 'SUMMARY' },
        {
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: transcriptText },
          ],
          jsonMode: true,
          temperature: 0,
          maxTokens: 250,
          speedTier: 'fast',
        },
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('handoff extraction timed out')), 2500)),
    ]);
    const parsed = JSON.parse(completion.text) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of ['accountHolder', 'fuel', 'bill', 'retailer', 'retailerHeard', 'other']) {
      const v = parsed[k];
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 160);
    }
    return Object.keys(out).length ? out : null;
  }

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
      // Energy bill-review campaigns (see seeds/seed-test-campaign.ts ENERGY_SCORING).
      decisionMaker: 'true if the customer confirms they are the one who looks after / pays the energy bill',
      payingTooMuch: 'true if the customer feels they are paying too much for energy',
      notSwitchedRecently: 'true if the customer has NOT compared or changed energy providers in the last 6-12 months (set true when they say they have not)',
      wantsSpecialist: 'true if the customer agrees to be put through to a specialist now',
      billProvided: 'true once the customer gives a rough amount for their electricity bill (monthly or quarterly)',
      retailerProvided: 'true once the customer names the energy company they are currently with',
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
    // `facts` is a Mixed path: in-place writes are invisible to change tracking.
    lead.markModified('facts');
    const score = computeScore(campaign.scoring, lead.facts);
    lead.score = score;
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

    call.finalScore = score;

    const name = lead.firstName ?? 'there';
    const openObjection = call.objections.find((o) => !o.recovered)?.label ?? 'none';
    const opener = lead.facts['appointmentInterest']
      ? `Hi ${name}, I hear you're keen to find a time — let's lock one in.`
      : `Hi ${name}, thanks for your time — I can answer any questions and sort the details.`;
    call.summary = interpolate(campaign.summaryTemplate, {
      firstName: lead.firstName ?? '',
      suburb: lead.suburb ?? '',
      name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'unknown',
      location: [lead.suburb, lead.state].filter(Boolean).join(', ') || 'unknown area',
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
   * Worker calls this when its `schedule_callback` tool fires: the customer
   * asked to be called back at a time they chose. The AI dialler rings them
   * then (handler AI), replacing any outstanding callback for the lead.
   */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @Post('calls/:id/callback')
  async callback(@Param('id') id: string, @Body() dto: CallbackRequestDto) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(new Types.ObjectId(id)).lean().exec();
    if (!call) throw new NotFoundException('Call not found');
    const cb = await this.scheduling.scheduleCallback({
      tenantId: call.tenantId.toString(),
      leadId: call.leadId.toString(),
      campaignId: call.campaignId.toString(),
      dueAt: new Date(dto.when),
      handler: 'AI',
      notes: dto.note ? `Customer asked for a callback: ${dto.note}` : 'Customer asked for a callback.',
    });
    return { ok: true, dueAt: cb.dueAt };
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

    // The customer's actual answers for the specialist's card, read from the
    // transcript now: the retailer answer arrives in the same turn as the
    // transfer, before the per-turn extraction has caught up. Bounded; the
    // hold line is playing meanwhile.
    const answers = await this.handoffAnswers(call).catch(() => null);
    if (answers) {
      await this.leadModel.updateOne({ _id: call.leadId }, { $set: { 'facts.answers': answers } }).exec();
    }

    const result = await this.transfers.requestTransfer({
      callId: id,
      whisperEnabled: campaign.whisperEnabled,
      acceptWindowSeconds: campaign.transferAcceptWindowSeconds,
      ...(answers ? { facts: { answers } } : {}),
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
