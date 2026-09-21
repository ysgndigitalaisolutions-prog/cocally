import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { Model, Types } from 'mongoose';
import { config } from '../../common/config';
import { Campaign, CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { DncWashRecord, DncWashRecordDocument } from '../../schemas/suppression.schema';
import { CountryPacksService } from '../country-packs/country-packs.service';
import { SuppressionService } from './suppression.service';

/**
 * Per-number wash verdict returned by the register.
 *
 * Y — registered on the DNC Register. Must NOT be called.
 * N — not registered. Callable.
 * I — invalid / not a washable Australian number.
 */
export type WashStatus = 'Y' | 'N' | 'I';

/**
 * The Do Not Call Register is the *Australian* register, run by ACMA. Only
 * leads on an AU country pack are washed through it; other packs need their
 * own registry client and are deliberately left alone rather than silently
 * marked "washed" by an Australian service.
 */
const AU_PACK_CODE = 'AU';

/** Hard ceiling the service enforces regardless of DNCR_BATCH_SIZE. */
const MAX_BATCH = 500;

/**
 * Gap between batches. The register's operating guidelines ask that load be
 * spread across seconds rather than fired as a burst — a 100k-lead import
 * submitted as 500 simultaneous requests is the fastest way to get an account
 * throttled or suspended.
 */
const BATCH_PACE_MS = 1_000;

/** Per-request network timeout. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The register explicitly asks callers to wait at least 30 seconds before
 * retrying a request that timed out — retrying immediately doubles the load on
 * a service that is already struggling.
 */
const TIMEOUT_BACKOFF_MS = 30_000;

/** One retry only. Beyond that the sweep gives up and leaves the numbers unwashed (fail closed). */
const MAX_ATTEMPTS = 2;

/**
 * Cap on numbers washed per sweep run. Washing is metered — an unbounded first
 * run against a freshly imported million-lead list would burn the account's
 * entire credit balance in one pass with nobody watching.
 */
const MAX_NUMBERS_PER_SWEEP = 5_000;

interface SweepSummary {
  at: number;
  durationMs: number;
  submitted: number;
  listed: number;
  callable: number;
  invalid: number;
  errors: number;
  skippedReason?: string;
}

interface WashCandidates {
  tenantId: string;
  /** E.164 numbers with a missing or expiring wash. */
  phones: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ACMA Do Not Call Register — real-time washing web service client.
 *
 * `SuppressionService.recordWash()` has always existed and has never had a
 * caller. That single gap is why an Australian floor cannot go live: with
 * `dncEnforced` on, `checkAtDialTime` blocks EVERY number with
 * `DNC_WASH_STALE`, because no wash record is ever written. This service is
 * that caller.
 *
 * Design notes:
 *
 * - The register speaks SOAP. The envelope is built with template strings and
 *   the response scanned with a tolerant regex parser rather than pulling in
 *   an XML/SOAP dependency: the payload is three flat operations with a
 *   handful of scalar fields, and a strict parser would break the moment the
 *   register adds an element.
 * - Auth is the Account ID + passphrase carried in the request BODY, not in a
 *   header. That is unusual, and the reason the credentials appear inside the
 *   envelope below rather than as Basic auth.
 * - A wash result is valid for 30 days (the safe-harbour window). We re-wash
 *   after `config.dncr.rewashAfterDays` (default 25) so a scheduler outage has
 *   five days of slack before results start expiring under the floor.
 * - Everything fails CLOSED. If the register is unreachable, returns an
 *   unparseable body, or reports a number as invalid, NO wash record is
 *   written — the number stays blocked. Marking a number washed that was not
 *   actually washed is the one failure mode that turns a bug into a fine.
 */
@Injectable()
export class DncrWashService implements OnModuleInit {
  private readonly logger = new Logger(DncrWashService.name);

  private lastSweep: SweepSummary | null = null;
  /** Guards against a slow sweep overlapping the next tick. */
  private sweeping = false;

  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(DncWashRecord.name) private readonly dncModel: Model<DncWashRecordDocument>,
    private readonly suppression: SuppressionService,
    private readonly packs: CountryPacksService,
  ) {}

  /**
   * Say so, loudly, at startup when washing is off.
   *
   * A silent "feature disabled" here presents to the operator as "the dialer
   * is broken and nobody knows why" — every lead fails suppression with
   * DNC_WASH_STALE and the floor sits idle with no explanation anywhere.
   */
  onModuleInit(): void {
    if (!config.dncr.enabled) {
      this.logger.warn(
        'DNC washing is OFF (DNCR_ENABLED=false). Any campaign on a country pack with dnc.enforced=true ' +
          'will block EVERY dial with DNC_WASH_STALE, because no wash record can be written. ' +
          'Set DNCR_ENABLED/DNCR_ACCOUNT_ID/DNCR_PASSPHRASE before going live in AU.',
      );
      return;
    }
    if (!config.dncr.accountId || !config.dncr.passphrase) {
      this.logger.error(
        'DNCR_ENABLED=true but DNCR_ACCOUNT_ID/DNCR_PASSPHRASE are missing — washing will fail closed ' +
          'and the AU pack will block dialing.',
      );
      return;
    }
    this.logger.log(
      `DNC washing ON — endpoint=${config.dncr.endpoint} batch=${this.batchSize()} rewashAfter=${config.dncr.rewashAfterDays}d`,
    );
  }

  isEnabled(): boolean {
    return config.dncr.enabled && Boolean(config.dncr.accountId && config.dncr.passphrase);
  }

  private batchSize(): number {
    return Math.min(Math.max(1, config.dncr.batchSize), MAX_BATCH);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Wash a list of E.164 numbers.
   *
   * Returns a map keyed by the ORIGINAL E.164 string the caller passed in, so
   * callers never have to reason about the register's national number format.
   * Numbers that could not be submitted (non-AU, unparseable) and numbers the
   * register did not answer for are simply absent from the map — absent means
   * "not washed", which the suppression layer treats as blocked.
   */
  async washNumbers(phones: string[]): Promise<Map<string, WashStatus>> {
    const results = new Map<string, WashStatus>();
    if (!this.isEnabled()) {
      // Inert, not throwing: a disabled integration must not take down the
      // caller. The startup warning above already explains the consequence.
      this.logger.debug(`washNumbers() called with ${phones.length} number(s) but DNCR is disabled — no-op`);
      return results;
    }

    // Map wire number → E.164 so the response can be attributed back. A single
    // E.164 may appear twice in the input; dedupe on the wire form.
    const wireToE164 = new Map<string, string>();
    for (const phone of phones) {
      const wire = this.toWireNumber(phone);
      if (!wire) continue;
      if (!wireToE164.has(wire)) wireToE164.set(wire, phone);
    }

    const wireNumbers = [...wireToE164.keys()];
    const size = this.batchSize();
    for (let offset = 0; offset < wireNumbers.length; offset += size) {
      const batch = wireNumbers.slice(offset, offset + size);
      let batchResults: Map<string, WashStatus>;
      try {
        batchResults = await this.washBatch(batch);
      } catch (err) {
        // Fail closed: drop the batch, keep going with the rest. The numbers
        // stay unwashed and therefore stay un-dialable.
        this.logger.error(`wash batch of ${batch.length} failed: ${(err as Error).message}`);
        continue;
      }
      for (const [wire, status] of batchResults) {
        const e164 = wireToE164.get(wire);
        if (e164) results.set(e164, status);
      }
      // Spread the load: pause between batches rather than firing them all at
      // once. Skipped after the final batch so a small wash stays fast.
      if (offset + size < wireNumbers.length) await sleep(BATCH_PACE_MS);
    }

    return results;
  }

  /** Remaining wash credits on the account, or null when the register did not report one. */
  async getBalance(): Promise<{ enabled: boolean; balance: number | null }> {
    if (!this.isEnabled()) return { enabled: false, balance: null };
    const xml = await this.soapCall(
      'GetAccountBalance',
      `${this.credentialsXml()}`,
    );
    const balance = this.parseScalar(xml, ['Balance', 'AccountBalance', 'Credits', 'RemainingCredits']);
    const numeric = balance === null ? null : Number(balance);
    return { enabled: true, balance: numeric !== null && Number.isFinite(numeric) ? numeric : null };
  }

  /**
   * Fetch the results of a previously-submitted wash by submission id.
   *
   * The register answers small washes inline on `WashNumbers`, but hands back
   * a submission id for larger ones. `washBatch` uses this automatically when
   * it sees an id and no inline results.
   */
  async getWashResults(submissionId: string): Promise<Map<string, WashStatus>> {
    if (!this.isEnabled()) return new Map();
    const xml = await this.soapCall(
      'GetWashResults',
      `${this.credentialsXml()}\n      <SubmissionID>${this.escapeXml(submissionId)}</SubmissionID>`,
    );
    return this.parseWashResults(xml);
  }

  /**
   * Operator view: why is the floor idle?
   *
   * `staleNumbers` is the number that matters — if it is non-zero and the
   * sweep is not running, every one of those leads is being rejected at dial
   * time with DNC_WASH_STALE.
   */
  async status(): Promise<{
    enabled: boolean;
    endpoint: string;
    batchSize: number;
    rewashAfterDays: number;
    lastSweep: SweepSummary | null;
    staleNumbers: number;
    washedNumbers: number;
    listedNumbers: number;
  }> {
    const candidates = await this.collectCandidates();
    const staleNumbers = candidates.reduce((sum, c) => sum + c.phones.length, 0);
    const [washedNumbers, listedNumbers] = await Promise.all([
      this.dncModel.countDocuments({ countryPackCode: AU_PACK_CODE, expiresAt: { $gt: new Date() } }).exec(),
      this.dncModel
        .countDocuments({ countryPackCode: AU_PACK_CODE, listed: true, expiresAt: { $gt: new Date() } })
        .exec(),
    ]);
    return {
      enabled: this.isEnabled(),
      endpoint: config.dncr.endpoint,
      batchSize: this.batchSize(),
      rewashAfterDays: config.dncr.rewashAfterDays,
      lastSweep: this.lastSweep,
      staleNumbers,
      washedNumbers,
      listedNumbers,
    };
  }

  // ── Scheduled sweep ─────────────────────────────────────────────────────

  /**
   * Wash everything that needs it, on a loop.
   *
   * Every 15 minutes rather than daily: a wash is not just a periodic
   * refresh, it is a *precondition to dialling at all*. A list imported at
   * 9:05am must not wait until midnight before the floor can work it.
   */
  @Interval(15 * 60_000)
  async sweep(): Promise<SweepSummary> {
    const startedAt = Date.now();
    const empty = (skippedReason?: string): SweepSummary => ({
      at: startedAt,
      durationMs: Date.now() - startedAt,
      submitted: 0,
      listed: 0,
      callable: 0,
      invalid: 0,
      errors: 0,
      ...(skippedReason ? { skippedReason } : {}),
    });

    if (!this.isEnabled()) return empty('DNCR disabled');
    if (this.sweeping) {
      this.logger.warn('DNCR sweep still running from the previous tick — skipping this one');
      return empty('already running');
    }
    this.sweeping = true;

    let submitted = 0;
    let listed = 0;
    let callable = 0;
    let invalid = 0;
    let errors = 0;

    try {
      const pack = await this.packs.getByCode(AU_PACK_CODE).catch(() => null);
      // 30 days is the statutory safe-harbour; the pack owns the real number.
      const washExpiryDays = pack?.dnc?.washExpiryDays ?? 30;

      const candidates = await this.collectCandidates();
      let budget = MAX_NUMBERS_PER_SWEEP;

      for (const candidate of candidates) {
        if (budget <= 0) break;
        const phones = candidate.phones.slice(0, budget);
        budget -= phones.length;
        submitted += phones.length;

        const results = await this.washNumbers(phones);
        for (const phone of phones) {
          const status = results.get(phone);
          if (status === undefined) {
            // No answer for this number — leave it unwashed so it stays
            // blocked. Counted as an error so `status` shows the operator that
            // the register is only partially answering.
            errors += 1;
            continue;
          }
          if (status === 'I') {
            // Invalid at the register. Deliberately NOT recorded as a wash:
            // an unwashable number can never be lawfully dialled under the
            // AU pack, so it must stay blocked rather than be waved through.
            invalid += 1;
            continue;
          }
          const isListed = status === 'Y';
          if (isListed) listed += 1;
          else callable += 1;
          await this.suppression.recordWash({
            tenantId: candidate.tenantId,
            countryPackCode: AU_PACK_CODE,
            phone,
            listed: isListed,
            washExpiryDays,
          });
        }
      }

      const summary: SweepSummary = {
        at: startedAt,
        durationMs: Date.now() - startedAt,
        submitted,
        listed,
        callable,
        invalid,
        errors,
      };
      this.lastSweep = summary;
      if (submitted > 0) {
        this.logger.log(
          `DNCR sweep: washed ${submitted} number(s) — ${callable} callable, ${listed} on the register, ` +
            `${invalid} invalid, ${errors} unanswered (${summary.durationMs}ms)`,
        );
      }
      return summary;
    } catch (err) {
      this.logger.error(`DNCR sweep failed: ${(err as Error).message}`);
      const summary = { ...empty('sweep threw'), submitted, listed, callable, invalid, errors: errors + 1 };
      this.lastSweep = summary;
      return summary;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Numbers that need washing, grouped by tenant.
   *
   * "Needs washing" = attached to an ACTIVE campaign on the AU pack, in a
   * dialable lead state, and either never washed or washed longer ago than
   * `rewashAfterDays`. Leads already parked in DNC/EXHAUSTED are skipped —
   * washing a number nobody will dial burns credits for nothing.
   */
  private async collectCandidates(): Promise<WashCandidates[]> {
    const campaigns = await this.campaignModel
      .find({ status: 'ACTIVE', countryPackCode: AU_PACK_CODE }, { tenantId: 1 })
      .lean()
      .exec();
    if (campaigns.length === 0) return [];

    const byTenant = new Map<string, Types.ObjectId[]>();
    for (const campaign of campaigns) {
      const tenantId = campaign.tenantId.toString();
      const list = byTenant.get(tenantId);
      if (list) list.push(campaign._id);
      else byTenant.set(tenantId, [campaign._id]);
    }

    const cutoff = new Date(Date.now() - config.dncr.rewashAfterDays * 24 * 60 * 60 * 1000);
    const out: WashCandidates[] = [];

    for (const [tenantId, campaignIds] of byTenant) {
      const leads = await this.leadModel
        .find(
          {
            tenantId: new Types.ObjectId(tenantId),
            campaignId: { $in: campaignIds },
            state_: { $nin: ['DNC', 'EXHAUSTED'] },
          },
          { phone: 1 },
        )
        .lean()
        .exec();
      if (leads.length === 0) continue;

      const phones = [...new Set(leads.map((l) => l.phone))];
      const fresh = await this.dncModel
        .find(
          {
            tenantId: new Types.ObjectId(tenantId),
            countryPackCode: AU_PACK_CODE,
            phone: { $in: phones },
            washedAt: { $gte: cutoff },
          },
          { phone: 1 },
        )
        .lean()
        .exec();
      const freshSet = new Set(fresh.map((f) => f.phone));
      const stale = phones.filter((p) => !freshSet.has(p));
      if (stale.length > 0) out.push({ tenantId, phones: stale });
    }

    return out;
  }

  // ── SOAP plumbing ───────────────────────────────────────────────────────

  /**
   * Submit one batch. Handles both response shapes: inline results, or a
   * submission id that has to be collected with `GetWashResults`.
   */
  private async washBatch(wireNumbers: string[]): Promise<Map<string, WashStatus>> {
    const numbersXml = wireNumbers.map((n) => `        <Number>${this.escapeXml(n)}</Number>`).join('\n');
    const xml = await this.soapCall(
      'WashNumbers',
      `${this.credentialsXml()}\n      <Numbers>\n${numbersXml}\n      </Numbers>`,
    );

    const inline = this.parseWashResults(xml);
    if (inline.size > 0) return inline;

    const submissionId = this.parseScalar(xml, ['SubmissionID', 'SubmissionId', 'RequestID', 'RequestId']);
    if (!submissionId) {
      throw new Error('wash response contained neither results nor a submission id');
    }
    // Give the register a moment before collecting — an immediate poll on a
    // just-accepted submission reliably comes back empty.
    await sleep(BATCH_PACE_MS);
    return this.getWashResults(submissionId);
  }

  /** Account ID + passphrase go in the body, not in an auth header. */
  private credentialsXml(): string {
    return [
      `      <AccountID>${this.escapeXml(config.dncr.accountId ?? '')}</AccountID>`,
      `      <Passphrase>${this.escapeXml(config.dncr.passphrase ?? '')}</Passphrase>`,
    ].join('\n');
  }

  /**
   * POST one SOAP envelope.
   *
   * TLS 1.2+ is required by the register; Node 20's default minimum is already
   * TLSv1.2, so this is a matter of NOT lowering it anywhere rather than
   * raising it here.
   *
   * A timeout is retried exactly once, after a ≥30s pause, per the register's
   * own guidance. Any other failure is surfaced immediately — retrying a 401
   * or a malformed request just wastes the account's quota.
   */
  private async soapCall(operation: string, innerXml: string): Promise<string> {
    const envelope = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
      '  <soapenv:Body>',
      `    <${operation}>`,
      innerXml,
      `    </${operation}>`,
      '  </soapenv:Body>',
      '</soapenv:Envelope>',
    ].join('\n');

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(config.dncr.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: operation,
          },
          body: envelope,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`DNCR ${operation} HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        // `Error` is included because ColdFusion services routinely report
        // application errors in a 200 body, but a benign `<Error>0</Error>`
        // must not be mistaken for one.
        const fault = this.parseScalar(text, ['faultstring', 'ErrorMessage', 'ErrorDescription', 'Error']);
        if (fault && !['0', 'false', 'none', 'ok'].includes(fault.toLowerCase())) {
          throw new Error(`DNCR ${operation} fault: ${fault}`);
        }
        return text;
      } catch (err) {
        lastError = err as Error;
        const aborted = controller.signal.aborted;
        if (!aborted || attempt === MAX_ATTEMPTS) break;
        this.logger.warn(
          `DNCR ${operation} timed out after ${REQUEST_TIMEOUT_MS}ms — waiting ${TIMEOUT_BACKOFF_MS}ms before retry`,
        );
        await sleep(TIMEOUT_BACKOFF_MS);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ServiceUnavailableException(lastError?.message ?? `DNCR ${operation} failed`);
  }

  // ── Number formats ──────────────────────────────────────────────────────

  /**
   * E.164 → the national format the register expects (`0412345678`).
   *
   * Returns null for anything that is not a valid Australian number: the DNCR
   * only knows about AU numbers, and submitting a foreign number wastes a
   * credit to be told it is invalid.
   */
  private toWireNumber(e164: string): string | null {
    const parsed = parsePhoneNumberFromString(e164, 'AU');
    if (!parsed || !parsed.isValid() || parsed.country !== 'AU') return null;
    return `0${parsed.nationalNumber}`;
  }

  /**
   * Reduce whatever the register echoed back to the same national form we sent.
   *
   * The service normally returns the number exactly as submitted, but has been
   * observed reformatting (spaces, `+61`). Attributing a verdict to the wrong
   * key — or to no key — silently drops a wash result, which under fail-closed
   * semantics means the lead stays blocked forever, so it is worth
   * normalising both sides rather than trusting the echo.
   */
  private canonicalNumber(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.startsWith('61') && digits.length === 11) return `0${digits.slice(2)}`;
    if (digits.length === 9) return `0${digits}`;
    return digits;
  }

  // ── XML ─────────────────────────────────────────────────────────────────

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private unescapeXml(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /**
   * Flatten the response into an ordered stream of `[localName, value]` leaf
   * elements, namespace prefixes stripped.
   *
   * Everything below is built on this rather than on a DOM because the shape
   * of the register's response wrappers (`WashNumbersResult`, `NumberResult`,
   * `ArrayOfNumberResult`, …) is not worth encoding — the only thing that
   * matters is the order in which numbers and statuses appear.
   */
  private leaves(xml: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const pattern = /<(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?\1>/g;
    let match = pattern.exec(xml);
    while (match !== null) {
      const name = match[1];
      const value = match[2];
      if (name !== undefined && value !== undefined) out.push([name, this.unescapeXml(value).trim()]);
      match = pattern.exec(xml);
    }
    return out;
  }

  /** First value of any of `names` (case-insensitive), or null. */
  private parseScalar(xml: string, names: string[]): string | null {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    for (const [name, value] of this.leaves(xml)) {
      if (wanted.has(name.toLowerCase()) && value !== '') return value;
    }
    return null;
  }

  /**
   * Pair each number element with the status element that follows it.
   *
   * The register returns one record per number; whether the wrapper is called
   * `NumberResult`, `WashResult` or something else, the number always precedes
   * its verdict. Pairing positionally is therefore both simpler and more
   * robust than matching on a wrapper name that may change.
   */
  private parseWashResults(xml: string): Map<string, WashStatus> {
    const NUMBER_NAMES = new Set(['number', 'phonenumber', 'telephone', 'telephonenumber', 'msn']);
    const STATUS_NAMES = new Set(['status', 'result', 'washresult', 'registrationstatus', 'registered', 'washstatus']);

    const results = new Map<string, WashStatus>();
    let pendingNumber: string | null = null;

    for (const [name, value] of this.leaves(xml)) {
      const lower = name.toLowerCase();
      if (NUMBER_NAMES.has(lower)) {
        pendingNumber = this.canonicalNumber(value);
        continue;
      }
      if (!STATUS_NAMES.has(lower) || pendingNumber === null) continue;
      const status = this.toWashStatus(value);
      if (status) results.set(pendingNumber, status);
      pendingNumber = null;
    }

    return results;
  }

  /**
   * Anything not recognisably Y/N is treated as invalid rather than callable.
   * An unknown verdict must never resolve to "safe to call".
   */
  private toWashStatus(raw: string): WashStatus | null {
    const value = raw.trim().toUpperCase();
    if (value === '') return null;
    if (value === 'Y' || value === 'YES' || value === 'TRUE' || value === 'REGISTERED') return 'Y';
    if (value === 'N' || value === 'NO' || value === 'FALSE' || value === 'NOTREGISTERED') return 'N';
    return 'I';
  }
}
