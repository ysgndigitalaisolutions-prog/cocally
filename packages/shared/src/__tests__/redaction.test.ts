import { describe, expect, it } from 'vitest';
import { maskPhone, redactPii } from '../redaction.js';

describe('maskPhone', () => {
  it('masks an AU mobile keeping head and tail per REC-04', () => {
    expect(maskPhone('0412345062')).toBe('04XX XXX 062');
  });

  it('masks spaced numbers', () => {
    expect(maskPhone('0412 345 062')).toBe('04XX XXX 062');
  });

  it('leaves short digit runs alone', () => {
    expect(maskPhone('1234567')).toBe('1234567');
  });
});

describe('redactPii', () => {
  it('redacts phones inside prose', () => {
    expect(redactPii('call me on 0412345062 today')).toBe('call me on 04XX XXX 062 today');
  });

  it('redacts emails', () => {
    expect(redactPii('mail bob@example.com now')).toBe('mail [email redacted] now');
  });

  it('does not touch small numbers', () => {
    expect(redactPii('my bill is 450 dollars')).toBe('my bill is 450 dollars');
  });
});
