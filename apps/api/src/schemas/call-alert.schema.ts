import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AlertSeverity = 'CRITICAL' | 'WARNING';

export interface AlertFinding {
  severity: AlertSeverity;
  /** Stable id of the check, e.g. CARRIER_REFUSALS. */
  check: string;
  campaignId: string;
  campaignName: string;
  title: string;
  detail: string;
}

/** One alert check that found something: what it found and whether the email went out. */
@Schema({ timestamps: true, collection: 'callalerts' })
export class CallAlert {
  @Prop({ required: true, index: true })
  windowStart: Date;

  @Prop({ required: true })
  windowEnd: Date;

  @Prop({ type: [Object], default: [] })
  findings: AlertFinding[];

  /** Calls per campaign in the window, for context in the email. */
  @Prop({ type: [Object], default: [] })
  stats: Array<{ campaignName: string; calls: number; outcomes: Record<string, number> }>;

  @Prop({ type: [String], default: [] })
  emailedTo: string[];

  /** Why no email went out (no key, send failed), when it did not. */
  @Prop()
  emailError?: string;
}

export type CallAlertDocument = HydratedDocument<CallAlert>;
export const CallAlertSchema = SchemaFactory.createForClass(CallAlert);
