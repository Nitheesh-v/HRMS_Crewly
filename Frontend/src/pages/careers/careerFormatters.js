export const careerEnumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const careerDateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : '';

export const careerExperienceLabel = (job) =>
  job.experienceLevel === 'FRESHER'
    ? 'Fresher'
    : `${job.minExperience ?? 0}–${job.maxExperience ?? 0} years`;
