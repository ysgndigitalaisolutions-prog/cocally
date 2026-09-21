import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import {
  PAUSE_CODES,
  PAUSE_CODE_LABELS,
  PRODUCTIVE_PAUSE_CODES,
  type AgentShiftState,
  type PauseCode,
  type PresenceState,
  type RoutingStrategy,
} from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { AgentActivity, AgentActivityDocument } from '../../schemas/agent-activity.schema';
import { Call, CallDocument } from '../../schemas/call.schema';
import { User, UserDocument } from '../../schemas/user.schema';

/**
 * Presence states the sweep may auto-end. ON_CALL and RESERVED are owned by an
 * in-flight call or transfer offer, which have their own timeouts — ending
 * those here would cut across the cascade.
 */
const SWEEPABLE_STATES: PresenceState[] = ['AVAILABLE', 'WRAP_UP', 'BREAK'];

/**
 * Presence per WS-01 and transfer eligibility per XFER-01: logged-in,
 * presence Available, skill match (campaign, language).
 *
 * Every transition also writes the AgentActivity session log, which drives
 * per-agent occupancy / adherence insights.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  /** Round-robin cursor per campaign. */
  private readonly rrCursor = new Map<string, number>();

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(AgentActivity.name) private readonly activityModel: Model<AgentActivityDocument>,
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
  ) {}

  /**
   * Close the user's open presence segment and open one for the new state.
   *
   * `pauseCode` is stamped onto the new segment (BREAK only). Without it the
   * activity log can answer "how long were they paused" but not "was that
   * pause productive", which is the whole basis of adherence reporting.
   */
  private async logSegment(
    tenantId: Types.ObjectId,
    userId: string,
    state: PresenceState,
    pauseCode?: PauseCode,
  ): Promise<void> {
    const now = new Date();
    await this.activityModel
      .updateMany({ userId: new Types.ObjectId(userId), endedAt: null }, [
        {
          $set: {
            endedAt: now,
            durationSeconds: { $dateDiff: { startDate: '$startedAt', endDate: now, unit: 'second' } },
          },
        },
      ])
      .exec();
    // OFFLINE has no meaningful duration — the shift simply has no open segment.
    if (state !== 'OFFLINE') {
      await this.activityModel.create({
        tenantId,
        userId: new Types.ObjectId(userId),
        state,
        startedAt: now,
        ...(state === 'BREAK' && pauseCode ? { pauseCode } : {}),
      });
    }
  }

  /**
   * Every transition out of BREAK must wipe the reason code. A stale
   * `pauseCode` on an AVAILABLE agent shows up in the supervisor wallboard as
   * "at lunch while taking calls", and quietly corrupts adherence totals.
   */
  private static readonly CLEAR_PAUSE = { pauseCode: '', pausedSince: '' } as const;

  /**
   * Client keep-alive. Only refreshes the timestamp — it never revives a
   * presence the sweep already ended, so a backgrounded tab can't silently put
   * an agent back on the floor.
   */
  async heartbeat(userId: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: new Types.ObjectId(userId) }, { lastSeenAt: new Date() })
      .exec();
  }

  /**
   * Sign out staffed agents whose client stopped checking in (closed laptop,
   * dropped network). Without this an agent stays AVAILABLE forever: the
   * dialer keeps pacing calls against them and every transfer offer they get
   * times out, cascading to someone else after burning the accept window.
   */
  @Interval(60_000)
  async sweepStalePresence(): Promise<void> {
    const cutoff = new Date(Date.now() - config.presenceTimeoutMinutes * 60_000);
    const stale = await this.userModel
      .find({
        presence: { $in: SWEEPABLE_STATES },
        $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: { $exists: false } }, { lastSeenAt: null }],
      })
      .select('_id email presence')
      .lean()
      .exec();

    for (const user of stale) {
      await this.setPresence(user._id.toString(), 'OFFLINE');
      this.logger.log(
        `Auto-signed-out ${user.email} from ${user.presence} — no heartbeat for ${config.presenceTimeoutMinutes}m`,
      );
    }
  }

  /**
   * Agent-driven presence change.
   *
   * Two rails that the floor cannot operate without:
   *   • BREAK requires a reason code. A single undifferentiated BREAK makes
   *     adherence unreportable and payroll unauditable, so it is rejected
   *     rather than defaulted — a defaulted code is worse than none, because
   *     it looks like real data.
   *   • AVAILABLE requires the agent to be clocked in. Otherwise the dialer
   *     paces calls at, and transfers cascade to, someone who is not on shift.
   *     Only enforced for AGENTs: supervisors and admins flip presence to
   *     take an overflow call without running a shift.
   */
  async setPresence(userId: string, state: PresenceState, pauseCode?: PauseCode): Promise<void> {
    if (state === 'BREAK' && !pauseCode) {
      throw new BadRequestException('Select a pause code (break, lunch, training…) before going on break.');
    }
    const now = new Date();
    const prevDoc = await this.userModel
      .findById(userId)
      .select('presence tenantId roles clockedInAt')
      .lean()
      .exec();
    if (state === 'AVAILABLE' && prevDoc?.roles.includes('AGENT') && !prevDoc.clockedInAt) {
      throw new BadRequestException('Clock in before going available — you are not on shift yet.');
    }

    const set: Record<string, unknown> = { presence: state, lastSeenAt: now };
    if (state === 'AVAILABLE') set.availableSince = now;
    if (state === 'BREAK' && pauseCode) {
      set.pauseCode = pauseCode;
      set.pausedSince = now;
    }
    const update =
      state === 'BREAK'
        ? { $set: set }
        : { $set: set, $unset: PresenceService.CLEAR_PAUSE };

    const prev = await this.userModel
      .findOneAndUpdate({ _id: new Types.ObjectId(userId) }, update, { new: false })
      .select('presence tenantId')
      .lean()
      .exec();
    // A BREAK→BREAK move with a *different* code is a real transition: the old
    // segment has to close so each code gets its own duration.
    const codeChanged = state === 'BREAK' && prevDoc?.presence === 'BREAK';
    if (prev && (prev.presence !== state || codeChanged)) {
      await this.logSegment(prev.tenantId, userId, state, pauseCode);
    }
  }

  async getPresence(userId: string): Promise<PresenceState | null> {
    const user = await this.userModel.findById(userId).select('presence').lean().exec();
    return user?.presence ?? null;
  }

  // ── Time clock ──────────────────────────────────────────────────────────

  /**
   * Clock on. Deliberately does NOT make the agent available — clocking in and
   * going available are two decisions (headset check, briefing, CRM login),
   * and conflating them puts calls on an agent who is still finding their
   * chair. Re-clocking in while already on shift is a no-op so a reload cannot
   * silently reset the shift timer.
   */
  async clockIn(userId: string): Promise<{ ok: true; clockedInAt: number }> {
    const user = await this.userModel.findById(userId).select('clockedInAt').exec();
    if (!user) throw new BadRequestException('User not found');
    if (!user.clockedInAt) {
      user.clockedInAt = new Date();
      await user.save();
      this.logger.log(`agent ${userId} clocked in`);
    }
    return { ok: true, clockedInAt: (user.clockedInAt as Date).getTime() };
  }

  /**
   * Clock off. Forces OFFLINE in the same move — an agent left AVAILABLE off
   * the clock is exactly the ghost the presence sweep exists to kill, and the
   * open activity segment has to be closed or the shift totals run forever.
   */
  async clockOut(userId: string): Promise<{ ok: true }> {
    await this.setPresence(userId, 'OFFLINE');
    await this.userModel
      .updateOne({ _id: new Types.ObjectId(userId) }, { $unset: { clockedInAt: '', ...PresenceService.CLEAR_PAUSE } })
      .exec();
    this.logger.log(`agent ${userId} clocked out`);
    return { ok: true };
  }

  /**
   * Everything the agent header needs: am I on shift, on what pause, for how
   * long, and is a wrap-up timer running.
   *
   * `pausedSeconds` is summed from the AgentActivity segments rather than from
   * `pausedSince`, so it survives reloads, covers every code the agent moved
   * through this shift, and matches what adherence reporting will later show.
   */
  async shiftState(userId: string): Promise<AgentShiftState> {
    const user = await this.userModel
      .findById(userId)
      .select('presence pauseCode pausedSince clockedInAt')
      .lean()
      .exec();
    if (!user) throw new BadRequestException('User not found');

    const now = Date.now();
    const shiftStart = user.clockedInAt ?? null;
    const clockedInAt = shiftStart?.getTime() ?? null;

    let pausedSeconds = 0;
    if (shiftStart) {
      const segments = await this.activityModel
        .find({ userId: new Types.ObjectId(userId), state: 'BREAK', startedAt: { $gte: shiftStart } })
        .select('startedAt endedAt durationSeconds')
        .lean()
        .exec();
      for (const segment of segments) {
        // The open segment has no durationSeconds yet — count it live so the
        // timer in the UI ticks instead of jumping when the agent comes back.
        pausedSeconds += segment.endedAt
          ? (segment.durationSeconds ?? 0)
          : Math.max(0, Math.round((now - segment.startedAt.getTime()) / 1000));
      }
    }

    // The wrap-up countdown is stored on the call, not the user: it belongs to
    // the piece of work being wrapped up, and survives an API restart there.
    // Not filtered on call state — a manual dial sits in WRAP_UP, but an AI
    // call is already COMPLETED while its agent is still writing notes.
    const wrapUp =
      user.presence === 'WRAP_UP'
        ? await this.callModel
            .findOne({ agentId: new Types.ObjectId(userId), wrapUpDeadline: { $ne: null } })
            .sort({ startedAt: -1 })
            .select('wrapUpDeadline')
            .lean()
            .exec()
        : null;

    return {
      presence: user.presence,
      pauseCode: user.pauseCode ?? null,
      pausedSince: user.pausedSince?.getTime() ?? null,
      clockedInAt,
      shiftSeconds: clockedInAt === null ? 0 : Math.max(0, Math.round((now - clockedInAt) / 1000)),
      pausedSeconds,
      wrapUpDeadline: wrapUp?.wrapUpDeadline?.getTime() ?? null,
    };
  }

  /** Pause-code picker payload: code, human label, and whether it is paid time. */
  pauseCodes(): Array<{ code: PauseCode; label: string; productive: boolean }> {
    return PAUSE_CODES.map((code) => ({
      code,
      label: PAUSE_CODE_LABELS[code],
      productive: PRODUCTIVE_PAUSE_CODES.includes(code),
    }));
  }

  /**
   * Wrap-up expiry: return an agent to the floor. Returns the state they
   * landed in, or null when they had already moved on themselves (the sweep
   * must never yank an agent out of a break they took after wrapping up).
   *
   * An agent who clocked out during wrap-up goes OFFLINE, not AVAILABLE —
   * otherwise the timer puts a departed agent back in the dialer's pool.
   */
  async returnFromWrapUp(userId: string): Promise<PresenceState | null> {
    const user = await this.userModel.findById(userId).select('presence clockedInAt tenantId').lean().exec();
    if (!user || user.presence !== 'WRAP_UP') return null;
    const to: PresenceState = user.clockedInAt ? 'AVAILABLE' : 'OFFLINE';
    const prev = await this.userModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(userId), presence: 'WRAP_UP' },
        {
          $set: { presence: to, ...(to === 'AVAILABLE' ? { availableSince: new Date() } : {}) },
          $unset: PresenceService.CLEAR_PAUSE,
        },
        { new: false },
      )
      .select('tenantId')
      .lean()
      .exec();
    if (!prev) return null;
    await this.logSegment(prev.tenantId, userId, to);
    return to;
  }

  /** Live team roster: every agent/supervisor with their server-truth presence. */
  async team(tenantId: string) {
    const users = await this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId), active: true, roles: { $in: ['AGENT', 'SUPERVISOR'] } })
      .select('name email roles presence availableSince talkTimeTodaySeconds skills')
      .lean()
      .exec();
    return users.map((u) => ({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      roles: u.roles,
      presence: u.presence,
      availableSince: u.availableSince ?? null,
      talkTimeTodaySeconds: u.talkTimeTodaySeconds,
      skills: u.skills,
    }));
  }

  /** Free-closer count driving availability-aware pacing per XFER-03. */
  async availableAgentCount(tenantId: string, campaignId: string): Promise<number> {
    return this.userModel
      .countDocuments({
        tenantId: new Types.ObjectId(tenantId),
        presence: 'AVAILABLE',
        active: true,
        roles: 'AGENT',
        $or: [{ skills: { $size: 0 } }, { skills: campaignId }],
      })
      .exec();
  }

  /**
   * Pick the next agent per XFER-01 selection strategies. Excluded ids are
   * agents already offered this transfer (cascade per XFER-04).
   */
  async selectAgent(input: {
    tenantId: string;
    campaignId: string;
    strategy: RoutingStrategy;
    excludeIds: string[];
    stickyAgentId?: string;
  }): Promise<UserDocument | null> {
    const { tenantId, campaignId, strategy, excludeIds, stickyAgentId } = input;

    if (strategy === 'STICKY' && stickyAgentId && !excludeIds.includes(stickyAgentId)) {
      const sticky = await this.userModel
        .findOne({ _id: new Types.ObjectId(stickyAgentId), presence: 'AVAILABLE', active: true })
        .exec();
      if (sticky) return sticky;
    }

    const baseFilter = {
      tenantId: new Types.ObjectId(tenantId),
      presence: 'AVAILABLE' as const,
      active: true,
      roles: 'AGENT',
      _id: { $nin: excludeIds.map((id) => new Types.ObjectId(id)) },
      $or: [{ skills: { $size: 0 } }, { skills: campaignId }],
    };

    switch (strategy) {
      case 'LEAST_TALK_TIME':
        return this.userModel.findOne(baseFilter).sort({ talkTimeTodaySeconds: 1 }).exec();
      case 'SKILL_PRIORITY':
        return this.userModel.findOne({ ...baseFilter, skills: campaignId }).sort({ availableSince: 1 }).exec();
      case 'ROUND_ROBIN': {
        const candidates = await this.userModel.find(baseFilter).sort({ _id: 1 }).exec();
        if (candidates.length === 0) return null;
        const cursor = this.rrCursor.get(campaignId) ?? 0;
        this.rrCursor.set(campaignId, (cursor + 1) % candidates.length);
        return candidates[cursor % candidates.length] ?? null;
      }
      case 'STICKY':
      case 'LONGEST_IDLE':
      default:
        return this.userModel.findOne(baseFilter).sort({ availableSince: 1 }).exec();
    }
  }

  /** Reserve an agent per XFER-02 so parallel transfers cannot double-book. */
  async reserve(agentId: Types.ObjectId): Promise<boolean> {
    const prev = await this.userModel
      .findOneAndUpdate({ _id: agentId, presence: 'AVAILABLE' }, { presence: 'RESERVED' }, { new: false })
      .select('tenantId')
      .lean()
      .exec();
    if (!prev) return false;
    await this.logSegment(prev.tenantId, agentId.toString(), 'RESERVED');
    return true;
  }

  async release(agentId: string, to: PresenceState = 'AVAILABLE'): Promise<void> {
    const prev = await this.userModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(agentId), presence: { $in: ['RESERVED', 'ON_CALL', 'WRAP_UP'] } },
        {
          $set: { presence: to, ...(to === 'AVAILABLE' ? { availableSince: new Date() } : {}) },
          $unset: PresenceService.CLEAR_PAUSE,
        },
        { new: false },
      )
      .select('presence tenantId')
      .lean()
      .exec();
    if (prev && prev.presence !== to) await this.logSegment(prev.tenantId, agentId, to);
  }

  async markOnCall(agentId: string): Promise<void> {
    const prev = await this.userModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(agentId) },
        { $set: { presence: 'ON_CALL' }, $unset: PresenceService.CLEAR_PAUSE },
        { new: false },
      )
      .select('presence tenantId')
      .lean()
      .exec();
    if (prev && prev.presence !== 'ON_CALL') await this.logSegment(prev.tenantId, agentId, 'ON_CALL');
  }

  async addTalkTime(agentId: string, seconds: number): Promise<void> {
    await this.userModel
      .updateOne({ _id: new Types.ObjectId(agentId) }, { $inc: { talkTimeTodaySeconds: seconds } })
      .exec();
  }
}
