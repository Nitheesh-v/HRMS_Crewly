import {
  boundedText,
  normalizeParsedResume,
  normalizeResumeDate,
  uniqueStrings,
} from './resumeNormalizationService.js';

export const RESUME_PARSER_VERSION = 'deterministic-1.0.0';

const SECTION_ALIASES = new Map([
  ['summary', 'summary'],
  ['professional summary', 'summary'],
  ['profile', 'summary'],
  ['professional profile', 'summary'],
  ['career objective', 'summary'],
  ['objective', 'summary'],
  ['about me', 'summary'],
  ['skills', 'skills'],
  ['technical skills', 'skills'],
  ['core skills', 'skills'],
  ['core competencies', 'skills'],
  ['competencies', 'skills'],
  ['technologies', 'skills'],
  ['technical expertise', 'skills'],
  ['experience', 'workExperience'],
  ['work experience', 'workExperience'],
  ['professional experience', 'workExperience'],
  ['employment history', 'workExperience'],
  ['career history', 'workExperience'],
  ['education', 'education'],
  ['academic background', 'education'],
  ['academic qualifications', 'education'],
  ['qualifications', 'education'],
  ['certifications', 'certifications'],
  ['certificates', 'certifications'],
  ['licenses and certifications', 'certifications'],
  ['projects', 'projects'],
  ['personal projects', 'projects'],
  ['key projects', 'projects'],
  ['links', 'links'],
  ['professional links', 'links'],
  ['languages', 'languages'],
  ['language proficiency', 'languages'],
  ['awards', 'awards'],
  ['honors and awards', 'awards'],
  ['honours and awards', 'awards'],
  ['achievements', 'achievements'],
  ['accomplishments', 'achievements'],
  ['publications', 'publications'],
  ['volunteering', 'volunteering'],
  ['volunteer experience', 'volunteering'],
]);

const DATE_TOKEN =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)?\\s*[’\']?(?:19\\d{2}|20\\d{2}|\\d{2})|present|current|now|ongoing|till date|to date';
const DATE_RANGE = new RegExp(
  `(${DATE_TOKEN})\\s*(?:-|–|—|to|until|through)\\s*(${DATE_TOKEN})`,
  'i'
);
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/i;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>{}\[\]]+/gi;
const PHONE_PATTERN = /(?:\+\d{1,3}[\s().-]*)?(?:\d[\s().-]*){9,14}\d/;

const headingKey = (line) =>
  boundedText(line, 100)
    .toLowerCase()
    .replace(/^[•·▪◦*#\-–—|]+\s*/, '')
    .replace(/[:|\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

const sectionForHeading = (line) => {
  if (String(line || '').length > 70) return null;
  return SECTION_ALIASES.get(headingKey(line)) || null;
};

const toLines = (rawText) =>
  boundedText(rawText, 250000)
    .split('\n')
    .map((line) => line.replace(/^[•·▪◦]+\s*/, '• ').trim())
    .filter(Boolean)
    .slice(0, 10000);

const groupSections = (lines) => {
  const sections = new Map();
  const intro = [];
  let current = null;

  lines.forEach((line) => {
    const section = sectionForHeading(line);

    if (section) {
      current = section;
      if (!sections.has(section)) sections.set(section, []);
      return;
    }

    if (current) sections.get(current).push(line);
    else intro.push(line);
  });

  return { sections, intro };
};

const firstMatch = (lines, expression) => {
  for (const line of lines) {
    const match = line.match(expression);
    if (match) return boundedText(match[0], 320);
  }
  return '';
};

const plausibleName = (line) => {
  const value = boundedText(line, 200).replace(/[|•]/g, ' ').trim();
  const words = value.split(/\s+/).filter(Boolean);

  if (
    !value ||
    words.length < 2 ||
    words.length > 6 ||
    value.length > 80 ||
    EMAIL_PATTERN.test(value) ||
    PHONE_PATTERN.test(value) ||
    /https?:|www\.|resume|curriculum vitae|vitae|profile/i.test(value) ||
    sectionForHeading(value)
  ) {
    return '';
  }

  return /^[\p{L}][\p{L} .,'’-]+$/u.test(value) ? value : '';
};

const parseIdentity = (lines) => {
  const head = lines.slice(0, 16);
  const explicitName = head
    .map((line) => line.match(/^(?:name)\s*[:|-]\s*(.+)$/i)?.[1] || '')
    .find(Boolean);
  const email = firstMatch(head, EMAIL_PATTERN);
  const phone = firstMatch(
    head.filter((line) => !DATE_RANGE.test(line)),
    PHONE_PATTERN
  );
  const location = head
    .map(
      (line) =>
        line.match(/^(?:location|address|based in)\s*[:|-]\s*(.+)$/i)?.[1] || ''
    )
    .find(Boolean);

  return {
    name: boundedText(explicitName || head.map(plausibleName).find(Boolean), 200),
    email,
    phone,
    location: boundedText(location, 300),
  };
};

const splitSkills = (lines) =>
  lines
    .flatMap((line) =>
      line
        .replace(/^(?:technical\s+)?skills?\s*[:|-]\s*/i, '')
        .split(/[,;|•·▪◦]|\s\/\s/)
    )
    .map((value) => boundedText(value, 100))
    .filter((value) => value && value.length <= 100 && value.split(/\s+/).length <= 8);

const extractLinks = (lines) => {
  const links = [];

  lines.forEach((line) => {
    const urls = line.match(URL_PATTERN) || [];

    urls.forEach((url) => {
      const lower = url.toLowerCase();
      const label = lower.includes('linkedin')
        ? 'LinkedIn'
        : lower.includes('github')
          ? 'GitHub'
          : lower.includes('gitlab')
            ? 'GitLab'
            : lower.includes('stackoverflow')
              ? 'Stack Overflow'
              : 'Professional link';
      links.push({ label, url });
    });
  });

  return links;
};

const entryBlocks = (lines) => {
  const blocks = [];
  let current = [];

  lines.forEach((line) => {
    const startsEntry = DATE_RANGE.test(line) && current.some((item) => DATE_RANGE.test(item));

    if (startsEntry && current.length) {
      blocks.push(current);
      current = [];
    }

    current.push(line);
  });

  if (current.length) blocks.push(current);
  return blocks.filter((block) => block.some((line) => boundedText(line, 200)));
};

const rangeFromBlock = (block) => {
  for (const line of block) {
    const match = line.match(DATE_RANGE);

    if (match) {
      return {
        startDate: boundedText(match[1], 100),
        endDate: boundedText(match[2], 100),
        rangeLine: line,
      };
    }
  }

  return { startDate: '', endDate: '', rangeLine: '' };
};

const headerLines = (block, rangeLine) =>
  block
    .filter(
      (line) =>
        line !== rangeLine &&
        !/^\s*[•*-]/.test(line) &&
        !/^\s*(?:responsibilities|achievements|technologies|environment)\s*:/i.test(line)
    )
    .slice(0, 3);

const splitRoleAndEmployer = (headers) => {
  const first = boundedText(headers[0], 300);
  const second = boundedText(headers[1], 300);
  const atMatch = first.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);

  if (atMatch) {
    return {
      title: boundedText(atMatch[1], 250),
      employer: boundedText(atMatch[2], 300),
    };
  }

  const segments = first.split(/\s+[|–—]\s+/).map((value) => value.trim());

  if (segments.length >= 2) {
    return {
      title: boundedText(segments[0], 250),
      employer: boundedText(segments.slice(1).join(' | '), 300),
    };
  }

  return { title: first, employer: second };
};

const parseWorkExperience = (lines) =>
  entryBlocks(lines).slice(0, 50).map((block) => {
    const range = rangeFromBlock(block);
    const headers = headerLines(block, range.rangeLine);
    const role = splitRoleAndEmployer(headers);
    const detailLines = block.filter(
      (line) => !headers.includes(line) && line !== range.rangeLine
    );
    const technologyLine = detailLines.find((line) =>
      /^(?:technologies|tech stack|environment|tools)\s*[:|-]/i.test(line)
    );

    return {
      ...role,
      startDate: range.startDate,
      endDate: range.endDate,
      isCurrent: /present|current|now|ongoing|till date|to date/i.test(
        range.endDate
      ),
      description: detailLines.join('\n'),
      technologies: technologyLine ? splitSkills([technologyLine]) : [],
      originalText: block.join('\n'),
    };
  });

const parseEducation = (lines) =>
  entryBlocks(lines).slice(0, 30).map((block) => {
    const range = rangeFromBlock(block);
    const headers = headerLines(block, range.rangeLine);
    const degreeLine = headers.find((line) =>
      /\b(?:bachelor|master|doctor|ph\.?d|b\.?tech|m\.?tech|b\.?e\.?|m\.?e\.?|b\.?sc|m\.?sc|mba|diploma|degree|university|college|institute)\b/i.test(
        line
      )
    );
    const institutionLine = headers.find(
      (line) => line !== degreeLine && /university|college|institute|school|academy/i.test(line)
    );
    const fieldMatch = degreeLine?.match(/\b(?:in|of)\s+(.+)$/i);
    const gradeLine = block.find((line) => /^(?:gpa|cgpa|grade|percentage)\s*[:|-]/i.test(line));

    return {
      qualification: degreeLine || headers[0] || '',
      fieldOfStudy: fieldMatch?.[1] || '',
      institution: institutionLine || headers.find((line) => line !== degreeLine) || '',
      startDate: range.startDate,
      endDate: range.endDate,
      grade: gradeLine?.replace(/^[^:|-]+[:|-]\s*/, '') || '',
      description: block
        .filter((line) => !headers.includes(line) && line !== range.rangeLine)
        .join('\n'),
      originalText: block.join('\n'),
    };
  });

const parseCertifications = (lines) =>
  entryBlocks(lines).slice(0, 50).map((block) => {
    const range = rangeFromBlock(block);
    const first = block.find((line) => line !== range.rangeLine) || '';
    const issuerMatch = block
      .join(' ')
      .match(/(?:issued by|issuer)\s*[:|-]?\s*([^|•,;]+)/i);
    const credentialMatch = block
      .join(' ')
      .match(/credential\s*(?:id)?\s*[:|-]\s*([^|•,;]+)/i);

    return {
      name: first,
      issuer: issuerMatch?.[1] || '',
      issuedDate: range.startDate || range.endDate,
      credentialId: credentialMatch?.[1] || '',
      credentialUrl: extractLinks(block)[0]?.url || '',
      originalText: block.join('\n'),
    };
  });

const parseProjects = (lines) =>
  entryBlocks(lines).slice(0, 50).map((block) => {
    const first = block[0] || '';
    const technologyLine = block.find((line) =>
      /^(?:technologies|tech stack|environment|tools)\s*[:|-]/i.test(line)
    );

    return {
      name: first.replace(DATE_RANGE, '').replace(/\s+[|–—]\s*$/, ''),
      description: block.slice(1).join('\n'),
      technologies: technologyLine ? splitSkills([technologyLine]) : [],
      url: extractLinks(block)[0]?.url || '',
      originalText: block.join('\n'),
    };
  });

const parseLanguages = (lines) =>
  splitSkills(lines)
    .slice(0, 50)
    .map((value) => {
      const [name, proficiency = ''] = value.split(/\s*[-:(]\s*/, 2);
      return {
        name,
        proficiency: proficiency.replace(/\)$/, ''),
      };
    });

const parseNamedItems = (lines) =>
  entryBlocks(lines).slice(0, 50).map((block) => {
    const range = rangeFromBlock(block);
    return {
      title: block[0] || '',
      date: range.startDate || range.endDate,
      description: block.slice(1).join('\n'),
      url: extractLinks(block)[0]?.url || '',
      originalText: block.join('\n'),
    };
  });

const dateConfidence = (structuredData) => {
  const dates = [
    ...structuredData.workExperience.flatMap((entry) => [
      entry.startDate,
      entry.endDate,
    ]),
    ...structuredData.education.flatMap((entry) => [
      entry.startDate,
      entry.endDate,
    ]),
  ].filter((value) => value?.original);

  if (!dates.length) return 0;
  const confident = dates.filter(
    (value) => value?.normalized || value?.isCurrent
  ).length;
  return Number((confident / dates.length).toFixed(2));
};

export const parseResumeDeterministically = ({ rawText, extraction }) => {
  const lines = toLines(rawText);
  const { sections, intro } = groupSections(lines);
  const allLines = [...intro, ...[...sections.values()].flat()];
  const inlineSkillLines = allLines.filter((line) =>
    /^(?:technical\s+)?skills?\s*[:|-]/i.test(line)
  );
  const parsed = {
    identity: parseIdentity(lines),
    summary: (sections.get('summary') || []).join('\n'),
    skills: splitSkills([...(sections.get('skills') || []), ...inlineSkillLines]),
    workExperience: parseWorkExperience(sections.get('workExperience') || []),
    education: parseEducation(sections.get('education') || []),
    certifications: parseCertifications(sections.get('certifications') || []),
    projects: parseProjects(sections.get('projects') || []),
    links: extractLinks(allLines),
    languages: parseLanguages(sections.get('languages') || []),
    awards: parseNamedItems(sections.get('awards') || []),
    achievements: parseNamedItems(sections.get('achievements') || []),
    publications: parseNamedItems(sections.get('publications') || []),
    volunteering: parseNamedItems(sections.get('volunteering') || []),
  };
  const structuredData = normalizeParsedResume(parsed);
  const detectedSections = sections.size;
  const warnings = [];

  if (!detectedSections) {
    warnings.push('No standard resume section headings were detected. Review extracted fields.');
  }
  if (!structuredData.identity.email && !structuredData.identity.phone) {
    warnings.push('Contact details could not be confidently extracted.');
  }
  if (!structuredData.skills.length) {
    warnings.push('No explicit skills section could be extracted.');
  }
  if (extraction?.truncated) {
    warnings.push('Extraction reached a configured safety limit; review the original resume.');
  }

  const textExtraction = Math.max(
    0,
    Math.min(1, Number(extraction?.confidence || 0))
  );
  const sectionDetection = Math.min(1, detectedSections / 6);
  const normalizedDateConfidence = dateConfidence(structuredData);
  const overall = Number(
    (
      textExtraction * 0.55 +
      sectionDetection * 0.3 +
      normalizedDateConfidence * 0.15
    ).toFixed(2)
  );

  return {
    structuredData,
    warnings: uniqueStrings(warnings, 50, 300),
    extractionConfidence: {
      overall,
      textExtraction: Number(textExtraction.toFixed(2)),
      sectionDetection: Number(sectionDetection.toFixed(2)),
      dateNormalization: normalizedDateConfidence,
    },
  };
};

export const inspectNormalizedDate = normalizeResumeDate;
