import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { redactPii } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { AgentActivity, AgentActivityDocument } from '../../schemas/agent-activity.schema';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Recording, RecordingDocument } from '../../schemas/recording.schema';
import { Transfer, TransferDocument } from '../../schemas/transfer.schema';
import { User, UserDocument } from '../../schemas/user.schema';

export type InsightGranularity = 'hour' | 'day' | 'month';

export interface InsightRange {
  from: Date;
  to: Date;
  granularity: InsightGranularity;
}

interface TransferAggRow {
  _id: string;
  offered: number;
  accepted: number;
  declined: number;
  timedOut: number;
  acceptMsTotal: number;
}

interface ActivityAggRow {
  _id: { userId: Types.ObjectId; state: string };
  seconds: number;
}

/** Reshape {state → seconds} rows into the fixed activity block. */
function activityBlock(rows: Array<{ state: string; seconds: number }>) {
  const by = Object.fromEntries(rows.map((r) => [r.state, r.seconds]));
  const availableSeconds = by['AVAILABLE'] ?? 0;
  const onCallSeconds = (by['ON_CALL'] ?? 0) + (by['RESERVED'] ?? 0);
  const wrapUpSeconds = by['WRAP_UP'] ?? 0;
  const breakSeconds = by['BREAK'] ?? 0;
  const working = availableSeconds + onCallSeconds + wrapUpSeconds;
  return {
    availableSeconds,
    onCallSeconds,
    wrapUpSeconds,
    breakSeconds,
    loggedInSeconds: working + breakSeconds,
    /** BPO occupancy: productive time over staffed time. */
    occupancy: working > 0 ? (onCallSeconds + wrapUpSeconds) / working : 0,
  };
}

function transferBlock(row: TransferAggRow | undefined) {
  const offered = row?.offered ?? 0;
  const accepted = row?.accepted ?? 0;
  return {
    offered,
    accepted,
    declined: row?.declined ?? 0,
    timedOut: row?.timedOut ?? 0,
    acceptanceRate: offered > 0 ? accepted / offered : 0,
    avgAcceptSeconds: accepted > 0 ? Math.round((row?.acceptMsTotal ?? 0) / accepted / 1000) : null,
  };
}

/**
 * Per-agent performance insights, BPO-style: volumes, talk time, AHT,
 * transfer acceptance discipline, occupancy, QA, recordings — for the agent
 * themself ("my day") and for supervisors/admins across the whole team.
 */
@Injectable()
export class AgentInsightsService {
  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Recording.name) private readonly recordingModel: Model<RecordingDocument>,
    @InjectModel(AgentActivity.name) private readonly activityModel: Model<AgentActivityDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  /** Everything one member (or "me") needs about their own performance. */
  async memberStats(tenantId: string, agentId: string, range: InsightRange) {
    const tid = new Types.ObjectId(tenantId);
    const aid = new Types.ObjectId(agentId);
    const { from, to, granularity } = range;

    const agent = await this.userModel
      .findOne({ _id: aid, tenantId: tid })
      .select('name email presence talkTimeTodaySeconds roles')
      .lean()
      .exec();
    if (!agent) throw new NotFoundException('Agent not found');

    const callMatch = { tenantId: tid, agentId: aid, bridgedAt: { $gte: from, $lte: to } };

    const [summaryRow] = await this.callModel.aggregate<{
      handled: number;
      booked: number;
      talkMs: number;
      avgQa: number | null;
      avgLeadScore: number | null;
    }>([
      { $match: callMatch },
      {
        $group: {
          _id: null,
          handled: { $sum: 1 },
          booked: { $sum: { $cond: [{ $eq: ['$disposition', 'BOOKED'] }, 1, 0] } },
          talkMs: {
            $sum: { $cond: [{ $and: ['$endedAt', '$bridgedAt'] }, { $subtract: ['$endedAt', '$bridgedAt'] }, 0] },
          },
          avgQa: { $avg: '$qaScore.total' },
          avgLeadScore: { $avg: '$finalScore' },
        },
      },
    ]);

    const [transferRows, activityRows, dispositionRows, timelineRows, recentRows] = await Promise.all([
      this.transferAgg(tid, from, to, agentId),
      this.activityAgg(tid, from, to, aid),
      this.callModel.aggregate<{ _id: string | null; count: number }>([
        { $match: callMatch },
        { $group: { _id: '$disposition', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      this.callModel.aggregate<{ _id: Date; handled: number; booked: number; talkMs: number }>([
        { $match: callMatch },
        {
          $group: {
            _id: { $dateTrunc: { date: '$bridgedAt', unit: granularity } },
            handled: { $sum: 1 },
            booked: { $sum: { $cond: [{ $eq: ['$disposition', 'BOOKED'] }, 1, 0] } },
            talkMs: {
              $sum: { $cond: [{ $and: ['$endedAt', '$bridgedAt'] }, { $subtract: ['$endedAt', '$bridgedAt'] }, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      this.callModel.aggregate<{
        _id: Types.ObjectId;
        bridgedAt?: Date;
        endedAt?: Date;
        disposition?: string;
        outcome?: string;
        finalScore: number;
        qaTotal?: number;
        summary: string;
        recordings: number;
      }>([
        { $match: callMatch },
        { $sort: { bridgedAt: -1 } },
        { $limit: 25 },
        { $lookup: { from: 'recordings', localField: '_id', foreignField: 'callId', as: 'recs' } },
        {
          $project: {
            bridgedAt: 1,
            endedAt: 1,
            disposition: 1,
            outcome: 1,
            finalScore: 1,
            qaTotal: '$qaScore.total',
            summary: 1,
            recordings: { $size: '$recs' },
          },
        },
      ]),
    ]);

    // Recording count over the whole range (recent list only covers 25 calls).
    const callIds = await this.callModel.find(callMatch).select('_id').lean().exec();
    const recordings = callIds.length
      ? await this.recordingModel.countDocuments({ callId: { $in: callIds.map((c) => c._id) } }).exec()
      : 0;

    const handled = summaryRow?.handled ?? 0;
    const booked = summaryRow?.booked ?? 0;
    const talkMs = summaryRow?.talkMs ?? 0;

    return {
      agent: {
        id: agent._id.toString(),
        name: agent.name,
        email: agent.email,
        presence: agent.presence,
        talkTimeTodaySeconds: agent.talkTimeTodaySeconds,
      },
      range: { from, to, granularity },
      summary: {
        handled,
        booked,
        talkSeconds: Math.round(talkMs / 1000),
        avgHandleSeconds: handled > 0 ? Math.round(talkMs / handled / 1000) : 0,
        conversionRate: handled > 0 ? booked / handled : 0,
        avgQaScore: summaryRow?.avgQa ?? null,
        avgLeadScore: summaryRow?.avgLeadScore ?? null,
        recordings,
      },
      transfers: transferBlock(transferRows.find((r) => r._id === agentId)),
      activity: activityBlock(activityRows.map((r) => ({ state: r._id.state, seconds: r.seconds }))),
      timeline: timelineRows.map((r) => ({
        bucket: r._id,
        handled: r.handled,
        booked: r.booked,
        talkSeconds: Math.round(r.talkMs / 1000),
      })),
      dispositions: dispositionRows.map((r) => ({ disposition: r._id ?? 'PENDING', count: r.count })),
      recentCalls: recentRows.map((r) => ({
        id: r._id.toString(),
        bridgedAt: r.bridgedAt,
        talkSeconds:
          r.endedAt && r.bridgedAt ? Math.round((r.endedAt.getTime() - r.bridgedAt.getTime()) / 1000) : null,
        disposition: r.disposition ?? null,
        outcome: r.outcome ?? null,
        finalScore: r.finalScore,
        qaScore: r.qaTotal ?? null,
        summary: redactPii(r.summary ?? ''),
        recordings: r.recordings,
      })),
    };
  }

  /** Roster view: one row per agent, plus the AI-vs-human floor timeline. */
  async teamStats(tenantId: string, range: InsightRange) {
    const tid = new Types.ObjectId(tenantId);
    const { from, to, granularity } = range;

    const [members, callRows, recRows, transferRows, activityRows, timelineRows] = await Promise.all([
      this.userModel
        .find({ tenantId: tid, roles: 'AGENT', active: true })
        .select('name email presence talkTimeTodaySeconds')
        .lean()
        .exec(),
      this.callModel.aggregate<{
        _id: Types.ObjectId;
        handled: number;
        booked: number;
        talkMs: number;
        avgQa: number | null;
      }>([
        { $match: { tenantId: tid, agentId: { $ne: null }, bridgedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: '$agentId',
            handled: { $sum: 1 },
            booked: { $sum: { $cond: [{ $eq: ['$disposition', 'BOOKED'] }, 1, 0] } },
            talkMs: {
              $sum: { $cond: [{ $and: ['$endedAt', '$bridgedAt'] }, { $subtract: ['$endedAt', '$bridgedAt'] }, 0] },
            },
            avgQa: { $avg: '$qaScore.total' },
          },
        },
      ]),
      this.callModel.aggregate<{ _id: Types.ObjectId; recordings: number }>([
        { $match: { tenantId: tid, agentId: { $ne: null }, bridgedAt: { $gte: from, $lte: to } } },
        { $lookup: { from: 'recordings', localField: '_id', foreignField: 'callId', as: 'recs' } },
        { $group: { _id: '$agentId', recordings: { $sum: { $size: '$recs' } } } },
      ]),
      this.transferAgg(tid, from, to),
      this.activityAgg(tid, from, to),
      // Floor timeline: how AI dial volume converts into human work.
      this.callModel.aggregate<{
        _id: Date;
        dials: number;
        connects: number;
        aiResolved: number;
        humanBridged: number;
        booked: number;
      }>([
        { $match: { tenantId: tid, startedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { $dateTrunc: { date: '$startedAt', unit: granularity } },
            dials: { $sum: 1 },
            connects: { $sum: { $cond: [{ $eq: ['$amdClass', 'HUMAN'] }, 1, 0] } },
            aiResolved: {
              $sum: {
                $cond: [{ $and: [{ $eq: ['$amdClass', 'HUMAN'] }, { $not: ['$agentId'] }] }, 1, 0],
              },
            },
            humanBridged: { $sum: { $cond: [{ $ifNull: ['$agentId', false] }, 1, 0] } },
            booked: { $sum: { $cond: [{ $eq: ['$disposition', 'BOOKED'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const callsBy = new Map(callRows.map((r) => [r._id.toString(), r]));
    const recsBy = new Map(recRows.map((r) => [r._id.toString(), r.recordings]));
    const transfersBy = new Map(transferRows.map((r) => [r._id, r]));
    const activityBy = new Map<string, Array<{ state: string; seconds: number }>>();
    for (const row of activityRows) {
      const key = row._id.userId.toString();
      const list = activityBy.get(key) ?? [];
      list.push({ state: row._id.state, seconds: row.seconds });
      activityBy.set(key, list);
    }

    const rows = members.map((m) => {
      const id = m._id.toString();
      const calls = callsBy.get(id);
      const handled = calls?.handled ?? 0;
      const booked = calls?.booked ?? 0;
      const talkMs = calls?.talkMs ?? 0;
      return {
        id,
        name: m.name,
        email: m.email,
        presence: m.presence,
        handled,
        booked,
        talkSeconds: Math.round(talkMs / 1000),
        avgHandleSeconds: handled > 0 ? Math.round(talkMs / handled / 1000) : 0,
        conversionRate: handled > 0 ? booked / handled : 0,
        avgQaScore: calls?.avgQa ?? null,
        recordings: recsBy.get(id) ?? 0,
        transfers: transferBlock(transfersBy.get(id)),
        activity: activityBlock(activityBy.get(id) ?? []),
      };
    });
    rows.sort((a, b) => b.handled - a.handled || b.booked - a.booked);

    const totals = timelineRows.reduce(
      (acc, r) => ({
        dials: acc.dials + r.dials,
        connects: acc.connects + r.connects,
        aiResolved: acc.aiResolved + r.aiResolved,
        humanBridged: acc.humanBridged + r.humanBridged,
        booked: acc.booked + r.booked,
      }),
      { dials: 0, connects: 0, aiResolved: 0, humanBridged: 0, booked: 0 },
    );

    return {
      range: { from, to, granularity },
      members: rows,
      timeline: timelineRows.map(({ _id, ...rest }) => ({ bucket: _id, ...rest })),
      totals,
    };
  }

  /** Transfer-offer discipline per agent from the cascade attempt history. */
  private transferAgg(tid: Types.ObjectId, from: Date, to: Date, agentId?: string): Promise<TransferAggRow[]> {
    return this.transferModel.aggregate<TransferAggRow>([
      { $match: { tenantId: tid, createdAt: { $gte: from, $lte: to } } },
      { $unwind: '$attempts' },
      ...(agentId ? [{ $match: { 'attempts.agentId': agentId } }] : []),
      {
        $group: {
          _id: '$attempts.agentId',
          offered: { $sum: 1 },
          accepted: { $sum: { $cond: [{ $eq: ['$attempts.result', 'ACCEPTED'] }, 1, 0] } },
          declined: { $sum: { $cond: [{ $eq: ['$attempts.result', 'DECLINED'] }, 1, 0] } },
          timedOut: { $sum: { $cond: [{ $eq: ['$attempts.result', 'TIMED_OUT'] }, 1, 0] } },
          acceptMsTotal: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$attempts.result', 'ACCEPTED'] }, '$attempts.resolvedAt'] },
                { $subtract: ['$attempts.resolvedAt', '$attempts.offeredAt'] },
                0,
              ],
            },
          },
        },
      },
    ]);
  }

  /**
   * Presence seconds by state, clipped to the range; open segments count up
   * to "now" so today's occupancy is live.
   */
  private activityAgg(tid: Types.ObjectId, from: Date, to: Date, userId?: Types.ObjectId): Promise<ActivityAggRow[]> {
    const now = new Date();
    return this.activityModel.aggregate<ActivityAggRow>([
      {
        $match: {
          tenantId: tid,
          ...(userId ? { userId } : {}),
          startedAt: { $lte: to },
          $or: [{ endedAt: null }, { endedAt: { $gte: from } }],
        },
      },
      {
        $project: {
          userId: 1,
          state: 1,
          seconds: {
            $max: [
              {
                $dateDiff: {
                  startDate: { $max: ['$startedAt', from] },
                  endDate: { $min: [{ $ifNull: ['$endedAt', now] }, to] },
                  unit: 'second',
                },
              },
              0,
            ],
          },
        },
      },
      { $group: { _id: { userId: '$userId', state: '$state' }, seconds: { $sum: '$seconds' } } },
    ]);
  }
}
