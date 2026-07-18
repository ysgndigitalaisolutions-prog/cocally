import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PRESENCE_STATES, type PresenceState } from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Presence session log: one document per contiguous presence state, closed on
 * the next transition. Server-written (never client-supplied), so agent
 * occupancy / adherence insights are auditable rather than inferred.
 */
@Schema({ timestamps: true })
export class AgentActivity {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: PRESENCE_STATES, required: true })
  state: PresenceState;

  @Prop({ required: true })
  startedAt: Date;

  /** Unset while this is the agent's current state. */
  @Prop()
  endedAt?: Date;

  @Prop()
  durationSeconds?: number;
}

export type AgentActivityDocument = HydratedDocument<AgentActivity>;
export const AgentActivitySchema = SchemaFactory.createForClass(AgentActivity);
AgentActivitySchema.index({ tenantId: 1, userId: 1, startedAt: -1 });
AgentActivitySchema.index({ userId: 1, endedAt: 1 });
