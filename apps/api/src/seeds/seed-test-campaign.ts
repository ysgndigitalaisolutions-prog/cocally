/**
 * Seeds a ready-to-dial test campaign into an EXISTING tenant:
 *   client (Australian Deal) → published flow (the AI Energy Campaign call
 *   script, verbatim) → campaign on the IN pack → one lead list →
 *   one lead per --phone → every active AGENT assigned to the campaign.
 *
 *   node apps/api/dist/seeds/seed-test-campaign.js --tenant-slug ysgn \
 *     --phone +919902352425 --first-name Nithin [--phone +91... --first-name Surya ...] [--client-name "Australian Deal"]
 *
 * Idempotent on campaign name: re-running adds missing leads and re-assigns
 * agents but does not duplicate the flow or campaign. Internal testing only —
 * the IN pack has no DNC integration, so only our own numbers go here.
 */
import 'reflect-metadata';
import mongoose, { Types } from 'mongoose';
import type { ScoringConfig } from '@cocally/shared';
import { config } from '../common/config';
import { normalizePhone, regionOf } from '../modules/leads/phone.util';

function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const next = process.argv[i + 1];
    if (process.argv[i] === `--${name}` && next) {
      out.push(next);
      i++;
    }
  }
  return out;
}
const arg = (name: string) => args(name)[0];

/** Country pack: IN (default, the team's own test phones over Twilio) or AU (+61 leads, dialled over Telvoq). */
const PACK = (arg('pack') ?? 'IN').toUpperCase() === 'AU' ? 'AU' : 'IN';
const CAMPAIGN_NAME = PACK === 'AU' ? 'AI Energy Campaign (AU test)' : 'AI Energy Campaign (India test)';
/** Earlier name of the same campaign; renamed in place so its leads and history stay. */
const OLD_CAMPAIGN_NAMES = PACK === 'AU' ? [] : ['Wendy test (India)'];
/** Where the test leads are, for local time (callbacks) and the dialler's calling window. */
const LEAD_PLACE = PACK === 'AU'
  ? { suburb: 'Collingwood', state: 'VIC', timezone: 'Australia/Melbourne' }
  : { suburb: 'Bengaluru', state: 'KA', timezone: 'Asia/Kolkata' };

/**
 * Scoring for the call script (claude-dev/2026-10-12 golden script). Facts are
 * booleans extracted from the transcript by `EngineController.recomposeSummary`
 * (FACT_GLOSSARY). The script transfers once the customer has named their
 * energy company, so the score can only reach the transfer threshold (100)
 * after all three answers; it can never fire mid-script.
 */
const ENERGY_SCORING: ScoringConfig = {
  weights: { decisionMaker: 30, billProvided: 20, retailerProvided: 50 },
  thresholds: { transfer: 100, bookOnly: 50, nurture: 30 },
};
const FLOW_NAME = 'AI Energy Campaign – Outbound Call Script';
/** Retailers and distributors customers name (client list, 27 Oct), plus script words. */
const STT_KEYWORDS = [
  // Retailers
  'AGL', 'ActewAGL', 'Origin Energy', 'EnergyAustralia', 'Alinta Energy', '1st Energy', 'Dodo', 'Powershop', 'Red Energy', 'Lumo Energy',
  'Blue Energy', 'OVO Energy', 'Amber', 'ENGIE', 'Momentum Energy', 'GloBird Energy', 'Sumo', 'Tango Energy', 'Next Business Energy', 'Simply Energy',
  // Distributors (named from the bill instead of the retailer)
  'Jemena', 'CitiPower', 'Powercor', 'AusNet', 'United Energy', 'Ausgrid', 'Endeavour Energy', 'Essential Energy', 'SA Power Networks', 'Energex',
  // Out of area
  'Aurora Energy', 'Ergon Energy', 'Jacana', 'Synergy',
  'electricity', 'gas', 'quarterly', 'monthly',
];
/**
 * Regional monopolies the client cannot serve (Tasmania, regional Queensland,
 * Northern Territory, Western Australia). Client rule, 27 Oct: thank them and
 * end the call, never transfer.
 */
const OUT_OF_AREA_RETAILERS = ['Aurora Energy', 'Ergon Energy', 'Jacana Energy', 'Synergy'];
const OUT_OF_AREA_LINE = 'Thank you, we cannot cater to your area. Bye, take care.';
/**
 * Said to a phone's call-screening assistant ("record your name and reason
 * for calling", seen on the client's own recordings), so the person sees who
 * is calling and picks up.
 */
const SCREENING_LINE = "Hi, this is Daniel from Australian Deal, calling regarding your electricity bills.";

/**
 * The opening line, spoken verbatim by the worker before the model's first
 * turn. Brief and without names (12 Oct, Nithin): who is calling comes in the
 * first question, once the customer has answered.
 */
const OPENING_LINE = 'Hello, how are you doing today?';

/** The script's hand-off, spoken verbatim by the worker when the transfer starts. */
const TRANSFER_LINE =
  "Perfect, thank you. What I'll do now is connect you with one of our energy specialists, who can review your current situation and explain any suitable offers in detail. They should be available in about 10 seconds, so please hold for just a moment while I connect you.";

const PROMPT = `You are Daniel, calling on behalf of {{clientName}} about the customer's electricity bills. Follow this call script exactly. Every scripted line has a tag like [S2]: to say it, output the tag and it is spoken for you word for word. Sound warm and human: if they ask how you are, or share a feeling or complaint ("bills are crazy", "rough day"), react in a few words first (for example: I'm doing well, thanks for asking!), then output the tag. One step per turn, then wait for their answer. Never skip a step, never add questions that are not in the script, and never repeat a step they have already answered.

Step 1, after they answer "how are you":
[S1] "This is Daniel from {{clientName}}. I'm calling regarding your electricity bills. Are you the person who looks after the electricity account?"
- If NO: say [E1] "No worries. Thank you for your time. Have a great day!" and then call end_call.
Repeat question: [S1Q] "Are you the person who looks after the electricity account?"
- If YES: go to step 2.

Step 2:
[S2] "As you may know, energy prices can be quite expensive, so we're doing a quick survey to see whether there's an opportunity to reduce your electricity bills or find you a better offer. Do you currently have electricity only, or do you have gas as well?"
Repeat question: [S2Q] "Do you currently have electricity only, or do you have gas as well?"

Step 3:
[S3] "No problem. Just to get a rough idea, how much do you usually spend on your electricity bills, either monthly or quarterly? Like 200 to 300 dollars, or more than that?"
Repeat question: [S3Q] "How much do you usually spend on your electricity bills, either monthly or quarterly? Like 200 to 300 dollars, or more than that?"

If they give their rates (cents per kilowatt hour, supply charge) instead of a bill amount, that counts as the answer: go to step 4.

Step 4:
[S4] "Okay, thanks for that. Based on what you've told me, there may be an opportunity to find a more competitive offer for your account. Which energy company are you currently with?"
Repeat question: [S4Q] "Which energy company are you currently with?"

Step 5, once they answer step 4: call request_transfer. Say nothing yourself; the hand-off line is spoken for you and asks them to hold. This applies whatever they answer: a retailer, a network company from their bill (Jemena, CitiPower, Powercor, AusNet, United Energy, Ausgrid, Endeavour, Essential, SA Power Networks, Energex), or that they are not sure. Never ask about the company again.

If an answer is unclear, or they cut in before you finished a step, output that step's repeat-question tag (e.g. [S2Q]), never the whole step again. If they ask a question, output the playbook answer's tag and then the tag of the step you were on, e.g. [Q1] [S3].`;

/** The script's customer questions and answers, verbatim. */
const playbook = (clientName: string) => [
  { objection: 'Where are you calling from?', rebuttal: `Say: [Q1] "I'm calling from ${clientName}. We're an energy broker, and we work with multiple energy retailers to help customers find suitable offers." Then output the tag of the step you were on.` },
  { objection: 'Which country are you calling from? / Where are you located?', rebuttal: `Say: [Q2] "We're based in Collingwood, Melbourne, Australia." Then output the tag of the step you were on.` },
  { objection: "What's the offer? / How much can you save me?", rebuttal: 'Say: [Q3] "The offer depends on your meter type and current tariff. Give me a moment, and our energy specialist will review the details and explain the available offer to you." Then output the tag of the step you were on.' },
  { objection: "I'm not interested. / I'm happy with my current offer. / I've recently changed my energy company.", rebuttal: `Say: [Q4] "I understand. If you're happy to spare just two minutes, our specialist can explain the available offer so you can decide whether it's worth considering."` },
  { objection: "My number is on the DNC Register. / Don't call me again. / I'll make a complaint.", rebuttal: 'Call the opt_out tool and say nothing yourself: the closing line is spoken for you and their number is suppressed.' },
  { objection: "I'm busy right now. / Call me back later. / I'm at work and can't talk.", rebuttal: 'Say: [Q6] "No problem. What would be a convenient time for us to call you back? If today doesn\'t suit you, which day and time would work best?" When they give a day and time, call schedule_callback with it, confirm it back, say goodbye and call end_call.' },
  { objection: 'Any question that is not covered in this script', rebuttal: 'Say: [Q7] "Sure, our energy specialist will be able to explain that to you in more detail. Let me connect you with them and continue the script." Then output the tag of the next step of the script and proceed with the transfer.' },
];

async function main() {
  const slug = arg('tenant-slug');
  const phones = args('phone');
  if (!slug || phones.length === 0) {
    console.error('Usage: --tenant-slug <slug> --phone <+91...> [--phone ...] [--first-name <name>] [--client-name <name>]');
    process.exit(2);
  }
  // Names pair with phones in order: --phone A --first-name Alice --phone B --first-name Bob.
  const firstNames = args('first-name');
  const firstName = firstNames[0] ?? 'Nithin';
  const nameFor = (i: number) => firstNames[i] ?? (i === 0 ? firstName : `Test${i + 1}`);
  const clientName = arg('client-name') ?? 'Australian Deal';

  await mongoose.connect(config.mongoUri);
  const db = mongoose.connection.db!;
  const now = new Date();

  const tenant = await db.collection('tenants').findOne({ slug });
  if (!tenant) {
    console.error(`tenant ${slug} not found`);
    process.exit(1);
  }
  const tenantId = tenant._id as Types.ObjectId;

  const pack = await db.collection('countrypacks').findOne({ code: PACK });
  if (!pack) {
    console.error(`${PACK} country pack not seeded yet (the API seeds it on boot)`);
    process.exit(1);
  }

  // Client
  let client = await db.collection('clients').findOne({ tenantId, name: clientName });
  if (!client) {
    const _id = new Types.ObjectId();
    await db.collection('clients').insertOne({ _id, tenantId, name: clientName, branding: {}, active: true, createdAt: now, updatedAt: now });
    client = { _id };
    console.log(`created client "${clientName}"`);
  }
  const clientId = client._id as Types.ObjectId;

  // Flow + published version. If the flow already exists but its prompt has
  // changed since it was published, publish a new version and point the
  // campaign at it — otherwise prompt edits here never reach a live pilot.
  const buildGraph = () => {
  const graph = {
    entryNodeId: 'amd',
    nodes: [
      { id: 'amd', type: 'AMD_CLASSIFY', mandatory: false, config: {} },
      {
        id: 'disclosure',
        type: 'SPEAK',
        mandatory: true,
        config: {
          text: OPENING_LINE,
          interruptible: false,
        },
      },
      {
        id: 'qualify',
        type: 'AI_CONVERSATION',
        mandatory: false,
        config: {
          prompt: PROMPT,
          exitIntents: ['qualified', 'callback', 'not_interested', 'silence', 'max_turns', 'capture_failed'],
          captureVariables: ['decisionMaker', 'fuelScope', 'billAmount', 'retailer'],
          maxTurns: 24,
        },
      },
      { id: 'transfer', type: 'TRANSFER', mandatory: false, config: { strategy: 'LONGEST_IDLE', whisperEnabled: false, acceptWindowSeconds: 15, announceText: TRANSFER_LINE } },
      {
        id: 'book-fallback',
        type: 'SPEAK',
        mandatory: false,
        config: {
          text: 'All of our specialists are with other customers right now. We will call you back shortly to go through the rates. Thanks {{firstName}}!',
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
      { id: 'e-callback', from: 'qualify', to: 'end-nurture', conditions: [{ variable: 'intent', operator: 'eq', value: 'callback' }], priority: 1 },
      { id: 'e-nurture', from: 'qualify', to: 'end-nurture', conditions: [{ variable: 'intent', operator: 'eq', value: 'not_interested' }], priority: 2 },
      { id: 'e-qualify-default', from: 'qualify', to: 'end', conditions: [], priority: 10 },
      { id: 'e-transfer-fallback', from: 'transfer', to: 'book-fallback', conditions: [], priority: 0 },
      { id: 'e-fallback-end', from: 'book-fallback', to: 'end-booked', conditions: [], priority: 0 },
    ],
  };
    return graph;
  };
  let flow = await db.collection('flows').findOne({ tenantId, name: FLOW_NAME });
  let flowVersionId: Types.ObjectId;
  if (flow) {
    const v = await db.collection('flowversions').findOne({ tenantId, flowId: flow._id, state: 'PUBLISHED' }, { sort: { version: -1 } });
    if (!v) {
      console.error(`flow "${FLOW_NAME}" exists but has no published version; publish it in the UI or delete it and re-run`);
      process.exit(1);
    }
    if (JSON.stringify(v.graph) === JSON.stringify(buildGraph())) {
      flowVersionId = v._id as Types.ObjectId;
      console.log(`reusing published flow "${FLOW_NAME}" v${v.version}`);
    } else {
      flowVersionId = new Types.ObjectId();
      await db.collection('flowversions').insertOne({
        _id: flowVersionId, tenantId, flowId: flow._id, version: v.version + 1, state: 'PUBLISHED', graph: buildGraph(), publishedAt: now,
        changeNote: 'Re-seeded: flow updated in seed-test-campaign', createdAt: now, updatedAt: now,
      });
      await db.collection('flowversions').updateOne({ _id: v._id }, { $set: { state: 'ARCHIVED', updatedAt: now } });
      console.log(`published flow "${FLOW_NAME}" v${v.version + 1} (flow changed; v${v.version} archived)`);
    }
  } else {
    const flowId = new Types.ObjectId();
    await db.collection('flows').insertOne({ _id: flowId, tenantId, name: FLOW_NAME, direction: 'OUTBOUND', isTemplate: false, createdAt: now, updatedAt: now });
    flowVersionId = new Types.ObjectId();
    await db.collection('flowversions').insertOne({
      _id: flowVersionId, tenantId, flowId, version: 1, state: 'PUBLISHED', graph: buildGraph(), publishedAt: now,
      changeNote: 'Seeded from the AI Energy Campaign call script (seed-test-campaign)', createdAt: now, updatedAt: now,
    });
    console.log(`created + published flow "${FLOW_NAME}" v1`);
  }

  // Campaign
  let campaign = await db.collection('campaigns').findOne({ tenantId, name: { $in: [CAMPAIGN_NAME, ...OLD_CAMPAIGN_NAMES] } });
  if (campaign && campaign.name !== CAMPAIGN_NAME) {
    await db.collection('campaigns').updateOne({ _id: campaign._id }, { $set: { name: CAMPAIGN_NAME, updatedAt: now } });
    console.log(`renamed campaign "${campaign.name}" -> "${CAMPAIGN_NAME}"`);
  }
  if (!campaign) {
    const _id = new Types.ObjectId();
    await db.collection('campaigns').insertOne({
      _id, tenantId, clientId, name: CAMPAIGN_NAME, countryPackCode: PACK, status: 'ACTIVE',
      activeFlowVersionId: flowVersionId, abSplits: [], dailyDialBudget: 200, maxConcurrentCalls: 2, dialsPerAvailableAgent: 1,
      noAgentFallback: 'BOOK', voicemailPolicy: 'SILENT_HANGUP', ivrPolicy: { enabled: false, digits: '1', maxMenuDepth: 3 },
      cliPool: [], cliRules: { geoMatch: false, rotation: 'ROUND_ROBIN' },
      retryMatrix: [
        { outcome: 'BUSY', delayMinutes: 5, shiftTimeBand: false, maxAttempts: 3 },
        { outcome: 'NO_ANSWER', delayMinutes: 5, shiftTimeBand: false, maxAttempts: 3 },
        { outcome: 'ANSWERED_VOICEMAIL', delayMinutes: 10, shiftTimeBand: false, maxAttempts: 2 },
      ],
      frequencyCapDays: 0, scoring: ENERGY_SCORING,
      rebuttals: playbook(clientName),
      aiSelfIdentification: true, transcriptionMode: 'BOTH', whisperEnabled: false, routingStrategy: 'LONGEST_IDLE',
      transferAcceptWindowSeconds: 15, schedule: [], sttKeywords: STT_KEYWORDS,
      outOfAreaRetailers: OUT_OF_AREA_RETAILERS, outOfAreaLine: OUT_OF_AREA_LINE, screeningLine: SCREENING_LINE,
      summaryTemplate: 'Lead {{firstName}}. Score {{score}}. Facts: {{facts}}. Objection: {{objection}}.',
      createdAt: now, updatedAt: now,
    });
    campaign = { _id };
    console.log(`created campaign "${CAMPAIGN_NAME}" (${PACK} pack, ACTIVE, frequency cap off, retries every 5 min)`);
  } else {
    // Also repairs campaigns seeded by the first version of this script, which wrote an invalid transcriptionMode.
    await db.collection('campaigns').updateOne({ _id: campaign._id }, {
      $set: { clientId, activeFlowVersionId: flowVersionId, transcriptionMode: 'BOTH', scoring: ENERGY_SCORING, rebuttals: playbook(clientName), sttKeywords: STT_KEYWORDS, outOfAreaRetailers: OUT_OF_AREA_RETAILERS, outOfAreaLine: OUT_OF_AREA_LINE, screeningLine: SCREENING_LINE, updatedAt: now },
    });
    // Keep the campaign's lists and leads under the same client.
    await db.collection('leadlists').updateMany({ tenantId, campaignId: campaign._id }, { $set: { clientId, updatedAt: now } });
    await db.collection('leads').updateMany({ tenantId, campaignId: campaign._id }, { $set: { clientId, updatedAt: now } });
    console.log(`reusing campaign "${CAMPAIGN_NAME}"`);
  }
  const campaignId = campaign._id as Types.ObjectId;

  // Lead list
  let list = await db.collection('leadlists').findOne({ tenantId, campaignId, name: 'Own numbers' });
  if (!list) {
    const _id = new Types.ObjectId();
    await db.collection('leadlists').insertOne({ _id, tenantId, clientId, name: 'Own numbers', campaignId, priority: 0, status: 'ACTIVE', createdAt: now, updatedAt: now });
    list = { _id };
  }
  const listId = list._id as Types.ObjectId;

  // Leads (one per --phone), reset to FRESH if they already exist so they can be dialled again
  for (const [i, raw] of phones.entries()) {
    const p = normalizePhone(raw, regionOf(raw, PACK));
    if (!p.ok) { console.error(`skipping ${raw}: ${p.reason}`); continue; }
    const e164 = p.value.e164;
    const existing = await db.collection('leads').findOne({ tenantId, campaignId, phone: e164 });
    if (existing) {
      await db.collection('leads').updateOne({ _id: existing._id }, { $set: { state_: 'FRESH', attempts: 0, nextAttemptAt: null, manualClaimedBy: null, updatedAt: now } });
      console.log(`lead ${e164} reset to FRESH`);
      continue;
    }
    await db.collection('leads').insertOne({
      tenantId, clientId, listId, campaignId, phone: e164, firstName: nameFor(i), lastName: firstNames[i] || i === 0 ? '' : 'Number',
      ...LEAD_PLACE, lineType: 'MOBILE', custom: {}, state_: 'FRESH', attempts: 0, facts: {}, score: 0,
      dncListed: false, timeline: [{ at: now, kind: 'IMPORT', detail: 'seed-test-campaign' }], createdAt: now, updatedAt: now,
    });
    console.log(`created lead ${e164} (${nameFor(i)})`);
  }

  // Assign every active agent as a closer on this campaign (skills holds campaign ids)
  const agents = await db.collection('users').find({ tenantId, roles: 'AGENT', active: true }).toArray();
  for (const a of agents) {
    if (!(a.skills ?? []).includes(campaignId.toString())) {
      await db.collection('users').updateOne({ _id: a._id }, { $addToSet: { skills: campaignId.toString() }, $set: { updatedAt: now } });
    }
  }
  console.log(agents.length ? `assigned ${agents.length} agent(s) to the campaign: ${agents.map((a) => a.name).join(', ')}` : 'no active agents yet — invite one, then re-run this seed (or assign on the campaign page)');

  console.log(`\nready: campaign "${CAMPAIGN_NAME}" → https://app.co-cally.com/campaigns/${campaignId}`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
