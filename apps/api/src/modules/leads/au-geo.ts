/** Pure AU geography helpers for lead import (no Nest/Mongoose imports, so they are unit-testable). */

/** AU postcode ranges → IANA zone. Returns null when unknown. */
export function timezoneFromAuPostcode(postcode?: string): string | null {
  if (!postcode) return null;
  const n = Number(postcode.replace(/\D/g, ''));
  if (!Number.isInteger(n) || postcode.replace(/\D/g, '').length !== 4) return null;
  if ((n >= 800 && n <= 999)) return 'Australia/Darwin';
  if ((n >= 200 && n <= 299) || (n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return 'Australia/Sydney'; // ACT
  if ((n >= 1000 && n <= 2999)) return 'Australia/Sydney';
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return 'Australia/Melbourne';
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return 'Australia/Brisbane';
  if ((n >= 5000 && n <= 5999)) return 'Australia/Adelaide';
  if ((n >= 6000 && n <= 6999)) return 'Australia/Perth';
  if ((n >= 7000 && n <= 7999)) return 'Australia/Hobart';
  return null;
}

/** "Western Australia", "wa", "W.A." → WA. Unknown → undefined. */
export function normaliseAuState(raw: string): string | undefined {
  const key = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (!key) return undefined;
  const map: Record<string, string> = {
    NSW: 'NSW', NEWSOUTHWALES: 'NSW',
    VIC: 'VIC', VICTORIA: 'VIC',
    QLD: 'QLD', QUEENSLAND: 'QLD',
    SA: 'SA', SOUTHAUSTRALIA: 'SA',
    WA: 'WA', WESTERNAUSTRALIA: 'WA',
    TAS: 'TAS', TASMANIA: 'TAS',
    NT: 'NT', NORTHERNTERRITORY: 'NT',
    ACT: 'ACT', AUSTRALIANCAPITALTERRITORY: 'ACT',
  };
  return map[key] ?? raw.toUpperCase();
}
