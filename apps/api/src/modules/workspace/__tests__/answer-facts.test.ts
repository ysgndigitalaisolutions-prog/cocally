import { describe, expect, it } from 'vitest';
import { answerFacts } from '../answer-facts';

describe('answerFacts', () => {
  it('shows answers as label and value, and never passes the answers object on', () => {
    const { answers, rest } = answerFacts({
      answers: { fuel: 'Electricity only', retailer: 'AGL', retailerHeard: 'AGL' },
      retailerProvided: true,
      owner: true,
    });
    expect(answers).toEqual([
      { label: 'Fuel', value: 'Electricity only', confirmed: true },
      { label: 'Retailer', value: 'AGL', confirmed: true },
    ]);
    expect(rest).toEqual([['owner', true]]);
  });

  it('keeps every flag when there are no answers', () => {
    expect(answerFacts({ retailerProvided: true }).rest).toEqual([['retailerProvided', true]]);
  });
});
