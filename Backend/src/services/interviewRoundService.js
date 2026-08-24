import ApiError from '../utils/ApiError.js';

export const DEFAULT_INTERVIEW_ROUNDS = [
  {
    key: 'TECHNICAL_1',
    name: 'Technical Round 1',
    sequence: 1,
    category: 'TECHNICAL',
    targetStage: 'INTERVIEW_1',
  },
  {
    key: 'TECHNICAL_2',
    name: 'Technical Round 2',
    sequence: 2,
    category: 'TECHNICAL',
    targetStage: 'INTERVIEW_2',
  },
  {
    key: 'MANAGER',
    name: 'Manager Round',
    sequence: 3,
    category: 'MANAGER',
    targetStage: 'MANAGER_ROUND',
  },
  {
    key: 'HR_FINAL',
    name: 'HR Final Round',
    sequence: 4,
    category: 'HR',
    targetStage: 'HR_FINAL',
  },
];

const safeRoundKey = (value) => String(value || '').trim().toUpperCase();

export const resolveInterviewRound = ({
  roundKey,
  roundName = '',
  roundSequence = null,
  roundCategory = 'CUSTOM',
}) => {
  const key = safeRoundKey(roundKey);
  const configured = DEFAULT_INTERVIEW_ROUNDS.find((round) => round.key === key);

  if (configured) {
    return {
      snapshot: {
        key: configured.key,
        name: configured.name,
        sequence: configured.sequence,
        category: configured.category,
      },
      targetStage: configured.targetStage,
      configured: true,
    };
  }

  const name = String(roundName || '').trim();
  const sequence = Number(roundSequence);
  const category = String(roundCategory || 'CUSTOM').toUpperCase();

  if (!/^[A-Z0-9_]{2,80}$/.test(key)) {
    throw ApiError.badRequest('Choose a valid interview round key');
  }
  if (name.length < 2 || name.length > 120) {
    throw ApiError.badRequest('Custom round name must be between 2 and 120 characters');
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 100) {
    throw ApiError.badRequest('Custom round sequence must be between 1 and 100');
  }
  if (!['TECHNICAL', 'MANAGER', 'HR', 'CUSTOM'].includes(category)) {
    throw ApiError.badRequest('Choose a valid custom round category');
  }

  return {
    snapshot: { key, name, sequence, category },
    targetStage: null,
    configured: false,
  };
};

export const interviewRoundOptions = () =>
  DEFAULT_INTERVIEW_ROUNDS.map(({ targetStage, ...round }) => ({
    ...round,
    targetStage,
  }));
