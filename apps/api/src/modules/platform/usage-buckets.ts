import type { CallOutcome } from '@cocally/shared';

/**
 * Where every finished call lands on the usage board, so the tiles add up to
 * Calls. Before this, "No answer" was whatever was left over: 6 calls the carrier
 * refused with a 503 (4 Nov), which never rang, showed as customers not answering.
 */
export const OUTCOME_BUCKETS: Record<'pickedUp' | 'voicemail' | 'gate' | 'noAnswer' | 'failed', CallOutcome[]> = {
  pickedUp: ['ANSWERED_HUMAN', 'CALLBACK_REQUESTED', 'OPT_OUT', 'ABANDONED'],
  voicemail: ['ANSWERED_VOICEMAIL'],
  gate: ['ANSWERED_IVR'],
  noAnswer: ['NO_ANSWER', 'BUSY'],
  failed: ['FAILED', 'DISCONNECTED'],
};

/** Mongo expression: 1 when the call's outcome is in the bucket. */
export const inBucket = (bucket: keyof typeof OUTCOME_BUCKETS) => ({
  $cond: [{ $in: ['$outcome', OUTCOME_BUCKETS[bucket]] }, 1, 0],
});
