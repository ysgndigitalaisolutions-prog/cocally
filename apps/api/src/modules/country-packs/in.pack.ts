import type { CountryPack } from '../../schemas/country-pack.schema';

/**
 * India pack for INTERNAL TESTING ONLY: lets the team dial its own verified
 * Indian numbers through the Twilio trunk before the AU pilot goes live.
 *
 * DNC washing is off (no NCPR/TRAI DND integration exists), so this pack must
 * never be used to call customers. Calling hours follow the TRAI commercial
 * communication window, 09:00-21:00 IST, every day.
 */
export const IN_PACK: CountryPack = {
  code: 'IN',
  name: 'India (internal testing only)',
  dialCode: '91',
  phoneRegion: 'IN',
  emergencyBlocklist: ['100', '101', '102', '108', '112'],
  dnc: { registryName: 'none (internal testing only)', washExpiryDays: 30, enforced: false },
  callingWindows: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '21:00' })),
  // National holidays 2026 (Republic Day, Independence Day, Gandhi Jayanti).
  publicHolidays: ['2026-01-26', '2026-08-15', '2026-10-02'],
  publicHolidaysByZone: {},
  disclosures: {
    recordingDisclosureRequired: true,
    recordingDisclosureText: 'This call may be recorded for quality and training purposes.',
    aiIdentificationDefaultOn: true,
    aiIdentificationText: "I'm a virtual assistant calling on behalf of {{clientName}}.",
    consentRequired: true,
  },
  cliRules: { stirShakenRequired: false, geoMatching: false },
  sttLanguage: 'en-IN',
  ttsShortlist: ['elevenlabs', 'google', 'azure'],
  timezones: ['Asia/Kolkata'],
  timezoneHints: {},
  dataResidencyRegion: 'in',
  retentionDefaultDays: 90,
  active: true,
};
