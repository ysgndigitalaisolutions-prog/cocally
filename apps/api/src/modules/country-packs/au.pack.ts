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
  // State/territory holidays, keyed by the lead's IANA zone (the Telemarketing
  // Industry Standard applies at the callee's location). 2026 dates; extend yearly.
  publicHolidaysByZone: {
    'Australia/Sydney': ['2026-06-08', '2026-10-05', '2027-01-01', '2027-01-26'], // NSW/ACT: King's Birthday, Labour Day
    'Australia/Melbourne': ['2026-03-09', '2026-06-08', '2026-09-25', '2026-11-03', '2027-01-01', '2027-01-26'], // VIC: Labour Day, King's Birthday, AFL Grand Final Friday, Melbourne Cup
    'Australia/Brisbane': ['2026-05-04', '2026-10-05', '2027-01-01', '2027-01-26'], // QLD: Labour Day, King's Birthday
    'Australia/Adelaide': ['2026-03-09', '2026-06-08', '2026-10-05', '2027-01-01', '2027-01-26'], // SA: Adelaide Cup, King's Birthday, Labour Day
    'Australia/Perth': ['2026-03-02', '2026-06-01', '2026-09-28', '2027-01-01', '2027-01-26'], // WA: Labour Day, WA Day, King's Birthday
    'Australia/Hobart': ['2026-03-09', '2026-06-08', '2026-11-02', '2027-01-01', '2027-01-26'], // TAS: Eight Hours Day, King's Birthday, Recreation Day
    'Australia/Darwin': ['2026-05-04', '2026-06-08', '2026-08-03', '2027-01-01', '2027-01-26'], // NT: May Day, King's Birthday, Picnic Day
  },
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
