import type { AmdClass } from '@cocally/shared';

/** Same wording as `_MACHINE_ONLY_PATTERNS` in agent-worker/agent.py: keep in step. */
const MACHINE_ONLY =
  /you'?ve reached|you have reached|(leave|record) (me )?(a|your) ((text|voice|short|brief|quick) )?(message|name)|after the (tone|beep)|at the (tone|beep)|please record|unable to take your call|can'?t take your call|message bank|(mobile|number|person|customer) you('?re|'?ve| are| have)? (called|calling|dialled|dialed|trying to reach) (is (not|un|switched|currently|busy)|isn'?t|has|cannot|can'?t)|switched off or not answering|(mobile|phone|number)( phone)? is not monitored|thank you for getting in touch|forwarded to (the )?(voicemail|message)|no message can be left|finished recording|leave your number|leave you a message|not able to get to the phone|welcome to the voice ?mail|voice ?mail (system|service)/i;

const CONNECT_GATE = /to connect (your|the) call|^(\S+\s+){0,7}press (zero|one|two|three|four|five|six|seven|eight|nine|\d)[.!?]?\s*$/i;

/** After this long into the call, "leave a message" is more likely a person talking about one. */
const MACHINE_WINDOW_S = 30;

export interface FinalClassInput {
  amdClass?: AmdClass;
  bridged: boolean;
  /** The worker pressed the carrier's connect gate on this call. */
  gatePressed?: boolean;
  /** What the far end said, with seconds since it answered. */
  customerLines: Array<{ text: string; seconds: number }>;
}

/**
 * What answered, decided when the call ends with the whole transcript in hand.
 * The worker decides live on partial words and can miss, or crash and decide
 * nothing: on 4 Nov that recorded 5 mailboxes as people and made the board wrong.
 * A call a specialist took was a person, whatever else is on the transcript.
 */
export function finalAmdClass({ amdClass, bridged, gatePressed, customerLines }: FinalClassInput): AmdClass | undefined {
  if (bridged) return 'HUMAN';
  // The carrier's "to connect your call, press two" is not the customer talking.
  const gateHeard = gatePressed || customerLines.some((l) => CONNECT_GATE.test(l.text));
  customerLines = customerLines.filter((l) => !CONNECT_GATE.test(l.text));
  if (gateHeard && customerLines.every((l) => !l.text.trim())) return 'IVR';
  const spoke = customerLines.some((l) => l.text.trim());
  if (customerLines.some((l) => l.seconds <= MACHINE_WINDOW_S && MACHINE_ONLY.test(l.text))) return 'VOICEMAIL';
  if (amdClass === 'SILENCE' && spoke) return 'HUMAN';
  // Answered, but nothing was heard and nothing was decided: not proof of a person.
  if (!amdClass && !spoke) return 'SILENCE';
  return amdClass;
}
