// Job referrals — posted jobs visible to every employee, for referral.
//
// Source pins (the repo's frontend test convention): the feature must be
// reachable by EVERY role, never role-gated in the client, wired to the real
// endpoints, and truthful — no invented referral rewards, approvals or
// resume uploads, none of which exist in this product.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFile(join(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

test('the route exists, is lazy, and has no role gate', async () => {
  const routes = await read('src/routes/AppRoutes.jsx');
  assert.match(routes, /const ReferralsPage = lazy\(\(\) => import\("\.\.\/pages\/referrals\/ReferralsPage\.jsx"\)\);/);
  assert.match(routes, /<Route path="referrals" element=\{<ReferralsPage \/>\} \/>/);
  // the referrals route element must not be wrapped in a role/permission gate
  assert.doesNotMatch(
    routes,
    /<Route path="referrals" element=\{<(?:RequireRole|RequirePermission)[^>]*>/,
    'referrals must be reachable by every authenticated employee',
  );
});

test('every role menu exposes Job Referrals (5 roles)', async () => {
  const layout = await read('src/layout/AppLayout.jsx');
  const count = (layout.match(/to: "\/app\/referrals", label: "Job Referrals"/g) || []).length;
  assert.ok(
    count >= 5,
    `expected the entry in all five role arrays (COMPANY_ADMIN, HR_MANAGER, MANAGER, TEAM_LEAD, EMPLOYEE), found ${count}`,
  );
});

test('the sidebar groups referrals under Work and gives it an icon', async () => {
  const nav = await read('src/layout/SidebarNav.jsx');
  assert.match(nav, /"\/app\/referrals": UserPlus,/);
  assert.match(
    nav,
    /paths: \["\/app\/tasks", "\/app\/meetings", "\/app\/announcements", "\/app\/referrals"\]/,
  );
});

test('the page talks to the real referral endpoints', async () => {
  const service = await read('src/services/referralService.js');
  assert.match(service, /api\.get\('\/referrals\/openings'\)/);
  assert.match(service, /api\.get\('\/referrals\/mine'\)/);
  assert.match(service, /api\.post\(`\/referrals\/\$\{jobCode\}`/);

  const page = await read('src/pages/referrals/ReferralsPage.jsx');
  assert.match(page, /referralService\.openings\(\)/);
  assert.match(page, /referralService\.mine\(\)/);
  assert.match(page, /referralService\.refer\(/);
});

test('the referral form requires name + email, and phone stays optional', async () => {
  const page = await read('src/pages/referrals/ReferralsPage.jsx');
  assert.match(page, /errors\.fullName = "Enter the candidate's full name"/);
  assert.match(page, /errors\.email = "Enter a valid email"/);
  assert.match(page, /\(optional\)/);
});

test('the page stays truthful: no invented rewards, approvals or resume uploads', async () => {
  // strip comments first — a comment EXPLAINING the ban must not trip it
  // (this bit me twice in one unit: 'rewards', then 'incentive', both in
  // comments). The scan judges user-facing copy only.
  const raw = await read('src/pages/referrals/ReferralsPage.jsx');
  const page = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .toLowerCase();
  for (const banned of ['reward', 'bonus', 'incentive', 'gift card', 'resume upload', 'approve referral']) {
    assert.equal(
      page.includes(banned),
      false,
      `the referrals page must not claim a "${banned}" flow this product does not have`,
    );
  }
  // and it must say what actually happens: the candidate enters the pipeline
  assert.match(page, /normal pipeline/);
});

test('HR surfaces label REFERRAL candidates as Referral', async () => {
  const inbox = await read('src/pages/recruitment/CandidateInboxPage.jsx');
  assert.match(inbox, /value === 'REFERRAL' \? 'Referral'/);
  assert.match(inbox, /<option value="REFERRAL">Referral<\/option>/);

  const detail = await read('src/pages/recruitment/CandidateDetailPage.jsx');
  assert.match(detail, /candidate\.overview\.source === 'REFERRAL' \? 'Referral'/);
});

test('the backend analytics accepts and labels the REFERRAL source', async () => {
  const analytics = await read('../Backend/src/services/recruitment/recruitmentAnalyticsService.js');
  assert.match(analytics, /\['INTERNAL', 'CAREER_PAGE', 'REFERRAL'\]/);
  assert.match(analytics, /'Employee referral'/);
});

test('the candidate model carries the REFERRAL source and the referrer', async () => {
  const model = await read('../Backend/src/models/Candidate.js');
  assert.match(model, /CANDIDATE_SOURCES = \['INTERNAL', 'CAREER_PAGE', 'REFERRAL'\]/);
  assert.match(model, /referredBy: \{ type: mongoose\.Schema\.Types\.ObjectId, ref: 'User', default: null \}/);
});

// ── post-requisition handoff (the "bad UX after approving" fix) ────────────

test('approving a requisition hands the reviewer to the next step, not a dead end', async () => {
  const page = await read('src/pages/recruitment/RequisitionApprovalsPage.jsx');
  // the toast names what actually happened…
  assert.match(page, /approved — job posting created as a draft/);
  // …and a persistent banner offers the one-click continuation
  assert.match(page, /justApproved && \(/);
  assert.match(page, /the job posting was created as a draft/);
  assert.match(page, /Open job posting/);
  assert.match(page, /careers page and in every employee/);
});

test('the requisition drawer shows the next step as a section, not a buried button', async () => {
  const page = await read('src/pages/recruitment/RequisitionsPage.jsx');
  assert.match(page, /Next step: the job posting/);
  assert.match(page, /Open job posting/);
  assert.match(page, /Create job posting/);
  // the old buried header-row button is gone
  assert.doesNotMatch(page, /Open created job/);
  // the user-facing tab no longer says "legacy"
  assert.doesNotMatch(page, /Existing jobs/);
  assert.match(page, /Job postings &amp; pipeline/);
});

test('job-save feedback tells the truth about draft vs published', async () => {
  const page = await read('src/pages/recruitment/RecruitmentPage.jsx');
  assert.match(page, /Job published — now visible on the careers page and in employee Job Referrals/);
  assert.match(page, /Job saved as draft — publish it when it is ready/);
  // the misleading unconditional toast is gone
  assert.doesNotMatch(page, /flash\('success', 'Job posted'\)/);
});

// ── the "Invalid value" toast (2-char job title from a requisition) ────────

test('the job form catches a too-short title before the server does', async () => {
  const page = await read('src/pages/recruitment/RecruitmentPage.jsx');
  assert.match(
    page,
    /Job title must be at least 3 characters — e\.g\. change "hr" to "HR Executive" — then save again/,
    'saveJob must guard the title contract with a fix-it message',
  );
  // and backend field errors are surfaced per-field instead of a bare toast
  assert.match(page, /response\?\.data\?\.errors/);
});

test('the backend update validator names the field instead of "Invalid value"', async () => {
  const validator = await read('../Backend/src/validators/recruitment/recruitmentValidator.js');
  const block = validator.slice(
    validator.indexOf('export const updateJobRules'),
    validator.indexOf('export const candidateRules'),
  );
  assert.match(block, /isLength\(\{ min: 3, max: 120 \}\)\.withMessage\('Title must be 3–120 characters'\)/);
});
