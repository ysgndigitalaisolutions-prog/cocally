import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { Transfer, TransferDocument } from '../../schemas/transfer.schema';

/** How long a computed dashboard panel stays warm. */
const CACHE_TTL_MS = 20_000;

/**
 * Dashboard aggregations per DASH-01..08. All pipelines are tenant-scoped;
 * campaign filter optional.
 *
 * Two scale properties matter here, because every panel is a live aggregation
 * over the raw `calls` collection rather than a pre-computed rollup:
 *
 *  - `allowDiskUse` — a `$group` over 100k+ documents can exceed MongoDB's
 *    100 MB in-memory aggregation limit and fail outright. Spilling to disk
 *    trades latency for not falling over.
 *  - a short TTL cache — the dashboard polls every 10s and the team page every
 *    15s, *per viewing supervisor*. With 15 supervisors that is a full
 *    collection scan several times a second for data that changes far more
 *    slowly than it is requested. Caching collapses that to one scan per
 *    window.
 *
 * The cache is per-process, which is correct while the API runs as the single
 * instance the dialer already requires. Moving to multiple instances means
 * moving this to Redis — the same change the live-channel counter needs.
 */
@Injectable()
export class AnalyticsService {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
  ) {}

  /** Memoise a panel for CACHE_TTL_MS, keyed by its full argument set. */
  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

    const value = await compute();
    this.cache.set(key, { at: Date.now(), value });

    // Bound the map so a tenant sweeping date ranges can't grow it without end.
    if (this.cache.size > 500) {
      const cutoff = Date.now() - CACHE_TTL_MS;
      for (const [k, v] of this.cache) if (v.at < cutoff) this.cache.delete(k);
    }
    return value;
  }

  private baseFilter(tenantId: string, campaignId?: string, from?: Date, to?: Date) {
    return {
      tenantId: new Types.ObjectId(tenantId),
      ...(campaignId ? { campaignId: new Types.ObjectId(campaignId) } : {}),
      ...(from || to
        ? { startedAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } }
        : {}),
    };
  }

  /** KPI band per DASH-01. */
  async kpis(tenantId: string, campaignId?: string, from?: Date, to?: Date) {
    return this.cached(`kpis:${tenantId}:${campaignId ?? ''}:${from?.getTime() ?? ''}:${to?.getTime() ?? ''}`, () =>
      this.computeKpis(tenantId, campaignId, from, to),
    );
  }

  private async computeKpis(tenantId: string, campaignId?: string, from?: Date, to?: Date) {
    const filter = this.baseFilter(tenantId, campaignId, from, to);
    const [row] = await this.callModel.aggregate<{
      dials: number;
      connects: number;
      transfers: number;
      booked: number;
      totalTalkMs: number;
      totalCostCents: number;
      avgQa: number;
    }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          dials: { $sum: 1 },
          connects: { $sum: { $cond: [{ $eq: ['$amdClass', 'HUMAN'] }, 1, 0] } },
          transfers: { $sum: { $cond: [{ $ifNull: ['$agentId', false] }, 1, 0] } },
          booked: { $sum: { $cond: [{ $eq: ['$disposition', 'BOOKED'] }, 1, 0] } },
          totalTalkMs: {
            $sum: { $cond: [{ $and: ['$endedAt', '$answeredAt'] }, { $subtract: ['$endedAt', '$answeredAt'] }, 0] },
          },
          totalCostCents: {
            $sum: { $add: ['$costCents.telco', '$costCents.stt', '$costCents.tts', '$costCents.llm'] },
          },
          avgQa: { $avg: '$qaScore.total' },
        },
      },
    ]).allowDiskUse(true);

    const dials = row?.dials ?? 0;
    const connects = row?.connects ?? 0;
    const booked = row?.booked ?? 0;
    return {
      dials,
      connects,
      connectRate: dials > 0 ? connects / dials : 0,
      transfers: row?.transfers ?? 0,
      bookings: booked,
      qualifyToBook: connects > 0 ? booked / connects : 0,
      costPerBookingCents: booked > 0 ? Math.round((row?.totalCostCents ?? 0) / booked) : null,
      avgHandleTimeMs: connects > 0 ? Math.round((row?.totalTalkMs ?? 0) / connects) : 0,
      avgQaScore: row?.avgQa ?? null,
    };
  }

  /** Funnel with per-stage drop-off per DASH-02. */
  async funnel(tenantId: string, campaignId?: string, from?: Date, to?: Date) {
    // Leads have no `startedAt`; a date range means "leads whose lifecycle state
    // changed in the window", so we scope on `updatedAt` rather than call time.
    const filter = {
      tenantId: new Types.ObjectId(tenantId),
      ...(campaignId ? { campaignId: new Types.ObjectId(campaignId) } : {}),
      ...(from || to
        ? { updatedAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } }
        : {}),
    };
    const rows = await this.leadModel
      .aggregate<{ _id: string; count: number }>([
        { $match: filter },
        { $group: { _id: '$state_', count: { $sum: 1 } } },
      ])
      .allowDiskUse(true);
    const byState = Object.fromEntries(rows.map((r) => [r._id, r.count]));
    return {
      fresh: byState['FRESH'] ?? 0,
      attempted: byState['ATTEMPTED'] ?? 0,
      contacted: byState['CONTACTED'] ?? 0,
      qualified: byState['QUALIFIED'] ?? 0,
      transferred: byState['TRANSFERRED'] ?? 0,
      booked: byState['BOOKED'] ?? 0,
      callback: byState['CALLBACK'] ?? 0,
      nurture: byState['NURTURE'] ?? 0,
      exhausted: byState['EXHAUSTED'] ?? 0,
      dnc: byState['DNC'] ?? 0,
    };
  }

  /** Objection intelligence per DASH-03. */
  async objections(tenantId: string, campaignId?: string, from?: Date, to?: Date) {
    const filter = this.baseFilter(tenantId, campaignId, from, to);
    return this.callModel.aggregate([
      { $match: filter },
      { $unwind: '$objections' },
      {
        $group: {
          _id: '$objections.label',
          frequency: { $sum: 1 },
          recovered: { $sum: { $cond: ['$objections.recovered', 1, 0] } },
          bookingsAtRisk: { $sum: { $cond: [{ $gte: ['$finalScore', 50] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          objection: '$_id',
          frequency: 1,
          rebuttalWinRate: { $cond: [{ $gt: ['$frequency', 0] }, { $divide: ['$recovered', '$frequency'] }, 0] },
          bookingsAtRisk: 1,
        },
      },
      { $sort: { frequency: -1 } },
    ]).allowDiskUse(true);
  }

  /** Outcome/disposition mix + AMD accuracy inputs per DASH-02/08. */
  async outcomes(tenantId: string, campaignId?: string) {
    return this.cached(`outcomes:${tenantId}:${campaignId ?? ''}`, async () => {
      const filter = this.baseFilter(tenantId, campaignId);
      const [outcomes, amd] = await Promise.all([
        this.callModel
          .aggregate([{ $match: filter }, { $group: { _id: '$outcome', count: { $sum: 1 } } }])
          .allowDiskUse(true),
        this.callModel
          .aggregate([
            { $match: filter },
            { $group: { _id: '$amdClass', count: { $sum: 1 }, avgLatency: { $avg: '$amdLatencyMs' } } },
          ])
          .allowDiskUse(true),
      ]);
      return { outcomes, amd };
    });
  }

  /** Best-time-to-call heatmap per DASH-05: connect rate by weekday/hour. */
  async heatmap(tenantId: string, campaignId?: string) {
    return this.cached(`heatmap:${tenantId}:${campaignId ?? ''}`, () => this.computeHeatmap(tenantId, campaignId));
  }

  private async computeHeatmap(tenantId: string, campaignId?: string) {
    const filter = this.baseFilter(tenantId, campaignId);
    return this.callModel.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { weekday: { $isoDayOfWeek: '$startedAt' }, hour: { $hour: '$startedAt' } },
          dials: { $sum: 1 },
          connects: { $sum: { $cond: [{ $eq: ['$amdClass', 'HUMAN'] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          weekday: '$_id.weekday',
          hour: '$_id.hour',
          dials: 1,
          connectRate: { $cond: [{ $gt: ['$dials', 0] }, { $divide: ['$connects', '$dials'] }, 0] },
        },
      },
      { $sort: { weekday: 1, hour: 1 } },
    ]).allowDiskUse(true);
  }

  /**
   * Pacing safety — how often a connected customer found nobody to talk to.
   *
   * This is the outbound floor's most important compliance-adjacent KPI and it
   * was not measured anywhere. A transfer that ends FALLBACK (no eligible agent)
   * or exhausts its cascade on TIMED_OUT means the AI qualified a live human and
   * then had no closer to hand them to. Sustained, that is both lost revenue and
   * the metric a regulator asks about.
   */
  async pacingHealth(tenantId: string, campaignId?: string, from?: Date, to?: Date) {
    return this.cached(
      `pacing:${tenantId}:${campaignId ?? ''}:${from?.getTime() ?? ''}:${to?.getTime() ?? ''}`,
      async () => {
        const filter: Record<string, unknown> = {
          tenantId: new Types.ObjectId(tenantId),
          ...(campaignId ? { campaignId: new Types.ObjectId(campaignId) } : {}),
          ...(from || to
            ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } }
            : {}),
        };

        const rows = await this.transferModel
          .aggregate<{ _id: string; count: number }>([
            { $match: filter },
            { $group: { _id: '$state', count: { $sum: 1 } } },
          ])
          .allowDiskUse(true);

        const byState = Object.fromEntries(rows.map((r) => [r._id, r.count]));
        const requested = rows.reduce((sum, r) => sum + r.count, 0);
        const bridged = (byState['BRIDGED'] ?? 0) + (byState['ACCEPTED'] ?? 0);
        // Customer was live and qualified, but no human took the call.
        const abandoned = (byState['FALLBACK'] ?? 0) + (byState['TIMED_OUT'] ?? 0);

        return {
          transfersRequested: requested,
          bridged,
          abandoned,
          /** The number to watch: most outbound regimes cap this around 3%. */
          abandonRate: requested > 0 ? abandoned / requested : 0,
          bridgeRate: requested > 0 ? bridged / requested : 0,
          byState,
        };
      },
    );
  }

  /**
   * List health — penetration and remaining inventory per campaign.
   *
   * Without this a floor manager cannot answer the two questions that decide
   * each day: how much of this list have we actually worked, and how many
   * dialable records are left before the seats run dry?
   */
  async listHealth(tenantId: string, campaignId?: string) {
    return this.cached(`listHealth:${tenantId}:${campaignId ?? ''}`, async () => {
      const filter: Record<string, unknown> = {
        tenantId: new Types.ObjectId(tenantId),
        ...(campaignId ? { campaignId: new Types.ObjectId(campaignId) } : {}),
      };

      const rows = await this.leadModel
        .aggregate<{ _id: { state: string; touched: boolean }; count: number }>([
          { $match: filter },
          {
            $group: {
              _id: { state: '$state_', touched: { $gt: ['$attempts', 0] } },
              count: { $sum: 1 },
            },
          },
        ])
        .allowDiskUse(true);

      const total = rows.reduce((s, r) => s + r.count, 0);
      const touched = rows.filter((r) => r._id.touched).reduce((s, r) => s + r.count, 0);
      const WORKABLE = ['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'];
      const remaining = rows
        .filter((r) => WORKABLE.includes(r._id.state))
        .reduce((s, r) => s + r.count, 0);
      const exhausted = rows
        .filter((r) => ['EXHAUSTED', 'DNC', 'NURTURE'].includes(r._id.state))
        .reduce((s, r) => s + r.count, 0);

      // How many workable records are actually free to hand to a seat right now.
      const availableNow = await this.leadModel.countDocuments({
        ...filter,
        state_: { $in: WORKABLE },
        ownerId: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
      });

      return {
        total,
        touched,
        untouched: total - touched,
        penetration: total > 0 ? touched / total : 0,
        remainingWorkable: remaining,
        exhausted,
        availableNow,
        /** Surfaced so the UI can warn before the floor runs out of work. */
        hopperDry: availableNow < 50,
      };
    });
  }
}
