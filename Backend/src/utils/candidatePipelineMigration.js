import Candidate from '../models/Candidate.js';
import { PIPELINE_STAGES } from '../models/CandidatePipelineHistory.js';

const normalizedStageExpression = {
  $let: {
    vars: {
      sourceStage: { $ifNull: ['$currentStage', '$stage'] },
    },
    in: {
      $switch: {
        branches: [
          { case: { $eq: ['$$sourceStage', 'SCREENING'] }, then: 'HR_SCREENING' },
          { case: { $eq: ['$$sourceStage', 'INTERVIEW'] }, then: 'INTERVIEW_1' },
          { case: { $eq: ['$$sourceStage', 'HIRED'] }, then: 'JOINED' },
          ...PIPELINE_STAGES.map((stage) => ({
            case: { $eq: ['$$sourceStage', stage] },
            then: stage,
          })),
        ],
        default: 'APPLIED',
      },
    },
  },
};

export const ensureCandidatePipelineStages = async () => {
  const result = await Candidate.updateMany(
    {},
    [
      { $set: { currentStage: normalizedStageExpression } },
      { $set: { stage: '$currentStage' } },
    ],
    { updatePipeline: true }
  );

  return {
    matched: result.matchedCount || 0,
    normalized: result.modifiedCount || 0,
  };
};
