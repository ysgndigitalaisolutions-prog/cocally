import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  AMD_CLASSES,
  CALL_OUTCOMES,
  CALL_STATES,
  DISPOSITIONS,
  type AmdClass,
  type CallOutcome,
  type CallState,
  type Disposition,
} from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

export interface TranscriptEntry {
  leg: 'AI' | 'HUMAN';
  speaker: 'ai' | 'customer' | 'agent';
  text: string;
  /** Redacted variant per REC-04, served by default. */
  redactedText: string;
  startMs: number;
  endMs: number;
}

export interface ScorePoint {
  atMs: number;
  score: number;
  reason: string;
}

export interface ComplianceEvent {
  atMs: number;
  kind:
    | 'RECORDING_DISCLOSURE'
    | 'AI_IDENTIFICATION'
    | 'CONSENT'
    | 'OPT_OUT_DETECTED'
    | 'DISTRESS_EXIT'
    | 'WINDOW_CHECK'
    | 'DNC_CHECK';
  detail: string;
}

export interface CallTimings {
  /** Per-call trace per NFR observability, all in ms. */
  sttFirstPartial?: number;
  ttsFirstByte?: number;
  turnLatencies: number[];
  transferDeadAirMs?: number;
}

@Schema({ timestamps: true })
export class Call {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Campaign', required: true, index: true })
  campaignId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Lead', required: true, index: true })
  leadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'FlowVersion', required: true })
  flowVersionId: Types.ObjectId;

  @Prop({ type: String, enum: ['OUTBOUND', 'INBOUND'], default: 'OUTBOUND' })
  direction: 'OUTBOUND' | 'INBOUND';

  /** CLI presented per TEL-07. */
  @Prop()
  cli?: string;

  @Prop({ type: String, enum: CALL_STATES, default: 'DIALING', index: true })
  state: CallState;

  @Prop({ type: String, enum: AMD_CLASSES })
  amdClass?: AmdClass;

  @Prop()
  amdLatencyMs?: number;

  @Prop({ type: String, enum: CALL_OUTCOMES })
  outcome?: CallOutcome;

  /** Human agent bridged on transfer, if any. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  agentId?: Types.ObjectId;

  @Prop({ type: String, enum: DISPOSITIONS })
  disposition?: Disposition;

  @Prop()
  dispositionNotes?: string;

  @Prop({ required: true })
  startedAt: Date;

  @Prop()
  answeredAt?: Date;

  @Prop()
  bridgedAt?: Date;

  @Prop()
  endedAt?: Date;

  @Prop({ type: [Object], default: [] })
  transcript: TranscriptEntry[];

  /** Incrementally-assembled summary per PAL-11. */
  @Prop({ default: '' })
  summary: string;

  @Prop({ type: [Object], default: [] })
  scoreHistory: ScorePoint[];

  @Prop({ default: 0 })
  finalScore: number;

  /** Objections raised, for DASH-03. */
  @Prop({ type: [Object], default: [] })
  objections: Array<{ label: string; recovered: boolean }>;

  @Prop({ type: [Object], default: [] })
  complianceEvents: ComplianceEvent[];

  /** 100%-auto-scoring per DASH-02: QA score 0-100 + notes. */
  @Prop({ type: Object })
  qaScore?: { total: number; breakdown: Record<string, number>; notes: string };

  @Prop({ type: Object, default: { turnLatencies: [] } })
  timings: CallTimings;

  /** Cost composition per PLAT-03, in cents: telco + STT + TTS + LLM. */
  @Prop({ type: Object, default: { telco: 0, stt: 0, tts: 0, llm: 0 } })
  costCents: { telco: number; stt: number; tts: number; llm: number };

  /** Providers actually used (after fallbacks), for the cost view and tracing. */
  @Prop({ type: Object, default: {} })
  providersUsed: Record<string, string>;
}

export type CallDocument = HydratedDocument<Call>;
export const CallSchema = SchemaFactory.createForClass(Call);
CallSchema.index({ tenantId: 1, campaignId: 1, startedAt: -1 });
CallSchema.index({ leadId: 1, startedAt: 1 });
CallSchema.index({ tenantId: 1, agentId: 1, bridgedAt: -1 });
