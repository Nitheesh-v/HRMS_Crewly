// Job update validation — the "Invalid value" toast case.
//
// The owner published a job titled "hr" (created from a requisition whose
// position allowed 2 characters) and every save died with express-validator's
// DEFAULT message: updateJobRules' title/location/description isLength rules
// carried no withMessage, so a failing title surfaced as "Invalid value" —
// no field named, no fix suggested. Create rules had the friendly message
// all along; update rules now match, and these pins hold both sides:
// the message is human, names the field, and never reverts to the default.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { updateJobRules } from '../src/validators/recruitment/recruitmentValidator.js';

const runRules = async (rules, body = {}) => {
  const req = { body };

  for (const rule of rules) {
    await new Promise((resolve, reject) => {
      const next = (error) => (error ? reject(error) : resolve());

      try {
        const result = rule(req, {}, next);
        if (result?.catch) result.catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }
};

const VALID_PUBLISH_PAYLOAD = {
  title: 'HR Executive',
  department: '',
  location: 'Coimbatore',
  employmentType: 'FULL_TIME',
  openings: 1,
  description: 'Run the people function.',
  status: 'OPEN',
  workMode: 'ONSITE',
  experienceLevel: 'FRESHER',
  minExperience: 0,
  maxExperience: 0,
  requiredSkills: ['communication'],
  preferredSkills: [],
  educationRequirements: [],
  maxNoticePeriod: 30,
  publicationStatus: 'PUBLISHED',
  applicationDeadline: '2026-10-25T23:59:59.999Z',
  publicSalaryVisible: false,
};

test('a valid publish payload passes the update rules', async () => {
  await runRules(updateJobRules, { ...VALID_PUBLISH_PAYLOAD });
});

test('a 2-character title fails with the field-named message, never "Invalid value"', async () => {
  const error = await runRules(updateJobRules, {
    ...VALID_PUBLISH_PAYLOAD,
    title: 'hr',
  }).then(() => null, (e) => e);

  assert.ok(error, 'a 2-character title must be rejected');
  assert.match(error.message, /Title must be 3–120 characters/);
  assert.notEqual(error.message, 'Invalid value');
  assert.equal(error.errors?.[0]?.field, 'title');
});

test('over-long location and description fail with field-named messages too', async () => {
  const locationError = await runRules(updateJobRules, {
    ...VALID_PUBLISH_PAYLOAD,
    location: 'x'.repeat(81),
  }).then(() => null, (e) => e);
  assert.match(locationError.message, /Location must be 80 characters or fewer/);

  const descriptionError = await runRules(updateJobRules, {
    ...VALID_PUBLISH_PAYLOAD,
    description: 'x'.repeat(2001),
  }).then(() => null, (e) => e);
  assert.match(descriptionError.message, /Description must be 2000 characters or fewer/);
});

test('no bare isLength rule is left without a message in updateJobRules', async () => {
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'validators', 'recruitment', 'recruitmentValidator.js'),
    'utf8',
  );
  const rulesStart = source.indexOf('export const updateJobRules');
  const rulesEnd = source.indexOf('export const candidateRules');
  const block = source.slice(rulesStart, rulesEnd);

  for (const match of block.matchAll(/isLength\(\{[^}]*\}\)/g)) {
    const after = block.slice(match.index, match.index + 220);
    assert.match(
      after,
      /withMessage/,
      `a bare ${match[0]} in updateJobRules will resurface as the default "Invalid value" toast — give it a withMessage`,
    );
  }
});
