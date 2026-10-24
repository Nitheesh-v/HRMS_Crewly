import TenantSequence from '../../models/TenantSequence.js';

export const HELPDESK_TICKET_SEQUENCE_KEY = 'HELPDESK_TICKET';

const incrementSequence = async (companyId, SequenceModel) => {
  let sequence;

  try {
    sequence = await SequenceModel.findOneAndUpdate(
      { companyId, key: HELPDESK_TICKET_SEQUENCE_KEY },
      {
        $inc: { value: 1 },
        $setOnInsert: { companyId, key: HELPDESK_TICKET_SEQUENCE_KEY },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;

    sequence = await SequenceModel.findOneAndUpdate(
      { companyId, key: HELPDESK_TICKET_SEQUENCE_KEY },
      { $inc: { value: 1 } },
      { returnDocument: 'after' },
    );
  }

  const value = Number(sequence?.value);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Helpdesk ticket number could not be allocated');
  }

  return value;
};

export const nextHelpdeskTicketNumber = async (
  companyId,
  { SequenceModel = TenantSequence } = {},
) => {
  if (!companyId) throw new Error('companyId is required');
  const value = await incrementSequence(companyId, SequenceModel);
  return `HD-${String(value).padStart(6, '0')}`;
};
