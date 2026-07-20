/**
 * Dev/pilot seed: tenant, users for every role, client, AU campaign with a
 * published solar qualification flow, CLI pool, and a small washed lead list.
 * Run: pnpm --filter @cocally/api seed
 */
import 'reflect-metadata';
import * as argon2 from 'argon2';
import mongoose, { Types } from 'mongoose';
import { DEFAULT_SCORING_CONFIG } from '@cocally/shared';
import { config } from '../common/config';
import { AU_PACK } from '../modules/country-packs/au.pack';

/**
 * Short demo logins (`admin` / `agent`, password `1234`) for walkthroughs where
 * typing full addresses is friction. Idempotent, so it also tops up a database
 * that was seeded before these existed.
 *
 * Skipped when NODE_ENV=production — these credentials must never exist in a
 * real environment. The full-strength accounts above are the real ones.
 */
type Db = NonNullable<typeof mongoose.connection.db>;

async function seedDemoLogins(db: Db, tenantId: Types.ObjectId): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.log('Skipping short demo logins (NODE_ENV=production).');
    return;
  }
  const now = new Date();
  const demoHash = await argon2.hash('1234');
  const demoUsers: Array<[string, string, string[]]> = [
    ['admin', 'Demo Admin', ['ADMIN']],
    ['agent', 'Demo Agent', ['AGENT']],
  ];
  for (const [email, name, userRoles] of demoUsers) {
    await db.collection('users').updateOne(
      { tenantId, email },
      {
        $set: { name, passwordHash: demoHash, roles: userRoles, active: true, updatedAt: now },
        $setOnInsert: {
          tenantId,
          email,
          skills: [],
          languages: ['en'],
          presence: 'OFFLINE',
          talkTimeTodaySeconds: 0,
          adminIpAllowlist: [],
          totpEnabled: false,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }
  console.log('Demo logins ready: admin / 1234  ·  agent / 1234');
}

async function main(): Promise<void> {
  await mongoose.connect(config.mongoUri);
  const db = mongoose.connection.db!;

  const existing = await db.collection('tenants').findOne({ slug: 'sunrise-connect' });
  if (existing) {
    console.log('Seed already applied (tenant sunrise-connect exists).');
    await seedDemoLogins(db, existing._id as Types.ObjectId);
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  const passwordHash = await argon2.hash('CoCally!Pilot2026');

  const tenantId = new Types.ObjectId();
  await db.collection('tenants').insertOne({
    _id: tenantId,
    name: 'Sunrise Connect (Pilot)',
    slug: 'sunrise-connect',
    region: 'au',
    branding: {},
    retentionDays: 365,
    dailyDialQuota: 0,
    paused: false,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.collection('countrypacks').updateOne({ code: 'AU' }, { $setOnInsert: { ...AU_PACK, createdAt: now, updatedAt: now } }, { upsert: true });

  const clientId = new Types.ObjectId();
  await db.collection('clients').insertOne({
    _id: clientId,
    tenantId,
    name: 'Aurora Solar Retail',
    branding: {},
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  const roles: Array<[string, string, string[]]> = [
    ['owner@cocally.dev', 'Olivia Owner', ['OWNER']],
    ['admin@cocally.dev', 'Andre Admin', ['ADMIN']],
    ['supervisor@cocally.dev', 'Sana Supervisor', ['SUPERVISOR']],
    ['agent1@cocally.dev', 'Alex Agent', ['AGENT']],
    ['agent2@cocally.dev', 'Amelia Agent', ['AGENT']],
    ['qa@cocally.dev', 'Quinn QA', ['QA']],
  ];
  await db.collection('users').insertMany(
    roles.map(([email, name, userRoles]) => ({
      tenantId,
      email,
      name,
      passwordHash,
      roles: userRoles,
      skills: [],
      languages: ['en'],
      presence: 'OFFLINE',
      talkTimeTodaySeconds: 0,
      adminIpAllowlist: [],
      totpEnabled: false,
      active: true,
      createdAt: now,
      updatedAt: now,
    })),
  );

  const cliIds = [new Types.ObjectId(), new Types.ObjectId()];
  await db.collection('clinumbers').insertMany([
    {
      _id: cliIds[0],
      tenantId,
      number: '+61390001000',
      geoRegion: 'VIC',
      countryPackCode: 'AU',
      status: 'ACTIVE',
      dialsToday: 0,
      answersToday: 0,
      answerRate7d: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: cliIds[1],
      tenantId,
      number: '+61280001000',
      geoRegion: 'NSW',
      countryPackCode: 'AU',
      status: 'ACTIVE',
      dialsToday: 0,
      answersToday: 0,
      answerRate7d: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Published AU solar qualification flow with mandatory disclosure node (AI-08).
  const flowId = new Types.ObjectId();
  await db.collection('flows').insertOne({
    _id: flowId,
    tenantId,
    name: 'AU Solar Qualification v1',
    direction: 'OUTBOUND',
    isTemplate: false,
    createdAt: now,
    updatedAt: now,
  });

  const graph = {
    entryNodeId: 'amd',
    nodes: [
      { id: 'amd', type: 'AMD_CLASSIFY', mandatory: false, config: {} },
      {
        id: 'disclosure',
        type: 'SPEAK',
        mandatory: true,
        config: {
          text: "Hi {{firstName}}, I'm an AI assistant calling on behalf of Aurora Solar. This call may be recorded for quality purposes.",
          interruptible: false,
        },
      },
      {
        id: 'qualify',
        type: 'AI_CONVERSATION',
        mandatory: false,
        config: {
          prompt:
            'You are a warm, natural Australian outbound assistant qualifying homeowners for a free solar assessment for Aurora Solar. Qualify: home ownership, existing panels, quarterly bill size, dwelling type, and interest in a free assessment visit. Be brief, never pushy, one question at a time.',
          exitIntents: ['qualified', 'callback', 'not_interested', 'silence', 'max_turns', 'capture_failed'],
          captureVariables: ['owner', 'noPanels', 'billHigh', 'dwellingHouse', 'appointmentInterest'],
          maxTurns: 16,
        },
      },
      {
        id: 'transfer',
        type: 'TRANSFER',
        mandatory: false,
        config: { strategy: 'LONGEST_IDLE', whisperEnabled: false, acceptWindowSeconds: 13 },
      },
      {
        id: 'book-fallback',
        type: 'SPEAK',
        mandatory: false,
        config: {
          text: 'All of our specialists are helping other customers right now — we will call you back shortly to lock in your assessment. Thanks {{firstName}}!',
          interruptible: false,
        },
      },
      { id: 'end-booked', type: 'END', mandatory: false, config: { outcome: 'QUALIFIED' } },
      { id: 'end-nurture', type: 'END', mandatory: false, config: { outcome: 'NURTURE' } },
      { id: 'end', type: 'END', mandatory: false, config: { outcome: 'COMPLETE' } },
    ],
    edges: [
      { id: 'e-amd-human', from: 'amd', to: 'disclosure', conditions: [{ variable: 'amd.class', operator: 'eq', value: 'HUMAN' }], priority: 0 },
      { id: 'e-amd-default', from: 'amd', to: 'end', conditions: [], priority: 10 },
      { id: 'e-disc', from: 'disclosure', to: 'qualify', conditions: [], priority: 0 },
      { id: 'e-qualified', from: 'qualify', to: 'transfer', conditions: [{ variable: 'intent', operator: 'eq', value: 'qualified' }], priority: 0 },
      { id: 'e-nurture', from: 'qualify', to: 'end-nurture', conditions: [{ variable: 'intent', operator: 'eq', value: 'not_interested' }], priority: 1 },
      { id: 'e-qualify-default', from: 'qualify', to: 'end', conditions: [], priority: 10 },
      { id: 'e-transfer-fallback', from: 'transfer', to: 'book-fallback', conditions: [], priority: 0 },
      { id: 'e-fallback-end', from: 'book-fallback', to: 'end-booked', conditions: [], priority: 0 },
    ],
  };

  const flowVersionId = new Types.ObjectId();
  await db.collection('flowversions').insertOne({
    _id: flowVersionId,
    tenantId,
    flowId,
    version: 1,
    state: 'PUBLISHED',
    graph,
    publishedAt: now,
    changeNote: 'Initial pilot flow',
    createdAt: now,
    updatedAt: now,
  });

  const campaignId = new Types.ObjectId();
  await db.collection('campaigns').insertOne({
    _id: campaignId,
    tenantId,
    clientId,
    name: 'Aurora Solar — VIC Pilot',
    countryPackCode: 'AU',
    status: 'PAUSED',
    activeFlowVersionId: flowVersionId,
    abSplits: [],
    dailyDialBudget: 500,
    maxConcurrentCalls: 5,
    dialsPerAvailableAgent: 3,
    noAgentFallback: 'BOOK',
    voicemailPolicy: 'SILENT_HANGUP',
    ivrPolicy: { enabled: false, digits: '1', maxMenuDepth: 3 },
    cliPool: cliIds,
    cliRules: { geoMatch: true, rotation: 'ROUND_ROBIN' },
    retryMatrix: [
      { outcome: 'BUSY', delayMinutes: 30, shiftTimeBand: false, maxAttempts: 5 },
      { outcome: 'NO_ANSWER', delayMinutes: 240, shiftTimeBand: true, maxAttempts: 4 },
      { outcome: 'ANSWERED_VOICEMAIL', delayMinutes: 1440, shiftTimeBand: true, maxAttempts: 3 },
    ],
    frequencyCapDays: 14,
    scoring: DEFAULT_SCORING_CONFIG,
    rebuttals: [
      { objection: 'not_interested', rebuttal: 'Acknowledge, mention typical bill savings, offer a no-obligation assessment.' },
      { objection: 'already_called', rebuttal: 'Apologise sincerely, offer to update contact preferences, never contradict.' },
    ],
    aiSelfIdentification: true,
    transcriptionMode: 'SUMMARY',
    whisperEnabled: false,
    routingStrategy: 'LONGEST_IDLE',
    transferAcceptWindowSeconds: 13,
    schedule: [],
    sttKeywords: ['solar', 'panels', 'kilowatt', 'rebate'],
    summaryTemplate:
      'Lead {{firstName}} in {{suburb}}. Score {{score}}. Facts: {{facts}}. Objection: {{objection}}. Opener: {{opener}}',
    createdAt: now,
    updatedAt: now,
  });

  const listId = new Types.ObjectId();
  await db.collection('leadlists').insertOne({
    _id: listId,
    tenantId,
    clientId,
    name: 'VIC Pilot List',
    campaignId,
    priority: 0,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });

  const leads = [
    { phone: '+61412000101', firstName: 'Sam', lastName: 'Nguyen', suburb: 'Richmond', state: 'VIC', timezone: 'Australia/Melbourne' },
    { phone: '+61412000102', firstName: 'Priya', lastName: 'Patel', suburb: 'Box Hill', state: 'VIC', timezone: 'Australia/Melbourne' },
    { phone: '+61412000103', firstName: 'Jack', lastName: 'OBrien', suburb: 'Geelong', state: 'VIC', timezone: 'Australia/Melbourne' },
    { phone: '+61412000104', firstName: 'Mei', lastName: 'Chen', suburb: 'Parramatta', state: 'NSW', timezone: 'Australia/Sydney' },
    { phone: '+61412000105', firstName: 'Noah', lastName: 'Williams', suburb: 'Southbank', state: 'QLD', timezone: 'Australia/Brisbane' },
  ];
  await db.collection('leads').insertMany(
    leads.map((lead) => ({
      tenantId,
      clientId,
      listId,
      campaignId,
      ...lead,
      lineType: 'MOBILE',
      custom: {},
      state_: 'FRESH',
      attempts: 0,
      facts: {},
      score: 0,
      dncListed: false,
      timeline: [{ at: now, kind: 'IMPORT', detail: 'Seed data' }],
      createdAt: now,
      updatedAt: now,
    })),
  );

  // Fresh ACMA wash for every seed lead so dial-time suppression passes (LEAD-05).
  const washExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await db.collection('dncwashrecords').insertMany(
    leads.map((lead) => ({
      tenantId,
      countryPackCode: 'AU',
      phone: lead.phone,
      listed: false,
      washedAt: now,
      expiresAt: washExpiry,
      createdAt: now,
      updatedAt: now,
    })),
  );

  await seedDemoLogins(db, tenantId);

  console.log('Seed complete.');
  console.log('Login: owner@cocally.dev / admin@cocally.dev / supervisor@cocally.dev / agent1@cocally.dev / qa@cocally.dev');
  console.log('Password (all): CoCally!Pilot2026');
  console.log('Short demo logins: admin / 1234  ·  agent / 1234');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
