import Attendance from "../models/Attendance.js";
import User from "../models/User.js";
import Leave from "../models/Leave.js";
import Shift from "../models/Shift.js";
import WorkSchedule from "../models/WorkSchedule.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import {
  ROLES,
  WORK_START_TIME,
  LATE_GRACE_MINUTES,
  HALF_DAY_MINUTES,
} from "../utils/constants.js";
import { todayString, monthRange } from "../utils/dateHelpers.js";
import * as engine from "../utils/scheduleEngine.js";
import {
  eachDayInRange,
  resolveDay as resolveReconciliationDay,
} from "../services/attendance/attendanceReconciliationService.js";
import { isLeaveCountedDay } from "../services/attendance/attendanceReconciliationRules.js";
import { resolveStoredSchedule } from "../services/attendance/attendanceScheduleService.js";

const FULL_ACCESS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];

// Used only when no Shift or Work Schedule exists.
const fallbackRule = {
  name: "Default schedule",
  startTime: WORK_START_TIME,
  endTime: "18:00",
  breakMinutes: 0,
  graceMinutes: LATE_GRACE_MINUTES,
  minWorkingHours: 8,
  halfDayHours: HALF_DAY_MINUTES / 60,
  overtimeEligible: false,
};

const getSubtreeIds = async (companyId, managerId) => {
  const users = await User.find({
    companyId,
    status: "ACTIVE",
  }).select("_id reportingTo");

  const children = {};

  users.forEach((user) => {
    const parent = String(user.reportingTo || "");

    (children[parent] ||= []).push(user._id);
  });

  const result = [];
  const queue = [String(managerId)];

  while (queue.length) {
    const current = queue.pop();

    (children[current] || []).forEach((id) => {
      result.push(id);
      queue.push(String(id));
    });
  }

  return result;
};

const resolveScopeIds = async (req) => {
  if (FULL_ACCESS.includes(req.user.role)) {
    return User.find({
      companyId: req.companyId,
      status: "ACTIVE",
    }).distinct("_id");
  }

  return getSubtreeIds(req.companyId, req.user._id);
};

const assertCompanyUser = (req) => {
  if (!req.companyId) {
    throw ApiError.forbidden("Only company users can use attendance");
  }
};

// Shift has priority over Work Schedule.
const resolveRule = async (companyId, user, onDate = new Date()) => {
  const resolved = await engine.resolveShiftForUser(companyId, user, onDate);

  const schedule =
    resolved.schedule || (await engine.resolveScheduleForUser(companyId, user));

  return {
    shift: resolved.shift || null,

    schedule: schedule || null,

    source: resolved.shift
      ? resolved.source
      : schedule
        ? "WORK_SCHEDULE"
        : "DEFAULT",

    rule: resolved.shift || schedule || fallbackRule,
  };
};

// Use the same rule at Punch Out that was selected at Punch In.
const ruleFromRecord = async (record, user) => {
  const [shift, schedule] = await Promise.all([
    record.shift
      ? Shift.findOne({
          _id: record.shift,
          companyId: record.companyId,
        }).lean()
      : null,

    record.schedule
      ? WorkSchedule.findOne({
          _id: record.schedule,
          companyId: record.companyId,
        }).lean()
      : null,
  ]);

  if (shift || schedule) {
    return {
      rule: shift || schedule,
      shift,
      schedule,
      source: record.shiftSource,
    };
  }

  return resolveRule(record.companyId, user, record.punchIn);
};

const expectedWorkingDays = async (companyId, user, start, end) => {
  const workingDays = await engine.getWorkingDaysForUser(companyId, user);

  const holidays = await engine.getHolidaysForUser(companyId, user, {
    from: start,
    to: end,
  });

  const holidayDates = new Set(
    holidays
      .filter((holiday) => !(holiday.isOptional && !holiday.picked))
      .flatMap((holiday) => holiday.dates),
  );

  return engine
    .eachDate(start, end, 370)
    .filter(
      (date) =>
        workingDays.includes(engine.dayKey(date)) && !holidayDates.has(date),
    ).length;
};

const expectedOnDate = async (companyId, user, date) => {
  const workingDays = await engine.getWorkingDaysForUser(companyId, user);

  if (!workingDays.includes(engine.dayKey(date))) {
    return false;
  }

  const holiday = await engine.holidayOnDate(companyId, user, date);

  return !holiday;
};

// Phase 31.7 — derived day for a history/company row: the stored
// projection wins (frozen meaning), else live resolution against
// current authorities. Never throws — reads stay silent instead of
// misleading when a lookup fails.
const bestEffortRowDay = async (companyId, person, record, date) => {
  try {
    const stored = record?.reconciliation || record?.toObject?.()?.reconciliation;
    if (stored?.resolvedAt) return stored;
    const control = record?.toObject ? record.toObject() : record;
    return await resolveReconciliationDay({
      companyId,
      userId: person._id || person,
      user: person,
      attendanceDate: date,
      control: control || null,
      schedule: resolveStoredSchedule({ control: control || {} }),
      LeaveModel: Leave,
      engine,
    });
  } catch {
    return null;
  }
};

// ============================================================
// PUNCH IN
// ============================================================

export const punchIn = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  assertCompanyUser(req);

  const date = todayString();

  // DB Logic - DB logics
  const existing = await Attendance.findOne({
    companyId: req.companyId,

    user: req.user._id,

    date,
  });

  if (existing) {
    throw ApiError.conflict("You have already punched in today");
  }

  const now = new Date();

  const { rule, shift, schedule, source } = await resolveRule(
    req.companyId,
    req.user,
    now,
  );

  const evaluation = engine.evaluatePunch({
    rule,
    punchIn: now,
  });

  const status = evaluation.status === "LATE" ? "LATE" : "PRESENT";

  const record = await Attendance.create({
    companyId: req.companyId,

    user: req.user._id,

    date,
    punchIn: now,
    status,

    shift: shift?._id || null,

    schedule: schedule?._id || null,

    shiftSource: source,

    lateMinutes: evaluation.lateMinutes || 0,
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message:
      status === "LATE"
        ? `Punched in ${evaluation.lateMinutes} minute(s) late`
        : `Punched in on time — ${rule.name || rule.startTime} 💪`,

    data: record,
  });
});

// ============================================================
// PUNCH OUT
// ============================================================

export const punchOut = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  assertCompanyUser(req);

  // DB Logic - DB logics
  const record = await Attendance.findOne({
    companyId: req.companyId,

    user: req.user._id,

    date: todayString(),
  });

  if (!record) {
    throw ApiError.badRequest("You have not punched in today");
  }

  if (record.punchOut) {
    throw ApiError.conflict("You have already punched out today");
  }

  // Phase 31.2 seam: event-backed sessions derive workMinutes from the
  // immutable event ledger. The classic formula (span minus fixed rule
  // breaks) must not silently overwrite those facts — such sessions
  // close through the Clock Out action instead. Classic-only sessions
  // (eventSeq 0, no liveState) behave exactly as before.
  if ((record.eventSeq || 0) > 0 || record.liveState) {
    throw ApiError.conflict(
      "This session uses advanced punching — use Clock Out to finish your day",
    );
  }

  const punchOut = new Date();

  const { rule } = await ruleFromRecord(record, req.user);

  const evaluation = engine.evaluatePunch({
    rule,
    punchIn: record.punchIn,
    punchOut,
  });

  const minimumMinutes = Number(rule.minWorkingHours || 8) * 60;

  record.punchOut = punchOut;

  record.workMinutes = evaluation.workedMinutes;

  record.earlyMinutes = evaluation.earlyMinutes || 0;

  record.overtimeMinutes = evaluation.overtimeMinutes || 0;

  if (record.workMinutes < minimumMinutes) {
    record.status = "HALF_DAY";
  }

  await record.save();

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message:
      `Punched out. Worked ` +
      `${(record.workMinutes / 60).toFixed(1)} hours` +
      `${
        record.overtimeMinutes ? ` · overtime ${record.overtimeMinutes}m` : ""
      }`,

    data: record,
  });
});

// ============================================================
// TODAY
// ============================================================

export const getMyToday = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  assertCompanyUser(req);

  // DB Logic - DB logics
  const record = await Attendance.findOne({
    companyId: req.companyId,

    user: req.user._id,

    date: todayString(),
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Today's attendance",

    data: record,
  });
});

// ============================================================
// MY MONTHLY ATTENDANCE
// ============================================================

export const getMyAttendance = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  assertCompanyUser(req);

  const month = req.query.month || todayString().slice(0, 7);

  const { start, end } = monthRange(month);

  // DB Logic - DB logics
  const records = await Attendance.find({
    companyId: req.companyId,

    user: req.user._id,

    date: {
      $gte: start,
      $lte: end,
    },
  }).sort("date");

  const until = month === todayString().slice(0, 7) ? todayString() : end;

  const workingDays = await expectedWorkingDays(
    req.companyId,
    req.user,
    start,
    until,
  );

  const present = records.length;

  const late = records.filter((record) => record.status === "LATE").length;

  const halfDay = records.filter(
    (record) => record.status === "HALF_DAY",
  ).length;

  const totalMinutes = records.reduce(
    (sum, record) => sum + (record.workMinutes || 0),
    0,
  );

  const absent = Math.max(0, workingDays - present);

  // Phase 31.7 — derived day per row (stored preferred, live on
  // miss) plus display-only rows for approved-leave days without
  // punches (31.7 never fabricates attendance rows). Summary math
  // above is untouched.
  const enriched = await Promise.all(
    records.map(async (record) => {
      const plain = record.toObject ? record.toObject() : { ...record };
      plain.reconciliation = await bestEffortRowDay(req.companyId, req.user, record, record.date);
      return plain;
    }),
  );
  const haveDates = new Set(enriched.map((row) => row.date));
  const approvedLeaves = await Leave.find({
    companyId: req.companyId,
    user: req.user._id,
    status: "APPROVED",
    startDate: { $lte: end },
    endDate: { $gte: start },
  }).lean();
  for (const leave of approvedLeaves || []) {
    for (const day of eachDayInRange(leave.startDate, leave.endDate)) {
      if (day < start || day > end || haveDates.has(day)) continue;
      if (!isLeaveCountedDay(day)) continue;
      haveDates.add(day);
      enriched.push({
        _id: `leave-${day}`,
        derived: "LEAVE",
        date: day,
        reconciliation: await bestEffortRowDay(req.companyId, req.user, null, day),
      });
    }
  }
  enriched.sort((a, b) => (a.date < b.date ? -1 : 1));

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "My attendance",

    data: {
      records: enriched,

      summary: {
        present,
        late,
        halfDay,
        absent,
        workingDays,

        totalHours: (totalMinutes / 60).toFixed(1),
      },
    },
  });
});

// ============================================================
// COMPANY / TEAM ATTENDANCE
// ============================================================

export const getCompanyAttendance = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const date = req.query.date || todayString();

  // DB Logic - DB logics
  const userIds = await resolveScopeIds(req);

  const [users, records] = await Promise.all([
    User.find({
      _id: {
        $in: userIds,
      },

      companyId: req.companyId,

      status: "ACTIVE",
    })
      .select("name email role designation department")
      .populate("department", "name")
      .sort("name"),

    Attendance.find({
      companyId: req.companyId,

      date,

      user: {
        $in: userIds,
      },
    }),
  ]);

  const recordMap = Object.fromEntries(
    records.map((record) => [String(record.user), record]),
  );

  const rows = await Promise.all(
    users.map(async (user) => {
      const userRecord = recordMap[String(user._id)] || null;
      return {
        user,

        record: userRecord,

        expected: await expectedOnDate(req.companyId, user, date),

        reconciliation: await bestEffortRowDay(req.companyId, user, userRecord, date),
      };
    }),
  );

  const counts = {
    total: rows.filter((row) => row.expected).length,

    punchedIn: rows.filter((row) => row.record && !row.record.punchOut).length,

    punchedOut: rows.filter((row) => row.record?.punchOut).length,

    late: rows.filter((row) => row.record?.status === "LATE").length,

    absent: rows.filter((row) => row.expected && !row.record).length,
  };

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Company attendance",

    data: {
      date,
      rows,
      counts,
    },
  });
});

// ============================================================
// MONTHLY REPORT
// ============================================================

export const getMonthlyReport = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const month = req.query.month || todayString().slice(0, 7);

  const { start, end } = monthRange(month);

  // DB Logic - DB logics
  const userIds = await resolveScopeIds(req);

  const userFilter = {
    _id: {
      $in: userIds,
    },

    companyId: req.companyId,

    status: "ACTIVE",
  };

  if (req.query.department) {
    userFilter.department = req.query.department;
  }

  const users = await User.find(userFilter)
    .select("name email role designation department")
    .populate("department", "name")
    .sort("name");

  const grouped = await Attendance.aggregate([
    {
      $match: {
        companyId: req.companyId,

        user: {
          $in: users.map((user) => user._id),
        },

        date: {
          $gte: start,
          $lte: end,
        },
      },
    },
    {
      $group: {
        _id: "$user",

        present: {
          $sum: 1,
        },

        late: {
          $sum: {
            $cond: [
              {
                $eq: ["$status", "LATE"],
              },
              1,
              0,
            ],
          },
        },

        halfDay: {
          $sum: {
            $cond: [
              {
                $eq: ["$status", "HALF_DAY"],
              },
              1,
              0,
            ],
          },
        },

        totalMinutes: {
          $sum: "$workMinutes",
        },
      },
    },
  ]);

  const statMap = Object.fromEntries(
    grouped.map((row) => [String(row._id), row]),
  );

  const until = month === todayString().slice(0, 7) ? todayString() : end;

  const rows = await Promise.all(
    users.map(async (user) => {
      const stats = statMap[String(user._id)] || {
        present: 0,
        late: 0,
        halfDay: 0,
        totalMinutes: 0,
      };

      const workingDays = await expectedWorkingDays(
        req.companyId,
        user,
        start,
        until,
      );

      return {
        user,
        workingDays,

        present: stats.present,

        late: stats.late,

        halfDay: stats.halfDay,

        absent: Math.max(0, workingDays - stats.present),

        totalMinutes: stats.totalMinutes,

        attendancePct: workingDays
          ? Math.round((stats.present / workingDays) * 100)
          : 0,
      };
    }),
  );

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Monthly attendance report",

    data: {
      month,
      rows,
    },
  });
});
