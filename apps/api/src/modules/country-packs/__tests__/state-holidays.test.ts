import { describe, expect, it } from 'vitest';
import { AU_PACK } from '../au.pack';
import { isWithinCallingWindow, nextWindowOpen } from '../calling-windows';

describe('per-state public holidays (CP-02)', () => {
  it('blocks WA on its King\'s Birthday while NSW is open', () => {
    // 2026-09-28 11:00 Perth = 13:00 Sydney, a Monday.
    const at = new Date('2026-09-28T03:00:00Z');
    expect(isWithinCallingWindow(AU_PACK, 'Australia/Perth', at)).toBe(false);
    expect(isWithinCallingWindow(AU_PACK, 'Australia/Sydney', at)).toBe(true);
  });

  it('skips a state holiday when computing the next opening', () => {
    const from = new Date('2026-09-27T23:00:00Z'); // Mon 07:00 Perth
    const next = nextWindowOpen(AU_PACK, 'Australia/Perth', from);
    expect(next?.toISOString()).toBe('2026-09-29T01:00:00.000Z'); // Tue 09:00 Perth
  });
});
