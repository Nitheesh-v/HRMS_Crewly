import Company from '../models/Company.js';
import Department from '../models/Department.js';
import JobPosting from '../models/JobPosting.js';
import ApiError from '../utils/ApiError.js';
import {
  getCurrentSubscription,
  hasFeature,
} from '../utils/subscriptionEngine.js';

const ELIGIBLE_SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'EXPIRING',
  'EXPIRING_SOON',
  'GRACE_PERIOD',
];
const MAX_PAGE = 10000;
const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 12;

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactTextRegex = (value) =>
  new RegExp(`^${escapeRegex(String(value || '').trim())}$`, 'i');

const safePublicUrl = (value, { allowQuery = true } = {}) => {
  try {
    const url = new URL(String(value || ''));

    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    if (!allowQuery && (url.search || url.hash)) return '';

    return url.toString();
  } catch {
    return '';
  }
};

const publicVisibilityFilter = (companyId, now = new Date()) => ({
  companyId,
  status: 'OPEN',
  publicationStatus: 'PUBLISHED',
  $and: [
    {
      $or: [
        { applicationDeadline: null },
        { applicationDeadline: { $exists: false } },
        { applicationDeadline: { $gt: now } },
      ],
    },
  ],
});

export const publicCompanyFields = (company) => ({
  name: company.name,
  logoUrl: safePublicUrl(company.logoUrl, { allowQuery: false }),
  about: company.careerAbout || '',
  website: safePublicUrl(company.careerWebsite),
  location: company.careerLocation || '',
});

const hasPublicSalary = (job) =>
  Boolean(job.publicSalaryVisible) &&
  [job.salaryMin, job.salaryMax].some(
    (value) => value !== null && value !== undefined
  );

const publicDescription = (value) =>
  String(value || '')
    .split(/\r?\n\s*\r?\n/)
    .map((section) => section.trim())
    .filter(
      (section) =>
        section && !/^hiring context\s*:/i.test(section)
    )
    .join('\n\n');

export const publicJobFields = (job) => ({
  jobCode: job.jobCode,
  title: job.title,
  department: job.department?.name || '',
  team: job.team || '',
  description: publicDescription(job.description),
  requiredSkills: Array.isArray(job.requiredSkills)
    ? job.requiredSkills
    : [],
  preferredSkills: Array.isArray(job.preferredSkills)
    ? job.preferredSkills
    : [],
  experienceLevel: job.experienceLevel,
  minExperience: job.minExperience,
  maxExperience: job.maxExperience,
  employmentType: job.employmentType,
  workMode: job.workMode,
  location: job.location || '',
  numberOfOpenings: job.openings,
  applicationDeadline: job.applicationDeadline || null,
  publishedAt: job.publishedAt || null,
  availability: 'ACCEPTING_APPLICATIONS',
  ...(hasPublicSalary(job)
    ? {
        salary: {
          min: job.salaryMin ?? null,
          max: job.salaryMax ?? null,
        },
      }
    : {}),
});

export const resolveCareerTenant = async (companySlug) => {
  const normalizedSlug = String(companySlug || '').trim().toLowerCase();
  const company = await Company.findOne({
    careerSlug: normalizedSlug,
    status: 'ACTIVE',
    archivedAt: null,
  })
    .select(
      '_id name logoUrl careerAbout careerWebsite careerLocation ' +
        'careerPortalEnabled'
    )
    .lean();

  if (!company || !company.careerPortalEnabled) {
    throw ApiError.notFound('Career portal is not available');
  }

  const [subscription, recruitmentEnabled] = await Promise.all([
    getCurrentSubscription(company._id),
    hasFeature(company._id, 'recruitment'),
  ]);

  if (
    !subscription ||
    !ELIGIBLE_SUBSCRIPTION_STATUSES.includes(subscription.status) ||
    !recruitmentEnabled
  ) {
    throw ApiError.notFound('Career portal is not available');
  }

  return company;
};

const paginationValues = (query = {}) => ({
  page: Math.min(MAX_PAGE, Math.max(1, Number(query.page) || 1)),
  limit: Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT)),
});

const publicSort = (sort) => {
  const sorts = {
    OLDEST: { publishedAt: 1, createdAt: 1 },
    TITLE_ASC: { title: 1, publishedAt: -1 },
    NEWEST: { publishedAt: -1, createdAt: -1 },
  };

  return sorts[String(sort || 'NEWEST').toUpperCase()] || sorts.NEWEST;
};

const buildListFilter = async ({ companyId, query, now }) => {
  const filter = publicVisibilityFilter(companyId, now);

  if (query.search?.trim()) {
    const search = new RegExp(escapeRegex(query.search.trim()), 'i');
    filter.$or = [
      { title: search },
      { description: search },
      { requiredSkills: search },
      { preferredSkills: search },
    ];
  }

  if (query.location?.trim()) {
    filter.location = exactTextRegex(query.location);
  }

  if (query.workMode) filter.workMode = query.workMode;
  if (query.employmentType) filter.employmentType = query.employmentType;
  if (query.experience) filter.experienceLevel = query.experience;

  if (query.department?.trim()) {
    const departmentIds = await Department.find({
      companyId,
      name: exactTextRegex(query.department),
    }).distinct('_id');

    filter.department = departmentIds.length
      ? { $in: departmentIds }
      : { $in: [] };
  }

  return filter;
};

export const getCareerHeader = async ({ companySlug }) => {
  const company = await resolveCareerTenant(companySlug);
  const openJobs = await JobPosting.countDocuments(
    publicVisibilityFilter(company._id)
  );

  return {
    company: publicCompanyFields(company),
    openJobs,
  };
};

export const listPublicJobs = async ({ companySlug, query = {} }) => {
  const company = await resolveCareerTenant(companySlug);
  const { page, limit } = paginationValues(query);
  const filter = await buildListFilter({
    companyId: company._id,
    query,
    now: new Date(),
  });

  const [jobs, total] = await Promise.all([
    JobPosting.find(filter)
      .select(
        'jobCode title department team description requiredSkills ' +
          'preferredSkills experienceLevel minExperience maxExperience ' +
          'employmentType workMode location openings applicationDeadline ' +
          'publishedAt publicSalaryVisible salaryMin salaryMax createdAt'
      )
      .populate({
        path: 'department',
        select: 'name -_id',
        match: { companyId: company._id },
      })
      .sort(publicSort(query.sort))
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    JobPosting.countDocuments(filter),
  ]);

  return {
    company: publicCompanyFields(company),
    jobs: jobs.map(publicJobFields),
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

export const getPublicJob = async ({ companySlug, jobCode }) => {
  const company = await resolveCareerTenant(companySlug);
  const normalizedJobCode = String(jobCode || '').trim().toUpperCase();
  const job = await JobPosting.findOne({
    ...publicVisibilityFilter(company._id),
    jobCode: normalizedJobCode,
  })
    .select(
      'jobCode title department team description requiredSkills ' +
        'preferredSkills experienceLevel minExperience maxExperience ' +
        'employmentType workMode location openings applicationDeadline ' +
        'publishedAt publicSalaryVisible salaryMin salaryMax status'
    )
    .populate({
      path: 'department',
      select: 'name -_id',
      match: { companyId: company._id },
    })
    .lean();

  if (job) {
    const deadlinePassed =
      job.applicationDeadline &&
      new Date(job.applicationDeadline).getTime() <= Date.now();

    if (job.status !== 'OPEN' || deadlinePassed) {
      throw new ApiError(410, 'This job is no longer accepting applications');
    }

    return {
      company: publicCompanyFields(company),
      job: publicJobFields(job),
    };
  }

  const wasPreviouslyPublished = await JobPosting.exists({
    companyId: company._id,
    jobCode: normalizedJobCode,
    publishedAt: { $ne: null },
  });

  if (wasPreviouslyPublished) {
    throw new ApiError(410, 'This job is no longer accepting applications');
  }

  throw ApiError.notFound('Job not found');
};

export const getCareerFilters = async ({ companySlug }) => {
  const company = await resolveCareerTenant(companySlug);
  const filter = publicVisibilityFilter(company._id);

  const [departmentIds, locations, workModes, employmentTypes, experience] =
    await Promise.all([
      JobPosting.distinct('department', filter),
      JobPosting.distinct('location', filter),
      JobPosting.distinct('workMode', filter),
      JobPosting.distinct('employmentType', filter),
      JobPosting.distinct('experienceLevel', filter),
    ]);

  const departments = await Department.find({
    _id: { $in: departmentIds },
    companyId: company._id,
  })
    .select('name -_id')
    .sort('name')
    .lean();

  const clean = (values) =>
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

  return {
    departments: departments.map((department) => department.name),
    locations: clean(locations),
    workModes: clean(workModes),
    employmentTypes: clean(employmentTypes),
    experience: clean(experience),
  };
};
