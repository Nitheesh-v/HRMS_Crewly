export const POSITIVE_PIPELINE_STAGES = [
  'APPLIED',
  'ATS_SCREENING',
  'HR_SCREENING',
  'SHORTLISTED',
  'INTERVIEW_1',
  'INTERVIEW_2',
  'INTERVIEW_3',
  'MANAGER_ROUND',
  'HR_FINAL',
  'FINAL_REVIEW',
  'SELECTED',
  'OFFER',
  'OFFER_ACCEPTED',
  'PRE_ONBOARDING',
  'JOINED',
];

export const DISPOSITION_PIPELINE_STAGES = [
  'REJECTED',
  'HOLD',
  'WITHDRAWN',
];

export const PIPELINE_STAGES = [
  ...POSITIVE_PIPELINE_STAGES,
  ...DISPOSITION_PIPELINE_STAGES,
];

export const PIPELINE_STAGE_LABELS = Object.fromEntries(
  PIPELINE_STAGES.map((stage) => [
    stage,
    stage
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
  ])
);

export const REASON_REQUIRED_STAGES = ['REJECTED', 'HOLD', 'WITHDRAWN'];
