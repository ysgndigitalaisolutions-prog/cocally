import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { config } from '../../common/config';
import { Call, CallDocument } from '../../schemas/call.schema';
import { User, UserDocument } from '../../schemas/user.schema';
import { RecordingsService } from '../recordings/recordings.service';
import { CallProgressService } from '../telephony/call-progress.service';
import { CliService } from '../telephony/cli.service';

/** A call sitting in a non-terminal state longer than this is presumed dead. */
const HUNG_CALL_MINUTES = 60;

const NON_TERMINAL_STATES = [
  'DIALING',
  'RINGING',
  'AMD_CLASSIFYING',
  'IN_CONVERSATION',
  'TRANSFER_PENDING',
  'BRIDGED',
  'WRAP_UP',
];

/**
 * The platform's scheduled-maintenance loop.
 *
 * Several housekeeping routines existed as well-written methods that nothing
 * ever called — `CliService.wakeRested`, `CliService.resetDailyCounters` (whose
 * own docstring said "called by the ops scheduler", which did not exist) and
 * `RecordingsService.purgeExpired`. The effect was silent: rested CLI numbers
 * never woke, daily counters grew without bound, and the retention promise was
 * never enforced. This service is that missing scheduler.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly cli: CliService,
    private readonly progress: CallProgressService,
    private readonly recordings: RecordingsService,
  ) {}

  /** Wake CLI numbers whose rest period has elapsed. */
  @Interval(5 * 60_000)
  async wakeRestedNumbers(): Promise<void> {
    try {
      await this.cli.wakeRested();
    } catch (err) {
      this.logger.error(`wakeRested failed: ${(err as Error).message}`);
    }
  }

  /**
   * Midnight rollover.
   *
   * `talkTimeTodaySeconds` was only ever incremented, so "today" silently became
   * lifetime talk time. That misreported the dashboard AND corrupted routing:
   * the LEAST_TALK_TIME strategy sorts on this field, so without a reset it
   * biases work permanently toward whoever joined the floor most recently.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { timeZone: config.businessTimezone })
  async dailyRollover(): Promise<void> {
    try {
      await this.cli.resetDailyCounters();
      const res = await this.userModel.updateMany({}, { talkTimeTodaySeconds: 0 }).exec();
      this.logger.log(`Daily rollover: reset CLI counters and talk time for ${res.modifiedCount} user(s)`);
    } catch (err) {
      this.logger.error(`dailyRollover failed: ${(err as Error).message}`);
    }
  }

  /** Enforce the recording retention window. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeRecordings(): Promise<void> {
    try {
      const purged = await this.recordings.purgeExpired();
      if (purged > 0) this.logger.log(`Purged ${purged} expired recording(s)`);
    } catch (err) {
      this.logger.error(`purgeExpired failed: ${(err as Error).message}`);
    }
  }

  /**
   * Force-complete calls stranded in a non-terminal state.
   *
   * Live-call bookkeeping lives in an in-process map, so a crash or restart
   * mid-call leaves the `Call` document parked in IN_CONVERSATION forever —
   * inflating concurrency counts, skewing every "in progress" metric, and
   * holding the agent's lead. Leads already had a 10-minute lock reclaim; calls
   * had no equivalent.
   */
  @Interval(10 * 60_000)
  async sweepHungCalls(): Promise<number> {
    const cutoff = new Date(Date.now() - HUNG_CALL_MINUTES * 60_000);
    try {
      // Keyed on last activity (`updatedAt`), not start time: a long, live
      // conversation keeps writing transcript/score updates and must not be
      // cut off at the hour mark. WRAP_UP is excluded — that record belongs
      // to the agent's disposition.
      const hung = await this.callModel
        .find({ state: { $in: NON_TERMINAL_STATES.filter((s) => s !== 'WRAP_UP') }, updatedAt: { $lte: cutoff } })
        .select('_id recordingEgressId outcome')
        .lean()
        .exec();
      let swept = 0;
      for (const c of hung) {
        const res = await this.callModel
          .updateOne(
            { _id: c._id, state: { $in: NON_TERMINAL_STATES } },
            {
              $set: {
                state: 'FAILED',
                ...(c.outcome ? {} : { outcome: 'FAILED' }),
                endedAt: new Date(),
                endReason: 'TIMEOUT',
                dispositionNotes: 'Auto-closed: no activity on this call for over an hour.',
              },
            },
          )
          .exec();
        if (res.modifiedCount === 0) continue;
        swept += 1;
        await this.progress.releaseResources({ _id: c._id, recordingEgressId: c.recordingEgressId });
      }
      if (swept > 0) this.logger.warn(`Swept ${swept} hung call(s) idle for over ${HUNG_CALL_MINUTES}m`);
      return swept;
    } catch (err) {
      this.logger.error(`sweepHungCalls failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
