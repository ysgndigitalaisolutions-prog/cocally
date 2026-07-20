import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DEFAULT_SCORING_CONFIG } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Client, ClientDocument } from '../../schemas/tenant.schema';
import { FlowVersion, FlowVersionDocument } from '../../schemas/flow.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { AuditService } from '../audit/audit.service';
import { CountryPacksService } from '../country-packs/country-packs.service';

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

  async list(tenantId: string) {
    return this.campaignModel.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec();
  }

  async get(tenantId: string, campaignId: string) {
    const campaign = await this.campaignModel
      .findOne({ _id: new Types.ObjectId(campaignId), tenantId: new Types.ObjectId(tenantId) })
      .lean()
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
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

    if (status === 'ACTIVE') {
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
