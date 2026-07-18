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

      const card = this.buildCard(transfer._id.toString(), call, lead, campaign.name, input.acceptWindowSeconds);
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
        transfer.state = 'BRIDGED';
        transfer.acceptedAgentId = agent._id;
        transfer.bridgedAt = new Date();
        transfer.bridgeDeadAirMs = Date.now() - handoffStarted;
        await transfer.save();

        await this.presence.markOnCall(agent._id.toString());
        call.agentId = agent._id;
        call.state = 'BRIDGED';
        call.bridgedAt = new Date();
        call.timings.transferDeadAirMs = transfer.bridgeDeadAirMs;
        await call.save();

        // Sticky preference for future callbacks per XFER-01.
        lead.preferredAgentId = agent._id;
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
      this.gateway.cancelTransferOffer(agent._id.toString(), transfer._id.toString(), 'offer window elapsed');
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
  ): TransferCard {
    const factLabels: Record<string, string> = {
      owner: 'Owns home',
      noPanels: 'No existing panels',
      billHigh: 'High power bill',
      dwellingHouse: 'House (not unit)',
      roofSuitable: 'Roof suitable',
      appointmentInterest: 'Wants appointment',
    };
    const facts = Object.entries(lead.facts ?? {}).map(([key, value]) => ({
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
      proposedAppointment: (lead.facts?.['appointmentSlot'] as string) ?? null,
      suggestedOpener: call.summary
        ? `Opener: pick up from — ${call.summary.slice(0, 140)}`
        : `Hi ${lead.firstName ?? 'there'}, thanks for chatting with our assistant — let's sort the details.`,
      acceptDeadline: Date.now() + acceptWindowSeconds * 1000,
    };
  }

  private buildWhisper(call: CallDocument, lead: LeadDocument): string {
    // 2-second whisper per XFER-05: name, suburb, score.
    return `${lead.firstName ?? 'Lead'} from ${lead.suburb ?? 'unknown'}, score ${call.finalScore}.`;
  }
}
