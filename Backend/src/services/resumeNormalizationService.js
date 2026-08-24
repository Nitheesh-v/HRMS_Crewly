const MONTHS = new Map([
  ['jan', 0],
  ['january', 0],
  ['feb', 1],
  ['february', 1],
  ['mar', 2],
  ['march', 2],
  ['apr', 3],
  ['april', 3],
  ['may', 4],
  ['jun', 5],
  ['june', 5],
  ['jul', 6],
  ['july', 6],
  ['aug', 7],
  ['august', 7],
  ['sep', 8],
  ['sept', 8],
  ['september', 8],
  ['oct', 9],
  ['october', 9],
  ['nov', 10],
  ['november', 10],
  ['dec', 11],
  ['december', 11],
]);

const SKILL_DISPLAY_ALIASES = new Map([
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['node.js', 'Node.js'],
  ['nodejs', 'Node.js'],
  ['react.js', 'React.js'],
  ['reactjs', 'React.js'],
  ['next.js', 'Next.js'],
  ['nextjs', 'Next.js'],
  ['vue.js', 'Vue.js'],
  ['vuejs', 'Vue.js'],
  ['mongodb', 'MongoDB'],
  ['postgresql', 'PostgreSQL'],
  ['mysql', 'MySQL'],
  ['graphql', 'GraphQL'],
  ['html5', 'HTML5'],
  ['css3', 'CSS3'],
  ['aws', 'AWS'],
  ['gcp', 'GCP'],
  ['azure', 'Azure'],
  ['c#', 'C#'],
  ['c++', 'C++'],
  ['.net', '.NET'],
  ['asp.net', 'ASP.NET'],
]);

export const boundedText = (value, maximum = 500) =>
  String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maximum);

export const normalizedKey = (value) =>
  boundedText(value, 200)
    .toLocaleLowerCase('en-US')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

export const normalizeSkill = (value) => {
  const cleaned = boundedText(value, 100)
    .replace(/^[•·▪◦*-]+\s*/, '')
    .replace(/[;,.]+$/, '')
    .trim();
  const key = normalizedKey(cleaned);

  if (!cleaned || key.length > 100) return null;

  const display = SKILL_DISPLAY_ALIASES.get(key) || cleaned;

  return {
    display,
    normalized: normalizedKey(display),
  };
};

export const normalizeSkills = (values = [], maximum = 200) => {
  const seen = new Set();
  const skills = [];

  values.flat().forEach((value) => {
    if (skills.length >= maximum) return;
    const skill = normalizeSkill(value);

    if (skill && !seen.has(skill.normalized)) {
      seen.add(skill.normalized);
      skills.push(skill);
    }
  });

  return skills;
};

const emptyDate = (original = '') => ({
  original: boundedText(original, 100),
  normalized: null,
  precision: 'UNKNOWN',
  uncertain: true,
});

const validYear = (value) => {
  const year = Number(value);
  const maximum = new Date().getUTCFullYear() + 10;
  return Number.isInteger(year) && year >= 1940 && year <= maximum
    ? year
    : null;
};

export const normalizeResumeDate = (value, { endDate = false } = {}) => {
  const original = boundedText(value, 100);
  const normalized = normalizedKey(original).replace(/[.,]/g, '');

  if (!normalized) return emptyDate();

  if (/^(present|current|now|ongoing|till date|to date)$/i.test(normalized)) {
    return {
      original,
      normalized: null,
      precision: 'MONTH',
      uncertain: false,
      isCurrent: true,
    };
  }

  const isoMatch = normalized.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/);

  if (isoMatch) {
    const year = validYear(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = isoMatch[3] ? Number(isoMatch[3]) : 1;

    if (year && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(Date.UTC(year, month - 1, day));

      if (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      ) {
        return {
          original,
          normalized: date,
          precision: isoMatch[3] ? 'DAY' : 'MONTH',
          uncertain: false,
        };
      }
    }
  }

  const monthYearMatch = normalized.match(
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+['’]?(\d{2}|\d{4})$/i
  );

  if (monthYearMatch) {
    const month = MONTHS.get(monthYearMatch[1].toLowerCase());
    const shortYear = Number(monthYearMatch[2]);
    const year = validYear(
      monthYearMatch[2].length === 2
        ? shortYear + (shortYear > 40 ? 1900 : 2000)
        : shortYear
    );

    if (month !== undefined && year) {
      return {
        original,
        normalized: new Date(Date.UTC(year, month, endDate ? 28 : 1)),
        precision: 'MONTH',
        uncertain: false,
      };
    }
  }

  const yearMonthMatch = normalized.match(/^['’]?(\d{2}|\d{4})\s+([a-z]+)$/i);

  if (yearMonthMatch) {
    return normalizeResumeDate(
      `${yearMonthMatch[2]} ${yearMonthMatch[1]}`,
      { endDate }
    );
  }

  const year = validYear(normalized.match(/^(19\d{2}|20\d{2})$/)?.[1]);

  if (year) {
    return {
      original,
      normalized: new Date(Date.UTC(year, endDate ? 11 : 0, endDate ? 31 : 1)),
      precision: 'YEAR',
      uncertain: true,
    };
  }

  return emptyDate(original);
};

export const normalizeUrl = (value) => {
  const candidate = boundedText(value, 500).replace(/[),.;]+$/, '');
  const withProtocol = /^(?:https?):\/\//i.test(candidate)
    ? candidate
    : /^(?:www\.)/i.test(candidate)
      ? `https://${candidate}`
      : '';

  if (!withProtocol) return '';

  try {
    const url = new URL(withProtocol);
    return ['http:', 'https:'].includes(url.protocol)
      ? url.toString().slice(0, 500)
      : '';
  } catch {
    return '';
  }
};

export const uniqueStrings = (values = [], maximum = 50, length = 300) => {
  const seen = new Set();
  const result = [];

  values.flat().forEach((value) => {
    const cleaned = boundedText(value, length);
    const key = normalizedKey(cleaned);

    if (cleaned && !seen.has(key) && result.length < maximum) {
      seen.add(key);
      result.push(cleaned);
    }
  });

  return result;
};

const monthIndex = (value, endFallback = false) => {
  if (value?.isCurrent) {
    const now = new Date();
    return now.getUTCFullYear() * 12 + now.getUTCMonth();
  }

  if (!(value?.normalized instanceof Date) || Number.isNaN(value.normalized.getTime())) {
    return null;
  }

  const date = value.normalized;
  return date.getUTCFullYear() * 12 + date.getUTCMonth() + (endFallback ? 1 : 0);
};

export const deriveExperienceMonths = (entries = []) => {
  const intervals = entries
    .map((entry) => {
      const start = monthIndex(entry.startDate);
      const end = monthIndex(entry.endDate, true);
      return start !== null && end !== null && end >= start
        ? [start, end]
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);

  if (!intervals.length) return 0;

  const merged = [intervals[0]];

  intervals.slice(1).forEach(([start, end]) => {
    const current = merged[merged.length - 1];

    if (start <= current[1]) {
      current[1] = Math.max(current[1], end);
    } else {
      merged.push([start, end]);
    }
  });

  return Math.min(
    1200,
    merged.reduce((total, [start, end]) => total + Math.max(0, end - start), 0)
  );
};

const cap = (items, maximum) => (Array.isArray(items) ? items.slice(0, maximum) : []);

const normalizeNamedItems = (items = []) =>
  cap(items, 50).map((item) => ({
    title: boundedText(item?.title, 300),
    issuer: boundedText(item?.issuer, 300),
    date: normalizeResumeDate(item?.date),
    description: boundedText(item?.description, 2000),
    url: normalizeUrl(item?.url),
    originalText: boundedText(item?.originalText, 2500),
  }));

export const normalizeParsedResume = (parsed = {}) => {
  const workExperience = cap(parsed.workExperience, 50).map((item) => {
    const startDate = normalizeResumeDate(item?.startDate);
    const endDate = normalizeResumeDate(item?.endDate, { endDate: true });
    const isCurrent = Boolean(item?.isCurrent || endDate.isCurrent);

    return {
      employer: boundedText(item?.employer, 300),
      title: boundedText(item?.title, 250),
      location: boundedText(item?.location, 200),
      startDate,
      endDate,
      isCurrent,
      description: boundedText(item?.description, 3000),
      technologies: normalizeSkills(item?.technologies, 50),
      originalText: boundedText(item?.originalText, 4000),
    };
  });

  return {
    identity: {
      name: boundedText(parsed.identity?.name, 200),
      email: boundedText(parsed.identity?.email, 320).toLowerCase(),
      phone: boundedText(parsed.identity?.phone, 100),
      location: boundedText(parsed.identity?.location, 300),
    },
    summary: boundedText(parsed.summary, 5000),
    skills: normalizeSkills(parsed.skills, 200),
    education: cap(parsed.education, 30).map((item) => ({
      qualification: boundedText(item?.qualification, 200),
      fieldOfStudy: boundedText(item?.fieldOfStudy, 200),
      institution: boundedText(item?.institution, 300),
      location: boundedText(item?.location, 200),
      startDate: normalizeResumeDate(item?.startDate),
      endDate: normalizeResumeDate(item?.endDate, { endDate: true }),
      grade: boundedText(item?.grade, 100),
      description: boundedText(item?.description, 1500),
      originalText: boundedText(item?.originalText, 2000),
    })),
    workExperience,
    derivedExperienceMonths: deriveExperienceMonths(workExperience),
    certifications: cap(parsed.certifications, 50).map((item) => ({
      name: boundedText(item?.name, 300),
      issuer: boundedText(item?.issuer, 300),
      issuedDate: normalizeResumeDate(item?.issuedDate),
      expiryDate: normalizeResumeDate(item?.expiryDate, { endDate: true }),
      credentialId: boundedText(item?.credentialId, 200),
      credentialUrl: normalizeUrl(item?.credentialUrl),
      originalText: boundedText(item?.originalText, 1500),
    })),
    projects: cap(parsed.projects, 50).map((item) => ({
      name: boundedText(item?.name, 300),
      role: boundedText(item?.role, 200),
      description: boundedText(item?.description, 2500),
      technologies: normalizeSkills(item?.technologies, 50),
      url: normalizeUrl(item?.url),
      originalText: boundedText(item?.originalText, 3000),
    })),
    links: cap(parsed.links, 30)
      .map((item) => ({
        label: boundedText(item?.label, 100),
        url: normalizeUrl(item?.url),
      }))
      .filter((item) => item.url),
    languages: cap(parsed.languages, 50).map((item) => ({
      name: boundedText(item?.name, 100),
      proficiency: boundedText(item?.proficiency, 100),
    })),
    awards: normalizeNamedItems(parsed.awards),
    achievements: normalizeNamedItems(parsed.achievements),
    publications: normalizeNamedItems(parsed.publications),
    volunteering: normalizeNamedItems(parsed.volunteering),
  };
};
