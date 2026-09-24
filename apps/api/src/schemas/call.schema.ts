import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  AMD_CLASSES,
  CALL_END_REASONS,
  CALL_OUTCOMES,
  CALL_STATES,
  DISPOSITIONS,
  SUPERVISION_MODES,
  type AmdClass,
  type CallEndReason,
  type CallOutcome,
  type CallState,
  type Disposition,
  type SupervisionMode,
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
    | 'DNC_CHECK'
    | 'ABANDONED_CALL_NOTICE'
    /** Customer pressed the keypad opt-out digit — a rail that does not depend on an LLM. */
    | 'DTMF_OPT_OUT'
    /** A supervisor attached to the live call (monitor/whisper/barge), recorded for audit. */
    | 'SUPERVISION_ATTACHED';
  detail: string;
}

export interface CallTimings {
  /** Per-call trace per NFR observability, all in ms. */
  sttFirstPartial?: number;
  ttsFirstByte?: number;
  turnLatencies: number[];
  /** Per-turn breakdown (ms) from the voice worker, last 200 turns. */
  turns?: Array<{ at: Date; eou: number; stt: number; llm: number; tts: number; total: number }>;
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

  /** The AI flow that ran this call. Absent for manual dials (no AI leg). */
  @Prop({ type: Types.ObjectId, ref: 'FlowVersion' })
  flowVersionId?: Types.ObjectId;

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

  /** True for agent-initiated manual dials (no AI leg) per the manual dialer. */
  @Prop({ default: false })
  manual: boolean;

  /** True for calls placed by the ratio/adaptive human-agent predictive dialer. */
  @Prop({ default: false })
  predictive: boolean;

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

  // ── Real-carrier call progress ────────────────────────────────────────
  // Populated by the LiveKit webhook receiver. Before these existed nothing
  // advanced a live call past RINGING, so BUSY / NO_ANSWER / DISCONNECTED
  // were declared outcomes that no code path could ever produce — which in
  // turn made the whole retry matrix dead for real calls.

  /** LiveKit SIP call id, for correlating webhooks and carrier-side CDRs. */
  @Prop({ index: true, sparse: true })
  sipCallId?: string;

  /** Final SIP response code seen on the customer leg. */
  @Prop()
  sipStatusCode?: number;

  /** Normalised disconnect cause — see CALL_END_REASONS. */
  @Prop({ type: String, enum: CALL_END_REASONS })
  endReason?: CallEndReason;

  /** Wall-clock ms from INVITE to answer; null when never answered. */
  @Prop()
  ringMs?: number;

  // ── Agent call control ────────────────────────────────────────────────

  /** Times the agent placed the customer on hold. */
  @Prop({ default: 0 })
  holdCount: number;

  /** Total ms the customer spent on hold — surfaced in QA. */
  @Prop({ default: 0 })
  heldMs: number;

  /** Set while the customer is parked on music-on-hold. */
  @Prop()
  heldSince?: Date;

  /** Agent who handed this call over, when it arrived by agent-to-agent transfer. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  transferredFromAgentId?: Types.ObjectId;

  /** Every agent who has been on this call, in order — conference and transfer history. */
  @Prop({ type: [Types.ObjectId], ref: 'User', default: [] })
  participantAgentIds: Types.ObjectId[];

  /** Supervisor currently attached, if any. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  supervisorId?: Types.ObjectId;

  @Prop({ type: String, enum: SUPERVISION_MODES })
  supervisionMode?: SupervisionMode;

  // ── Recording ─────────────────────────────────────────────────────────

  /** LiveKit Egress id for the room composite recording. */
  @Prop()
  recordingEgressId?: string;

  /** Where the finished audio landed (object-store key or local path). */
  @Prop()
  recordingUri?: string;

  /** Wrap-up deadline; the sweep auto-returns the agent to AVAILABLE after this. */
  @Prop()
  wrapUpDeadline?: Date;
}

export type CallDocument = HydratedDocument<Call>;
export const CallSchema = SchemaFactory.createForClass(Call);
CallSchema.index({ tenantId: 1, campaignId: 1, startedAt: -1 });
CallSchema.index({ leadId: 1, startedAt: 1 });
CallSchema.index({ tenantId: 1, agentId: 1, bridgedAt: -1 });
// Floor timeline and tenant-wide KPI scans (no campaign filter).
CallSchema.index({ tenantId: 1, startedAt: -1 });
// Disposition/outcome mix and the calls screen's primary filters.
CallSchema.index({ tenantId: 1, campaignId: 1, disposition: 1, startedAt: -1 });
CallSchema.index({ tenantId: 1, campaignId: 1, outcome: 1, startedAt: -1 });
// Hung-call sweep: find non-terminal calls older than the cutoff.
CallSchema.index({ state: 1, startedAt: 1 });
// "What am I on right now?" — the call-bar recovery lookup, hit on every reload.
CallSchema.index({ agentId: 1, state: 1 });
// Wrap-up auto-return sweep.
CallSchema.index({ wrapUpDeadline: 1 });
// Per-agent productivity over a window.
CallSchema.index({ tenantId: 1, agentId: 1, startedAt: -1 });
