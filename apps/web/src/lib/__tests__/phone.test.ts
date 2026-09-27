import { describe, expect, it } from 'vitest';
import { toE164 } from '../phone';

describe('toE164', () => {
  it('prefixes the country code and strips spaces', () => {
    expect(toE164('+91', '99023 52425')).toBe('+919902352425');
  });
  it('drops a leading trunk zero', () => {
    expect(toE164('+61', '0408 988 859')).toBe('+61408988859');
  });
  it('keeps a number typed with its own +', () => {
    expect(toE164('+91', '+61 408 988 859')).toBe('+61408988859');
  });
});
