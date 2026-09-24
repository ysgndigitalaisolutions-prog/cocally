import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { LIVE_CALL_STATES } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { Call, CallDocument } from '../../schemas/call.schema';
import { CampaignDocument } from '../../schemas/campaign.schema';
import { LeadDocument } from '../../schemas/lead.schema';
import { RealtimeGateway } from '../workspace/realtime.gateway';
import { LivekitService } from './livekit.service';

/**
 * What a live placement can report back synchronously.
 *
 * `answered` is deliberately always `false` here — see `placeCall`. `callId`
 * is returned so the caller can correlate the asynchronous progress that
 * follows, and so a dial-out failure can be finalised against the right
 * record instead of leaking a DIALING row and a locked lead.
 */
export interface LivePlacementResult {
  answered: boolean;
  callId: string;
}

export interface LivePlacementOptions {
  /** Flow version whose brief the Python worker will fetch for this call. */
  flowVersionId?: Types.ObjectId | null;
  /**
   * Invoked the instant the Call document exists, before any media-plane I/O.
   *
   * The orchestrator uses this to learn the callId even when the dial-out
   * throws — without it a trunk failure would leave the Call stuck in DIALING
   * and the lead locked, because the caller would have nothing to finalise.
   */
  onCallCreated?: (callId: string) => void;
  /** The customer picked up (the awaited INVITE resolved). */
  onAnswered?: (callId: string) => Promise<void> | void;
  /** The INVITE ended without an answer: busy, no answer, rejected, invalid… */
  onDialFailed?: (callId: string, sipStatus: number | undefined, detail: string) => Promise<void> | void;
}

interface LiveCallEntry {
  campaignId: string;
  tenantId: string;
  leadId: string;
}

/**
 * Places a REAL outbound AI call over the carrier trunk.
 *
 * This is the driver that was missing: `CallOrchestratorService.placeCall`
 * unconditionally constructed `SimulationRuntime`, so `config.telephonyDriver`
 * was parsed and never read and the auto-dialer placed exactly zero real
 * calls. `LivekitService.dialOut()` — the only SIP INVITE in the codebase —
 * was reachable only from the manual dialer.
 *
 * Note what this driver does NOT do: it does not run the flow-graph executor.
 * On a live call the conversation is run by the Python LiveKit Agents worker
 * (`agent-worker/agent.py`), which auto-joins the room, reads `callId` off the
 * room metadata, fetches its brief from `GET /engine/calls/:id/brief`, streams
 * turns back to `POST /engine/calls/:id/transcript` and asks for a transfer via
 * `POST /engine/calls/:id/transfer`. Duplicating the turn loop here would give
 * two independent conversation engines on one call.
 *
 * So this driver's whole job is the *setup* half of a call — room, recording,
 * INVITE — and then getting out of the way. Everything after the INVITE
 * arrives as a LiveKit webhook and is handled by `CallProgressService`.
 */
@Injectable()
export class LiveCallDriver implements OnModuleInit {
  private readonly logger = new Logger(LiveCallDriver.name);

  /**
   * Live calls currently in flight, keyed by callId.
   *
   * The simulation path can track concurrency with a `try/finally` around an
   * awaited conversation, because the call is over when `placeCall` returns.
   * A live call is only just *starting* when `placeCall` returns, so the
   * registry has to outlive the call, and is cleared by `release()` when
   * `CallProgressService` finalises the call. Without this, pacing and the
   * channel cap would both read zero and the dialer would dial without limit.
   */
  private readonly liveCalls = new Map<string, LiveCallEntry>();

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    private readonly livekit: LivekitService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * Rebuild the in-flight registry after a restart so pacing does not read
   * zero (and over-dial to twice the channel cap) while calls placed by the
   * previous process are still live. Whatever really ended in the meantime is
   * released by the terminal webhook or the hung-call sweep as usual.
   */
  async onModuleInit(): Promise<void> {
    const since = new Date(Date.now() - 2 * 60 * 60_000);
    const live = await this.callModel
      .find({ state: { $in: [...LIVE_CALL_STATES] }, manual: { $ne: true }, agentId: null, startedAt: { $gte: since } })
      .select('_id campaignId tenantId leadId')
      .lean()
      .exec();
    for (const c of live) {
      this.liveCalls.set(c._id.toString(), {
        campaignId: c.campaignId.toString(),
        tenantId: c.tenantId.toString(),
        leadId: c.leadId.toString(),
      });
    }
    if (live.length > 0) this.logger.warn(`restored ${live.length} live call(s) into the pacing registry after restart`);
  }

  activeCount(campaignId: string): number {
    return [...this.liveCalls.values()].filter((c) => c.campaignId === campaignId).length;
  }

  totalActiveForTenant(tenantId: string): number {
    return [...this.liveCalls.values()].filter((c) => c.tenantId === tenantId).length;
  }

  /**
   * Stop counting this call against pacing and drop its floor card.
   *
   * Called by `CallProgressService` from the terminal webhook. It is safe to
   * call for a call this driver never placed (a manual dial, a replayed
   * webhook) — the map lookup simply misses.
   */
  release(callId: string): void {
    const entry = this.liveCalls.get(callId);
    if (!entry) return;
    this.liveCalls.delete(callId);
    this.gateway.removeFloorCall(entry.tenantId, callId);
  }

  /**
   * Create the Call, open the room, start recording, send the INVITE.
   *
   * The return shape matches the simulation path so the orchestrator can
   * branch without the callers noticing — but `answered` is ALWAYS `false`
   * here, and that is not a bug. On a real trunk nothing is known about the
   * outcome at INVITE time: the call has not even rung yet. The customer's
   * `participant_joined` webhook is the answer signal, and
   * `CallProgressService` is what records CLI health from it (rather than the
   * dialer hardcoding `recordDial(cli, true)`, which is what starved the
   * answer-rate heuristics of real data in the first place).
   *
   * Callers on the live path must therefore NOT feed this `answered` into
   * `CliService.recordDial` — see the guard in `DialerService.dialCampaign`.
   */
  async placeCall(
    campaign: CampaignDocument,
    lead: LeadDocument,
    cli: string | undefined,
    options?: LivePlacementOptions,
  ): Promise<LivePlacementResult> {
    const tenantId = campaign.tenantId.toString();
    const campaignId = campaign._id.toString();

    const call = await this.callModel.create({
      tenantId: campaign.tenantId,
      campaignId: campaign._id,
      leadId: lead._id,
      ...(options?.flowVersionId ? { flowVersionId: options.flowVersionId } : {}),
      cli,
      state: 'DIALING',
      startedAt: new Date(),
    });
    const callId = call._id.toString();
    this.liveCalls.set(callId, { campaignId, tenantId, leadId: lead._id.toString() });
    options?.onCallCreated?.(callId);

    try {
      // The worker reads `callId` off room metadata to fetch its brief; the
      // rest is there so a room can be identified from the media plane alone
      // when debugging a live floor.
      await this.livekit.ensureRoom(callId, {
        campaignId,
        tenantId,
        leadId: lead._id.toString(),
        campaignName: campaign.name,
      });

      // Recording is started before the INVITE so nothing at the head of the
      // conversation is lost. A brand-new room with no publishers can refuse
      // egress on some deployments; `startRecording` swallows that and returns
      // null, and `CallProgressService.onParticipantJoined` retries once the
      // customer is actually in the room. A recording failure must never take
      // the call down with it.
      const recording = await this.livekit.startRecording(callId, tenantId);
      if (recording) {
        call.recordingEgressId = recording.egressId;
        call.recordingUri = recording.uri;
      }

      call.state = 'RINGING';
      await call.save();
      // The INVITE is awaited until answered (or refused) in the background —
      // see LivekitService.dialOut. Answer/failure is reported through the
      // callbacks so CallProgressService owns the state machine either way.
      void this.livekit
        .dialOut(callId, lead.phone, { from: cli })
        .then(async ({ sipCallId }) => {
          if (sipCallId) await this.callModel.updateOne({ _id: call._id }, { sipCallId }).exec();
          await options?.onAnswered?.(callId);
        })
        .catch(async (err: Error) => {
          const status = LivekitService.sipStatusFromError(err);
          this.logger.warn(`live dial ${callId} not answered: ${err.message} (sip ${status ?? 'n/a'})`);
          await options?.onDialFailed?.(callId, status, err.message);
        });

      this.gateway.updateFloorCall(tenantId, {
        callId,
        leadId: lead._id.toString(),
        campaignId,
        leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.phone,
        state: 'RINGING',
        currentStage: 'dialing',
        score: lead.score,
        startedAt: call.startedAt.getTime(),
        claimable: false,
      });
      this.gateway.emitToTenant(tenantId, 'call.state.changed', { callId, state: 'RINGING' });

      this.logger.log(`live dial: ${lead.phone} via ${cli ?? 'trunk default'} (call ${callId})`);

      // Progress arrives by webhook from here — see LivekitWebhookController.
      return { answered: false, callId };
    } catch (err) {
      // Leave the registry entry in place: the orchestrator finalises through
      // CallProgressService, which is what calls `release()`. Clearing it here
      // would race the finaliser and drop the floor card twice.
      this.logger.error(`live dial failed for call ${callId}: ${(err as Error).message}`);
      throw err;
    }
  }
}
