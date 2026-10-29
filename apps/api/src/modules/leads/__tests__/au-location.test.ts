import { describe, expect, it } from 'vitest';
import { auLocationKnown } from '../au-geo';

describe('auLocationKnown', () => {
  it('knows the location from a state or a postcode', () => {
    expect(auLocationKnown('WA', undefined, '04')).toBe(true);
    expect(auLocationKnown(undefined, '6000', '04')).toBe(true);
    expect(auLocationKnown(undefined, '3066', '04')).toBe(true);
  });

  it('knows it from a single-region landline area code', () => {
    expect(auLocationKnown(undefined, undefined, '02')).toBe(true);
    expect(auLocationKnown(undefined, undefined, '03')).toBe(true);
    expect(auLocationKnown(undefined, undefined, '07')).toBe(true);
  });

  it('does not know it for a bare mobile or an 08 landline', () => {
    expect(auLocationKnown(undefined, undefined, '04')).toBe(false);
    expect(auLocationKnown(undefined, undefined, '08')).toBe(false);
    expect(auLocationKnown(undefined, 'abc', '04')).toBe(false);
  });
});
