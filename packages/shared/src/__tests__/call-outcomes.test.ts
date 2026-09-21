import { describe, expect, it } from 'vitest';
import { CALL_END_REASONS, sipStatusToEndReason } from '../enums.js';

/**
 * This mapping is load-bearing in a way that is easy to miss: it is the only
 * thing that turns a carrier response into a `CallEndReason`, which the call
 * finaliser then turns into a `CallOutcome`, which the retry matrix acts on.
 *
 * Before it existed, BUSY / NO_ANSWER / DISCONNECTED were declared outcomes
 * that no code path could ever produce, so the entire retry matrix was dead
 * for real calls. Getting a case wrong here does not throw — it silently
 * retries a disconnected number forever, or gives up on a busy one.
 */
describe('sipStatusToEndReason', () => {
  it('treats any 2xx as a normal completed call', () => {
    expect(sipStatusToEndReason(200)).toBe('CUSTOMER_HANGUP');
    expect(sipStatusToEndReason(202)).toBe('CUSTOMER_HANGUP');
  });

  it('maps both busy codes', () => {
    // 486 is the callee's device; 600 is the network answering on its behalf.
    expect(sipStatusToEndReason(486)).toBe('BUSY');
    expect(sipStatusToEndReason(600)).toBe('BUSY');
  });

  it('maps ring-out and unavailability to NO_ANSWER, which is retryable', () => {
    expect(sipStatusToEndReason(408)).toBe('NO_ANSWER');
    expect(sipStatusToEndReason(480)).toBe('NO_ANSWER');
  });

  it('maps dead numbers to INVALID_NUMBER so they stop being retried', () => {
    expect(sipStatusToEndReason(404)).toBe('INVALID_NUMBER');
    expect(sipStatusToEndReason(410)).toBe('INVALID_NUMBER');
  });

  it('separates rejection-as-unwanted from ordinary rejection', () => {
    // 603/607/608 are the codes a callee's network or an analytics engine
    // returns when a call is being refused as unwanted. They are the earliest
    // visible signal that a CLI is being blocked, so they must NOT collapse
    // into the generic 4xx bucket — number health keys off this.
    expect(sipStatusToEndReason(603)).toBe('CARRIER_BLOCKED');
    expect(sipStatusToEndReason(607)).toBe('CARRIER_BLOCKED');
    expect(sipStatusToEndReason(608)).toBe('CARRIER_BLOCKED');
    expect(sipStatusToEndReason(488)).toBe('REJECTED');
  });

  it('maps auth failures to TRUNK_ERROR — our problem, not the lead\'s', () => {
    // A misconfigured trunk must never be recorded against the lead as a
    // failed attempt pattern; it is an operations alert.
    expect(sipStatusToEndReason(401)).toBe('TRUNK_ERROR');
    expect(sipStatusToEndReason(403)).toBe('TRUNK_ERROR');
    expect(sipStatusToEndReason(407)).toBe('TRUNK_ERROR');
  });

  it('maps 5xx to congestion', () => {
    expect(sipStatusToEndReason(500)).toBe('CONGESTION');
    expect(sipStatusToEndReason(502)).toBe('CONGESTION');
    expect(sipStatusToEndReason(503)).toBe('CONGESTION');
    expect(sipStatusToEndReason(504)).toBe('CONGESTION');
  });

  it('never returns an undeclared reason, for any status in 100..699', () => {
    for (let status = 100; status < 700; status += 1) {
      expect(CALL_END_REASONS).toContain(sipStatusToEndReason(status));
    }
  });

  it('returns UNKNOWN rather than guessing when the carrier told us nothing', () => {
    expect(sipStatusToEndReason(undefined)).toBe('UNKNOWN');
    // 1xx are provisional and should never arrive as a final status.
    expect(sipStatusToEndReason(180)).toBe('UNKNOWN');
  });
});
