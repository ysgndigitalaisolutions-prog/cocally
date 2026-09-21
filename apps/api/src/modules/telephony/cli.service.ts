import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
import { AuditService } from '../audit/audit.service';
import { Call, CallDocument } from '../../schemas/call.schema';
import { CliNumber, CliNumberDocument } from '../../schemas/cli-number.schema';

/** Minimum answered-or-not sample before the 7-day rate is trusted enough to act on — a handful of unlucky dials must not quarantine a healthy number. */
const MIN_SAMPLE_FOR_QUARANTINE = 20;
/** Below this rolling answer rate, with sample size met, the number is presumed carrier-labelled ("Spam Likely") and pulled from rotation. */
const QUARANTINE_ANSWER_RATE_THRESHOLD = 0.08;
/** Guardrail from claude-dev/2026-07-23-progress-and-next-steps.md: keep any single DID under ~150-200 dials/day. */
export const CLI_DAILY_DIAL_GUARDRAIL = 180;

/**
 * CLI pool management per TEL-07: geo-matching, rotation, and two distinct
 * health mechanisms —
 *   RESTING     same-day circuit breaker (recordDial): heavy volume + a
 *               collapsing SAME-DAY answer rate. Auto-wakes after 24h
 *               (CliService.wakeRested, called by the ops scheduler).
 *   QUARANTINED sustained decay over the rolling 7-day window
 *               (recomputeHealth). Once carrier-labelled, remediation is
 *               days-to-weeks with no guaranteed fix — this does NOT
 *               auto-wake. It requires an explicit `reinstate()` with an
 *               audit trail, so nobody dials from a suspect DID by accident.
 */
@Injectable()
export class CliService {
  private readonly logger = new Logger(CliService.name);
  private rotationCursor = 0;

  constructor(
    @InjectModel(CliNumber.name) private readonly cliModel: Model<CliNumberDocument>,
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    private readonly audit: AuditService,
  ) {}

  /**
   * Pick a CLI for a dial: prefer geo-matched (e.g. 03 numbers to VIC leads),
   * skip resting/quarantined numbers, rotate within the healthy set.
   */
  async selectCli(input: {
    tenantId: string;
    poolIds: Types.ObjectId[];
    leadState?: string;
    geoMatch: boolean;
  }): Promise<CliNumberDocument | null> {
    const filter = {
      tenantId: new Types.ObjectId(input.tenantId),
      status: 'ACTIVE' as const,
      ...(input.poolIds.length > 0 ? { _id: { $in: input.poolIds } } : {}),
    };
    const candidates = await this.cliModel.find(filter).sort({ _id: 1 }).exec();
    if (candidates.length === 0) return null;

    let pool = candidates;
    if (input.geoMatch && input.leadState) {
      const matched = candidates.filter((c) => c.geoRegion === input.leadState);
      if (matched.length > 0) pool = matched;
    }

    this.rotationCursor = (this.rotationCursor + 1) % pool.length;
    return pool[this.rotationCursor % pool.length] ?? null;
  }

  async recordDial(cliId: Types.ObjectId, answered: boolean): Promise<void> {
    await this.cliModel
      .updateOne({ _id: cliId }, { $inc: { dialsToday: 1, ...(answered ? { answersToday: 1 } : {}) } })
      .exec();
    // Fast same-day circuit breaker: heavy dials with collapsing answer rate
    // rests the number for 24h. The slower, sustained-decay judgement lives
    // in recomputeHealth() below and quarantines instead of resting.
    const cli = await this.cliModel.findById(cliId).exec();
    if (cli && cli.status === 'ACTIVE' && cli.dialsToday >= 50 && cli.answersToday / cli.dialsToday < 0.05) {
      cli.status = 'RESTING';
      cli.restingUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await cli.save();
      this.logger.warn(`CLI ${cli.number} auto-RESTING: ${cli.answersToday}/${cli.dialsToday} answered today`);
    }
  }

  /**
   * Rolling 7-day answer-rate health and auto-quarantine — the highest
   * business-value guardrail here: once a DID is carrier-labelled, >95% of
   * "Spam Likely" calls go unanswered and remediation takes days to weeks.
   * Runs every 15 minutes; recomputing per-dial would be an aggregation per
   * call at 10-30 agents' dial volume, which this cadence avoids.
   */
  @Interval(15 * 60 * 1000)
  async recomputeHealth(): Promise<void> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const numbers = await this.cliModel.find({ status: { $in: ['ACTIVE', 'RESTING'] } }).exec();
    if (numbers.length === 0) return;

    const stats = await this.callModel
      .aggregate<{ _id: string; total: number; answered: number }>([
        // Answer detection is `answeredAt`, not `amdClass`.
        //
        // Gating on `amdClass: {$exists:true}` made every live call invisible
        // here: AMD is reported asynchronously by the voice worker and is
        // absent on a manual dial entirely, so the 7-day quarantine heuristic
        // only ever saw simulated traffic — which is always HUMAN, giving a
        // permanent answer rate of 1.0 that could never cross the threshold.
        // `answeredAt` is set by the call-progress webhook the moment the
        // carrier reports the leg answered, which is the signal we actually
        // want: did a person pick up this number's call.
        { $match: { cli: { $in: numbers.map((n) => n.number) }, startedAt: { $gte: since } } },
        {
          $group: {
            _id: '$cli',
            total: { $sum: 1 },
            answered: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $ne: [{ $ifNull: ['$answeredAt', null] }, null] },
                      { $eq: ['$amdClass', 'HUMAN'] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ])
      .exec();
    const byNumber = new Map(stats.map((s) => [s._id, s]));

    for (const cli of numbers) {
      const stat = byNumber.get(cli.number);
      if (!stat || stat.total === 0) continue;
      const rate = stat.answered / stat.total;
      cli.answerRate7d = rate;

      if (stat.total >= MIN_SAMPLE_FOR_QUARANTINE && rate < QUARANTINE_ANSWER_RATE_THRESHOLD && cli.status === 'ACTIVE') {
        cli.status = 'QUARANTINED';
        cli.quarantinedAt = new Date();
        cli.quarantineReason = `7-day answer rate ${(rate * 100).toFixed(1)}% over ${stat.total} dials (< ${(QUARANTINE_ANSWER_RATE_THRESHOLD * 100).toFixed(0)}% threshold) — likely carrier-labelled.`;
        this.logger.warn(`CLI ${cli.number} auto-QUARANTINED: ${cli.quarantineReason}`);
        await this.audit.record({
          tenantId: cli.tenantId.toString(),
          actorLabel: 'system:cli-health',
          action: 'cli.auto_quarantine',
          entityType: 'CliNumber',
          entityId: cli._id.toString(),
          before: { status: 'ACTIVE' },
          after: { status: 'QUARANTINED', reason: cli.quarantineReason },
        });
        // Carrier/ops alert: no SMTP/webhook target configured yet, so this
        // is the notification of record for now — surfaced to the CLI health
        // dashboard via `list()` below, not silently buried in a log file.
      }
      await cli.save();
    }
  }

  /** Called by the ops scheduler: wake RESTING numbers whose 24h cool-down elapsed. QUARANTINED numbers are untouched — they need `reinstate()`. */
  async wakeRested(): Promise<void> {
    await this.cliModel
      .updateMany({ status: 'RESTING', restingUntil: { $lte: new Date() } }, { status: 'ACTIVE', restingUntil: null })
      .exec();
  }

  async resetDailyCounters(): Promise<void> {
    await this.cliModel.updateMany({}, { dialsToday: 0, answersToday: 0 }).exec();
  }

  async addNumber(tenantId: string, input: { number: string; geoRegion?: string; countryPackCode: string }) {
    return this.cliModel.create({ tenantId: new Types.ObjectId(tenantId), ...input });
  }

  async list(tenantId: string) {
    return this.cliModel.find({ tenantId: new Types.ObjectId(tenantId) }).sort({ number: 1 }).lean().exec();
  }

  /** Manual reinstate — the only way a QUARANTINED number returns to rotation, always audited. */
  async reinstate(tenantId: string, actor: { id: string; label: string }, cliId: string, reason: string): Promise<CliNumberDocument> {
    if (!Types.ObjectId.isValid(cliId)) throw new NotFoundException('CLI number not found');
    const cli = await this.cliModel.findOne({ _id: new Types.ObjectId(cliId), tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!cli) throw new NotFoundException('CLI number not found');
    if (cli.status !== 'QUARANTINED') throw new BadRequestException('Only a quarantined number can be reinstated.');
    if (!reason.trim()) throw new BadRequestException('A reinstate reason is required for the audit trail.');

    cli.status = 'ACTIVE';
    cli.reinstatedBy = new Types.ObjectId(actor.id);
    cli.reinstatedAt = new Date();
    await cli.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'cli.reinstate',
      entityType: 'CliNumber',
      entityId: cliId,
      before: { status: 'QUARANTINED', quarantineReason: cli.quarantineReason },
      after: { status: 'ACTIVE', reason },
    });
    return cli;
  }

  /** Manual quarantine — a supervisor pulling a number on their own judgement (e.g. a carrier phone call), same audit trail as the automatic path. */
  async quarantine(tenantId: string, actor: { id: string; label: string }, cliId: string, reason: string): Promise<CliNumberDocument> {
    if (!Types.ObjectId.isValid(cliId)) throw new NotFoundException('CLI number not found');
    const cli = await this.cliModel.findOne({ _id: new Types.ObjectId(cliId), tenantId: new Types.ObjectId(tenantId) }).exec();
    if (!cli) throw new NotFoundException('CLI number not found');
    if (!reason.trim()) throw new BadRequestException('A quarantine reason is required for the audit trail.');

    const before = cli.status;
    cli.status = 'QUARANTINED';
    cli.quarantinedAt = new Date();
    cli.quarantineReason = reason;
    await cli.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'cli.manual_quarantine',
      entityType: 'CliNumber',
      entityId: cliId,
      before: { status: before },
      after: { status: 'QUARANTINED', reason },
    });
    return cli;
  }
}
