import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Appointment {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client', required: true })
  clientId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead', required: true, index: true })
  leadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Call' })
  callId?: Types.ObjectId;

  @Prop({ required: true })
  startsAt: Date;

  @Prop({ default: 60 })
  durationMinutes: number;

  /** Slot-inventory key per PLAT-05 (field advisor / calendar id). */
  @Prop()
  slotKey?: string;

  @Prop({ type: String, enum: ['BOOKED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'], default: 'BOOKED' })
  status: 'BOOKED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

  @Prop()
  notes?: string;
}

export type AppointmentDocument = HydratedDocument<Appointment>;
export const AppointmentSchema = SchemaFactory.createForClass(Appointment);
// Prevent double-booking a slot per PLAT-05.
AppointmentSchema.index(
  { tenantId: 1, clientId: 1, slotKey: 1, startsAt: 1 },
  { unique: true, partialFilterExpression: { slotKey: { $exists: true }, status: { $in: ['BOOKED', 'CONFIRMED'] } } },
);

/** Callback tasks per LEAD-08 with sticky-agent preference. */
@Schema({ timestamps: true })
export class Callback {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead', required: true, index: true })
  leadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Campaign', required: true })
  campaignId: Types.ObjectId;

  @Prop({ required: true })
  dueAt: Date;

  @Prop({ type: String, enum: ['AI', 'HUMAN'], default: 'AI' })
  handler: 'AI' | 'HUMAN';

  @Prop({ type: Types.ObjectId, ref: 'User' })
  preferredAgentId?: Types.ObjectId;

  @Prop({ type: String, enum: ['PENDING', 'DONE', 'CANCELLED'], default: 'PENDING' })
  status: 'PENDING' | 'DONE' | 'CANCELLED';

  @Prop()
  notes?: string;
}

export type CallbackDocument = HydratedDocument<Callback>;
export const CallbackSchema = SchemaFactory.createForClass(Callback);
CallbackSchema.index({ tenantId: 1, status: 1, dueAt: 1 });
