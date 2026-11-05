import { describe, expect, it } from 'vitest';
import { CALL_OUTCOMES } from '@cocally/shared';
import { OUTCOME_BUCKETS } from '../usage-buckets';

describe('usage board buckets', () => {
  it('counts every outcome exactly once, so the tiles add up to Calls', () => {
    const all = Object.values(OUTCOME_BUCKETS).flat();
    expect([...all].sort()).toEqual([...CALL_OUTCOMES].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps calls that never rang out of No answer', () => {
    expect(OUTCOME_BUCKETS.noAnswer).not.toContain('FAILED');
    expect(OUTCOME_BUCKETS.failed).toContain('FAILED');
  });
});
