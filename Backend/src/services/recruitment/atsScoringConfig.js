const DEFAULT_WEIGHTS = Object.freeze({
  requiredSkills: 40,
  experience: 25,
  preferredSkills: 15,
  education: 10,
  locationAndNotice: 10,
});

const boundedNumber = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
};

const configuredWeights = {
  requiredSkills: boundedNumber(
    process.env.ATS_WEIGHT_REQUIRED_SKILLS,
    DEFAULT_WEIGHTS.requiredSkills,
    0,
    1000
  ),
  experience: boundedNumber(
    process.env.ATS_WEIGHT_EXPERIENCE,
    DEFAULT_WEIGHTS.experience,
    0,
    1000
  ),
  preferredSkills: boundedNumber(
    process.env.ATS_WEIGHT_PREFERRED_SKILLS,
    DEFAULT_WEIGHTS.preferredSkills,
    0,
    1000
  ),
  education: boundedNumber(
    process.env.ATS_WEIGHT_EDUCATION,
    DEFAULT_WEIGHTS.education,
    0,
    1000
  ),
  locationAndNotice: boundedNumber(
    process.env.ATS_WEIGHT_LOCATION_NOTICE,
    DEFAULT_WEIGHTS.locationAndNotice,
    0,
    1000
  ),
};

const totalWeight = Object.values(configuredWeights).reduce(
  (total, weight) => total + weight,
  0
);

export const ATS_ENGINE_VERSION = '1.0';
export const ATS_DEFAULT_MAX_NOTICE_PERIOD = boundedNumber(
  process.env.ATS_DEFAULT_MAX_NOTICE_PERIOD_DAYS,
  30,
  0,
  365
);

export const getATSScoringConfiguration = () => ({
  engineVersion: ATS_ENGINE_VERSION,
  weights: {
    ...(totalWeight > 0 ? configuredWeights : DEFAULT_WEIGHTS),
  },
  defaultMaxNoticePeriod: ATS_DEFAULT_MAX_NOTICE_PERIOD,
});

export const ATS_DEFAULT_WEIGHTS = DEFAULT_WEIGHTS;
