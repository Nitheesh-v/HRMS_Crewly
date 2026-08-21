// ─────────────────────────────────────────────────────────────
// Audit trail middleware — mounted ONCE in routes/index.js.
// After each response finishes, non-GET calls by a logged-in
// user are recorded in AuditLog. Covers every module — past &
// future — with zero controller edits.
// ─────────────────────────────────────────────────────────────
import AuditLog from '../models/AuditLog.js';
import logger from '../config/logger.js';

// Friendly labels for common endpoints (first match wins)
const LABELS = [
  [/^POST \/api\/users$/, 'Created a user'],
  [/^POST \/api\/users\/.*\/reset-password/, 'Reset a user password'],
  [/^PATCH \/api\/users\//, 'Updated a user'],
  [/^POST \/api\/attendance\/punch-in/, 'Punched in'],
  [/^PATCH \/api\/attendance\/.*punch-out/, 'Punched out'],
  [/^POST \/api\/leaves$/, 'Applied for leave'],
  [/^PATCH \/api\/leaves\/.*\/decide/, 'Decided a leave request'],
  [/^PATCH \/api\/leaves\//, 'Updated a leave'],
  [/^POST \/api\/departments$/, 'Created a department'],
  [/^PATCH \/api\/departments\//, 'Updated a department'],
  [/^DELETE \/api\/departments\//, 'Deleted a department'],
  [/^POST \/api\/projects$/, 'Created a project'],
  [/^PATCH \/api\/projects\//, 'Updated a project'],
  [/^POST \/api\/tasks$/, 'Created a task'],
  [/^PATCH \/api\/tasks\//, 'Updated a task'],
  [/^POST \/api\/payroll\/generate/, 'Ran payroll generation'],
  [/^PATCH \/api\/payroll\/.*\/pay/, 'Marked payroll as PAID'],
  [/^PUT \/api\/payroll\/structure\//, 'Saved a salary structure'],
  [/^POST \/api\/recruitment\/requisitions\/.*\/submit$/, 'Submitted a job requisition'],
  [/^POST \/api\/recruitment\/requisitions$/, 'Created a job requisition'],
  [/^PATCH \/api\/recruitment\/requisitions\//, 'Updated a job requisition'],
  [/^POST \/api\/recruitment\/jobs$/, 'Posted a job'],
  [/^PATCH \/api\/recruitment\/jobs\//, 'Updated a job'],
  [/^POST \/api\/recruitment\/candidates$/, 'Added a candidate'],
  [/^PATCH \/api\/recruitment\/candidates\/.*\/stage/, 'Moved a candidate stage'],
  [/^PATCH \/api\/recruitment\/candidates\/.*\/offer/, 'Updated an offer'],
  [/^POST \/api\/recruitment\/candidates\/.*\/convert/, 'Converted candidate to employee'],
  [/^POST \/api\/exit\/resign/, 'Submitted a resignation'],
  [/^PATCH \/api\/exit\/.*\/decide/, 'Decided an exit request'],
  [/^PATCH \/api\/exit\/.*\/withdraw/, 'Withdrew a resignation'],
  [/^PUT \/api\/companies\/my/, 'Updated company profile'],
  [/^POST \/api\/billing\/checkout/, 'Started a subscription payment'],
  [/^POST \/api\/billing\/verify/, 'Verified payment / upgraded plan'],
];

const labelFor = (method, url) => {
  const key = `${method} ${url.split('?')[0]}`;
  const hit = LABELS.find(([re]) => re.test(key));
  return hit ? hit[1] : key; // fallback: "PATCH /api/…"
};

export const auditTrail = (req, res, next) => {
  res.on('finish', () => {
    try {
      if (req.method === 'GET' || !req.user) return; // reads aren't audits
      AuditLog.create({
        companyId: req.companyId || null,
        actor: req.user._id,
        actorName: req.user.name,
        actorRole: req.user.role,
        action: labelFor(req.method, req.originalUrl),
        method: req.method,
        path: req.originalUrl.split('?')[0],
        statusCode: res.statusCode,
        ip: req.ip || '',
      }).catch(() => {});
    } catch (err) {
      logger.warn(`📜 auditTrail failed: ${err.message}`);
    }
  });
  next();
};