import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Country pack per CP-01: one country's compliance, language, telephony and
 * residency rules as configuration. Packs are platform-level documents;
 * tenants assign them to campaigns (CP-03).
 */

export interface CallingWindow {
  /** ISO weekday 1=Mon … 7=Sun. */
  weekday: number;
  /** "HH:mm" local time. */
  start: string;
  end: string;
}

@Schema({ timestamps: true })
export class CountryPack {
  /** ISO 3166-1 alpha-2, e.g. "AU". */
  @Prop({ required: true, unique: true, uppercase: true })
  code: string;

  @Prop({ required: true })
  name: string;

  /** E.164 country calling code, e.g. "61". */
  @Prop({ required: true })
  dialCode: string;

  /** Default region for libphonenumber parsing. */
  @Prop({ required: true })
  phoneRegion: string;

  /** Numbers that must never be dialled (emergency etc.). */
  @Prop({ type: [String], default: [] })
  emergencyBlocklist: string[];

  /** DNC registry integration per CP-01. */
  @Prop({ type: Object, required: true })
  dnc: {
    registryName: string;
    /** Days a wash result stays valid (AU: 30). */
    washExpiryDays: number;
    enforced: boolean;
  };

  /** Legal calling hours in the lead's local timezone. */
  @Prop({ type: [Object], required: true })
  callingWindows: CallingWindow[];

  /** ISO dates on which calling is prohibited (public holidays). */
  @Prop({ type: [String], default: [] })
  publicHolidays: string[];

  /** Mandatory disclosures per CP-01 / AI-07 / AI-08. */
  @Prop({ type: Object, required: true })
  disclosures: {
    recordingDisclosureRequired: boolean;
    recordingDisclosureText: string;
    aiIdentificationDefaultOn: boolean;
    aiIdentificationText: string;
    consentRequired: boolean;
  };

  /** CLI/attestation rules, e.g. STIR/SHAKEN per TEL-07. */
  @Prop({ type: Object, default: {} })
  cliRules: { stirShakenRequired?: boolean; geoMatching?: boolean };

  /** Default STT language pack, e.g. "en-AU" per PAL-07. */
  @Prop({ required: true })
  sttLanguage: string;

  /** Preferred TTS provider ids in order. */
  @Prop({ type: [String], default: [] })
  ttsShortlist: string[];

  /** IANA timezones covered, e.g. Australia/Sydney, Australia/Brisbane. */
  @Prop({ type: [String], required: true })
  timezones: string[];

  /** Mapping used to infer a lead's timezone from its number/postcode. */
  @Prop({ type: Object, default: {} })
  timezoneHints: Record<string, string>;

  /** Data-residency region recordings must stay in per REC-02. */
  @Prop({ required: true })
  dataResidencyRegion: string;

  @Prop({ default: 365 })
  retentionDefaultDays: number;

  @Prop({ default: true })
  active: boolean;
}

export type CountryPackDocument = HydratedDocument<CountryPack>;
export const CountryPackSchema = SchemaFactory.createForClass(CountryPack);
