import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../phone.util';

describe('normalizePhone (LEAD-01/02)', () => {
  it('normalises 04xx mobiles to E.164', () => {
    const result = normalizePhone('0412 345 678', 'AU');
    expect(result).toEqual({ ok: true, value: { e164: '+61412345678', lineType: 'MOBILE', areaHint: '04' } });
  });

  it('accepts 61-prefixed numbers', () => {
    const result = normalizePhone('61412345678', 'AU');
    expect(result.ok && result.value.e164).toBe('+61412345678');
  });

  it('accepts dashes and parens on landlines', () => {
    const result = normalizePhone('(03) 9123-4567', 'AU');
    expect(result.ok && result.value.e164).toBe('+61391234567');
    expect(result.ok && result.value.lineType).toBe('LANDLINE');
    expect(result.ok && result.value.areaHint).toBe('03');
  });

  it('rejects garbage', () => {
    expect(normalizePhone('not-a-number', 'AU').ok).toBe(false);
    expect(normalizePhone('', 'AU').ok).toBe(false);
    expect(normalizePhone('12345', 'AU').ok).toBe(false);
  });
});
