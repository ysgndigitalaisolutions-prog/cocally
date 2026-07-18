import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ timestamps: true })
export class WebhookSubscription {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client' })
  clientId?: Types.ObjectId;

  @Prop({ required: true })
  url: string;

  @Prop({ type: [String], enum: WEBHOOK_EVENTS, required: true })
  events: WebhookEvent[];

  /** HMAC-SHA256 signing secret for payload verification. */
  @Prop({ required: true, select: false })
  secret: string;

  @Prop({ default: true })
  active: boolean;
}

export type WebhookSubscriptionDocument = HydratedDocument<WebhookSubscription>;
export const WebhookSubscriptionSchema = SchemaFactory.createForClass(WebhookSubscription);

@Schema({ timestamps: true })
export class WebhookDelivery {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'WebhookSubscription', required: true, index: true })
  subscriptionId: Types.ObjectId;

  @Prop({ type: String, enum: WEBHOOK_EVENTS, required: true })
  event: WebhookEvent;

  @Prop({ type: Object, required: true })
  payload: Record<string, unknown>;

  @Prop({ type: String, enum: ['PENDING', 'DELIVERED', 'FAILED'], default: 'PENDING' })
  status: 'PENDING' | 'DELIVERED' | 'FAILED';

  @Prop({ default: 0 })
  attempts: number;

  @Prop()
  lastError?: string;

  @Prop()
  nextRetryAt?: Date;

  @Prop()
  deliveredAt?: Date;
}

export type WebhookDeliveryDocument = HydratedDocument<WebhookDelivery>;
export const WebhookDeliverySchema = SchemaFactory.createForClass(WebhookDelivery);
WebhookDeliverySchema.index({ status: 1, nextRetryAt: 1 });
