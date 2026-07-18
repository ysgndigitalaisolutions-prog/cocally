/**
 * PII redaction per REC-04: phone numbers masked by default in transcripts
 * and analytics (e.g. "0412 345 062" → "04XX XXX 062"). Raw access is
 * role-gated and audited at the API layer.
 */

const PHONE_CANDIDATE = /\+?\d[\d\s-]{6,14}\d/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Masks a phone-like digit run, keeping the leading two and trailing three
 * digits, grouped 4-3-3 style: 0412345062 → 04XX XXX 062.
 */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return raw;
  const head = digits.slice(0, 2);
  const tail = digits.slice(-3);
  const masked = head + 'X'.repeat(digits.length - 5) + tail;
  const groups: string[] = [];
  let rest = masked;
  // Trailing groups of 3, leading group takes the remainder.
  while (rest.length > 4) {
    groups.unshift(rest.slice(-3));
    rest = rest.slice(0, -3);
  }
  groups.unshift(rest);
  return groups.join(' ');
}

export function redactPii(text: string): string {
  return text
    .replace(PHONE_CANDIDATE, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 8 && digits.length <= 15 ? maskPhone(m) : m;
    })
    .replace(EMAIL, '[email redacted]');
}
