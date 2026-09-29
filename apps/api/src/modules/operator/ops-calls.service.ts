import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { redactPii } from '@cocally/shared';
import { Model, Types, type FilterQuery } from 'mongoose';
import { signedRecordingUrl } from '../../common/recording-url';
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

/** Latency thresholds the ops console colours against (ms, caller-perceived turn gap). */
export const LATENCY_TARGETS = { goodMs: 1000, slowMs: 1500, stallMs: 5000 } as const;

export interface Dist {
  n: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  avg: number | null;
}

function dist(values: number[]): Dist {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, p50: null, p90: null, p95: null, max: null, avg: null };
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!;
  return { n: v.length, p50: q(0.5), p90: q(0.9), p95: q(0.95), max: v[v.length - 1]!, avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
}

type Turn = { at: Date; eou: number; stt: number; llm: number; tts: number; total: number; llmServed?: string; promptTokens?: number };
type TimelineEvent = { at: Date; kind: string; ms?: number; detail?: string };

/** Stage distributions over a set of turns. Stalls are kept out of the stage p50s' way by reporting them separately too. */
function turnStats(turns: Turn[]) {
  return {
    turns: turns.length,
    total: dist(turns.map((t) => t.total)),
    eou: dist(turns.map((t) => t.eou)),
    llm: dist(turns.map((t) => t.llm)),
    tts: dist(turns.map((t) => t.tts)),
    slow: turns.filter((t) => t.total > LATENCY_TARGETS.slowMs && t.total <= LATENCY_TARGETS.stallMs).length,
    stalls: turns.filter((t) => t.total > LATENCY_TARGETS.stallMs).length,
    underTarget: turns.filter((t) => t.total <= LATENCY_TARGETS.goodMs).length,
  };
}

const istDay = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

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

  /**
   * Voice latency for one tenant's AI calls: stage distributions (end of
   * turn, LLM first token, TTS first byte, total gap), stalls, which provider
   * stack and which model actually served each turn, per day and per call.
   * "Reply" turns are the ones where the customer spoke (eou > 0); the rest
   * are AI-initiated (after a tool call) and are counted, not mixed in.
   */
  async latency(f: { tenantId: string; from?: Date; to?: Date; campaignId?: string }) {
    if (!Types.ObjectId.isValid(f.tenantId)) throw new NotFoundException('Tenant not found');
    const to = f.to ?? new Date();
    const from = f.from ?? new Date(to.getTime() - 7 * 86_400_000);
    const q: FilterQuery<CallDocument> = {
      tenantId: new Types.ObjectId(f.tenantId),
      startedAt: { $gte: from, $lt: to },
      manual: { $ne: true },
      predictive: { $ne: true },
      $or: [{ 'timings.turns.0': { $exists: true } }, { 'timings.events.0': { $exists: true } }],
    };
    if (f.campaignId && Types.ObjectId.isValid(f.campaignId)) q.campaignId = new Types.ObjectId(f.campaignId);
    const calls = await this.callModel
      .find(q)
      .select('campaignId leadId startedAt answeredAt outcome amdClass amdLatencyMs providersUsed timings')
      .sort({ startedAt: -1 })
      .limit(1000)
      .lean()
      .exec();
    const n = await this.names(
      [],
      calls.map((c) => c.campaignId?.toString()).filter(Boolean) as string[],
      calls.map((c) => c.leadId?.toString()).filter(Boolean) as string[],
      [],
    );

    const allReply: Turn[] = [];
    let aiInitiated = 0;
    const byStack = new Map<string, { stack: { stt: string; llm: string; tts: string }; calls: number; turns: Turn[] }>();
    const byModel = new Map<string, Turn[]>();
    const byDay = new Map<string, { calls: number; turns: Turn[] }>();
    const greeting: number[] = [];
    const answered: number[] = [];
    const amd: number[] = [];
    let stallGuardFires = 0;
    const transfers: Array<{ result: string; ms: number | null }> = [];

    const rows = calls.map((c) => {
      const t = (c.timings ?? {}) as { turns?: Turn[]; events?: TimelineEvent[] };
      const turns = t.turns ?? [];
      const events = t.events ?? [];
      const reply = turns.filter((x) => x.eou > 0);
      aiInitiated += turns.length - reply.length;
      allReply.push(...reply);
      const pu = (c.providersUsed ?? {}) as Record<string, string>;
      const stack = { stt: pu.stt ?? 'nova', llm: pu.llm ?? '—', tts: pu.tts ?? '—' };
      const key = `${stack.stt}|${stack.llm}|${stack.tts}`;
      const st = byStack.get(key) ?? { stack, calls: 0, turns: [] };
      st.calls += 1;
      st.turns.push(...reply);
      byStack.set(key, st);
      for (const x of reply) {
        const m = x.llmServed ?? `${pu.llm ?? 'unknown'} (configured)`;
        byModel.set(m, [...(byModel.get(m) ?? []), x]);
      }
      const day = istDay(new Date(c.startedAt));
      const d = byDay.get(day) ?? { calls: 0, turns: [] };
      d.calls += 1;
      d.turns.push(...reply);
      byDay.set(day, d);
      const ev = (k: string) => events.filter((e) => e.kind === k);
      const g = ev('greeting')[0]?.ms;
      if (g !== undefined) greeting.push(g);
      const a = ev('answered')[0]?.ms;
      if (a !== undefined) answered.push(a);
      if (c.amdLatencyMs != null) amd.push(c.amdLatencyMs);
      const guards = ev('stall_guard').length;
      stallGuardFires += guards;
      for (const tr of ev('transfer')) transfers.push({ result: tr.detail ?? '?', ms: tr.ms ?? null });
      const s = turnStats(reply);
      const lead = c.leadId ? n.lead.get(c.leadId.toString()) : undefined;
      return {
        id: c._id.toString(),
        startedAt: c.startedAt,
        leadName: lead?.name ?? null,
        campaignName: c.campaignId ? (n.campaign.get(c.campaignId.toString()) ?? '—') : '—',
        outcome: c.outcome ?? null,
        stack,
        turns: s.turns,
        aiInitiatedTurns: turns.length - reply.length,
        p50: s.total.p50,
        p95: s.total.p95,
        max: s.total.max,
        eouP50: s.eou.p50,
        llmP50: s.llm.p50,
        ttsP50: s.tts.p50,
        slow: s.slow,
        stalls: s.stalls,
        stallGuardFires: guards,
        greetingMs: g ?? null,
        amdLatencyMs: c.amdLatencyMs ?? null,
        llmServed: [...new Set(reply.map((x) => x.llmServed).filter(Boolean))],
      };
    });

    const summary = turnStats(allReply);
    return {
      range: { from, to },
      targets: LATENCY_TARGETS,
      truncated: calls.length === 1000,
      summary: {
        ...summary,
        calls: calls.length,
        aiInitiatedTurns: aiInitiated,
        stallGuardFires,
        greeting: dist(greeting),
        answerDetect: dist(answered),
        amd: dist(amd),
        transfers: {
          n: transfers.length,
          bridged: transfers.filter((x) => x.result === 'BRIDGED').length,
          wait: dist(transfers.map((x) => x.ms ?? NaN)),
        },
      },
      byStack: [...byStack.values()]
        .map((x) => ({ stack: x.stack, calls: x.calls, ...turnStats(x.turns) }))
        .sort((a, b) => b.turns - a.turns),
      byModel: [...byModel.entries()]
        .map(([model, ts]) => ({ model, turns: ts.length, llm: dist(ts.map((x) => x.llm)), total: dist(ts.map((x) => x.total)) }))
        .sort((a, b) => b.turns - a.turns),
      byDay: [...byDay.entries()]
        .map(([day, x]) => ({ day, calls: x.calls, ...turnStats(x.turns) }))
        .sort((a, b) => b.day.localeCompare(a.day)),
      calls: rows.slice(0, 200),
    };
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
      turnMetrics: ((call.timings as { turns?: Turn[] } | undefined)?.turns ?? []).map((t) => ({ ...t, reply: t.eou > 0 })),
      events: (call.timings as { events?: TimelineEvent[] } | undefined)?.events ?? [],
      providersUsed: (c.providersUsed as Record<string, string>) ?? {},
      latencyTargets: LATENCY_TARGETS,
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
    const expiresInSeconds = 15 * 60;
    const url = signedRecordingUrl(call.recordingUri, expiresInSeconds);
    if (!url) throw new NotFoundException('Recording is stored outside the configured bucket');
    return { url, expiresInSeconds };
  }

}
