import UsageMetric from '../models/UsageMetric.js';

const MODULE_BY_PREFIX = {
  attendance: 'ATTENDANCE',
  leaves: 'LEAVES',
  payroll: 'PAYROLL',
  recruitment: 'RECRUITMENT',
  projects: 'PROJECTS',
  tasks: 'TASKS',
  documents: 'DOCUMENTS',
  performance: 'PERFORMANCE',
  expenses: 'EXPENSES',
  assets: 'ASSETS',
  meetings: 'MEETINGS',
  holidays: 'HOLIDAYS',
  shifts: 'SHIFTS',
};

export const platformUsage = (
  req,
  res,
  next
) => {
  res.on('finish', () => {
    // Super Admin has no companyId, so platform routes
    // are not counted as customer-company usage.
    if (!req.companyId || !req.user) return;

    const date = new Date()
      .toISOString()
      .slice(0, 10);

    const pathPart =
      req.originalUrl
        .split('?')[0]
        .split('/')[2] || '';

    const moduleName =
      MODULE_BY_PREFIX[pathPart] || 'OTHER';

    const isFileUpload =
      req.method === 'POST' &&
      ['documents', 'profile'].includes(pathPart) &&
      res.statusCode < 400;

    UsageMetric.updateOne(
      {
        companyId: req.companyId,
        date,
      },
      {
        $inc: {
          apiRequests: 1,

          successfulRequests:
            res.statusCode < 400 ? 1 : 0,

          failedRequests:
            res.statusCode >= 400 ? 1 : 0,

          fileUploads:
            isFileUpload ? 1 : 0,

          [`moduleUsage.${moduleName}`]: 1,
        },

        $addToSet: {
          activeUserIds: req.user._id,
        },
      },
      {
        upsert: true,
      }
    ).catch(() => {});
  });

  next();
};