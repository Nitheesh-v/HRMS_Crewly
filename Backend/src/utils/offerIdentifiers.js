import TenantSequence from '../models/TenantSequence.js';

const SEQUENCE_KEY = 'OFFER';

export const nextOfferCode = async (companyId) => {
  let sequence;

  try {
    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key: SEQUENCE_KEY },
      {
        $inc: { value: 1 },
        $setOnInsert: { companyId, key: SEQUENCE_KEY },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key: SEQUENCE_KEY },
      { $inc: { value: 1 } },
      { new: true }
    );
  }

  return `OFF-${String(sequence.value).padStart(6, '0')}`;
};
