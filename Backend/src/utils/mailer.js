// ─────────────────────────────────────────────────────────────
// Mailer — dual mode:
//   SMTP_HOST set  → real emails via nodemailer
//   SMTP_HOST blank → "mock": emails printed to backend console
// sendMail NEVER throws — email issues must not break requests.
// ─────────────────────────────────────────────────────────────
import nodemailer from 'nodemailer';
import logger from '../config/logger.js';

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  logger.info('📧 Mailer: SMTP mode (real emails)');
} else {
  logger.info('📧 Mailer: MOCK mode (emails logged to console — set SMTP_* to send real mail)');
}

export const sendMail = async ({ to, subject, html }) => {
  try {
    if (!transporter) {
      logger.info(`📧 [MOCK EMAIL] → ${to} | ${subject}`);
      return;
    }
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'Crewly HRMS <no-reply@crewly.com>',
      to, subject, html,
    });
  } catch (err) {
    logger.warn(`📧 Email to ${to} failed: ${err.message}`); // non-fatal by design
  }
};

const shell = (title, bodyHtml) => `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #2ea04355;border-radius:10px;overflow:hidden">
    <div style="background:#0d1117;color:#3fb950;padding:14px 18px;font-weight:bold">🟩 Crewly HRMS</div>
    <div style="padding:18px;color:#24292f">${bodyHtml}</div>
    <div style="padding:10px 18px;color:#8b949e;font-size:11px;border-top:1px solid #eee">${title}</div>
  </div>`;

// Credentials email (new user / converted candidate)
export const welcomeEmail = ({ name, email, password, companyName, code }) => ({
  subject: `Welcome to ${companyName || 'Crewly HRMS'} — your login credentials`,
  html: shell('You received this because an account was created for you.', `
    <h2 style="margin:0 0 10px">Welcome, ${name}! 👋</h2>
    <p>Your <b>${companyName || 'company'}</b> HRMS account is ready:</p>
    <table style="background:#f6f8fa;padding:12px;border-radius:8px;font-size:14px">
      <tr><td style="padding:4px 10px">Company code</td><td><b>${code || ''}</b></td></tr>
      <tr><td style="padding:4px 10px">Login email</td><td><b>${email}</b></td></tr>
      <tr><td style="padding:4px 10px">Temp password</td><td><b style="font-family:monospace">${password}</b></td></tr>
    </table>
    <p style="color:#57606a;font-size:13px">Tip: ask your admin to reset your password after first login (Users → Reset PW).</p>`),
});

// Payment receipt email
export const receiptEmail = ({ companyName, planName, amount, months, endDate, paymentId }) => ({
  subject: `Payment received — ${planName} plan activated 🎉`,
  html: shell('Thanks for choosing Crewly HRMS.', `
    <h2 style="margin:0 0 10px">Payment successful ✅</h2>
    <p><b>${companyName}</b> is now on the <b>${planName}</b> plan.</p>
    <table style="background:#f6f8fa;padding:12px;border-radius:8px;font-size:14px">
      <tr><td style="padding:4px 10px">Amount</td><td><b>₹${amount.toLocaleString('en-IN')}</b></td></tr>
      <tr><td style="padding:4px 10px">Duration</td><td>${months} month(s)</td></tr>
      <tr><td style="padding:4px 10px">Valid until</td><td><b>${new Date(endDate).toLocaleDateString('en-IN')}</b></td></tr>
      <tr><td style="padding:4px 10px">Payment ID</td><td style="font-family:monospace">${paymentId}</td></tr>
    </table>`),
});