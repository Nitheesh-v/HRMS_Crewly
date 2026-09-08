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

export const nextBgvCaseCode = async (companyId) => {
  const value = await nextSequence(companyId, 'BGV_CASE');
  return `BGV-${String(value).padStart(6, '0')}`;
};
