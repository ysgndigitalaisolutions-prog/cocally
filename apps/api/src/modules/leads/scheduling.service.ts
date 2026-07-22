import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Appointment,
  AppointmentDocument,
  Callback,
  CallbackDocument,
} from '../../schemas/appointment.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';

export interface CallbackRow {
  id: string;
  leadId: string;
  leadName: string;
  phone: string;
  campaignId: string;
  dueAt: string;
  overdue: boolean;
  handler: 'AI' | 'HUMAN';
  preferredAgentId: string | null;
  notes: string | null;
}

/**
 * Callback and appointment scheduling.
 *
 * Both collections existed in the schema layer but were never registered or
 * written to — a BOOKED disposition flipped lead state and fired a webhook
 * without creating an appointment, and a CALLBACK disposition only set
 * `lead.nextAttemptAt`, leaving agents with no worklist of what they'd promised
 * to call back. For a human-dialer floor the callback book IS the day's work, so
 * these are now first-class records with their own queues.
 */
@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  constructor(
    @InjectModel(Callback.name) private readonly callbackModel: Model<CallbackDocument>,
    @InjectModel(Appointment.name) private readonly appointmentModel: Model<AppointmentDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
  ) {}

  // ── Callbacks ────────────────────────────────────────────────────────────

  /**
   * Promise a callback. Creates the task, moves the lead to CALLBACK, and makes
   * the lead dialable again at `dueAt` — keeping the retry matrix and the
   * callback book in agreement rather than tracking the same promise twice.
   *
   * A HUMAN callback also pins ownership to the promising agent, so it lands in
   * their worklist and not someone else's: the customer expects that voice back.
   */
  async scheduleCallback(input: {
    tenantId: string;
    leadId: string;
    campaignId: string;
    dueAt: Date;
    handler?: 'AI' | 'HUMAN';
    preferredAgentId?: string;
    notes?: string;
  }): Promise<CallbackDocument> {
    if (Number.isNaN(input.dueAt.getTime())) throw new BadRequestException('Invalid callback time');
    if (input.dueAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('Callback time is in the past');
    }

    const lead = await this.leadModel
      .findOne({ _id: new Types.ObjectId(input.leadId), tenantId: new Types.ObjectId(input.tenantId) })
      .exec();
    if (!lead) throw new NotFoundException('Lead not found');

    // Supersede any outstanding promise so an agent never sees two.
    await this.callbackModel
      .updateMany(
        { tenantId: new Types.ObjectId(input.tenantId), leadId: lead._id, status: 'PENDING' },
        { status: 'CANCELLED' },
      )
      .exec();

    const handler = input.handler ?? 'HUMAN';
    const callback = await this.callbackModel.create({
      tenantId: new Types.ObjectId(input.tenantId),
      leadId: lead._id,
      campaignId: new Types.ObjectId(input.campaignId),
      dueAt: input.dueAt,
      handler,
      preferredAgentId: input.preferredAgentId ? new Types.ObjectId(input.preferredAgentId) : undefined,
      notes: input.notes,
      status: 'PENDING',
    });

    lead.state_ = 'CALLBACK';
    lead.nextAttemptAt = input.dueAt;
    if (input.preferredAgentId) {
      const agent = new Types.ObjectId(input.preferredAgentId);
      lead.preferredAgentId = agent;
      if (handler === 'HUMAN') lead.ownerId = agent;
    }
    lead.timeline.push({
      at: new Date(),
      kind: 'CALLBACK_SCHEDULED',
      detail: `Callback set for ${input.dueAt.toISOString()}${input.notes ? ` — ${input.notes}` : ''}`,
      state: 'CALLBACK',
    });
    await lead.save();

    return callback;
  }

  /**
   * An agent's callback book: what they promised, soonest first. Overdue items
   * surface first so a missed promise is visible rather than buried.
   */
  async dueCallbacks(
    tenantId: string,
    agentId: string,
    opts: { includeUnassigned?: boolean; withinHours?: number; limit?: number } = {},
  ): Promise<CallbackRow[]> {
    const horizon = new Date(Date.now() + (opts.withinHours ?? 24) * 60 * 60 * 1000);
    const agent = new Types.ObjectId(agentId);

    const callbacks = await this.callbackModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: 'PENDING',
        handler: 'HUMAN',
        dueAt: { $lte: horizon },
        ...(opts.includeUnassigned
          ? { $or: [{ preferredAgentId: agent }, { preferredAgentId: null }] }
          : { preferredAgentId: agent }),
      })
      .sort({ dueAt: 1 })
      .limit(Math.min(opts.limit ?? 100, 200))
      .lean()
      .exec();
    if (callbacks.length === 0) return [];

    const leads = await this.leadModel
      .find({ _id: { $in: callbacks.map((c) => c.leadId) } })
      .select('firstName lastName phone')
      .lean()
      .exec();
    const leadById = new Map(leads.map((l) => [l._id.toString(), l]));
    const now = Date.now();

    return callbacks.map((c) => {
      const lead = leadById.get(c.leadId.toString());
      return {
        id: c._id.toString(),
        leadId: c.leadId.toString(),
        leadName:
          [lead?.firstName, lead?.lastName].filter(Boolean).join(' ') || lead?.phone || 'Unknown',
        phone: lead?.phone ?? '',
        campaignId: c.campaignId.toString(),
        dueAt: c.dueAt.toISOString(),
        overdue: c.dueAt.getTime() < now,
        handler: c.handler,
        preferredAgentId: c.preferredAgentId?.toString() ?? null,
        notes: c.notes ?? null,
      };
    });
  }

  async completeCallback(tenantId: string, callbackId: string): Promise<void> {
    await this.callbackModel
      .updateOne(
        { _id: new Types.ObjectId(callbackId), tenantId: new Types.ObjectId(tenantId), status: 'PENDING' },
        { status: 'DONE' },
      )
      .exec();
  }

  /** Close any outstanding promise on a lead — called when a call is dispositioned. */
  async resolveOpenCallbacks(tenantId: string, leadId: string): Promise<void> {
    await this.callbackModel
      .updateMany(
        { tenantId: new Types.ObjectId(tenantId), leadId: new Types.ObjectId(leadId), status: 'PENDING' },
        { status: 'DONE' },
      )
      .exec();
  }

  /** Supervisor view: every overdue promise on the floor. */
  async overdueCallbacks(tenantId: string, limit = 200): Promise<CallbackRow[]> {
    const rows = await this.callbackModel
      .find({ tenantId: new Types.ObjectId(tenantId), status: 'PENDING', dueAt: { $lt: new Date() } })
      .sort({ dueAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    const leads = await this.leadModel
      .find({ _id: { $in: rows.map((r) => r.leadId) } })
      .select('firstName lastName phone')
      .lean()
      .exec();
    const leadById = new Map(leads.map((l) => [l._id.toString(), l]));
    return rows.map((c) => {
      const lead = leadById.get(c.leadId.toString());
      return {
        id: c._id.toString(),
        leadId: c.leadId.toString(),
        leadName: [lead?.firstName, lead?.lastName].filter(Boolean).join(' ') || lead?.phone || 'Unknown',
        phone: lead?.phone ?? '',
        campaignId: c.campaignId.toString(),
        dueAt: c.dueAt.toISOString(),
        overdue: true,
        handler: c.handler,
        preferredAgentId: c.preferredAgentId?.toString() ?? null,
        notes: c.notes ?? null,
      };
    });
  }

  // ── Appointments ─────────────────────────────────────────────────────────

  /**
   * Book an appointment. When a `slotKey` is supplied the unique partial index
   * on the collection enforces single-occupancy, so two agents closing the same
   * slot at once produce a duplicate-key error rather than a double-booking —
   * surfaced here as a 409 the UI can retry against a fresh slot list.
   */
  async bookAppointment(input: {
    tenantId: string;
    clientId: string;
    leadId: string;
    callId?: string;
    startsAt: Date;
    durationMinutes?: number;
    slotKey?: string;
    notes?: string;
  }): Promise<AppointmentDocument> {
    if (Number.isNaN(input.startsAt.getTime())) throw new BadRequestException('Invalid appointment time');
    try {
      const appointment = await this.appointmentModel.create({
        tenantId: new Types.ObjectId(input.tenantId),
        clientId: new Types.ObjectId(input.clientId),
        leadId: new Types.ObjectId(input.leadId),
        callId: input.callId ? new Types.ObjectId(input.callId) : undefined,
        startsAt: input.startsAt,
        durationMinutes: input.durationMinutes ?? 60,
        slotKey: input.slotKey,
        notes: input.notes,
        status: 'BOOKED',
      });

      await this.leadModel
        .updateOne(
          { _id: new Types.ObjectId(input.leadId) },
          {
            $push: {
              timeline: {
                at: new Date(),
                kind: 'APPOINTMENT_BOOKED',
                detail: `Appointment booked for ${input.startsAt.toISOString()}`,
                callId: input.callId,
              },
            },
          },
        )
        .exec();

      return appointment;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictException('That slot has just been taken — pick another.');
      }
      throw err;
    }
  }

  async appointments(tenantId: string, range: { from?: Date; to?: Date; status?: string } = {}) {
    const filter: Record<string, unknown> = { tenantId: new Types.ObjectId(tenantId) };
    if (range.from || range.to) {
      filter.startsAt = {
        ...(range.from ? { $gte: range.from } : {}),
        ...(range.to ? { $lte: range.to } : {}),
      };
    }
    if (range.status) filter.status = range.status;
    return this.appointmentModel.find(filter).sort({ startsAt: 1 }).limit(500).lean().exec();
  }

  async setAppointmentStatus(
    tenantId: string,
    appointmentId: string,
    status: 'BOOKED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW',
  ): Promise<void> {
    const res = await this.appointmentModel
      .updateOne(
        { _id: new Types.ObjectId(appointmentId), tenantId: new Types.ObjectId(tenantId) },
        { status },
      )
      .exec();
    if (res.matchedCount === 0) throw new NotFoundException('Appointment not found');
  }
}
