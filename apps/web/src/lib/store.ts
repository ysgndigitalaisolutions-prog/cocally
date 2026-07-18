'use client';

import { create } from 'zustand';
import type { PresenceState, TransferCard } from '@cocally/shared';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

interface AppState {
  user: SessionUser | null;
  setUser: (user: SessionUser | null) => void;
  presence: PresenceState;
  setPresence: (state: PresenceState) => void;
  transferOffer: TransferCard | null;
  setTransferOffer: (offer: TransferCard | null) => void;
  activeCallId: string | null;
  setActiveCallId: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  presence: 'OFFLINE',
  setPresence: (presence) => set({ presence }),
  transferOffer: null,
  setTransferOffer: (transferOffer) => set({ transferOffer }),
  activeCallId: null,
  setActiveCallId: (activeCallId) => set({ activeCallId }),
}));
