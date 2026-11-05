import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { cliCandidateFilter, isValidCliNumber } from '../cli-rules';

const tenantId = new Types.ObjectId().toString();

describe('caller ID selection', () => {
  it('stays inside the campaign country', () => {
    expect(cliCandidateFilter({ tenantId, poolIds: [], countryPackCode: 'AU' })).toMatchObject({ countryPackCode: 'AU', status: 'ACTIVE' });
  });

  it('uses only the numbers ticked on the campaign', () => {
    const id = new Types.ObjectId();
    expect(cliCandidateFilter({ tenantId, poolIds: [id], countryPackCode: 'AU' })).toMatchObject({ _id: { $in: [id] } });
  });

  it('leaves the pool open when nothing is ticked', () => {
    expect(cliCandidateFilter({ tenantId, poolIds: [], countryPackCode: 'AU' })).not.toHaveProperty('_id');
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
