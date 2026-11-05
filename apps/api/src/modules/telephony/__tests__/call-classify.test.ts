import { describe, expect, it } from 'vitest';
import { finalAmdClass } from '../call-classify';

const say = (text: string, seconds = 5) => ({ text, seconds });

describe('final call classification', () => {
  it('catches the mailboxes of 4 Nov, verbatim', () => {
    for (const greeting of [
      "Hello. You've reached zero four zero nine one two",
      'Hi. Sorry I missed your call. Please leave a text message, and I will get back to you.',
      "I'm sorry. This person is not available. If you would like to leave an additional message, please reply after the tone.",
      "To voicemail. The person you're trying to reach is not available. At the tone, please record your message.",
      "The person you're trying to reach is not available.",
    ]) {
      expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say(greeting)] })).toBe('VOICEMAIL');
    }
  });

  it('keeps real people as people', () => {
    for (const said of ['Hello?', 'Yes, I am.', "He's not available.", 'I am with AGL.', 'Sorry I missed your call earlier', "Who's the person you're calling?"]) {
      expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say(said)] })).toBe('HUMAN');
    }
  });

  it('does not call it a mailbox for words late in a conversation', () => {
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say('Yes'), say('Can I leave a message for him?', 70)] })).toBe('HUMAN');
  });

  it('trusts a transfer a specialist took', () => {
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: true, customerLines: [say('please leave a message')] })).toBe('HUMAN');
  });

  it('never calls an unclassified silent call a person', () => {
    expect(finalAmdClass({ bridged: false, customerLines: [] })).toBe('SILENCE');
  });

  it('corrects a silence guess when the customer did speak', () => {
    expect(finalAmdClass({ amdClass: 'SILENCE', bridged: false, customerLines: [say('Yeah')] })).toBe('HUMAN');
  });

  it('leaves a worker verdict alone when nothing contradicts it', () => {
    expect(finalAmdClass({ amdClass: 'IVR', bridged: false, customerLines: [say('Press one for sales')] })).toBe('IVR');
    expect(finalAmdClass({ bridged: false, customerLines: [say('Hello?')] })).toBeUndefined();
  });
});
