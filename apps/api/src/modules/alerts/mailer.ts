import { config } from '../../common/config';

/** Sends one email through Resend's HTTP API. Throws with Resend's message on failure. */
export async function sendAlertEmail(to: string[], subject: string, text: string, html: string): Promise<void> {
  const key = config.alertEmail.resendApiKey;
  if (!key) throw new Error('RESEND_API_KEY is not set on the server');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.alertEmail.from, to, subject, text, html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
