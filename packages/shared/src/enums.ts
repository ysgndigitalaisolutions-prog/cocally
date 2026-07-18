/** Roles per PRD §2. */
export const ROLES = ['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT', 'QA', 'API_CLIENT'] as const;
export type Role = (typeof ROLES)[number];

/** Lead lifecycle states per LEAD-07. */
export const LEAD_STATES = [
  'FRESH',
  'ATTEMPTED',
  'CONTACTED',
  'QUALIFIED',
  'TRANSFERRED',
  'BOOKED',
  'CALLBACK',
  'NURTURE',
  'EXHAUSTED',
  'DNC',
] as const;
export type LeadState = (typeof LEAD_STATES)[number];

/** Answering-machine detection classes per TEL-04. */
export const AMD_CLASSES = ['HUMAN', 'VOICEMAIL', 'IVR', 'FAX', 'SILENCE'] as const;
export type AmdClass = (typeof AMD_CLASSES)[number];

/** Call outcomes driving the retry matrix per LEAD-04. */
export const CALL_OUTCOMES = [
  'ANSWERED_HUMAN',
  'ANSWERED_VOICEMAIL',
  'ANSWERED_IVR',
  'BUSY',
  'NO_ANSWER',
  'DISCONNECTED',
  'FAILED',
  'CALLBACK_REQUESTED',
  'OPT_OUT',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** Voicemail policies per TEL-05. */
export const VOICEMAIL_POLICIES = ['SILENT_HANGUP', 'PRERECORDED_DROP', 'AI_DROP'] as const;
export type VoicemailPolicy = (typeof VOICEMAIL_POLICIES)[number];

/** Agent presence per WS-01. */
export const PRESENCE_STATES = ['AVAILABLE', 'WRAP_UP', 'BREAK', 'OFFLINE', 'ON_CALL', 'RESERVED'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/** Transfer routing strategies per XFER-01. */
export const ROUTING_STRATEGIES = [
  'LONGEST_IDLE',
  'ROUND_ROBIN',
  'LEAST_TALK_TIME',
  'SKILL_PRIORITY',
  'STICKY',
] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

/** AI provider capabilities per PAL. */
export const PROVIDER_CAPABILITIES = ['TTS', 'STT', 'LLM'] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/** LLM roles per PAL-03: each independently configurable. */
export const LLM_ROLES = ['CONVERSATION', 'SUMMARY', 'SCORING'] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/** Transcription display mode per PAL-10. */
export const TRANSCRIPTION_MODES = ['LIVE', 'SUMMARY', 'BOTH'] as const;
export type TranscriptionMode = (typeof TRANSCRIPTION_MODES)[number];

/** Call leg types per REC-01 / TEL-10. */
export const CALL_LEGS = ['AI', 'WHISPER', 'HUMAN'] as const;
export type CallLeg = (typeof CALL_LEGS)[number];

/** Live call lifecycle used by the orchestrator and floor feed. */
export const CALL_STATES = [
  'DIALING',
  'RINGING',
  'AMD_CLASSIFYING',
  'IN_CONVERSATION',
  'TRANSFER_PENDING',
  'BRIDGED',
  'WRAP_UP',
  'COMPLETED',
  'FAILED',
] as const;
export type CallState = (typeof CALL_STATES)[number];

/** Flow node types per FLOW-02. */
export const NODE_TYPES = [
  'PLAY_AUDIO',
  'SPEAK',
  'AI_CONVERSATION',
  'LISTEN_CAPTURE',
  'AMD_CLASSIFY',
  'SEND_DTMF',
  'BRANCH',
  'TRANSFER',
  'WEBHOOK',
  'SET_RETRY',
  'END',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Flow version lifecycle per FLOW-04. */
export const FLOW_VERSION_STATES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type FlowVersionState = (typeof FLOW_VERSION_STATES)[number];

/** Disposition set closed by the human agent per XFER-06. */
export const DISPOSITIONS = [
  'BOOKED',
  'CALLBACK',
  'NOT_INTERESTED',
  'NOT_QUALIFIED',
  'WRONG_NUMBER',
  'DO_NOT_CALL',
  'FOLLOW_UP',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** Webhook events per PLAT-04. */
export const WEBHOOK_EVENTS = [
  'call.completed',
  'lead.qualified',
  'transfer.accepted',
  'appointment.booked',
  'lead.optout',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Score-threshold actions per AI-05. */
export const SCORE_ACTIONS = ['TRANSFER', 'BOOK_ONLY', 'NURTURE', 'RELEASE'] as const;
export type ScoreAction = (typeof SCORE_ACTIONS)[number];
