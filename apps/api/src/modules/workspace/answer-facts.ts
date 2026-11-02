const ANSWER_LABELS: Record<string, string> = {
  accountHolder: 'Account holder',
  fuel: 'Fuel',
  bill: 'Bill',
  retailer: 'Retailer',
  retailerHeard: 'Retailer (as heard)',
  other: 'Note',
};

/** The yes/no flags an answer replaces: "Retailer: Powershop" says more than "retailerProvided: true". */
const COVERED_BY_ANSWERS = ['decisionMaker', 'billProvided', 'retailerProvided'];

/**
 * Splits a lead's facts for the specialist's screens: the customer's own
 * answers (EngineController.handoffAnswers) as label + value, and the keys
 * still left to show. `answers` is an object, so it must never reach a String().
 */
export function answerFacts(facts: Record<string, unknown>): {
  answers: Array<{ label: string; value: string; confirmed: boolean }>;
  rest: Array<[string, unknown]>;
} {
  const raw = (facts['answers'] ?? null) as Record<string, string> | null;
  const answers = Object.entries(raw ?? {})
    .filter(([key, value]) => typeof value === 'string' && value && !(key === 'retailerHeard' && value === raw?.['retailer']))
    .map(([key, value]) => ({ label: ANSWER_LABELS[key] ?? key, value: String(value), confirmed: true }));
  const covered = raw ? COVERED_BY_ANSWERS : [];
  const rest = Object.entries(facts).filter(([key]) => key !== 'answers' && !covered.includes(key));
  return { answers, rest };
}
