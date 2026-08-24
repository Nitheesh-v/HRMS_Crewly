import Candidate from '../models/Candidate.js';
import TenantSequence from '../models/TenantSequence.js';

const SEQUENCE_KEY = 'CANDIDATE';

const updateSequence = async ({ companyId, update }) => {
  try {
    return await TenantSequence.findOneAndUpdate(
      { companyId, key: SEQUENCE_KEY },
      {
        ...update,
        $setOnInsert: { companyId, key: SEQUENCE_KEY },
      },
      {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
      }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    return TenantSequence.findOneAndUpdate(
      { companyId, key: SEQUENCE_KEY },
      update,
      { returnDocument: 'after' }
    );
  }
};

export const nextCandidateCode = async (companyId) => {
  const sequence = await updateSequence({
    companyId,
    update: { $inc: { value: 1 } },
  });

  return `CAN-${String(sequence.value).padStart(6, '0')}`;
};

const reserveCandidateCodeRange = async (companyId, count) => {
  const sequence = await updateSequence({
    companyId,
    update: { $inc: { value: count } },
  });

  return sequence.value - count + 1;
};

const existingCodeValue = (candidateCode) => {
  const match = /^CAN-(\d+)$/i.exec(String(candidateCode || '').trim());
  return match ? Number(match[1]) : 0;
};

export const ensureCandidateIdentifiers = async () => {
  const [codedCandidates, missingCodeCandidates] = await Promise.all([
    Candidate.find({ candidateCode: /^CAN-\d+$/i })
      .select('companyId candidateCode')
      .lean(),
    Candidate.find({
      $or: [
        { candidateCode: { $exists: false } },
        { candidateCode: '' },
        { candidateCode: null },
      ],
    })
      .select('_id companyId')
      .sort({ companyId: 1, createdAt: 1, _id: 1 })
      .lean(),
  ]);

  const highestByCompany = new Map();
  codedCandidates.forEach((candidate) => {
    const key = String(candidate.companyId);
    highestByCompany.set(
      key,
      Math.max(
        highestByCompany.get(key) || 0,
        existingCodeValue(candidate.candidateCode)
      )
    );
  });

  for (const [companyId, value] of highestByCompany.entries()) {
    await updateSequence({
      companyId,
      update: { $max: { value } },
    });
  }

  const candidatesByCompany = new Map();
  missingCodeCandidates.forEach((candidate) => {
    const key = String(candidate.companyId);
    const rows = candidatesByCompany.get(key) || [];
    rows.push(candidate);
    candidatesByCompany.set(key, rows);
  });

  let candidateCodesBackfilled = 0;

  for (const candidates of candidatesByCompany.values()) {
    const companyId = candidates[0].companyId;
    const start = await reserveCandidateCodeRange(
      companyId,
      candidates.length
    );

    const result = await Candidate.bulkWrite(
      candidates.map((candidate, index) => ({
        updateOne: {
          filter: {
            _id: candidate._id,
            companyId,
            $or: [
              { candidateCode: { $exists: false } },
              { candidateCode: '' },
              { candidateCode: null },
            ],
          },
          update: {
            $set: {
              candidateCode: `CAN-${String(start + index).padStart(6, '0')}`,
            },
          },
        },
      })),
      { ordered: false }
    );

    candidateCodesBackfilled += result.modifiedCount;
  }

  const [
    sourceResult,
    statusResult,
    applicationStatusResult,
    applicationDateResult,
  ] = await Promise.all([
    Candidate.updateMany(
      { source: { $exists: false } },
      { $set: { source: 'INTERNAL' } }
    ),
    Candidate.updateMany(
      { status: { $exists: false } },
      { $set: { status: 'ACTIVE' } }
    ),
    Candidate.updateMany(
      { applicationStatus: { $exists: false } },
      { $set: { applicationStatus: 'APPLIED' } }
    ),
    Candidate.updateMany(
      { applicationDate: { $exists: false } },
      [
        {
          $set: {
            applicationDate: { $ifNull: ['$createdAt', '$$NOW'] },
          },
        },
      ],
      { updatePipeline: true }
    ),
  ]);

  return {
    candidateCodesBackfilled,
    sourcesBackfilled: sourceResult.modifiedCount,
    statusesBackfilled: statusResult.modifiedCount,
    applicationStatusesBackfilled: applicationStatusResult.modifiedCount,
    applicationDatesBackfilled: applicationDateResult.modifiedCount,
  };
};
