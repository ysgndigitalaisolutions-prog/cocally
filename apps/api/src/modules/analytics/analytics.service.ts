import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';

/**
 * Dashboard aggregations per DASH-01..08. All pipelines are tenant-scoped;
 * campaign filter optional.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
  ) {}

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
    ]);

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
  async funnel(tenantId: string, campaignId?: string) {
    const filter = {
      tenantId: new Types.ObjectId(tenantId),
      ...(campaignId ? { campaignId: new Types.ObjectId(campaignId) } : {}),
    };
    const rows = await this.leadModel.aggregate<{ _id: string; count: number }>([
      { $match: filter },
      { $group: { _id: '$state_', count: { $sum: 1 } } },
    ]);
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
  async objections(tenantId: string, campaignId?: string) {
    const filter = this.baseFilter(tenantId, campaignId);
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
    ]);
  }

  /** Outcome/disposition mix + AMD accuracy inputs per DASH-02/08. */
  async outcomes(tenantId: string, campaignId?: string) {
    const filter = this.baseFilter(tenantId, campaignId);
    const [outcomes, amd] = await Promise.all([
      this.callModel.aggregate([{ $match: filter }, { $group: { _id: '$outcome', count: { $sum: 1 } } }]),
      this.callModel.aggregate([
        { $match: filter },
        { $group: { _id: '$amdClass', count: { $sum: 1 }, avgLatency: { $avg: '$amdLatencyMs' } } },
      ]),
    ]);
    return { outcomes, amd };
  }

  /** Best-time-to-call heatmap per DASH-05: connect rate by weekday/hour. */
  async heatmap(tenantId: string, campaignId?: string) {
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
    ]);
  }
}
