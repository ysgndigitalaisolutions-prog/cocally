'use client';

import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import type { AgentTransferOffer, CurrentCallState, PredictiveBridgeCard, SupervisionMode, TransferCard } from '@cocally/shared';
import { api, secondsSince, secondsUntil } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAppStore } from '@/lib/store';
import TransferDialog, { type OfferedTransfer } from '@/components/TransferDialog';

interface CallBriefing {
  callId: string;
  leadName: string;
  location: string;
  score: number;
  summary: string;
  facts: Array<{ label: string; value: string; confirmed: boolean }>;
  objection: string | null;
  campaignName: string;
  rebuttals: Array<{ objection: string; rebuttal: string }>;
}

const DISPOSITIONS: Array<[string, string]> = [
  ['BOOKED', 'Booked'],
  ['CALLBACK', 'Callback'],
  ['NOT_INTERESTED', 'Not interested'],
  ['NOT_QUALIFIED', 'Not qualified'],
  ['WRONG_NUMBER', 'Wrong number'],
  ['DO_NOT_CALL', 'Do not call'],
  ['FOLLOW_UP', 'Follow up'],
];
const NEEDS_SCHEDULE = new Set(['BOOKED', 'CALLBACK']);

/**
 * joining    browser connecting to the room + publishing mic
 * dialing    (manual only) mic is live, carrier INVITE sent
 * ringing    (manual only) carrier accepted the SIP leg, waiting for pickup
 * connected  a human is on the line — for transfer/predictive this is
 *            reached as soon as the room connects (already bridged
 *            server-side); for manual it waits for the SIP leg's audio track
 * ended      the call dropped
 */
type CallPhase = 'joining' | 'dialing' | 'ringing' | 'connected' | 'ended';
const PHASE_LABEL: Record<CallPhase, string> = {
  joining: 'Connecting…',
  dialing: 'Dialing…',
  ringing: 'Ringing…',
  connected: 'Connected',
  ended: 'Call ended',
};
const PHASE_DOT: Record<CallPhase, string> = {
  joining: 'var(--accent)',
  dialing: 'var(--accent)',
  ringing: 'var(--accent)',
  connected: 'var(--good)',
  ended: 'var(--bad)',
};

const DTMF_CODES: Record<string, number> = {
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '*': 10, '0': 0, '#': 11,
};
const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/** The Web Audio graph currently feeding hold music into the mic sender. */
interface HoldAudio {
  ctx: AudioContext;
  element: HTMLAudioElement | null;
  track: MediaStreamTrack;
  /** Set only for the generated fallback tone. */
  stopTone: (() => void) | null;
}

function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message;
  if (Array.isArray(detail)) return detail.join(', ');
  return typeof detail === 'string' ? detail : fallback;
}

/**
 * The one place a live call is ever rendered — a persistent, docked bar
 * (mounted once in the app layout) instead of a full-page section, so it
 * survives the agent navigating to check a lead or a campaign mid-call. This
 * replaces three separate "on call" implementations that used to live inside
 * workspace/page.tsx and manual-dial/page.tsx, one per call source
 * (AI-warm-transfer, manual dial, predictive dial) — they differ only in how
 * the call STARTS; everything after that (audio, mute, DTMF, briefing,
 * disposition) is identical, so it's one component now.
 *
 * It is also the only component that is mounted for the whole session, so it
 * owns the socket events that must never be missed regardless of which page
 * the agent happens to be on: call state, call end, wrap-up, supervision, and
 * agent-to-agent transfer offers.
 */
export default function GlobalCallBar() {
  const {
    activeCall,
    setActiveCall,
    setPresence,
    setShift,
    agentTransferOffer,
    setAgentTransferOffer,
    pendingTransfer,
    setPendingTransfer,
    wrapUp,
    setWrapUp,
    supervision,
    setSupervision,
    transferOffer,
    setTransferOffer,
  } = useAppStore();
  const [phase, setPhase] = useState<CallPhase>('joining');
  const [reconnecting, setReconnecting] = useState(false);
  const [aiOfferCountdown, setAiOfferCountdown] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [briefing, setBriefing] = useState<CallBriefing | null>(null);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState<{ value: string; when: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [dtmfSent, setDtmfSent] = useState('');
  const [onHold, setOnHold] = useState(false);
  const [holdBusy, setHoldBusy] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [offerCountdown, setOfferCountdown] = useState(0);
  const [pendingCountdown, setPendingCountdown] = useState(0);
  const [wrapUpLeft, setWrapUpLeft] = useState(0);

  const roomRef = useRef<Room | null>(null);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  /** The real microphone track, stashed while hold music is published in its place. */
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const holdAudioRef = useRef<HoldAudio | null>(null);
  /** Mirrors `onHold` for callbacks (socket/track handlers) that close over stale state. */
  const onHoldRef = useRef(false);

  function flash(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(''), 3500);
  }

  // ── Hold audio ────────────────────────────────────────────────────────────
  //
  // READ THIS BEFORE CHANGING ANY OF THE FOUR FUNCTIONS BELOW.
  //
  // The API holds a call in STATE ONLY — see the comment on CallControlService.
  // There is no server-side media publisher in this stack, so nothing can push
  // an audio file into the LiveKit room. The hold experience the customer
  // actually gets is produced here, in the agent's browser:
  //
  //   hold   → build a looping source (the `holdMusicUrl` the hold endpoint
  //            returns, or a generated comfort tone if there is none) into a
  //            MediaStreamAudioDestinationNode, then `replaceTrack` the already
  //            published microphone sender with that node's track. The customer
  //            keeps receiving the same LiveKit track, now carrying music, so
  //            there is no renegotiation and no gap.
  //   resume → `replaceTrack` the stashed real mic track back in.
  //
  // The agent must not hear any of it: a MediaElementAudioSourceNode detaches
  // the <audio> element from the speakers (it only reaches them if you connect
  // to ctx.destination, which we never do), and the customer's inbound track is
  // muted locally for the duration so the agent can talk to a colleague.
  //
  // Consequence worth knowing: if this tab dies while on hold, the music dies
  // with it and the customer hears silence while the server still says ON_HOLD.
  // That is why the recovery path below re-engages hold audio after a reload.

  function setRemoteAudioMuted(muted: boolean) {
    audioContainerRef.current?.querySelectorAll('audio').forEach((el) => {
      (el as HTMLAudioElement).muted = muted;
    });
  }

  async function buildHoldAudio(url: string | null): Promise<HoldAudio> {
    const ctx = new AudioContext();
    // Hold is always reached from a click, so a suspended context (autoplay
    // policy) resumes immediately here rather than silently producing nothing.
    if (ctx.state === 'suspended') await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    gain.connect(dest);

    let element: HTMLAudioElement | null = null;
    if (url) {
      try {
        element = new Audio(url);
        element.loop = true;
        // Required for the graph to read the samples cross-origin; without it a
        // remote file yields a silent (tainted) source, which is the exact
        // failure the fallback tone below exists to catch.
        element.crossOrigin = 'anonymous';
        ctx.createMediaElementSource(element).connect(gain);
        await element.play();
      } catch {
        element?.pause();
        element = null;
      }
    }

    let stopTone: (() => void) | null = null;
    if (!element) {
      // No hold music configured, or it would not load. Silence is worse than a
      // tone: a customer hearing nothing assumes the call dropped and hangs up,
      // so they get a quiet periodic pulse that says "still here" instead.
      const osc = ctx.createOscillator();
      const toneGain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      toneGain.gain.value = 0;
      osc.connect(toneGain);
      toneGain.connect(gain);
      osc.start();
      const pulse = () => {
        const now = ctx.currentTime;
        toneGain.gain.cancelScheduledValues(now);
        toneGain.gain.setValueAtTime(0, now);
        toneGain.gain.linearRampToValueAtTime(0.08, now + 0.08);
        toneGain.gain.setValueAtTime(0.08, now + 0.9);
        toneGain.gain.linearRampToValueAtTime(0, now + 1);
      };
      pulse();
      const timer = setInterval(pulse, 4000);
      stopTone = () => {
        clearInterval(timer);
        try {
          osc.stop();
        } catch {
          // Already stopped — nothing to do.
        }
      };
    }

    const track = dest.stream.getAudioTracks()[0];
    if (!track) throw new Error('Could not build the hold audio track.');
    return { ctx, element, track, stopTone };
  }

  function teardownHoldAudio() {
    const hold = holdAudioRef.current;
    holdAudioRef.current = null;
    if (!hold) return;
    hold.stopTone?.();
    hold.element?.pause();
    hold.track.stop();
    void hold.ctx.close().catch(() => undefined);
  }

  /** Publish hold music in place of the mic. Throws if the mic is not published. */
  async function engageHoldAudio(url: string | null): Promise<void> {
    const room = roomRef.current;
    const local = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!room || !local) throw new Error('Your microphone is not live — cannot hold this call.');
    if (holdAudioRef.current) return;

    const hold = await buildHoldAudio(url);
    // Stash the real mic first: replaceTrack does NOT stop the outgoing track,
    // so this stays live and can be swapped straight back on resume without
    // re-prompting the agent for microphone permission.
    micTrackRef.current = local.mediaStreamTrack;
    // `true` marks the track as user-provided so the SDK does not try to
    // restart or release a Web Audio track as if it were a capture device.
    await local.replaceTrack(hold.track, true);
    holdAudioRef.current = hold;
    onHoldRef.current = true;
    setRemoteAudioMuted(true);
    setOnHold(true);
  }

  /** Local-only: swap the mic back and tear the graph down. Does not call the API. */
  async function releaseHoldAudio(): Promise<void> {
    const room = roomRef.current;
    const local = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    const mic = micTrackRef.current;
    if (local && holdAudioRef.current) {
      if (mic && mic.readyState === 'live') {
        await local.replaceTrack(mic, false);
      } else if (room) {
        // The device was released while parked (headset unplugged, tab frozen).
        // Re-acquire rather than leave the agent publishing music at a customer
        // who has just been taken off hold.
        await room.localParticipant.setMicrophoneEnabled(false);
        await room.localParticipant.setMicrophoneEnabled(true);
      }
    }
    micTrackRef.current = null;
    teardownHoldAudio();
    onHoldRef.current = false;
    setRemoteAudioMuted(false);
    setOnHold(false);
  }

  function resetLocal() {
    setPhase('joining');
    setError('');
    setBriefing(null);
    setNotes('');
    setPending(null);
    setAudioBlocked(false);
    setMicMuted(false);
    setDtmfSent('');
    setElapsed(0);
    setExpanded(true);
    setShowTransfer(false);
    teardownHoldAudio();
    micTrackRef.current = null;
    onHoldRef.current = false;
    setOnHold(false);
  }

  // ── Call-bar recovery ─────────────────────────────────────────────────────
  //
  // The single most valuable request on the agent desktop. A reload used to
  // lose the customer outright: the room token died with the page, so the agent
  // sat looking at an empty screen while the server still had them ON_CALL and
  // the customer heard nothing. `GET /workspace/me/current-call` answers "what
  // am I on right now?" and mints a FRESH LiveKit token for exactly this, so
  // the bar (and the audio) can be rebuilt from server truth alone.
  useEffect(() => {
    let cancelled = false;
    api
      .get('/workspace/me/current-call')
      .then((r) => {
        const state: CurrentCallState | null = r.data ?? null;
        // A call this tab started while the request was in flight wins — it has
        // credentials of its own and is further along than this snapshot.
        if (cancelled || !state || useAppStore.getState().activeCall) return;
        if (state.state === 'WRAP_UP' && state.wrapUpDeadline) setWrapUp({ callId: state.callId, deadline: state.wrapUpDeadline });
        setActiveCall({
          callId: state.callId,
          source: state.manual ? 'manual' : state.transferCard ? 'transfer' : 'predictive',
          agentId: state.agentId,
          leadName: state.leadName,
          phone: state.phone,
          cli: state.cli,
          campaignName: state.campaignName,
          livekitUrl: state.livekitUrl || undefined,
          livekitToken: state.livekitToken || undefined,
          startedAt: state.startedAt,
          callState: state.state,
          transferCard: state.transferCard,
          recovered: true,
        });
      })
      .catch(() => undefined);
    // An AI transfer offer that was mid-countdown when the page reloaded.
    api
      .get('/workspace/me')
      .then((r) => {
        const offer: TransferCard | null = r.data?.pendingOffer ?? null;
        if (!cancelled && offer && !useAppStore.getState().transferOffer) setTransferOffer(offer);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [setActiveCall, setTransferOffer, setWrapUp]);

  // The call itself: join the room, publish the mic, then (manual only) tell
  // the API to place the SIP leg. Never dial before the mic is live, or the
  // customer can answer to an empty room.
  useEffect(() => {
    if (!activeCall) {
      roomRef.current?.disconnect();
      roomRef.current = null;
      resetLocal();
      return;
    }

    let cancelled = false;
    resetLocal();
    // A call recovered in WRAP_UP has already ended: no room to join, just
    // the disposition form (and the countdown) to put back on screen.
    if (activeCall.recovered && activeCall.callState === 'WRAP_UP') {
      setPhase('ended');
      return;
    }
    const sipIdentity = `lead-${activeCall.callId}`;
    const room = new Room();

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      // A track that arrives while the customer is parked must come in muted,
      // or the agent suddenly hears them mid-hold.
      el.muted = onHoldRef.current;
      audioContainerRef.current?.appendChild(el);
      el.play().catch(() => setAudioBlocked(true));
      if (activeCall.source === 'manual' && participant.identity === sipIdentity) setPhase('connected');
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (activeCall.source === 'manual' && participant.identity === sipIdentity) {
        setPhase((prev) => (prev === 'connected' || prev === 'ringing' || prev === 'dialing' ? 'ended' : prev));
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!cancelled) setPhase('ended');
    });

    (async () => {
      try {
        let url = activeCall.livekitUrl;
        let token = activeCall.livekitToken;
        if (!url || !token) {
          // transfer/predictive: already bridged server-side, just mint our join token.
          const r = await api.get(`/calls/${activeCall.callId}/agent-token`);
          url = r.data.url;
          token = r.data.token;
        }
        await room.connect(url!, token!);
        await room.localParticipant.setMicrophoneEnabled(true);
        if (cancelled) return;
        roomRef.current = room;

        // A recovered call is already up: the SIP leg exists and re-issuing the
        // manual-dial connect would ring the customer a second time.
        if (activeCall.recovered) {
          setPhase(
            activeCall.callState === 'DIALING' || activeCall.callState === 'CONNECTING'
              ? 'dialing'
              : activeCall.callState === 'RINGING'
                ? 'ringing'
                : 'connected',
          );
          // Reloaded between dial() and connect(): the INVITE was never sent.
          // connect() is guarded server-side, so re-issuing it cannot ring twice.
          if (activeCall.source === 'manual' && activeCall.callState === 'DIALING') {
            await api.post(`/manual-dial/calls/${activeCall.callId}/connect`);
            if (!cancelled) setPhase((prev) => (prev === 'dialing' ? 'ringing' : prev));
          }
          const me = JSON.parse(localStorage.getItem('cocally.user') ?? '{}') as { id?: string };
          const ownsHold = !activeCall.agentId || !me.id || activeCall.agentId === me.id;
          if (activeCall.callState === 'ON_HOLD' && ownsHold) {
            // The server still says parked, but the browser that was producing
            // the music is gone — the customer is sitting in silence right now.
            // The hold endpoint is idempotent, so this re-reads the URL without
            // inflating the hold count, and puts the music back.
            const r = await api.post(`/call-control/calls/${activeCall.callId}/hold`);
            if (!cancelled) await engageHoldAudio(r.data.holdMusicUrl ?? null);
          }
          return;
        }

        if (activeCall.source !== 'manual') {
          setPhase('connected');
          return;
        }
        setPhase('dialing');
        await api.post(`/manual-dial/calls/${activeCall.callId}/connect`);
        if (!cancelled) setPhase((prev) => (prev === 'dialing' ? 'ringing' : prev));
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err, 'Could not connect the call.'));
        setPhase('ended');
      }
    })();

    return () => {
      cancelled = true;
      teardownHoldAudio();
      room.disconnect();
      if (roomRef.current === room) roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall?.callId]);

  // Briefing loads in behind the call — works for all three sources (empty
  // facts/summary for manual/predictive, since there's no AI leg to summarise).
  useEffect(() => {
    if (!activeCall) return;
    api.get(`/calls/${activeCall.callId}/briefing`).then((r) => setBriefing(r.data)).catch(() => undefined);
  }, [activeCall?.callId]);

  // The timer is anchored to the server's `startedAt`, not to a local counter
  // that starts at zero — otherwise every reload restarts the clock and the
  // agent has no idea how long the customer has actually been on the line.
  useEffect(() => {
    if (phase !== 'connected') return;
    const startedAt = activeCall?.startedAt;
    if (typeof startedAt === 'number') {
      setElapsed(secondsSince(startedAt));
      const timer = setInterval(() => setElapsed(secondsSince(startedAt)), 1000);
      return () => clearInterval(timer);
    }
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, [phase, activeCall?.startedAt]);

  // ── Session-wide socket events ────────────────────────────────────────────
  // Registered here (not on a page) because this component is mounted for the
  // whole session: a wrap-up timer or a transfer offer must not be missed just
  // because the agent was looking at Leads. Handlers are removed by reference
  // so this never tears down another component's listener for the same event.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onAgentOffer = (offer: AgentTransferOffer) => setAgentTransferOffer(offer);

    // AI warm-transfer offers. Owned here, not by the Workspace page, so an
    // Available agent on Manual dial / Insights / Leads still gets the card
    // (and the ring) instead of silently timing the customer out.
    const onOffer = (card: TransferCard) => setTransferOffer(card);
    const onOfferCancelled = ({ transferId }: { transferId: string }) => {
      if (useAppStore.getState().transferOffer?.transferId === transferId) setTransferOffer(null);
    };
    const onBridged = ({ callId }: { callId: string }) => {
      const offer = useAppStore.getState().transferOffer;
      setActiveCall({
        callId,
        source: 'transfer',
        leadName: offer?.name ?? '',
        phone: '',
        campaignName: offer?.campaignName,
        transferCard: offer ?? null,
      });
      setTransferOffer(null);
    };
    const onPredictiveBridged = (card: PredictiveBridgeCard) => {
      setActiveCall({ callId: card.callId, source: 'predictive', leadName: card.leadName, phone: card.phone });
    };
    const onWrapUpFinished = () => {
      setWrapUp(null);
      setPresence('AVAILABLE');
    };
    const refreshFromServer = () => {
      api
        .get('/workspace/me')
        .then((r) => {
          setPresence(r.data.presence);
          const offer: TransferCard | null = r.data?.pendingOffer ?? null;
          if (offer && !useAppStore.getState().transferOffer) setTransferOffer(offer);
        })
        .catch(() => undefined);
      api.get('/workspace/me/shift').then((r) => setShift(r.data)).catch(() => undefined);
    };
    const onDisconnect = () => setReconnecting(true);
    const onConnect = () => {
      setReconnecting(false);
      // Anything the server decided while we were away (an offer, a presence
      // change, a wrap-up) is re-read rather than assumed.
      refreshFromServer();
    };

    const onAgentCancelled = ({ transferId, reason }: { transferId: string; reason: string }) => {
      const state = useAppStore.getState();
      if (state.agentTransferOffer?.transferId === transferId) setAgentTransferOffer(null);
      if (state.pendingTransfer?.transferId === transferId) {
        // The server un-parks a customer it parked for the offer, so drop the
        // music to match rather than leaving them listening to it forever.
        if (state.pendingTransfer.heldForOffer) void releaseHoldAudio();
        setPendingTransfer(null);
        flash(`Transfer cancelled — ${reason}.`);
      }
    };

    const onAgentAccepted = ({ transferId }: { transferId: string; callId: string }) => {
      const state = useAppStore.getState();
      const outgoing = state.pendingTransfer;
      if (outgoing?.transferId !== transferId) return;
      if (outgoing.kind === 'BLIND') {
        // Ownership has moved and the server has already evicted us from the
        // room; wrap-up arrives on its own event.
        void releaseHoldAudio();
        setPendingTransfer(null);
        setActiveCall(null);
        return;
      }
      setPendingTransfer({ ...outgoing, accepted: true });
      flash(
        outgoing.kind === 'WARM'
          ? `${outgoing.toAgentName} accepted — complete the transfer when you are done.`
          : `${outgoing.toAgentName} joined the conference.`,
      );
    };

    const onCallState = ({ callId, state }: { callId: string; state: string }) => {
      const active = useAppStore.getState().activeCall;
      if (!active || active.callId !== callId) return;
      // Server-driven un-park (an expired transfer offer, a supervisor, the
      // other agent completing a warm handover): stop the music so the customer
      // is not left on hold audio nobody asked for.
      if (state !== 'ON_HOLD' && holdAudioRef.current) void releaseHoldAudio();
    };

    const onCallEnded = ({ callId, reason }: { callId: string; reason: string }) => {
      const active = useAppStore.getState().activeCall;
      if (!active || active.callId !== callId) return;
      void releaseHoldAudio();
      setPhase('ended');
      flash(`Call ended — ${reason}.`);
    };

    const onWrapUp = ({ callId, deadline }: { callId: string; deadline: number }) => {
      setWrapUp({ callId, deadline });
      // Put the cursor where the work is; the agent has a bounded window.
      setTimeout(() => notesRef.current?.focus(), 0);
    };

    const onSupervision = ({
      mode,
      supervisorName,
    }: {
      callId: string;
      mode: SupervisionMode | null;
      supervisorName: string | null;
    }) => {
      // MONITOR is silent by design — the agent is NOT told they are being
      // listened to. The API broadcasts supervision.changed to the whole tenant
      // (which the agent is in), so that filtering has to happen here.
      if (!mode || mode === 'MONITOR') {
        setSupervision(null);
        return;
      }
      setSupervision({ mode, supervisorName });
    };

    socket.on('transfer.offer', onOffer);
    socket.on('transfer.cancelled', onOfferCancelled);
    socket.on('transfer.bridged', onBridged);
    socket.on('predictive.call.bridged', onPredictiveBridged);
    socket.on('wrapup.finished', onWrapUpFinished);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    socket.io.on('reconnect', onConnect);
    socket.on('agent.transfer.offer', onAgentOffer);
    socket.on('agent.transfer.cancelled', onAgentCancelled);
    socket.on('agent.transfer.accepted', onAgentAccepted);
    socket.on('call.state.changed', onCallState);
    socket.on('call.ended', onCallEnded);
    socket.on('wrapup.started', onWrapUp);
    socket.on('supervision.changed', onSupervision);

    return () => {
      socket.off('transfer.offer', onOffer);
      socket.off('transfer.cancelled', onOfferCancelled);
      socket.off('transfer.bridged', onBridged);
      socket.off('predictive.call.bridged', onPredictiveBridged);
      socket.off('wrapup.finished', onWrapUpFinished);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
      socket.io.off('reconnect', onConnect);
      socket.off('agent.transfer.offer', onAgentOffer);
      socket.off('agent.transfer.cancelled', onAgentCancelled);
      socket.off('agent.transfer.accepted', onAgentAccepted);
      socket.off('call.state.changed', onCallState);
      socket.off('call.ended', onCallEnded);
      socket.off('wrapup.started', onWrapUp);
      socket.off('supervision.changed', onSupervision);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI offer countdown (server-clock corrected).
  useEffect(() => {
    if (!transferOffer) return;
    const tick = () => {
      const left = secondsUntil(transferOffer.acceptDeadline);
      setAiOfferCountdown(left);
      if (left === 0) setTransferOffer(null);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [transferOffer, setTransferOffer]);

  // Ring while any offer is waiting: a visual card alone loses most offers on
  // a floor where the agent is looking at another screen. Synthesised with
  // WebAudio so there is no asset to load, plus a title flash for a hidden tab.
  const ringing = Boolean(transferOffer || agentTransferOffer);
  useEffect(() => {
    if (!ringing) return;
    let ctx: AudioContext | null = null;
    let stopped = false;
    let ringTimer: ReturnType<typeof setInterval> | undefined;
    const originalTitle = document.title;
    let flash = false;
    const titleTimer = setInterval(() => {
      flash = !flash;
      document.title = flash ? '☎ Incoming transfer' : originalTitle;
    }, 800);
    try {
      ctx = new AudioContext();
      const burst = () => {
        if (stopped || !ctx) return;
        const now = ctx.currentTime;
        for (const [freq, at] of [[880, 0], [1040, 0.18], [880, 0.36], [1040, 0.54]] as Array<[number, number]>) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, now + at);
          gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.16);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + at);
          osc.stop(now + at + 0.18);
        }
      };
      burst();
      ringTimer = setInterval(burst, 2000);
    } catch {
      // No audio permission / no AudioContext: the card and title flash remain.
    }
    return () => {
      stopped = true;
      clearInterval(titleTimer);
      if (ringTimer) clearInterval(ringTimer);
      document.title = originalTitle;
      void ctx?.close().catch(() => undefined);
    };
  }, [ringing]);

  async function acceptAiOffer() {
    const offer = transferOffer;
    if (!offer || busy) return;
    setBusy(true);
    try {
      await api.post(`/workspace/transfers/${offer.transferId}/accept`);
      // `transfer.bridged` builds the call bar; the card stays until then.
    } catch {
      flash('That offer has expired — it was likely already offered to someone else.');
      setTransferOffer(null);
    } finally {
      setBusy(false);
    }
  }

  async function declineAiOffer() {
    const offer = transferOffer;
    if (!offer) return;
    try {
      await api.post(`/workspace/transfers/${offer.transferId}/decline`);
    } catch {
      // Already expired — nothing to decline.
    }
    setTransferOffer(null);
  }

  // Inbound agent-to-agent offer countdown, mirroring the AI transfer card.
  useEffect(() => {
    if (!agentTransferOffer) return;
    const tick = () => {
      const left = secondsUntil(agentTransferOffer.acceptDeadline);
      setOfferCountdown(left);
      if (left === 0) setAgentTransferOffer(null);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [agentTransferOffer, setAgentTransferOffer]);

  // Outbound offer countdown — the window the other agent has to answer.
  useEffect(() => {
    if (!pendingTransfer || pendingTransfer.accepted) return;
    const tick = () => setPendingCountdown(secondsUntil(pendingTransfer.acceptDeadline));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [pendingTransfer]);

  // Wrap-up: a visible countdown to the server's deadline. When it lapses the
  // SERVER returns the agent to AVAILABLE — this only re-reads what happened,
  // it never posts a presence change of its own.
  useEffect(() => {
    if (!wrapUp) return;
    const tick = () => {
      const left = secondsUntil(wrapUp.deadline);
      setWrapUpLeft(left);
      if (left > 0) return;
      setWrapUp(null);
      api
        .get('/workspace/me/shift')
        .then((r) => {
          setShift(r.data);
          setPresence(r.data.presence);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [wrapUp, setWrapUp, setShift, setPresence]);

  function enableAudio() {
    audioContainerRef.current?.querySelectorAll('audio').forEach((el) => void (el as HTMLAudioElement).play());
    setAudioBlocked(false);
  }

  function toggleMic() {
    const room = roomRef.current;
    if (!room) return;
    const next = !micMuted;
    void room.localParticipant.setMicrophoneEnabled(!next);
    setMicMuted(next);
  }

  function sendDtmf(digit: string) {
    const room = roomRef.current;
    if (!room || phase !== 'connected') return;
    void room.localParticipant.publishDtmf(DTMF_CODES[digit]!, digit).catch(() => flash('Could not send DTMF.'));
    setDtmfSent((prev) => (prev + digit).slice(-12));
  }

  async function toggleHold() {
    if (!activeCall || holdBusy) return;
    setHoldBusy(true);
    try {
      if (onHold) {
        await api.post(`/call-control/calls/${activeCall.callId}/resume`);
        await releaseHoldAudio();
      } else {
        const r = await api.post(`/call-control/calls/${activeCall.callId}/hold`);
        try {
          await engageHoldAudio(r.data.holdMusicUrl ?? null);
        } catch (audioErr) {
          // The server thinks the customer is parked but we could not produce a
          // note of music. Un-park immediately rather than leave them in silence.
          await api.post(`/call-control/calls/${activeCall.callId}/resume`).catch(() => undefined);
          throw audioErr;
        }
      }
    } catch (err) {
      flash(err instanceof Error && !('response' in err) ? err.message : errorMessage(err, 'Could not change hold.'));
    } finally {
      setHoldBusy(false);
    }
  }

  /** An offer we made was placed — the customer may now be parked by the server. */
  async function handleOffered(offered: OfferedTransfer) {
    // Mirrors CallControlService.offerAgentTransfer exactly: BLIND and WARM park
    // the customer for the accept window, CONFERENCE does not. `holdMusicUrl` is
    // null both when nothing was parked AND when no music is configured, so the
    // kind — not the URL — decides whether we start publishing music.
    const heldForOffer = offered.kind !== 'CONFERENCE' && !onHold;
    setPendingTransfer({
      transferId: offered.transferId,
      callId: activeCall?.callId ?? '',
      kind: offered.kind,
      toAgentName: offered.toAgentName,
      acceptDeadline: offered.acceptDeadline,
      accepted: false,
      heldForOffer,
    });
    if (heldForOffer) {
      try {
        await engageHoldAudio(offered.holdMusicUrl);
      } catch {
        flash('Offer sent, but hold music could not start — the customer may hear silence.');
      }
    }
  }

  async function cancelPendingTransfer() {
    if (!pendingTransfer) return;
    setBusy(true);
    try {
      await api.post(`/call-control/agent-transfers/${pendingTransfer.transferId}/cancel`);
    } catch {
      // Window already lapsed — the cancelled event will clear it either way.
    } finally {
      if (pendingTransfer.heldForOffer) await releaseHoldAudio();
      setPendingTransfer(null);
      setBusy(false);
    }
  }

  async function completeWarmTransfer() {
    if (!pendingTransfer || !activeCall) return;
    setBusy(true);
    try {
      await api.post(`/call-control/calls/${activeCall.callId}/transfer/complete`);
      await releaseHoldAudio();
      setPendingTransfer(null);
      // Ownership moved to the other agent and the server evicted us from the
      // room; the wrap-up event lands separately.
      setActiveCall(null);
    } catch (err) {
      flash(errorMessage(err, 'Could not complete the transfer.'));
    } finally {
      setBusy(false);
    }
  }

  function handleExternalTransferred(destination: string) {
    void releaseHoldAudio();
    setPhase('ended');
    flash(`Customer transferred to ${destination}. Log the call below.`);
  }

  async function acceptAgentTransfer() {
    const offer = agentTransferOffer;
    if (!offer) return;
    setBusy(true);
    try {
      const r = await api.post(`/call-control/agent-transfers/${offer.transferId}/accept`);
      // `current-call` is the only place the server-side call start time lives,
      // and the timer has to be anchored to it rather than to "now".
      const current = await api
        .get('/workspace/me/current-call')
        .then((x) => x.data as CurrentCallState | null)
        .catch(() => null);
      setActiveCall({
        callId: r.data.callId,
        source: 'transfer',
        leadName: offer.leadName,
        phone: offer.phone,
        campaignName: offer.campaignName,
        livekitUrl: r.data.livekitUrl,
        livekitToken: r.data.livekitToken,
        startedAt: current?.startedAt,
        transferCard: current?.transferCard ?? null,
        // Already bridged server-side — never re-dial.
        recovered: true,
        // `callState` is deliberately NOT passed through. On a WARM handover the
        // customer is parked by the OTHER agent, whose browser is producing the
        // music; if we engaged hold audio too we would publish music instead of
        // our microphone and the two of us could not talk at all.
      });
      setAgentTransferOffer(null);
    } catch (err) {
      flash(errorMessage(err, 'That offer has already expired.'));
      setAgentTransferOffer(null);
    } finally {
      setBusy(false);
    }
  }

  async function declineAgentTransfer() {
    const offer = agentTransferOffer;
    if (!offer) return;
    try {
      await api.post(`/call-control/agent-transfers/${offer.transferId}/decline`);
    } catch {
      // Already expired — nothing to decline.
    }
    setAgentTransferOffer(null);
  }

  async function hangUp() {
    if (!activeCall) return;
    setBusy(true);
    try {
      // One route for every source: drops the customer leg, stops the
      // recording, frees the pacing slot and starts the wrap-up clock.
      await api.post(`/call-control/calls/${activeCall.callId}/hangup`);
    } catch {
      // Line may already be down (customer hung up first) — still let the agent disposition.
    } finally {
      await releaseHoldAudio();
      roomRef.current?.disconnect();
      roomRef.current = null;
      setPhase('ended');
      setBusy(false);
    }
  }

  function chooseDisposition(value: string) {
    if (!NEEDS_SCHEDULE.has(value)) {
      void submitDisposition(value);
      return;
    }
    const suggested = new Date(Date.now() + (value === 'CALLBACK' ? 2 : 24) * 3600 * 1000);
    setPending({ value, when: localInputValue(suggested) });
  }

  async function submitDisposition(value: string, when?: string) {
    if (!activeCall) return;
    setBusy(true);
    try {
      await api.post(`/calls/${activeCall.callId}/disposition`, {
        disposition: value,
        notes: notes || undefined,
        scheduledFor: when ? new Date(when).toISOString() : undefined,
        ...(value === 'BOOKED' && when ? { durationMinutes: 60 } : {}),
      });
      await releaseHoldAudio();
      roomRef.current?.disconnect();
      roomRef.current = null;
      setActiveCall(null);
      // The server hands the agent straight back to the floor once the call is logged.
      setPresence('AVAILABLE');
      setWrapUp(null);
    } catch (err) {
      const msg = errorMessage(err, 'Could not log the disposition.');
      flash(msg);
      if (/already dispositioned/i.test(msg)) {
        // Logged from another tab: nothing left to do here.
        roomRef.current?.disconnect();
        roomRef.current = null;
        setActiveCall(null);
        setWrapUp(null);
      }
    } finally {
      setBusy(false);
    }
  }

  // The inbound offer card renders even with no active call — that is the
  // normal case for a BLIND transfer arriving at an idle agent.
  const offerCard = agentTransferOffer && (
    <div
      className="fixed bottom-4 right-4 z-[55] w-80 rounded-xl border-2 p-4 shadow-2xl"
      style={{ borderColor: 'var(--accent)', background: 'var(--surface)' }}
      role="alertdialog"
      aria-label="Incoming transfer from another agent"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>
            {agentTransferOffer.kind.toLowerCase()} transfer from {agentTransferOffer.fromAgentName}
          </p>
          <h3 className="mt-1 text-lg font-bold">{agentTransferOffer.leadName}</h3>
          <p className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>
            {agentTransferOffer.phone}
          </p>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            {agentTransferOffer.campaignName}
          </p>
        </div>
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-4 font-bold"
          style={{ borderColor: offerCountdown <= 4 ? 'var(--bad)' : 'var(--accent)' }}
          aria-label={`${offerCountdown} seconds to answer`}
        >
          {offerCountdown}
        </div>
      </div>
      {agentTransferOffer.note && (
        <p className="mt-2 rounded-lg p-2 text-sm italic" style={{ background: 'var(--surface-2)' }}>
          “{agentTransferOffer.note}”
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary flex-1 text-sm" disabled={busy} onClick={acceptAgentTransfer}>
          Accept
        </button>
        <button className="btn btn-ghost text-sm" disabled={busy} onClick={declineAgentTransfer}>
          Decline
        </button>
      </div>
    </div>
  );

  const aiOfferCard = transferOffer && (
    <div
      className="fixed bottom-4 right-4 z-[56] w-96 rounded-xl border-2 p-4 shadow-2xl"
      style={{ borderColor: 'var(--good)', background: 'var(--surface)' }}
      role="alertdialog"
      aria-label="Incoming warm transfer"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--good)' }}>
            Incoming transfer — {transferOffer.campaignName}
          </p>
          <h3 className="mt-1 text-lg font-bold">{transferOffer.name}</h3>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            {transferOffer.location} · score <span className="font-bold" style={{ color: 'var(--good)' }}>{transferOffer.score}</span>
            {transferOffer.flaggedObjection && <> · objection: {transferOffer.flaggedObjection.replace(/_/g, ' ')}</>}
          </p>
        </div>
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-4 font-bold"
          style={{ borderColor: aiOfferCountdown <= 4 ? 'var(--bad)' : 'var(--good)' }}
          aria-label={`${aiOfferCountdown} seconds to answer`}
        >
          {aiOfferCountdown}
        </div>
      </div>
      {transferOffer.facts.length > 0 && (
        <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          {transferOffer.facts.map((fact) => (
            <li key={fact.label} style={{ color: fact.confirmed ? 'var(--good)' : 'var(--text-dim)' }}>
              {fact.confirmed ? '✓' : '·'} {fact.label}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs italic" style={{ color: 'var(--text-dim)' }}>{transferOffer.suggestedOpener}</p>
      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary flex-1 text-sm" disabled={busy} onClick={acceptAiOffer}>
          Accept transfer
        </button>
        <button className="btn btn-ghost text-sm" disabled={busy} onClick={declineAiOffer}>
          Decline
        </button>
      </div>
    </div>
  );

  const reconnectStrip = reconnecting && (
    <div
      className="fixed left-1/2 top-2 z-[60] -translate-x-1/2 rounded-full px-4 py-1 text-xs font-semibold shadow"
      style={{ background: 'var(--bad)', color: '#fff' }}
      role="status"
    >
      Reconnecting to the floor… offers may be missed until this clears.
    </div>
  );

  if (!activeCall) {
    return (
      <>
        {reconnectStrip}
        {aiOfferCard}
        {offerCard}
      </>
    );
  }

  const leadName = briefing?.leadName || activeCall.leadName;
  const sourceLabel = activeCall.source === 'manual' ? 'Manual dial' : activeCall.source === 'predictive' ? 'Predictive dial' : 'Warm transfer';
  const live = phase === 'connected' || phase === 'ringing' || phase === 'dialing';

  return (
    <>
      {reconnectStrip}
      {aiOfferCard}
      {offerCard}
      {showTransfer && (
        <TransferDialog
          callId={activeCall.callId}
          onClose={() => setShowTransfer(false)}
          onOffered={(offered) => void handleOffered(offered)}
          onExternalTransferred={handleExternalTransferred}
        />
      )}
      <div
        className="fixed inset-x-0 bottom-0 z-50 border-t shadow-2xl"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {/* Collapsed strip — always visible, click to expand. This is the part
            that stays on screen while the agent works another page mid-call. */}
        <button
          className="flex w-full items-center justify-between gap-3 px-6 py-2 text-left"
          onClick={() => setExpanded((e) => !e)}
        >
          <div className="flex items-center gap-3">
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${phase !== 'connected' && phase !== 'ended' ? 'animate-pulse' : ''}`}
              style={{ background: PHASE_DOT[phase], boxShadow: `0 0 0 4px color-mix(in srgb, ${PHASE_DOT[phase]} 25%, transparent)` }}
            />
            <span className="text-sm font-bold">{leadName || 'Lead'}</span>
            {activeCall.phone && (
              <span className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{activeCall.phone}</span>
            )}
            <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
              {sourceLabel}
            </span>
            <span className="text-xs" style={{ color: PHASE_DOT[phase] }}>{PHASE_LABEL[phase]}</span>
            {onHold && (
              <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: 'var(--accent)', color: '#0b1220' }}>
                ON HOLD
              </span>
            )}
            {supervision && (
              <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: 'var(--accent-dim)', color: '#0b1220' }}>
                {supervision.mode === 'WHISPER' ? 'Coaching' : 'Supervisor on call'}
                {supervision.supervisorName ? ` · ${supervision.supervisorName}` : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {phase === 'connected' && (
              <span className="font-mono text-sm font-bold tabular-nums" style={{ color: 'var(--good)' }}>{formatDuration(elapsed)}</span>
            )}
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{expanded ? '▾ collapse' : '▴ expand'}</span>
          </div>
        </button>

        {expanded && (
          <div className="max-h-[60vh] overflow-y-auto border-t px-6 py-4" style={{ borderColor: 'var(--border)' }}>
            {message && <p className="mb-2 text-sm" style={{ color: 'var(--accent)' }}>{message}</p>}
            {error && <p className="mb-2 text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

            {audioBlocked && (
              <div className="mb-3 flex items-center justify-between rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
                <span style={{ color: 'var(--accent)' }}>Audio is connected but your browser blocked autoplay.</span>
                <button onClick={enableAudio} className="btn btn-primary text-xs">Enable audio</button>
              </div>
            )}

            {wrapUp && (
              <div
                className="mb-3 flex items-center justify-between rounded-lg border p-3 text-sm"
                style={{ borderColor: wrapUpLeft <= 15 ? 'var(--bad)' : 'var(--accent)', background: 'var(--surface-2)' }}
                role="status"
              >
                <span>
                  Wrap-up — log this call before the timer runs out. You go back to Available automatically.
                </span>
                <span
                  className="font-mono text-lg font-bold tabular-nums"
                  style={{ color: wrapUpLeft <= 15 ? 'var(--bad)' : 'var(--accent)' }}
                >
                  {formatDuration(wrapUpLeft)}
                </span>
              </div>
            )}

            {pendingTransfer && (
              <div
                className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                style={{ borderColor: 'var(--accent)', background: 'var(--surface-2)' }}
                role="status"
              >
                {pendingTransfer.accepted ? (
                  <span>
                    {pendingTransfer.toAgentName} accepted the {pendingTransfer.kind.toLowerCase()} transfer.
                    {pendingTransfer.kind === 'WARM' && (
                      <>
                        {' '}
                        The customer is parked on hold music, which is published in place of your microphone — brief{' '}
                        {pendingTransfer.toAgentName} on another channel, then complete the handover.
                      </>
                    )}
                  </span>
                ) : (
                  <span>
                    Waiting for {pendingTransfer.toAgentName} to accept — {pendingCountdown}s
                    {pendingTransfer.heldForOffer && ' · customer is on hold'}
                  </span>
                )}
                <span className="flex gap-2">
                  {pendingTransfer.accepted && pendingTransfer.kind === 'WARM' && (
                    <button className="btn btn-primary text-xs" disabled={busy} onClick={completeWarmTransfer}>
                      Complete transfer
                    </button>
                  )}
                  {!pendingTransfer.accepted && (
                    <button className="btn btn-ghost text-xs" disabled={busy} onClick={cancelPendingTransfer}>
                      Cancel offer
                    </button>
                  )}
                </span>
              </div>
            )}

            {live && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button className="btn btn-danger text-sm" disabled={busy} onClick={hangUp}>☎ Hang up</button>
                {phase === 'connected' && (
                  <>
                    <button className="btn btn-ghost text-sm" onClick={toggleMic}>{micMuted ? 'Unmute' : 'Mute'}</button>
                    <button
                      className="btn text-sm"
                      disabled={holdBusy}
                      onClick={() => void toggleHold()}
                      aria-pressed={onHold}
                      style={
                        onHold
                          ? { background: 'var(--accent)', color: '#0b1220' }
                          : { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }
                      }
                    >
                      {holdBusy ? '…' : onHold ? 'Resume customer' : 'Hold'}
                    </button>
                    <button
                      className="btn btn-ghost text-sm"
                      disabled={Boolean(pendingTransfer)}
                      onClick={() => setShowTransfer(true)}
                    >
                      Transfer…
                    </button>
                  </>
                )}
                {phase === 'connected' && (
                  <div className="flex items-center gap-1">
                    {DTMF_KEYS.map((k) => (
                      <button key={k} className="btn btn-ghost px-2 py-1 text-xs" aria-label={`Send DTMF ${k}`} onClick={() => sendDtmf(k)}>{k}</button>
                    ))}
                    {dtmfSent && <span className="ml-1 font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{dtmfSent}</span>}
                  </div>
                )}
              </div>
            )}

            {onHold && (
              <p className="mb-3 rounded-lg p-2 text-sm" style={{ background: 'var(--surface-2)', color: 'var(--accent)' }}>
                The customer is parked. They hear hold audio, not you, and you cannot hear them.
              </p>
            )}

            {phase !== 'connected' && phase !== 'ended' ? (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
                {phase === 'joining' && 'Joining the call and enabling your mic…'}
                {phase === 'dialing' && 'Ringing the carrier trunk…'}
                {phase === 'ringing' && 'Ringing the customer…'}
              </p>
            ) : (
              <>
                {/* Lead "story": AI summary + facts + rebuttals when there's an
                    AI leg behind this call; otherwise this is just quietly empty
                    rather than a wall of "no data" notices. */}
                {briefing && (briefing.summary || briefing.facts.length > 0 || briefing.rebuttals.length > 0) && (
                  <div className="mb-4 grid gap-4 md:grid-cols-2">
                    {(briefing.summary || briefing.facts.length > 0) && (
                      <div className="rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Summary</p>
                        {briefing.summary && <p>{briefing.summary}</p>}
                        {briefing.facts.length > 0 && (
                          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
                            {briefing.facts.map((fact) => (
                              <li key={fact.label} style={{ color: fact.confirmed ? 'var(--good)' : 'var(--text-dim)' }}>
                                {fact.confirmed ? '✓' : '·'} {fact.label}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    {briefing.rebuttals.length > 0 && (
                      <div className="rounded-lg p-3 text-sm" style={{ background: 'var(--surface-2)' }}>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Script &amp; rebuttals</p>
                        {briefing.objection && (
                          <p className="mb-2" style={{ color: 'var(--accent)' }}>
                            Flagged objection: <span className="font-semibold">{briefing.objection.replace(/_/g, ' ')}</span>
                          </p>
                        )}
                        <ul className="space-y-2">
                          {briefing.rebuttals.map((r) => (
                            <li
                              key={r.objection}
                              className="rounded p-2"
                              style={briefing.objection === r.objection ? { background: 'var(--surface)', border: '1px solid var(--accent)' } : undefined}
                            >
                              <p className="font-semibold capitalize">{r.objection.replace(/_/g, ' ')}</p>
                              <p style={{ color: 'var(--text-dim)' }}>{r.rebuttal}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {phase === 'ended' && !error && (
                  <p className="mb-3 text-sm" style={{ color: 'var(--text-dim)' }}>
                    Call ended — log what happened below.
                  </p>
                )}
                {phase === 'connected' && (
                  <p className="mb-3 text-sm" style={{ color: 'var(--text-dim)' }}>
                    Hang up when you are done — the outcome is logged after the call ends.
                  </p>
                )}

                <label className="sr-only" htmlFor="call-notes">Call notes</label>
                <textarea
                  id="call-notes"
                  ref={notesRef}
                  className="input mb-3 h-20"
                  placeholder="Call notes (optional)…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />

                {phase !== 'ended' ? null : pending ? (
                  <div className="rounded-lg p-4" style={{ background: 'var(--surface-2)' }}>
                    <p className="mb-2 text-sm font-semibold">
                      {pending.value === 'BOOKED' ? 'When is the appointment?' : 'When should we call back?'}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="datetime-local"
                        className="input max-w-xs"
                        aria-label={pending.value === 'BOOKED' ? 'Appointment time' : 'Callback time'}
                        value={pending.when}
                        onChange={(e) => setPending({ ...pending, when: e.target.value })}
                      />
                      <button
                        className="btn btn-primary text-sm"
                        disabled={busy || !pending.when}
                        onClick={() => submitDisposition(pending.value, pending.when)}
                      >
                        Confirm {pending.value === 'BOOKED' ? 'booking' : 'callback'}
                      </button>
                      <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {DISPOSITIONS.map(([value, label]) => (
                      <button
                        key={value}
                        className="btn btn-ghost text-sm"
                        disabled={busy}
                        onClick={() => chooseDisposition(value)}
                        style={value === 'BOOKED' ? { borderColor: 'var(--good)', color: 'var(--good)' } : undefined}
                      >
                        {label}
                        {NEEDS_SCHEDULE.has(value) && ' …'}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        <div ref={audioContainerRef} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }} />
      </div>
    </>
  );
}
