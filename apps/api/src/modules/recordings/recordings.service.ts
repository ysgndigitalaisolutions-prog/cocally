import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CallLeg } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { Recording, RecordingDocument } from '../../schemas/recording.schema';
import { Tenant, TenantDocument } from '../../schemas/tenant.schema';
import { AuditService } from '../audit/audit.service';

/**
 * Recordings per REC-01..05: dual-leg capture stitched into one per-lead
 * timeline, region-pinned storage, retention with legal hold, audited raw
 * access. In simulation the "audio" is the transcript rendered to a text
 * artefact under the same storage contract; the SIP driver writes real
 * media through the identical path.
 */
@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);

  constructor(
    @InjectModel(Recording.name) private readonly recordingModel: Model<RecordingDocument>,
    @InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>,
    private readonly audit: AuditService,
  ) {}

  async captureLeg(input: {
    tenantId: string;
    callId: string;
    leadId: string;
    leg: CallLeg;
    startedAt: Date;
    transcript: Array<{ speaker: string; text: string; startMs: number }>;
  }): Promise<void> {
    const tenant = await this.tenantModel.findById(input.tenantId).lean().exec();
    const region = tenant?.region ?? 'au';
    const retentionDays = tenant?.retentionDays ?? 365;

    // Region-pinned path per REC-02: {region}/{tenant}/{lead}/{call}-{leg}.
    const dir = join(config.recordingsDir, region, input.tenantId, input.leadId);
    const filename = `${input.callId}-${input.leg}.txt`;
    const storagePath = join(dir, filename);
    try {
      await mkdir(dir, { recursive: true });
      const body = input.transcript.map((t) => `[${t.startMs}ms] ${t.speaker}: ${t.text}`).join('\n');
      await writeFile(storagePath, body, 'utf8');
    } catch (err) {
      this.logger.error(`recording write failed: ${(err as Error).message}`);
    }

    const durationMs = input.transcript.length > 0 ? Math.max(...input.transcript.map((t) => t.startMs)) : 0;
    const priorLegs = await this.recordingModel
      .find({ leadId: new Types.ObjectId(input.leadId) })
      .sort({ startedAt: 1 })
      .lean()
      .exec();
    const timelineOffsetMs = priorLegs.reduce((acc, r) => acc + r.durationMs, 0);

    await this.recordingModel.create({
      tenantId: new Types.ObjectId(input.tenantId),
      callId: new Types.ObjectId(input.callId),
      leadId: new Types.ObjectId(input.leadId),
      leg: input.leg,
      storagePath,
      region,
      startedAt: input.startedAt,
      endedAt: new Date(),
      durationMs,
      timelineOffsetMs,
      purgeAfter: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
    });
  }

  /** Stitched per-lead timeline per REC-01, whisper legs marked. */
  async leadTimeline(tenantId: string, leadId: string) {
    const legs = await this.recordingModel
      .find({ tenantId: new Types.ObjectId(tenantId), leadId: new Types.ObjectId(leadId) })
      .sort({ startedAt: 1 })
      .lean()
      .exec();
    return legs.map((leg) => ({
      recordingId: leg._id.toString(),
      callId: leg.callId.toString(),
      leg: leg.leg,
      isWhisper: leg.leg === 'WHISPER',
      startedAt: leg.startedAt,
      durationMs: leg.durationMs,
      timelineOffsetMs: leg.timelineOffsetMs,
    }));
  }

  /** Raw access is role-gated at the controller and audited here per REC-04. */
  async rawAccess(tenantId: string, actor: { id: string; label: string }, recordingId: string) {
    const recording = await this.recordingModel
      .findOne({ _id: new Types.ObjectId(recordingId), tenantId: new Types.ObjectId(tenantId) })
      .lean()
      .exec();
    if (!recording) throw new NotFoundException('Recording not found');
    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'recording.raw_access',
      entityType: 'Recording',
      entityId: recordingId,
    });
    return recording;
  }

  /** Retention purge per REC-03: deletes doc rows past purgeAfter unless legal hold. */
  async purgeExpired(): Promise<number> {
    const result = await this.recordingModel
      .deleteMany({ legalHold: false, purgeAfter: { $lte: new Date() } })
      .exec();
    return result.deletedCount ?? 0;
  }

  async setLegalHold(tenantId: string, recordingId: string, hold: boolean): Promise<void> {
    await this.recordingModel
      .updateOne({ _id: new Types.ObjectId(recordingId), tenantId: new Types.ObjectId(tenantId) }, { legalHold: hold })
      .exec();
  }
}
