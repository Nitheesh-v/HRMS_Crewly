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
//    find / findOne / aggregate. No save, no update, no delete, no counter.
//    Nothing in Leave, Attendance, ShiftAssignment, User, Holiday or
//    Announcement is ever written by this module (Phase 36 §10).
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
// ═══════════════════════════════════════════════════════════════════════════

import User from '../../models/User.js';

import Department from '../../models/Department.js';

import Leave from '../../models/Leave.js';

import Attendance from '../../models/Attendance.js';

import ShiftAssignment from '../../models/ShiftAssignment.js';

import Shift from '../../models/Shift.js';

import Holiday from '../../models/Holiday.js';

import Announcement from '../../models/Announcement.js';

import AITenantConfig from '../../models/AITenantConfig.js';

import logger from '../../config/logger.js';

import { LEAVE_TYPES } from '../../utils/constants.js';

import { COMPANY_TIMEZONE } from '../../utils/dateHelpers.js';

import {
  AI_CONTEXT_CATEGORIES,
  AI_POLICY_LOOKAHEAD_DAYS,
  AI_POLICY_HOLIDAY_LIMIT,
  AI_POLICY_ANNOUNCEMENT_LIMIT,
  AI_WEEK_HOURS_DAYS,
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
    lines.push('- (no leave balances configured)');
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
    lines.push('- (none pending)');
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
    lines.push('- Status: NO_RECORD (no attendance record for today)');
  }

  if (shift) {
    lines.push(`- Shift: ${shift.name} (${shift.startTime} - ${shift.endTime})`);
  } else {
    lines.push('- Shift: (no shift assigned)');
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
    lines.push('- (none scheduled)');
  } else {
    holidays.forEach((holiday) => {
      lines.push(`- ${shortDate(holiday.date)}: ${holiday.name}`);
    });
  }

  lines.push('', 'Recent Announcements:');

  if (!announcements || announcements.length === 0) {
    lines.push('- (none posted)');
  } else {
    announcements.forEach((announcement) => {
      const title = String(announcement.title || '').trim();

      if (title) lines.push(`- ${title}`);
    });
  }

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
