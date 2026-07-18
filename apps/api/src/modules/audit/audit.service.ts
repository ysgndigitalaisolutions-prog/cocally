import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, AuditLogDocument } from '../../schemas/audit-log.schema';

export interface AuditEntry {
  tenantId: string;
  actorId?: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ip?: string;
}

/** Append-only audit log per ADM-02. Inserts only — no update/delete API exists. */
@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditLog.name) private readonly auditModel: Model<AuditLogDocument>) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.auditModel.create({
      ...entry,
      tenantId: new Types.ObjectId(entry.tenantId),
      actorId: entry.actorId ? new Types.ObjectId(entry.actorId) : undefined,
    });
  }

  async list(tenantId: string, options: { limit?: number; action?: string; entityType?: string } = {}) {
    const filter: Record<string, unknown> = { tenantId: new Types.ObjectId(tenantId) };
    if (options.action) filter.action = options.action;
    if (options.entityType) filter.entityType = options.entityType;
    return this.auditModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(options.limit ?? 100, 500))
      .lean()
      .exec();
  }
}
