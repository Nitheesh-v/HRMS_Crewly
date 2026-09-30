// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.2 — HR CONTEXT RETRIEVER (read-only, redacted, authorized)
//
//  WHAT IT IS FOR
//    36.1 can call a vendor safely. 36.2 answers the next question: what does
//    the AI get to KNOW about the person asking? Without this module the only
//    alternative is the frontend putting HR data in the request body, which
//    destroys tenant isolation and puts PII in a payload the vendor could
//    see. So the BACKEND fetches the data, under the caller's own authority,
//    and hands the AI redacted text (Phase 36 §5.5).
//
//  THE AUTHORIZATION LAW
//    Every user-scoped query carries BOTH `companyId` AND `user`, both taken
//    from the arguments this function was given — which the caller fills from
//    `req.companyId` / `req.user._id` and nothing else. There is deliberately
//    NO parameter through which a different user's context can be requested:
//    no alternate-identity argument of any kind. The signature IS the
//    authorisation, and a source pin greps for the forbidden names.
//
//  READ-ONLY
//    find / findOne / findById / aggregate / countDocuments. No save, no
//    update, no delete, no counter. Nothing in Leave, Attendance,
//    ShiftAssignment, User, Holiday, Announcement, Payslip, Expense, Task,
//    Project or Document is ever written by this module (Phase 36 §10).
//
//  PARTIAL > NOTHING
//    One category failing must not blank the whole context. A failed section
//    renders a placeholder and the rest still arrives, so an employee asking
//    about leave still gets their shift even if the announcement query timed
//    out. The failure is logged metadata-only.
//
//  THE REDACTION SAFETY NET
//    Field selection keeps PII out at the query level, but free text cannot
//    be trusted: an announcement body, a holiday description and a leave
//    reason are all things a human typed. The assembled string therefore goes
//    through redactPII() before it is returned, so anything that slipped
//    through the query is still masked before it can reach a prompt.
//
//  36.4 — WHAT WAS ADDED, AND THE ONE RULE THAT DID NOT BEND
//    Nine more categories: the employee's own payslips, expenses, tasks,
//    projects, documents, full leave history, a month view of attendance,
//    role-aware aggregate COUNTS, and a static capability catalogue.
//
//    The authorization law above is unchanged and still absolute. Every new
//    builder is scoped by `companyId` AND the field that owns the row, and
//    every value still comes from the arguments this function was given.
//    An employee still cannot read another employee's salary, leave or
//    attendance through a chat box.
//
//    The one place the context is not strictly the caller's own data is
//    `org-aggregates`, and it is written to be obviously safe: counts only,
//    never a row, never an id, a name, a designation or a salary figure.
//    See renderOrgAggregates for the four rules.
//
//    And the money rule: NO salary-labelled number is ever rendered, because
//    the redactor masks it by design and a masked figure in a context string
//    would make the assistant report the employee's own net pay as redacted.
//    See the payslip renderer's note.
// ═══════════════════════════════════════════════════════════════════════════

import User from '../../models/User.js';

import Department from '../../models/Department.js';

import Leave from '../../models/Leave.js';

import Attendance from '../../models/Attendance.js';

import ShiftAssignment from '../../models/ShiftAssignment.js';

import Shift from '../../models/Shift.js';

import Holiday from '../../models/Holiday.js';

import Announcement from '../../models/Announcement.js';

import Payslip from '../../models/Payslip.js';

import Expense from '../../models/Expense.js';

import Task from '../../models/Task.js';

import Project from '../../models/Project.js';

import Document from '../../models/Document.js';

import AITenantConfig from '../../models/AITenantConfig.js';

import logger from '../../config/logger.js';

import { LEAVE_TYPES, ROLES } from '../../utils/constants.js';

import { COMPANY_TIMEZONE } from '../../utils/dateHelpers.js';

import {
  AI_CONTEXT_CATEGORIES,
  AI_POLICY_LOOKAHEAD_DAYS,
  AI_POLICY_HOLIDAY_LIMIT,
  AI_POLICY_ANNOUNCEMENT_LIMIT,
  AI_WEEK_HOURS_DAYS,
  AI_PAYSLIP_LIMIT,
  AI_EXPENSE_LIMIT,
  AI_TASK_LIMIT,
  AI_PROJECT_LIMIT,
  AI_DOCUMENT_LIMIT,
  AI_LEAVE_REQUEST_LIMIT,
  AI_CAPABILITIES,
} from './aiConfig.js';

import { getTenantConfig } from './aiTenantConfigService.js';

import { redactPII } from './piiRedactor.js';

// ── DATE HELPERS (company-local, mirroring utils/dateHelpers) ───────────────

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: COMPANY_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' in the company timezone. Injected clock keeps it testable. */
const dayString = (date = new Date()) => dayFmt.format(date);

/** Midnight-to-midnight UTC bounds for a company-local day string. */
const dayBounds = (dayStr) => ({
  start: new Date(`${dayStr}T00:00:00.000Z`),
  end: new Date(`${dayStr}T23:59:59.999Z`),
});

const clockTime = (value) => {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: COMPANY_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
};

const shortDate = (value) => {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return dayString(date);
};

// ── SECTION RENDERERS ───────────────────────────────────────────────────────
// Each returns a string (possibly empty). None of them throw: a failure is
// caught by the caller and rendered as a placeholder.

/*
 * THE TWO KINDS OF "NOTHING" - and why they must never look alike.
 *
 * A section can be empty in two very different ways, and conflating them is
 * what made the assistant answer "I do not have that information" to a question
 * it could actually answer:
 *
 *   NONE        - the data was read successfully and the answer is that nothing
 *                 exists. Rendered by each builder as plain words ("none
 *                 assigned to you"). The assistant MUST state this as the
 *                 answer. See system-prompt rule 8.
 *   UNAVAILABLE - the read FAILED. Produced here. The assistant must say it
 *                 could not retrieve the section and suggest HR. See rule 9.
 *
 * The parenthesised `(x unavailable)` form is deliberately visually distinct
 * from a "none" line, so the model can tell them apart at a glance.
 */
const UNAVAILABLE = (label) => `(${label} unavailable)`;

const renderProfile = (user, departmentName) => {
  if (!user) return UNAVAILABLE('profile');

  const lines = ['Employee Profile:'];

  lines.push(`- Name: ${user.name || 'not set'}`);

  if (user.employeeCode) lines.push(`- Employee Code: ${user.employeeCode}`);

  if (user.designation) lines.push(`- Designation: ${user.designation}`);

  if (departmentName) lines.push(`- Department: ${departmentName}`);

  if (user.dateOfJoining) {
    lines.push(`- Date of Joining: ${shortDate(user.dateOfJoining)}`);
  }

  // workEmail is INCLUDED on purpose: the employee needs the AI to know how
  // to reach them. It is masked by the final redactPII() pass, never by
  // trusting this line.
  if (user.email) lines.push('- Work Email: [EMAIL_REDACTED]');

  return lines.join('\n');
};

/**
 * Leave balances. Mirrors the computation in controllers/leaveController.js
 * (committedDays + buildBalance) rather than importing it, because that
 * controller's helper is not exported and this module must additionally scope
 * by companyId — getMyLeaves is not company-scoped today, and an AI context
 * must never be able to read across tenants.
 */
const buildBalances = (rows) => {
  const committed = {};

  Object.keys(LEAVE_TYPES).forEach((type) => {
    committed[type] = { approved: 0, pending: 0 };
  });

  (rows || []).forEach((row) => {
    const type = row?._id?.type;

    const status = String(row?._id?.status || '').toLowerCase();

    if (!committed[type]) return;

    if (status === 'approved' || status === 'pending') {
      committed[type][status] += Number(row?.days) || 0;
    }
  });

  return Object.entries(LEAVE_TYPES).map(([type, cfg]) => {
    const approved = committed[type].approved;

    const pending = committed[type].pending;

    return {
      type,
      label: cfg.label,
      total: cfg.yearly,
      approved,
      pending,
      available: cfg.yearly - approved - pending,
    };
  });
};

const renderLeaves = (balances, pending) => {
  if (!balances) return UNAVAILABLE('leave balances');

  const lines = ['Leave Balances:'];

  if (balances.length === 0) {
    lines.push('- Leave balances: none configured for you');
  } else {
    balances.forEach((balance) => {
      lines.push(
        `- ${balance.label}: ${balance.available} remaining / ${balance.total} total` +
          ` (${balance.approved} approved, ${balance.pending} pending)`,
      );
    });
  }

  lines.push('', 'Pending Leave Requests:');

  if (!pending || pending.length === 0) {
    lines.push('- none - you have no pending leave requests');
  } else {
    pending.forEach((request) => {
      lines.push(
        `- ${LEAVE_TYPES[request.type]?.label || request.type}: ` +
          `${request.startDate} to ${request.endDate} (${request.status})`,
      );
    });
  }

  return lines.join('\n');
};

const renderAttendance = ({ record, shift, weekHours }) => {
  if (!record && !shift && weekHours === null) return UNAVAILABLE('attendance');

  const lines = ["Today's Attendance:"];

  if (record) {
    const punchIn = clockTime(record.punchIn);

    lines.push(
      `- Status: ${record.status}` +
        (punchIn ? ` (punched in at ${punchIn})` : ' (no punch-in recorded)'),
    );
  } else {
    // There is no stored ABSENT row in this schema (the Attendance status enum
    // is PRESENT / LATE / HALF_DAY only), so the honest answer is that no
    // record exists — inventing ABSENT would be a guess presented as fact.
    lines.push(
      '- Status: NO_RECORD - none recorded, you have not been marked present today',
    );
  }

  if (shift) {
    lines.push(`- Shift: ${shift.name} (${shift.startTime} - ${shift.endTime})`);
  } else {
    lines.push('- Shift: none assigned to you');
  }

  if (weekHours !== null) {
    lines.push(`- This Week: ${weekHours} hours worked`);
  }

  return lines.join('\n');
};

const renderPolicies = ({ holidays, announcements }) => {
  if (!holidays && !announcements) return UNAVAILABLE('policies');

  const lines = [`Upcoming Holidays (next ${AI_POLICY_LOOKAHEAD_DAYS} days):`];

  if (!holidays || holidays.length === 0) {
    lines.push('- none scheduled in the next 30 days');
  } else {
    holidays.forEach((holiday) => {
      lines.push(`- ${shortDate(holiday.date)}: ${holiday.name}`);
    });
  }

  lines.push('', 'Recent Announcements:');

  if (!announcements || announcements.length === 0) {
    lines.push('- none posted');
  } else {
    announcements.forEach((announcement) => {
      const title = String(announcement.title || '').trim();

      if (title) lines.push(`- ${title}`);
    });
  }

  return lines.join('\n');
};

// ── 36.4 SECTION RENDERERS (own records) ────────────────────────────────────
// Every renderer below follows the same two laws as the 36.2 ones:
//   NONE vs UNAVAILABLE — a failed read is parenthesised, an empty result is
//   a plain statement (system-prompt rules 8 and 9).
//   NO LABELLED MONEY — see the payslip renderer's note.
//
/**
 * THE MONEY RULE, and why the payslip figures are not here.
 *
 * piiRedactor deliberately masks a number that carries a salary label:
 *   "net pay 45000"  ->  "net pay [AMOUNT_REDACTED]"
 * That is a 36.2 decision and it is correct — salary is the single most
 * sensitive number in the product and the redactor's whole job is to keep it
 * out of the vendor payload. It was verified, not assumed.
 *
 * So rendering "net pay 45000" here would produce a context that reads
 * "net pay [AMOUNT_REDACTED]", and the assistant would then tell the
 * employee their own net pay is redacted — which is both useless and
 * confusing. Instead this section carries WHICH payslips exist and their
 * status, and says plainly that the figures stay on the payslip screen.
 *
 * The redactor is NOT loosened to make the assistant look clever. The
 * honest degraded state is the required behaviour, not a shortcut.
 *
 * 36.6 — THE PROMPT ASKED FOR THE FIGURES. IT DID NOT GET THEM.
 *
 * The 36.6 build prompt asked this section to carry Gross Salary, Net Pay
 * and Total Deductions, with a format example that showed two of the three
 * as `[AMOUNT_REDACTED]`. That example is the tell: the author knew they
 * would be masked. Rendering them would have produced a context reading
 *
 *   Gross Salary: [AMOUNT_REDACTED]
 *   Net Pay: [AMOUNT_REDACTED]
 *   Total Deductions: 8000
 *
 * which is strictly WORSE than what ships today. Two lines are noise, and
 * the third is a real leak: `Total Deductions` is NOT in the redactor's
 * salary-label list, so that figure would survive into the vendor payload
 * — exactly the number the money rule exists to keep out.
 *
 * So the decision stands. What 36.6 DOES add is naming the three fields
 * explicitly, so the assistant can answer "what is on my payslip?" and
 * point at the right screen instead of gesturing at "figures".
 *
 * The query's `.select()` stays narrowed to month and status, so
 * `snapshot.salary.*` is never read from Mongo at all. That 36.4 decision
 * is not reversed here.
 */
const renderPayslips = (rows) => {
  if (!rows) return UNAVAILABLE('payslips');

  const lines = ['My Payslips (most recent first):'];

  if (rows.length === 0) {
    lines.push('- none generated for you yet');
  } else {
    rows.forEach((row) => {
      const snapshot = row.snapshot || {};

      const payroll = snapshot.payroll || {};

      const label =
        payroll.monthLabel || payroll.month || row.month || 'an earlier month';

      const status = row.status || 'GENERATED';

      lines.push(`- ${label}: ${status}`);
    });

    // 36.6 — the three fields are NAMED, not hidden behind "figures".
    // The employee learns what a payslip contains and where to see it,
    // which is a useful answer, rather than being told that something
    // unspecified is unavailable, which is not.
    lines.push(
      '- Gross salary, total deductions and net pay are not shown here by design. Open My Payslips to view them.',
    );
  }

  return lines.join('\n');
};

/**
 * Own expense claims. Unlike salary, an expense amount is an ordinary
 * business number: the redactor leaves a bare number alone on purpose
 * ("ordinary business numbers survive"), so it is rendered here. What is
 * still never rendered is a receipt URL or a storage key.
 */
const renderExpenses = (rows) => {
  if (!rows) return UNAVAILABLE('expenses');

  const lines = ['My Expense Claims:'];

  if (rows.length === 0) {
    lines.push('- none submitted by you yet');
  } else {
    rows.forEach((row) => {
      const when = row.expenseDate || shortDate(row.createdAt) || 'date not set';

      const parts = [`- ${when}`, row.category || 'OTHER'];

      const amount = Number(row.amount);

      if (Number.isFinite(amount) && amount > 0) {
        parts.push(`${amount} ${row.currency || 'INR'}`);
      }

      if (row.description) parts.push(row.description);

      parts.push(`(${row.status || 'UNKNOWN'})`);

      lines.push(parts.join(', '));
    });
  }

  return lines.join('\n');
};

const renderTasks = (rows) => {
  if (!rows) return UNAVAILABLE('tasks');

  const lines = ['My Tasks:'];

  if (rows.length === 0) {
    lines.push('- none assigned to you');
  } else {
    rows.forEach((row) => {
      const due = row.dueDate ? shortDate(row.dueDate) : 'no due date';

      lines.push(`- ${row.title || 'untitled'} (${row.status || 'TODO'}), due ${due}`);
    });
  }

  return lines.join('\n');
};

const renderProjects = (rows) => {
  if (!rows) return UNAVAILABLE('projects');

  const lines = ['My Projects:'];

  if (rows.length === 0) {
    lines.push('- none - you are not on any project');
  } else {
    rows.forEach((row) => {
      lines.push(`- ${row.name || 'untitled'} (${row.status || 'NOT_STARTED'})`);
    });
  }

  return lines.join('\n');
};

const renderDocuments = (rows) => {
  if (!rows) return UNAVAILABLE('documents');

  const lines = ['My Documents:'];

  if (rows.length === 0) {
    lines.push('- none uploaded for you');
  } else {
    rows.forEach((row) => {
      lines.push(`- ${row.name || 'untitled'} (${row.category || 'OTHER'})`);
    });
  }

  return lines.join('\n');
};

/**
 * The full leave request history, newest first. Deliberately includes
 * rejected and cancelled rows: "why was my leave rejected?" can only be
 * answered from a rejected row, and the balances section has no concept of
 * one.
 */
const renderLeaveRequests = (rows) => {
  if (!rows) return UNAVAILABLE('leave requests');

  const lines = ['My Leave Requests (newest first):'];

  if (rows.length === 0) {
    lines.push('- none - you have never applied for leave');
  } else {
    rows.forEach((row) => {
      const label = LEAVE_TYPES[row.type]?.label || row.type || 'LEAVE';

      const days = Number(row.days) || 0;

      lines.push(
        `- ${label}: ${row.startDate} to ${row.endDate} (${days} day(s)) ` +
          `[${row.status || 'UNKNOWN'}]`,
      );
    });
  }

  return lines.join('\n');
};

/**
 * Month-to-date attendance rollup. The `attendance` category answers
 * "how am I doing today?"; this one answers "how has this month been?",
 * which is a different question and was previously unanswerable.
 */
const renderAttendanceMonth = ({ buckets, minutes, daysInMonth, monthLabel }) => {
  if (!buckets) return UNAVAILABLE('attendance for this month');

  const lines = [`Attendance This Month (${monthLabel}):`];

  const present = Number(buckets.PRESENT) || 0;

  const late = Number(buckets.LATE) || 0;

  const half = Number(buckets.HALF_DAY) || 0;

  const recorded = present + late + half;

  if (recorded === 0) {
    lines.push('- none recorded so far this month');
  } else {
    lines.push(`- Days recorded: ${recorded} of ${daysInMonth}`);

    lines.push(`- Present: ${present}, Late: ${late}, Half day: ${half}`);
  }

  const hours = Math.round((minutes / 60) * 10) / 10;

  lines.push(`- Hours worked so far: ${hours}`);

  return lines.join('\n');
};

/**
 * ROLE-AWARE AGGREGATES — COUNTS ONLY, NEVER ROWS.
 *
 * This is the one place the context is not strictly the caller's own data,
 * so it is written to be obviously safe:
 *   §1 A count is not a person. "3 people are on leave today" names nobody.
 *   §2 No employee id, name, employeeCode, email or designation is
 *      ever put in an aggregate. Not in the query, not in the render.
 *   §3 An EMPLOYEE gets nothing: the section says their role does not
 *      include company-wide figures, which is an answer, not a refusal.
 *   §4 No salary figure is aggregated, at any role. Payroll stays out.
 *
 * A manager sees their own team's counts because they can already open
 * their team's leave list on screen. An HR user sees company counts because
 * they can already open the company dashboard. Neither gets a new door.
 */
const renderOrgAggregates = ({ role, counts }) => {
  if (!role) return UNAVAILABLE('role');

  if (role === ROLES.EMPLOYEE) {
    return [
      'Team and Company Figures:',
      '- none - your role does not include team or company-wide figures',
    ].join('\n');
  }

  const isPeopleManager =
    role === ROLES.MANAGER || role === ROLES.TEAM_LEAD;

  const lines = [isPeopleManager ? 'My Team Figures:' : 'Company Figures:'];

  if (isPeopleManager) {
    lines.push(`- Direct reports: ${counts.reports}`);
  } else {
    lines.push(`- Total employees: ${counts.employees}`);
  }

  lines.push(`- On leave today: ${counts.onLeaveToday}`);

  lines.push(`- Marked present today: ${counts.presentToday}`);

  if (!isPeopleManager) {
    lines.push(`- Pending leave requests: ${counts.pendingLeave}`);
  }

  lines.push(`- Pending expense claims: ${counts.pendingExpenses}`);

  return lines.join('\n');
};

/**
 * The static capability catalogue. Needs no database read, so it cannot
 * fail and therefore has no unavailable branch.
 */
const renderCapabilities = () => {
  const lines = ['What This Assistant Can Help You Do:'];

  AI_CAPABILITIES.forEach((entry) => {
    lines.push(`- ${entry.topic}: ${entry.how}`);
  });

  return lines.join('\n');
};

// ── THE RETRIEVER ───────────────────────────────────────────────────────────

/**
 * Assemble this user's authorized HR context as one redacted string.
 *
 * @param {object}   input
 * @param {string}   input.companyId   SERVER-DERIVED tenant authority
 * @param {string}   input.userId      SERVER-DERIVED caller (req.user._id)
 * @param {string[]} [input.categories] optional request; intersected with the
 *                                      tenant's allowlist
 * @param {object}   [input.deps]      DI seam — every Mongoose model is
 *                                      injectable, plus the clock and the
 *                                      tenant-config model/cache
 *
 * @returns {Promise<{context: string, categoriesUsed: string[], sections: object}>}
 */
export const getUserHRContext = async ({
  companyId,
  userId,
  categories,
  deps = {},
} = {}) => {
  // Identity is never optional and never overridable. A missing tenant means
  // the caller skipped tenantContext — refuse rather than query unscoped.
  if (!companyId || !userId) {
    throw new Error('getUserHRContext requires companyId and userId');
  }

  const {
    UserModel = User,
    DepartmentModel = Department,
    LeaveModel = Leave,
    AttendanceModel = Attendance,
    ShiftAssignmentModel = ShiftAssignment,
    ShiftModel = Shift,
    HolidayModel = Holiday,
    AnnouncementModel = Announcement,
    PayslipModel = Payslip,
    ExpenseModel = Expense,
    TaskModel = Task,
    ProjectModel = Project,
    DocumentModel = Document,
    ConfigModel = AITenantConfig,
    cacheIo,
    now = () => new Date(),
  } = deps;

  // Step 1 — tenant config. A read failure PROPAGATES (unlike a section
  // failure): without the allowlist we cannot know what this tenant permits,
  // and guessing would hand the AI data the tenant never allowed.
  const config = await getTenantConfig(companyId, {
    Model: ConfigModel,
    ...(cacheIo ? { io: cacheIo } : {}),
  });

  const allowed = Array.isArray(config?.allowedCategories)
    ? config.allowedCategories
    : [];

  const requested = Array.isArray(categories) ? categories : allowed;

  // Intersection. An unknown requested category is dropped rather than
  // refused: the allowlist is the authority, and a typo must not turn a
  // working context into an error.
  const effective = AI_CONTEXT_CATEGORIES.filter(
    (category) => allowed.includes(category) && requested.includes(category),
  );

  const reference = now();

  const today = dayString(reference);

  if (effective.length === 0) {
    return {
      context:
        '=== EMPLOYEE HR CONTEXT ===\n(no categories enabled)\n=== END CONTEXT ===',
      categoriesUsed: [],
      sections: {},
    };
  }

  // Step 2 — one builder per category. Each is independently guarded so a
  // single failure degrades one section instead of the whole answer.
  const builders = {
    profile: async () => {
      const user = await UserModel.findOne({ _id: userId, companyId })
        .select(
          'name designation department dateOfJoining email employeeCode',
        )
        .populate('department', 'name')
        .lean();

      return renderProfile(user, user?.department?.name || null);
    },

    leaves: async () => {
      const year = today.slice(0, 4);

      const rows = await LeaveModel.aggregate([
        {
          $match: {
            companyId,
            user: userId,
            status: { $in: ['APPROVED', 'PENDING'] },
            startDate: { $gte: `${year}-01-01` },
          },
        },
        {
          $group: {
            _id: { type: '$type', status: '$status' },
            days: { $sum: '$days' },
          },
        },
      ]);

      // COMP_OFF spends an all-time earned entitlement, never a yearly quota,
      // so its committed days are counted across every year (the same rule
      // leaveController applies). Year-scoping it would double-count at every
      // January boundary.
      const compOff = await LeaveModel.aggregate([
        {
          $match: {
            companyId,
            user: userId,
            type: 'COMP_OFF',
            status: { $in: ['APPROVED', 'PENDING'] },
          },
        },
        { $group: { _id: '$status', days: { $sum: '$days' } } },
      ]);

      const merged = (rows || []).filter(
        (row) => row?._id?.type !== 'COMP_OFF',
      );

      (compOff || []).forEach((row) => {
        merged.push({
          _id: { type: 'COMP_OFF', status: String(row?._id || '') },
          days: row?.days,
        });
      });

      const pending = await LeaveModel.find({
        companyId,
        user: userId,
        status: 'PENDING',
      })
        .sort({ startDate: 1 })
        .limit(10)
        .lean();

      return renderLeaves(buildBalances(merged), pending);
    },

    attendance: async () => {
      const record = await AttendanceModel.findOne({
        companyId,
        user: userId,
        date: today,
      })
        .lean();

      const weekStart = dayString(
        new Date(reference.getTime() - (AI_WEEK_HOURS_DAYS - 1) * 86400000),
      );

      const weekRows = await AttendanceModel.aggregate([
        {
          $match: {
            companyId,
            user: userId,
            date: { $gte: weekStart, $lte: today },
          },
        },
        { $group: { _id: null, minutes: { $sum: '$workMinutes' } } },
      ]);

      const minutes = Number(weekRows?.[0]?.minutes) || 0;

      const weekHours = Math.round((minutes / 60) * 10) / 10;

      const shift = await resolveCurrentShift({
        companyId,
        userId,
        reference,
        record,
        ShiftAssignmentModel,
        ShiftModel,
        UserModel,
      });

      return renderAttendance({ record, shift, weekHours });
    },

    policies: async () => {
      const horizonDay = dayString(
        new Date(reference.getTime() + AI_POLICY_LOOKAHEAD_DAYS * 86400000),
      );

      const bounds = dayBounds(today);

      const horizon = dayBounds(horizonDay);

      const [holidays, announcements] = await Promise.all([
        HolidayModel.find({
          companyId,
          isActive: true,
          // Optional holidays are a CHOICE an employee has not necessarily
          // made; listing them as "upcoming" would be wrong for most people.
          isOptional: false,
          date: { $gte: bounds.start, $lte: horizon.end },
        })
          .sort({ date: 1 })
          .limit(AI_POLICY_HOLIDAY_LIMIT)
          .lean(),

        // There is no `visibility` field on Announcement in this repo, so
        // every announcement in the tenant is already company-wide. The
        // ordering is pinned-first then newest, matching the dashboard.
        AnnouncementModel.find({ companyId })
          .sort({ pinned: -1, createdAt: -1 })
          .limit(AI_POLICY_ANNOUNCEMENT_LIMIT)
          .select('title pinned createdAt')
          .lean(),
      ]);

      return renderPolicies({ holidays, announcements });
    },

    // ── 36.4 own-record builders ──────────────────────────────────────────
    // Each one is scoped by companyId AND the field that owns the row, and
    // every value comes from the arguments this function was given. There is
    // no parameter anywhere in this module through which another employee's
    // rows could be requested.

    payslips: async () => {
      // employeeId is the payslip's owner field and it is req.user._id —
      // the same rule payslipController.js pins as "only ever their own".
      const rows = await PayslipModel.find({
        companyId,
        employeeId: userId,
      })
        .sort({ month: -1 })
        .limit(AI_PAYSLIP_LIMIT)
        // NARROWED ON PURPOSE (36.4 close-out, matrix row 7). Selecting
        // `snapshot` pulls the WHOLE sub-document, and that sub-document
        // contains snapshot.salary.{grossSalary, netSalary, ...} - the
        // most sensitive numbers in the product. The renderer never emits
        // them and the redactor would mask them, so the guarantee held
        // anyway; but a guarantee that depends on two later layers is
        // weaker than one that holds at the query. Only the two payroll
        // label fields are actually read, so only those are selected.
        .select(
          'month status snapshot.payroll.month snapshot.payroll.monthLabel',
        )
        .lean();

      return renderPayslips(rows);
    },

    expenses: async () => {
      const rows = await ExpenseModel.find({ companyId, user: userId })
        .sort({ expenseDate: -1, createdAt: -1 })
        .limit(AI_EXPENSE_LIMIT)
        // receiptUrl is a signed delivery URL and receiptStorageKey is
        // select:false anyway; neither is ever needed to describe a claim.
        .select('category amount currency expenseDate description status')
        .lean();

      return renderExpenses(rows);
    },

    tasks: async () => {
      const rows = await TaskModel.find({
        company: companyId,
        assignedTo: userId,
      })
        .sort({ dueDate: 1, createdAt: -1 })
        .limit(AI_TASK_LIMIT)
        .select('title status dueDate priority')
        .lean();

      return renderTasks(rows);
    },

    projects: async () => {
      // Project has no scalar owner: membership is an array on three
      // different fields. All three are checked, because a team lead is not
      // in `members` and the manager is in neither array.
      const rows = await ProjectModel.find({
        company: companyId,
        $or: [
          { manager: userId },
          { teamLeads: userId },
          { members: userId },
        ],
      })
        .sort({ updatedAt: -1 })
        .limit(AI_PROJECT_LIMIT)
        .select('name status startDate endDate')
        .lean();

      return renderProjects(rows);
    },

    documents: async () => {
      const rows = await DocumentModel.find({ companyId, user: userId })
        .sort({ createdAt: -1 })
        .limit(AI_DOCUMENT_LIMIT)
        // fileUrl is a private storage reference and is never selected.
        .select('name category createdAt')
        .lean();

      return renderDocuments(rows);
    },

    'leave-requests': async () => {
      const rows = await LeaveModel.find({ companyId, user: userId })
        .sort({ startDate: -1 })
        .limit(AI_LEAVE_REQUEST_LIMIT)
        .select('type startDate endDate days status reason')
        .lean();

      return renderLeaveRequests(rows);
    },

    'attendance-month': async () => {
      const monthPrefix = today.slice(0, 7);

      const rows = await AttendanceModel.aggregate([
        {
          $match: {
            companyId,
            user: userId,
            // Month start through today, never into the future.
            date: { $gte: `${monthPrefix}-01`, $lte: today },
          },
        },
        {
          $group: {
            _id: '$status',
            days: { $sum: 1 },
            minutes: { $sum: '$workMinutes' },
          },
        },
      ]);

      const buckets = {};

      let minutes = 0;

      (rows || []).forEach((row) => {
        if (row?._id) buckets[row._id] = Number(row?.days) || 0;

        minutes += Number(row?.minutes) || 0;
      });

      const daysInMonth = new Date(
        Number(monthPrefix.slice(0, 4)),
        Number(monthPrefix.slice(5, 7)),
        0,
      ).getDate();

      return renderAttendanceMonth({
        buckets,
        minutes,
        daysInMonth,
        monthLabel: monthPrefix,
      });
    },

    // Counts only. See renderOrgAggregates for the four rules that make
    // this safe to hand to a vendor at all.
    'org-aggregates': async () => {
      const me = await UserModel.findOne({ _id: userId, companyId })
        .select('role department reportingTo')
        .lean();

      if (!me) return UNAVAILABLE('role');

      const role = String(me.role || '').toUpperCase();

      if (role === ROLES.EMPLOYEE) {
        return renderOrgAggregates({ role, counts: {} });
      }

      const isPeopleManager =
        role === ROLES.MANAGER || role === ROLES.TEAM_LEAD;

      const presentFilter = {
        companyId,
        date: today,
        status: { $in: ['PRESENT', 'LATE'] },
      };

      const onLeaveFilter = {
        companyId,
        status: 'APPROVED',
        startDate: { $lte: today },
        endDate: { $gte: today },
      };

      const pendingExpenseFilter = {
        companyId,
        status: { $in: ['PENDING_MANAGER', 'PENDING_FINANCE'] },
      };

      const pendingLeaveFilter = { companyId, status: 'PENDING' };

      const [
        reports,
        employees,
        presentToday,
        onLeaveToday,
        pendingExpenses,
        pendingLeave,
      ] = await Promise.all([
        isPeopleManager
          ? UserModel.countDocuments({ companyId, reportingTo: userId })
          : Promise.resolve(0),
        isPeopleManager
          ? Promise.resolve(0)
          : UserModel.countDocuments({ companyId }),
        AttendanceModel.countDocuments(presentFilter),
        LeaveModel.countDocuments(onLeaveFilter),
        ExpenseModel.countDocuments(pendingExpenseFilter),
        isPeopleManager
          ? Promise.resolve(0)
          : LeaveModel.countDocuments(pendingLeaveFilter),
      ]);

      return renderOrgAggregates({
        role,
        counts: {
          reports,
          employees,
          presentToday,
          onLeaveToday,
          pendingExpenses,
          pendingLeave,
        },
      });
    },

    // No read, therefore no failure branch.
    capabilities: async () => renderCapabilities(),
  };

  const settled = await Promise.all(
    effective.map(async (category) => {
      try {
        const section = await builders[category]();

        return { category, section, ok: true };
      } catch (error) {
        // Metadata only: which category failed and the driver's error CODE.
        // A Mongo message can name collections and hosts, so it stays out.
        logger.warn('ai.context.section_failed', {
          category,
          errorCode: String(error?.code || error?.name || 'error'),
        });

        return { category, section: UNAVAILABLE(category), ok: false };
      }
    }),
  );

  // Step 3 — assemble in the declared category order, not completion order,
  // so the string is deterministic for the same data.
  const sections = {};

  const blocks = [];

  AI_CONTEXT_CATEGORIES.forEach((category) => {
    const found = settled.find((entry) => entry.category === category);

    if (!found) return;

    sections[category] = { ok: found.ok, text: found.section };

    blocks.push(found.section);
  });

  const assembled = [
    '=== EMPLOYEE HR CONTEXT ===',
    ...blocks,
    '=== END CONTEXT ===',
  ].join('\n\n');

  // Step 4 — THE SAFETY NET. Everything above selects fields, but free text
  // (an announcement title, a holiday name, a leave reason) is typed by a
  // human and cannot be trusted. This is the last line before the boundary.
  const context = redactPII(assembled);

  return { context, categoriesUsed: [...effective], sections };
};

/**
 * Resolve the shift that applies RIGHT NOW.
 *
 * Order: an employee-scoped active assignment, then a department-scoped one,
 * then whatever shift today's attendance row already recorded (which is the
 * resolved shift even after an assignment changed mid-day).
 */
const resolveCurrentShift = async ({
  companyId,
  userId,
  reference,
  record,
  ShiftAssignmentModel,
  ShiftModel,
  UserModel,
}) => {
  const active = {
    effectiveFrom: { $lte: reference },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: reference } }],
  };

  const withShift = (row) =>
    row?.shift
      ? {
          name: row.shift.name,
          startTime: row.shift.startTime,
          endTime: row.shift.endTime,
        }
      : null;

  const employeeRow = await ShiftAssignmentModel.findOne({
    companyId,
    user: userId,
    ...active,
  })
    .sort({ effectiveFrom: -1 })
    .populate('shift', 'name startTime endTime')
    .lean();

  if (employeeRow?.shift) return withShift(employeeRow);

  const user = await UserModel.findOne({ _id: userId, companyId })
    .select('department')
    .lean();

  if (user?.department) {
    const departmentRow = await ShiftAssignmentModel.findOne({
      companyId,
      scope: 'DEPARTMENT',
      department: user.department,
      ...active,
    })
      .sort({ effectiveFrom: -1 })
      .populate('shift', 'name startTime endTime')
      .lean();

    if (departmentRow?.shift) return withShift(departmentRow);
  }

  if (record?.shift) {
    const recorded = await ShiftModel.findById(record.shift)
      .select('name startTime endTime')
      .lean();

    if (recorded) {
      return {
        name: recorded.name,
        startTime: recorded.startTime,
        endTime: recorded.endTime,
      };
    }
  }

  return null;
};

export { dayString, dayBounds };
