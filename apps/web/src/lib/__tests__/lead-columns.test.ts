import { describe, expect, it } from 'vitest';
import { guessMapping, onDncRegister } from '../lead-columns';
import { toCsv } from '../xlsx';

describe('guessMapping', () => {
  it("reads the CallTap list's headers", () => {
    const headers = ['Title', 'First Name', 'Last Name', 'DateOfBirth', 'Gender', 'Ad1', 'Suburb', 'State', 'Postcode', 'Phone2_Mobile', 'Dncr_Mobile_Status', 'Elec', 'Gas'];
    expect(guessMapping(headers)).toEqual({
      phone: 'Phone2_Mobile',
      firstName: 'First Name',
      lastName: 'Last Name',
      suburb: 'Suburb',
      state: 'State',
      postcode: 'Postcode',
      dncrStatus: 'Dncr_Mobile_Status',
    });
  });

  it('prefers a mobile column over a landline one', () => {
    expect(guessMapping(['Phone', 'Mobile', 'Surname']).phone).toBe('Mobile');
    expect(guessMapping(['phone', 'firstName']).phone).toBe('phone');
  });

  it('leaves unknown columns unmapped', () => {
    expect(guessMapping(['Elec', 'Gas', 'Notes'])).toEqual({});
  });
});

describe('onDncRegister', () => {
  it('treats Y as registered and N or blank as callable', () => {
    expect(onDncRegister('Y')).toBe(true);
    expect(onDncRegister(' yes ')).toBe(true);
    expect(onDncRegister('N')).toBe(false);
    expect(onDncRegister('')).toBe(false);
  });
});

describe('toCsv', () => {
  it('quotes commas and quotes, and pads short rows', () => {
    expect(toCsv([['phone', 'Ad1'], ['0412 345 678', '7 Reely St, Pymble'], ['0412'], ['x', 'say "hi"']])).toBe(
      'phone,Ad1\n0412 345 678,"7 Reely St, Pymble"\n0412,\nx,"say ""hi"""',
    );
  });
});
