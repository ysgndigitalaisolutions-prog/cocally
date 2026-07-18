import type { CountryPack } from '../../schemas/country-pack.schema';

/**
 * Australia launch pack per CP-02: ACMA DNC wash with 30-day expiry,
 * telemarketing hours (weekdays 09:00-20:00, Sat 09:00-17:00, no Sundays or
 * public holidays), en-AU STT, AU data residency.
 */
export const AU_PACK: CountryPack = {
  code: 'AU',
  name: 'Australia',
  dialCode: '61',
  phoneRegion: 'AU',
  emergencyBlocklist: ['000', '112', '106'],
  dnc: { registryName: 'ACMA Do Not Call Register', washExpiryDays: 30, enforced: true },
  callingWindows: [
    { weekday: 1, start: '09:00', end: '20:00' },
    { weekday: 2, start: '09:00', end: '20:00' },
    { weekday: 3, start: '09:00', end: '20:00' },
    { weekday: 4, start: '09:00', end: '20:00' },
    { weekday: 5, start: '09:00', end: '20:00' },
    { weekday: 6, start: '09:00', end: '17:00' },
    // No Sundays (weekday 7 absent).
  ],
  // National public holidays 2026; state holidays layered in per timezone later.
  publicHolidays: ['2026-01-01', '2026-01-26', '2026-04-03', '2026-04-04', '2026-04-06', '2026-04-25', '2026-12-25', '2026-12-26', '2026-12-28'],
  disclosures: {
    recordingDisclosureRequired: true,
    recordingDisclosureText: 'This call may be recorded for quality and training purposes.',
    aiIdentificationDefaultOn: true,
    aiIdentificationText: "I'm a virtual assistant calling on behalf of {{clientName}}.",
    consentRequired: true,
  },
  cliRules: { stirShakenRequired: false, geoMatching: true },
  sttLanguage: 'en-AU',
  ttsShortlist: ['elevenlabs', 'google', 'azure'],
  timezones: [
    'Australia/Sydney',
    'Australia/Melbourne',
    'Australia/Brisbane',
    'Australia/Adelaide',
    'Australia/Perth',
    'Australia/Hobart',
    'Australia/Darwin',
  ],
  // Area-code and mobile-postcode hints for timezone inference per LEAD-06.
  timezoneHints: {
    '02': 'Australia/Sydney',
    '03': 'Australia/Melbourne',
    '07': 'Australia/Brisbane',
    '08': 'Australia/Adelaide',
  },
  dataResidencyRegion: 'au',
  retentionDefaultDays: 365,
  active: true,
};
