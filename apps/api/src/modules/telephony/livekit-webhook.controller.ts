import { Controller, Headers, HttpCode, Logger, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import { config } from '../../common/config';
import { Public } from '../../common/auth/public.decorator';
import { CallProgressService } from './call-progress.service';
import { LivekitService } from './livekit.service';

/**
 * Participant attributes LiveKit SIP may carry the final response code on.
 * See the matching list in `CallProgressService` for why there is more than one.
 */
const SIP_STATUS_ATTRIBUTES = [
  'sip.callStatusCode',
  'sip.statusCode',
  'sip.responseCode',
  'sip.h.x-status-code',
] as const;

/**
 * The missing subscriber.
 *
 * Nothing in the codebase listened to LiveKit, so on a real trunk a call went
 * out and then... nothing. It stayed RINGING forever: no answer, no hangup, no
 * outcome, no retry-matrix decision, no CLI health. Every live-call state
 * transition after the INVITE originates here.
 *
 * Design rules, all of them about not making a bad night worse:
 *  - `@Public()`, because LiveKit has no CoCally credentials. Authenticity is
 *    proven instead by verifying the signed `Authorization` JWT with the
 *    LiveKit SDK's own receiver, which hashes the exact request body — so this
 *    endpoint is unauthenticated but not unauthenticated-and-trusting.
 *  - Always 200, always fast. A non-2xx makes LiveKit retry, and a handler
 *    that throws on a poison event turns one bad call into a retry storm.
 *  - Unknown rooms are ignored silently: the same LiveKit project may host
 *    rooms that are none of our business.
 */
@Public()
@Controller('telephony/livekit')
export class LivekitWebhookController {
  private readonly logger = new Logger(LivekitWebhookController.name);
  private receiver: WebhookReceiver | null = null;

  constructor(
    private readonly livekit: LivekitService,
    private readonly progress: CallProgressService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('authorization') authorization?: string,
  ): Promise<{ received: boolean }> {
    const receiver = this.getReceiver();
    if (!receiver) {
      this.logger.warn('LiveKit webhook received but LIVEKIT_API_KEY/SECRET are not configured — ignoring.');
      return { received: false };
    }

    // The signature is over the exact bytes LiveKit sent, so a re-serialised
    // `req.body` will not verify. `rawBody` requires the app to be created
    // with `{ rawBody: true }` (see main.ts) — the fallback keeps the endpoint
    // functional but is logged, because it will fail verification.
    const raw = req.rawBody;
    if (!raw) {
      this.logger.warn(
        'LiveKit webhook has no raw body — NestFactory.create needs `{ rawBody: true }`; signature verification will fail.',
      );
    }
    const body = raw ? raw.toString('utf8') : JSON.stringify(req.body ?? {});

    let event: WebhookEvent;
    try {
      event = await receiver.receive(body, authorization);
    } catch (err) {
      // Do NOT 4xx: a rejected signature is either a misconfiguration or an
      // intruder, and in both cases retrying is pointless.
      this.logger.warn(`rejected LiveKit webhook: ${(err as Error).message}`);
      return { received: false };
    }

    const roomName = event.room?.name;
    const callId = roomName ? this.livekit.callIdFromRoom(roomName) : null;
    if (!callId) return { received: true };

    try {
      await this.dispatch(event, callId);
    } catch (err) {
      // Swallowed on purpose — see the class comment. The call is left for the
      // `room_finished` safety net rather than being retried into a loop.
      this.logger.error(`LiveKit webhook "${event.event}" for call ${callId} failed: ${(err as Error).message}`);
    }
    return { received: true };
  }

  private async dispatch(event: WebhookEvent, callId: string): Promise<void> {
    switch (event.event) {
      case 'participant_joined': {
        const identity = event.participant?.identity;
        if (identity) await this.progress.onParticipantJoined(callId, identity);
        return;
      }
      case 'participant_left': {
        const participant = event.participant;
        if (!participant?.identity) return;
        await this.progress.onParticipantLeft(
          callId,
          participant.identity,
          participant.disconnectReason,
          this.sipStatus(participant.attributes),
        );
        return;
      }
      case 'room_finished':
        await this.progress.onRoomFinished(callId);
        return;
      case 'egress_ended': {
        const info = event.egressInfo;
        if (!info?.egressId) return;
        // Room-composite egress reports one entry per output file. `location`
        // is the resolved destination (the S3 URL when an upload is
        // configured); `filename` is the local path fallback.
        const file = info.fileResults[0];
        await this.progress.onEgressEnded(callId, info.egressId, file?.location || file?.filename);
        return;
      }
      case 'track_published':
        // Needed by supervision (whisper isolation has to be re-applied once a
        // supervisor's track actually exists). Logged only for now so the
        // event stream is visible while that lands.
        this.logger.debug(
          `track_published on call ${callId} by ${event.participant?.identity ?? 'unknown'} (${event.track?.sid ?? '-'})`,
        );
        return;
      default:
        return;
    }
  }

  /** First attribute that parses as a plausible SIP response code. */
  private sipStatus(attributes: Record<string, string> | undefined): number | undefined {
    if (!attributes) return undefined;
    for (const key of SIP_STATUS_ATTRIBUTES) {
      const raw = attributes[key];
      if (raw === undefined) continue;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 100 && parsed < 700) return parsed;
    }
    return undefined;
  }

  /** Built lazily so the API still boots with LiveKit unconfigured (dev, tests). */
  private getReceiver(): WebhookReceiver | null {
    if (this.receiver) return this.receiver;
    const { apiKey, apiSecret } = config.livekit;
    if (!apiKey || !apiSecret) return null;
    this.receiver = new WebhookReceiver(apiKey, apiSecret);
    return this.receiver;
  }
}
