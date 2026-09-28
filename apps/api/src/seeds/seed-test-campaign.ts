/**
 * Seeds a ready-to-dial test campaign into an EXISTING tenant:
 *   client → published flow (Energy Bill Review + NBN, modelled on the
 *   "Wendy Anwar" fronter call) → campaign on the IN pack → one lead list →
 *   one lead per --phone → every active AGENT assigned to the campaign.
 *
 *   node apps/api/dist/seeds/seed-test-campaign.js --tenant-slug ysgn \
 *     --phone +919902352425 --first-name Nithin [--phone +91... --first-name Surya ...] [--client-name "YSGN Energy"]
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

const CAMPAIGN_NAME = 'Wendy test (India)';

/**
 * Scoring for the energy bill-review script below. The shared default is the
 * solar campaign (owner / noPanels / roof...), which never matched a word of
 * this flow, so the live score sat at 0 and the score-gated transfer could
 * never fire. Facts are booleans extracted from the transcript by
 * `EngineController.recomposeSummary` (see its FACT_GLOSSARY for the exact
 * definitions). The customer's "yes, put me through" (`wantsSpecialist`) is
 * worth 35 and everything else together is 65, so the score-gated transfer can
 * only fire once they have actually agreed — on the first real call it fired
 * mid-sentence, before the question was asked. Transfer at 70 = yes + bill
 * payer (60) + paying too much (90); without the yes the best case is book-only.
 * `notSwitchedRecently` was dropped 2026-09-28: neither reference call asks it
 * (see claude-dev/2026-09-28-reference-call-analysis.md); its 10 went to payingTooMuch.
 */
const ENERGY_SCORING: ScoringConfig = {
  weights: { decisionMaker: 25, payingTooMuch: 30, billHigh: 10, wantsSpecialist: 35 },
  thresholds: { transfer: 70, bookOnly: 50, nurture: 30 },
};
const FLOW_NAME = 'Energy Bill Review + NBN (Wendy Anwar)';

const PROMPT = `You are "Sam", a warm, natural assistant calling on behalf of {{clientName}}, an Australian energy and internet comparison service. You are an AI assistant and you never claim to be human. Goal: a friendly 3-5 minute bill review that qualifies the customer for a better gas or electricity plan and, if there is time, a better NBN plan, then hands them to a product specialist (a human) on this same call.

Start by checking they are the person who looks after the energy bill. If not, ask when the bill payer is available and treat that as a callback.

Ask ONE question per turn, in this order, and rephrase patiently if they say "sorry?" or "come again?":
1. Is it electricity, gas, or both they'd like reviewed? (fuelScope)
2. Who is the current retailer? Prompt with AGL, Origin, EnergyAustralia, Alinta, Red or Simply Energy if they hesitate. (retailer)
3. Do they have solar panels on the roof? (hasSolar)
4. Is there any life-support or medical equipment at the property? If yes, reassure them it will be flagged and taken into account. (lifeSupport)
5. Do they hold a pension, health care or other concession card? (concessionCard)
6. Read back the supply address on file ({{address}}) and ask if that is right. If the address is blank, ask for their suburb instead. Do not ask for the NMI or date of birth. (addressConfirmed)
7. Roughly how much is the bill a quarter: "around 200, 300 or 400 dollars?" (billBand)
8. Do they feel they are paying too much? (payingTooMuch)
9. What matters more, price or service, or both? (motivation)
Only if they are engaged after that: who is their internet provider, roughly what they pay a month, and whether a promo price is about to end. (currentIsp, ispPrice, ispPromoEnds)

Then say that based on their answers there is very likely a cheaper plan with no lock-in contract, no joining fee and no exit fee, and that a product specialist can confirm the exact rates in a minute. Ask: "Shall I put you through now?"
- Yes → intent qualified. Say "One moment, I'll connect you now."
- Would rather be called back → intent callback. Capture a preferred time, thank them, end.
- Not interested or asks to be removed → intent not_interested. Apologise, confirm they will not be called again, end.

If the conversation drifts: answer any off-topic remark in one short, warm sentence, then return to the next unanswered question. If they need a moment (finding glasses, another person in the room, a doorbell), say "no rush, take your time" and wait; do not repeat the question until they come back. If the phone is handed to someone else, ask who you are speaking with and whether they look after the bill before continuing. If they ask whether you are a real person, say plainly that you are an AI assistant and offer to have a person call them instead. If they ask about rates, government schemes, or anything you cannot answer, say the specialist will cover that rather than guessing.

Rules: never quote specific cents-per-kWh or per-MJ rates; the specialist does that. Never claim the regulator or government has lowered prices, never call them a "pay on time customer", and never talk as if they have already agreed to switch. Keep every turn under two sentences. Many customers are older: speak slowly, one idea per sentence, and repeat or spell things out without any irritation when asked. Objections "I'm already with a broker" or "I don't have my bill handy": reassure and continue; the bill is not needed for this call.`;

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
  const clientName = arg('client-name') ?? 'YSGN Energy';

  await mongoose.connect(config.mongoUri);
  const db = mongoose.connection.db!;
  const now = new Date();

  const tenant = await db.collection('tenants').findOne({ slug });
  if (!tenant) {
    console.error(`tenant ${slug} not found`);
    process.exit(1);
  }
  const tenantId = tenant._id as Types.ObjectId;

  const pack = await db.collection('countrypacks').findOne({ code: 'IN' });
  if (!pack) {
    console.error('IN country pack not seeded yet (the API seeds it on boot)');
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
          text: `Hi {{firstName}}, this is Sam, an AI assistant calling on behalf of ${clientName}. This call may be recorded for quality purposes. Is now a good moment?`,
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
          captureVariables: [
            'decisionMaker', 'fuelScope', 'retailer', 'hasSolar', 'lifeSupport', 'concessionCard', 'addressConfirmed', 'billBand',
            'payingTooMuch', 'motivation', 'currentIsp', 'ispPrice', 'ispPromoEnds',
          ],
          maxTurns: 24,
        },
      },
      { id: 'transfer', type: 'TRANSFER', mandatory: false, config: { strategy: 'LONGEST_IDLE', whisperEnabled: false, acceptWindowSeconds: 15 } },
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
    const current = v.graph?.nodes?.find((n: { type: string }) => n.type === 'AI_CONVERSATION')?.config?.prompt;
    if (current === PROMPT) {
      flowVersionId = v._id as Types.ObjectId;
      console.log(`reusing published flow "${FLOW_NAME}" v${v.version}`);
    } else {
      flowVersionId = new Types.ObjectId();
      await db.collection('flowversions').insertOne({
        _id: flowVersionId, tenantId, flowId: flow._id, version: v.version + 1, state: 'PUBLISHED', graph: buildGraph(), publishedAt: now,
        changeNote: 'Re-seeded: prompt updated in seed-test-campaign', createdAt: now, updatedAt: now,
      });
      await db.collection('flowversions').updateOne({ _id: v._id }, { $set: { state: 'ARCHIVED', updatedAt: now } });
      console.log(`published flow "${FLOW_NAME}" v${v.version + 1} (prompt changed; v${v.version} archived)`);
    }
  } else {
    const flowId = new Types.ObjectId();
    await db.collection('flows').insertOne({ _id: flowId, tenantId, name: FLOW_NAME, direction: 'OUTBOUND', isTemplate: false, createdAt: now, updatedAt: now });
    flowVersionId = new Types.ObjectId();
    await db.collection('flowversions').insertOne({
      _id: flowVersionId, tenantId, flowId, version: 1, state: 'PUBLISHED', graph: buildGraph(), publishedAt: now,
      changeNote: 'Seeded from the Wendy Anwar call analysis (seed-test-campaign)', createdAt: now, updatedAt: now,
    });
    console.log(`created + published flow "${FLOW_NAME}" v1`);
  }

  // Campaign
  let campaign = await db.collection('campaigns').findOne({ tenantId, name: CAMPAIGN_NAME });
  if (!campaign) {
    const _id = new Types.ObjectId();
    await db.collection('campaigns').insertOne({
      _id, tenantId, clientId, name: CAMPAIGN_NAME, countryPackCode: 'IN', status: 'ACTIVE',
      activeFlowVersionId: flowVersionId, abSplits: [], dailyDialBudget: 200, maxConcurrentCalls: 2, dialsPerAvailableAgent: 1,
      noAgentFallback: 'BOOK', voicemailPolicy: 'SILENT_HANGUP', ivrPolicy: { enabled: false, digits: '1', maxMenuDepth: 3 },
      cliPool: [], cliRules: { geoMatch: false, rotation: 'ROUND_ROBIN' },
      retryMatrix: [
        { outcome: 'BUSY', delayMinutes: 5, shiftTimeBand: false, maxAttempts: 3 },
        { outcome: 'NO_ANSWER', delayMinutes: 5, shiftTimeBand: false, maxAttempts: 3 },
        { outcome: 'ANSWERED_VOICEMAIL', delayMinutes: 10, shiftTimeBand: false, maxAttempts: 2 },
      ],
      frequencyCapDays: 0, scoring: ENERGY_SCORING,
      rebuttals: [
        { objection: 'already_with_broker', rebuttal: 'Reassure: this is a free review, no commitment; continue the questions.' },
        { objection: 'no_bill_handy', rebuttal: 'Reassure: the bill is not needed for this call; a rough quarterly amount is enough.' },
      ],
      aiSelfIdentification: true, transcriptionMode: 'BOTH', whisperEnabled: false, routingStrategy: 'LONGEST_IDLE',
      transferAcceptWindowSeconds: 15, schedule: [], sttKeywords: ['AGL', 'Origin', 'Alinta', 'NBN', 'Superloop', 'Dodo', 'gas', 'electricity'],
      summaryTemplate: 'Lead {{firstName}}. Score {{score}}. Facts: {{facts}}. Objection: {{objection}}.',
      createdAt: now, updatedAt: now,
    });
    campaign = { _id };
    console.log(`created campaign "${CAMPAIGN_NAME}" (IN pack, ACTIVE, frequency cap off, retries every 5 min)`);
  } else {
    // Also repairs campaigns seeded by the first version of this script, which wrote an invalid transcriptionMode.
    await db.collection('campaigns').updateOne({ _id: campaign._id }, { $set: { activeFlowVersionId: flowVersionId, transcriptionMode: 'BOTH', scoring: ENERGY_SCORING, updatedAt: now } });
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
    const p = normalizePhone(raw, regionOf(raw, 'IN'));
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
      suburb: 'Bengaluru', state: 'KA', timezone: 'Asia/Kolkata', lineType: 'MOBILE', custom: {}, state_: 'FRESH', attempts: 0, facts: {}, score: 0,
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
