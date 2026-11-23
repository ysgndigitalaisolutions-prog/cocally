import { describe, expect, it } from 'vitest';
import { DEFAULT_BILLING, priceUsage } from '../billing-price';
import type { TenantUsage } from '../usage.service';

const EMPTY_USAGE: TenantUsage = { dials: 0, answered: 0, pickedUp: 0, voicemail: 0, gate: 0, noAnswer: 0, failed: 0, transfers: 0, manualDials: 0, ringSeconds: 0, aiSeconds: 0, billableAiSeconds: 0, humanSeconds: 0, recordedSeconds: 0, ttsChars: 0 };

// The quote: ₹8.50/min AI talk only when a person answered, ₹0.80 per dial;
// ₹8.00 / ₹0.70 from 10,000 AI minutes in the month, for all of that month.
describe('bill per the contract', () => {
  it('charges AI minutes only for calls a person answered (23 Nov)', () => {
    const u = { ...EMPTY_USAGE, dials: 1000, aiSeconds: 600 * 60, billableAiSeconds: 300 * 60 };
    const p = priceUsage(u, DEFAULT_BILLING);
    expect(p.aiMinutes).toBe(300);
    expect(p.lines[0]!.amountInr).toBe(2550); // 300 × 8.50, not 600 × 8.50
    expect(p.lines[1]!.amountInr).toBe(800); // 1000 × 0.80
    expect(p.subtotalInr).toBe(3350);
  });

  it('the cheaper band applies to the whole month from 10,000 billed minutes', () => {
    const p = priceUsage({ ...EMPTY_USAGE, dials: 100, billableAiSeconds: 10_000 * 60 }, DEFAULT_BILLING);
    expect(p.tier.aiPerMinInr).toBe(8);
    expect(p.tier.perDialInr).toBe(0.7);
    expect(p.subtotalInr).toBe(80_070);
  });

  it('voicemail-only time never moves the band', () => {
    const p = priceUsage({ ...EMPTY_USAGE, dials: 100, aiSeconds: 20_000 * 60, billableAiSeconds: 0 }, DEFAULT_BILLING);
    expect(p.tierIndex).toBe(0);
    expect(p.subtotalInr).toBe(80);
  });
});
