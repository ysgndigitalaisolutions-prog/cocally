import type { ScoreAction } from './enums.js';
import type { ScoringConfig } from './contracts.js';

/**
 * Live propensity scoring per AI-05: every captured answer updates a
 * configurable weighted score; thresholds drive transfer / book-only /
 * nurture / release.
 */
export function computeScore(config: ScoringConfig, facts: Record<string, unknown>): number {
  let score = 0;
  for (const [key, weight] of Object.entries(config.weights)) {
    const value = facts[key];
    if (value === undefined || value === null || value === '' || value === false || value === 'no') continue;
    score += weight;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function scoreAction(config: ScoringConfig, score: number): ScoreAction {
  const { transfer, bookOnly, nurture } = config.thresholds;
  if (score >= transfer) return 'TRANSFER';
  if (score >= bookOnly) return 'BOOK_ONLY';
  if (score >= nurture) return 'NURTURE';
  return 'RELEASE';
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: {
    owner: 25,
    noPanels: 20,
    billHigh: 20,
    dwellingHouse: 15,
    roofSuitable: 10,
    appointmentInterest: 10,
  },
  thresholds: { transfer: 70, bookOnly: 50, nurture: 30 },
};
