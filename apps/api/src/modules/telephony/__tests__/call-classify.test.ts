import { describe, expect, it } from 'vitest';
import { finalAmdClass } from '../call-classify';

const say = (text: string, seconds = 5) => ({ text, seconds });

describe('final call classification', () => {
  it('a pressed gate that nobody answered is a gate, not a person', () => {
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, gatePressed: true, customerLines: [] })).toBe('IVR');
    expect(finalAmdClass({ amdClass: 'SILENCE', bridged: false, gatePressed: true, customerLines: [say('To connect your call,'), say('press two.')] })).toBe('IVR');
  });

  it('a mailbox after the gate is a mailbox, and a person after it is a person', () => {
    expect(
      finalAmdClass({ amdClass: 'HUMAN', bridged: false, gatePressed: true, customerLines: [say('press nine.'), say('Your call has been forwarded to voicemail.', 18)] }),
    ).toBe('VOICEMAIL');
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, gatePressed: true, customerLines: [say('press one.'), say('Hello, who is this?', 12)] })).toBe('HUMAN');
  });

  it("catches the mailbox wording of 5 Nov", () => {
    for (const greeting of ['Just leave your number, and I can ring you back.', "Hi. I'll leave you a message.", "Hello. I'm not able to get to the phone at the moment."]) {
      expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say(greeting)] })).toBe('VOICEMAIL');
    }
  });

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

  it('catches the mailboxes and carrier messages of 9 Nov, verbatim', () => {
    for (const greeting of [
      'Hi. You\'ve called West My Long Signs.',
      "I'm out of service at the moment, so please text",
      "Hi. It's Christina Dodo. I'm not available at the moment.",
      "I can get back to you as soon as possible.",
      'Just try sending a text. I\'ll get back to you as soon as I can. Thanks.',
      "David, I've missed your call. I'll call you back as soon as I can.",
      "I'm just on another call. I'll get right back to you.",
      'To you as quickly as I can. Thank you.',
      'Please try again later.',
      'Leave a number, and I\'ll call back.',
    ]) {
      expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say(greeting)] })).toBe('VOICEMAIL');
    }
  });

  it('keeps real people as people', () => {
    for (const said of ['Hello?', 'Yes, I am.', "You've called the wrong number.", "You've called me three times.", 'Good. Thanks. How are you?', 'Are you an AI?', "He's not available.", 'I am with AGL.', 'Sorry I missed your call earlier', "Who's the person you're calling?"]) {
      expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say(said)] })).toBe('HUMAN');
    }
  });

  it('does not call it a mailbox for words late in a conversation', () => {
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say('Yes'), say('Can I leave a message for him?', 70)] })).toBe('HUMAN');
  });

  it('trusts a transfer a specialist took', () => {
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: true, customerLines: [say('please leave a message')] })).toBe('HUMAN');
  });

  it('does not mistake the connect gate for a person', () => {
    const gate = [say('To connect your call, press two.'), say('To connect your call, press five.', 12)];
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: gate })).toBe('IVR');
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [...gate, say('Hello?', 25)] })).toBe('HUMAN');
    expect(finalAmdClass({ bridged: false, customerLines: [...gate, say('Please leave a message.', 25)] })).toBe('VOICEMAIL');
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say('press seven.')] })).toBe('IVR');
    expect(finalAmdClass({ amdClass: 'HUMAN', bridged: false, customerLines: [say('As this mobile phone is not monitored, please email us.')] })).toBe('VOICEMAIL');
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
