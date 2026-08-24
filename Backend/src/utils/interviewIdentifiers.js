import TenantSequence from '../models/TenantSequence.js';

const INTERVIEW_SEQUENCE_KEY = 'INTERVIEW';

const incrementSequence = async (companyId) => {
  try {
    return await TenantSequence.findOneAndUpdate(
      { companyId, key: INTERVIEW_SEQUENCE_KEY },
      {
        $inc: { value: 1 },
        $setOnInsert: { companyId, key: INTERVIEW_SEQUENCE_KEY },
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
      { companyId, key: INTERVIEW_SEQUENCE_KEY },
      { $inc: { value: 1 } },
      { returnDocument: 'after' }
    );
  }
};

export const nextInterviewCode = async (companyId) => {
  const sequence = await incrementSequence(companyId);
  return `INT-${String(sequence.value).padStart(6, '0')}`;
};
