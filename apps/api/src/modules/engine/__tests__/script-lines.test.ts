import { describe, expect, it } from 'vitest';
import { extractScriptLines } from '../lines';

describe('extractScriptLines', () => {
  it('reads tagged lines, repeat questions and playbook answers', () => {
    const text = [
      'Step 1:',
      '[S1] "This is Daniel. Are you the account holder?"',
      'Repeat question: [S1Q] "Are you the account holder?"',
      '- If NO: say [E1] "No worries. Have a great day!" and then call end_call.',
      '- If they say "Where from?": Say: [Q1] "I\'m calling from Australian Deal."',
    ].join('\n');
    expect(extractScriptLines(text)).toEqual({
      S1: 'This is Daniel. Are you the account holder?',
      S1Q: 'Are you the account holder?',
      E1: 'No worries. Have a great day!',
      Q1: "I'm calling from Australian Deal.",
    });
  });

  it('is not fooled by an example that ends in a tag (29 Oct bug)', () => {
    const text = [
      'React first, e.g. "I\'m doing well, thanks for asking! [S1]". One step per turn.',
      '[S1] "This is Daniel. Are you the account holder?"',
    ].join('\n');
    expect(extractScriptLines(text).S1).toBe('This is Daniel. Are you the account holder?');
  });
});
