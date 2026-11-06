/**
 * Which column of an uploaded list holds which lead field, guessed from the
 * headers. Vendors name them anything ("Phone2_Mobile", "First Name", "Surname"),
 * so the guess is shown and can be changed before importing.
 */

export const LEAD_FIELDS = ['phone', 'firstName', 'lastName', 'suburb', 'state', 'postcode', 'dncrStatus'] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];
export type ColumnMapping = Partial<Record<LeadField, string>>;

export const FIELD_LABELS: Record<LeadField, string> = {
  phone: 'Phone (required)',
  firstName: 'First name',
  lastName: 'Last name',
  suburb: 'Suburb',
  state: 'State',
  postcode: 'Postcode',
  dncrStatus: 'Do Not Call status',
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

const PATTERNS: Record<LeadField, RegExp> = {
  // "mobile" beats a landline column when both exist: listed first in the scoring below.
  phone: /^(phone\d*mobile|mobile(phone|no|number)?|cell(phone)?|phone(no|number|\d)?|contact(no|number)?|tel(ephone)?|number|msisdn)$/,
  firstName: /^(firstname|first|fname|givenname|forename)$/,
  lastName: /^(lastname|last|lname|surname|familyname)$/,
  suburb: /^(suburb|city|town|locality)$/,
  state: /^(state|st|region)$/,
  postcode: /^(postcode|postalcode|zip|zipcode|pcode)$/,
  dncrStatus: /^(dncr|dnc|dncrmobilestatus|dncrstatus|dncstatus|donotcall|donotcallstatus|dncrmobile)$/,
};

export function guessMapping(headers: string[]): ColumnMapping {
  const out: ColumnMapping = {};
  for (const field of LEAD_FIELDS) {
    const hits = headers.filter((h) => PATTERNS[field].test(norm(h)));
    // A list with both a landline and a mobile column: prefer the mobile.
    const pick = field === 'phone' ? (hits.find((h) => /mobile|cell/.test(norm(h))) ?? hits[0]) : hits[0];
    if (pick) out[field] = pick;
  }
  return out;
}

/** "Y" (or "yes") in the Do Not Call column means the number is registered. */
export const onDncRegister = (value: string | undefined) => /^\s*(y|yes|true|1|registered)\s*$/i.test(value ?? '');
