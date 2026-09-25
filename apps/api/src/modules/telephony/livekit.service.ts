import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { SupervisionMode } from '@cocally/shared';
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  SipClient,
  type ParticipantInfo,
} from 'livekit-server-sdk';
import { config } from '../../common/config';

/**
 * Media-plane primitives. One LiveKit room per Call; the customer joins as a
 * SIP participant, the AI worker and any human agents join over WebRTC.
 *
 * Everything above this file — the dialers, agent call control, supervision
 * and recording — is written against these methods rather than the SDK
 * directly, so there is one place where media-plane behaviour is reasoned
 * about and one place to change when the carrier does.
 */
@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);

  /** True when LiveKit credentials are present; callers use this to degrade gracefully. */
  isConfigured(): boolean {
    return Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);
  }

  private assertConfigured(): { url: string; apiKey: string; apiSecret: string } {
    const { url, apiKey, apiSecret } = config.livekit;
    if (!url || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException('LiveKit is not configured (LIVEKIT_URL/API_KEY/API_SECRET)');
    }
    return { url, apiKey, apiSecret };
  }

  private get roomClient(): RoomServiceClient {
    const { url, apiKey, apiSecret } = this.assertConfigured();
    return new RoomServiceClient(url, apiKey, apiSecret);
  }

  private get sipClient(): SipClient {
    const { url, apiKey, apiSecret } = this.assertConfigured();
    return new SipClient(url, apiKey, apiSecret);
  }

  private get egressClient(): EgressClient {
    const { url, apiKey, apiSecret } = this.assertConfigured();
    return new EgressClient(url, apiKey, apiSecret);
  }

  // ── Identity conventions ────────────────────────────────────────────────
  // Identities are structured so any component can derive them from a callId
  // alone, with no database round-trip. The webhook receiver in particular
  // only ever sees a room name and a participant identity.

  roomName(callId: string): string {
    return `call-${callId}`;
  }

  /** `call-<id>` → `<id>`; null when the room is not one of ours. */
  callIdFromRoom(roomName: string): string | null {
    return roomName.startsWith('call-') ? roomName.slice('call-'.length) : null;
  }

  /** The customer's SIP leg — targeted for hangup, DTMF and external transfer. */
  sipParticipantIdentity(callId: string): string {
    return `lead-${callId}`;
  }

  agentIdentity(agentId: string): string {
    return agentId;
  }

  supervisorIdentity(supervisorId: string): string {
    return `sup-${supervisorId}`;
  }

  isSupervisorIdentity(identity: string): boolean {
    return identity.startsWith('sup-');
  }

  // ── Rooms ───────────────────────────────────────────────────────────────

  /**
   * Idempotent. `createRoom`'s `metadata` only applies on first create, so it
   * is re-applied via `updateRoomMetadata` every time — the AI worker reads
   * `callId` off `ctx.room.metadata` and must find it whether the room was
   * just created or already existed.
   */
  async ensureRoom(callId: string, extraMetadata?: Record<string, unknown>): Promise<void> {
    const name = this.roomName(callId);
    const metadata = JSON.stringify({ callId, ...extraMetadata });
    try {
      await this.roomClient.createRoom({ name, metadata, emptyTimeout: 600 });
    } catch (err) {
      this.logger.warn(`createRoom(${callId}) failed (may already exist): ${(err as Error).message}`);
    }
    try {
      await this.roomClient.updateRoomMetadata(name, metadata);
    } catch (err) {
      this.logger.warn(`updateRoomMetadata(${callId}) failed: ${(err as Error).message}`);
    }
  }

  async listParticipants(callId: string): Promise<ParticipantInfo[]> {
    try {
      return await this.roomClient.listParticipants(this.roomName(callId));
    } catch {
      return [];
    }
  }

  /** True when the customer's SIP leg is still in the room. */
  async hasLiveCustomer(callId: string): Promise<boolean> {
    const target = this.sipParticipantIdentity(callId);
    return (await this.listParticipants(callId)).some((p) => p.identity === target);
  }

  async removeParticipant(callId: string, identity: string): Promise<void> {
    try {
      await this.roomClient.removeParticipant(this.roomName(callId), identity);
    } catch (err) {
      this.logger.warn(`removeParticipant(${callId}, ${identity}) failed: ${(err as Error).message}`);
    }
  }

  // ── Dialling ────────────────────────────────────────────────────────────

  /**
   * SIP response code carried on a failed `createSipParticipant`, if any.
   * The SDK surfaces it as Twirp error metadata (`sip_status_code`), and
   * older builds only in the message text.
   */
  static sipStatusFromError(err: unknown): number | undefined {
    const e = err as { metadata?: Record<string, string>; message?: string };
    const meta = e?.metadata?.['sip_status_code'] ?? e?.metadata?.['sip_status'];
    const fromMeta = meta ? Number(meta) : NaN;
    if (Number.isInteger(fromMeta) && fromMeta >= 100 && fromMeta < 700) return fromMeta;
    const m = /\b(4\d\d|5\d\d|6\d\d)\b/.exec(e?.message ?? '');
    if (m) return Number(m[1]);
    return undefined;
  }

  /**
   * Real PSTN dial-out over whichever outbound SIP trunk `LIVEKIT_SIP_TRUNK_ID`
   * points at. `from` presents the CLI the pool selected instead of the trunk
   * default.
   *
   * `waitUntilAnswered: false` so this returns as soon as the INVITE is sent —
   * ringing, answer and hangup all arrive as webhooks, which is what lets the
   * call state machine be driven by the carrier rather than guessed at.
   */
  async dialOut(
    callId: string,
    phoneNumber: string,
    options?: { from?: string; ringingTimeoutSeconds?: number; waitUntilAnswered?: boolean },
  ): Promise<{ sipCallId: string | null }> {
    if (!config.livekit.sipTrunkId) {
      throw new ServiceUnavailableException('LIVEKIT_SIP_TRUNK_ID is not configured — no outbound SIP trunk set up yet');
    }
    // Some carriers route on a tech prefix + country code + number with no
    // leading plus (e.g. 1701 61 2xxxxxxxx). Twilio takes E.164 unchanged.
    const dialTo = config.livekit.sipDialPrefix ? `${config.livekit.sipDialPrefix}${phoneNumber.replace(/^\+/, '')}` : phoneNumber;
    const info = await this.sipClient.createSipParticipant(
      config.livekit.sipTrunkId,
      dialTo,
      this.roomName(callId),
      {
        participantIdentity: this.sipParticipantIdentity(callId),
        participantName: 'Lead',
        playDialtone: true,
        fromNumber: options?.from,
        // `waitUntilAnswered: true` is the only reliable answer signal on a
        // real trunk: the `participant_joined` webhook fires while the phone
        // is still ringing, and there is no webhook for the SIP status
        // attribute changing to "active". With it, this promise resolves on
        // pickup and rejects with the SIP status (486/480/603…) on failure.
        waitUntilAnswered: options?.waitUntilAnswered ?? true,
        ringingTimeout: options?.ringingTimeoutSeconds ?? 45,
      },
    );
    return { sipCallId: info?.sipCallId ?? null };
  }

  /**
   * Blind-transfer the customer's leg off the platform to an external number
   * (the client's office, another department).
   *
   * This costs a second carrier leg for the duration and hands the customer
   * away entirely — the room is torn down afterwards.
   */
  async transferSipToExternal(callId: string, destination: string, options?: { playDialtone?: boolean }): Promise<void> {
    const transferTo =
      destination.startsWith('sip:') || destination.startsWith('tel:') ? destination : `tel:${destination}`;
    await this.sipClient.transferSipParticipant(
      this.roomName(callId),
      this.sipParticipantIdentity(callId),
      transferTo,
      { playDialtone: options?.playDialtone ?? true, ringingTimeout: 45 },
    );
  }

  /**
   * End a call: drop the SIP leg, then tear the room down. Each call gets its
   * own room, so there is never anything else in it worth preserving.
   */
  async hangup(callId: string): Promise<void> {
    const name = this.roomName(callId);
    try {
      await this.roomClient.removeParticipant(name, this.sipParticipantIdentity(callId));
    } catch (err) {
      this.logger.warn(`removeParticipant(${callId}) failed (may already be gone): ${(err as Error).message}`);
    }
    try {
      await this.roomClient.deleteRoom(name);
    } catch (err) {
      this.logger.warn(`deleteRoom(${callId}) failed (may already be gone): ${(err as Error).message}`);
    }
  }

  // ── Tokens ──────────────────────────────────────────────────────────────

  async mintToken(
    callId: string,
    identity: string,
    name: string,
    grants?: { canPublish?: boolean; canSubscribe?: boolean; hidden?: boolean },
  ): Promise<{ url: string; token: string; roomName: string }> {
    const { url, apiKey, apiSecret } = this.assertConfigured();
    const roomName = this.roomName(callId);
    const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: '2h' });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: grants?.canPublish ?? true,
      canSubscribe: grants?.canSubscribe ?? true,
      // `hidden` keeps a monitoring supervisor out of the participant list the
      // agent's UI renders, so silent monitoring is actually silent.
      hidden: grants?.hidden ?? false,
    });
    return { url, token: await at.toJwt(), roomName };
  }

  /**
   * Supervisor credentials scoped to the mode.
   *
   * MONITOR — cannot publish at all, and is hidden from the participant list.
   * WHISPER — publishes, but `applyWhisperSubscriptions` then stops the
   *           customer's SIP leg subscribing, so only the agent hears it.
   * BARGE   — publishes to everyone.
   */
  async mintSupervisorToken(
    callId: string,
    supervisorId: string,
    name: string,
    mode: SupervisionMode,
  ): Promise<{ url: string; token: string; roomName: string; identity: string }> {
    const identity = this.supervisorIdentity(supervisorId);
    const { url, token, roomName } = await this.mintToken(callId, identity, name, {
      canPublish: mode !== 'MONITOR',
      canSubscribe: true,
      hidden: mode === 'MONITOR',
    });
    return { url, token, roomName, identity };
  }

  /**
   * Whisper isolation: unsubscribe the customer's SIP leg from every track the
   * supervisor publishes, so coaching is audible to the agent only.
   *
   * Safe to call repeatedly — a supervisor's track does not exist the instant
   * they join, so the supervision service re-applies this once tracks appear.
   */
  async applyWhisperSubscriptions(callId: string, supervisorIdentity: string): Promise<void> {
    const participants = await this.listParticipants(callId);
    const supervisor = participants.find((p) => p.identity === supervisorIdentity);
    const customer = participants.find((p) => p.identity === this.sipParticipantIdentity(callId));
    if (!supervisor || !customer) return;
    const trackSids = supervisor.tracks.map((t) => t.sid);
    if (trackSids.length === 0) return;
    try {
      await this.roomClient.updateSubscriptions(this.roomName(callId), customer.identity, trackSids, false);
      this.logger.log(`whisper isolated on call ${callId}: customer unsubscribed from ${trackSids.length} track(s)`);
    } catch (err) {
      this.logger.warn(`applyWhisperSubscriptions(${callId}) failed: ${(err as Error).message}`);
    }
  }

  /** Re-subscribe the customer to the supervisor's tracks — whisper → barge. */
  async applyBargeSubscriptions(callId: string, supervisorIdentity: string): Promise<void> {
    const participants = await this.listParticipants(callId);
    const supervisor = participants.find((p) => p.identity === supervisorIdentity);
    const customer = participants.find((p) => p.identity === this.sipParticipantIdentity(callId));
    if (!supervisor || !customer) return;
    const trackSids = supervisor.tracks.map((t) => t.sid);
    if (trackSids.length === 0) return;
    try {
      await this.roomClient.updateSubscriptions(this.roomName(callId), customer.identity, trackSids, true);
    } catch (err) {
      this.logger.warn(`applyBargeSubscriptions(${callId}) failed: ${(err as Error).message}`);
    }
  }

  // ── Recording ───────────────────────────────────────────────────────────

  /**
   * Start an audio-only room-composite recording covering every leg — the AI,
   * the customer and any human agent who joins later — in one stitched file.
   *
   * Recording the *room* rather than individual tracks is what makes a warm
   * transfer produce a single continuous artefact instead of two files with a
   * gap where the handover happened.
   */
  async startRecording(callId: string, tenantId: string): Promise<{ egressId: string; uri: string } | null> {
    if (!config.recording.enabled) return null;
    const stamp = new Date().toISOString().slice(0, 10);
    const key = `${tenantId}/${stamp}/${callId}.ogg`;

    const output = new EncodedFileOutput({ fileType: EncodedFileType.OGG, filepath: key });
    const { bucket, s3Region, s3AccessKey, s3Secret, s3Endpoint } = config.recording;
    if (bucket && s3AccessKey && s3Secret) {
      output.output = {
        case: 's3',
        value: new S3Upload({
          bucket,
          region: s3Region,
          accessKey: s3AccessKey,
          secret: s3Secret,
          ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
        }),
      };
    }

    try {
      const info = await this.egressClient.startRoomCompositeEgress(this.roomName(callId), output, {
        audioOnly: true,
        layout: 'speaker',
      });
      this.logger.log(`recording started for call ${callId} (egress ${info.egressId})`);
      return { egressId: info.egressId, uri: bucket ? `s3://${bucket}/${key}` : key };
    } catch (err) {
      // A recording failure must never take the call down with it.
      this.logger.error(`startRecording(${callId}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  async stopRecording(egressId: string): Promise<void> {
    try {
      await this.egressClient.stopEgress(egressId);
    } catch (err) {
      this.logger.warn(`stopEgress(${egressId}) failed (may have already ended): ${(err as Error).message}`);
    }
  }
}
