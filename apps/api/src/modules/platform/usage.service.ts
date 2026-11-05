import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type PipelineStage } from 'mongoose';
import { Call, CallDocument } from '../../schemas/call.schema';
import { inBucket } from './usage-buckets';

/** Raw usage over a period, measured from calls. */
export interface TenantUsage {
  dials: number;
  answered: number;
  /** Reached a person. `answered` also counts a line the carrier picked up where nobody spoke. */
  pickedUp: number;
  voicemail: number;
  gate: number;
  noAnswer: number;
  /** Never rang: the carrier refused the call (e.g. SIP 503) or the number is dead. */
  failed: number;
  transfers: number;
  manualDials: number;
  ringSeconds: number;
  aiSeconds: number;
  humanSeconds: number;
  recordedSeconds: number;
  ttsChars: number;
}

export const EMPTY_USAGE: TenantUsage = {
  dials: 0,
  answered: 0,
  pickedUp: 0,
  voicemail: 0,
  gate: 0,
  noAnswer: 0,
  failed: 0,
  transfers: 0,
  manualDials: 0,
  ringSeconds: 0,
  aiSeconds: 0,
  humanSeconds: 0,
  recordedSeconds: 0,
  ttsChars: 0,
};

/** One place that turns calls into billable/costable usage, for the Platform screen, invoices and the tenant's own Usage page. */
@Injectable()
export class UsageService {
  constructor(@InjectModel(Call.name) private readonly callModel: Model<CallDocument>) {}

  /**
   * Usage grouped by tenant or by campaign, measured from call timestamps and transcripts.
   *
   * Seconds are capped where the timestamps cannot be trusted: a call the
   * finaliser missed was closed by the hung-call sweep an hour later, and
   * counting that hour as AI time would invent cost. AI time therefore ends
   * at the last transcript line + 30 s (or 2 min with no transcript), and no
   * call counts more than 30 min of AI or 4 h with a human.
   */
  async usage(opts: {
    from?: Date;
    to?: Date;
    tenantId?: string;
    callIds?: string[];
    groupBy?: 'tenantId' | 'campaignId' | '_id' | 'day';
    /** IANA zone the `day` grouping uses for its calendar dates (default Asia/Kolkata). */
    timezone?: string;
  }): Promise<Map<string, TenantUsage>> {
    const { from, to } = opts;
    const groupBy = opts.groupBy ?? 'tenantId';
    const ms = (a: unknown, b: unknown) => ({ $max: [0, { $subtract: [a, b] }] });
    const pipeline: PipelineStage[] = [
      {
        $match: {
          ...(from && to ? { startedAt: { $gte: from, $lt: to } } : {}),
          ...(opts.tenantId ? { tenantId: new Types.ObjectId(opts.tenantId) } : {}),
          ...(opts.callIds ? { _id: { $in: opts.callIds.map((id) => new Types.ObjectId(id)) } } : {}),
        },
      },
      {
        $project: {
          tenantId: 1,
          campaignId: 1,
          manual: { $ifNull: ['$manual', false] },
          answered: { $cond: [{ $ifNull: ['$answeredAt', false] }, 1, 0] },
          pickedUp: inBucket('pickedUp'),
          voicemail: inBucket('voicemail'),
          gate: inBucket('gate'),
          noAnswer: inBucket('noAnswer'),
          failed: inBucket('failed'),
          recorded: { $cond: [{ $ifNull: ['$recordingUri', false] }, 1, 0] },
          aiCall: {
            $and: [
              { $not: [{ $ifNull: ['$manual', false] }] },
              { $not: [{ $ifNull: ['$predictive', false] }] },
              { $ifNull: ['$flowVersionId', false] },
            ],
          },
          startedAt: 1,
          answeredAt: 1,
          bridgedAt: 1,
          end: { $ifNull: ['$endedAt', '$$NOW'] },
          lastLineMs: { $max: '$transcript.endMs' },
          ttsChars: {
            $reduce: {
              input: { $filter: { input: { $ifNull: ['$transcript', []] }, cond: { $eq: ['$$this.speaker', 'ai'] } } },
              initialValue: 0,
              in: { $add: ['$$value', { $strLenCP: { $ifNull: ['$$this.text', ''] } }] },
            },
          },
        },
      },
      {
        $project: {
          tenantId: 1,
          campaignId: 1,
          manual: 1,
          answered: 1,
          pickedUp: 1,
          voicemail: 1,
          gate: 1,
          noAnswer: 1,
          failed: 1,
          recorded: 1,
          aiCall: 1,
          ttsChars: 1,
          day: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: opts.timezone ?? 'Asia/Kolkata' } },
          transfer: { $cond: [{ $and: ['$aiCall', { $ifNull: ['$bridgedAt', false] }] }, 1, 0] },
          ringMs: {
            $cond: [
              { $ifNull: ['$answeredAt', false] },
              ms('$answeredAt', '$startedAt'),
              { $min: [60_000, ms('$end', '$startedAt')] },
            ],
          },
          aiMs: {
            $cond: [
              { $and: ['$aiCall', { $ifNull: ['$answeredAt', false] }] },
              {
                $min: [
                  30 * 60_000,
                  ms({ $ifNull: ['$bridgedAt', '$end'] }, '$answeredAt'),
                  {
                    $cond: [
                      { $ifNull: ['$lastLineMs', false] },
                      ms({ $add: ['$startedAt', '$lastLineMs', 30_000] }, '$answeredAt'),
                      120_000,
                    ],
                  },
                ],
              },
              0,
            ],
          },
          humanMs: {
            $cond: [{ $ifNull: ['$bridgedAt', false] }, { $min: [4 * 3600_000, ms('$end', '$bridgedAt')] }, 0],
          },
        },
      },
      {
        $group: {
          _id: `$${groupBy}`,
          dials: { $sum: 1 },
          answered: { $sum: '$answered' },
          pickedUp: { $sum: '$pickedUp' },
          voicemail: { $sum: '$voicemail' },
          gate: { $sum: '$gate' },
          noAnswer: { $sum: '$noAnswer' },
          failed: { $sum: '$failed' },
          transfers: { $sum: '$transfer' },
          manualDials: { $sum: { $cond: ['$manual', 1, 0] } },
          ringMs: { $sum: '$ringMs' },
          aiMs: { $sum: '$aiMs' },
          humanMs: { $sum: '$humanMs' },
          recordedMs: { $sum: { $cond: ['$recorded', { $add: ['$aiMs', '$humanMs'] }, 0] } },
          ttsChars: { $sum: { $cond: ['$aiCall', '$ttsChars', 0] } },
        },
      },
    ];
    const rows = await this.callModel
      .aggregate<{
        _id: Types.ObjectId | string | null;
        dials: number;
        answered: number;
        pickedUp: number;
        voicemail: number;
        gate: number;
        noAnswer: number;
        failed: number;
        transfers: number;
        manualDials: number;
        ringMs: number;
        aiMs: number;
        humanMs: number;
        recordedMs: number;
        ttsChars: number;
      }>(pipeline)
      .exec();
    const out = new Map<string, TenantUsage>();
    for (const r of rows) {
      out.set(String(r._id), {
        dials: r.dials,
        answered: r.answered,
        pickedUp: r.pickedUp,
        voicemail: r.voicemail,
        gate: r.gate,
        noAnswer: r.noAnswer,
        failed: r.failed,
        transfers: r.transfers,
        manualDials: r.manualDials,
        ringSeconds: Math.round(r.ringMs / 1000),
        aiSeconds: Math.round(r.aiMs / 1000),
        humanSeconds: Math.round(r.humanMs / 1000),
        recordedSeconds: Math.round(r.recordedMs / 1000),
        ttsChars: r.ttsChars,
      });
    }
    return out;
  }
}
