import { interpolate } from './runtime';

/**
 * Prompt assembly for the AI conversation loop — kept as a pure, exported
 * module so the admin UI can render an exact preview of what the model
 * receives (flows "prompt preview" endpoint) and tests can assert on it.
 *
 * How a turn reaches the LLM:
 *
 *   [system]    composeSystemPrompt(...)        ← node prompt + identity +
 *                                                 answered-facts + rebuttal
 *                                                 playbook + JSON envelope
 *   [user]      customer utterance, turn 1
 *   [assistant] AI's JSON envelope reply, turn 1
 *   [user]      customer utterance, turn 2
 *   ...rolling history, one entry per turn...
 *
 * The system prompt is REBUILT each turn so the ALREADY-ANSWERED list stays
 * current — that is what enforces AI-03 (never re-ask an answered question).
 * The model must answer with a single JSON object (the "envelope"); the
 * engine parses it, applies `captured` facts to call state, updates the
 * propensity score, and speaks `reply` through TTS.
 */

export interface PromptConfig {
  /** The AI_CONVERSATION node's prompt (campaign author writes this). */
  nodePrompt: string;
  /** Template variables available for {{interpolation}} in the node prompt. */
  vars: Record<string, unknown>;
  /** Structured facts captured so far (AI-06) — becomes the never-re-ask list. */
  facts: Record<string, unknown>;
  /** Campaign rebuttal library (AI-04). */
  rebuttals: Array<{ objection: string; rebuttal: string }>;
  /** Whether the AI has identified itself per AI-07. */
  aiSelfIdentification: boolean;
}

/** The JSON contract every conversation-model reply must follow. */
export const ENVELOPE_CONTRACT = {
  reply: 'string — what the AI says next; one or two sentences, natural spoken tone',
  intent: '"continue" | "qualified" | "objection" | "opt_out" | "callback" | "end"',
  captured:
    'object — qualification facts learned THIS turn (keys: owner, noPanels, billHigh, dwellingHouse, roofSuitable, appointmentInterest, or campaign-specific)',
  objection: 'string label of an objection raised this turn, or null',
} as const;

export function composeSystemPrompt(config: PromptConfig): string {
  const answered = Object.entries(config.facts)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  const rebuttals = config.rebuttals.map((r) => `- If "${r.objection}": ${r.rebuttal}`).join('\n');
  return [
    interpolate(config.nodePrompt, config.vars),
    config.aiSelfIdentification ? `You have already identified yourself as an AI assistant.` : '',
    `ALREADY ANSWERED (never re-ask these): ${answered || 'nothing yet'}.`,
    `OBJECTION PLAYBOOK (acknowledge gracefully, never contradict the customer):\n${rebuttals || 'none'}`,
    `Respond ONLY with a JSON object: {"reply": ${ENVELOPE_CONTRACT.reply},`,
    `"intent": ${ENVELOPE_CONTRACT.intent},`,
    `"captured": ${ENVELOPE_CONTRACT.captured},`,
    `"objection": ${ENVELOPE_CONTRACT.objection}}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Example message array for the preview UI, showing exactly how history rolls. */
export function exampleMessageAssembly(systemPrompt: string): Array<{ role: string; content: string }> {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '«customer utterance, turn 1 — raw STT text»' },
    {
      role: 'assistant',
      content:
        '{"reply":"«what the AI said turn 1»","intent":"continue","captured":{"owner":true},"objection":null}',
    },
    { role: 'user', content: '«customer utterance, turn 2»' },
    { role: 'assistant', content: '…and so on — full rolling history each turn…' },
  ];
}
