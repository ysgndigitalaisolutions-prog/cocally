/** Country code + local digits → E.164. A number typed with its own "+" is used as is; a leading trunk 0 is dropped. */
export function toE164(countryCode: string, local: string): string {
  const raw = local.replace(/[\s\-()]/g, '');
  if (raw.startsWith('+')) return raw;
  return countryCode + raw.replace(/^0+/, '');
}
