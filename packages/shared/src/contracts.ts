import type {
  AgentTransferKind,
  AmdClass,
  CallState,
  Disposition,
  LeadState,
  PauseCode,
  PresenceState,
  SupervisionMode,
  TranscriptionMode,
} from './enums.js';

/**
 * Everything the agent's browser needs to rebuild the call bar after a reload.
 *
 * Without this the agent loses the call on any refresh — the customer hears
 * silence while the server still believes the agent is ON_CALL. This is the
 * server-side answer to "what am I on right now?".
 */
export interface CurrentCallState {
  callId: string;
  leadId: string;
  leadName: string;
  phone: string;
  campaignId: string;
  campaignName: string;
  state: CallState;
  manual: boolean;
  /** Owning agent (null for an AI-only call); lets the bar know whether hold music is its job. */
  agentId: string | null;
  /** Set when the call is parked in WRAP_UP awaiting the agent's disposition. */
  wrapUpDeadline: number | null;
  /** Epoch ms — drives the call timer without trusting the client clock. */
  startedAt: number;
  bridgedAt: number | null;
  onHold: boolean;
  cli: string | null;
  /** Fresh LiveKit credentials so the browser can rejoin the same room. */
  livekitUrl: string;
  livekitToken: string;
  roomName: string;
  /** Present when this call arrived as an AI warm transfer. */
  transferCard: TransferCard | null;
}

/** Answer to "is this agent clocked on, and on what?" */
export interface AgentShiftState {
  presence: PresenceState;
  pauseCode: PauseCode | null;
  pausedSince: number | null;
  clockedInAt: number | null;
  /** Seconds worked in the current shift, server-computed. */
  shiftSeconds: number;
  /** Seconds paused in the current shift, across all codes. */
  pausedSeconds: number;
  /** Epoch ms the wrap-up timer expires, when in WRAP_UP. */
  wrapUpDeadline: number | null;
}

/** A supervisor's live view of one in-progress call. */
export interface SupervisableCall {
  callId: string;
  agentId: string | null;
  agentName: string | null;
  leadName: string;
  campaignName: string;
  state: CallState;
  startedAt: number;
  manual: boolean;
  /** True when a supervisor is already attached to this call. */
  supervised: SupervisionMode | null;
}

/** Credentials for a supervisor to attach to a live call room. */
export interface SupervisionSession {
  callId: string;
  mode: SupervisionMode;
  livekitUrl: string;
  livekitToken: string;
  roomName: string;
  /** Identities the supervisor should subscribe to. MONITOR/BARGE = all. */
  subscribeTo: string[];
}

/** Agent-to-agent transfer offer, delivered over the socket. */
export interface AgentTransferOffer {
  transferId: string;
  callId: string;
  kind: AgentTransferKind;
  fromAgentId: string;
  fromAgentName: string;
  leadName: string;
  phone: string;
  campaignName: string;
  note: string | null;
  acceptDeadline: number;
}

/** Transfer summary card contract per XFER-05. */
export interface TransferCard {
  transferId: string;
  leadId: string;
  callId: string;
  campaignId: string;
  campaignName: string;
  name: string;
  location: string;
  score: number;
  /** Qualified-fact checklist: label → captured value. */
  facts: Array<{ label: string; value: string; confirmed: boolean }>;
  flaggedObjection: string | null;
  proposedAppointment: string | null;
  suggestedOpener: string;
  /** Epoch ms when the accept window expires (countdown ring in WS-03). */
  acceptDeadline: number;
}

/**
 * Predictive (ratio/adaptive) dialing config for the human-agent floor —
 * ViciDial calls this "adaptive dialing": the ratio of lines dialed per
 * logged-in agent is recalculated periodically off the rolling abandon
 * rate. `method: 'ADAPT_HARD_LIMIT'` auto-lowers `ratio` toward `minRatio`
 * whenever the abandon rate approaches `maxAbandonRatePercent`, and raises
 * it toward `maxRatio` when agents are idle and the rate has headroom —
 * the same governor VICIdial's AST_VDadapt process runs every ~15s.
 */
export interface PredictiveDialingConfig {
  enabled: boolean;
  method: 'FIXED_RATIO' | 'ADAPT_HARD_LIMIT';
  /** Lines dialed per logged-in agent right now (auto-adjusted under ADAPT_HARD_LIMIT). */
  ratio: number;
  minRatio: number;
  maxRatio: number;
  /** FCC/TCPA-style cap: max % of human-answered calls that may go unstaffed, per campaign. */
  maxAbandonRatePercent: number;
  /** Seconds to wait for a free agent before a connected call is abandoned (2s is the FCC rule). */
  abandonTimeoutSeconds: number;
}

/** Instant screen-pop for a predictive-dial connect — no accept/decline, the
 *  customer is already live so the agent's audio bridges immediately. */
export interface PredictiveBridgeCard {
  callId: string;
  leadId: string;
  leadName: string;
  phone: string;
  location: string;
  campaignId: string;
  campaignName: string;
}

/** Floor-feed card per WS-02. */
export interface FloorCallCard {
  callId: string;
  leadId: string;
  campaignId: string;
  leadName: string;
  state: CallState;
  currentStage: string;
  score: number;
  startedAt: number;
  claimable: boolean;
}

export interface TranscriptSegment {
  callId: string;
  leg: 'AI' | 'HUMAN';
  speaker: 'agent' | 'customer' | 'ai';
  text: string;
  startMs: number;
  endMs: number;
  final: boolean;
}

/** WebSocket events server → client. */
export interface ServerEvents {
  'presence.updated': { userId: string; state: PresenceState };
  'floor.call.updated': FloorCallCard;
  'floor.call.removed': { callId: string };
  'transfer.offer': TransferCard;
  'transfer.cancelled': { transferId: string; reason: string };
  'transfer.bridged': { transferId: string; callId: string };
  'predictive.call.bridged': PredictiveBridgeCard;
  'predictive.call.ended': { callId: string };
  'transcript.segment': TranscriptSegment;
  'call.summary.updated': { callId: string; summary: string };
  'campaign.paused': { campaignId: string; by: string };
  /** Server-authoritative call state change (ringing → bridged → hold → ended). */
  'call.state.changed': { callId: string; state: CallState; endReason?: string };
  /** The agent's own current call was ended by the far end or a supervisor. */
  'call.ended': { callId: string; reason: string; outcome: string | null };
  'agent.transfer.offer': AgentTransferOffer;
  'agent.transfer.cancelled': { transferId: string; reason: string };
  'agent.transfer.accepted': { transferId: string; callId: string };
  /** Wrap-up countdown started; the client shows a timer and auto-returns. */
  'wrapup.started': { callId: string; deadline: number };
  /** A supervisor attached to or detached from this agent's call. */
  'supervision.changed': { callId: string; mode: SupervisionMode | null; supervisorName: string | null };
  /** Campaign worklist is running dry — surfaced to supervisors, not agents. */
  'hopper.low': { campaignId: string; campaignName: string; availableNow: number; threshold: number };
}

/** WebSocket events client → server. */
export interface ClientEvents {
  'presence.set': { state: Extract<PresenceState, 'AVAILABLE' | 'WRAP_UP' | 'BREAK' | 'OFFLINE'> };
  'transfer.accept': { transferId: string };
  'transfer.decline': { transferId: string };
  'call.claim': { callId: string };
  'disposition.set': { callId: string; disposition: Disposition; notes?: string };
}

/** Lead import report per LEAD-01. */
export interface LeadImportReport {
  importId: string;
  total: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  rejects: Array<{ row: number; reason: string; raw: Record<string, string> }>;
}

/** Live propensity scoring config per AI-05. */
export interface ScoringConfig {
  weights: Record<string, number>;
  thresholds: {
    transfer: number;
    bookOnly: number;
    nurture: number;
  };
}

export interface LeadTimelineEntry {
  at: string;
  kind:
    | 'STATE_CHANGE'
    | 'CALL'
    | 'TRANSFER'
    | 'DISPOSITION'
    | 'SUPPRESSION'
    | 'IMPORT'
    | 'CALLBACK_SCHEDULED'
    | 'OPT_OUT';
  detail: string;
  state?: LeadState;
  callId?: string;
}

export interface CallDetail {
  callId: string;
  leadId: string;
  campaignId: string;
  state: CallState;
  amdClass: AmdClass | null;
  startedAt: string;
  endedAt: string | null;
  score: number;
  transcriptionMode: TranscriptionMode;
  costCents: number;
}
