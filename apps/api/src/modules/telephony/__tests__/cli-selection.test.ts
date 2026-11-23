import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { cliCandidateFilter, isValidCliNumber, pickCli } from '../cli-rules';

const tenantId = new Types.ObjectId().toString();

describe('caller ID selection', () => {
  it('stays inside the campaign country', () => {
    expect(cliCandidateFilter({ tenantId, poolIds: [], countryPackCode: 'AU' })).toMatchObject({ countryPackCode: 'AU', status: 'ACTIVE' });
  });

  it('uses only the numbers ticked on the campaign', () => {
    const id = new Types.ObjectId();
    expect(cliCandidateFilter({ tenantId, poolIds: [id], countryPackCode: 'AU' })).toMatchObject({ _id: { $in: [id] } });
  });

  it("uses none when nothing is ticked, so the carrier's default number shows", () => {
    expect(cliCandidateFilter({ tenantId, poolIds: [], countryPackCode: 'AU' })).toMatchObject({ _id: { $in: [] } });
  });
});

describe('caller ID format', () => {
  it('needs the plus and a full number', () => {
    expect(isValidCliNumber('+61285316375')).toBe(true);
    expect(isValidCliNumber('61285316375')).toBe(false);
    expect(isValidCliNumber('+6128')).toBe(false);
    expect(isValidCliNumber(undefined)).toBe(false);
  });
});

describe('two calls, two numbers (23 Nov)', () => {
  const pool = [{ number: '+61390728793' }, { number: '+61390728794' }];
  it('a second call at the same time takes the other number', () => {
    for (const cursor of [0, 1, 2, 3]) {
      expect(pickCli(pool, ['+61390728793'], cursor)?.number).toBe('+61390728794');
      expect(pickCli(pool, ['+61390728794'], cursor)?.number).toBe('+61390728793');
    }
  });
  it('rotates when both are free, and still dials when both are busy', () => {
    expect(new Set([0, 1].map((c) => pickCli(pool, [], c)?.number)).size).toBe(2);
    expect(pickCli(pool, ['+61390728793', '+61390728794'], 0)).not.toBeNull();
    expect(pickCli([], [], 0)).toBeNull();
  });
});
