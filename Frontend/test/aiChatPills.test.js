// PHASE 36.3 — every quick prompt must be ANSWERABLE.
//
// The retriever fills exactly four categories: profile, leaves, attendance and
// policies (= upcoming holidays + recent announcement titles). There is NO
// leave-policy document source in this repository, so a pill that promises one
// is guaranteed to be refused - and a guaranteed refusal is worse than no pill.
//
// This test fails if a pill promises something the context cannot deliver.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { QUICK_PROMPTS } from '../src/pages/AIAssistant/chatPrompts.js';

/** What 36.2's retriever can actually put in the context string. */
const ANSWERABLE = Object.freeze({
  profile: [
    'profile',
    'name',
    'designation',
    'department',
    'date of joining',
    'employee code',
  ],
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
  // The `policies` category is holidays + announcements. NOTHING ELSE.
  policies: ['holiday', 'announcement'],
});

const ALL_TERMS = Object.values(ANSWERABLE).flat();

describe('Phase 36.3 quick prompts', () => {
  test('there are six pills, each with a label and a prompt', () => {
    assert.equal(QUICK_PROMPTS.length, 6);

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

  test('the pills cover three of the four categories', () => {
    // A pill set that only asks about one thing is a poor introduction.
    const haystack = QUICK_PROMPTS.map(
      (pill) => `${pill.label} ${pill.prompt}`.toLowerCase(),
    ).join(' | ');

    const covered = Object.keys(ANSWERABLE).filter((category) =>
      ANSWERABLE[category].some((term) => haystack.includes(term)),
    );

    assert.ok(
      covered.length >= 3,
      `only ${covered.length} categories are represented: ${covered.join(', ')}`,
    );
  });
});
