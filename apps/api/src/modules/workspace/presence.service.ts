import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import type { PresenceState, RoutingStrategy } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { AgentActivity, AgentActivityDocument } from '../../schemas/agent-activity.schema';
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
  ) {}

  /** Close the user's open presence segment and open one for the new state. */
  private async logSegment(tenantId: Types.ObjectId, userId: string, state: PresenceState): Promise<void> {
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
      await this.activityModel.create({ tenantId, userId: new Types.ObjectId(userId), state, startedAt: now });
    }
  }

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

  async setPresence(userId: string, state: PresenceState): Promise<void> {
    const update: Record<string, unknown> = { presence: state, lastSeenAt: new Date() };
    if (state === 'AVAILABLE') update.availableSince = new Date();
    const prev = await this.userModel
      .findOneAndUpdate({ _id: new Types.ObjectId(userId) }, update, { new: false })
      .select('presence tenantId')
      .lean()
      .exec();
    if (prev && prev.presence !== state) await this.logSegment(prev.tenantId, userId, state);
  }

  async getPresence(userId: string): Promise<PresenceState | null> {
    const user = await this.userModel.findById(userId).select('presence').lean().exec();
    return user?.presence ?? null;
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
        { _id: new Types.ObjectId(agentId), presence: { $in: ['RESERVED', 'ON_CALL'] } },
        { presence: to, ...(to === 'AVAILABLE' ? { availableSince: new Date() } : {}) },
        { new: false },
      )
      .select('tenantId')
      .lean()
      .exec();
    if (prev) await this.logSegment(prev.tenantId, agentId, to);
  }

  async markOnCall(agentId: string): Promise<void> {
    const prev = await this.userModel
      .findOneAndUpdate({ _id: new Types.ObjectId(agentId) }, { presence: 'ON_CALL' }, { new: false })
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
