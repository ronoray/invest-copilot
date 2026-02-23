// Standalone script — called by deploy-invest.sh via docker exec after health check
// Usage: node /app/scripts/sendDeployEmail.mjs <sha> <branch> <time> [commitMessage]

import { sendDeployNotification } from '../services/emailService.js';

const [,, commit, branch, time, ...msgParts] = process.argv;
const commitMessage = msgParts.join(' ');
const email = process.env.ADMIN_EMAIL || process.env.EMAIL_FROM_ADDRESS;

if (!email) {
  console.error('[deploy-email] No ADMIN_EMAIL set, skipping');
  process.exit(0);
}

try {
  const result = await sendDeployNotification(email, { commit, branch, time, commitMessage });
  if (result?.success) {
    console.log(`[deploy-email] Sent to ${email} (${result.messageId})`);
  } else if (result?.disabled) {
    console.log('[deploy-email] Email notifications disabled');
  }
} catch (err) {
  // Never fail the deploy because of a notification
  console.error('[deploy-email] Failed:', err.message);
}
