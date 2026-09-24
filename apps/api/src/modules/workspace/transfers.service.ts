import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { TransferCard } from '@cocally/shared';
import { Model, Types } from 'mongoose';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { Transfer, TransferDocument } from '../../schemas/transfer.schema';
import { PresenceService } from './presence.service';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Transfer orchestration per XFER-01..05: eligibility pool, pre-reservation,
 * accept-window cascade, summary-card delivery, bridge. A hot lead never
 * hears an abandoned queue — every path resolves to BRIDGED or a fallback.
 */
@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  /** In-flight accept deadlines: transferId → resolve fn of the pending offer. */
  private readonly pendingOffers = new Map<string, { resolve: (accepted: boolean) => void; agentId: string }>();

  /** Transfers declined during their accept window, consumed by the cascade loop. */
  private readonly declinedOffers = new Set<string>();

  constructor(
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    private readonly presence: PresenceService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * Run the full transfer per XFER-02/04: select agent → reserve → offer
   * with countdown card → on accept, bridge; on decline/timeout, cascade to
   * the next eligible agent; when the pool is empty, resolve NO_AGENT so the
   * flow can fall back (book/schedule per XFER-03).
   */
  async requestTransfer(input: {
    callId: string;
    whisperEnabled: boolean;
    acceptWindowSeconds: number;
    /** Facts captured so far in this conversation (not yet persisted on the lead in simulation). */
    facts?: Record<string, unknown>;
  }): Promise<'BRIDGED' | 'NO_AGENT' | 'FAILED'> {
    const call = await this.callModel.findById(input.callId).exec();
    if (!call) return 'FAILED';
    const [lead, campaign] = await Promise.all([
      this.leadModel.findById(call.leadId).exec(),
      this.campaignModel.findById(call.campaignId).lean().exec(),
    ]);
    if (!lead || !campaign) return 'FAILED';

    const transfer = await this.transferModel.create({
      tenantId: call.tenantId,
      callId: call._id,
      leadId: lead._id,
      campaignId: call.campaignId,
      state: 'RESERVED',
      whisperText: input.whisperEnabled ? this.buildWhisper(call, lead) : undefined,
    });

    const excludeIds: string[] = [];
    const handoffStarted = Date.now();

    // Cascade per XFER-04: bounded by pool size.
    for (let hop = 0; hop < 10; hop += 1) {
      const agent = await this.presence.selectAgent({
        tenantId: call.tenantId.toString(),
        campaignId: call.campaignId.toString(),
        strategy: campaign.routingStrategy,
        excludeIds,
        stickyAgentId: lead.preferredAgentId?.toString(),
      });
      if (!agent) break;

      const reserved = await this.presence.reserve(agent._id);
      if (!reserved) {
        excludeIds.push(agent._id.toString());
        continue;
      }

      const card = this.buildCard(transfer._id.toString(), call, lead, campaign.name, input.acceptWindowSeconds, input.facts);
      transfer.state = 'OFFERED';
      transfer.attempts.push({ agentId: agent._id.toString(), offeredAt: new Date(), result: 'PENDING' });
      transfer.card = card as unknown as Record<string, unknown>;
      await transfer.save();

      this.gateway.offerTransfer(agent._id.toString(), card);

      const accepted = await this.waitForAccept(transfer._id.toString(), agent._id.toString(), input.acceptWindowSeconds * 1000);

      const attempt = transfer.attempts[transfer.attempts.length - 1];
      if (attempt) {
        attempt.resolvedAt = new Date();
        const declined = this.declinedOffers.delete(transfer._id.toString());
        attempt.result = accepted ? 'ACCEPTED' : declined ? 'DECLINED' : 'TIMED_OUT';
        // attempts is a Mixed array — deep mutations must be flagged to persist.
        transfer.markModified('attempts');
      }

      if (accepted) {
        // The customer may have hung up inside the accept window (live path:
        // CallProgressService already finalised the call). Bridging must be a
        // conditional write against a still-live call, otherwise the accept
        // resurrects a COMPLETED call, pins the agent ON_CALL in an empty
        // room and the record shows as live forever.
        const bridgedAt = new Date();
        const deadAirMs = Date.now() - handoffStarted;
        const bridgedCall = await this.callModel
          .findOneAndUpdate(
            { _id: call._id, state: { $in: ['TRANSFER_PENDING', 'IN_CONVERSATION', 'ON_HOLD', 'AMD_CLASSIFYING'] } },
            { $set: { agentId: agent._id, state: 'BRIDGED', bridgedAt, 'timings.transferDeadAirMs': deadAirMs } },
            { new: true },
          )
          .exec();
        if (!bridgedCall) {
          this.logger.warn(`transfer ${transfer._id} accepted by ${agent.name} but call ${call._id} is no longer live`);
          transfer.state = 'FALLBACK';
          await transfer.save();
          await this.presence.release(agent._id.toString());
          this.gateway.cancelTransferOffer(agent._id.toString(), transfer._id.toString(), 'the customer hung up');
          return 'FAILED';
        }
        transfer.state = 'BRIDGED';
        transfer.acceptedAgentId = agent._id;
        transfer.bridgedAt = bridgedAt;
        transfer.bridgeDeadAirMs = deadAirMs;
        await transfer.save();

        await this.presence.markOnCall(agent._id.toString());
        // Keep the caller's in-memory document in step with what was committed.
        call.agentId = agent._id;
        call.state = 'BRIDGED';
        call.bridgedAt = bridgedAt;
        call.timings.transferDeadAirMs = deadAirMs;

        // Sticky preference for future callbacks per XFER-01. The lead-state
        // transition lives here so the live (worker) path records TRANSFERRED
        // exactly like the simulation path does.
        lead.preferredAgentId = agent._id;
        lead.state_ = 'TRANSFERRED';
        lead.lastContactedAt = new Date();
        lead.timeline.push({ at: new Date(), kind: 'TRANSFER', detail: `Bridged to agent ${agent.name}`, callId: call._id.toString() });
        await lead.save();

        this.gateway.emitToUser(agent._id.toString(), 'transfer.bridged', {
          transferId: transfer._id.toString(),
          callId: call._id.toString(),
        });
        return 'BRIDGED';
      }

      // Release the reserved agent back to the pool and cascade.
      await this.presence.release(agent._id.toString());
      this.gateway.cancelTransferOffer(
        agent._id.toString(),
        transfer._id.toString(),
        attempt?.result === 'DECLINED' ? 'declined' : 'offer window elapsed',
      );
      excludeIds.push(agent._id.toString());
      await transfer.save();
    }

    transfer.state = 'FALLBACK';
    await transfer.save();
    return 'NO_AGENT';
  }

  private waitForAccept(transferId: string, agentId: string, windowMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOffers.delete(transferId);
        resolve(false);
      }, windowMs);
      this.pendingOffers.set(transferId, {
        agentId,
        resolve: (accepted) => {
          clearTimeout(timer);
          this.pendingOffers.delete(transferId);
          resolve(accepted);
        },
      });
    });
  }

  /**
   * The call ended while an offer was still out (customer hung up during the
   * accept window): resolve it as not accepted so the cascade stops and the
   * reserved agent is released, and take the card off their screen.
   */
  async cancelOffersForCall(callId: string, reason: string): Promise<void> {
    for (const [transferId, pending] of this.pendingOffers) {
      const transfer = await this.transferModel.findById(transferId).select('callId').lean().exec();
      if (transfer?.callId?.toString() !== callId) continue;
      this.gateway.cancelTransferOffer(pending.agentId, transferId, reason);
      pending.resolve(false);
    }
  }

  /**
   * The offer currently waiting on this agent, if any — so a reloaded browser
   * can re-render the card instead of sitting RESERVED with nothing to click.
   */
  async pendingOfferFor(agentId: string): Promise<TransferCard | null> {
    for (const [transferId, pending] of this.pendingOffers) {
      if (pending.agentId !== agentId) continue;
      const transfer = await this.transferModel.findById(transferId).select('card').lean().exec();
      return (transfer?.card as unknown as TransferCard) ?? null;
    }
    return null;
  }

  /** Agent one-click accept per WS-03. */
  async accept(transferId: string, agentId: string): Promise<{ ok: boolean }> {
    const pending = this.pendingOffers.get(transferId);
    if (!pending || pending.agentId !== agentId) throw new NotFoundException('Offer no longer active');
    pending.resolve(true);
    return { ok: true };
  }

  async decline(transferId: string, agentId: string): Promise<{ ok: boolean }> {
    const pending = this.pendingOffers.get(transferId);
    if (!pending || pending.agentId !== agentId) throw new NotFoundException('Offer no longer active');
    // The cascade loop owns the transfer doc; writing here from a second doc
    // instance would be overwritten by its next save. Flag the decline instead.
    this.declinedOffers.add(transferId);
    pending.resolve(false);
    return { ok: true };
  }

  /** Summary card per XFER-05 rendered from incrementally-built call state (PAL-11 — zero added dead air). */
  private buildCard(
    transferId: string,
    call: CallDocument,
    lead: LeadDocument,
    campaignName: string,
    acceptWindowSeconds: number,
    liveFacts?: Record<string, unknown>,
  ): TransferCard {
    const factLabels: Record<string, string> = {
      owner: 'Owns home',
      noPanels: 'No existing panels',
      billHigh: 'High power bill',
      dwellingHouse: 'House (not unit)',
      roofSuitable: 'Roof suitable',
      appointmentInterest: 'Wants appointment',
    };
    const merged = { ...(lead.facts ?? {}), ...(liveFacts ?? {}) };
    const facts = Object.entries(merged).map(([key, value]) => ({
      label: factLabels[key] ?? key,
      value: String(value),
      confirmed: Boolean(value),
    }));
    const openObjection = call.objections.find((o) => !o.recovered)?.label ?? null;

    return {
      transferId,
      leadId: lead._id.toString(),
      callId: call._id.toString(),
      campaignId: call.campaignId.toString(),
      campaignName,
      name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unknown',
      location: [lead.suburb, lead.state].filter(Boolean).join(', ') || 'Unknown',
      score: call.finalScore,
      facts,
      flaggedObjection: openObjection,
      proposedAppointment: (merged['appointmentSlot'] as string) ?? null,
      suggestedOpener: this.buildOpener(lead, openObjection, merged),
      acceptDeadline: Date.now() + acceptWindowSeconds * 1000,
    };
  }

  /**
   * A natural first line for the agent to say on bridge. Deliberately NOT the
   * raw summary blob (name/score/facts already render structurally on the card);
   * it reflects the lead's context — an open objection or appointment intent.
   */
  private buildOpener(lead: LeadDocument, openObjection: string | null, facts?: Record<string, unknown>): string {
    const name = lead.firstName ?? 'there';
    if (openObjection) {
      return `Hi ${name}, thanks for holding — I know you mentioned ${openObjection.replace(/_/g, ' ')}, let me help sort that out.`;
    }
    if ((facts ?? lead.facts)?.['appointmentInterest']) {
      return `Hi ${name}, thanks for holding — I understand you're keen on a free solar assessment. Let me lock in a time that suits you.`;
    }
    return `Hi ${name}, thanks for chatting with our assistant — let me confirm a couple of details and see how we can help.`;
  }

  private buildWhisper(call: CallDocument, lead: LeadDocument): string {
    // 2-second whisper per XFER-05: name, suburb, score.
    return `${lead.firstName ?? 'Lead'} from ${lead.suburb ?? 'unknown'}, score ${call.finalScore}.`;
  }
}
