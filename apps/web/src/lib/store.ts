'use client';

import { create } from 'zustand';
import type {
  AgentShiftState,
  AgentTransferKind,
  AgentTransferOffer,
  CallState,
  PresenceState,
  SupervisionMode,
  TransferCard,
} from '@cocally/shared';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

/**
 * The one active call an agent can be on, regardless of how it started.
 * Global (not page-local) so a docked call bar can stay visible while the
 * agent navigates — the call doesn't vanish just because they clicked over
 * to Leads to check something mid-call.
 */
export interface ActiveCallInfo {
  callId: string;
  source: 'transfer' | 'manual' | 'predictive';
  leadName: string;
  phone: string;
  cli?: string | null;
  /** Manual dial only — join info already in hand from dial(), skips a round trip. */
  livekitUrl?: string;
  livekitToken?: string;
  /** Server epoch ms the call started. The ONLY trusted origin for the call timer. */
  startedAt?: number;
  /**
   * Server-side call state at (re)join time. Only set on a recovered call —
   * the bar drives its own state from there. `ON_HOLD` here is what tells the
   * bar to put the hold music back after a reload killed it.
   */
  callState?: CallState;
  campaignName?: string;
  /** AI warm-transfer card, re-served by `/workspace/me/current-call` after a reload. */
  transferCard?: TransferCard | null;
  /**
   * True when this call was rebuilt from `/workspace/me/current-call` rather
   * than started in this tab. Load-bearing: the call bar must NOT re-issue the
   * manual-dial connect for a recovered call — the SIP leg is already up and
   * dialing again would ring the customer a second time.
   */
  recovered?: boolean;
}

/** An agent-to-agent transfer this agent OFFERED and is waiting on. */
export interface PendingAgentTransfer {
  transferId: string;
  callId: string;
  kind: AgentTransferKind;
  toAgentName: string;
  acceptDeadline: number;
  /** Set once the target accepts — WARM then waits for "complete transfer". */
  accepted: boolean;
  /**
   * True when making this offer parked the customer (BLIND/WARM do, CONFERENCE
   * does not), so the browser knows whether it owns the hold music that has to
   * stop if the offer is cancelled or lapses.
   */
  heldForOffer: boolean;
}

interface AppState {
  user: SessionUser | null;
  setUser: (user: SessionUser | null) => void;
  presence: PresenceState;
  setPresence: (state: PresenceState) => void;
  /** Clock/pause state from `GET /workspace/me/shift`, refreshed on every change. */
  shift: AgentShiftState | null;
  setShift: (shift: AgentShiftState | null) => void;
  transferOffer: TransferCard | null;
  setTransferOffer: (offer: TransferCard | null) => void;
  /** Inbound agent-to-agent offer (`agent.transfer.offer`), distinct from the AI one above. */
  agentTransferOffer: AgentTransferOffer | null;
  setAgentTransferOffer: (offer: AgentTransferOffer | null) => void;
  /** Outbound agent-to-agent offer this agent is waiting on. */
  pendingTransfer: PendingAgentTransfer | null;
  setPendingTransfer: (pending: PendingAgentTransfer | null) => void;
  /**
   * Wrap-up countdown, from the `wrapup.started` socket event. Lives in the
   * store because it outlives the call bar: a BLIND transfer drops the call
   * and leaves the agent wrapping up with nothing docked at the bottom.
   */
  wrapUp: { callId: string; deadline: number } | null;
  setWrapUp: (wrapUp: { callId: string; deadline: number } | null) => void;
  /** A supervisor audible on this agent's call. Never set for MONITOR — see GlobalCallBar. */
  supervision: { mode: SupervisionMode; supervisorName: string | null } | null;
  setSupervision: (supervision: { mode: SupervisionMode; supervisorName: string | null } | null) => void;
  activeCall: ActiveCallInfo | null;
  setActiveCall: (call: ActiveCallInfo | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  presence: 'OFFLINE',
  setPresence: (presence) => set({ presence }),
  shift: null,
  setShift: (shift) => set({ shift }),
  transferOffer: null,
  setTransferOffer: (transferOffer) => set({ transferOffer }),
  agentTransferOffer: null,
  setAgentTransferOffer: (agentTransferOffer) => set({ agentTransferOffer }),
  pendingTransfer: null,
  setPendingTransfer: (pendingTransfer) => set({ pendingTransfer }),
  wrapUp: null,
  setWrapUp: (wrapUp) => set({ wrapUp }),
  supervision: null,
  setSupervision: (supervision) => set({ supervision }),
  activeCall: null,
  setActiveCall: (activeCall) => set({ activeCall }),
}));
