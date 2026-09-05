// Phase 30.1 — OPTIONAL BGV DECISION (hermetic suite).
//
// Runs without MongoDB/Redis: the decision service accepts injected
// collaborators (deps) and the rules/composition functions are pure, so every
// business path below is exercised in-memory with fake snapshots.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BGV_DECISIONS,
  BGV_DECISION_MAX_REASON_LENGTH,
  composeConversionBgvEligibility,
  decisionDisplay,
  decisionStatusFor,
  evaluateDecisionEligibility,
  normalizeDecisionReason,
  resolveDecisionOutcome,
} from '../src/services/bgv/bgvDecisionRules.js';
import { recordBgvDecision } from '../src/services/bgv/bgvDecisionService.js';
import BackgroundVerificationHistory from '../src/models/BackgroundVerificationHistory.js';

const COMPANY_A = 'aaa111111111111111111111';
const COMPANY_B = 'bbb222222222222222222222';
const CANDIDATE_ID = 'ccc333333333333333333333';
const JOB_ID = 'ddd444444444444444444444';
const ACTOR = 'eee555555555555555555555';

// ── fakes ────────────────────────────────────────────────────────
const makeCandidate = (over = {}) => ({
  _id: CANDIDATE_ID,
  companyId: COMPANY_A,
  job: JOB_ID,
  currentStage: 'SELECTED',
  stage: 'SELECTED',
  bgvDecision: { status: 'NONE', decidedBy: null, decidedAt: null, reason: '' },
  ...over,
});

const makeWorld = ({ candidate = makeCandidate(), activeCase = null } = {}) => {
  const state = {
    candidate,
    activeCase,
    loads: [],
    claims: [],
    history: [],
    audits: [],
  };
  const deps = {
    loadCandidate: async ({ companyId, candidateRef }) => {
      state.loads.push({ companyId, candidateRef });
      // Tenant-safe: only the same-tenant snapshot is ever returned.
      if (companyId !== candidate.companyId) return null;
      return state.candidate;
    },
    loadActiveCase: async () => state.activeCase,
    claimDecision: async (args) => {
      state.claims.push(args);
      if (state.candidate.bgvDecision.status !== 'NONE') return null; // lost race
      state.candidate.bgvDecision = {
        status: args.target,
        decidedBy: args.actorId,
        decidedAt: args.decidedAt,
        reason: args.reason,
      };
      return { _id: state.candidate._id, bgvDecision: state.candidate.bgvDecision };
    },
    reloadCandidate: async () => state.candidate,
    writeHistory: async (entry) => {
      state.history.push(entry);
      return entry;
    },
    audit: async (entry) => {
      state.audits.push(entry);
      return true;
    },
  };
  return { state, deps };
};

const record = (world, over = {}) =>
  recordBgvDecision({
    companyId: COMPANY_A,
    candidateRef: CANDIDATE_ID,
    actorId: ACTOR,
    decision: 'PROCEED_WITHOUT_BGV',
    reason: '',
    deps: world.deps,
    ...over,
  });

// ── pure rules ───────────────────────────────────────────────────
test('rules: only the two explicit HR choices exist', () => {
  assert.deepEqual(BGV_DECISIONS, ['PROCEED_WITHOUT_BGV', 'INITIATE_BGV']);
  assert.equal(decisionStatusFor('PROCEED_WITHOUT_BGV'), 'PROCEEDED_WITHOUT_BGV');
  assert.equal(decisionStatusFor('INITIATE_BGV'), 'BGV_INITIATED');
  assert.equal(decisionStatusFor('CLEAR'), null);
});

test('rules: decision only after the human final selection', () => {
  for (const stage of ['APPLIED', 'HR_SCREENING', 'INTERVIEW_2', 'HR_FINAL', 'FINAL_REVIEW']) {
    const result = evaluateDecisionEligibility({ stage, decision: 'PROCEED_WITHOUT_BGV' });
    assert.equal(result.allowed, false, `${stage} must not be eligible`);
    assert.equal(result.code, 'NOT_POST_SELECTION');
  }
  for (const stage of ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'PRE_ONBOARDING', 'JOINED']) {
    assert.equal(
      evaluateDecisionEligibility({ stage, decision: 'INITIATE_BGV' }).allowed,
      true,
      `${stage} must be eligible`
    );
  }
});

test('rules: an active 27.15 case blocks both choices', () => {
  const waived = evaluateDecisionEligibility({
    stage: 'SELECTED',
    decision: 'PROCEED_WITHOUT_BGV',
    hasActiveCase: true,
  });
  assert.equal(waived.allowed, false);
  assert.equal(waived.code, 'BGV_ALREADY_STARTED');

  const initiated = evaluateDecisionEligibility({
    stage: 'SELECTED',
    decision: 'INITIATE_BGV',
    hasActiveCase: true,
  });
  assert.equal(initiated.allowed, false);
  assert.equal(initiated.code, 'BGV_CASE_EXISTS');
});

test('rules: idempotent same, conflict opposite, record when fresh', () => {
  assert.equal(
    resolveDecisionOutcome({ currentStatus: 'NONE', decision: 'INITIATE_BGV' }).kind,
    'RECORD'
  );
  assert.equal(
    resolveDecisionOutcome({
      currentStatus: 'BGV_INITIATED',
      decision: 'INITIATE_BGV',
    }).kind,
    'IDEMPOTENT'
  );
  assert.equal(
    resolveDecisionOutcome({
      currentStatus: 'PROCEEDED_WITHOUT_BGV',
      decision: 'INITIATE_BGV',
    }).kind,
    'CONFLICT'
  );
  assert.equal(
    resolveDecisionOutcome({
      currentStatus: 'BGV_INITIATED',
      decision: 'PROCEED_WITHOUT_BGV',
    }).kind,
    'CONFLICT'
  );
});

test('rules: reason is optional, trimmed and capped', () => {
  assert.equal(normalizeDecisionReason(undefined), '');
  assert.equal(normalizeDecisionReason('  BGV not required for this role  '), 'BGV not required for this role');
  const long = 'x'.repeat(BGV_DECISION_MAX_REASON_LENGTH + 50);
  assert.equal(normalizeDecisionReason(long).length, BGV_DECISION_MAX_REASON_LENGTH);
});

test('rules: Without-BGV display can never claim a clearance', () => {
  const waived = decisionDisplay({ status: 'PROCEEDED_WITHOUT_BGV' });
  assert.equal(waived.cleared, false);
  assert.equal(waived.label, 'BGV Not Requested');
  // The label must never read as a clearance (the note may negate one).
  assert.doesNotMatch(waived.label, /clear|verified|passed/i);
  assert.match(waived.note, /NOT been BGV cleared/);
  const initiated = decisionDisplay({ status: 'BGV_INITIATED' });
  assert.equal(initiated.cleared, false);
  assert.equal(decisionDisplay({}).label, 'No BGV decision yet');
});

// ── conversion composition (27.15 preserved + 30.1 waiver) ───────
const caseRecord = (over = {}) => ({
  _id: 'fff666666666666666666666',
  caseCode: 'BGV-0007',
  status: 'COMPLETED',
  overallOutcome: 'CLEAR',
  ...over,
});

test('composition: settings off stays not-required (27.15 behaviour)', () => {
  const result = composeConversionBgvEligibility({
    settings: { enabled: false, bgvRequiredBeforeConversion: true },
    caseRecord: null,
    decisionStatus: 'NONE',
  });
  assert.deepEqual(
    { required: result.required, satisfied: result.satisfied },
    { required: false, satisfied: true }
  );
});

test('composition: required + no case blocks unless HR waived it', () => {
  const settings = { enabled: true, bgvRequiredBeforeConversion: true };
  const blocking = composeConversionBgvEligibility({ settings, caseRecord: null });
  assert.equal(blocking.satisfied, false);
  assert.equal(blocking.blockingReasons.length, 1);

  const waived = composeConversionBgvEligibility({
    settings,
    caseRecord: null,
    decisionStatus: 'PROCEEDED_WITHOUT_BGV',
  });
  assert.equal(waived.required, true);
  assert.equal(waived.satisfied, true);
  assert.equal(waived.waived, true);
  assert.deepEqual(waived.blockingReasons, []);

  // Initiated-but-not-performed is NOT a clearance.
  const initiated = composeConversionBgvEligibility({
    settings,
    caseRecord: null,
    decisionStatus: 'BGV_INITIATED',
  });
  assert.equal(initiated.satisfied, false);
});

test('composition: active case branches unchanged by the waiver', () => {
  const settings = { enabled: true, bgvRequiredBeforeConversion: true };
  const inProgress = composeConversionBgvEligibility({
    settings,
    caseRecord: caseRecord({ status: 'IN_PROGRESS' }),
    decisionStatus: 'PROCEEDED_WITHOUT_BGV',
  });
  assert.equal(inProgress.satisfied, false);
  assert.match(inProgress.blockingReasons[0], /IN_PROGRESS/);

  const hold = composeConversionBgvEligibility({
    settings,
    caseRecord: caseRecord({ overallOutcome: 'HOLD' }),
  });
  assert.equal(hold.satisfied, false);

  const clear = composeConversionBgvEligibility({
    settings,
    caseRecord: caseRecord({ overallOutcome: 'CLEAR_WITH_DISCREPANCIES' }),
  });
  assert.equal(clear.satisfied, true);
});

// ── service behaviour ────────────────────────────────────────────
test('service: eligible selected candidate records Proceed Without BGV', async () => {
  const world = makeWorld();
  const result = await record(world, { reason: ' BGV not required for this role ' });

  assert.equal(result.changed, true);
  assert.equal(result.idempotent, false);
  assert.equal(result.decision.status, 'PROCEEDED_WITHOUT_BGV');
  assert.equal(result.decision.reason, 'BGV not required for this role');
  assert.equal(world.state.candidate.bgvDecision.decidedBy, ACTOR);

  // Timeline + audit written exactly once, with safe metadata only.
  assert.equal(world.state.history.length, 1);
  assert.equal(world.state.history[0].action, 'BGV_DECISION_WAIVED');
  assert.equal(world.state.history[0].source, 'BGV_DECISION');
  assert.equal(world.state.audits.length, 1);
  assert.equal(world.state.audits[0].action, 'BGV_DECISION_WAIVED');
  assert.equal(world.state.audits[0].companyId, COMPANY_A);
});

test('service: Initiate BGV records the intention (no case, no payment)', async () => {
  const world = makeWorld();
  const result = await record(world, { decision: 'INITIATE_BGV' });

  assert.equal(result.decision.status, 'BGV_INITIATED');
  assert.equal(world.state.history[0].action, 'BGV_DECISION_INITIATED');
  // No active case was manufactured by the decision itself.
  assert.equal(world.state.activeCase, null);
});

test('service: pre-selection candidate is rejected with 409', async () => {
  const world = makeWorld({ candidate: makeCandidate({ currentStage: 'FINAL_REVIEW' }) });
  await assert.rejects(record(world), (error) => error.statusCode === 409);
  assert.equal(world.state.claims.length, 0);
  assert.equal(world.state.audits.length, 0);
});

test('service: invalid decision value is a 400', async () => {
  const world = makeWorld();
  await assert.rejects(
    record(world, { decision: 'CLEAR' }),
    (error) => error.statusCode === 400
  );
});

test('service: identical duplicate decision is idempotent, no duplicate effects', async () => {
  const world = makeWorld();
  await record(world);
  const again = await record(world);

  assert.equal(again.idempotent, true);
  assert.equal(again.changed, false);
  assert.equal(again.decision.status, 'PROCEEDED_WITHOUT_BGV');
  assert.equal(world.state.claims.length, 1, 'second submit must not re-claim');
  assert.equal(world.state.history.length, 1, 'no duplicate timeline row');
  assert.equal(world.state.audits.length, 1, 'no duplicate audit row');
});

test('service: conflicting opposite decision is rejected', async () => {
  const world = makeWorld();
  await record(world);
  await assert.rejects(
    record(world, { decision: 'INITIATE_BGV' }),
    (error) => error.statusCode === 409
  );
});

test('service: active 27.15 case blocks both decisions', async () => {
  const activeCase = { _id: '999888877777777777777777', status: 'IN_PROGRESS' };
  const world = makeWorld({ activeCase });
  await assert.rejects(record(world), (error) => error.statusCode === 409);
  await assert.rejects(
    record(world, { decision: 'INITIATE_BGV' }),
    (error) => error.statusCode === 409
  );
  assert.equal(world.state.claims.length, 0);
});

test('service: tenant B candidate is a clean 404 for tenant A', async () => {
  const world = makeWorld();
  await assert.rejects(
    recordBgvDecision({
      companyId: COMPANY_B,
      candidateRef: CANDIDATE_ID,
      actorId: ACTOR,
      decision: 'PROCEED_WITHOUT_BGV',
      deps: world.deps,
    }),
    (error) => error.statusCode === 404
  );
  assert.equal(world.state.claims.length, 0);
});

test('service: tenant authority always flows through companyId in the load filter', async () => {
  const world = makeWorld();
  await record(world);
  assert.equal(world.state.loads[0].companyId, COMPANY_A);
  assert.equal(world.state.loads[0].candidateRef, CANDIDATE_ID);
  // The claim is tenant-scoped as well.
  assert.equal(world.state.claims[0].companyId, COMPANY_A);
});

test('regression 27.15: consent statuses are valid BGV history statuses', () => {
  // RCA 2026-09-05: Start BGV with consentRequired wrote NOT_REQUESTED ->
  // REQUESTED into BackgroundVerificationHistory and crashed on the enum.
  const previous = BackgroundVerificationHistory.schema.path('previousStatus').enumValues;
  const next = BackgroundVerificationHistory.schema.path('newStatus').enumValues;
  for (const status of ['NOT_REQUESTED', 'REQUESTED', 'GRANTED', 'DECLINED']) {
    assert.ok(previous.includes(status), `previousStatus must accept ${status}`);
    assert.ok(next.includes(status), `newStatus must accept ${status}`);
  }
  // A consent row now passes Mongoose validation synchronously.
  const row = new BackgroundVerificationHistory({
    companyId: COMPANY_A,
    case: 'fff666666666666666666666',
    candidate: CANDIDATE_ID,
    action: 'BGV_CONSENT_REQUESTED',
    previousStatus: 'NOT_REQUESTED',
    newStatus: 'REQUESTED',
    actorType: 'TENANT_USER',
  });
  const validationError = row.validateSync();
  assert.equal(validationError, undefined);
});

test('service: the decision never mutates the pipeline stage', async () => {
  const world = makeWorld();
  await record(world);
  assert.equal(world.state.candidate.currentStage, 'SELECTED');
  // The claim only touches bgvDecision fields.
  const claim = world.state.claims[0];
  assert.equal(claim.target, 'PROCEEDED_WITHOUT_BGV');
  assert.ok(!('stage' in claim) && !('currentStage' in claim));
});
