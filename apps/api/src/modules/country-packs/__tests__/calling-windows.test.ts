import { describe, expect, it } from 'vitest';
import { isWithinCallingWindow, nextWindowOpen, type WindowRules } from '../calling-windows';

const AU_RULES: WindowRules = {
  callingWindows: [
    { weekday: 1, start: '09:00', end: '20:00' },
    { weekday: 2, start: '09:00', end: '20:00' },
    { weekday: 3, start: '09:00', end: '20:00' },
    { weekday: 4, start: '09:00', end: '20:00' },
    { weekday: 5, start: '09:00', end: '20:00' },
    { weekday: 6, start: '09:00', end: '17:00' },
  ],
  publicHolidays: ['2026-01-26'],
};

describe('isWithinCallingWindow (LEAD-06 / CP-02)', () => {
  it('allows a Tuesday 10:00 Sydney call', () => {
    // 2026-07-21 is a Tuesday. 10:00 AEST = 00:00 UTC.
    const at = new Date('2026-07-21T00:00:00Z');
    expect(isWithinCallingWindow(AU_RULES, 'Australia/Sydney', at)).toBe(true);
  });

  it('blocks a Sunday call', () => {
    // 2026-07-19 is a Sunday in Sydney at 10:00 local.
    const at = new Date('2026-07-19T00:00:00Z');
    expect(isWithinCallingWindow(AU_RULES, 'Australia/Sydney', at)).toBe(false);
  });

  it('blocks before 09:00 local', () => {
    // Tuesday 08:00 AEST = Monday 22:00 UTC.
    const at = new Date('2026-07-20T22:00:00Z');
    expect(isWithinCallingWindow(AU_RULES, 'Australia/Sydney', at)).toBe(false);
  });

  it('blocks after 20:00 weekday local', () => {
    // Tuesday 20:30 AEST = 10:30 UTC.
    const at = new Date('2026-07-21T10:30:00Z');
    expect(isWithinCallingWindow(AU_RULES, 'Australia/Sydney', at)).toBe(false);
  });

  it('handles DST divergence: QLD callable while NSW is not (summer)', () => {
    // 2026-01-06 (Tue). 19:30 in Brisbane (AEST, UTC+10) = 09:30 UTC.
    // Sydney is then AEDT (UTC+11) → 20:30, outside the window.
    const at = new Date('2026-01-06T09:30:00Z');
    expect(isWithinCallingWindow(AU_RULES, 'Australia/Brisbane', at)).toBe(true);
    expect(isWithinCallingWindow(AU_RULES, 'Australia/Sydney', at)).toBe(false);
  });

  it('blocks public holidays', () => {
    // Australia Day 2026-01-26 (Monday), 10:00 AEDT = 23:00 UTC on the 25th.
    const at = new Date('2026-01-25T23:00:00Z');
    expect(isWithinCallingWindow(AU_RULES, 'Australia/Sydney', at)).toBe(false);
  });

  it('blocks Saturday after 17:00', () => {
    // Saturday 2026-07-25, 17:30 AEST = 07:30 UTC.
    const at = new Date('2026-07-25T07:30:00Z');
    expect(isWithinCallingWindow(AU_RULES, 'Australia/Sydney', at)).toBe(false);
  });
});

describe('nextWindowOpen', () => {
  it('returns Monday 09:00 when asked on Sunday', () => {
    // Sunday 2026-07-19 10:00 AEST.
    const from = new Date('2026-07-19T00:00:00Z');
    const next = nextWindowOpen(AU_RULES, 'Australia/Sydney', from);
    expect(next).not.toBeNull();
    // Monday 09:00 AEST = Sunday 23:00 UTC.
    expect(next!.toISOString()).toBe('2026-07-19T23:00:00.000Z');
  });

  it('returns the same instant when already inside a window', () => {
    const from = new Date('2026-07-21T00:00:00Z'); // Tue 10:00 AEST
    const next = nextWindowOpen(AU_RULES, 'Australia/Sydney', from);
    expect(next!.getTime()).toBe(from.getTime());
  });

  it('skips public holidays', () => {
    // Sunday 2026-01-25 → Monday 26th is Australia Day → Tuesday 27th 09:00 AEDT = Mon 22:00 UTC.
    const from = new Date('2026-01-25T05:00:00Z');
    const next = nextWindowOpen(AU_RULES, 'Australia/Sydney', from);
    expect(next!.toISOString()).toBe('2026-01-26T22:00:00.000Z');
  });
});
