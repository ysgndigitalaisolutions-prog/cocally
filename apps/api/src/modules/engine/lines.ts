/**
 * Spoken when an opt-out rail fires (live worker and simulation alike).
 * Wording from the campaign call script's DNC answer.
 */
export const OPT_OUT_CLOSING_LINE =
  "I'm sorry to have bothered you. I'll record your request so your number can be excluded from future calls. Thank you for your time. Goodbye.";

/**
 * What "take me off your list" sounds like, for every opt-out rail (live
 * worker transcripts and the simulation path). One pattern so the two cannot
 * drift: until 25 Oct the simulation copy had six phrases and the live one
 * missed the script's own Q&A ("My number is on the DNC Register", "I'll make
 * a complaint"), which ended the call without writing the suppression.
 *
 * A complaint threat is treated as an opt-out on purpose: the script's answer
 * to it is the DNC goodbye, and calling that person again is the complaint.
 * "Not interested" is NOT here: the script answers it with the two-minute ask.
 */
export const OPT_OUT_PATTERN = new RegExp(
  String.raw`\b(?:` +
  [
    String.raw`don'?t (call|ring|contact|phone)( me)?( again| back)?`,
    String.raw`do not (call|ring|contact|phone)`,
    String.raw`stop (calling|ringing|phoning)`,
    String.raw`never (call|ring) (me|here|this number)`,
    String.raw`remove (me|my (number|details))`,
    String.raw`take (me|my (number|details)) off`,
    String.raw`unsubscribe`,
    String.raw`no more calls`,
    String.raw`delete my (number|details)`,
    String.raw`d\.? ?n\.? ?c\b`,
    String.raw`do[ -]not[ -]call`,
    String.raw`not interested in (any|being) call`,
    String.raw`(make|lodge|file|put in|raise|making|lodging) a complaint`,
    String.raw`(i'?ll|i will|i'?m going to|gonna|going to) (complain|report)`,
    String.raw`report (you|this|your company)`,
    String.raw`\bacma\b`,
    String.raw`ombudsman`,
  ].join('|') +
    ')',
  'i',
);
