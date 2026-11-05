import type { AmdClass } from '@cocally/shared';

/** Same wording as `_MACHINE_ONLY_PATTERNS` in agent-worker/agent.py: keep in step. */
const MACHINE_ONLY =
  /you'?ve reached|you have reached|(leave|record) (me )?(a|your) ((text|voice|short|brief|quick) )?(message|name)|after the (tone|beep)|at the (tone|beep)|please record|unable to take your call|can'?t take your call|message bank|(mobile|number|person|customer) you('?re|'?ve| are| have)? (called|calling|dialled|dialed|trying to reach) (is (not|un|switched|currently|busy)|isn'?t|has|cannot|can'?t)|switched off or not answering/i;

/** After this long into the call, "leave a message" is more likely a person talking about one. */
const MACHINE_WINDOW_S = 30;

export interface FinalClassInput {
  amdClass?: AmdClass;
  bridged: boolean;
  /** What the far end said, with seconds since it answered. */
  customerLines: Array<{ text: string; seconds: number }>;
}

/**
 * What answered, decided when the call ends with the whole transcript in hand.
 * The worker decides live on partial words and can miss, or crash and decide
 * nothing: on 4 Nov that recorded 5 mailboxes as people and made the board wrong.
 * A call a specialist took was a person, whatever else is on the transcript.
 */
export function finalAmdClass({ amdClass, bridged, customerLines }: FinalClassInput): AmdClass | undefined {
  if (bridged) return 'HUMAN';
  const spoke = customerLines.some((l) => l.text.trim());
  if (customerLines.some((l) => l.seconds <= MACHINE_WINDOW_S && MACHINE_ONLY.test(l.text))) return 'VOICEMAIL';
  if (amdClass === 'SILENCE' && spoke) return 'HUMAN';
  // Answered, but nothing was heard and nothing was decided: not proof of a person.
  if (!amdClass && !spoke) return 'SILENCE';
  return amdClass;
}
