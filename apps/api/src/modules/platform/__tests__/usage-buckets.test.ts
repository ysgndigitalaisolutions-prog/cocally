import { describe, expect, it } from 'vitest';
import { CALL_OUTCOMES } from '@cocally/shared';
import { OUTCOME_BUCKETS } from '../usage-buckets';

describe('usage board buckets', () => {
  it('counts every outcome exactly once, so the tiles add up to Calls', () => {
    const all = Object.values(OUTCOME_BUCKETS).flat();
    expect([...all].sort()).toEqual([...CALL_OUTCOMES].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('counts a gate apart from a mailbox and from a pick-up', () => {
    expect(OUTCOME_BUCKETS.gate).toEqual(['ANSWERED_IVR']);
    expect(OUTCOME_BUCKETS.voicemail).not.toContain('ANSWERED_IVR');
    expect(OUTCOME_BUCKETS.pickedUp).not.toContain('ANSWERED_IVR');
  });

  it('keeps calls that never rang out of No answer', () => {
    expect(OUTCOME_BUCKETS.noAnswer).not.toContain('FAILED');
    expect(OUTCOME_BUCKETS.failed).toContain('FAILED');
  });
});
