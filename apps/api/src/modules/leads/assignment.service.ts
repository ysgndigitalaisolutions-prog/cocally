import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { User, UserDocument } from '../../schemas/user.schema';

/** States a lead can still be worked in. Mirrors DialerService.DIALABLE_STATES. */
const WORKABLE_STATES = ['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'];

/** How long an owned-but-untouched lead is held before returning to the pool. */
const STALE_OWNERSHIP_HOURS = 12;

/** Default size of an agent's personal worklist. */
export const DEFAULT_WORKLIST_TARGET = 25;

export type AssignStrategy = 'ROUND_ROBIN' | 'LEAST_LOADED' | 'SCORE_BALANCED';

/**
 * Lead ownership / distribution for a human-dialer floor.
 *
 * The problem this solves: without ownership every agent's worklist is the same
 * score-sorted head of the campaign, so 15 callers race for the same records and
 * 14 of them lose every click. Assigning `ownerId` partitions the book so each
 * agent has a private, collision-free queue.
 *
 * Distribution is PULL-based (`topUp`) rather than a supervisor pushing batches:
 * an agent draws work only when their queue runs low, so leads aren't stranded
 * in the queue of someone who logged off, and a fast closer isn't throttled by
 * an even split. Each draw is an atomic `findOneAndUpdate` guarded on
 * `ownerId: null`, so two agents topping up simultaneously can never take the
 * same lead — the loser simply draws the next one.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  /**
   * Draw unowned leads into an agent's worklist until it reaches `target`.
   *
   * Returns the number newly assigned. Safe to call on every worklist fetch —
   * it no-ops once the agent is at target.
   */
  async topUp(
    tenantId: string,
    agentId: string,
    campaignIds: Types.ObjectId[],
    target = DEFAULT_WORKLIST_TARGET,
  ): Promise<number> {
    if (campaignIds.length === 0) return 0;
    const tenant = new Types.ObjectId(tenantId);
    const owner = new Types.ObjectId(agentId);

    const held = await this.leadModel.countDocuments({
      tenantId: tenant,
      ownerId: owner,
      state_: { $in: WORKABLE_STATES },
    });
    const deficit = target - held;
    if (deficit <= 0) return 0;

    const now = new Date();
    let claimed = 0;
    for (let i = 0; i < deficit; i += 1) {
      // Atomic: only succeeds if the lead is still unowned when we write.
      const lead = await this.leadModel
        .findOneAndUpdate(
          {
            tenantId: tenant,
            campaignId: { $in: campaignIds },
            state_: { $in: WORKABLE_STATES },
            ownerId: null,
            manualClaimedBy: null,
            $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
          },
          { $set: { ownerId: owner, assignedAt: now } },
          // Best leads first, then oldest-due — the standard BPO work order.
          { sort: { score: -1, nextAttemptAt: 1 }, new: true },
        )
        .exec();
      if (!lead) break; // Pool exhausted.
      claimed += 1;
    }
    if (claimed > 0) this.logger.debug(`Assigned ${claimed} lead(s) to agent ${agentId}`);
    return claimed;
  }

  /**
   * Supervisor bulk-assign: distribute unowned leads across a set of agents.
   * Used to pre-load a shift, or to push a fresh list onto the floor at once.
   */
  async distribute(
    tenantId: string,
    campaignIds: Types.ObjectId[],
    agentIds: string[],
    perAgent: number,
    strategy: AssignStrategy = 'ROUND_ROBIN',
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    if (agentIds.length === 0 || campaignIds.length === 0) return result;

    let order = [...agentIds];
    if (strategy === 'LEAST_LOADED') {
      const loads = await Promise.all(
        agentIds.map(async (id) => ({
          id,
          n: await this.leadModel.countDocuments({
            tenantId: new Types.ObjectId(tenantId),
            ownerId: new Types.ObjectId(id),
            state_: { $in: WORKABLE_STATES },
          }),
        })),
      );
      order = loads.sort((a, b) => a.n - b.n).map((l) => l.id);
    }

    for (const agentId of order) {
      result[agentId] = await this.topUp(tenantId, agentId, campaignIds, perAgent);
    }
    return result;
  }

  /** Supervisor reassign: move specific leads to another agent (or back to the pool). */
  async reassign(tenantId: string, leadIds: string[], toAgentId: string | null): Promise<number> {
    const ids = leadIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return 0;
    const res = await this.leadModel
      .updateMany(
        { tenantId: new Types.ObjectId(tenantId), _id: { $in: ids } },
        toAgentId
          ? { $set: { ownerId: new Types.ObjectId(toAgentId), assignedAt: new Date() } }
          : { $unset: { ownerId: '', assignedAt: '' } },
      )
      .exec();
    return res.modifiedCount;
  }

  /** Release every lead held by an agent — used when they end a shift. */
  async releaseAllFor(tenantId: string, agentId: string): Promise<number> {
    const res = await this.leadModel
      .updateMany(
        {
          tenantId: new Types.ObjectId(tenantId),
          ownerId: new Types.ObjectId(agentId),
          // Never yank a lead out from under a live call.
          manualClaimedBy: null,
        },
        { $unset: { ownerId: '', assignedAt: '' } },
      )
      .exec();
    return res.modifiedCount;
  }

  /**
   * Return stranded leads to the shared pool.
   *
   * Without this, an agent who logs off holding 25 leads takes them out of
   * circulation indefinitely — the floor slowly starves while the list looks
   * full. Runs every 15 minutes.
   */
  @Interval(15 * 60_000)
  async reclaimStale(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_OWNERSHIP_HOURS * 60 * 60 * 1000);
    const res = await this.leadModel
      .updateMany(
        {
          ownerId: { $ne: null },
          assignedAt: { $lte: cutoff },
          state_: { $in: WORKABLE_STATES },
          manualClaimedBy: null,
        },
        { $unset: { ownerId: '', assignedAt: '' } },
      )
      .exec();
    if (res.modifiedCount > 0) {
      this.logger.log(`Reclaimed ${res.modifiedCount} stale-owned lead(s) to the pool`);
    }
    return res.modifiedCount;
  }

  /** Per-agent worklist depth, for the supervisor floor view. */
  async loadByAgent(tenantId: string): Promise<Array<{ agentId: string; name: string; held: number }>> {
    const rows = await this.leadModel.aggregate<{ _id: Types.ObjectId; held: number }>([
      {
        $match: {
          tenantId: new Types.ObjectId(tenantId),
          ownerId: { $ne: null },
          state_: { $in: WORKABLE_STATES },
        },
      },
      { $group: { _id: '$ownerId', held: { $sum: 1 } } },
    ]);
    const users = await this.userModel
      .find({ _id: { $in: rows.map((r) => r._id) } })
      .select('name')
      .lean()
      .exec();
    const nameById = new Map(users.map((u) => [u._id.toString(), u.name]));
    return rows.map((r) => ({
      agentId: r._id.toString(),
      name: nameById.get(r._id.toString()) ?? 'Unknown',
      held: r.held,
    }));
  }
}
