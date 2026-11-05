import { describe, expect, it } from 'vitest';
import { billingFailureVendor, vendorStatus } from '../vendor-signals';

describe('billing failures in worker logs', () => {
  it('names the vendor', () => {
    expect(billingFailureVendor('cartesia TTS error status 402 Payment Required')).toBe('cartesia');
    expect(billingFailureVendor('elevenlabs: quota_exceeded insufficient credits')).toBe('elevenlabs');
    expect(billingFailureVendor('Vertex 403 BILLING_DISABLED for project')).toBe('google');
    expect(billingFailureVendor('You exceeded your current quota, groq')).toBe('groq');
  });

  it('ignores normal lines and rate limits', () => {
    for (const line of [
      'Cerebras 429 high traffic',
      'net provider tts api.cartesia.ai round trip=224 ms',
      'room audio: frames=421 audio=21.1s peak=4020',
      'room audio: frames=402 audio=20.1s sr=24000',
      'latency 402 ms',
      'tts_ttfb=0.32s acquire=0.000s',
    ]) {
      expect(billingFailureVendor(line)).toBeNull();
    }
  });
});

describe('vendor status', () => {
  const quiet = { keyOk: true, billingFailures24h: 0, billingFailures7d: 0, lastUsedAt: null };
  it('reads the signals', () => {
    expect(vendorStatus(quiet)).toBe('OK');
    expect(vendorStatus({ ...quiet, keyOk: false })).toBe('PROBLEM');
    expect(vendorStatus({ ...quiet, billingFailures24h: 1, billingFailures7d: 1 })).toBe('PROBLEM');
    expect(vendorStatus({ ...quiet, billingFailures7d: 1 })).toBe('WARN');
    expect(vendorStatus({ ...quiet, carrierFailures24h: 2 })).toBe('WARN');
    expect(vendorStatus({ ...quiet, keyOk: null })).toBe('UNKNOWN');
  });
});
