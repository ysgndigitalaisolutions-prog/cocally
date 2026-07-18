import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  ROUTING_STRATEGIES,
  TRANSCRIPTION_MODES,
  VOICEMAIL_POLICIES,
  type RoutingStrategy,
  type ScoringConfig,
  type TranscriptionMode,
  type VoicemailPolicy,
} from '@cocally/shared';
import { HydratedDocument, Types } from 'mongoose';

/** One retry rule of the outcome-driven retry matrix per LEAD-04. */
export interface RetryRule {
  outcome: string;
  delayMinutes: number;
  shiftTimeBand: boolean;
  maxAttempts: number;
}

@Schema({ timestamps: true })
export class Campaign {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  /** Country pack code per CP-03, e.g. "AU". */
  @Prop({ required: true })
  countryPackCode: string;

  @Prop({ type: String, enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'], default: 'DRAFT' })
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';

  /** Published flow version driving the AI leg. */
  @Prop({ type: Types.ObjectId, ref: 'FlowVersion' })
  activeFlowVersionId?: Types.ObjectId;

  /** A/B split per FLOW-06: version id → percentage (must total 100 with active). */
  @Prop({ type: [Object], default: [] })
  abSplits: Array<{ flowVersionId: string; percent: number }>;

  /** Daily dial budget and pacing per ADM-03. */
  @Prop({ default: 1000 })
  dailyDialBudget: number;

  /** Hard cap on concurrent AI calls for this campaign per TEL-08. */
  @Prop({ default: 10 })
  maxConcurrentCalls: number;

  /** Availability-aware pacing per XFER-03: max concurrent dials per free agent. */
  @Prop({ default: 3 })
  dialsPerAvailableAgent: number;

  /** Behaviour when no closer is free: AI books instead of transferring. */
  @Prop({ type: String, enum: ['BOOK', 'HOLD', 'AI_CLOSE'], default: 'BOOK' })
  noAgentFallback: 'BOOK' | 'HOLD' | 'AI_CLOSE';

  @Prop({ type: String, enum: VOICEMAIL_POLICIES, default: 'SILENT_HANGUP' })
  voicemailPolicy: VoicemailPolicy;

  /** Prompt asset played/generated for voicemail drops. */
  @Prop({ type: Types.ObjectId, ref: 'PromptAsset' })
  voicemailDropAssetId?: Types.ObjectId;

  /** IVR navigation per TEL-06. */
  @Prop({ type: Object, default: { enabled: false, digits: '1', maxMenuDepth: 3 } })
  ivrPolicy: { enabled: boolean; digits: string; maxMenuDepth: number };

  /** CLI pool per TEL-07: refs into CliNumber collection. */
  @Prop({ type: [Types.ObjectId], ref: 'CliNumber', default: [] })
  cliPool: Types.ObjectId[];

  @Prop({ type: Object, default: { geoMatch: true, rotation: 'ROUND_ROBIN' } })
  cliRules: { geoMatch: boolean; rotation: 'ROUND_ROBIN' | 'RANDOM' | 'HEALTH_WEIGHTED' };

  /** Outcome-driven retry matrix per LEAD-04. */
  @Prop({ type: [Object], default: [] })
  retryMatrix: RetryRule[];

  /** Cross-campaign frequency cap per LEAD-05: max 1 contact per N days. */
  @Prop({ default: 14 })
  frequencyCapDays: number;

  /** Scoring configuration per AI-05. */
  @Prop({ type: Object, required: true })
  scoring: ScoringConfig;

  /** Objection rebuttal library per AI-04: objection label → rebuttal guidance. */
  @Prop({ type: [Object], default: [] })
  rebuttals: Array<{ objection: string; rebuttal: string }>;

  /** AI self-identification toggle per AI-07 (legal default ON per pack). */
  @Prop({ default: true })
  aiSelfIdentification: boolean;

  @Prop({ type: String, enum: TRANSCRIPTION_MODES, default: 'SUMMARY' })
  transcriptionMode: TranscriptionMode;

  /** TTS whisper in the agent's ear before bridge per XFER-05. */
  @Prop({ default: false })
  whisperEnabled: boolean;

  @Prop({ type: String, enum: ROUTING_STRATEGIES, default: 'LONGEST_IDLE' })
  routingStrategy: RoutingStrategy;

  @Prop({ default: 13 })
  transferAcceptWindowSeconds: number;

  /** Campaign-level calling schedule (intersected with pack legal windows). */
  @Prop({ type: [Object], default: [] })
  schedule: Array<{ weekday: number; start: string; end: string }>;

  /** STT keyword boosting per PAL-07. */
  @Prop({ type: [String], default: [] })
  sttKeywords: string[];

  /** Summary template per PAL-11. */
  @Prop({
    default:
      'Lead {{name}} in {{location}}. Score {{score}}. Facts: {{facts}}. Objection: {{objection}}. Opener: {{opener}}',
  })
  summaryTemplate: string;
}

export type CampaignDocument = HydratedDocument<Campaign>;
export const CampaignSchema = SchemaFactory.createForClass(Campaign);
CampaignSchema.index({ tenantId: 1, status: 1 });
