import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** Transfer orchestration state per XFER-02/04. */
@Schema({ timestamps: true })
export class Transfer {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Call', required: true, index: true })
  callId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead', required: true })
  leadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Campaign', required: true })
  campaignId: Types.ObjectId;

  @Prop({
    type: String,
    enum: ['RESERVED', 'OFFERED', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'BRIDGED', 'CANCELLED', 'FALLBACK'],
    default: 'RESERVED',
  })
  state: 'RESERVED' | 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'TIMED_OUT' | 'BRIDGED' | 'CANCELLED' | 'FALLBACK';

  /** Cascade history per XFER-04: each agent offered, outcome, timing. */
  @Prop({ type: [Object], default: [] })
  attempts: Array<{
    agentId: string;
    offeredAt: Date;
    resolvedAt?: Date;
    result: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TIMED_OUT';
  }>;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  acceptedAgentId?: Types.ObjectId;

  /** Rendered summary card per XFER-05, snapshotted at offer time. */
  @Prop({ type: Object })
  card?: Record<string, unknown>;

  @Prop()
  whisperText?: string;

  @Prop()
  bridgedAt?: Date;

  /** Dead-air between AI hand-off and human bridge, per NFR (≤1s target). */
  @Prop()
  bridgeDeadAirMs?: number;
}

export type TransferDocument = HydratedDocument<Transfer>;
export const TransferSchema = SchemaFactory.createForClass(Transfer);
