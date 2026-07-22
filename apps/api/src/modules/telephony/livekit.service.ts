import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AccessToken, RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { config } from '../../common/config';

/**
 * Media-plane glue for the browser-simulated (no-SIP) live voice demo: one
 * LiveKit room per Call, the AI worker auto-joins via its own registration
 * (no explicit dispatch needed), and this mints scoped join tokens for the
 * "lead" browser tab and the bridged human agent. See
 * claude-dev/2026-07-22-live-voice-build-progress.md.
 */
@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);

  private get roomClient(): RoomServiceClient {
    if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
      throw new ServiceUnavailableException('LiveKit is not configured (LIVEKIT_URL/API_KEY/API_SECRET)');
    }
    return new RoomServiceClient(config.livekit.url, config.livekit.apiKey, config.livekit.apiSecret);
  }

  private get sipClient(): SipClient {
    if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
      throw new ServiceUnavailableException('LiveKit is not configured (LIVEKIT_URL/API_KEY/API_SECRET)');
    }
    return new SipClient(config.livekit.url, config.livekit.apiKey, config.livekit.apiSecret);
  }

  roomName(callId: string): string {
    return `call-${callId}`;
  }

  /**
   * Idempotent. `createRoom`'s `metadata` only takes effect on first create —
   * a no-op on an already-existing room — so metadata is (re)applied via
   * `updateRoomMetadata` every time, which the worker needs to find `callId`
   * on `ctx.room.metadata` regardless of whether the room was just created or
   * already existed (e.g. re-minting a token minutes after the initial dial).
   */
  async ensureRoom(callId: string): Promise<void> {
    const name = this.roomName(callId);
    const metadata = JSON.stringify({ callId });
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

  /**
   * Real PSTN dial-out via the Twilio Elastic SIP Trunk <-> LiveKit outbound
   * trunk (`LIVEKIT_SIP_TRUNK_ID`) — the AI worker (already in the room per
   * automatic dispatch) ends up talking to a real phone instead of a browser
   * tab. On a Twilio Trial account this only succeeds for a Verified Caller ID.
   */
  async dialOut(callId: string, phoneNumber: string): Promise<void> {
    if (!config.livekit.sipTrunkId) {
      throw new ServiceUnavailableException('LIVEKIT_SIP_TRUNK_ID is not configured — no outbound SIP trunk set up yet');
    }
    await this.sipClient.createSipParticipant(config.livekit.sipTrunkId, phoneNumber, this.roomName(callId), {
      participantIdentity: `lead-${callId}`,
      participantName: 'Lead',
      playDialtone: true,
    });
  }

  async mintToken(callId: string, identity: string, name: string): Promise<{ url: string; token: string; roomName: string }> {
    if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
      throw new ServiceUnavailableException('LiveKit is not configured (LIVEKIT_URL/API_KEY/API_SECRET)');
    }
    const roomName = this.roomName(callId);
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, { identity, name, ttl: '2h' });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    return { url: config.livekit.url, token: await at.toJwt(), roomName };
  }
}
