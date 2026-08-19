// ============================================================
// reportBuilderController.js — server-side, tenant-safe reports.
// HR/Admin can see their company. Managers/TLs see only their
// reporting subtree. Every module and field is whitelisted here.
// ============================================================
import mongoose from "mongoose";
import * as core from "../utils/reportingCore.js";
import * as orgHelpersNS from "../utils/orgHelpers.js";
import { auditSafe } from "../utils/scheduleEngine.js";

const ok = (res, status, data, message) =>
  res.status(status).json({
    statusCode: status,
    success: true,
    data,
    message,
  });

const fail = (res, status, message) =>
  res.status(status).json({
    statusCode: status,
    success: false,
    message,
  });

const getSubtreeIds =
  orgHelpersNS.getSubtreeIds || orgHelpersNS.default?.getSubtreeIds;

const objectId = (value) => {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    return value;
  }

  return new mongoose.Types.ObjectId(value);
};

const httpError = (status, message) => {
  const error = new Error(message);
  error.code = status;
  return error;
};

// ------------------------------------------------------------
// MODULE REGISTRY
//
// Only these modules and fields may be used in reports.
//
// tenantField:
// The real field stored inside MongoDB. Mongo aggregation does
// not automatically translate Mongoose aliases.
//
// scopeField:
// The field used to restrict Manager/TL reports to their team.
// ------------------------------------------------------------
const MODULES = {
  employees: {
    model: "User",
    label: "Employees",
    dateField: "createdAt",
    tenantField: "companyId",
    scopeField: "_id",

    fields: [
      {
        key: "name",
        label: "Name",
      },
      {
        key: "email",
        label: "Email",
      },
      {
        key: "role",
        label: "Role",
      },
      {
        key: "designation",
        label: "Designation",
      },
      {
        key: "departmentName",
        label: "Department",
      },
      {
        key: "status",
        label: "Status",
      },
      {
        key: "createdAt",
        label: "Joining Date",
        map: core.dstr,
      },
    ],

    lookups: [
      {
        from: "departments",
        localField: "department",
        foreignField: "_id",
        as: "dept",
      },
    ],

    post: (doc) => ({
      ...doc,
      departmentName: doc.dept?.[0]?.name || "—",
    }),
  },

  attendance: {
    model: "Attendance",
    label: "Attendance",
    dateField: "date",

    // Attendance.date is stored as "YYYY-MM-DD", not Date.
    dateStorage: "string",

    tenantField: "companyId",
    scopeField: "user",

    fields: [
      {
        key: "userName",
        label: "Employee",
      },
      {
        key: "date",
        label: "Date",
        map: core.dstr,
      },
      {
        key: "status",
        label: "Status",
      },
    ],

    lookups: [
      {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "u",
      },
    ],

    post: (doc) => ({
      ...doc,
      userName: doc.u?.[0]?.name || "—",
    }),
  },

  leaves: {
    model: "Leave",
    label: "Leaves",
    dateField: "createdAt",
    tenantField: "companyId",
    scopeField: "user",

    fields: [
      {
        key: "userName",
        label: "Employee",
      },
      {
        key: "type",
        label: "Type",
      },
      {
        key: "status",
        label: "Status",
      },
      {
        key: "days",
        label: "Days",
      },
      {
        key: "startDate",
        label: "From",
        map: core.dstr,
      },
      {
        key: "endDate",
        label: "To",
        map: core.dstr,
      },
    ],

    lookups: [
      {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "u",
      },
    ],

    post: (doc) => ({
      ...doc,
      userName: doc.u?.[0]?.name || "—",
    }),
  },

  tasks: {
    model: "Task",
    label: "Tasks",
    dateField: "createdAt",

    // Task stores the physical tenant field as "company".
    tenantField: "company",

    scopeField: "assignedTo",

    fields: [
      {
        key: "title",
        label: "Task",
      },
      {
        key: "status",
        label: "Status",
      },
      {
        key: "priority",
        label: "Priority",
      },
      {
        key: "assigneeName",
        label: "Assigned To",
      },
      {
        key: "dueDate",
        label: "Due",
        map: core.dstr,
      },
    ],

    lookups: [
      {
        from: "users",
        localField: "assignedTo",
        foreignField: "_id",
        as: "u",
      },
    ],

    post: (doc) => ({
      ...doc,
      assigneeName: doc.u?.[0]?.name || "—",
    }),
  },

  expenses: {
    model: "Expense",
    label: "Expenses",
    dateField: "createdAt",
    tenantField: "companyId",
    scopeField: "user",

    fields: [
      {
        key: "userName",
        label: "Employee",
      },
      {
        key: "category",
        label: "Category",
      },
      {
        key: "amount",
        label: "Amount ₹",
      },
      {
        key: "status",
        label: "Status",
      },
      {
        key: "expenseDate",
        label: "Expense Date",
        map: core.dstr,
      },
      {
        key: "createdAt",
        label: "Submitted",
        map: core.dstr,
      },
    ],

    lookups: [
      {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "u",
      },
    ],

    post: (doc) => ({
      ...doc,
      userName: doc.u?.[0]?.name || "—",
    }),
  },

  payroll: {
    model: "Payroll",
    label: "Payroll (HR only)",
    dateField: "createdAt",
    tenantField: "companyId",
    scopeField: "user",
    hrOnly: true,

    fields: [
      {
        key: "userName",
        label: "Employee",
      },
      {
        key: "month",
        label: "Month",
      },
      {
        key: "year",
        label: "Year",
      },
      {
        key: "grossSalary",
        label: "Gross ₹",
      },
      {
        key: "netSalary",
        label: "Net ₹",
      },
      {
        key: "totalDeductions",
        label: "Deductions ₹",
      },
      {
        key: "status",
        label: "Status",
      },
    ],

    lookups: [
      {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "u",
      },
    ],

    // Convert the nested Payroll model fields into flat
    // report-friendly fields.
    post: (doc) => ({
      ...doc,

      userName: doc.u?.[0]?.name || "—",

      year: String(doc.month || "").slice(0, 4),

      grossSalary: doc.earnings?.gross ?? doc.grossSalary ?? doc.gross ?? 0,

      netSalary: doc.netPay ?? doc.netSalary ?? doc.net ?? 0,

      totalDeductions:
        doc.deductions?.total ?? doc.totalDeductions ?? doc.deduction ?? 0,
    }),
  },
};

// ============================================================
// GET /api/report-builder/meta
// ============================================================

export async function builderMeta(req, res) {
  const isHR =
    req.user.role === "COMPANY_ADMIN" || req.user.role === "HR_MANAGER";

  const modules = Object.entries(MODULES)
    .filter(([, definition]) => !definition.hrOnly || isHR)
    .map(([key, definition]) => ({
      key,
      label: definition.label,

      fields: definition.fields.map(({ key: fieldKey, label }) => ({
        key: fieldKey,
        label,
      })),
    }));

  return ok(
    res,
    200,
    {
      modules,
    },
    "Report builder meta",
  );
}

// ============================================================
// MANAGER / TEAM LEAD SCOPE
// ============================================================

async function teamScopeIds(req) {
  const isTeamRole =
    req.user.role === "MANAGER" || req.user.role === "TEAM_LEAD";

  if (!isTeamRole) {
    return null;
  }

  // Safe fallback: if the org helper is unavailable,
  // the requester can only see their own rows.
  if (!getSubtreeIds) {
    return [req.user._id];
  }

  const companyId = req.companyId || req.user.companyId;

  const ids = await getSubtreeIds(companyId, req.user._id);

  return ids.map(objectId);
}

function intersectIds(first = [], second = []) {
  const secondSet = new Set(second.map(String));

  return first.filter((id) => secondSet.has(String(id)));
}

// ============================================================
// DEPARTMENT FILTER
// ============================================================

async function applyDepartmentFilter({ req, definition, match, scopeIds }) {
  const departmentId =
    req.body.filters?.departmentId || req.body.filters?.department;

  if (!departmentId) {
    return;
  }

  // Employee documents contain the department directly.
  if (definition.model === "User") {
    match.department = objectId(departmentId);

    return;
  }

  // Attendance, leave, task, expense and payroll records do not
  // carry department directly. Resolve department employees first.
  const User = await core.getModel("User");

  const companyId = req.companyId || req.user.companyId;

  const users = await User.find({
    companyId,
    department: objectId(departmentId),
  })
    .select("_id")
    .lean();

  const departmentUserIds = users.map((user) => user._id);

  const allowedIds = scopeIds
    ? intersectIds(scopeIds, departmentUserIds)
    : departmentUserIds;

  match[definition.scopeField] = {
    $in: allowedIds,
  };
}

// ============================================================
// PAYROLL PERIOD FILTER
// ============================================================

function applyPayrollPeriodFilter(match, filters) {
  const month = String(filters.month || "").trim();

  const year = String(filters.year || "").trim();

  // Exact "2026-08" format.
  if (/^\d{4}-\d{2}$/.test(month)) {
    match.month = month;
    return;
  }

  // Month "8" + year "2026".
  if (/^\d{1,2}$/.test(month) && /^\d{4}$/.test(year)) {
    match.month = `${year}-${month.padStart(2, "0")}`;

    return;
  }

  // Whole year.
  if (/^\d{4}$/.test(year)) {
    match.month = {
      $regex: `^${year}-`,
    };
  }
}

// ============================================================
// SHARED REPORT ENGINE
// Used by both Generate and Export.
// ============================================================

async function buildRows(req, cap) {
  const definition = MODULES[req.body?.module];

  if (!definition) {
    throw httpError(400, "Unknown report module");
  }

  const isHR =
    req.user.role === "COMPANY_ADMIN" || req.user.role === "HR_MANAGER";

  if (definition.hrOnly && !isHR) {
    throw httpError(403, "Forbidden");
  }

  const companyId = req.companyId || req.user.companyId;

  if (!companyId) {
    throw httpError(400, "Company context required");
  }

  const Model = await core.getModel(definition.model);

  const scopeIds = await teamScopeIds(req);

  // ----------------------------------------------------------
  // STEP 1 — Tenant filter.
  //
  // Always use the physical field stored in MongoDB.
  // ----------------------------------------------------------
  const match = {
    [definition.tenantField]: objectId(companyId),
  };

  // ----------------------------------------------------------
  // STEP 2 — Manager/TL subtree restriction.
  // ----------------------------------------------------------
  if (scopeIds) {
    match[definition.scopeField] = {
      $in: scopeIds,
    };
  }

  // ----------------------------------------------------------
  // STEP 3 — Date range.
  // ----------------------------------------------------------
  const { from, to } = core.rangeFromQuery(req.body || {});

  if (definition.dateField) {
    if (definition.dateStorage === "string") {
      match[definition.dateField] = {
        $gte: core.dstr(from),
        $lte: core.dstr(to),
      };
    } else {
      match[definition.dateField] = {
        $gte: from,
        $lte: to,
      };
    }
  }

  // ----------------------------------------------------------
  // STEP 4 — Simple whitelisted filters.
  // ----------------------------------------------------------
  const filters = req.body.filters || {};

  ["status", "type", "role", "category"].forEach((fieldName) => {
    if (filters[fieldName]) {
      match[fieldName] = filters[fieldName];
    }
  });

  await applyDepartmentFilter({
    req,
    definition,
    match,
    scopeIds,
  });

  if (definition.model === "Payroll") {
    applyPayrollPeriodFilter(match, filters);
  }

  // ----------------------------------------------------------
  // STEP 5 — Select report columns.
  // ----------------------------------------------------------
  const requestedFields = Array.isArray(req.body.fields) ? req.body.fields : [];

  const wantedKeys = (
    requestedFields.length
      ? requestedFields
      : definition.fields.map((field) => field.key)
  ).slice(0, 12);

  const columns = definition.fields.filter((field) =>
    wantedKeys.includes(field.key),
  );

  if (!columns.length) {
    throw httpError(400, "Select at least one report field");
  }

  // ----------------------------------------------------------
  // STEP 6 — Mongo aggregation.
  // ----------------------------------------------------------
  const sortField = definition.dateField || "createdAt";

  const sortDirection = req.body.sortDir === "asc" ? 1 : -1;

  const pipeline = [
    {
      $match: match,
    },
    {
      $sort: {
        [sortField]: sortDirection,
      },
    },
    {
      $limit: cap,
    },

    ...(definition.lookups || []).map((lookup) => ({
      $lookup: lookup,
    })),
  ];

  const [total, docs] = await Promise.all([
    Model.countDocuments(match),

    Model.aggregate(pipeline).allowDiskUse(true),
  ]);

  // ----------------------------------------------------------
  // STEP 7 — Flatten rows for frontend/CSV/Excel.
  // ----------------------------------------------------------
  const rows = docs.map((doc) => {
    const shaped = definition.post ? definition.post(doc) : doc;

    const row = {};

    columns.forEach((column) => {
      const rawValue = shaped[column.key];

      // IMPORTANT FIX:
      // Pass only the field value into core.dstr/map.
      // The old code passed the whole Mongo document.
      const displayValue = column.map ? column.map(rawValue, shaped) : rawValue;

      row[column.key] = displayValue ?? "";
    });

    return row;
  });

  return {
    columns,
    rows,
    total,
    capped: total > cap,
    from,
    to,
  };
}

// ============================================================
// POST /api/report-builder/run
// ============================================================

export async function runReport(req, res) {
  try {
    const page = Math.max(1, parseInt(req.body.page, 10) || 1);

    const pageSize = Math.max(
      1,
      Math.min(100, parseInt(req.body.pageSize, 10) || 25),
    );

    const result = await buildRows(req, 5000);

    const start = (page - 1) * pageSize;

    const rows = result.rows.slice(start, start + pageSize);

    await auditSafe({
      companyId: req.companyId || req.user.companyId,

      userId: req.user._id,

      action: "REPORT_RUN",

      target: req.body.module,

      method: req.method,

      path: req.originalUrl,
    });

    return ok(
      res,
      200,
      {
        columns: result.columns.map(({ key, label }) => ({
          key,
          label,
        })),

        rows,

        // The report is capped at 5000 rows.
        total: Math.min(result.total, 5000),

        actualTotal: result.total,

        capped: result.capped,

        page,
        pageSize,

        from: core.dstr(result.from),

        to: core.dstr(result.to),
      },
      "Report generated",
    );
  } catch (error) {
    console.error("[report-builder/run]", error);

    return fail(
      res,
      error.code || 500,
      error.message || "Could not generate report",
    );
  }
}

// ============================================================
// POST /api/report-builder/export?format=csv|xls
// ============================================================

export async function exportReport(req, res) {
  try {
    const result = await buildRows(req, 5000);

    await auditSafe({
      companyId: req.companyId || req.user.companyId,

      userId: req.user._id,

      action: "REPORT_EXPORT",

      target: req.body.module,

      method: req.method,

      path: req.originalUrl,

      detail: JSON.stringify(req.body.filters || {}),
    });

    const stamp = `${core.dstr(result.from)}_${core.dstr(result.to)}`;

    const filename = `${req.body.module}-report-${stamp}`;

    const columns = result.columns.map(({ key, label }) => ({
      key,
      label,
    }));

    if (req.query.format === "xls") {
      return core.sendXls(res, `${filename}.xls`, columns, result.rows);
    }

    return core.sendCsv(
      res,
      `${filename}.csv`,
      core.toCsv(columns, result.rows),
    );
  } catch (error) {
    console.error("[report-builder/export]", error);

    return fail(
      res,
      error.code || 500,
      error.message || "Could not export report",
    );
  }
}
