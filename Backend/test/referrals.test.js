// Employee referrals — posted jobs visible to every employee, for referral.
//
// Hermetic: the REAL service runs against stubbed model statics (the same
// pattern as requisitionApproval.test.js — no database). What must be proven:
//   1. the openings list is the SAME "posted" filter the public career page
//      uses, tenant-scoped, and never leaks salary/budget fields;
//   2. a referral lands as an APPLIED candidate attributed to the referrer
//      (source REFERRAL + referredBy), with history and a tenant sequence code;
//   3. duplicates are rejected with a friendly 409 — both the pre-check and
//      the E11000 race path;
//   4. "my referrals" is self-scoped and maps the live pipeline stage;
//   5. a job that is not posted (draft/closed/expired/foreign tenant) is
//      invisible — 404, never a partial answer.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import ApiError from '../src/utils/ApiError.js';
import Candidate from '../src/models/Candidate.js';
import CandidateHistory from '../src/models/CandidateHistory.js';
import JobPosting from '../src/models/JobPosting.js';
import TenantSequence from '../src/models/TenantSequence.js';
import {
  listMyReferrals,
  listReferralOpenings,
  submitReferral,
} from '../src/services/recruitment/employeeReferralService.js';

const COMPANY = '64f0aaaaaaaaaaaaaaaaaaaaaa';
const USER = '64f0bbbbbbbbbbbbbbbbbbbbbb';
const JOB_ID = '64f0cccccccccccccccccccccc';

const POSTED_JOB = {
  _id: JOB_ID,
  jobCode: 'JOB-0007',
  title: 'Senior Backend Engineer',
  department: { _id: '64f0dddddddddddddddddddddd', name: 'Engineering' },
  location: 'Coimbatore',
  workMode: 'HYBRID',
  employmentType: 'FULL_TIME',
  description: 'Build the HR engine.',
  openings: 2,
  publishedAt: new Date('2026-10-01'),
  sourceRequisition: null,
  salaryMin: 1200000,
  hiringBudget: 1500000,
};

const statusCodeOf = (promise) =>
  promise.then(
    () => null,
    (error) => error.statusCode || null,
  );

const withStubs = async (stubs, fn) => {
  const originals = Object.entries(stubs).map(([owner, patch]) => {
    const restored = Object.entries(patch).map(([key, value]) => [
      key,
      owner === 'chain' ? value : undefined,
    ]);
    return { owner, patch, restored };
  });
  // eslint-disable-next-line no-unused-vars
  originals.forEach(({ owner, patch }) => {
    Object.entries(patch).forEach(([key, value]) => {
      const target = { JobPosting, Candidate, CandidateHistory, TenantSequence }[owner];
      target[`__orig_${key}`] = target[key];
      target[key] = value;
    });
  });
  try {
    return await fn();
  } finally {
    Object.entries(stubs).forEach(([owner, patch]) => {
      const target = { JobPosting, Candidate, CandidateHistory, TenantSequence }[owner];
      Object.keys(patch).forEach((key) => {
        target[key] = target[`__orig_${key}`];
        delete target[`__orig_${key}`];
      });
    });
  }
};

const openingChain = (jobs) => {
  const chain = {
    populate() { return chain; },
    sort() { return chain; },
    lean: () => Promise.resolve(jobs),
  };
  return chain;
};

test('openings list uses the posted filter, tenant scope, and never leaks pay fields', async () => {
  let captured = {};
  await withStubs(
    {
      JobPosting: {
        find: (filter, projection) => {
          captured = { filter, projection };
          return openingChain([POSTED_JOB]);
        },
      },
    },
    async () => {
      const { openings } = await listReferralOpenings({ companyId: COMPANY });
      assert.equal(openings.length, 1);
      assert.equal(openings[0].title, 'Senior Backend Engineer');

      // tenant + "posted" semantics — the same rules the public page uses
      assert.equal(captured.filter.companyId, COMPANY);
      assert.equal(captured.filter.publicationStatus, 'PUBLISHED');
      assert.equal(captured.filter.status, 'OPEN');
      assert.deepEqual(captured.filter.publishedAt, { $ne: null });

      // referral-safe projection: HR-only money fields must not be requested
      for (const banned of ['salaryMin', 'salaryMax', 'hiringBudget', 'hiringReason']) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(captured.projection, banned),
          false,
          `${banned} must not be exposed to employees`,
        );
      }
    },
  );
});

test('a referral is created as an attributed APPLIED candidate with history', async () => {
  let created = null;
  let history = null;
  const savedJob = await withStubs(
    {
      JobPosting: { findOne: () => ({ lean: () => Promise.resolve(POSTED_JOB) }) },
      Candidate: {
        findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
        create: async (doc) => {
          created = doc;
          return { ...doc, _id: '64f0eeeeeeeeeeeeeeeeeeeeee' };
        },
      },
      CandidateHistory: {
        create: async (doc) => {
          history = doc;
          return doc;
        },
      },
      TenantSequence: {
        findOneAndUpdate: () => Promise.resolve({ value: 7 }),
      },
    },
    () =>
      submitReferral({
        companyId: COMPANY,
        userId: USER,
        jobCode: 'job-0007', // lowercase on purpose: the service normalises
        input: { fullName: 'Priya Raman', email: 'Priya@Example.com ', phone: '9876543210' },
      }),
  );

  assert.equal(savedJob.referral.candidateCode, 'CAN-000007');
  assert.equal(created.companyId, COMPANY);
  assert.equal(created.job, JOB_ID);
  assert.equal(created.source, 'REFERRAL');
  assert.equal(created.referredBy, USER);
  assert.equal(created.email, 'priya@example.com'); // lowercased like the model does
  assert.equal(created.stage, 'APPLIED');
  assert.equal(history.action, 'CANDIDATE_APPLIED');
  assert.equal(history.actorType, 'TENANT_USER');
  assert.equal(history.actor, USER);
});

test('input validation and duplicates fail loudly before anything is created', async () => {
  // invalid email → 400, and create must never run
  await withStubs(
    {
      JobPosting: { findOne: () => ({ lean: () => Promise.resolve(POSTED_JOB) }) },
      Candidate: {
        findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
        create: async () => assert.fail('create must never run for invalid input'),
      },
    },
    async () => {
      const error = await submitReferral({
        companyId: COMPANY,
        userId: USER,
        jobCode: 'JOB-0007',
        input: { fullName: 'Priya Raman', email: 'not-an-email' },
      }).then(() => null, (e) => e);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /valid candidate email/i);
    },
  );

  // unposted / draft / foreign-tenant job → 404 (never a partial answer)
  await withStubs(
    { JobPosting: { findOne: () => ({ lean: () => Promise.resolve(null) }) } },
    async () => {
      const error = await submitReferral({
        companyId: COMPANY,
        userId: USER,
        jobCode: 'JOB-404',
        input: { fullName: 'Priya Raman', email: 'priya@example.com' },
      }).then(() => null, (e) => e);
      assert.equal(error.statusCode, 404);
    },
  );

  // duplicate (pre-check) → 409, create never runs
  await withStubs(
    {
      JobPosting: { findOne: () => ({ lean: () => Promise.resolve(POSTED_JOB) }) },
      Candidate: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve({ _id: '64f0ffffffffffaaaaaaaaaaaa' }) }) }) },
    },
    async () => {
      const error = await submitReferral({
        companyId: COMPANY,
        userId: USER,
        jobCode: 'JOB-0007',
        input: { fullName: 'Priya Raman', email: 'priya@example.com' },
      }).then(() => null, (e) => e);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /already in the pipeline/i);
    },
  );
});

test('an E11000 race (two referrals, same email, same job) is a friendly 409', async () => {
  const raceError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  const error = await withStubs(
    {
      JobPosting: { findOne: () => ({ lean: () => Promise.resolve(POSTED_JOB) }) },
      Candidate: {
        findOne: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
        create: async () => {
          throw raceError;
        },
      },
      TenantSequence: { findOneAndUpdate: () => Promise.resolve({ value: 8 }) },
    },
    () =>
      submitReferral({
        companyId: COMPANY,
        userId: USER,
        jobCode: 'JOB-0007',
        input: { fullName: 'Priya Raman', email: 'priya@example.com' },
      }).then(() => null, (e) => e),
  );
  assert.equal(error.statusCode, 409);
  assert.equal(error instanceof ApiError, true);
});

test('"my referrals" is self-scoped and maps the live pipeline stage', async () => {
  let captured = {};
  await withStubs(
    {
      Candidate: {
        find: (filter) => {
          captured.filter = filter;
          const chain = {
            populate() { return chain; },
            sort() { return chain; },
            lean: () =>
              Promise.resolve([
                {
                  _id: '64f0eeeeeeeeeeeeeeeeeeeeee',
                  candidateCode: 'CAN-000007',
                  name: 'Priya Raman',
                  email: 'priya@example.com',
                  currentStage: 'INTERVIEW',
                  stage: 'INTERVIEW',
                  applicationDate: new Date('2026-10-05'),
                  job: { jobCode: 'JOB-0007', title: 'Senior Backend Engineer' },
                },
              ]),
          };
          return chain;
        },
      },
    },
    async () => {
      const { referrals } = await listMyReferrals({ companyId: COMPANY, userId: USER });
      assert.equal(captured.filter.companyId, COMPANY);
      assert.equal(captured.filter.source, 'REFERRAL');
      assert.equal(captured.filter.referredBy, USER);
      assert.equal(referrals[0].stage, 'INTERVIEW');
      assert.equal(referrals[0].job.title, 'Senior Backend Engineer');
    },
  );
});
