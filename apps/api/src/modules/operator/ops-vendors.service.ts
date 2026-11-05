import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { RoomServiceClient } from 'livekit-server-sdk';
import { Model } from 'mongoose';
import { config } from '../../common/config';
import { Call, CallDocument } from '../../schemas/call.schema';
import { Lead, LeadDocument } from '../../schemas/lead.schema';
import { billingFailureVendor, vendorStatus, type VendorId, type VendorStatus } from './vendor-signals';

export interface VendorRow {
  id: VendorId;
  name: string;
  usedFor: string;
  status: VendorStatus;
  /** true = key accepted, false = rejected, null = no way to check. */
  keyOk: boolean | null;
  keyDetail: string;
  /** Why no balance is shown. No vendor gives us one with today's keys. */
  balance: string;
  /** Login that owns it, when we can prove it. Null means not confirmed. */
  account: string | null;
  lastUsedAt: string | null;
  billingFailures24h: number;
  billingFailures7d: number;
  carrierFailures24h: number;
  lastFailure: string | null;
  billingUrl: string | null;
}

const DAY = 86_400_000;
const CACHE_MS = 5 * 60_000;

const VENDORS: Array<{ id: VendorId; name: string; usedFor: string; balance: string; account: string | null; billingUrl: string | null }> = [
  { id: 'google', name: 'Google Cloud', usedFor: 'Server, Gemini AI, recordings', balance: 'Our server has no billing access', account: 'ysgndigitalaisolutions@gmail.com', billingUrl: 'https://console.cloud.google.com/billing/01E15E-A27387-92236C' },
  { id: 'atlas', name: 'MongoDB Atlas', usedFor: 'Main database', balance: 'No key for its billing', account: null, billingUrl: 'https://cloud.mongodb.com' },
  { id: 'livekit', name: 'LiveKit', usedFor: 'Call rooms and phone connection', balance: 'No balance API', account: null, billingUrl: 'https://cloud.livekit.io' },
  { id: 'telvoq', name: 'Telvoq', usedFor: 'Australian phone route', balance: 'No API; ask Telvoq', account: 'WhatsApp contact', billingUrl: null },
  { id: 'twilio', name: 'Twilio', usedFor: 'Indian test calls', balance: 'No Twilio key on our server', account: null, billingUrl: 'https://console.twilio.com' },
  { id: 'deepgram', name: 'Deepgram', usedFor: 'Speech-to-text, last-resort voice', balance: 'Our key has no billing permission', account: 'ysgndigitalaisolutions@gmail.com', billingUrl: 'https://console.deepgram.com' },
  { id: 'cartesia', name: 'Cartesia', usedFor: 'Main voice (Arlo)', balance: 'No balance API', account: null, billingUrl: 'https://play.cartesia.ai' },
  { id: 'elevenlabs', name: 'ElevenLabs', usedFor: 'Backup voice', balance: 'Our key has no billing permission', account: null, billingUrl: 'https://elevenlabs.io/app/subscription' },
  { id: 'cerebras', name: 'Cerebras', usedFor: 'Backup AI, summaries', balance: 'No balance API', account: null, billingUrl: 'https://cloud.cerebras.ai' },
  { id: 'groq', name: 'Groq', usedFor: 'Backup AI', balance: 'No balance API', account: null, billingUrl: 'https://console.groq.com/settings/billing' },
  { id: 'github', name: 'GitHub', usedFor: 'Code and deploys', balance: 'No key for its billing', account: 'Organisation ysgndigitalaisolutions-prog', billingUrl: 'https://github.com/settings/billing' },
];

/**
 * What we can prove about each paid vendor: is the key accepted, did it work on
 * a real call, and did a real call fail for a billing reason. A working key does
 * not prove credit remains; only the failure counts can show that.
 */
@Injectable()
export class OpsVendorsService {
  private readonly logger = new Logger(OpsVendorsService.name);
  private cache: { at: number; rows: VendorRow[] } | null = null;

  constructor(
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
  ) {}

  async list(): Promise<VendorRow[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rows;
    const [keys, signals] = await Promise.all([this.checkKeys(), this.callSignals()]);
    const rows = VENDORS.map((v) => {
      const key = keys[v.id] ?? { ok: null, detail: 'No way to check' };
      const s = signals[v.id];
      return {
        ...v,
        keyOk: key.ok,
        keyDetail: key.detail,
        status: vendorStatus({ keyOk: key.ok, ...s }),
        lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
        billingFailures24h: s.billingFailures24h,
        billingFailures7d: s.billingFailures7d,
        carrierFailures24h: s.carrierFailures24h,
        lastFailure: s.lastFailure,
      };
    });
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  private async checkKeys(): Promise<Partial<Record<VendorId, { ok: boolean | null; detail: string }>>> {
    const env = process.env;
    const probe = async (url: string, headers: Record<string, string>, key?: string) => {
      if (!key) return { ok: null, detail: 'No key set' };
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (r.ok) return { ok: true, detail: 'Key accepted' };
        // A restricted key is still a live key: this one is only barred from this read.
        if ((await r.text()).includes('missing_permissions')) return { ok: true, detail: 'Key accepted' };
        if (r.status === 401 || r.status === 402 || r.status === 403) return { ok: false, detail: `Rejected (${r.status})` };
        return { ok: null, detail: `Could not check (${r.status})` };
      } catch {
        return { ok: null, detail: 'Could not reach it' };
      }
    };
    const livekit = async () => {
      const { url, apiKey, apiSecret } = config.livekit;
      if (!url || !apiKey || !apiSecret) return { ok: null, detail: 'No key set' };
      try {
        await new RoomServiceClient(url.replace('wss://', 'https://'), apiKey, apiSecret).listRooms();
        return { ok: true, detail: 'Key accepted' };
      } catch (e) {
        this.logger.warn(`livekit key check failed: ${(e as Error).message}`);
        return { ok: false, detail: 'Rejected or unreachable' };
      }
    };
    const atlas = async () => {
      try {
        await this.callModel.db.db?.admin().ping();
        return { ok: true, detail: 'Database answering' };
      } catch {
        return { ok: false, detail: 'Database not answering' };
      }
    };
    const [deepgram, cartesia, elevenlabs, cerebras, groq, lk, db] = await Promise.all([
      probe('https://api.deepgram.com/v1/projects', { Authorization: `Token ${env.DEEPGRAM_API_KEY}` }, env.DEEPGRAM_API_KEY),
      probe('https://api.cartesia.ai/voices?limit=1', { 'X-API-Key': env.CARTESIA_API_KEY ?? '', 'Cartesia-Version': '2025-04-16' }, env.CARTESIA_API_KEY),
      probe('https://api.elevenlabs.io/v1/models', { 'xi-api-key': env.ELEVENLABS_API_KEY ?? '' }, env.ELEVENLABS_API_KEY),
      probe('https://api.cerebras.ai/v1/models', { Authorization: `Bearer ${env.CEREBRAS_API_KEY}` }, env.CEREBRAS_API_KEY),
      probe('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${env.GROQ_API_KEY}` }, env.GROQ_API_KEY),
      livekit(),
      atlas(),
    ]);
    return { deepgram, cartesia, elevenlabs, cerebras, groq, livekit: lk, atlas: db };
  }

  /** Billing failures and last good use, read from real calls of the past 7 days. */
  private async callSignals() {
    const now = Date.now();
    const blank = () => ({ billingFailures24h: 0, billingFailures7d: 0, carrierFailures24h: 0, lastFailure: null as string | null, lastUsedAt: null as Date | null });
    const out = Object.fromEntries(VENDORS.map((v) => [v.id, blank()])) as Record<VendorId, ReturnType<typeof blank>>;
    const calls = await this.callModel
      .find({ startedAt: { $gte: new Date(now - 7 * DAY) } })
      .select('leadId startedAt answeredAt sipStatusCode timings.turns.llmServed timings.turns.ttsServed timings.turns.stt timings.workerLog')
      .sort({ startedAt: -1 })
      .limit(500)
      .lean()
      .exec();
    // Telvoq carries only +61 numbers, so a 503 or an answer on any other number says nothing about it.
    const leadIds = [...new Set(calls.map((c) => c.leadId))];
    const auLeads = new Set(
      (await this.leadModel.find({ _id: { $in: leadIds }, phone: /^\+61/ }).select('_id').lean().exec()).map((l) => l._id.toString()),
    );
    const used = (id: VendorId, at: Date) => {
      if (!out[id].lastUsedAt || at > out[id].lastUsedAt!) out[id].lastUsedAt = at;
    };
    const fail = (id: VendorId, at: Date, text: string) => {
      const o = out[id];
      if (now - at.getTime() < DAY) o.billingFailures24h += 1;
      o.billingFailures7d += 1;
      o.lastFailure ??= text.slice(0, 160);
    };
    for (const call of calls) {
      const at = call.startedAt;
      const t = (call.timings ?? {}) as { turns?: Array<{ llmServed?: string; ttsServed?: string; stt?: number }>; workerLog?: Array<{ detail?: string }> };
      for (const turn of t.turns ?? []) {
        const served = `${turn.llmServed ?? ''} ${turn.ttsServed ?? ''}`.toLowerCase();
        if (served.includes('vertex')) used('google', at);
        if (served.includes('cerebras')) used('cerebras', at);
        if (served.includes('groq')) used('groq', at);
        if (served.includes('cartesia')) used('cartesia', at);
        if (served.includes('elevenlabs')) used('elevenlabs', at);
        if (typeof turn.stt === 'number') used('deepgram', at);
      }
      const onTelvoq = auLeads.has(call.leadId.toString());
      if (call.answeredAt) used('livekit', at);
      if (call.answeredAt) used(onTelvoq ? 'telvoq' : 'twilio', at);
      for (const line of t.workerLog ?? []) {
        const vendor = billingFailureVendor(line.detail ?? '');
        if (vendor && vendor !== 'unknown') fail(vendor, at, line.detail ?? '');
      }
      if (call.sipStatusCode === 402 && onTelvoq) fail('telvoq', at, 'The phone route answered 402 Payment Required');
      if (call.sipStatusCode === 503 && onTelvoq && now - at.getTime() < DAY) out.telvoq.carrierFailures24h += 1;
    }
    return out;
  }
}
