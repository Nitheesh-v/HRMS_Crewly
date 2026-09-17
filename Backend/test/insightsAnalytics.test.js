// Insights backend — hermetic suite (no Mongo, no network).
//
// Guards the exact regression the user hit on localhost ("Route not
// found" on /app/analytics + /app/reports): every frontend-called
// endpoint must be registered, validated, and backed by importable
// models — plus pure-unit coverage of the shared reporting toolbox.
import test from 'node:test';
import assert from 'node:assert/strict';

// Dummy URI satisfies src/config/env.js at import (same convention as the
// other suites). Nothing ever connects — no Mongo, no network.
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

// Dynamic imports AFTER the env assignment: static imports hoist above
// it, which would trip the env guard in the middleware chain.
const core = await import('../src/utils/reportingCore.js');
const { REPORT_BUILDER_MODULES } = await import(
  '../src/controllers/reportBuilderController.js'
);
const {
  analyticsPresetValidator,
  reportExportValidator,
  reportRunValidator,
} = await import('../src/validators/insightsValidator.js');
const { default: insightsAnalyticsRoutes } = await import(
  '../src/routes/insightsAnalyticsRoutes.js'
);
const { default: reportBuilderRoutes } = await import(
  '../src/routes/reportBuilderRoutes.js'
);

// ── reportingCore: preset → range ────────────────────────────────────

test('reportingCore — rangeFromQuery resolves every hub preset', () => {
  const year = new Date().getFullYear();
  const month = new Date().getMonth();

  const thisMonth = core.rangeFromQuery({ preset: 'this_month' });
  assert.equal(thisMonth.from.getTime(), new Date(year, month, 1).getTime());
  assert.ok(thisMonth.to >= thisMonth.from);

  const prevMonth = core.rangeFromQuery({ preset: 'prev_month' });
  assert.equal(prevMonth.from.getTime(), new Date(year, month - 1, 1).getTime());
  assert.equal(prevMonth.to.getTime(), new Date(year, month, 1).getTime());

  const today = core.rangeFromQuery({ preset: 'today' });
  assert.equal(today.from.getHours(), 0);
  assert.ok(today.to >= today.from);

  const yesterday = core.rangeFromQuery({ preset: 'yesterday' });
  assert.ok(yesterday.to > yesterday.from);

  for (const preset of ['this_week', 'this_quarter', 'prev_quarter', 'this_year', 'prev_year']) {
    const range = core.rangeFromQuery({ preset });
    assert.ok(range.to >= range.from, `${preset} must not invert`);
    assert.equal(range.preset, preset);
  }
});

test('reportingCore — custom range honors from/to; unknown preset falls back', () => {
  const custom = core.rangeFromQuery({ preset: 'custom', from: '2026-09-01', to: '2026-09-10' });
  assert.equal(core.dstr(custom.from), '2026-09-01');
  assert.equal(custom.preset, 'custom');
  // The whole "to" day is included.
  assert.ok(custom.to.getTime() > new Date('2026-09-10T00:00:00Z').getTime());

  const fallback = core.rangeFromQuery({ preset: 'not-a-preset' });
  assert.equal(fallback.preset, 'this_month');

  const missing = core.rangeFromQuery({});
  assert.equal(missing.preset, 'this_month');
});

test('reportingCore — formatters and safe() never throw the page', async () => {
  assert.equal(core.dstr(null), null);
  assert.equal(core.dstr(new Date('2026-09-17T10:00:00Z')), '2026-09-17');
  assert.equal(core.pct(1, 4), 25);
  assert.equal(core.pct(5, 0), 0);
  assert.ok(core.money(100000).includes('1,00,000'));

  const csv = core.toCsv(
    [
      { key: 'name', label: 'Name' },
      { key: 'note', label: 'Note' },
    ],
    [{ name: 'A, B', note: 'says "hi"' }]
  );
  assert.ok(csv.includes('"A, B"'), 'commas force quoting');
  assert.ok(csv.includes('"says ""hi"""'), 'quotes are doubled');

  assert.equal(await core.safe(async () => 7, 0), 7);
  assert.equal(
    await core.safe(async () => {
      throw new Error('boom');
    }, 'fallback'),
    'fallback'
  );

  assert.deepEqual(core.firstNonNull(['$a', '$b'], 0), {
    $ifNull: ['$a', { $ifNull: ['$b', 0] }],
  });
});

// ── route registration (the localhost regression, locked) ─────────────

const registeredRoutes = (router) =>
  router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).filter((method) => layer.route.methods[method]),
      // protect + authorize (+ validators) must sit in front of handlers.
      guards: layer.route.stack.length,
    }));

test('insights routes — every Analytics Hub endpoint is registered', () => {
  const routes = registeredRoutes(insightsAnalyticsRoutes);
  const paths = routes.map((route) => `GET ${route.path}`);

  for (const path of [
    'GET /analytics/overview',
    'GET /analytics/attendance',
    'GET /analytics/leaves',
    'GET /analytics/payroll',
    'GET /analytics/work',
    'GET /analytics/recruitment',
    'GET /analytics/my',
    'GET /saas/overview',
  ]) {
    assert.ok(paths.includes(path), `${path} must be registered`);
  }

  // Every hub route carries guards (protect/authorize/validator), and
  // /my + /saas carry at least protect + role scoping.
  for (const route of routes) {
    assert.ok(route.guards >= 2, `${route.path} must be guarded, not public`);
  }
  assert.equal(routes.length, 8, 'no surprise hub routes');
});

test('report-builder routes — meta/run/export are registered', () => {
  const routes = registeredRoutes(reportBuilderRoutes);
  const asSet = new Set(
    routes.flatMap((route) => route.methods.map((method) => `${method.toUpperCase()} ${route.path}`))
  );

  assert.ok(asSet.has('GET /report-builder/meta'), 'meta must be registered');
  assert.ok(asSet.has('POST /report-builder/run'), 'run must be registered');
  assert.ok(asSet.has('POST /report-builder/export'), 'export must be registered');
  assert.equal(routes.length, 3, 'no surprise builder routes');

  for (const route of routes) {
    assert.ok(route.guards >= 2, `${route.path} must be guarded, not public`);
  }
});

// ── report module registry ───────────────────────────────────────────

test('report-builder registry — six whitelisted modules with labeled fields', () => {
  const keys = Object.keys(REPORT_BUILDER_MODULES).sort();
  assert.deepEqual(keys, ['attendance', 'employees', 'expenses', 'leaves', 'payroll', 'tasks']);

  for (const [key, definition] of Object.entries(REPORT_BUILDER_MODULES)) {
    assert.ok(definition.model, `${key} names a model`);
    assert.ok(definition.label, `${key} has a label`);
    assert.ok(definition.tenantField, `${key} names its physical tenant field`);
    assert.ok(
      Array.isArray(definition.fields) && definition.fields.length > 0,
      `${key} exposes fields`
    );
    for (const field of definition.fields) {
      assert.ok(field.key && field.label, `${key} fields need key + label`);
    }
  }
  assert.equal(REPORT_BUILDER_MODULES.payroll.hrOnly, true, 'payroll stays HR-only');
});

test('report-builder registry — every module model file imports without a database', async () => {
  const models = new Set(
    Object.values(REPORT_BUILDER_MODULES).map((definition) => definition.model)
  );
  // Plus every model the hub controller aggregates on.
  for (const name of [
    'Resignation',
    'JobPosting',
    'Project',
    'Department',
    'Payslip',
    'Appraisal',
    'Candidate',
    'Holiday',
    'Shift',
    'ShiftAssignment',
    'Company',
    'Subscription',
  ]) {
    models.add(name);
  }
  for (const name of models) {
    const model = await core.getModel(name);
    assert.ok(model, `${name}.js must import`);
  }
});

// ── validators ───────────────────────────────────────────────────────

const runChains = async (chains, req) => {
  const nextCalls = [];
  const next = () => {
    nextCalls.push(true);
  };
  for (const chain of Array.isArray(chains) ? chains : [chains]) {
    // eslint-disable-next-line no-await-in-loop
    await chain(req, {}, next);
  }
  return nextCalls.length;
};

test('validators — hub preset accepts the 9 page presets, refuses junk + tenant override', async () => {
  for (const preset of [
    'today',
    'yesterday',
    'this_week',
    'this_month',
    'prev_month',
    'this_quarter',
    'prev_quarter',
    'this_year',
    'prev_year',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await runChains(analyticsPresetValidator, { query: { preset } });
  }

  await assert.rejects(
    runChains(analyticsPresetValidator, { query: { preset: 'everything' } }),
    /preset must be one of/
  );
  await assert.rejects(
    runChains(analyticsPresetValidator, { query: { preset: 'this_month', companyId: 'x' } }),
    /must not be supplied/
  );
  await assert.rejects(
    runChains(analyticsPresetValidator, { query: { from: '17-09-2026' } }),
    /YYYY-MM-DD/
  );
});

test('validators — report run/export bodies accept the page payload, refuse junk', async () => {
  const good = {
    body: {
      module: 'attendance',
      fields: ['userName', 'date', 'status'],
      preset: 'this_month',
      filters: { status: 'PRESENT' },
      page: 2,
      pageSize: 25,
    },
    query: {},
  };
  await runChains(reportRunValidator, good);
  await runChains(reportExportValidator, { ...good, query: { format: 'xls' } });

  await assert.rejects(
    runChains(reportRunValidator, { body: { module: 'salaries' }, query: {} }),
    /module must be one of/
  );
  await assert.rejects(
    runChains(reportRunValidator, {
      body: { module: 'leaves', pageSize: 5000 },
      query: {},
    }),
    /pageSize/
  );
  await assert.rejects(
    runChains(reportExportValidator, { ...good, query: { format: 'pdf' } }),
    /format must be csv or xls/
  );
});
