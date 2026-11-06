import { describe, expect, it } from 'vitest';
import { usableFirstName } from '../first-name';

describe('usableFirstName', () => {
  it('speaks a real first name, title-cased', () => {
    expect(usableFirstName('Karen')).toBe('Karen');
    expect(usableFirstName('JOANNA')).toBe('Joanna');
    expect(usableFirstName(" o'brien ")).toBe("O'brien");
  });

  it('falls back when there is nothing fit to say', () => {
    for (const raw of ['', '  ', 'J', 'Mr', 'MRS', 'Unknown', 'Test', '1234', 'Mary Jane', null, undefined]) {
      expect(usableFirstName(raw)).toBeNull();
    }
  });
});
