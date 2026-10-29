import { describe, expect, it } from 'vitest';
import { cooldownMsFor } from '../pal-cooldown';

describe('cooldownMsFor', () => {
  it('benches a provider for a minute on an outage', () => {
    expect(cooldownMsFor('Cerebras completion failed: 503')).toBe(60_000);
    expect(cooldownMsFor('fetch failed')).toBe(60_000);
    expect(cooldownMsFor('The operation was aborted due to timeout')).toBe(60_000);
    expect(cooldownMsFor('Anthropic API key not configured')).toBe(60_000);
  });

  it('only briefly on a rate limit', () => {
    expect(cooldownMsFor('Groq completion failed: 429')).toBe(10_000);
  });

  it('not at all on a one-off error', () => {
    expect(cooldownMsFor('Cerebras completion failed: 400')).toBe(0);
    expect(cooldownMsFor('Unexpected token < in JSON at position 0')).toBe(0);
  });
});
