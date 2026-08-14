// ============================================================
// reportBuilderController.js — HR/Admin pick a module + fields +
// filters, we generate a table server-side (max 5000 rows) and
// can export it as CSV or Excel. Employees/TLs are blocked by
// the route AND double-checked here (defense in depth).
// Every run/export is written to the audit log.
// ============================================================
import * as core from '../utils/reportingCore.js';
import { auditSafe } from '../utils/scheduleEngine.js';

const ok = (res, status, data, message) => res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ statusCode: status, success: false, message });

// ------------------------------------------------------------
// MODULE REGISTRY — the ONLY modules/fields a report can touch.
// Whitelisting = nobody can craft a query for data they shouldn't see.
// ------------------------------------------------------------
const MODULES = {
  employees: {
    model: 'User', label: 'Employees', dateField: 'createdAt',
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'role', label: 'Role' },
      { key: 'designation', label: 'Designation' },
      { key: 'departmentName', label: 'Department' }, // filled after the $lookup join
      { key: 'status', label: 'Status' },
      { key: 'createdAt', label: 'Joining Date', map: core.dstr },
    ],
    lookups: [{ from: 'departments', localField: 'department', foreignField: '_id', as: 'dept' }],
    post: (doc) => ({ ...doc, departmentName: doc.dept?.[0]?.name || '—' }),
  },
  attendance: {
    model: 'Attendance', label: 'Attendance', dateField: 'date',
    fields: [
      { key: 'userName', label: 'Employee' },
      { key: 'date', label: 'Date', map: core.dstr },
      { key: 'status', label: 'Status' },
    ],
    lookups: [{ from: 'users', localField: 'user', foreignField: '_id', as: 'u' }],
    post: (doc) => ({ ...doc, userName: doc.u?.[0]?.name || '—' }),
  },
  leaves: {
    model: 'Leave', label: 'Leaves', dateField: 'createdAt',
    fields: [
      { key: 'userName', label: 'Employee' },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'days', label: 'Days' },
      { key: 'startDate', label: 'From', map: core.dstr },
      { key: 'endDate', label: 'To', map: core.dstr },
    ],
    lookups: [{ from: 'users', localField: 'user', foreignField: '_id', as: 'u' }],
    post: (doc) => ({ ...doc, userName: doc.u?.[0]?.name || '—' }),
  },
  tasks: {
    model: 'Task', label: 'Tasks', dateField: 'createdAt',
    fields: [
      { key: 'title', label: 'Task' },
      { key: 'status', label: 'Status' },
      { key: 'priority', label: 'Priority' },
      { key: 'assigneeName', label: 'Assigned To' },
      { key: 'dueDate', label: 'Due', map: core.dstr },
    ],
    lookups: [{ from: 'users', localField: 'assignedTo', foreignField: '_id', as: 'u' }],
    post: (doc) => ({ ...doc, assigneeName: doc.u?.[0]?.name || '—' }),
  },
  expenses: {
    model: 'Expense', label: 'Expenses', dateField: 'createdAt',
    fields: [
      { key: 'userName', label: 'Employee' },
      { key: 'category', label: 'Category' },
      { key: 'amount', label: 'Amount ₹' },
      { key: 'status', label: 'Status' },
      { key: 'createdAt', label: 'Submitted', map: core.dstr },
    ],
    lookups: [{ from: 'users', localField: 'user', foreignField: '_id', as: 'u' }],
    post: (doc) => ({ ...doc, userName: doc.u?.[0]?.name || '—' }),
  },
  payroll: {
    model: 'Payroll', label: 'Payroll (HR only)', dateField: 'createdAt', hrOnly: true,
    fields: [
      { key: 'userName', label: 'Employee' },
      { key: 'month', label: 'Month' },
      { key: 'year', label: 'Year' },
      { key: 'grossSalary', label: 'Gross ₹' },
      { key: 'netSalary', label: 'Net ₹' },
      { key: 'totalDeductions', label: 'Deductions ₹' },
      { key: 'status', label: 'Status' },
    ],
    lookups: [{ from: 'users', localField: 'user', foreignField: '_id', as: 'u' }],
    post: (doc) => ({ ...doc, userName: doc.u?.[0]?.name || '—' }),
  },
};

// GET /api/report-builder/meta — what the frontend dropdowns show.
// Payroll is hidden from non-HR here too (UI-level; backend still enforces).
export async function builderMeta(req, res) {
  const isHR = req.user.role === 'COMPANY_ADMIN' || req.user.role === 'HR_MANAGER';
  const modules = Object.entries(MODULES)
    .filter(([, def]) => !def.hrOnly || isHR)
    .map(([key, def]) => ({
      key,
      label: def.label,
      fields: def.fields.map(({ key: fieldKey, label }) => ({ key: fieldKey, label })),
    }));
  return ok(res, 200, { modules }, 'Report builder meta');
}

// ------------------------------------------------------------
// Shared engine of run + export: build the Mongo query from the
// whitelisted module + user filters, return up to `cap` rows.
// ------------------------------------------------------------
async function buildRows(req, cap) {
  const def = MODULES[req.body.module];
  if (!def) throw new Error('Unknown module');

  const isHR = req.user.role === 'COMPANY_ADMIN' || req.user.role === 'HR_MANAGER';
  if (def.hrOnly && !isHR) {
    const error = new Error('Forbidden'); error.code = 403; throw error;
  }

  const Model = await core.getModel(def.model);

  // STEP 1: base filter — ALWAYS companyId first (tenant isolation)
  const match = { companyId: req.user.companyId };
  const { from, to } = core.rangeFromQuery(req.body);
  if (def.dateField) match[def.dateField] = { $gte: from, $lte: to };

  // STEP 2: apply the simple filters the user picked (status/type/role…)
  const filters = req.body.filters || {};
  ['status', 'type', 'role', 'category', 'department'].forEach((fieldName) => {
    // allow departmentId as a friendlier alias of department
    if (fieldName === 'department' && filters.departmentId) match.department = filters.departmentId;
    else if (filters[fieldName]) match[fieldName] = filters[fieldName];
  });
  if (filters.month) match.month = parseInt(filters.month, 10);
  if (filters.year) match.year = parseInt(filters.year, 10);

  // STEP 3: which columns did the user pick? (default: all, max 12)
  const wantedKeys = (req.body.fields && req.body.fields.length ? req.body.fields : def.fields.map((f) => f.key)).slice(0, 12);
  const columns = def.fields.filter((f) => wantedKeys.includes(f.key));

  // STEP 4: run ONE aggregation — sort, cap, join names — inside Mongo
  const total = await Model.countDocuments(match);
  const pipeline = [
    { $match: match },
    { $sort: { [def.dateField || 'createdAt']: req.body.sortDir === 'asc' ? 1 : -1 } },
    { $limit: cap },
    ...def.lookups.map((lookup) => ({ $lookup: lookup })),
  ];
  const docs = await Model.aggregate(pipeline).allowDiskUse(true);

  // STEP 5: shape each doc into a flat row { fieldKey: displayValue }
  const rows = docs.map((doc) => {
    const shaped = def.post ? def.post(doc) : doc;
    const row = {};
    columns.forEach((col) => {
      row[col.key] = col.map ? col.map(doc) : (shaped[col.key] ?? '');
    });
    return row;
  });

  return { columns, rows, total, from, to };
}

// POST /api/report-builder/run — returns a page of the table
export async function runReport(req, res) {
  try {
    const page = Math.max(1, parseInt(req.body.page, 10) || 1);
    const pageSize = Math.min(100, parseInt(req.body.pageSize, 10) || 25);

    const result = await buildRows(req, 5000); // hard cap: never load more than 5000
    const rows = result.rows.slice((page - 1) * pageSize, page * pageSize);

    await auditSafe({ companyId: req.user.companyId, userId: req.user._id, action: 'REPORT_RUN', target: req.body.module, method: req.method, path: req.originalUrl });

    return ok(res, 200, {
      columns: result.columns.map(({ key, label }) => ({ key, label })),
      rows,
      total: result.total,
      page,
      pageSize,
      from: core.dstr(result.from),
      to: core.dstr(result.to),
    }, 'Report generated');
  } catch (error) {
    return fail(res, error.code || 500, error.message);
  }
}

// POST /api/report-builder/export?format=csv|xls — same query, downloaded as a file
export async function exportReport(req, res) {
  try {
    const result = await buildRows(req, 5000);

    await auditSafe({ companyId: req.user.companyId, userId: req.user._id, action: 'REPORT_EXPORT', target: req.body.module, method: req.method, path: req.originalUrl, detail: JSON.stringify(req.body.filters || {}) });

    const stamp = `${core.dstr(result.from)}_${core.dstr(result.to)}`;
    const filename = `${req.body.module}-report-${stamp}`;
    const columns = result.columns.map((col) => ({ key: col.key, label: col.label }));

    if (req.query.format === 'xls') return core.sendXls(res, `${filename}.xls`, columns, result.rows);
    return core.sendCsv(res, `${filename}.csv`, core.toCsv(columns, result.rows));
  } catch (error) {
    return fail(res, error.code || 500, error.message);
  }
}