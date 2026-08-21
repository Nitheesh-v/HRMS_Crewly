// ─────────────────────────────────────────────────────────────
// Recruitment email templates (Phase 27).
// Uses the existing utils/mailer.js sendMail — which is MOCK when
// SMTP is not configured and NEVER throws.
//
// Phase 27 Batch A: requisition emails only.
// Later batches add candidate / interview / offer templates here.
// ─────────────────────────────────────────────────────────────
import { sendMail } from './mailer.js';

const shell = (footer, bodyHtml) => `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #2ea04355;border-radius:10px;overflow:hidden">
    <div style="background:#0d1117;color:#3fb950;padding:14px 18px;font-weight:bold">Crewly HRMS · Recruitment</div>
    <div style="padding:18px;color:#24292f">${bodyHtml}</div>
    <div style="padding:10px 18px;color:#8b949e;font-size:11px;border-top:1px solid #eee">${footer}</div>
  </div>`;

const row = (k, v) =>
  `<tr><td style="padding:4px 10px;color:#57606a">${k}</td><td style="padding:4px 10px"><b>${v}</b></td></tr>`;

const table = (rows) =>
  `<table style="background:#f6f8fa;padding:10px;border-radius:8px;font-size:14px;width:100%">${rows.join('')}</table>`;

export const appUrl = (path = '') =>
  `${(process.env.APP_PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '')}${path}`;

// ── Internal: requisition submitted → HR reviewers ──────────────
export const requisitionSubmittedEmail = ({
  code,
  position,
  openings,
  priority,
  requesterName,
  departmentName,
  companyName,
}) => ({
  subject: `New hiring request ${code} — ${position}`,
  html: shell('You receive this because you review hiring requests.', `
    <h2 style="margin:0 0 10px">Hiring request submitted</h2>
    <p><b>${requesterName}</b> raised a hiring request for <b>${companyName}</b>.</p>
    ${table([
      row('Reference', code),
      row('Position', position),
      row('Department', departmentName || '—'),
      row('Openings', openings),
      row('Priority', priority),
    ])}
    <p style="margin-top:14px">
      <a href="${appUrl('/app/recruitment/requisitions/review')}"
         style="background:#4f46e5;color:#fff;padding:9px 16px;border-radius:7px;text-decoration:none">
        Review request
      </a>
    </p>`),
});

// ── Internal: HR decision → requester ───────────────────────────
export const requisitionDecisionEmail = ({
  code,
  position,
  decision,
  reason,
  reviewerName,
}) => {
  const titles = {
    APPROVED: 'Your hiring request was approved',
    REJECTED: 'Your hiring request was rejected',
    SENT_BACK: 'Your hiring request needs changes',
  };

  return {
    subject: `${code} — ${titles[decision] || 'Hiring request updated'}`,
    html: shell('Crewly recruitment notification.', `
      <h2 style="margin:0 0 10px">${titles[decision] || 'Request updated'}</h2>
      ${table([
        row('Reference', code),
        row('Position', position),
        row('Decision', decision.replace('_', ' ')),
        row('Reviewed by', reviewerName || 'HR'),
        ...(reason ? [row('Comments', reason)] : []),
      ])}
      <p style="margin-top:14px">
        <a href="${appUrl('/app/recruitment/requisitions')}"
           style="background:#4f46e5;color:#fff;padding:9px 16px;border-radius:7px;text-decoration:none">
          Open requisition
        </a>
      </p>`),
  };
};

// Convenience: send without ever breaking the request.
export const sendRecruitmentMail = async (to, template) => {
  if (!to) return;
  await sendMail({ to, subject: template.subject, html: template.html });
};

export default { sendRecruitmentMail, requisitionSubmittedEmail, requisitionDecisionEmail };
