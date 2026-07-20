/**
 * Demo-data generator: 30 days of realistic call history on top of the base
 * seed, so dashboards, analytics, heatmaps and team insights show meaningful
 * shape during a walkthrough instead of near-empty charts.
 *
 * Run:  pnpm --filter @cocally/api demo-data
 *
 * Idempotent — every document it writes carries `demoSeed: true`, and the
 * script deletes those first, so it can be re-run freely without touching the
 * base seed's tenant, users, campaign or flow.
 *
 * Two schema details this depends on (both easy to get wrong):
 *  - The funnel groups on `lead.state_` (lifecycle). `lead.state` is the
 *    geographic AU state (VIC/NSW) — a different field entirely.
 *  - The heatmap buckets on `$hour: '$startedAt'`, which Mongo evaluates in
 *    UTC. Call times are therefore generated to land in UTC business hours so
 *    the heatmap renders as a clean weekday band on screen.
 */
import 'reflect-metadata';
import mongoose, { Types } from 'mongoose';
import { config } from '../common/config';

type Db = NonNullable<typeof mongoose.connection.db>;

const DAYS = 30;
const DIALS_PER_WEEKDAY = 26;

/** Deterministic PRNG so re-runs produce the same demo, and rehearsals match the live demo. */
let seedState = 1337;
function rnd(): number {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rnd() * items.length)]!;
}
/** Weighted pick: entries are [value, weight]. */
function weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

interface DemoLead {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  campaignId: Types.ObjectId;
  clientId: Types.ObjectId;
  firstName: string;
  lastName: string;
  phone: string;
  lineType: string;
  timezone: string;
  suburb: string;
  /** Geographic AU state (VIC/NSW) — NOT the lifecycle state. */
  state: string;
  postcode: string;
  /** Lifecycle state — this is what the funnel aggregation groups on. */
  state_: string;
  attempts: number;
  timeline: Array<Record<string, unknown>>;
  customFields: Record<string, unknown>;
  demoSeed: boolean;
  createdAt: Date;
  updatedAt: Date;
}
function intBetween(lo: number, hi: number): number {
  return Math.floor(lo + rnd() * (hi - lo + 1));
}

const FIRST_NAMES = ['Sarah', 'James', 'Priya', 'Michael', 'Emma', 'David', 'Aisha', 'Tom', 'Grace', 'Daniel', 'Chloe', 'Raj', 'Hannah', 'Liam', 'Mei', 'Oliver', 'Zoe', 'Ethan', 'Ruby', 'Noah'];
const LAST_NAMES = ['Nguyen', 'Smith', 'Patel', 'Brown', 'Wilson', 'Taylor', 'Singh', 'Clarke', 'Murphy', 'Chen', 'Robinson', 'Kaur', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott'];
const SUBURBS: Array<[string, string, string]> = [
  ['Richmond', 'VIC', '3121'], ['Geelong', 'VIC', '3220'], ['Ballarat', 'VIC', '3350'],
  ['Bendigo', 'VIC', '3550'], ['Frankston', 'VIC', '3199'], ['Werribee', 'VIC', '3030'],
  ['Dandenong', 'VIC', '3175'], ['Shepparton', 'VIC', '3630'], ['Traralgon', 'VIC', '3844'],
];

/** Transcript snippets — enough to make the deep-dive readable, with redaction applied. */
function buildTranscript(connected: boolean, transferred: boolean, objection?: string) {
  if (!connected) return [];
  const lines: Array<{ leg: 'AI' | 'HUMAN'; speaker: 'ai' | 'customer' | 'agent'; text: string; redactedText: string; startMs: number; endMs: number }> = [
    { leg: 'AI', speaker: 'ai', text: "Hi, this is Ava calling from Aurora Solar. This call is recorded, and just so you know, I'm an AI assistant. Do you have a quick moment?", redactedText: "Hi, this is Ava calling from Aurora Solar. This call is recorded, and just so you know, I'm an AI assistant. Do you have a quick moment?", startMs: 0, endMs: 7000 },
    { leg: 'AI', speaker: 'customer', text: 'Yeah, alright, go on.', redactedText: 'Yeah, alright, go on.', startMs: 7200, endMs: 9000 },
    { leg: 'AI', speaker: 'ai', text: 'Great — am I right that you own the property?', redactedText: 'Great — am I right that you own the property?', startMs: 9200, endMs: 12000 },
    { leg: 'AI', speaker: 'customer', text: "Yes, we've been here about six years.", redactedText: "Yes, we've been here about six years.", startMs: 12200, endMs: 15000 },
    { leg: 'AI', speaker: 'ai', text: 'And roughly what does a quarterly electricity bill come to?', redactedText: 'And roughly what does a quarterly electricity bill come to?', startMs: 15200, endMs: 18500 },
    { leg: 'AI', speaker: 'customer', text: "It's been over nine hundred lately, which is why I picked up.", redactedText: "It's been over nine hundred lately, which is why I picked up.", startMs: 18700, endMs: 23000 },
  ];
  if (objection) {
    lines.push(
      { leg: 'AI', speaker: 'customer', text: "Look, I'm not really interested in switching right now.", redactedText: "Look, I'm not really interested in switching right now.", startMs: 23200, endMs: 26500 },
      { leg: 'AI', speaker: 'ai', text: "That's completely fair — most people we speak to say the same before they see the numbers. Can I take thirty seconds to show what the rebate covers?", redactedText: "That's completely fair — most people we speak to say the same before they see the numbers. Can I take thirty seconds to show what the rebate covers?", startMs: 26700, endMs: 33000 },
    );
  }
  if (transferred) {
    lines.push(
      { leg: 'AI', speaker: 'ai', text: "You're a great fit for the VIC rebate. Let me bring in a specialist — one moment.", redactedText: "You're a great fit for the VIC rebate. Let me bring in a specialist — one moment.", startMs: 34000, endMs: 39000 },
      { leg: 'HUMAN', speaker: 'agent', text: "Hi, it's Alex from Aurora Solar — I've got your details here. You said the bill's around nine hundred a quarter?", redactedText: "Hi, it's Alex from Aurora Solar — I've got your details here. You said the bill's around nine hundred a quarter?", startMs: 40000, endMs: 46000 },
      { leg: 'HUMAN', speaker: 'customer', text: "That's right. My number's 0412 300 062 if you need to call back.", redactedText: "That's right. My number's 04XX XXX 062 if you need to call back.", startMs: 46200, endMs: 51000 },
      { leg: 'HUMAN', speaker: 'agent', text: 'Perfect. I can get an assessor out Thursday afternoon — does two o\'clock suit?', redactedText: 'Perfect. I can get an assessor out Thursday afternoon — does two o\'clock suit?', startMs: 51200, endMs: 56000 },
    );
  }
  return lines;
}

async function main(): Promise<void> {
  await mongoose.connect(config.mongoUri);
  const db: Db = mongoose.connection.db!;

  const tenant = await db.collection('tenants').findOne({ slug: 'sunrise-connect' });
  if (!tenant) {
    console.error('Base seed not found. Run `pnpm --filter @cocally/api seed` first.');
    await mongoose.disconnect();
    process.exit(1);
  }
  const tenantId = tenant._id as Types.ObjectId;

  const campaign = await db.collection('campaigns').findOne({ tenantId });
  const client = await db.collection('clients').findOne({ tenantId });
  const flowVersion = await db.collection('flowversions').findOne({});
  if (!campaign) {
    console.error('No campaign found — run the base seed first.');
    await mongoose.disconnect();
    process.exit(1);
  }
  const campaignId = campaign._id as Types.ObjectId;
  const clientId = (client?._id ?? campaign.clientId) as Types.ObjectId;
  const flowVersionId = (flowVersion?._id ?? campaign.activeFlowVersionId) as Types.ObjectId;

  const agents = await db
    .collection('users')
    .find({ tenantId, roles: 'AGENT' })
    .toArray();
  if (agents.length === 0) {
    console.error('No AGENT users found — run the base seed first.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Objection labels taken from the campaign's own rebuttal library, so the
  // objection-intelligence panel lines up with the configured playbook.
  const rebuttals: Array<{ objection: string }> = campaign.rebuttals ?? [];
  const objectionLabels = rebuttals.length
    ? rebuttals.map((r) => r.objection)
    : ['not_interested', 'too_expensive', 'no_time', 'already_have', 'send_info'];

  console.log('Clearing previous demo data…');
  const collections = ['calls', 'transfers', 'leads', 'recordings', 'agentactivities', 'appointments', 'suppressions', 'auditlogs', 'clinumbers'];
  for (const c of collections) {
    await db.collection(c).deleteMany({ demoSeed: true });
  }

  const now = new Date();
  const leads: DemoLead[] = [];
  const calls: Record<string, unknown>[] = [];
  const transfers: Record<string, unknown>[] = [];
  const recordings: Record<string, unknown>[] = [];
  const appointments: Record<string, unknown>[] = [];
  const activities: Record<string, unknown>[] = [];
  const suppressions: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];

  // ---- CLI pool with varied health, so the CLI/answer-rate view has shape ----
  const cliNumbers = [
    { number: '+61385500110', geoRegion: 'VIC', status: 'ACTIVE', answerRate7d: 0.42, dialsToday: 128, answersToday: 54 },
    { number: '+61385500111', geoRegion: 'VIC', status: 'ACTIVE', answerRate7d: 0.38, dialsToday: 141, answersToday: 53 },
    { number: '+61385500112', geoRegion: 'VIC', status: 'ACTIVE', answerRate7d: 0.35, dialsToday: 119, answersToday: 41 },
    { number: '+61352200140', geoRegion: 'VIC', status: 'RESTING', answerRate7d: 0.11, dialsToday: 0, answersToday: 0 },
    { number: '+61354400150', geoRegion: 'VIC', status: 'QUARANTINED', answerRate7d: 0.04, dialsToday: 0, answersToday: 0 },
  ].map((c) => ({ ...c, tenantId, countryPackCode: 'AU', demoSeed: true, createdAt: now, updatedAt: now }));
  await db.collection('clinumbers').insertMany(cliNumbers);
  const activeClis = cliNumbers.filter((c) => c.status === 'ACTIVE').map((c) => c.number);

  // ---- Leads ----
  const LEAD_COUNT = 240;
  for (let i = 0; i < LEAD_COUNT; i++) {
    const [suburb, auState, postcode] = pick(SUBURBS);
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    leads.push({
      _id: new Types.ObjectId(),
      tenantId,
      campaignId,
      clientId,
      firstName: first,
      lastName: last,
      phone: `+6141${String(2000000 + i * 379).slice(0, 7)}`,
      lineType: weighted([['MOBILE', 8], ['LANDLINE', 2]] as const),
      timezone: 'Australia/Melbourne',
      suburb,
      state: auState,        // geographic
      postcode,
      state_: 'FRESH',       // lifecycle — set properly below
      attempts: 0,
      timeline: [],
      customFields: {},
      demoSeed: true,
      createdAt: new Date(now.getTime() - intBetween(1, DAYS) * 86400000),
      updatedAt: now,
    });
  }

  // ---- Calls across the last 30 days ----
  let leadCursor = 0;
  for (let d = DAYS; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86400000);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // weekdays only

    // Slight upward trend over the month so charts show improvement.
    const trend = 1 + (DAYS - d) / (DAYS * 2.5);
    const dials = Math.round(DIALS_PER_WEEKDAY * trend * (0.85 + rnd() * 0.3));

    for (let n = 0; n < dials; n++) {
      const lead = leads[leadCursor % leads.length]!;
      leadCursor++;

      // UTC business hours → clean weekday band on the heatmap.
      const hour = weighted([[9, 3], [10, 5], [11, 5], [12, 3], [13, 4], [14, 5], [15, 5], [16, 4], [17, 3], [18, 2]] as const);
      const startedAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, intBetween(0, 59), intBetween(0, 59)));

      // Connect rate is hour-dependent so the heatmap has genuine variation.
      const hourBoost = hour >= 16 ? 1.25 : hour === 12 ? 0.7 : 1;
      const amdClass = weighted([
        ['HUMAN', 40 * hourBoost],
        ['VOICEMAIL', 30],
        ['SILENCE', 12],
        ['IVR', 6],
        ['FAX', 1],
      ] as const);
      const connected = amdClass === 'HUMAN';

      const callId = new Types.ObjectId();
      const amdLatencyMs = intBetween(900, 2600);
      const answeredAt = new Date(startedAt.getTime() + intBetween(4000, 11000));

      let outcome: string;
      let disposition: string | undefined;
      let agentId: Types.ObjectId | undefined;
      let bridgedAt: Date | undefined;
      let finalScore = 0;
      let leadState = 'ATTEMPTED';
      const objections: Array<{ label: string; recovered: boolean }> = [];

      if (!connected) {
        outcome = amdClass === 'VOICEMAIL' ? 'ANSWERED_VOICEMAIL' : amdClass === 'IVR' ? 'ANSWERED_IVR' : weighted([['NO_ANSWER', 6], ['BUSY', 2], ['DISCONNECTED', 1]] as const);
        leadState = weighted([['ATTEMPTED', 7], ['NURTURE', 2], ['EXHAUSTED', 1]] as const);
      } else {
        finalScore = intBetween(12, 96);
        if (rnd() < 0.45) objections.push({ label: pick(objectionLabels), recovered: rnd() < 0.62 });

        if (rnd() < 0.04) {
          outcome = 'OPT_OUT';
          leadState = 'DNC';
          finalScore = intBetween(5, 25);
        } else if (rnd() < 0.09) {
          outcome = 'CALLBACK_REQUESTED';
          leadState = 'CALLBACK';
        } else {
          outcome = 'ANSWERED_HUMAN';
          // ~34% of human connects clear the transfer threshold.
          if (finalScore >= 62) {
            agentId = (pick(agents)._id as Types.ObjectId);
            bridgedAt = new Date(answeredAt.getTime() + intBetween(120000, 220000));
            disposition = weighted([
              ['BOOKED', 38], ['CALLBACK', 16], ['NOT_INTERESTED', 20],
              ['NOT_QUALIFIED', 14], ['FOLLOW_UP', 10], ['WRONG_NUMBER', 2],
            ] as const);
            leadState = disposition === 'BOOKED' ? 'BOOKED' : disposition === 'CALLBACK' ? 'CALLBACK' : 'TRANSFERRED';
          } else {
            leadState = finalScore >= 40 ? 'QUALIFIED' : 'CONTACTED';
          }
        }
      }

      const talkMs = connected ? intBetween(95000, 210000) + (agentId ? intBetween(180000, 480000) : 0) : intBetween(8000, 32000);
      const endedAt = new Date(answeredAt.getTime() + talkMs);
      const aiMinutes = Math.max(0.5, (bridgedAt ? bridgedAt.getTime() - answeredAt.getTime() : talkMs) / 60000);
      const humanMinutes = bridgedAt ? (endedAt.getTime() - bridgedAt.getTime()) / 60000 : 0;

      // Cost composition in cents, tracking the COGS model's per-minute rates.
      const totalMinutes = aiMinutes + humanMinutes;
      const costCents = {
        telco: Math.round(totalMinutes * 6.5 * 100) / 100,
        stt: Math.round(totalMinutes * 0.77 * 100) / 100,
        tts: Math.round(aiMinutes * 1.2 * 100) / 100,
        llm: Math.round(aiMinutes * 0.09 * 100) / 100,
      };

      const scoreHistory = connected
        ? [0, 1, 2, 3].map((i) => ({
            atMs: 15000 + i * 22000,
            score: Math.round((finalScore * (i + 1)) / 4),
            reason: ['greeting accepted', 'ownership confirmed', 'bill threshold met', 'interest confirmed'][i],
          }))
        : [];

      const complianceEvents = connected
        ? [
            { atMs: 800, kind: 'RECORDING_DISCLOSURE', detail: 'Recording disclosure played' },
            { atMs: 3200, kind: 'AI_IDENTIFICATION', detail: 'AI identity disclosed' },
            ...(outcome === 'OPT_OUT' ? [{ atMs: 41000, kind: 'OPT_OUT_DETECTED', detail: 'Do-not-call phrase detected — suppressed' }] : []),
          ]
        : [{ atMs: 0, kind: 'WINDOW_CHECK', detail: 'Within legal calling window (Australia/Melbourne)' }];

      calls.push({
        _id: callId,
        tenantId,
        campaignId,
        leadId: lead._id,
        flowVersionId,
        direction: 'OUTBOUND',
        cli: pick(activeClis),
        state: 'COMPLETED',
        amdClass,
        amdLatencyMs,
        outcome,
        ...(agentId ? { agentId } : {}),
        ...(disposition ? { disposition } : {}),
        startedAt,
        answeredAt,
        ...(bridgedAt ? { bridgedAt } : {}),
        endedAt,
        transcript: buildTranscript(connected, Boolean(agentId), objections[0]?.label),
        summary: connected
          ? `Homeowner in ${lead.suburb}. Quarterly bill ~$900, owns property, roof suitable. ${agentId ? 'Transferred to specialist.' : 'Did not reach transfer threshold.'}`
          : '',
        scoreHistory,
        finalScore,
        objections,
        complianceEvents,
        qaScore: connected
          ? {
              total: intBetween(68, 98),
              breakdown: { disclosure: intBetween(18, 20), tone: intBetween(15, 20), compliance: intBetween(18, 20), outcome: intBetween(14, 20) },
              notes: 'Auto-scored against the AU outbound rubric.',
            }
          : undefined,
        timings: {
          sttFirstPartial: intBetween(180, 420),
          ttsFirstByte: intBetween(120, 380),
          turnLatencies: Array.from({ length: intBetween(3, 9) }, () => intBetween(620, 1450)),
          ...(bridgedAt ? { transferDeadAirMs: intBetween(180, 420) } : {}),
        },
        costCents,
        providersUsed: { stt: 'deepgram', tts: 'deepgram', llm: 'gemini', telephony: 'simulation' },
        demoSeed: true,
        createdAt: startedAt,
        updatedAt: endedAt,
      });

      // Lead lifecycle state + timeline
      lead.state_ = leadState;
      lead.attempts += 1;
      lead.timeline.push({ at: startedAt, kind: 'CALL', detail: `${outcome} (score ${finalScore})`, callId: callId.toString() });

      // Recording legs
      recordings.push({
        tenantId, callId, leadId: lead._id, leg: 'AI',
        storagePath: `${tenantId}/au/${callId}/ai.ogg`, region: 'au',
        startedAt: answeredAt, endedAt: bridgedAt ?? endedAt,
        durationMs: (bridgedAt ?? endedAt).getTime() - answeredAt.getTime(),
        timelineOffsetMs: 0, legalHold: false, demoSeed: true, createdAt: endedAt, updatedAt: endedAt,
      });
      if (bridgedAt) {
        recordings.push({
          tenantId, callId, leadId: lead._id, leg: 'HUMAN',
          storagePath: `${tenantId}/au/${callId}/human.ogg`, region: 'au',
          startedAt: bridgedAt, endedAt,
          durationMs: endedAt.getTime() - bridgedAt.getTime(),
          timelineOffsetMs: bridgedAt.getTime() - answeredAt.getTime(),
          legalHold: false, demoSeed: true, createdAt: endedAt, updatedAt: endedAt,
        });
      }

      // Transfer record with a realistic cascade
      if (agentId) {
        const offeredAt = new Date(bridgedAt!.getTime() - intBetween(3000, 9000));
        const attempts: Array<Record<string, unknown>> = [];
        if (rnd() < 0.22) {
          const declined = pick(agents);
          attempts.push({
            agentId: (declined._id as Types.ObjectId).toString(),
            offeredAt: new Date(offeredAt.getTime() - 12000),
            resolvedAt: new Date(offeredAt.getTime() - 4000),
            result: rnd() < 0.5 ? 'DECLINED' : 'TIMED_OUT',
          });
        }
        attempts.push({ agentId: agentId.toString(), offeredAt, resolvedAt: bridgedAt, result: 'ACCEPTED' });
        transfers.push({
          tenantId, callId, leadId: lead._id, campaignId,
          state: 'BRIDGED', attempts, acceptedAgentId: agentId,
          bridgedAt, bridgeDeadAirMs: intBetween(180, 420),
          card: { name: `${lead.firstName} ${lead.lastName}`, location: `${lead.suburb}, ${lead.state}`, score: finalScore },
          demoSeed: true, createdAt: offeredAt, updatedAt: bridgedAt,
        });
      }

      // Appointment for booked outcomes
      if (disposition === 'BOOKED') {
        appointments.push({
          tenantId, clientId, leadId: lead._id, callId,
          startsAt: new Date(endedAt.getTime() + intBetween(1, 9) * 86400000),
          durationMinutes: 60,
          status: weighted([['BOOKED', 6], ['CONFIRMED', 3], ['COMPLETED', 2], ['NO_SHOW', 1]] as const),
          notes: 'Home assessment booked from AI-qualified transfer.',
          demoSeed: true, createdAt: endedAt, updatedAt: endedAt,
        });
      }

      if (outcome === 'OPT_OUT') {
        suppressions.push({
          tenantId, clientId, phone: lead.phone, kind: 'OPT_OUT',
          source: 'in-call opt-out phrase', demoSeed: true, createdAt: endedAt, updatedAt: endedAt,
        });
      }
    }

    // ---- Presence segments per agent per day (drives occupancy + adherence) ----
    for (const agent of agents) {
      let cursor = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9, 0, 0));
      const shiftEnd = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 17, 30, 0));
      while (cursor < shiftEnd) {
        const state = weighted([['AVAILABLE', 42], ['ON_CALL', 30], ['WRAP_UP', 14], ['BREAK', 12]] as const);
        const durationSeconds = state === 'BREAK' ? intBetween(600, 1500) : state === 'ON_CALL' ? intBetween(240, 720) : intBetween(180, 900);
        const endedAt = new Date(Math.min(cursor.getTime() + durationSeconds * 1000, shiftEnd.getTime()));
        activities.push({
          tenantId, userId: agent._id, state,
          startedAt: cursor, endedAt,
          durationSeconds: Math.round((endedAt.getTime() - cursor.getTime()) / 1000),
          demoSeed: true, createdAt: cursor, updatedAt: endedAt,
        });
        cursor = endedAt;
      }
    }
  }

  // A handful of client-supplied suppressions
  for (let i = 0; i < 12; i++) {
    suppressions.push({
      tenantId, clientId, phone: `+6141999${String(1000 + i)}`, kind: 'CLIENT_SUPPRESSION',
      source: 'Aurora Solar existing-customer list', demoSeed: true, createdAt: now, updatedAt: now,
    });
  }

  // Audit trail
  const auditActions: Array<[string, string]> = [
    ['CAMPAIGN_UPDATED', 'Campaign'], ['FLOW_PUBLISHED', 'FlowVersion'], ['USER_CREATED', 'User'],
    ['PROVIDER_UPDATED', 'Provider'], ['KILL_SWITCH_TOGGLED', 'Tenant'], ['LEAD_LIST_IMPORTED', 'Lead'],
    ['RECORDING_RAW_ACCESSED', 'Recording'], ['SUPPRESSION_ADDED', 'Suppression'],
  ];
  for (let i = 0; i < 24; i++) {
    const [action, entityType] = pick(auditActions);
    audits.push({
      tenantId,
      actorLabel: pick(['Olivia Owner', 'Andre Admin', 'Sana Supervisor', 'Quinn QA']),
      action, entityType, entityId: new Types.ObjectId().toString(),
      ip: `203.0.113.${intBetween(2, 250)}`,
      demoSeed: true,
      createdAt: new Date(now.getTime() - intBetween(1, DAYS) * 86400000),
      updatedAt: now,
    });
  }

  console.log('Inserting demo data…');
  await db.collection('leads').insertMany(leads);
  await db.collection('calls').insertMany(calls);
  if (transfers.length) await db.collection('transfers').insertMany(transfers);
  if (recordings.length) await db.collection('recordings').insertMany(recordings);
  if (appointments.length) await db.collection('appointments').insertMany(appointments);
  if (activities.length) await db.collection('agentactivities').insertMany(activities);
  if (suppressions.length) await db.collection('suppressions').insertMany(suppressions);
  if (audits.length) await db.collection('auditlogs').insertMany(audits);

  const connects = calls.filter((c) => c.amdClass === 'HUMAN').length;
  const bridged = calls.filter((c) => c.agentId).length;
  const booked = calls.filter((c) => c.disposition === 'BOOKED').length;

  console.log('');
  console.log('Demo data ready:');
  console.log(`  leads          ${leads.length}`);
  console.log(`  calls          ${calls.length}  (${connects} human connects, ${((connects / calls.length) * 100).toFixed(1)}% connect rate)`);
  console.log(`  transfers      ${bridged}`);
  console.log(`  bookings       ${booked}`);
  console.log(`  recordings     ${recordings.length}`);
  console.log(`  appointments   ${appointments.length}`);
  console.log(`  presence segs  ${activities.length}`);
  console.log(`  suppressions   ${suppressions.length}`);
  console.log(`  audit entries  ${audits.length}`);
  console.log('');
  console.log('Re-run any time — it replaces only documents tagged demoSeed:true.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
