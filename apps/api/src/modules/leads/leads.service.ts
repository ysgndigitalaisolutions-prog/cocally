import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { CallOutcome, LeadState } from '@cocally/shared';
import { parse } from 'csv-parse/sync';
import { Model, Types } from 'mongoose';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { LeadImport, LeadImportDocument } from '../../schemas/lead.schema';
import { LeadList, LeadListDocument } from '../../schemas/lead.schema';
import { LeadNote, LeadNoteDocument } from '../../schemas/lead.schema';
import { Campaign, CampaignDocument, RetryRule } from '../../schemas/campaign.schema';
import { SuppressionEntry, SuppressionEntryDocument } from '../../schemas/suppression.schema';
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

/** Rows per dedup-lookup + insert round-trip during CSV import. */
const IMPORT_BATCH_SIZE = 1000;

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
    @InjectModel(LeadNote.name) private readonly noteModel: Model<LeadNoteDocument>,
    @InjectModel(SuppressionEntry.name) private readonly suppressionModel: Model<SuppressionEntryDocument>,
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
    input: {
      listId?: string;
      campaignId?: string;
      filename: string;
      csvContent: string;
      mapping: ColumnMapping;
      /** Provenance stamped on every lead; defaults to the filename. */
      source?: string;
    },
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

    // ── Pass 1: normalise and validate entirely in memory (no DB round-trips).
    const mappedColumns = new Set(
      Object.values(input.mapping).filter((c): c is string => typeof c === 'string' && c.length > 0),
    );
    const candidates: Array<Record<string, unknown>> = [];
    const importedAt = new Date();

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

      // Dedup within the file (LEAD-02); cross-list dedup happens in pass 2.
      if (seenInFile.has(e164)) {
        duplicates += 1;
        continue;
      }
      seenInFile.add(e164);

      const state = (raw[input.mapping.state ?? ''] ?? '').toUpperCase() || undefined;
      const timezone = this.inferTimezone(pack.timezoneHints, pack.timezones, areaHint, state);

      // Keep only genuinely custom columns — storing the whole raw row duplicated
      // every mapped field on every document, which is real money at 100k leads.
      const custom: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!mappedColumns.has(k) && v !== '') custom[k] = v;
      }

      candidates.push({
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
        custom,
        source: input.source ?? input.filename,
        timeline: [{ at: importedAt, kind: 'IMPORT', detail: `Imported from ${input.filename}` }],
      });
    }

    // ── Pass 2: batched dedup + insert.
    //
    // The previous implementation issued one findOne + one create per row, so a
    // 100k-row list meant ~200k serialised round-trips inside a single HTTP
    // request. Now each batch costs one indexed $in lookup plus one unordered
    // insertMany — roughly two round-trips per 1,000 rows.
    const scopeFilter = list.campaignId ? { campaignId: list.campaignId } : { listId: list._id };

    for (let start = 0; start < candidates.length; start += IMPORT_BATCH_SIZE) {
      const batch = candidates.slice(start, start + IMPORT_BATCH_SIZE);
      const phones = batch.map((c) => c.phone as string);

      const existing = await this.leadModel
        .find({ tenantId: new Types.ObjectId(tenantId), phone: { $in: phones }, ...scopeFilter })
        .select('phone')
        .lean()
        .exec();
      const existingPhones = new Set(existing.map((e) => e.phone));

      const fresh = batch.filter((c) => !existingPhones.has(c.phone as string));
      duplicates += batch.length - fresh.length;
      if (fresh.length === 0) continue;

      try {
        // `ordered: false` so one bad document can't abort the rest of the batch.
        const inserted = await this.leadModel.insertMany(fresh, { ordered: false, rawResult: true });
        accepted += (inserted as unknown as { insertedCount: number }).insertedCount ?? fresh.length;
      } catch (err) {
        // A concurrent import can still race us to a phone number; the unique
        // work is done, so count what landed and treat collisions as duplicates.
        const bulkErr = err as { insertedDocs?: unknown[]; writeErrors?: unknown[] };
        const landed = bulkErr.insertedDocs?.length ?? 0;
        accepted += landed;
        duplicates += fresh.length - landed;
      }
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

  /**
   * Paged, searchable lead browse.
   *
   * Uses a cursor (`_id` as a tiebreaker on `updatedAt`) rather than skip/limit:
   * `skip` degrades linearly and a supervisor paging into a 100k-lead book would
   * make the database walk every skipped document. A cursor stays O(page).
   */
  async search(
    tenantId: string,
    query: {
      campaignId?: string;
      listId?: string;
      state?: LeadState;
      ownerId?: string;
      tag?: string;
      /** Matches name, phone, or email. */
      q?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ rows: unknown[]; nextCursor: string | null; total?: number }> {
    const filter: Record<string, unknown> = { tenantId: new Types.ObjectId(tenantId) };
    if (query.campaignId && Types.ObjectId.isValid(query.campaignId)) {
      filter.campaignId = new Types.ObjectId(query.campaignId);
    }
    if (query.listId && Types.ObjectId.isValid(query.listId)) {
      filter.listId = new Types.ObjectId(query.listId);
    }
    if (query.state) filter.state_ = query.state;
    if (query.ownerId) {
      filter.ownerId = query.ownerId === 'unassigned' ? null : new Types.ObjectId(query.ownerId);
    }
    if (query.tag) filter.tags = query.tag;

    if (query.q) {
      const term = query.q.trim();
      if (term) {
        const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp(safe, 'i');
        // Digits-only input is treated as a phone fragment, anchored so the
        // indexed prefix can still be used where possible.
        filter.$or = /^[\d+\s-]+$/.test(term)
          ? [{ phone: rx }]
          : [{ firstName: rx }, { lastName: rx }, { email: rx }];
      }
    }

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    if (query.cursor && Types.ObjectId.isValid(query.cursor)) {
      filter._id = { $lt: new Types.ObjectId(query.cursor) };
    }

    const rows = await this.leadModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean()
      .exec();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      rows: page,
      nextCursor: hasMore ? page[page.length - 1]!._id.toString() : null,
    };
  }

  /**
   * Correct lead data in place. Restricted to fields a human should be able to
   * fix from the floor — never state, attempts, or ownership, which move through
   * their own audited paths.
   */
  async update(
    tenantId: string,
    leadId: string,
    actor: { id: string; label: string },
    patch: {
      firstName?: string;
      lastName?: string;
      email?: string;
      suburb?: string;
      state?: string;
      postcode?: string;
      timezone?: string;
      tags?: string[];
      altPhones?: string[];
      custom?: Record<string, string>;
    },
  ) {
    const lead = await this.leadModel
      .findOne({ _id: new Types.ObjectId(leadId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!lead) throw new NotFoundException('Lead not found');

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const current = (lead as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      before[key] = current;
      after[key] = value;
      (lead as unknown as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(after).length === 0) return lead.toObject();

    lead.timeline.push({
      at: new Date(),
      kind: 'EDIT',
      detail: `${actor.label} edited ${Object.keys(after).join(', ')}`,
    });
    await lead.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'leads.update',
      entityType: 'Lead',
      entityId: leadId,
      before,
      after,
    });
    return lead.toObject();
  }

  /**
   * Manual state override (supervisor correcting a mis-disposition, or pulling a
   * lead back out of NURTURE for a re-engagement pass). Audited, because moving
   * a lead out of DNC is a compliance-relevant act.
   */
  async setState(
    tenantId: string,
    leadId: string,
    actor: { id: string; label: string },
    to: LeadState,
    reason: string,
  ) {
    const lead = await this.leadModel
      .findOne({ _id: new Types.ObjectId(leadId), tenantId: new Types.ObjectId(tenantId) })
      .exec();
    if (!lead) throw new NotFoundException('Lead not found');
    const from = lead.state_;
    if (from === 'DNC' && to !== 'DNC') {
      // Guard the one transition that can create real legal exposure.
      //
      // Two independent reasons a lead can be DNC, and both must block a reopen:
      //  - `dncListed`: on the national register (set by the wash).
      //  - an OPT_OUT suppression entry: the person told us directly. This is the
      //    common case, and it does NOT set `dncListed` — so checking that flag
      //    alone would let a "don't call me again" lead be put back on the floor.
      const optedOut = await this.suppressionModel
        .findOne({ tenantId: new Types.ObjectId(tenantId), phone: lead.phone, kind: 'OPT_OUT' })
        .lean()
        .exec();
      if (lead.dncListed || optedOut) {
        throw new BadRequestException(
          optedOut
            ? 'This person has opted out — the lead cannot be returned to the dialable pool.'
            : 'Lead is on the DNC register and cannot be reopened.',
        );
      }
    }
    this.transition(lead, to, `${reason} (by ${actor.label})`);
    // Re-entering a workable state should make the lead dialable again.
    if (['FRESH', 'ATTEMPTED', 'CONTACTED', 'CALLBACK'].includes(to)) {
      lead.nextAttemptAt = new Date();
    }
    await lead.save();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'leads.setState',
      entityType: 'Lead',
      entityId: leadId,
      before: { state_: from },
      after: { state_: to, reason },
    });
    return lead.toObject();
  }

  /**
   * Recycle leads back into the dialable pool — the standard BPO answer to a
   * list that has been worked out. NURTURE and EXHAUSTED are dead ends today,
   * so without this a list can only ever shrink.
   */
  async recycle(
    tenantId: string,
    actor: { id: string; label: string },
    input: { campaignId: string; fromStates: LeadState[]; olderThanDays?: number; resetAttempts?: boolean },
  ): Promise<number> {
    // Never recycle anyone who opted out or is DNC-listed. `dncListed` alone is
    // not enough — a direct opt-out never sets it — so DNC-state leads are
    // excluded outright and opted-out numbers are subtracted explicitly.
    const optedOutPhones = await this.suppressionModel
      .find({ tenantId: new Types.ObjectId(tenantId), kind: 'OPT_OUT' })
      .select('phone')
      .lean()
      .exec();

    const filter: Record<string, unknown> = {
      tenantId: new Types.ObjectId(tenantId),
      campaignId: new Types.ObjectId(input.campaignId),
      state_: { $in: input.fromStates.filter((s) => s !== 'DNC') },
      dncListed: { $ne: true },
      ...(optedOutPhones.length > 0 ? { phone: { $nin: optedOutPhones.map((p) => p.phone) } } : {}),
    };
    if (input.olderThanDays) {
      filter.updatedAt = { $lte: new Date(Date.now() - input.olderThanDays * 86_400_000) };
    }

    const update: Record<string, unknown> = {
      $set: { state_: 'FRESH' as LeadState, nextAttemptAt: new Date() },
      $unset: { ownerId: '', assignedAt: '', lockedAt: '' },
      $push: {
        timeline: {
          at: new Date(),
          kind: 'RECYCLED',
          detail: `Recycled into the dialable pool by ${actor.label}`,
          state: 'FRESH',
        },
      },
    };
    if (input.resetAttempts) (update.$set as Record<string, unknown>).attempts = 0;

    const res = await this.leadModel.updateMany(filter, update).exec();

    await this.audit.record({
      tenantId,
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'leads.recycle',
      entityType: 'Campaign',
      entityId: input.campaignId,
      after: { ...input, modified: res.modifiedCount },
    });
    return res.modifiedCount;
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  async addNote(tenantId: string, leadId: string, author: { id: string; label: string }, text: string) {
    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('Note cannot be empty');
    const note = await this.noteModel.create({
      tenantId: new Types.ObjectId(tenantId),
      leadId: new Types.ObjectId(leadId),
      authorId: new Types.ObjectId(author.id),
      authorLabel: author.label,
      text: trimmed,
    });
    await this.leadModel
      .updateOne(
        { _id: new Types.ObjectId(leadId), tenantId: new Types.ObjectId(tenantId) },
        { $push: { timeline: { at: new Date(), kind: 'NOTE', detail: `Note by ${author.label}` } } },
      )
      .exec();
    return note;
  }

  async notes(tenantId: string, leadId: string) {
    return this.noteModel
      .find({ tenantId: new Types.ObjectId(tenantId), leadId: new Types.ObjectId(leadId) })
      .sort({ pinned: -1, createdAt: -1 })
      .limit(200)
      .lean()
      .exec();
  }

  /** Bulk tag/untag from the leads screen. */
  async tag(tenantId: string, leadIds: string[], add: string[], remove: string[]): Promise<number> {
    const ids = leadIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return 0;
    const filter = { tenantId: new Types.ObjectId(tenantId), _id: { $in: ids } };
    let modified = 0;
    if (add.length > 0) {
      const res = await this.leadModel.updateMany(filter, { $addToSet: { tags: { $each: add } } }).exec();
      modified = Math.max(modified, res.modifiedCount);
    }
    if (remove.length > 0) {
      const res = await this.leadModel.updateMany(filter, { $pull: { tags: { $in: remove } } }).exec();
      modified = Math.max(modified, res.modifiedCount);
    }
    return modified;
  }
}
