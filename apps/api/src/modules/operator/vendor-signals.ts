export type VendorId = 'google' | 'livekit' | 'telvoq' | 'deepgram' | 'cartesia' | 'elevenlabs' | 'cerebras' | 'groq';

const BILLING_ERROR =
  /(status|http|code|error|sip)[^\d\n]{0,16}402\b|payment required|insufficient[ _](funds|credits?|balance|quota)|out of credits|credits? (exhausted|exceeded)|exceeded your (current )?quota|billing[ _](is[ _])?(disabled|not[ _]enabled)|account (is )?suspended|delinquent/i;

const VENDOR_WORDS: Array<[VendorId, RegExp]> = [
  ['cartesia', /cartesia/i],
  ['elevenlabs', /eleven ?labs/i],
  ['deepgram', /deepgram/i],
  ['cerebras', /cerebras/i],
  ['groq', /groq/i],
  ['google', /vertex|gemini|googleapis|billing[ _]disabled/i],
  ['livekit', /livekit/i],
  ['telvoq', /telvoq|sip /i],
];

/** Which vendor a worker log line blames for a billing failure, or null. Rate limits (429) are not billing. */
export function billingFailureVendor(line: string): VendorId | 'unknown' | null {
  if (!BILLING_ERROR.test(line)) return null;
  return VENDOR_WORDS.find(([, words]) => words.test(line))?.[0] ?? 'unknown';
}

export type VendorStatus = 'OK' | 'WARN' | 'PROBLEM' | 'UNKNOWN';

/** One rule for every vendor: a rejected key or a billing failure today is a problem. */
export function vendorStatus(s: { keyOk: boolean | null; billingFailures24h: number; billingFailures7d: number; carrierFailures24h?: number; lastUsedAt: Date | null }): VendorStatus {
  if (s.keyOk === false || s.billingFailures24h > 0) return 'PROBLEM';
  if (s.billingFailures7d > 0 || (s.carrierFailures24h ?? 0) > 0) return 'WARN';
  if (s.keyOk === null && !s.lastUsedAt) return 'UNKNOWN';
  return 'OK';
}
