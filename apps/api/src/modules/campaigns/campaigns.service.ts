import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DEFAULT_SCORING_CONFIG } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { z } from 'zod';
import { Campaign, CampaignDocument, DEFAULT_PREDICTIVE_DIALING } from '../../schemas/campaign.schema';
import { Client, ClientDocument } from '../../schemas/tenant.schema';
import { FlowVersion, FlowVersionDocument } from '../../schemas/flow.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { AuditService } from '../audit/audit.service';
import { CountryPacksService } from '../country-packs/country-packs.service';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be an id');
/** Shape guard for PATCH /campaigns/:id — unknown keys are dropped by the editable list. */
const CAMPAIGN_PATCH_SCHEMA = z
  .object({
    name: z.string().trim().min(1).max(120),
    activeFlowVersionId: objectId.nullable(),
    dailyDialBudget: z.number().int().min(0).max(1_000_000),
    maxConcurrentCalls: z.number().int().min(1).max(500),
    dialsPerAvailableAgent: z.number().min(0.1).max(20),
    noAgentFallback: z.enum(['BOOK', 'HOLD', 'AI_CLOSE']),
    voicemailPolicy: z.string(),
    ivrPolicy: z.object({ enabled: z.boolean(), digits: z.string().regex(/^[0-9*#]*$/), maxMenuDepth: z.number().int().min(0).max(10) }),
    cliRules: z.object({ geoMatch: z.boolean(), rotation: z.enum(['ROUND_ROBIN', 'RANDOM', 'HEALTH_WEIGHTED']) }),
    retryMatrix: z.array(
      z.object({
        outcome: z.string().min(1),
        delayMinutes: z.number().min(0).max(60 * 24 * 30),
        shiftTimeBand: z.boolean().default(false),
        maxAttempts: z.number().int().min(1).max(50),
      }),
    ),
    frequencyCapDays: z.number().int().min(0).max(365),
    scoring: z.record(z.unknown()),
    rebuttals: z.array(z.object({ objection: z.string(), rebuttal: z.string() })),
    aiSelfIdentification: z.boolean(),
    transcriptionMode: z.enum(['LIVE', 'SUMMARY', 'BOTH']),
    whisperEnabled: z.boolean(),
    routingStrategy: z.string(),
    transferAcceptWindowSeconds: z.number().int().min(5).max(120),
    schedule: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: z.string().regex(HHMM), end: z.string().regex(HHMM) })),
    sttKeywords: z.array(z.string()),
    summaryTemplate: z.string().max(2000),
    abSplits: z.array(z.object({ flowVersionId: objectId, percent: z.number().min(0).max(100) })),
    predictiveDialing: z.record(z.unknown()),
    cliPool: z.array(objectId),
  })
  .partial()
  .strict();

@Injectable()
export class CampaignsService {
  constructor(
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(FlowVersion.name) private readonly versionModel: Model<FlowVersionDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly packs: CountryPacksService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actor: { id: string; label: string },
    input: { name: string; clientId: string; countryPackCode?: string },
  ) {
    const client = await this.clientModel
      .findOne({ _id: new Types.ObjectId(input.clientId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!client) throw new NotFoundException('Client not found');
    await this.packs.getByCode(input.countryPackCode ?? 'AU');

    const pack = await this.packs.getByCode(input.countryPackCode ?? 'AU');
    const campaign = await this.campaignModel.create({
      tenantId: new Types.ObjectId(tenantId),
      clientId: client._id,
      name: input.name,
      countryPackCode: pack.code,
      scoring: DEFAULT_SCORING_CONFIG,
      aiSelfIdentification: pack.disclosures.aiIdentificationDefaultOn,
    });

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'campaign.create',
      entityType: 'Campaign',
      entityId: campaign._id.toString(),
      after: { name: input.name, countryPackCode: pack.code },
    });
    return campaign;
  }

  /**
   * `.lean()` returns the raw stored document — a campaign created before
   * `predictiveDialing` existed has no such field at all in Mongo, so a lean
   * read gives back `undefined`, not the schema default. Backfill it here
   * rather than trust every caller (and the frontend) to null-check.
   */
  private withDefaults<T extends { predictiveDialing?: unknown }>(campaign: T): T {
    return { ...campaign, predictiveDialing: campaign.predictiveDialing ?? DEFAULT_PREDICTIVE_DIALING };
  }

  async list(tenantId: string) {
    const campaigns = await this.campaignModel.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec();
    return campaigns.map((c) => this.withDefaults(c));
  }

  async get(tenantId: string, campaignId: string) {
    const campaign = await this.campaignModel
      .findOne({ _id: new Types.ObjectId(campaignId), tenantId: new Types.ObjectId(tenantId) })
      .lean()
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.withDefaults(campaign);
  }

  /**
   * Roster for a campaign. Transfer eligibility (XFER-01) is skill-based: an
   * agent is eligible when their `skills` contain this campaign id, OR when
   * they have no skills at all — an unrestricted agent takes any campaign.
   * That fallback is why `unrestricted` is reported separately: assigning the
   * first agent to a campaign silently narrows who else can receive it.
   */
  async team(tenantId: string, campaignId: string) {
    const agents = await this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId), roles: 'AGENT', active: true })
      .select('name email skills presence')
      .sort({ name: 1 })
      .lean()
      .exec();

    return agents.map((a) => ({
      id: a._id.toString(),
      name: a.name || a.email,
      email: a.email,
      presence: a.presence,
      assigned: a.skills.includes(campaignId),
      unrestricted: a.skills.length === 0,
    }));
  }

  /** Set exactly which agents are assigned to this campaign. */
  async setTeam(
    tenantId: string,
    actor: { id: string; label: string },
    campaignId: string,
    agentIds: string[],
  ) {
    const campaign = await this.get(tenantId, campaignId);
    const wanted = new Set(agentIds);
    const agents = await this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId), roles: 'AGENT', active: true })
      .select('skills')
      .exec();

    const before: string[] = [];
    for (const agent of agents) {
      const id = agent._id.toString();
      const has = agent.skills.includes(campaignId);
      if (has) before.push(id);
      if (wanted.has(id) === has) continue;
      agent.skills = wanted.has(id)
        ? [...agent.skills, campaignId]
        : agent.skills.filter((s) => s !== campaignId);
      await agent.save();
    }

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'campaign.team.set',
      entityType: 'Campaign',
      entityId: campaignId,
      before: { agentIds: before },
      after: { agentIds },
    });

    return this.team(tenantId, campaign._id.toString());
  }

  async update(tenantId: string, actor: { id: string; label: string }, campaignId: string, patch: Record<string, unknown>) {
    const campaign = await this.campaignModel
      .findOne({ _id: new Types.ObjectId(campaignId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.predictiveDialing) campaign.predictiveDialing = DEFAULT_PREDICTIVE_DIALING;

    // The body is untyped, so the global ValidationPipe cannot see it; a
    // string budget or a retry rule with no delay used to be saved as-is and
    // then silently stalled the dialer or retried a lead every 10 minutes.
    const parsed = CAMPAIGN_PATCH_SCHEMA.safeParse(patch);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    }
    patch = parsed.data as Record<string, unknown>;

    // The AI script must be this tenant's own, published version; and a live
    // AI campaign cannot be left without one (activation checks the same).
    if (patch.activeFlowVersionId !== undefined) {
      if (patch.activeFlowVersionId === null) {
        if (campaign.status === 'ACTIVE' && !campaign.predictiveDialing?.enabled) {
          throw new BadRequestException('Pause the campaign before removing its AI script');
        }
      } else {
        const version = await this.versionModel
          .findOne({ _id: new Types.ObjectId(String(patch.activeFlowVersionId)), tenantId: new Types.ObjectId(tenantId) })
          .select('state')
          .lean()
          .exec();
        if (!version) throw new BadRequestException('Flow version not found');
        if (version.state !== 'PUBLISHED') throw new BadRequestException('Only a published flow version can be assigned');
      }
    }

    const editable = [
      'name',
      'activeFlowVersionId',
      'dailyDialBudget',
      'maxConcurrentCalls',
      'dialsPerAvailableAgent',
      'noAgentFallback',
      'voicemailPolicy',
      'ivrPolicy',
      'cliRules',
      'retryMatrix',
      'frequencyCapDays',
      'scoring',
      'rebuttals',
      'aiSelfIdentification',
      'transcriptionMode',
      'whisperEnabled',
      'routingStrategy',
      'transferAcceptWindowSeconds',
      'schedule',
      'sttKeywords',
      'summaryTemplate',
      'abSplits',
      'predictiveDialing',
      'cliPool',
    ] as const;

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of editable) {
      if (patch[key] !== undefined) {
        before[key] = campaign.get(key);
        after[key] = patch[key];
        campaign.set(key, patch[key]);
      }
    }
    await campaign.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'campaign.update',
      entityType: 'Campaign',
      entityId: campaignId,
      before,
      after,
    });
    return campaign;
  }

  /** Activate: requires a published flow version wired per FLOW-04. */
  async setStatus(
    tenantId: string,
    actor: { id: string; label: string },
    campaignId: string,
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED',
  ) {
    const campaign = await this.campaignModel
      .findOne({ _id: new Types.ObjectId(campaignId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');

    // A human-only (predictive/manual) campaign has no AI flow to publish.
    if (status === 'ACTIVE' && !campaign.predictiveDialing?.enabled) {
      if (!campaign.activeFlowVersionId) {
        throw new BadRequestException('Campaign needs a published flow version before activation');
      }
      const version = await this.versionModel.findById(campaign.activeFlowVersionId).lean().exec();
      if (version?.state !== 'PUBLISHED') {
        throw new BadRequestException('The assigned flow version is not published');
      }
    }

    const before = campaign.status;
    campaign.status = status;
    await campaign.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: `campaign.${status.toLowerCase()}`,
      entityType: 'Campaign',
      entityId: campaignId,
      before: { status: before },
      after: { status },
    });
    return campaign;
  }
}
