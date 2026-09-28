import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { redactPii } from '@cocally/shared';
import { Model, Types, type FilterQuery } from 'mongoose';
import { config } from '../../common/config';
import { presignS3Get } from '../../common/s3-presign';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { Tenant, TenantDocument } from '../../schemas/tenant.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { normaliseBilling, priceUsage } from '../platform/billing.service';
import { PlatformService } from '../platform/platform.service';
import { UsageService } from '../platform/usage.service';

export interface CallFilter {
  tenantId?: string;
  campaignId?: string;
  from?: Date;
  to?: Date;
  outcome?: string;
  amdClass?: string;
  transferred?: boolean;
  phone?: string;
  page?: number;
  pageSize?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Calls across every tenant, for support and billing questions ("why was I
 * charged for this?"). Each row carries what the call cost CoCally and what it
 * was billed at, both computed the same way as the invoices.
 */
@Injectable()
export class OpsCallsService {
  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly usage: UsageService,
    private readonly platform: PlatformService,
  ) {}

  private async names(tenantIds: string[], campaignIds: string[], leadIds: string[], agentIds: string[]) {
    const oid = (ids: string[]) => [...new Set(ids)].filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i));
    const [tenants, campaigns, leads, agents] = await Promise.all([
      this.tenantModel.find({ _id: { $in: oid(tenantIds) } }).select('name billing').lean().exec(),
      this.campaignModel.find({ _id: { $in: oid(campaignIds) } }).select('name').lean().exec(),
      this.leadModel.find({ _id: { $in: oid(leadIds) } }).select('firstName lastName phone').lean().exec(),
      this.userModel.find({ _id: { $in: oid(agentIds) } }).select('name').lean().exec(),
    ]);
    return {
      tenant: new Map(tenants.map((t) => [t._id.toString(), t])),
      campaign: new Map(campaigns.map((c) => [c._id.toString(), c.name])),
      lead: new Map(
        leads.map((l) => [l._id.toString(), { name: [l.firstName, l.lastName].filter(Boolean).join(' ') || null, phone: l.phone }]),
      ),
      agent: new Map(agents.map((a) => [a._id.toString(), a.name])),
    };
  }

  async list(f: CallFilter) {
    const q: FilterQuery<CallDocument> = {};
    if (f.tenantId) q.tenantId = new Types.ObjectId(f.tenantId);
    if (f.campaignId) q.campaignId = new Types.ObjectId(f.campaignId);
    if (f.from || f.to) q.startedAt = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lt: f.to } : {}) };
    if (f.outcome) q.outcome = f.outcome;
    if (f.amdClass) q.amdClass = f.amdClass;
    if (f.transferred) q.bridgedAt = { $exists: true };
    if (f.phone) {
      const digits = f.phone.replace(/[^\d]/g, '');
      if (digits.length < 4) throw new BadRequestException('Give at least 4 digits of the phone number');
      const leads = await this.leadModel
        .find({ ...(f.tenantId ? { tenantId: q.tenantId } : {}), phone: { $regex: `${digits}$` } })
        .select('_id')
        .limit(500)
        .lean()
        .exec();
      q.leadId = { $in: leads.map((l) => l._id) };
    }
    const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
    const page = Math.max(f.page ?? 1, 1);
    const [total, calls] = await Promise.all([
      this.callModel.countDocuments(q).exec(),
      this.callModel
        .find(q)
        .select('tenantId campaignId leadId agentId state outcome amdClass disposition startedAt answeredAt bridgedAt endedAt manual predictive finalScore recordingUri cli')
        .sort({ startedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
    ]);
    const ids = calls.map((c) => c._id.toString());
    const [usage, rc, n] = await Promise.all([
      ids.length ? this.usage.usage({ callIds: ids, groupBy: '_id' }) : Promise.resolve(new Map()),
      this.platform.rateCard(),
      this.names(
        calls.map((c) => c.tenantId.toString()),
        calls.map((c) => c.campaignId?.toString()).filter(Boolean) as string[],
        calls.map((c) => c.leadId?.toString()).filter(Boolean) as string[],
        calls.map((c) => c.agentId?.toString()).filter(Boolean) as string[],
      ),
    ]);
    const rows = calls.map((c) => {
      const id = c._id.toString();
      const u = usage.get(id);
      const tenant = n.tenant.get(c.tenantId.toString());
      const costInr = u ? round2(PlatformService.cost(u, rc).total * rc.inrPerUsd) : 0;
      // The call's own share of the bill, at the tenant's base rate. The invoice may
      // use a cheaper band for the month; this is for "what did this one call do".
      const tier = normaliseBilling(tenant?.billing).tiers[0]!;
      const billedInr = u ? round2((u.aiSeconds / 60) * tier.aiPerMinInr + u.dials * tier.perDialInr) : 0;
      const lead = c.leadId ? n.lead.get(c.leadId.toString()) : undefined;
      return {
        id,
        tenantId: c.tenantId.toString(),
        tenantName: tenant?.name ?? '—',
        campaignName: c.campaignId ? (n.campaign.get(c.campaignId.toString()) ?? '—') : '—',
        leadName: lead?.name ?? null,
        leadPhone: lead?.phone ?? null,
        agentName: c.agentId ? (n.agent.get(c.agentId.toString()) ?? null) : null,
        kind: c.manual ? 'Manual' : c.predictive ? 'Predictive' : 'AI',
        state: c.state,
        outcome: c.outcome ?? null,
        amdClass: c.amdClass ?? null,
        disposition: c.disposition ?? null,
        score: c.finalScore ?? null,
        startedAt: c.startedAt,
        ringSeconds: u?.ringSeconds ?? 0,
        aiSeconds: u?.aiSeconds ?? 0,
        humanSeconds: u?.humanSeconds ?? 0,
        recorded: Boolean(c.recordingUri),
        costInr,
        billedInr,
      };
    });
    return { total, page, pageSize, rows };
  }

  async detail(id: string, opts: { unredacted?: boolean } = {}) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(id).lean().exec();
    if (!call) throw new NotFoundException('Call not found');
    const [usage, rc, n] = await Promise.all([
      this.usage.usage({ callIds: [id], groupBy: '_id' }),
      this.platform.rateCard(),
      this.names([call.tenantId.toString()], [call.campaignId?.toString() ?? ''], [call.leadId?.toString() ?? ''], [call.agentId?.toString() ?? '']),
    ]);
    const u = usage.get(id);
    const tenant = n.tenant.get(call.tenantId.toString());
    const billing = normaliseBilling(tenant?.billing);
    const costUsd = u ? PlatformService.cost(u, rc) : null;
    const priced = u ? priceUsage(u, { ...billing, tiers: [billing.tiers[0]!] }) : null;
    const lead = call.leadId ? n.lead.get(call.leadId.toString()) : undefined;
    const c = call as unknown as Record<string, unknown>;
    return {
      id,
      tenantId: call.tenantId.toString(),
      tenantName: tenant?.name ?? '—',
      campaignId: call.campaignId?.toString() ?? null,
      campaignName: call.campaignId ? (n.campaign.get(call.campaignId.toString()) ?? '—') : '—',
      lead: lead ?? null,
      agentName: call.agentId ? (n.agent.get(call.agentId.toString()) ?? null) : null,
      kind: call.manual ? 'Manual' : call.predictive ? 'Predictive' : 'AI',
      cli: call.cli ?? null,
      state: call.state,
      outcome: call.outcome ?? null,
      endReason: c.endReason ?? null,
      sipStatus: c.sipStatus ?? null,
      amdClass: call.amdClass ?? null,
      amdLatencyMs: call.amdLatencyMs ?? null,
      disposition: call.disposition ?? null,
      dispositionNotes: call.dispositionNotes ?? null,
      score: c.finalScore ?? null,
      summary: call.summary ?? '',
      timeline: {
        startedAt: call.startedAt,
        answeredAt: call.answeredAt ?? null,
        aiDispatchedAt: call.aiDispatchedAt ?? null,
        bridgedAt: call.bridgedAt ?? null,
        endedAt: call.endedAt ?? null,
      },
      usage: u ?? null,
      costUsd,
      costInr: costUsd ? round2(costUsd.total * rc.inrPerUsd) : 0,
      inrPerUsd: rc.inrPerUsd,
      billedLines: priced?.lines ?? [],
      billedInr: priced?.subtotalInr ?? 0,
      complianceEvents: (c.complianceEvents as unknown[]) ?? [],
      turnMetrics: (c.turnMetrics as unknown[]) ?? (c.metrics as unknown[]) ?? [],
      recorded: Boolean(call.recordingUri),
      recordingUri: call.recordingUri ?? null,
      transcriptRedacted: !opts.unredacted,
      transcript: (call.transcript ?? []).map((t) => ({
        speaker: t.speaker,
        leg: t.leg,
        atMs: t.startMs,
        text: opts.unredacted ? t.text : t.redactedText || redactPii(t.text),
      })),
    };
  }

  /** Short-lived signed link to the call audio in the recordings bucket. */
  async recordingUrl(id: string): Promise<{ url: string; expiresInSeconds: number }> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Call not found');
    const call = await this.callModel.findById(id).select('recordingUri').lean().exec();
    if (!call?.recordingUri) throw new NotFoundException('No recording for this call');
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(call.recordingUri);
    const { s3Region, s3AccessKey, s3Secret, s3Endpoint } = config.recording;
    if (!m || !s3AccessKey || !s3Secret) throw new NotFoundException('Recording is stored outside the configured bucket');
    const expiresInSeconds = 15 * 60;
    return {
      url: presignS3Get({
        bucket: m[1]!,
        key: m[2]!,
        region: s3Region ?? 'ap-southeast-2',
        accessKey: s3AccessKey,
        secret: s3Secret,
        endpoint: s3Endpoint,
        expiresSeconds: expiresInSeconds,
      }),
      expiresInSeconds,
    };
  }
}
