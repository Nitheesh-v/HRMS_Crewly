// PHASE 36.3 — every quick prompt must be ANSWERABLE.
//
// The retriever fills the categories listed below. There is NO leave-policy
// document source in this repository, so a pill that promises one is guaranteed
// to be refused - and a guaranteed refusal is worse than no pill.
//
// This test fails if a pill promises something the context cannot deliver.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { QUICK_PROMPTS } from '../src/components/AIAssistant/chatPrompts.js';

/**
 * What the retriever can actually put in the context string. 36.4 widened the
 * catalogue from four categories to thirteen, and the pills widened with it —
 * but the rule did not change: a pill is only allowed if its answer can be
 * assembled from one of these.
 */
const ANSWERABLE = Object.freeze({
  profile: [
    'profile',
    'name',
    'designation',
    'department',
    'date of joining',
    'employee code',
  ],
  // WHICH payslips exist and their status. The figures are deliberately NOT in
  // the context, so a pill asking "what is my net pay" would be a lie.
  payslips: ['payslip'],
  expenses: ['expense', 'expense claim'],
  tasks: ['task'],
  projects: ['project'],
  documents: ['document'],
  'leave-requests': ['leave request', 'leave history', 'recent leave'],
  leaves: ['leave balance', 'casual', 'sick', 'earned', 'comp off', 'pending leave'],
  attendance: [
    'attendance status',
    'present',
    'late',
    'half day',
    'no record',
    'shift',
    'work hours',
  ],
  'attendance-month': ['attendance', 'this month'],
  // The `policies` category is holidays + announcements. NOTHING ELSE.
  policies: ['holiday', 'announcement'],
  // The static capability catalogue: no data access at all.
  capabilities: [
    'how do i',
    'apply for leave',
    'punch',
    'claim an expense',
    'upload a document',
  ],
});

const ALL_TERMS = Object.values(ANSWERABLE).flat();

describe('Phase 36.3 quick prompts', () => {
  test('every pill has a label and a prompt', () => {
    // 36.4 widened the set from six to fifteen so the empty state introduces
    // the new own-record categories, not just the original four.
    assert.equal(QUICK_PROMPTS.length, 15);

    for (const pill of QUICK_PROMPTS) {
      assert.equal(typeof pill.label, 'string', 'label');
      assert.equal(typeof pill.prompt, 'string', 'prompt');
      assert.ok(pill.label.length > 0);
      assert.ok(pill.prompt.length > 0);
    }
  });

  test('no two pills share a label', () => {
    const labels = QUICK_PROMPTS.map((pill) => pill.label);

    assert.equal(new Set(labels).size, labels.length);
  });

  test('no pill promises a leave-policy document', () => {
    // THE 36.3 REGRESSION: "Leave policy" was shipped as a pill, but there is
    // no leave-policy model in this repo, so every click on it produced
    // "I do not have that information."
    for (const pill of QUICK_PROMPTS) {
      assert.ok(
        !/leave policy|policy document|policy manual|handbook/i.test(pill.prompt),
        `"${pill.prompt}" promises a policy document the context cannot supply`,
      );
    }
  });

  test('every prompt asks about something the retriever fills', () => {
    // Loose by design: this is a guard against a clearly unanswerable pill, not
    // an exact parser. If a new pill is added that no term covers, this fails
    // and forces the author to check the context first.
    const unverifiable = QUICK_PROMPTS.filter((pill) => {
      const haystack = `${pill.label} ${pill.prompt}`.toLowerCase();

      return !ALL_TERMS.some((term) => haystack.includes(term));
    });

    assert.deepEqual(
      unverifiable.map((pill) => pill.label),
      [],
      'these pills do not map to any category the retriever fills',
    );
  });

  test('the pills cover most of the categories', () => {
    // A pill set that only asks about one thing is a poor introduction.
    const haystack = QUICK_PROMPTS.map(
      (pill) => `${pill.label} ${pill.prompt}`.toLowerCase(),
    ).join(' | ');

    const covered = Object.keys(ANSWERABLE).filter((category) =>
      ANSWERABLE[category].some((term) => haystack.includes(term)),
    );

    assert.ok(
      covered.length >= 10,
      `only ${covered.length} categories are represented: ${covered.join(', ')}`,
    );
  });

  test('no pill asks for a salary figure', () => {
    // 36.4 — the context deliberately carries no net pay, gross or deduction
    // amount (the redactor masks salary-labelled numbers by design), so a pill
    // asking for one is guaranteed to be refused. "Which payslips do I have?"
    // is answerable; "what is my net pay?" is not.
    for (const pill of QUICK_PROMPTS) {
      assert.ok(
        !/net pay|gross pay|salary|ctc|take[\s-]?home|in[\s-]hand|how much (do i|am i) (earn|paid|get)/i.test(
          pill.prompt,
        ),
        `"${pill.prompt}" asks for a figure the context cannot supply`,
      );
    }
  });
});
