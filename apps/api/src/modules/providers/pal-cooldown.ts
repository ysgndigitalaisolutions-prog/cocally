/**
 * How long a failed provider is skipped. Only an outage (5xx, timeout,
 * network, missing key) earns the full cooldown; a rate limit 10 s; any other
 * one-off error (a 400, an unparseable reply) none. Before 29 Oct every error
 * benched the provider for 60 s process-wide, which pushed all per-turn
 * extraction onto Groq's 8k-tokens/min free tier.
 */
export function cooldownMsFor(message: string, outageMs = 60_000): number {
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return 10_000;
  if (/failed: 5\d\d|\b5\d\d\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|aborted|not configured/i.test(message)) {
    return outageMs;
  }
  return 0;
}
