import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OpsAuditLog, OpsAuditLogDocument } from '../../schemas/operator.schema';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedOperator } from './operator-auth.guard';

@Injectable()
export class OpsAuditService {
  constructor(
    @InjectModel(OpsAuditLog.name) private readonly model: Model<OpsAuditLogDocument>,
    private readonly tenantAudit: AuditService,
  ) {}

  /**
   * Record an operator action. When it touches a tenant it also goes into that
   * tenant's own audit log, labelled as CoCally, so tenants can see it.
   */
  async record(
    op: Pick<AuthenticatedOperator, 'operatorId' | 'email'>,
    entry: {
      action: string;
      tenantId?: string;
      entityType?: string;
      entityId?: string;
      before?: object;
      after?: object;
      ip?: string;
      mirrorToTenant?: boolean;
    },
  ): Promise<void> {
    const before = entry.before ? ({ ...entry.before } as Record<string, unknown>) : undefined;
    const after = entry.after ? ({ ...entry.after } as Record<string, unknown>) : undefined;
    await this.model.create({
      operatorId: op.operatorId,
      operatorEmail: op.email,
      action: entry.action,
      tenantId: entry.tenantId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before,
      after,
      ip: entry.ip,
    });
    if (entry.tenantId && entry.mirrorToTenant !== false && Types.ObjectId.isValid(entry.tenantId)) {
      await this.tenantAudit.record({
        tenantId: entry.tenantId,
        actorLabel: `${op.email} (CoCally)`,
        action: `ops.${entry.action}`,
        entityType: entry.entityType ?? 'Tenant',
        entityId: entry.entityId,
        before,
        after,
        ip: entry.ip,
      });
    }
  }

  async list(opts: { tenantId?: string; limit?: number; before?: Date }) {
    const rows = await this.model
      .find({
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
        ...(opts.before ? { createdAt: { $lt: opts.before } } : {}),
      })
      .sort({ createdAt: -1 })
      .limit(Math.min(opts.limit ?? 100, 500))
      .lean()
      .exec();
    return rows.map((r) => ({
      id: r._id.toString(),
      at: (r as unknown as { createdAt: Date }).createdAt,
      operatorEmail: r.operatorEmail,
      action: r.action,
      tenantId: r.tenantId ?? null,
      entityType: r.entityType ?? null,
      entityId: r.entityId ?? null,
      before: r.before ?? null,
      after: r.after ?? null,
      ip: r.ip ?? null,
    }));
  }
}
