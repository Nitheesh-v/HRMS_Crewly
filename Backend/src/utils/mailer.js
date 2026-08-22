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

export const sendMail = async ({
  to,
  subject,
  html = "",
  text = "",
  sensitive = false,
}) => {
  try {
    if (!transporter) {
      logger.info(
        sensitive
          ? `📧 [MOCK EMAIL] sensitive message queued | ${subject}`
          : `📧 [MOCK EMAIL] → ${to} | ${subject}`,
      );

      if (
        !sensitive &&
        process.env.NODE_ENV !==
        "production"
      ) {
        logger.info(
          `📧 [MOCK EMAIL BODY] ${text || html}`,
        );
      }

      return { delivered: true, mode: 'MOCK', error: '' };
    }

    await transporter.sendMail({
      from:
        process.env.SMTP_FROM ||
        "Crewly HRMS <no-reply@crewly.com>",

      to,
      subject,

      html:
        html || undefined,

      text:
        text || undefined,
    });

    return { delivered: true, mode: 'SMTP', error: '' };
  } catch (error) {
    logger.warn(
      `📧 Email delivery failed: ${error.message}`,
    );

    return {
      delivered: false,
      mode: transporter ? 'SMTP' : 'MOCK',
      error: String(error.message || 'Email delivery failed').slice(0, 300),
    };
  }
};

const shell = (title, bodyHtml) => `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #2ea04355;border-radius:10px;overflow:hidden">
    <div style="background:#0d1117;color:#3fb950;padding:14px 18px;font-weight:bold">🟩 Crewly HRMS</div>
    <div style="padding:18px;color:#24292f">${bodyHtml}</div>
    <div style="padding:10px 18px;color:#8b949e;font-size:11px;border-top:1px solid #eee">${title}</div>
  </div>`;

const escapeHtml = (value) =>
  String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

export const applicationReceivedEmail = ({
  candidateName,
  companyName,
  jobTitle,
  jobCode,
  applicationReference,
}) => {
  const safeName = escapeHtml(candidateName);
  const safeCompany = escapeHtml(companyName);
  const safeTitle = escapeHtml(jobTitle);
  const safeJobCode = escapeHtml(jobCode);
  const safeReference = escapeHtml(applicationReference);

  return {
    subject: `Application received — ${String(companyName || '')
      .replace(/[\r\n]/g, ' ')
      .slice(0, 120)}`,
    text:
      `Hello ${candidateName},\n\n` +
      `${companyName} has received your application for ${jobTitle} (${jobCode}).\n` +
      `Application reference: ${applicationReference}\n\n` +
      'The hiring team will contact you if your profile is selected for a next step.',
    html: shell('This is an application receipt, not a hiring decision.', `
      <h2 style="margin:0 0 10px">Application received</h2>
      <p>Hello ${safeName},</p>
      <p><b>${safeCompany}</b> has received your application for <b>${safeTitle}</b> (${safeJobCode}).</p>
      <p style="background:#f6f8fa;padding:12px;border-radius:8px">Application reference: <b>${safeReference}</b></p>
      <p style="color:#57606a;font-size:13px">The hiring team will contact you if your profile is selected for a next step.</p>`),
  };
};

export const candidatePipelineUpdateEmail = ({
  candidateName,
  companyName,
  jobTitle,
  candidateCode,
  stage,
}) => {
  const safeName = escapeHtml(candidateName);
  const safeCompany = escapeHtml(companyName);
  const safeJobTitle = escapeHtml(jobTitle);
  const safeCandidateCode = escapeHtml(candidateCode);
  const stageLabel = String(stage || '')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const safeStage = escapeHtml(stageLabel);
  const safeSubjectCompany = String(companyName || 'the hiring team')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 120);

  return {
    subject: `Application update — ${safeSubjectCompany}`,
    text:
      `Hello ${candidateName},\n\n` +
      `${companyName} has updated your application for ${jobTitle}.\n` +
      `Current status: ${stageLabel}.\n` +
      `Application reference: ${candidateCode}.\n\n` +
      'The hiring team will contact you if any action is required.',
    html: shell('This is a standard application status notification.', `
      <h2 style="margin:0 0 10px">Application update</h2>
      <p>Hello ${safeName},</p>
      <p><b>${safeCompany}</b> has updated your application for <b>${safeJobTitle}</b>.</p>
      <p style="background:#f6f8fa;padding:12px;border-radius:8px">Current status: <b>${safeStage}</b><br/>Application reference: <b>${safeCandidateCode}</b></p>
      <p style="color:#57606a;font-size:13px">The hiring team will contact you if any action is required.</p>`),
  };
};

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