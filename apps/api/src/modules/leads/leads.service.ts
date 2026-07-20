import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CallOutcome, LeadState } from '@cocally/shared';
import { parse } from 'csv-parse/sync';
import { Model, Types } from 'mongoose';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { LeadImport, LeadImportDocument } from '../../schemas/lead.schema';
import { LeadList, LeadListDocument } from '../../schemas/lead.schema';
import { Campaign, CampaignDocument, RetryRule } from '../../schemas/campaign.schema';
import { AuditService } from '../audit/audit.service';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { normalizePhone } from './phone.util';

export interface ColumnMapping {
  phone: string;
  firstName?: string;
  lastName?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
}

const DEFAULT_RETRY_MATRIX: RetryRule[] = [
  { outcome: 'BUSY', delayMinutes: 30, shiftTimeBand: false, maxAttempts: 5 },
  { outcome: 'NO_ANSWER', delayMinutes: 240, shiftTimeBand: true, maxAttempts: 4 },
  { outcome: 'ANSWERED_VOICEMAIL', delayMinutes: 1440, shiftTimeBand: true, maxAttempts: 3 },
  { outcome: 'DISCONNECTED', delayMinutes: 0, shiftTimeBand: false, maxAttempts: 1 },
  { outcome: 'FAILED', delayMinutes: 60, shiftTimeBand: false, maxAttempts: 3 },
];

@Injectable()
export class LeadsService {
  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(LeadList.name) private readonly listModel: Model<LeadListDocument>,
    @InjectModel(LeadImport.name) private readonly importModel: Model<LeadImportDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    private readonly packs: CountryPacksService,
    private readonly audit: AuditService,
  ) {}

  async createList(tenantId: string, input: { clientId: string; name: string; campaignId?: string; priority?: number }) {
    return this.listModel.create({
      tenantId: new Types.ObjectId(tenantId),
      clientId: new Types.ObjectId(input.clientId),
      name: input.name,
      campaignId: input.campaignId ? new Types.ObjectId(input.campaignId) : undefined,
      priority: input.priority ?? 0,
    });
  }

  async lists(tenantId: string) {
    return this.listModel.find({ tenantId: new Types.ObjectId(tenantId) }).lean().exec();
  }

  /**
   * CSV import per LEAD-01/02: forgiving parsing, E.164 normalisation,
   * dedup on import and cross-list, mobile/landline detection, timezone
   * inference, and a rejects report. Callers target a CAMPAIGN (the normal
   * path — the campaign's default list is found or created automatically)
   * or an explicit list id.
   */
  async importCsv(
    tenantId: string,
    actor: { id: string; label: string },
    input: { listId?: string; campaignId?: string; filename: string; csvContent: string; mapping: ColumnMapping },
  ) {
    let list;
    if (input.listId) {
      list = await this.listModel
        .findOne({ _id: new Types.ObjectId(input.listId), tenantId: new Types.ObjectId(tenantId) })
        .exec();
      if (!list) throw new NotFoundException('Lead list not found');
    } else if (input.campaignId) {
      const campaignObjectId = new Types.ObjectId(input.campaignId);
      const campaignDoc = await this.campaignModel.findOne({ _id: campaignObjectId, tenantId: new Types.ObjectId(tenantId) }).exec();
      if (!campaignDoc) throw new NotFoundException('Campaign not found');
      list = await this.listModel
        .findOne({ tenantId: new Types.ObjectId(tenantId), campaignId: campaignObjectId, status: 'ACTIVE' })
        .exec();
      if (!list) {
        list = await this.listModel.create({
          tenantId: new Types.ObjectId(tenantId),
          clientId: campaignDoc.clientId,
          name: `${campaignDoc.name} — leads`,
          campaignId: campaignObjectId,
          priority: 0,
        });
      }
    } else {
      throw new BadRequestException('Provide campaignId (preferred) or listId');
    }

    const campaign = list.campaignId
      ? await this.campaignModel.findById(list.campaignId).lean().exec()
      : null;
    const pack = await this.packs.getByCode(campaign?.countryPackCode ?? 'AU');

    let rows: Record<string, string>[];
    try {
      rows = parse(input.csvContent, { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      throw new BadRequestException(`CSV parse failed: ${(err as Error).message}`);
    }

    const report = await this.importModel.create({
      tenantId: new Types.ObjectId(tenantId),
      listId: list._id,
      uploadedBy: new Types.ObjectId(actor.id),
      filename: input.filename,
      total: rows.length,
    });

    const seenInFile = new Set<string>();
    let accepted = 0;
    let duplicates = 0;
    const rejects: Array<{ row: number; reason: string; raw: Record<string, string> }> = [];

    for (let i = 0; i < rows.length; i += 1) {
      const raw = rows[i]!;
      const phoneRaw = raw[input.mapping.phone] ?? '';
      const normalized = normalizePhone(phoneRaw, pack.phoneRegion);
      if (!normalized.ok) {
        rejects.push({ row: i + 1, reason: normalized.reason, raw });
        continue;
      }
      const { e164, lineType, areaHint } = normalized.value;

      if (pack.emergencyBlocklist.some((b) => e164.endsWith(b))) {
        rejects.push({ row: i + 1, reason: 'blocked number', raw });
        continue;
      }

      // Dedup within the file and cross-list within the campaign (LEAD-02).
      if (seenInFile.has(e164)) {
        duplicates += 1;
        continue;
      }
      seenInFile.add(e164);

      const existing = await this.leadModel
        .findOne({
          tenantId: new Types.ObjectId(tenantId),
          phone: e164,
          ...(list.campaignId ? { campaignId: list.campaignId } : { listId: list._id }),
        })
        .lean()
        .exec();
      if (existing) {
        duplicates += 1;
        continue;
      }

      const state = (raw[input.mapping.state ?? ''] ?? '').toUpperCase() || undefined;
      const timezone = this.inferTimezone(pack.timezoneHints, pack.timezones, areaHint, state);

      await this.leadModel.create({
        tenantId: new Types.ObjectId(tenantId),
        clientId: list.clientId,
        listId: list._id,
        campaignId: list.campaignId,
        phone: e164,
        lineType,
        firstName: raw[input.mapping.firstName ?? ''] || undefined,
        lastName: raw[input.mapping.lastName ?? ''] || undefined,
        suburb: raw[input.mapping.suburb ?? ''] || undefined,
        state,
        postcode: raw[input.mapping.postcode ?? ''] || undefined,
        timezone,
        custom: raw,
        timeline: [{ at: new Date(), kind: 'IMPORT', detail: `Imported from ${input.filename}` }],
      });
      accepted += 1;
    }

    report.accepted = accepted;
    report.duplicates = duplicates;
    report.rejected = rejects.length;
    report.rejects = rejects.slice(0, 1000);
    await report.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'leads.import',
      entityType: 'LeadImport',
      entityId: report._id.toString(),
      after: { filename: input.filename, total: rows.length, accepted, duplicates, rejected: rejects.length },
    });

    return {
      importId: report._id.toString(),
      total: rows.length,
      accepted,
      duplicates,
      rejected: rejects.length,
      rejects: rejects.slice(0, 100),
    };
  }

  /**
   * Timezone inference per LEAD-06: explicit state column wins, then
   * landline area-code hints, then the pack's first zone as fallback.
   */
  private inferTimezone(
    hints: Record<string, string>,
    zones: string[],
    areaHint: string,
    state?: string,
  ): string {
    const stateZones: Record<string, string> = {
      NSW: 'Australia/Sydney',
      ACT: 'Australia/Sydney',
      VIC: 'Australia/Melbourne',
      QLD: 'Australia/Brisbane',
      SA: 'Australia/Adelaide',
      WA: 'Australia/Perth',
      TAS: 'Australia/Hobart',
      NT: 'Australia/Darwin',
    };
    if (state && stateZones[state]) return stateZones[state]!;
    if (hints[areaHint]) return hints[areaHint]!;
    return zones[0] ?? 'UTC';
  }

  /**
   * Outcome-driven retry matrix per LEAD-04: apply the campaign's rule for
   * the call outcome, or exhaust the lead when attempts run out.
   */
  async applyOutcome(leadId: string, outcome: CallOutcome, callId: string): Promise<void> {
    const lead = await this.leadModel.findById(leadId).exec();
    if (!lead) return;

    const campaign = lead.campaignId ? await this.campaignModel.findById(lead.campaignId).lean().exec() : null;
    const matrix = campaign?.retryMatrix?.length ? campaign.retryMatrix : DEFAULT_RETRY_MATRIX;

    lead.attempts += 1;
    lead.lockedAt = undefined;
    lead.timeline.push({ at: new Date(), kind: 'CALL', detail: `Call outcome: ${outcome}`, callId });

    const terminalStates: Partial<Record<CallOutcome, LeadState>> = {
      OPT_OUT: 'DNC',
      CALLBACK_REQUESTED: 'CALLBACK',
    };
    const terminal = terminalStates[outcome];
    if (terminal) {
      this.transition(lead, terminal, `Outcome ${outcome}`);
      await lead.save();
      return;
    }

    if (outcome === 'ANSWERED_HUMAN') {
      lead.lastContactedAt = new Date();
      if (lead.state_ === 'FRESH' || lead.state_ === 'ATTEMPTED') {
        this.transition(lead, 'CONTACTED', 'Human answered');
      }
      await lead.save();
      return;
    }

    const rule = matrix.find((r) => r.outcome === outcome);
    if (!rule || lead.attempts >= rule.maxAttempts) {
      this.transition(lead, 'EXHAUSTED', rule ? 'Max attempts reached' : `No retry rule for ${outcome}`);
      await lead.save();
      return;
    }

    if (lead.state_ === 'FRESH') this.transition(lead, 'ATTEMPTED', 'First attempt made');
    let nextAt = new Date(Date.now() + rule.delayMinutes * 60 * 1000);
    if (rule.shiftTimeBand) {
      // Push into a different time band: add 4h so a morning miss retries in the afternoon.
      nextAt = new Date(nextAt.getTime() + 4 * 60 * 60 * 1000);
    }
    lead.nextAttemptAt = nextAt;
    await lead.save();
  }

  transition(lead: LeadDocument, to: LeadState, detail: string): void {
    lead.state_ = to;
    lead.timeline.push({ at: new Date(), kind: 'STATE_CHANGE', detail, state: to });
  }

  async get(tenantId: string, leadId: string) {
    const lead = await this.leadModel
      .findOne({ _id: new Types.ObjectId(leadId), tenantId: new Types.ObjectId(tenantId) })
      .lean()
      .exec();
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async listByCampaign(tenantId: string, campaignId: string, state?: LeadState, limit = 100) {
    const filter: Record<string, unknown> = {
      tenantId: new Types.ObjectId(tenantId),
      campaignId: new Types.ObjectId(campaignId),
    };
    if (state) filter.state_ = state;
    return this.leadModel.find(filter).sort({ updatedAt: -1 }).limit(Math.min(limit, 500)).lean().exec();
  }
}
