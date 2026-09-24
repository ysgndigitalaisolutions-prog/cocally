import { describe, expect, it } from 'vitest';
import { normaliseAuState, timezoneFromAuPostcode } from '../au-geo';

describe('AU timezone inference helpers (LEAD-06)', () => {
  it('maps postcodes to the right zone, including 08-area ambiguity', () => {
    expect(timezoneFromAuPostcode('6000')).toBe('Australia/Perth');
    expect(timezoneFromAuPostcode('0800')).toBe('Australia/Darwin');
    expect(timezoneFromAuPostcode('5000')).toBe('Australia/Adelaide');
    expect(timezoneFromAuPostcode('7000')).toBe('Australia/Hobart');
    expect(timezoneFromAuPostcode('4000')).toBe('Australia/Brisbane');
    expect(timezoneFromAuPostcode('3000')).toBe('Australia/Melbourne');
    expect(timezoneFromAuPostcode('2000')).toBe('Australia/Sydney');
    expect(timezoneFromAuPostcode('2600')).toBe('Australia/Sydney');
    expect(timezoneFromAuPostcode('abc')).toBeNull();
    expect(timezoneFromAuPostcode(undefined)).toBeNull();
  });

  it('normalises state spellings', () => {
    expect(normaliseAuState('Western Australia')).toBe('WA');
    expect(normaliseAuState('w.a.')).toBe('WA');
    expect(normaliseAuState('nsw')).toBe('NSW');
    expect(normaliseAuState('')).toBeUndefined();
  });
});
