import mongoose from "mongoose";
import AuditLog from "../models/AuditLog.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { recordSecurityEvent } from "../utils/securityauditService.js";

const escapeRegex = (value) =>
  String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .slice(0, 100);

const validDate = (value, endOfDay = false) => {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }

  return date;
};

const buildFilter = (companyId, query) => {
  const filter = {
    companyId,
  };

  const search = escapeRegex(query.search || "");

  if (search) {
    const regex = new RegExp(search, "i");

    filter.$or = [
      { actorName: regex },
      { action: regex },
      { path: regex },
      { targetType: regex },
    ];
  }

  if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(query.method)) {
    filter.method = query.method;
  }

  if (query.status === "success") {
    filter.statusCode = {
      $lt: 400,
    };
  }

  if (query.status === "failed") {
    filter.statusCode = {
      $gte: 400,
    };
  }

  if (query.actorId && mongoose.isValidObjectId(query.actorId)) {
    filter.actor = query.actorId;
  }

  if (query.action) {
    filter.action = String(query.action).slice(0, 100);
  }

  if (query.targetType) {
    filter.targetType = String(query.targetType).slice(0, 80);
  }

  const from = validDate(query.from);

  const to = validDate(query.to, true);

  if (from || to) {
    filter.createdAt = {
      ...(from && {
        $gte: from,
      }),

      ...(to && {
        $lte: to,
      }),
    };
  }

  return filter;
};

export const listAuditLogs = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const page = Math.max(1, Number(req.query.page) || 1);

  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));

  const filter = buildFilter(req.companyId, req.query);

  // DB Logic - DB logics
  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .populate("actor", "name email role")
      .sort("-createdAt")
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),

    AuditLog.countDocuments(filter),
  ]);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Audit logs",

    data: logs,

    meta: {
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      total,
      limit,
    },
  });
});

export const auditLogDetail = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!mongoose.isValidObjectId(req.params.id)) {
    throw ApiError.badRequest("Invalid audit log id");
  }

  // DB Logic - DB logics
  const log = await AuditLog.findOne({
    _id: req.params.id,
    companyId: req.companyId,
  })
    .populate("actor", "name email role")
    .lean();

  if (!log) {
    throw ApiError.notFound("Audit log not found");
  }

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Audit log detail",
    data: log,
  });
});

export const auditSummary = asyncHandler(async (req, res) => {
  const since =
    // Data from frontend - requests from frontend
    validDate(req.query.from) ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const match = {
    companyId: req.companyId,

    createdAt: {
      $gte: since,
    },
  };

  // DB Logic - DB logics
  const [total, failed, methods, actions] = await Promise.all([
    AuditLog.countDocuments(match),

    AuditLog.countDocuments({
      ...match,
      statusCode: {
        $gte: 400,
      },
    }),

    AuditLog.aggregate([
      { $match: match },

      {
        $group: {
          _id: "$method",
          count: {
            $sum: 1,
          },
        },
      },

      {
        $sort: {
          count: -1,
        },
      },
    ]),

    AuditLog.aggregate([
      { $match: match },

      {
        $group: {
          _id: "$action",
          count: {
            $sum: 1,
          },
        },
      },

      {
        $sort: {
          count: -1,
        },
      },

      { $limit: 8 },
    ]),
  ]);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: "Audit summary",

    data: {
      total,
      failed,
      methods,
      actions,
      since,
    },
  });
});

const csvCell = (value) => {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  // Prevent spreadsheet formulas.
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replaceAll('"', '""')}"`;
};

export const exportAuditCsv = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const filter = buildFilter(req.companyId, req.query);

  // DB Logic - DB logics
  const logs = await AuditLog.find(filter)
    .sort("-createdAt")
    .limit(10000)
    .lean();

  const columns = [
    "Date",
    "Actor",
    "Role",
    "Action",
    "Method",
    "Path",
    "Status",
    "IP",
    "Target type",
    "Target ID",
    "Metadata",
  ];

  const rows = logs.map((log) => [
    log.createdAt?.toISOString(),
    log.actorName,
    log.actorRole,
    log.action,
    log.method,
    log.path,
    log.statusCode,
    log.ip,
    log.targetType,
    log.targetId,
    log.metadata,
  ]);

  const csv = `\uFEFF${[columns, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}`;

  await recordSecurityEvent(req, {
    type: "AUDIT_LOG_EXPORTED",

    severity: "WARNING",

    message: "Tenant audit records exported to CSV",

    metadata: {
      exportedRows: logs.length,
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="crewly-audit-${stamp}.csv"`,
  );

  // Data to frontend - response to frontend
  return res.status(200).send(csv);
});
