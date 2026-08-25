import TenantSequence from '../models/TenantSequence.js';

const nextSequence = async (companyId, key) => {
  let sequence;

  try {
    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key },
      {
        $inc: { value: 1 },
        $setOnInsert: { companyId, key },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key },
      { $inc: { value: 1 } },
      { new: true }
    );
  }

  return sequence.value;
};

export const nextPreOnboardingCode = async (companyId) => {
  const value = await nextSequence(companyId, 'PRE_ONBOARDING');
  return `POB-${String(value).padStart(6, '0')}`;
};

export const nextCandidateDocumentCode = async (companyId) => {
  const value = await nextSequence(companyId, 'CANDIDATE_DOCUMENT');
  return `CDOC-${String(value).padStart(6, '0')}`;
};
