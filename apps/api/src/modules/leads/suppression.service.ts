import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DncWashRecord, DncWashRecordDocument, SuppressionEntry, SuppressionEntryDocument } from '../../schemas/suppression.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { AuditService } from '../audit/audit.service';

export type SuppressionVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'DNC_LISTED' | 'DNC_WASH_STALE' | 'OPT_OUT' | 'FREQUENCY_CAP' | 'CLIENT_SUPPRESSION' };

/**
 * Suppression stack per LEAD-05, evaluated at dial time in order:
 * 1. country DNC register wash (stale wash blocks the dial),
 * 2. tenant opt-out list,
 * 3. cross-campaign frequency caps,
 * 4. per-client suppression.
 */
@Injectable()
export class SuppressionService {
  constructor(
    @InjectModel(SuppressionEntry.name) private readonly suppressionModel: Model<SuppressionEntryDocument>,
    @InjectModel(DncWashRecord.name) private readonly dncModel: Model<DncWashRecordDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    private readonly audit: AuditService,
  ) {}

  async checkAtDialTime(input: {
    tenantId: string;
    clientId: string;
    phone: string;
    countryPackCode: string;
    dncEnforced: boolean;
    frequencyCapDays: number;
  }): Promise<SuppressionVerdict> {
    const tenantId = new Types.ObjectId(input.tenantId);

    // 1. DNC wash per pack: a listed number, or a wash that is missing/expired, blocks the dial.
    if (input.dncEnforced) {
      const wash = await this.dncModel
        .findOne({ tenantId, phone: input.phone, countryPackCode: input.countryPackCode })
        .lean()
        .exec();
      if (!wash || wash.expiresAt < new Date()) return { allowed: false, reason: 'DNC_WASH_STALE' };
      if (wash.listed) return { allowed: false, reason: 'DNC_LISTED' };
    }

    // 2. Tenant opt-out list.
    const optOut = await this.suppressionModel
      .findOne({ tenantId, phone: input.phone, kind: 'OPT_OUT' })
      .lean()
      .exec();
    if (optOut) return { allowed: false, reason: 'OPT_OUT' };

    // 3. Cross-campaign frequency cap: max 1 contact per N days across ALL campaigns.
    if (input.frequencyCapDays > 0) {
      const cutoff = new Date(Date.now() - input.frequencyCapDays * 24 * 60 * 60 * 1000);
      const recentContact = await this.leadModel
        .findOne({ tenantId, phone: input.phone, lastContactedAt: { $gte: cutoff } })
        .lean()
        .exec();
      if (recentContact) return { allowed: false, reason: 'FREQUENCY_CAP' };
    }

    // 4. Per-client suppression.
    const clientSuppression = await this.suppressionModel
      .findOne({
        tenantId,
        phone: input.phone,
        kind: { $in: ['CLIENT_SUPPRESSION', 'MANUAL'] },
        $or: [{ clientId: new Types.ObjectId(input.clientId) }, { clientId: { $exists: false } }],
        $and: [{ $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] }],
      })
      .lean()
      .exec();
    if (clientSuppression) return { allowed: false, reason: 'CLIENT_SUPPRESSION' };

    return { allowed: true };
  }

  /**
   * Instant opt-out write per LEAD-05/AI-09: called the moment a customer
   * says "don't call me", including mid-call.
   */
  async optOut(tenantId: string, phone: string, source: string): Promise<void> {
    await this.suppressionModel.updateOne(
      { tenantId: new Types.ObjectId(tenantId), phone, kind: 'OPT_OUT' },
      { $setOnInsert: { source } },
      { upsert: true },
    );
    await this.leadModel
      .updateMany({ tenantId: new Types.ObjectId(tenantId), phone }, { state_: 'DNC' })
      .exec();
    await this.audit.record({
      tenantId,
      actorLabel: 'system',
      action: 'suppression.optout',
      entityType: 'SuppressionEntry',
      after: { phone, source },
    });
  }

  /**
   * Record a DNC wash result. In production this is fed by the registry
   * integration (ACMA for AU); the wash scheduler re-washes before expiry.
   */
  async recordWash(input: {
    tenantId: string;
    countryPackCode: string;
    phone: string;
    listed: boolean;
    washExpiryDays: number;
  }): Promise<void> {
    const washedAt = new Date();
    const expiresAt = new Date(washedAt.getTime() + input.washExpiryDays * 24 * 60 * 60 * 1000);
    await this.dncModel.updateOne(
      { tenantId: new Types.ObjectId(input.tenantId), phone: input.phone, countryPackCode: input.countryPackCode },
      { listed: input.listed, washedAt, expiresAt },
      { upsert: true },
    );
  }
}
