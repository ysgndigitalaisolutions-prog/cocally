import { describe, expect, it } from 'vitest';
import { playFromAnswer } from '../recording-url';

describe('playFromAnswer', () => {
  it('skips the ring, keeping the start of the answer', () => {
    expect(playFromAnswer('https://x/a.ogg?sig=1', 19_458)).toBe('https://x/a.ogg?sig=1#t=16');
  });

  it('plays from the start when the ring was short or unknown', () => {
    expect(playFromAnswer('https://x/a.ogg', 2_000)).toBe('https://x/a.ogg');
    expect(playFromAnswer('https://x/a.ogg', undefined)).toBe('https://x/a.ogg');
  });
});
