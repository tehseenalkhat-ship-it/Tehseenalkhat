import { config } from './config.js';

/**
 * Sends an email via Resend (free tier: 3,000/month, 100/day — genuinely free,
 * simple API-key auth, no domain verification required to start with their
 * shared sending domain). If RESEND_API_KEY isn't set, this logs the email to
 * the console instead of failing — lets you test the reset-password flow
 * locally before setting up a real provider.
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  if (!config.resendApiKey) {
    console.log('--- EMAIL (no RESEND_API_KEY set, printing instead of sending) ---');
    console.log(`To: ${to}\nSubject: ${subject}\n\n${body}`);
    console.log('-------------------------------------------------------------------');
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to,
      subject,
      text: body,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to send email via Resend: ${response.status} ${errText}`);
  }
}
