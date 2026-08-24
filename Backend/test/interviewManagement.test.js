import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: Interview, ACTIVE_INTERVIEW_STATUSES, INTERVIEW_STATUSES },
  { default: InterviewScheduleLock },
  { CANDIDATE_HISTORY_ACTIONS },
  { default: TenantSequence },
  { nextInterviewCode },
  dateTime,
  roundService,
  { scheduleInterviewRules, rescheduleInterviewRules, updateInterviewStatusRules },
  { DEFAULT_ROLE_MATRIX },
] = await Promise.all([
  import('../src/models/Interview.js'),
  import('../src/models/InterviewScheduleLock.js'),
  import('../src/models/CandidateHistory.js'),
  import('../src/models/TenantSequence.js'),
  import('../src/utils/interviewIdentifiers.js'),
  import('../src/utils/interviewDateTime.js'),
  import('../src/services/interviewRoundService.js'),
  import('../src/validators/interviewValidator.js'),
  import('../src/utils/permissionRegistry.js'),
]);

const runRules = async (rules, { body = {}, params = {}, query = {} } = {}) => {
  const req = { body, params, query };
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
  return req;
};

const validSchedule = () => ({
  candidateId: '64b000000000000000000101',
  roundKey: 'TECHNICAL_1',
  date: '2027-01-15',
  time: '10:30',
  timezone: 'Asia/Kolkata',
  durationMinutes: 60,
  interviewType: 'ONLINE',
  meetingLink: 'https://meet.example.com/secure-room',
  location: '',
  candidateInstructions: 'Join five minutes early.',
  internalNotes: 'Focus on system design.',
  interviewerIds: [
    '64b000000000000000000102',
    '64b000000000000000000103',
  ],
  updateCandidateStage: true,
});

test('Interview model stores the tenant aggregate and required operational lifecycle', () => {
  assert.deepEqual(INTERVIEW_STATUSES, [
    'SCHEDULED',
    'RESCHEDULED',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED',
    'NO_SHOW',
  ]);
  assert.deepEqual(ACTIVE_INTERVIEW_STATUSES, [
    'SCHEDULED',
    'RESCHEDULED',
    'IN_PROGRESS',
  ]);

  const schema = Interview.schema;
  for (const path of [
    'companyId',
    'interviewCode',
    'candidate',
    'job',
    'round',
    'scheduledStartAt',
    'scheduledEndAt',
    'timezone',
    'interviewers',
    'status',
    'rescheduleHistory',
    'statusHistory',
    'reminderDispatch.state',
    'createdBy',
    'updatedBy',
  ]) {
    assert.ok(schema.path(path), `${path} must exist`);
  }
  assert.equal(schema.path('companyId').options.immutable, true);
  assert.equal(schema.path('candidate').options.immutable, true);
  assert.equal(schema.path('job').options.immutable, true);
  assert.equal(
    schema.path('rescheduleHistory').schema.path('reason').options.immutable,
    true
  );
  assert.equal(
    schema.path('rescheduleHistory').schema.path('changedBy').options.immutable,
    true
  );

  const indexes = schema.indexes();
  const codeIndex = indexes.find(([fields]) =>
    fields.companyId === 1 && fields.interviewCode === 1
  );
  assert.equal(codeIndex?.[1]?.unique, true);
  const activeRoundIndex = indexes.find(([fields]) =>
    fields.companyId === 1 && fields.candidate === 1 && fields.activeRoundKey === 1
  );
  assert.equal(activeRoundIndex?.[1]?.unique, true);
  assert.deepEqual(
    activeRoundIndex?.[1]?.partialFilterExpression,
    { activeRoundKey: { $type: 'string' } }
  );

  const lockIndexes = InterviewScheduleLock.schema.indexes();
  assert.ok(lockIndexes.some(([fields, options]) =>
    fields.companyId === 1 && options.unique === true
  ));
  assert.ok(lockIndexes.some(([fields, options]) =>
    fields.expiresAt === 1 && options.expireAfterSeconds === 0
  ));
});

test('interview identifiers use one atomic company-scoped TenantSequence increment', async () => {
  const original = TenantSequence.findOneAndUpdate;
  const calls = [];
  try {
    TenantSequence.findOneAndUpdate = async (filter, update, options) => {
      calls.push({ filter, update, options });
      return { value: 42 };
    };

    const code = await nextInterviewCode('64b000000000000000000111');
    assert.equal(code, 'INT-000042');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].filter.companyId, '64b000000000000000000111');
    assert.equal(calls[0].filter.key, 'INTERVIEW');
    assert.equal(calls[0].update.$inc.value, 1);
    assert.equal(calls[0].options.upsert, true);
  } finally {
    TenantSequence.findOneAndUpdate = original;
  }
});

test('IANA wall-clock conversion stores canonical UTC and handles DST offsets', () => {
  const india = dateTime.interviewWallClockToUtc({
    date: '2027-01-15',
    time: '10:30',
    timezone: 'Asia/Kolkata',
    durationMinutes: 60,
  });
  assert.equal(india.scheduledStartAt.toISOString(), '2027-01-15T05:00:00.000Z');
  assert.equal(india.scheduledEndAt.toISOString(), '2027-01-15T06:00:00.000Z');

  const newYorkSummer = dateTime.interviewWallClockToUtc({
    date: '2027-07-15',
    time: '10:30',
    timezone: 'America/New_York',
    durationMinutes: 45,
  });
  assert.equal(newYorkSummer.scheduledStartAt.toISOString(), '2027-07-15T14:30:00.000Z');
  assert.equal(newYorkSummer.scheduledEndAt.toISOString(), '2027-07-15T15:15:00.000Z');

  assert.throws(
    () => dateTime.interviewWallClockToUtc({
      date: '2027-01-15',
      time: '10:30',
      timezone: 'Server/Local',
      durationMinutes: 60,
    }),
    (error) => error.statusCode === 400 && /IANA/i.test(error.message)
  );
});

test('default round snapshots map only explicit HR scheduling choices to pipeline stages', () => {
  const technical = roundService.resolveInterviewRound({ roundKey: 'technical_1' });
  assert.deepEqual(technical.snapshot, {
    key: 'TECHNICAL_1',
    name: 'Technical Round 1',
    sequence: 1,
    category: 'TECHNICAL',
  });
  assert.equal(technical.targetStage, 'INTERVIEW_1');

  const custom = roundService.resolveInterviewRound({
    roundKey: 'ARCHITECTURE_PANEL',
    roundName: 'Architecture Panel',
    roundSequence: 8,
    roundCategory: 'CUSTOM',
  });
  assert.equal(custom.targetStage, null);
  assert.equal(custom.snapshot.name, 'Architecture Panel');
});

test('authoritative validators reject ownership injection, duplicate interviewers and unsafe status', async () => {
  await runRules(scheduleInterviewRules, { body: validSchedule() });

  await assert.rejects(
    runRules(scheduleInterviewRules, {
      body: { ...validSchedule(), companyId: '64b000000000000000000199' },
    }),
    (error) => error.statusCode === 400 && /server controlled/i.test(error.message)
  );

  const duplicated = validSchedule();
  duplicated.interviewerIds = [
    '64b000000000000000000102',
    '64b000000000000000000102',
  ];
  await assert.rejects(
    runRules(scheduleInterviewRules, { body: duplicated }),
    (error) => error.statusCode === 400 && /duplicates/i.test(error.message)
  );

  await assert.rejects(
    runRules(updateInterviewStatusRules, {
      params: { id: '64b000000000000000000120' },
      body: { status: 'SELECTED' },
    }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    runRules(updateInterviewStatusRules, {
      params: { id: '64b000000000000000000120' },
      body: { status: 'NO_SHOW', reason: '' },
    }),
    (error) => error.statusCode === 400 && /reason/i.test(error.message)
  );
});

test('reschedule validation requires a reason and never permits candidate, round or status reassignment', async () => {
  const body = {
    date: '2027-01-16',
    time: '11:00',
    timezone: 'Asia/Kolkata',
    durationMinutes: 60,
    interviewerIds: ['64b000000000000000000102'],
    meetingLink: 'https://meet.example.com/new-room',
    location: '',
    reason: 'Interviewer availability changed',
  };
  await runRules(rescheduleInterviewRules, {
    params: { id: '64b000000000000000000120' },
    body,
  });
  await assert.rejects(
    runRules(rescheduleInterviewRules, {
      params: { id: '64b000000000000000000120' },
      body: { ...body, status: 'COMPLETED' },
    }),
    (error) => error.statusCode === 400 && /cannot be changed/i.test(error.message)
  );
});

test('RBAC gives HR broad management and every tenant role narrow assignment access', () => {
  for (const permission of ['INTERVIEW_READ', 'INTERVIEW_CREATE', 'INTERVIEW_UPDATE']) {
    assert.equal(DEFAULT_ROLE_MATRIX.COMPANY_ADMIN.includes(permission), true);
    assert.equal(DEFAULT_ROLE_MATRIX.HR_MANAGER.includes(permission), true);
  }
  for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE']) {
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('INTERVIEW_READ'), false);
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('INTERVIEW_UPDATE'), false);
  }
  for (const role of ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE']) {
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('INTERVIEW_READ_SELF'), true);
    assert.equal(DEFAULT_ROLE_MATRIX[role].includes('INTERVIEW_UPDATE_SELF'), true);
  }
});

test('candidate operational history recognizes every Phase 27.9 interview event', () => {
  for (const action of [
    'INTERVIEW_SCHEDULED',
    'INTERVIEW_RESCHEDULED',
    'INTERVIEW_CANCELLED',
    'INTERVIEW_STARTED',
    'INTERVIEW_COMPLETED',
    'INTERVIEW_NO_SHOW',
  ]) {
    assert.equal(CANDIDATE_HISTORY_ACTIONS.includes(action), true);
  }
});

test('routes, access guards, audit actions, queue boundary and frontend surfaces stay wired', async () => {
  const [
    routes,
    service,
    dispatcher,
    controller,
    detailPage,
    workspace,
    myWorkspace,
    scheduleModal,
    detailModal,
  ] = await Promise.all([
    readFile(new URL('../src/routes/recruitmentRoutes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/interviewService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/interviewNotificationDispatcher.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/interviewController.js', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/pages/recruitment/CandidateDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/pages/recruitment/InterviewsPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/pages/recruitment/MyInterviewsPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/components/recruitment/InterviewScheduleModal.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/components/recruitment/InterviewDetailModal.jsx', import.meta.url), 'utf8'),
  ]);

  const routeContracts = [
    ['/interviews/options', 'INTERVIEW_READ'],
    ['/interviews/eligible-interviewers', 'INTERVIEW_CREATE'],
    ['/interviews/my-interviews', 'INTERVIEW_READ_SELF'],
    ['/interviews', 'INTERVIEW_READ'],
    ['/interviews/:id/reschedule', 'INTERVIEW_UPDATE'],
    ['/interviews/:id/cancel', 'INTERVIEW_UPDATE'],
    ['/interviews/:id/status', 'INTERVIEW_UPDATE_SELF'],
    ['/candidates/:candidateRef/interviews', 'INTERVIEW_READ'],
  ];
  for (const [path, permission] of routeContracts) {
    const routeIndex = routes.indexOf(`'${path}'`);
    const permissionIndex = routes.indexOf(`'${permission}'`, routeIndex);
    assert.notEqual(routeIndex, -1, `${path} route must exist`);
    assert.equal(permissionIndex > routeIndex && permissionIndex - routeIndex < 300, true);
  }

  for (const marker of [
    "action: 'INTERVIEW_SCHEDULED'",
    "action: 'INTERVIEWER_ASSIGNED'",
    "action: 'INTERVIEW_RESCHEDULED'",
    "action: 'INTERVIEW_CANCELLED'",
    "action: 'INTERVIEW_STATUS_CHANGED'",
    'transitionCandidateStage({',
  ]) {
    assert.equal(service.includes(marker), true, `${marker} must remain wired`);
  }
  assert.equal(service.includes('countDocuments() + 1'), false);
  assert.equal(service.includes('req.body.companyId'), false);
  assert.equal(service.includes('acquireScheduleLock(companyId)'), true);
  assert.equal(service.includes('InterviewScheduleLock.findOneAndUpdate'), true);
  assert.equal(service.includes('setTimeout'), false);
  assert.equal(service.includes('setInterval'), false);
  assert.equal(dispatcher.includes('setTimeout'), false);
  assert.equal(dispatcher.includes('setInterval'), false);
  assert.equal(dispatcher.includes('BullMQ'), false);
  assert.equal(controller.includes('// Data from frontend - requests from frontend'), true);
  assert.equal(controller.includes('// DB Logic - DB logics'), true);
  assert.equal(controller.includes('// Data to frontend - response to frontend'), true);

  for (const source of [detailPage, workspace, myWorkspace, scheduleModal, detailModal]) {
    assert.equal(source.includes('dangerouslySetInnerHTML'), false);
  }
  assert.match(detailPage, /INTERVIEW_ROUNDS/);
  assert.match(detailPage, /Feedback pending/);
  assert.match(workspace, /Upcoming agenda/);
  assert.match(myWorkspace, /assignmentOnly/);
  assert.match(scheduleModal, /updateCandidateStage/);
  assert.match(detailModal, /operational completion only/i);
  assert.equal(detailModal.includes('scorecard'), true);
  assert.equal(detailModal.includes('recommendation'), true);
  assert.equal(detailModal.includes('submitFeedback'), false);
});
