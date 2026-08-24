import Company from '../models/Company.js';
import JobPosting from '../models/JobPosting.js';
import TenantSequence from '../models/TenantSequence.js';

export const slugifyCareerValue = (value) =>
  String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');

export const nextJobCode = async (companyId) => {
  let sequence;

  try {
    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key: 'JOB_POSTING' },
      {
        $inc: { value: 1 },
        $setOnInsert: { companyId, key: 'JOB_POSTING' },
      },
      {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
      }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key: 'JOB_POSTING' },
      { $inc: { value: 1 } },
      { returnDocument: 'after' }
    );
  }

  return `JOB-${String(sequence.value).padStart(4, '0')}`;
};

const reserveJobCodeRange = async (companyId, count) => {
  let sequence;

  try {
    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key: 'JOB_POSTING' },
      {
        $inc: { value: count },
        $setOnInsert: { companyId, key: 'JOB_POSTING' },
      },
      {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
      }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key: 'JOB_POSTING' },
      { $inc: { value: count } },
      { returnDocument: 'after' }
    );
  }

  return sequence.value - count + 1;
};

const uniqueCareerSlug = ({ company, usedSlugs }) => {
  const codeBase = slugifyCareerValue(company.code) || String(company._id).slice(-8);
  const companyName = slugifyCareerValue(company.name);
  const nameBase = companyName.length >= 3 ? companyName : codeBase;
  let candidate = nameBase;
  let suffix = 1;

  if (usedSlugs.has(candidate)) {
    candidate = `${nameBase.slice(0, Math.max(1, 62 - codeBase.length))}-${codeBase}`;
  }

  while (usedSlugs.has(candidate)) {
    const number = String(suffix++);
    candidate = `${nameBase.slice(0, Math.max(1, 62 - number.length))}-${number}`;
  }

  usedSlugs.add(candidate);
  return candidate;
};

const claimCareerSlug = async ({ company, usedSlugs }) => {
  while (true) {
    const careerSlug = uniqueCareerSlug({ company, usedSlugs });

    try {
      const updated = await Company.findOneAndUpdate(
        {
          _id: company._id,
          $or: [
            { careerSlug: { $exists: false } },
            { careerSlug: '' },
            { careerSlug: null },
          ],
        },
        { $set: { careerSlug } },
        { returnDocument: 'after', runValidators: true }
      ).select('_id');

      return Boolean(updated);
    } catch (error) {
      if (error.code !== 11000) throw error;
      // Another process reserved this candidate; generate the next safe slug.
    }
  }
};

export const ensureCareerPortalIdentifiers = async () => {
  const [existingSlugRows, missingSlugCompanies, missingCodeJobs] =
    await Promise.all([
      Company.find({ careerSlug: { $exists: true, $ne: '' } })
        .select('careerSlug')
        .lean(),
      Company.find({
        $or: [
          { careerSlug: { $exists: false } },
          { careerSlug: '' },
          { careerSlug: null },
        ],
      })
        .select('_id name code')
        .sort({ createdAt: 1, _id: 1 })
        .lean(),
      JobPosting.find({
        $or: [
          { jobCode: { $exists: false } },
          { jobCode: '' },
          { jobCode: null },
        ],
      })
        .select('_id companyId')
        .sort({ companyId: 1, createdAt: 1, _id: 1 })
        .lean(),
    ]);

  const usedSlugs = new Set(
    existingSlugRows
      .map((row) => slugifyCareerValue(row.careerSlug))
      .filter(Boolean)
  );

  let companySlugsBackfilled = 0;

  for (const company of missingSlugCompanies) {
    if (await claimCareerSlug({ company, usedSlugs })) {
      companySlugsBackfilled += 1;
    }
  }

  await Company.updateMany(
    { careerPortalEnabled: { $exists: false } },
    { $set: { careerPortalEnabled: false } }
  );

  const jobsByCompany = new Map();

  missingCodeJobs.forEach((job) => {
    const key = String(job.companyId);
    const jobs = jobsByCompany.get(key) || [];
    jobs.push(job);
    jobsByCompany.set(key, jobs);
  });

  for (const jobs of jobsByCompany.values()) {
    const companyId = jobs[0].companyId;
    const start = await reserveJobCodeRange(companyId, jobs.length);

    await JobPosting.bulkWrite(
      jobs.map((job, index) => ({
        updateOne: {
          filter: {
            _id: job._id,
            companyId,
            $or: [
              { jobCode: { $exists: false } },
              { jobCode: '' },
              { jobCode: null },
            ],
          },
          update: {
            $set: {
              jobCode: `JOB-${String(start + index).padStart(4, '0')}`,
            },
          },
        },
      })),
      { ordered: false }
    );
  }

  const [publicationResult, salaryResult] = await Promise.all([
    JobPosting.updateMany(
      { publicationStatus: { $exists: false } },
      { $set: { publicationStatus: 'DRAFT', publishedAt: null } }
    ),
    JobPosting.updateMany(
      { publicSalaryVisible: { $exists: false } },
      { $set: { publicSalaryVisible: false } }
    ),
  ]);

  return {
    companySlugsBackfilled,
    jobCodesBackfilled: missingCodeJobs.length,
    publicationRowsBackfilled: publicationResult.modifiedCount,
    salaryFlagsBackfilled: salaryResult.modifiedCount,
  };
};
