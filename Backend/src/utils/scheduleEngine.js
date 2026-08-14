// ═══════════════════════════════════════════════════════════════════════════
// scheduleEngine — reusable policy-driven rules for holidays / schedules /
// shifts / attendance-eval / leave-counting / payroll-inputs.
// ZERO hard-coded Mon–Fri, ZERO hard-coded 09:00–18:00. Everything resolves
// from the company's configured Schedule/Shift docs.
// ═══════════════════════════════════════════════════════════════════════════

export const DAY_KEYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const DEFAULT_WORKING_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

export const toMin = (hhmm = '0:0') => {
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
};
export const dstr = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
};
export const addDays = (dateStr, n) => dstr(new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + n * 86400000));
export const dayKey = (dateStr) => DAY_KEYS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
export const crossesMidnight = (startTime, endTime) => toMin(endTime) <= toMin(startTime);

export function eachDate(fromStr, toStr, cap = 62) {
  const out = [];
  let cur = fromStr;
  while (cur && cur <= toStr && out.length < cap) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// ─── Punch evaluation (attendance rules service) ────────────────────────────
// rule = Shift or WorkSchedule doc. Handles cross-midnight as ONE shift.
export function evaluatePunch({ rule, punchIn, punchOut }) {
  if (!rule) return { status: 'NO_SHIFT' };
  const inD = new Date(punchIn);
  if (Number.isNaN(inD.getTime())) return { status: 'BAD_INPUT' };
  const outD = punchOut ? new Date(punchOut) : null;

  const anchor = Date.UTC(inD.getUTCFullYear(), inD.getUTCMonth(), inD.getUTCDate());
  const startTs = anchor + toMin(rule.startTime) * 60000;
  let endTs = anchor + toMin(rule.endTime) * 60000;
  const crossed = crossesMidnight(rule.startTime, rule.endTime);
  if (endTs <= startTs) endTs += 86400000; // 🌙 night shift → +1 day

  const lateGrace = rule.lateRule?.graceMinutes ?? rule.graceMinutes ?? 0;
  const earlyGrace = rule.earlyCheckoutRule?.graceMinutes ?? rule.graceMinutes ?? 0;
  const breakMin = rule.breakMinutes || 0;

  const lateMinutes = Math.max(0, Math.round((inD.getTime() - startTs) / 60000));
  const earlyMinutes = outD ? Math.max(0, Math.round((endTs - outD.getTime()) / 60000)) : 0;
  const workedMinutes = outD ? Math.max(0, Math.round((outD.getTime() - inD.getTime()) / 60000) - breakMin) : 0;
  const overtimeMinutes = rule.overtimeEligible && outD ? Math.max(0, Math.round((outD.getTime() - endTs) / 60000)) : 0;
  const halfDay = !!(rule.halfDayHours && workedMinutes > 0 && workedMinutes < rule.halfDayHours * 60);

  return {
    status: lateMinutes <= lateGrace ? 'ON_TIME' : 'LATE',
    lateMinutes,
    checkoutStatus: outD ? (earlyMinutes <= earlyGrace ? 'OK' : 'EARLY_CHECKOUT') : 'OPEN',
    earlyMinutes,
    workedMinutes,
    overtimeMinutes,
    halfDay,
    crossesMidnight: crossed,
    shiftWindow: { start: new Date(startTs).toISOString(), end: new Date(endTs).toISOString() },
  };
}

// ─── lazy model loader (avoids circular imports) ────────────────────────────
const _cache = {};
async function model(name) {
  if (!_cache[name]) {
    const m = await import(`../models/${name}.js`);
    _cache[name] = m.default || m;
  }
  return _cache[name];
}

// ─── Shift resolution: EMPLOYEE override ▲ DEPARTMENT default ▲ shift doc ──
export async function resolveShiftForUser(companyId, user, onDate = new Date()) {
  const ShiftAssignment = await model('ShiftAssignment');
  const Shift = await model('Shift');
  const on = new Date(`${dstr(onDate)}T00:00:00Z`);
  const uid = user._id || user;
  const deptId = user.department?._id || user.department || null;
  const win = { effectiveFrom: { $lte: on }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: on } }] };
  const pop = [{ path: 'shift' }, { path: 'schedule' }];

  const emp = await ShiftAssignment.findOne({ companyId, user: uid, scope: 'EMPLOYEE', ...win })
    .sort('-effectiveFrom').populate(pop).lean();
  if (emp?.shift && emp.shift.isActive !== false) {
    return { shift: emp.shift, schedule: emp.schedule || null, source: 'EMPLOYEE_OVERRIDE', assignment: emp };
  }
  if (deptId) {
    const dep = await ShiftAssignment.findOne({ companyId, department: deptId, scope: 'DEPARTMENT', ...win })
      .sort('-effectiveFrom').populate(pop).lean();
    if (dep?.shift && dep.shift.isActive !== false) {
      return { shift: dep.shift, schedule: dep.schedule || null, source: 'DEPARTMENT_DEFAULT', assignment: dep };
    }
  }
  // convenience fallback: shift doc directly listing the employee/department
  const direct = await Shift.findOne({
    companyId,
    isActive: true,
    $or: [{ employees: uid }, ...(deptId ? [{ departments: deptId }] : [])],
  }).lean();
  if (direct) return { shift: direct, schedule: null, source: 'SHIFT_DOC', assignment: null };
  return { shift: null, schedule: null, source: 'NONE', assignment: null };
}

// ─── Schedule resolution: employee ▲ department ▲ branch ▲ company default ─
export async function resolveScheduleForUser(companyId, user) {
  const WorkSchedule = await model('WorkSchedule');
  const uid = user._id || user;
  const deptId = user.department?._id || user.department || null;
  const branch = user.branch || '';

  const mine = await WorkSchedule.findOne({ companyId, isActive: true, employees: uid }).lean();
  if (mine) return mine;
  if (deptId) {
    const d = await WorkSchedule.findOne({ companyId, isActive: true, departments: deptId }).lean();
    if (d) return d;
  }
  if (branch) {
    const b = await WorkSchedule.findOne({ companyId, isActive: true, branch }).lean();
    if (b) return b;
  }
  const def =
    (await WorkSchedule.findOne({ companyId, isActive: true, name: /general/i }).lean()) ||
    (await WorkSchedule.findOne({ companyId, isActive: true }).sort('createdAt').lean());
  return def || null;
}

export async function getWorkingDaysForUser(companyId, user, schedule = undefined) {
  const s = schedule === undefined ? await resolveScheduleForUser(companyId, user) : schedule;
  return s?.workingDays?.length ? s.workingDays : DEFAULT_WORKING_DAYS;
}

// ─── Holidays ────────────────────────────────────────────────────────────────
const holidayScopes = (user) => {
  const uid = user._id || user;
  const deptId = user.department?._id || user.department || null;
  const branch = user.branch || '';
  return [
    { type: { $in: ['COMPANY', 'PUBLIC'] } },
    { type: 'OPTIONAL' }, // all optional visible (picked flag marks yours)
    ...(deptId ? [{ type: 'DEPARTMENT', departments: deptId }] : []),
    ...(branch ? [{ type: 'BRANCH', branch }] : []),
    { applicableEmployees: uid },
  ];
};

const toDto = (h, uid, yrProj = null) => {
  const from = dstr(yrProj?.date ?? h.date);
  const to = dstr(yrProj?.endDate ?? h.endDate ?? h.date);
  return {
    id: String(h._id),
    name: h.name,
    type: h.type,
    date: from,
    endDate: to,
    dates: eachDate(from, to),
    description: h.description || '',
    branch: h.branch || '',
    departments: (h.departments || []).map(String),
    isOptional: !!h.isOptional,
    picked: (h.optionalPicks || []).some((p) => String(p) === String(uid)),
    recurringYearly: !!h.recurringYearly,
    isActive: h.isActive !== false,
  };
};

export async function getHolidaysForUser(companyId, user, { from, to }) {
  const Holiday = await model('Holiday');
  const uid = user._id || user;
  const scopes = holidayScopes(user);
  const base = { companyId, isActive: true, $or: scopes };

  const [normal, recurring] = await Promise.all([
    Holiday.find({ ...base, recurringYearly: { $ne: true }, date: { $lte: new Date(to) }, endDate: { $gte: new Date(from) } }).lean(),
    Holiday.find({ ...base, recurringYearly: true }).lean(),
  ]);

  const out = normal.map((h) => toDto(h, uid));
  const fromYear = new Date(from).getUTCFullYear();
  const toYear = new Date(to).getUTCFullYear();
  for (const h of recurring) {
    const spanDays = Math.max(0, Math.round((new Date(h.endDate || h.date) - new Date(h.date)) / 86400000));
    for (let y = fromYear; y <= toYear; y += 1) {
      const o = new Date(h.date);
      const proj = new Date(Date.UTC(y, o.getUTCMonth(), o.getUTCDate()));
      const pEnd = new Date(proj.getTime() + spanDays * 86400000);
      if (dstr(pEnd) >= from && dstr(proj) <= to) out.push(toDto(h, uid, { date: proj, endDate: pEnd }));
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

export async function holidayOnDate(companyId, user, dateStr) {
  const list = await getHolidaysForUser(companyId, user, { from: dateStr, to: dateStr });
  return list.find((h) => h.dates.includes(dateStr) && !(h.isOptional && !h.picked)) || null;
}

// ─── Leave-day counting (policy-driven, NOT hard-coded weekends) ────────────
export function countLeaveDays({ from, to, workingDays = DEFAULT_WORKING_DAYS, holidaySet = new Set(), excludeWeeklyOffs = true, excludeHolidays = true }) {
  let days = 0;
  let weeklyOffs = 0;
  let holidays = 0;
  for (const d of eachDate(from, to, 370)) {
    const off = !workingDays.includes(dayKey(d));
    const hol = holidaySet.has(d);
    if (off && excludeWeeklyOffs) { weeklyOffs += 1; continue; }
    if (hol && excludeHolidays) { holidays += 1; continue; }
    days += 1;
  }
  return { days, weeklyOffs, holidays };
}

export async function leaveDaysForUser(companyId, user, from, to, opts = {}) {
  const workingDays = await getWorkingDaysForUser(companyId, user);
  const hols = await getHolidaysForUser(companyId, user, { from, to });
  const holidaySet = new Set(hols.filter((h) => !(h.isOptional && !h.picked)).flatMap((h) => h.dates));
  return countLeaveDays({ from, to, workingDays, holidaySet, ...opts });
}

// ─── Payroll input builder (payroll consumes THIS, never re-implements) ─────
export async function buildPayrollInputs(companyId, user, year, month) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const { shift, source } = await resolveShiftForUser(companyId, user, new Date(from));
  const workingDays = await getWorkingDaysForUser(companyId, user);
  const weeklyOffKeys = DAY_KEYS.filter((d) => !workingDays.includes(d));
  const hols = await getHolidaysForUser(companyId, user, { from, to });
  const paidHolidayDates = hols.filter((h) => !(h.isOptional && !h.picked)).flatMap((h) => h.dates).filter((d) => d >= from && d <= to);
  const allDates = eachDate(from, to);
  const weeklyOffDates = allDates.filter((d) => weeklyOffKeys.includes(dayKey(d)));
  const workingDayCount = allDates.filter((d) => !weeklyOffKeys.includes(dayKey(d))).length;
  return {
    userId: String(user._id || user),
    year, month, from, to,
    daysInMonth,
    workingDays,
    weeklyOffDates,
    workingDayCount,              // payroll base (paid holidays stay payable)
    paidHolidayDates,
    holidayCount: paidHolidayDates.length,
    shift: shift ? { name: shift.name, type: shift.type, shiftAllowance: shift.shiftAllowance || 0, nightAllowance: shift.nightAllowance || 0, overtimeRatePerHour: shift.overtimeRatePerHour || 0 } : null,
    shiftSource: source,
  };
}

// ─── Audit (best-effort, never blocks) ──────────────────────────────────────
export async function auditSafe(entry) {
  try {
    const AuditLog = await model('AuditLog');
       await AuditLog.create({
      companyId: entry.companyId,
      user: entry.userId,
      action: entry.action,
      method: entry.method || 'POST',
      path: entry.path || '/api/schedule-module',
    });
  } catch (e) {
    console.warn('[audit] skipped:', e.message);
  }
}