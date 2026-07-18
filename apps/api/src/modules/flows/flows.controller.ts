import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DEFAULT_SCORING_CONFIG, flowGraphSchema, validateFlowGraph } from '@cocally/shared';
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { config } from '../../common/config';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.decorator';
import { FlowExecutorService } from '../engine/flow-executor.service';
import { composeSystemPrompt, exampleMessageAssembly, ENVELOPE_CONTRACT } from '../engine/prompt';
import { SimulationRuntime } from '../engine/simulation.runtime';
import { PalService } from '../providers/pal.service';
import { FlowGeneratorService } from './flow-generator.service';
import { FlowsService } from './flows.service';
import { SimSessionService } from './sim-session.service';

class CreateFlowDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsIn(['OUTBOUND', 'INBOUND'])
  direction?: 'OUTBOUND' | 'INBOUND';
}

class SaveDraftDto {
  @IsObject()
  graph: Record<string, unknown>;

  @IsOptional()
  @IsString()
  changeNote?: string;
}

class PublishDto {
  @IsOptional()
  @IsString()
  countryPackCode?: string;
}

class SimulateDto {
  @IsOptional()
  scriptedReplies?: string[];

  @IsOptional()
  @IsString()
  personaPrompt?: string;

  @IsOptional()
  @IsObject()
  leadVars?: Record<string, unknown>;
}

@Controller('flows')
export class FlowsController {
  constructor(
    private readonly flowsService: FlowsService,
    private readonly executor: FlowExecutorService,
    private readonly pal: PalService,
    private readonly simSessions: SimSessionService,
    private readonly generator: FlowGeneratorService,
  ) {}

  /**
   * Prompt → workflow: generate a complete flow from a plain-language
   * campaign description. The graph structure is deterministic (always valid
   * and executable); the LLM writes the content. The two default
   * call-handling steps — voicemail drop (TEL-05) and IVR keypress
   * (TEL-06) — are included per their toggles and remain editable nodes.
   * Saved immediately as a draft, ready in the editor.
   */
  @Post('generate')
  @Roles('ADMIN')
  async generateFlow(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      name: string;
      description: string;
      voicemailStep?: boolean;
      ivrKeypressStep?: boolean;
      ivrDigits?: string;
    },
  ) {
    const { graph, contentSource } = await this.generator.generate(user.tenantId, {
      name: body.name,
      description: body.description,
      voicemailStep: body.voicemailStep ?? true,
      ivrKeypressStep: body.ivrKeypressStep ?? true,
      ivrDigits: body.ivrDigits,
    });
    const flow = await this.flowsService.create(user.tenantId, { name: body.name });
    const draft = await this.flowsService.saveDraft(
      user.tenantId,
      flow._id.toString(),
      graph,
      `Generated from prompt (${contentSource})`,
    );
    return { flowId: flow._id.toString(), versionId: draft._id.toString(), contentSource, graph };
  }

  /**
   * Interactive test-drive per FLOW-05: starts the REAL executor against
   * this version's graph; it pauses at every listen() and the admin plays
   * the customer turn by turn. Returns the AI's opening lines and a session
   * id for replies.
   */
  @Post('versions/:versionId/test-drive')
  @Roles('ADMIN', 'SUPERVISOR')
  async startTestDrive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
    @Body() body: { amdClass?: 'HUMAN' | 'VOICEMAIL' | 'IVR'; transferResult?: 'BRIDGED' | 'NO_AGENT'; leadVars?: Record<string, unknown> },
  ) {
    const version = await this.flowsService.getVersion(user.tenantId, versionId);
    return this.simSessions.start({
      tenantId: user.tenantId,
      graph: version.graph,
      amdClass: body.amdClass,
      transferResult: body.transferResult,
      leadVars: body.leadVars,
    });
  }

  /** Send the customer's next line into a running test-drive. */
  @Post('test-drive/:sessionId/reply')
  @Roles('ADMIN', 'SUPERVISOR')
  replyTestDrive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Body() body: { text: string },
  ) {
    return this.simSessions.reply(user.tenantId, sessionId, String(body.text ?? ''));
  }

  @Post('test-drive/:sessionId/end')
  @Roles('ADMIN', 'SUPERVISOR')
  endTestDrive(@CurrentUser() user: AuthenticatedUser, @Param('sessionId') sessionId: string) {
    this.simSessions.end(user.tenantId, sessionId);
    return { ok: true };
  }

  @Get()
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.flowsService.list(user.tenantId);
  }

  @Post()
  @Roles('ADMIN')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateFlowDto) {
    return this.flowsService.create(user.tenantId, dto);
  }

  @Post(':id/draft')
  @Roles('ADMIN')
  saveDraft(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SaveDraftDto) {
    return this.flowsService.saveDraft(user.tenantId, id, dto.graph, dto.changeNote);
  }

  @Post(':id/publish')
  @Roles('ADMIN')
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: PublishDto) {
    return this.flowsService.publish(user.tenantId, { id: user.userId, label: user.email }, id, dto.countryPackCode);
  }

  @Get(':id/versions')
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  versions(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.flowsService.listVersions(user.tenantId, id);
  }

  @Get('versions/:versionId')
  @Roles('ADMIN', 'SUPERVISOR', 'QA')
  version(@CurrentUser() user: AuthenticatedUser, @Param('versionId') versionId: string) {
    return this.flowsService.getVersion(user.tenantId, versionId);
  }

  /**
   * Prompt preview: shows EXACTLY what the conversation model receives for
   * a given AI node prompt — the composed system prompt (node prompt +
   * identity + answered-facts + rebuttals + JSON envelope contract) and the
   * rolling message assembly. Answers "how is this sent to the model?"
   * without reading engine code.
   */
  @Post('prompt-preview')
  @Roles('ADMIN', 'SUPERVISOR')
  promptPreview(
    @Body()
    body: {
      prompt: string;
      rebuttals?: Array<{ objection: string; rebuttal: string }>;
      facts?: Record<string, unknown>;
      vars?: Record<string, unknown>;
      aiSelfIdentification?: boolean;
    },
  ) {
    const systemPrompt = composeSystemPrompt({
      nodePrompt: body.prompt ?? '',
      vars: { firstName: 'Sam', suburb: 'Richmond', clientName: 'Aurora Solar', ...body.vars },
      facts: body.facts ?? {},
      rebuttals: body.rebuttals ?? [],
      aiSelfIdentification: body.aiSelfIdentification ?? true,
    });
    return {
      systemPrompt,
      messageAssembly: exampleMessageAssembly(systemPrompt),
      envelopeContract: ENVELOPE_CONTRACT,
      notes: [
        'The system prompt is rebuilt every turn so the ALREADY-ANSWERED list stays current (never re-asks).',
        'The full turn history (user = customer STT, assistant = prior JSON envelopes) is sent each turn.',
        'The model must reply with one JSON envelope; "reply" is spoken via TTS, "captured" updates facts and the live score, "intent" drives flow edges.',
        'Per-node provider overrides (PAL-04) can route this node to a different LLM than the rest of the campaign.',
      ],
    };
  }

  /** Validate a graph without saving — used live by the builder UI. */
  @Post('validate')
  @Roles('ADMIN')
  validate(@Body() body: { graph: unknown }) {
    const parsed = flowGraphSchema.safeParse(body.graph);
    if (!parsed.success) return { valid: false, issues: parsed.error.issues };
    const issues = validateFlowGraph(parsed.data);
    return { valid: issues.every((i) => i.severity !== 'error'), issues };
  }

  /**
   * Text simulator per FLOW-05: test-drive a draft or published version
   * against a scripted or persona-driven fake customer before any real dial.
   */
  @Post('versions/:versionId/simulate')
  @Roles('ADMIN', 'SUPERVISOR')
  async simulate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('versionId') versionId: string,
    @Body() dto: SimulateDto,
  ) {
    const version = await this.flowsService.getVersion(user.tenantId, versionId);
    const runtime = new SimulationRuntime(
      {
        scriptedReplies: dto.scriptedReplies,
        personaPrompt: dto.personaPrompt,
        transferResult: 'BRIDGED',
        tenantId: user.tenantId,
        preferRealLlmPersona: Boolean(
          config.providerKeys.anthropic || config.providerKeys.openai || config.providerKeys.google,
        ),
      },
      this.pal,
    );

    const transcript: Array<{ speaker: string; text: string }> = [];
    const scoreHistory: Array<{ score: number; reason: string }> = [];
    const complianceEvents: Array<{ kind: string; detail: string }> = [];
    let summary = '';

    const outcome = await this.executor.execute(
      version.graph,
      runtime,
      {
        callId: 'sim',
        tenantId: user.tenantId,
        campaignId: 'sim',
        leadId: 'sim',
        vars: { firstName: 'Sam', suburb: 'Richmond', phone: '+61400000000', ...dto.leadVars },
        facts: {},
        score: 0,
        attempt: 1,
        objections: [],
        startedAt: Date.now(),
      },
      {
        scoring: DEFAULT_SCORING_CONFIG,
        rebuttals: [],
        aiSelfIdentification: true,
        aiIdentificationText: "I'm a virtual assistant.",
        campaignPhone: '+61390000000',
        clientName: 'Simulated Client',
        summaryTemplate: 'Score {{score}}. Facts: {{facts}}. Objection: {{objection}}.',
        countryPackCode: 'AU',
      },
      {
        onLine: (speaker, text) => transcript.push({ speaker, text }),
        onScore: (score, reason) => scoreHistory.push({ score, reason }),
        onCompliance: (kind, detail) => complianceEvents.push({ kind, detail }),
        onStage: () => undefined,
        onSummary: (s) => {
          summary = s;
        },
      },
    );

    return { outcome, transcript, scoreHistory, complianceEvents, summary };
  }
}
