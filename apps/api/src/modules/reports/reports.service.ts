import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { toCsv } from '../../common/csv';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';

export interface ReportFilters {
  campaignId?: string;
  from?: Date;
  to?: Date;
}

interface CallCsvRow {
  startedAt: Date;
  endedAt?: Date;
  answeredAt?: Date;
  bridgedAt?: Date;
  campaignName: string;
  leadName: string;
  phone: string;
  agentName: string;
  direction: string;
  manual: boolean;
  predictive: boolean;
  cli?: string;
  amdClass?: string;
  outcome?: string;
  disposition?: string;
  finalScore: number;
  qaTotal?: number;
}

interface LeadCsvRow {
  name: string;
  phone: string;
  campaignName: string;
  state_: string;
  score: number;
  attempts: number;
  suburb?: string;
  state?: string;
  timezone: string;
  ownerName: string;
  lastContactedAt?: Date;
  nextAttemptAt?: Date;
  createdAt: Date;
}

interface CampaignSummaryRow {
  campaignName: string;
  dials: number;
  connects: number;
  connectRatePercent: number;
  abandoned: number;
  abandonRatePercent: number;
  transfers: number;
  booked: number;
  avgHandleTimeSeconds: number;
  avgQaScore: number | null;
}

/**
 * CSV report export for BPO client reporting — the platform had no export
 * path at all (see claude-dev/2026-07-23-progress-and-next-steps.md P1 #13).
 * Deliberately plain: query, shape rows, `toCsv()`. No pre-aggregation
 * cache — reports run far less often than the live dashboard panels these
 * queries are modelled on (`analytics.service.ts`).
 */
@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
  ) {}

  private matchFilter(tenantId: string, filters: ReportFilters, dateField = 'startedAt') {
    return {
      tenantId: new Types.ObjectId(tenantId),
      ...(filters.campaignId ? { campaignId: new Types.ObjectId(filters.campaignId) } : {}),
      ...(filters.from || filters.to
        ? { [dateField]: { ...(filters.from ? { $gte: filters.from } : {}), ...(filters.to ? { $lte: filters.to } : {}) } }
        : {}),
    };
  }

  async callsCsv(tenantId: string, filters: ReportFilters): Promise<string> {
    const rows = await this.callModel
      .aggregate<CallCsvRow>([
        { $match: this.matchFilter(tenantId, filters) },
        { $sort: { startedAt: -1 } },
        { $limit: 50_000 },
        { $lookup: { from: 'campaigns', localField: 'campaignId', foreignField: '_id', as: 'campaign' } },
        { $lookup: { from: 'leads', localField: 'leadId', foreignField: '_id', as: 'lead' } },
        { $lookup: { from: 'users', localField: 'agentId', foreignField: '_id', as: 'agent' } },
        {
          $project: {
            startedAt: 1,
            endedAt: 1,
            answeredAt: 1,
            bridgedAt: 1,
            cli: 1,
            amdClass: 1,
            outcome: 1,
            disposition: 1,
            finalScore: 1,
            manual: 1,
            predictive: 1,
            direction: 1,
            qaTotal: '$qaScore.total',
            campaignName: { $ifNull: [{ $arrayElemAt: ['$campaign.name', 0] }, 'Unknown'] },
            leadName: { $ifNull: [{ $arrayElemAt: ['$lead.name', 0] }, 'Unknown'] },
            phone: { $ifNull: [{ $arrayElemAt: ['$lead.phone', 0] }, ''] },
            agentName: { $ifNull: [{ $arrayElemAt: ['$agent.name', 0] }, ''] },
          },
        },
      ])
      .exec();

    return toCsv(rows, [
      { key: 'startedAt', label: 'Started At', value: (r) => r.startedAt?.toISOString() ?? '' },
      { key: 'campaignName', label: 'Campaign', value: (r) => r.campaignName },
      { key: 'leadName', label: 'Lead', value: (r) => r.leadName },
      { key: 'phone', label: 'Phone', value: (r) => r.phone },
      { key: 'mode', label: 'Mode', value: (r) => (r.predictive ? 'PREDICTIVE' : r.manual ? 'MANUAL' : 'AI') },
      { key: 'direction', label: 'Direction', value: (r) => r.direction },
      { key: 'cli', label: 'CLI', value: (r) => r.cli ?? '' },
      { key: 'amdClass', label: 'AMD', value: (r) => r.amdClass ?? '' },
      { key: 'outcome', label: 'Outcome', value: (r) => r.outcome ?? '' },
      { key: 'disposition', label: 'Disposition', value: (r) => r.disposition ?? '' },
      { key: 'agentName', label: 'Agent', value: (r) => r.agentName },
      {
        key: 'talkSeconds',
        label: 'Talk Seconds',
        value: (r) => (r.endedAt && r.answeredAt ? Math.round((r.endedAt.getTime() - r.answeredAt.getTime()) / 1000) : ''),
      },
      { key: 'finalScore', label: 'Score', value: (r) => r.finalScore ?? 0 },
      { key: 'qaTotal', label: 'QA Score', value: (r) => r.qaTotal ?? '' },
    ]);
  }

  async leadsCsv(tenantId: string, filters: ReportFilters): Promise<string> {
    const rows = await this.leadModel
      .aggregate<LeadCsvRow>([
        { $match: this.matchFilter(tenantId, filters, 'createdAt') },
        { $sort: { createdAt: -1 } },
        { $limit: 50_000 },
        { $lookup: { from: 'campaigns', localField: 'campaignId', foreignField: '_id', as: 'campaign' } },
        { $lookup: { from: 'users', localField: 'ownerId', foreignField: '_id', as: 'owner' } },
        {
          $project: {
            name: 1,
            phone: 1,
            state_: 1,
            score: 1,
            attempts: 1,
            suburb: 1,
            state: 1,
            timezone: 1,
            lastContactedAt: 1,
            nextAttemptAt: 1,
            createdAt: 1,
            campaignName: { $ifNull: [{ $arrayElemAt: ['$campaign.name', 0] }, 'Unassigned'] },
            ownerName: { $ifNull: [{ $arrayElemAt: ['$owner.name', 0] }, '' ] },
          },
        },
      ])
      .exec();

    return toCsv(rows, [
      { key: 'name', label: 'Name', value: (r) => r.name },
      { key: 'phone', label: 'Phone', value: (r) => r.phone },
      { key: 'campaignName', label: 'Campaign', value: (r) => r.campaignName },
      { key: 'state_', label: 'Lead State', value: (r) => r.state_ },
      { key: 'score', label: 'Score', value: (r) => r.score },
      { key: 'attempts', label: 'Attempts', value: (r) => r.attempts },
      { key: 'suburb', label: 'Suburb', value: (r) => r.suburb ?? '' },
      { key: 'state', label: 'State/Region', value: (r) => r.state ?? '' },
      { key: 'timezone', label: 'Timezone', value: (r) => r.timezone },
      { key: 'ownerName', label: 'Owner', value: (r) => r.ownerName },
      { key: 'lastContactedAt', label: 'Last Contacted', value: (r) => r.lastContactedAt?.toISOString() ?? '' },
      { key: 'nextAttemptAt', label: 'Next Attempt', value: (r) => r.nextAttemptAt?.toISOString() ?? '' },
      { key: 'createdAt', label: 'Created', value: (r) => r.createdAt.toISOString() },
    ]);
  }

  async campaignSummaryCsv(tenantId: string, filters: Omit<ReportFilters, 'campaignId'>): Promise<string> {
    const rows = await this.callModel
      .aggregate<CampaignSummaryRow>([
        { $match: this.matchFilter(tenantId, filters) },
        {
          $group: {
            _id: '$campaignId',
            dials: { $sum: 1 },
            connects: { $sum: { $cond: [{ $eq: ['$amdClass', 'HUMAN'] }, 1, 0] } },
            abandoned: { $sum: { $cond: [{ $eq: ['$outcome', 'ABANDONED'] }, 1, 0] } },
            transfers: { $sum: { $cond: [{ $ifNull: ['$agentId', false] }, 1, 0] } },
            booked: { $sum: { $cond: [{ $eq: ['$disposition', 'BOOKED'] }, 1, 0] } },
            totalTalkMs: { $sum: { $cond: [{ $and: ['$endedAt', '$answeredAt'] }, { $subtract: ['$endedAt', '$answeredAt'] }, 0] } },
            avgQa: { $avg: '$qaScore.total' },
          },
        },
        { $lookup: { from: 'campaigns', localField: '_id', foreignField: '_id', as: 'campaign' } },
        {
          $project: {
            campaignName: { $ifNull: [{ $arrayElemAt: ['$campaign.name', 0] }, 'Unknown'] },
            dials: 1,
            connects: 1,
            connectRatePercent: { $cond: [{ $gt: ['$dials', 0] }, { $multiply: [{ $divide: ['$connects', '$dials'] }, 100] }, 0] },
            abandoned: 1,
            abandonRatePercent: {
              $cond: [{ $gt: ['$connects', 0] }, { $multiply: [{ $divide: ['$abandoned', '$connects'] }, 100] }, 0],
            },
            transfers: 1,
            booked: 1,
            avgHandleTimeSeconds: {
              $cond: [{ $gt: ['$connects', 0] }, { $divide: [{ $divide: ['$totalTalkMs', '$connects'] }, 1000] }, 0],
            },
            avgQaScore: '$avgQa',
          },
        },
        { $sort: { dials: -1 } },
      ])
      .exec();

    return toCsv(rows, [
      { key: 'campaignName', label: 'Campaign', value: (r) => r.campaignName },
      { key: 'dials', label: 'Dials', value: (r) => r.dials },
      { key: 'connects', label: 'Connects', value: (r) => r.connects },
      { key: 'connectRatePercent', label: 'Connect Rate %', value: (r) => r.connectRatePercent.toFixed(1) },
      { key: 'abandoned', label: 'Abandoned', value: (r) => r.abandoned },
      { key: 'abandonRatePercent', label: 'Abandon Rate %', value: (r) => r.abandonRatePercent.toFixed(1) },
      { key: 'transfers', label: 'Transfers/Bridges', value: (r) => r.transfers },
      { key: 'booked', label: 'Booked', value: (r) => r.booked },
      { key: 'avgHandleTimeSeconds', label: 'Avg Handle Time (s)', value: (r) => r.avgHandleTimeSeconds.toFixed(0) },
      { key: 'avgQaScore', label: 'Avg QA Score', value: (r) => (r.avgQaScore === null ? '' : r.avgQaScore.toFixed(1)) },
    ]);
  }
}
