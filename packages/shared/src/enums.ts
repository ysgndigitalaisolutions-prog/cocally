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
  /** Predictive dialer connected a human but no agent was free within the
   *  legal window (FCC/TCPA-style ≤2s rule) — must be tracked distinctly
   *  from NO_ANSWER for the abandon-rate compliance calculation. */
  'ABANDONED',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** Voicemail policies per TEL-05. */
export const VOICEMAIL_POLICIES = ['SILENT_HANGUP', 'PRERECORDED_DROP', 'AI_DROP'] as const;
export type VoicemailPolicy = (typeof VOICEMAIL_POLICIES)[number];

/** Agent presence per WS-01. */
export const PRESENCE_STATES = ['AVAILABLE', 'WRAP_UP', 'BREAK', 'OFFLINE', 'ON_CALL', 'RESERVED'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/**
 * Reason codes attached to a BREAK presence.
 *
 * VICIdial calls these "pause codes" and every floor depends on them: a single
 * undifferentiated BREAK makes adherence reporting impossible, because a
 * supervisor cannot tell a trained-off agent from one waiting on a system
 * fault. `productive` marks the codes that count as working time in adherence
 * — coaching and training are paid, a lunch break is not.
 */
export const PAUSE_CODES = [
  'BREAK',
  'LUNCH',
  'TOILET',
  'TRAINING',
  'COACHING',
  'MEETING',
  'ADMIN',
  'TECH_ISSUE',
  'NO_LEADS',
  'END_OF_SHIFT',
] as const;
export type PauseCode = (typeof PAUSE_CODES)[number];

/** Pause codes that count as productive (paid, on-task) time for adherence. */
export const PRODUCTIVE_PAUSE_CODES: readonly PauseCode[] = [
  'TRAINING',
  'COACHING',
  'MEETING',
  'ADMIN',
  'TECH_ISSUE',
  'NO_LEADS',
];

export const PAUSE_CODE_LABELS: Record<PauseCode, string> = {
  BREAK: 'Break',
  LUNCH: 'Lunch',
  TOILET: 'Comfort break',
  TRAINING: 'Training',
  COACHING: 'Coaching / 1-on-1',
  MEETING: 'Meeting',
  ADMIN: 'Admin / paperwork',
  TECH_ISSUE: 'Technical issue',
  NO_LEADS: 'Waiting on leads',
  END_OF_SHIFT: 'End of shift',
};

/**
 * Supervisor live-call modes.
 *
 * MONITOR — subscribe-only, neither party hears the supervisor.
 * WHISPER — the supervisor is audible to the agent only (coaching).
 * BARGE   — the supervisor is audible to everyone (takeover).
 *
 * All three are implemented as LiveKit room grants rather than a separate
 * media path: the supervisor joins the existing call room with publish rights
 * scoped to the mode.
 */
export const SUPERVISION_MODES = ['MONITOR', 'WHISPER', 'BARGE'] as const;
export type SupervisionMode = (typeof SUPERVISION_MODES)[number];

/** How an agent-initiated transfer is performed. */
export const AGENT_TRANSFER_KINDS = ['BLIND', 'WARM', 'CONFERENCE'] as const;
export type AgentTransferKind = (typeof AGENT_TRANSFER_KINDS)[number];

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
  /** Customer is parked on music-on-hold by the agent. */
  'ON_HOLD',
  'WRAP_UP',
  'COMPLETED',
  'FAILED',
] as const;
export type CallState = (typeof CALL_STATES)[number];

/** States a call may still be live in — used by sweeps and the "am I on a call?" lookup. */
export const LIVE_CALL_STATES: readonly CallState[] = [
  'DIALING',
  'RINGING',
  'AMD_CLASSIFYING',
  'IN_CONVERSATION',
  'TRANSFER_PENDING',
  'BRIDGED',
  'ON_HOLD',
];

/**
 * Why a call leg ended, derived from SIP/LiveKit disconnect reasons.
 *
 * This is the missing link that made the whole retry matrix unreachable for
 * real calls: `CALL_OUTCOMES` declares BUSY / NO_ANSWER / DISCONNECTED but
 * nothing ever produced them, because no code inspected a SIP status.
 */
export const CALL_END_REASONS = [
  'CUSTOMER_HANGUP',
  'AGENT_HANGUP',
  'AI_HANGUP',
  'BUSY',
  'NO_ANSWER',
  'REJECTED',
  'INVALID_NUMBER',
  'CONGESTION',
  'CARRIER_BLOCKED',
  'TRUNK_ERROR',
  'TIMEOUT',
  'UNKNOWN',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/**
 * Map a SIP response code to an end reason.
 *
 * 603/607/608 deserve special attention for an outbound floor: they are the
 * codes a carrier or the callee's network returns when a call is being
 * *rejected as unwanted*, which is the earliest visible signal that a CLI is
 * being blocked. They are deliberately mapped to CARRIER_BLOCKED rather than
 * collapsed into REJECTED so number-health can act on them.
 */
export function sipStatusToEndReason(status: number | undefined): CallEndReason {
  if (status === undefined) return 'UNKNOWN';
  if (status >= 200 && status < 300) return 'CUSTOMER_HANGUP';
  switch (status) {
    case 486: // Busy Here
    case 600: // Busy Everywhere
      return 'BUSY';
    case 408: // Request Timeout
    case 480: // Temporarily Unavailable
      return 'NO_ANSWER';
    case 404: // Not Found
    case 410: // Gone
      return 'INVALID_NUMBER';
    case 603: // Decline
    case 607: // Unwanted
    case 608: // Rejected (intermediary / analytics engine)
      return 'CARRIER_BLOCKED';
    case 403: // Forbidden
    case 401:
    case 407:
      return 'TRUNK_ERROR';
    case 503: // Service Unavailable
    case 502:
    case 500:
      return 'CONGESTION';
    default:
      if (status >= 400 && status < 500) return 'REJECTED';
      if (status >= 500) return 'CONGESTION';
      return 'UNKNOWN';
  }
}

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
