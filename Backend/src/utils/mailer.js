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
      const runtimeMode = process.env.NODE_ENV || 'development';
      if (!['development', 'test'].includes(runtimeMode)) {
        logger.warn(`Email delivery unavailable outside local/test mode | ${subject}`);
        return {
          delivered: false,
          mode: 'MOCK',
          error: 'SMTP is not configured',
        };
      }

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

export const candidateInterviewEmail = ({
  event,
  candidateName,
  companyName,
  jobTitle,
  interviewCode,
  roundName,
  scheduleLabel,
  interviewType,
  meetingLink = '',
  location = '',
  instructions = '',
}) => {
  const eventLabel = {
    SCHEDULED: 'scheduled',
    RESCHEDULED: 'rescheduled',
    CANCELLED: 'cancelled',
    REMINDER: 'reminder',
  }[event] || 'updated';
  const isReminder = event === 'REMINDER';
  const statusVerb = isReminder ? 'is scheduled' : `has been ${eventLabel}`;
  const safeEventLabel = escapeHtml(eventLabel);
  const safeName = escapeHtml(candidateName);
  const safeCompany = escapeHtml(companyName);
  const safeJobTitle = escapeHtml(jobTitle);
  const safeCode = escapeHtml(interviewCode);
  const safeRound = escapeHtml(roundName);
  const safeSchedule = escapeHtml(scheduleLabel);
  const safeType = escapeHtml(interviewType);
  const safeLocation = escapeHtml(location);
  const safeInstructions = escapeHtml(instructions).replaceAll('\n', '<br/>');
  const safeMeetingLink = /^https:\/\//i.test(meetingLink)
    ? escapeHtml(meetingLink)
    : '';
  const subjectCompany = String(companyName || 'Hiring team')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 100);
  const scheduleText = event === 'CANCELLED'
    ? 'The hiring team will contact you if another step is required.'
    : `Schedule: ${scheduleLabel}\nType: ${interviewType}` +
      (meetingLink ? `\nMeeting link: ${meetingLink}` : '') +
      (location ? `\nLocation: ${location}` : '') +
      (instructions ? `\nInstructions: ${instructions}` : '');
  const scheduleHtml = event === 'CANCELLED'
    ? '<p>The hiring team will contact you if another step is required.</p>'
    : `<p style="background:#f6f8fa;padding:12px;border-radius:8px">
        Schedule: <b>${safeSchedule}</b><br/>
        Type: <b>${safeType}</b>
        ${safeMeetingLink ? `<br/>Meeting link: <a href="${safeMeetingLink}">${safeMeetingLink}</a>` : ''}
        ${safeLocation ? `<br/>Location: ${safeLocation}` : ''}
      </p>
      ${safeInstructions ? `<p><b>Instructions</b><br/>${safeInstructions}</p>` : ''}`;

  return {
    subject: isReminder ? `Interview reminder — ${subjectCompany}` : `Interview ${eventLabel} — ${subjectCompany}`,
    text:
      `Hello ${candidateName},\n\n` +
      (isReminder
        ? `This is a reminder that your ${roundName} interview for ${jobTitle} with ${companyName} is scheduled.`
        : `Your ${roundName} interview for ${jobTitle} with ${companyName} has been ${eventLabel}.`) +
      `\nInterview reference: ${interviewCode}\n${scheduleText}`,
    html: shell('This message concerns an interview schedule, not a hiring decision.', `
      <h2 style="margin:0 0 10px">Interview ${isReminder ? 'reminder' : safeEventLabel}</h2>
      <p>Hello ${safeName},</p>
      <p>${isReminder
        ? `This is a reminder that your <b>${safeRound}</b> interview for <b>${safeJobTitle}</b> with <b>${safeCompany}</b> is scheduled.`
        : `Your <b>${safeRound}</b> interview for <b>${safeJobTitle}</b> with <b>${safeCompany}</b> ${escapeHtml(statusVerb)}.`}</p>
      <p>Interview reference: <b>${safeCode}</b></p>
      ${scheduleHtml}`),
  };
};

export const interviewerAssignmentEmail = ({
  event,
  interviewerName,
  candidateName,
  candidateEmail,
  companyName,
  jobTitle,
  interviewCode,
  roundName,
  scheduleLabel,
  interviewType,
  meetingLink = '',
  location = '',
  internalNotes = '',
}) => {
  const eventLabel = {
    SCHEDULED: 'scheduled',
    RESCHEDULED: 'rescheduled',
    CANCELLED: 'cancelled',
    IN_PROGRESS: 'started',
    COMPLETED: 'completed',
    NO_SHOW: 'marked no-show',
    REMINDER: 'reminder',
  }[event] || 'updated';
  const isReminder = event === 'REMINDER';
  const safeMeetingLink = /^https:\/\//i.test(meetingLink)
    ? escapeHtml(meetingLink)
    : '';
  const safeNotes = escapeHtml(internalNotes).replaceAll('\n', '<br/>');
  const safeSchedule = escapeHtml(scheduleLabel);
  const safeType = escapeHtml(interviewType);
  const safeLocation = escapeHtml(location);
  const subjectCompany = String(companyName || 'Crewly')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 100);

  return {
    subject: `Interview ${isReminder ? 'reminder' : eventLabel} — ${String(roundName || '').replace(/[\r\n]/g, ' ').slice(0, 100)}`,
    text:
      `Hello ${interviewerName},\n\n` +
      (isReminder
        ? `This is a reminder that interview ${interviewCode} is scheduled.\n`
        : `Interview ${interviewCode} has been ${eventLabel}.\n`) +
      `Candidate: ${candidateName} (${candidateEmail})\n` +
      `Position: ${jobTitle}\nRound: ${roundName}\nSchedule: ${scheduleLabel}\nType: ${interviewType}` +
      (meetingLink ? `\nMeeting link: ${meetingLink}` : '') +
      (location ? `\nLocation: ${location}` : '') +
      (internalNotes ? `\nInternal instructions: ${internalNotes}` : ''),
    html: shell(`Interview workspace notification from ${escapeHtml(subjectCompany)}.`, `
      <h2 style="margin:0 0 10px">Interview ${isReminder ? 'reminder' : escapeHtml(eventLabel)}</h2>
      <p>Hello ${escapeHtml(interviewerName)},</p>
      <p>Interview <b>${escapeHtml(interviewCode)}</b> ${isReminder ? 'is scheduled' : `has been ${escapeHtml(eventLabel)}`}</p>
      <p style="background:#f6f8fa;padding:12px;border-radius:8px">
        Candidate: <b>${escapeHtml(candidateName)}</b> (${escapeHtml(candidateEmail)})<br/>
        Position: <b>${escapeHtml(jobTitle)}</b><br/>
        Round: <b>${escapeHtml(roundName)}</b><br/>
        Schedule: <b>${safeSchedule}</b><br/>
        Type: <b>${safeType}</b>
        ${safeMeetingLink ? `<br/>Meeting link: <a href="${safeMeetingLink}">${safeMeetingLink}</a>` : ''}
        ${safeLocation ? `<br/>Location: ${safeLocation}` : ''}
      </p>
      ${safeNotes ? `<p><b>Internal instructions</b><br/>${safeNotes}</p>` : ''}`),
  };
};

// Credentials email (new user / converted candidate)
export const offerCandidateAccessEmail = ({ offer, portalUrl }) => {
  const candidateName = offer.candidateSnapshot?.name || 'Candidate';
  const companyName = offer.companySnapshot?.name || 'Hiring team';
  const offerCode = offer.offerCode || '';
  const designation = offer.terms?.designation || offer.jobSnapshot?.title || 'the role';
  const expiryDate = offer.terms?.expiryDate
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(offer.terms.expiryDate))
    : 'the stated expiry date';
  const safeName = escapeHtml(candidateName);
  const safeCompany = escapeHtml(companyName);
  const safeCode = escapeHtml(offerCode);
  const safeDesignation = escapeHtml(designation);
  const safeExpiryDate = escapeHtml(expiryDate);
  const safePortalUrl = /^https:\/\//i.test(portalUrl) || /^http:\/\/localhost(?::\d+)?\//i.test(portalUrl)
    ? escapeHtml(portalUrl)
    : '';

  return {
    subject: `Employment offer — ${String(companyName).replace(/[\r\n]/g, ' ').slice(0, 100)}`,
    text:
      `Hello ${candidateName},\n\n` +
      `${companyName} has sent you an employment offer for ${designation}.\n` +
      `Offer reference: ${offerCode}\n` +
      `Offer expiry: ${expiryDate}\n\n` +
      `Review and respond securely: ${portalUrl}\n\n` +
      'Do not forward this private link. It expires on the date stated in your offer.',
    html: shell('This private link provides access to your employment offer.', `
      <h2 style="margin:0 0 10px">Your employment offer is ready</h2>
      <p>Hello ${safeName},</p>
      <p><b>${safeCompany}</b> has sent you an employment offer for <b>${safeDesignation}</b>.</p>
      <p style="background:#f6f8fa;padding:12px;border-radius:8px">Offer reference: <b>${safeCode}</b><br/>Offer expiry: <b>${safeExpiryDate}</b></p>
      ${safePortalUrl ? `<p><a href="${safePortalUrl}" style="display:inline-block;background:#172033;color:#fff;padding:11px 16px;border-radius:7px;text-decoration:none">Review offer securely</a></p>` : ''}
      <p style="color:#57606a;font-size:13px">Do not forward this private link. It expires on the date stated in your offer.</p>`),
  };
};

// 28.5: offer expiry reminder — NON-SENSITIVE nudge (sensitive: false
// at the call site). It intentionally carries NO portal token/URL and
// NO compensation: the candidate uses the secure link from the
// original (synchronous, token-bearing) offer email.
export const offerReminderEmail = ({ offer }) => {
  const candidateName = offer.candidateSnapshot?.name || 'Candidate';
  const companyName = offer.companySnapshot?.name || 'Hiring team';
  const offerCode = offer.offerCode || '';
  const designation = offer.terms?.designation || offer.jobSnapshot?.title || 'the role';
  const expiryDate = offer.terms?.expiryDate
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(offer.terms.expiryDate))
    : 'the stated expiry date';
  const safeName = escapeHtml(candidateName);
  const safeCompany = escapeHtml(companyName);
  const safeCode = escapeHtml(offerCode);
  const safeDesignation = escapeHtml(designation);
  const safeExpiryDate = escapeHtml(expiryDate);

  return {
    subject: `Offer response reminder — ${String(companyName).replace(/[\r\n]/g, ' ').slice(0, 100)}`,
    text:
      `Hello ${candidateName},\n\n` +
      `This is a friendly reminder that offer ${offerCode} for ${designation} from ${companyName} is still open and will expire on ${expiryDate}.\n\n` +
      `To review and respond, use the secure link from your original offer email. It stays valid until the expiry date.\n\n` +
      'The hiring team will contact you if any further information is needed.',
    html: shell('A reminder about a pending offer — the secure link in your original offer email remains valid until the stated expiry date.', `
      <h2 style="margin:0 0 10px">Offer response reminder</h2>
      <p>Hello ${safeName},</p>
      <p>This is a friendly reminder that offer <b>${safeCode}</b> for <b>${safeDesignation}</b> from <b>${safeCompany}</b> is still open and will expire on <b>${safeExpiryDate}</b>.</p>
      <p>To review and respond, use the secure link from your original offer email. It stays valid until the expiry date.</p>
      <p style="color:#57606a;font-size:13px">The hiring team will contact you if any further information is needed.</p>`),
  };
};

// 28.6: pre-onboarding candidate reminder — NON-SENSITIVE nudge.
// No portal token / URL (the token-bearing invite email is
// synchronous by 28.3 policy), no document details, no PII beyond
// the candidate's own name + role.
export const preOnboardingReminderEmail = ({ preOnboarding, reminderType }) => {
  const candidateName = preOnboarding.candidateSnapshot?.name || 'Candidate';
  const companyName = preOnboarding.companySnapshot?.name || 'Hiring team';
  const jobTitle = preOnboarding.jobSnapshot?.title || 'your role';
  const code = preOnboarding.preOnboardingCode || '';
  const safeName = escapeHtml(candidateName);
  const safeCompany = escapeHtml(companyName);
  const safeJob = escapeHtml(jobTitle);
  const safeCode = escapeHtml(code);

  const bodyByType = {
    DOCUMENTS_PENDING:
      'Your pre-onboarding still has required documents waiting to be submitted.',
    DOCUMENT_RESUBMISSION:
      'One or more of your pre-onboarding documents need to be resubmitted. Please check the rejection notes in your pre-onboarding portal.',
    JOINING: 'Your joining date is approaching and your pre-onboarding documents are being finalised.',
    DEFAULT: 'There is an open item in your pre-onboarding.',
  };
  const body = bodyByType[reminderType] || bodyByType.DEFAULT;
  const safeBody = escapeHtml(body);

  return {
    subject: `Pre-onboarding reminder — ${String(companyName).replace(/[\r\n]/g, ' ').slice(0, 100)}`,
    text:
      `Hello ${candidateName},\n\n` +
      `This is a reminder about your pre-onboarding for ${jobTitle} with ${companyName}. ${body}\n` +
      (code ? `Reference: ${code}\n` : '') +
      '\nUse the secure link from your original pre-onboarding email to review and act. It stays valid until your pre-onboarding is completed.\n\n' +
      'The hiring team will contact you if anything else is needed.',
    html: shell('A reminder about pre-onboarding documents — the secure link in your original pre-onboarding email remains valid.', `
      <h2 style="margin:0 0 10px">Pre-onboarding reminder</h2>
      <p>Hello ${safeName},</p>
      <p>This is a reminder about your pre-onboarding for <b>${safeJob}</b> with <b>${safeCompany}</b>. ${safeBody}</p>
      ${safeCode ? `<p>Reference: <b>${safeCode}</b></p>` : ''}
      <p>Use the secure link from your original pre-onboarding email to review and act. It stays valid until your pre-onboarding is completed.</p>
      <p style="color:#57606a;font-size:13px">The hiring team will contact you if anything else is needed.</p>`),
  };
};

// 28.6: BGV HR reminder — reference-based, internal audience.
export const bgvReminderEmail = ({ caseRecord, reminderType, recipientName = 'Hiring team' }) => {
  const candidateName = caseRecord.candidateSnapshot?.name || 'Candidate';
  const companyName = caseRecord.companySnapshot?.name || 'Crewly';
  const caseCode = caseRecord.caseCode || '';
  const jobTitle = caseRecord.jobSnapshot?.title || '';
  const safeCandidate = escapeHtml(candidateName);
  const safeCompany = escapeHtml(companyName);
  const safeCode = escapeHtml(caseCode);
  const safeJob = escapeHtml(jobTitle);
  const safeRecipient = escapeHtml(recipientName);

  const bodyByType = {
    CANDIDATE_INFO:
      'This case is still waiting on candidate consent or information.',
    VERIFIER:
      'Checks on this case are still awaiting verifier action.',
    REVIEW_REQUIRED:
      'This case is ready for human review.',
    DEFAULT: 'This case has open background-verification work.',
  };
  const body = bodyByType[reminderType] || bodyByType.DEFAULT;
  const safeBody = escapeHtml(body);

  return {
    subject: `BGV reminder — ${safeCode || 'case'}`,
    text:
      `Hello ${recipientName},\n\n` +
      `Background verification case ${caseCode} for ${candidateName} (${jobTitle} at ${companyName}) needs attention. ${body}\n\n` +
      'Open the case in the recruitment workspace to continue.',
    html: shell('Internal reminder about a background verification case.', `
      <h2 style="margin:0 0 10px">BGV reminder</h2>
      <p>Hello ${safeRecipient},</p>
      <p>Background verification case <b>${safeCode}</b> for <b>${safeCandidate}</b>${safeJob ? ` (<b>${safeJob}</b>)` : ''} at <b>${safeCompany}</b> needs attention. ${safeBody}</p>
      <p>Open the case in the recruitment workspace to continue.</p>`),
  };
};

export const offerDecisionConfirmationEmail = ({ offer, decision }) => {
  const candidateName = offer.candidateSnapshot?.name || 'Candidate';
  const companyName = offer.companySnapshot?.name || 'Hiring team';
  const offerCode = offer.offerCode || '';
  const decisionLabel = decision === 'ACCEPTED' ? 'accepted' : 'rejected';

  return {
    subject: `Offer ${decisionLabel} — ${String(companyName).replace(/[\r\n]/g, ' ').slice(0, 100)}`,
    text:
      `Hello ${candidateName},\n\n` +
      `Your decision to ${decisionLabel === 'accepted' ? 'accept' : 'reject'} offer ${offerCode} from ${companyName} has been recorded.\n\n` +
      'The hiring team will contact you if another action is required.',
    html: shell('This is a confirmation of your recorded offer decision.', `
      <h2 style="margin:0 0 10px">Offer decision recorded</h2>
      <p>Hello ${escapeHtml(candidateName)},</p>
      <p>Your decision to <b>${escapeHtml(decisionLabel)}</b> offer <b>${escapeHtml(offerCode)}</b> from <b>${escapeHtml(companyName)}</b> has been recorded.</p>
      <p style="color:#57606a;font-size:13px">The hiring team will contact you if another action is required.</p>`),
  };
};

export const offerWithdrawnEmail = ({ offer }) => {
  const candidateName = offer.candidateSnapshot?.name || 'Candidate';
  const companyName = offer.companySnapshot?.name || 'Hiring team';
  const offerCode = offer.offerCode || '';

  return {
    subject: `Offer withdrawn — ${String(companyName).replace(/[\r\n]/g, ' ').slice(0, 100)}`,
    text:
      `Hello ${candidateName},\n\n` +
      `${companyName} has withdrawn offer ${offerCode}. The secure offer link is no longer active.\n\n` +
      'Please contact the hiring team if you need clarification.',
    html: shell('This message confirms that the secure offer is no longer active.', `
      <h2 style="margin:0 0 10px">Offer withdrawn</h2>
      <p>Hello ${escapeHtml(candidateName)},</p>
      <p><b>${escapeHtml(companyName)}</b> has withdrawn offer <b>${escapeHtml(offerCode)}</b>. The secure offer link is no longer active.</p>
      <p style="color:#57606a;font-size:13px">Please contact the hiring team if you need clarification.</p>`),
  };
};

export const preOnboardingAccessEmail = ({
  candidateName,
  companyName,
  jobTitle,
  designation,
  joiningDate,
  preOnboardingCode,
  portalUrl,
  expiryDays = 90,
}) => {
  const safeName = escapeHtml(candidateName);
  const safeCompany = escapeHtml(companyName);
  const safeJob = escapeHtml(jobTitle || designation || 'your role');
  const safeCode = escapeHtml(preOnboardingCode || '');
  const joiningLabel = joiningDate
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(joiningDate))
    : 'the planned joining date';
  const safeJoining = escapeHtml(joiningLabel);
  const safePortalUrl =
    /^https:\/\//i.test(portalUrl) ||
    /^http:\/\/localhost(?::\d+)?\//i.test(portalUrl)
      ? escapeHtml(portalUrl)
      : '';

  return {
    subject: `Pre-onboarding documents — ${String(companyName || '')
      .replace(/[\r\n]/g, ' ')
      .slice(0, 100)}`,
    text:
      `Hello ${candidateName},\n\n` +
      `${companyName} has started pre-onboarding for ${jobTitle || designation}.\n` +
      `Reference: ${preOnboardingCode}\n` +
      `Expected joining date: ${joiningLabel}\n\n` +
      `Upload your documents securely: ${portalUrl}\n\n` +
      `This private link remains valid for up to ${expiryDays} days. Do not forward it.`,
    html: shell('This private link is for pre-joining document collection only.', `
      <h2 style="margin:0 0 10px">Pre-onboarding is ready</h2>
      <p>Hello ${safeName},</p>
      <p><b>${safeCompany}</b> has started pre-onboarding for <b>${safeJob}</b>.</p>
      <p style="background:#f6f8fa;padding:12px;border-radius:8px">Reference: <b>${safeCode}</b><br/>Expected joining date: <b>${safeJoining}</b></p>
      ${safePortalUrl ? `<p><a href="${safePortalUrl}" style="display:inline-block;background:#172033;color:#fff;padding:11px 16px;border-radius:7px;text-decoration:none">Open secure document portal</a></p>` : ''}
      <p style="color:#57606a;font-size:13px">This private link remains valid for up to ${Number(expiryDays) || 90} days. Do not forward it.</p>`),
  };
};

export const preOnboardingDocumentDecisionEmail = ({
  candidateName,
  companyName,
  requirementName,
  decision,
  reason = '',
}) => {
  const labels = {
    VERIFIED: 'verified',
    RESUBMISSION_REQUIRED: 'needs resubmission',
    READY_TO_JOIN: 'marked ready to join',
  };
  const decisionLabel = labels[decision] || 'updated';
  const safeReason = escapeHtml(reason).replaceAll('\n', '<br/>');

  return {
    subject: `Pre-onboarding update — ${String(companyName || '')
      .replace(/[\r\n]/g, ' ')
      .slice(0, 100)}`,
    text:
      `Hello ${candidateName},\n\n` +
      `${companyName} updated your pre-onboarding item "${requirementName}": ${decisionLabel}.\n` +
      (reason ? `Note: ${reason}\n` : '') +
      '\nThe hiring team will contact you if another action is required.',
    html: shell('This is a pre-onboarding status notification.', `
      <h2 style="margin:0 0 10px">Pre-onboarding update</h2>
      <p>Hello ${escapeHtml(candidateName)},</p>
      <p><b>${escapeHtml(companyName)}</b> updated <b>${escapeHtml(requirementName)}</b>: <b>${escapeHtml(decisionLabel)}</b>.</p>
      ${safeReason ? `<p style="background:#f6f8fa;padding:12px;border-radius:8px">${safeReason}</p>` : ''}
      <p style="color:#57606a;font-size:13px">The hiring team will contact you if another action is required.</p>`),
  };
};

export const accountSetupEmail = ({
  name,
  email,
  companyName,
  companyCode = '',
  employeeCode = '',
  designation = '',
  joiningDate = null,
  setupUrl,
  expiryHours = 72,
}) => {
  const joiningLabel = joiningDate
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(joiningDate))
    : 'your planned joining date';
  const safeSetupUrl =
    /^https:\/\//i.test(setupUrl) ||
    /^http:\/\/localhost(?::\d+)?\//i.test(setupUrl)
      ? escapeHtml(setupUrl)
      : '';
  const subjectCompany = String(companyName || 'Crewly HRMS')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 100);

  return {
    subject: `Set up your ${subjectCompany} account`,
    text:
      `Hello ${name},\n\n` +
      `Your employee account at ${companyName || 'the company'} is ready.\n` +
      (employeeCode ? `Employee ID: ${employeeCode}\n` : '') +
      (designation ? `Designation: ${designation}\n` : '') +
      `Login email: ${email}\n` +
      (companyCode ? `Company code: ${companyCode}\n` : '') +
      `Joining date: ${joiningLabel}\n\n` +
      `Set your password securely: ${setupUrl}\n` +
      `This link expires in ${expiryHours} hours. Do not forward it.\n`,
    html: shell('This private link lets you set your Crewly account password.', `
      <h2 style="margin:0 0 10px">Welcome aboard</h2>
      <p>Hello ${escapeHtml(name)},</p>
      <p>Your employee account at <b>${escapeHtml(companyName || 'the company')}</b> is ready.</p>
      <p style="background:#f6f8fa;padding:12px;border-radius:8px">
        ${employeeCode ? `Employee ID: <b>${escapeHtml(employeeCode)}</b><br/>` : ''}
        ${designation ? `Designation: <b>${escapeHtml(designation)}</b><br/>` : ''}
        Login email: <b>${escapeHtml(email)}</b><br/>
        ${companyCode ? `Company code: <b>${escapeHtml(companyCode)}</b><br/>` : ''}
        Joining date: <b>${escapeHtml(joiningLabel)}</b>
      </p>
      ${safeSetupUrl ? `<p><a href="${safeSetupUrl}" style="display:inline-block;background:#172033;color:#fff;padding:11px 16px;border-radius:7px;text-decoration:none">Set up your password</a></p>` : ''}
      <p style="color:#57606a;font-size:13px">This private link expires in ${Number(expiryHours) || 72} hours. Do not forward it. No temporary password is sent by email.</p>`),
  };
};

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