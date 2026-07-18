import type { AmdClass, CallState, Disposition, LeadState, PresenceState, TranscriptionMode } from './enums.js';

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
  'transcript.segment': TranscriptSegment;
  'call.summary.updated': { callId: string; summary: string };
  'campaign.paused': { campaignId: string; by: string };
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
