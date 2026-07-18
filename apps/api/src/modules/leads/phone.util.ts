import { parsePhoneNumberFromString } from 'libphonenumber-js';

export interface NormalizedPhone {
  e164: string;
  lineType: 'MOBILE' | 'LANDLINE' | 'UNKNOWN';
  areaHint: string;
}

/**
 * Forgiving number parsing per LEAD-01: accepts "04xx", "61x", spaces,
 * dashes, parens; returns E.164 or null with a reason.
 */
export function normalizePhone(raw: string, region: string): { ok: true; value: NormalizedPhone } | { ok: false; reason: string } {
  const cleaned = raw.trim();
  if (!cleaned) return { ok: false, reason: 'empty number' };

  const parsed = parsePhoneNumberFromString(cleaned, region as never);
  if (!parsed) return { ok: false, reason: 'unparseable number' };
  if (!parsed.isValid()) return { ok: false, reason: 'invalid number for region' };

  const type = parsed.getType();
  const lineType = type === 'MOBILE' ? 'MOBILE' : type === 'FIXED_LINE' ? 'LANDLINE' : 'UNKNOWN';

  // National area hint for geo CLI matching and timezone inference:
  // AU landlines → "02"/"03"/"07"/"08"; mobiles → "04".
  const national = parsed.formatNational().replace(/\D/g, '');
  const areaHint = national.slice(0, 2);

  return { ok: true, value: { e164: parsed.number, lineType, areaHint } };
}
