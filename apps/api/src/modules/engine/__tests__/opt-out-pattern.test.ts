import { describe, expect, it } from 'vitest';
import { OPT_OUT_PATTERN } from '../lines';

describe('OPT_OUT_PATTERN', () => {
  it.each([
    // The script's own DNC questions, verbatim.
    'My number is on the DNC Register.',
    "Don't call me again.",
    "I'll make a complaint.",
    // How they come out of the STT.
    "my number's on the do not call register",
    'I am on the D.N.C. list',
    'take me off your list',
    'stop calling me',
    "I'm going to report you to the ACMA",
    'remove my number please',
  ])('opts out on %j', (text) => {
    expect(OPT_OUT_PATTERN.test(text)).toBe(true);
  });

  it.each([
    "I'm not interested.",
    "I'm happy with my current offer.",
    'Call me back later.',
    "I'm busy right now, can you call me tomorrow?",
    "I'm with AGL.",
    'Yes, that is me.',
    'About 300 dollars a quarter.',
    'electricity and gas',
    'Sorry, who is this?',
  ])('does not opt out on %j', (text) => {
    expect(OPT_OUT_PATTERN.test(text)).toBe(false);
  });
});
