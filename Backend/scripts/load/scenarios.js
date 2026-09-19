// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.13 — SCENARIO REGISTRY (read-only by law, §82)
//
// Every scenario here is a REAL, verified Crewly route (§5 — nothing
// invented) and READ-ONLY. Mutating load (attendance punch, payroll,
// BGV, applications) is deliberately NOT registered: isolated synthetic
// tenants cannot be guaranteed by this harness, and Crewly law forbids
// seed/demo data — so destructive traffic stays out of the tool
// entirely (E-class decision, documented in the Phase 32 doc).
//
// Auth scenarios use a PRE-SUPPLIED legitimate token via the
// LOAD_TEST_TOKEN environment variable (name only — never a value in
// source). No bypass headers, no auth shortcuts (§28/§30/§70).
// ═══════════════════════════════════════════════════════════════════════════

export const SCENARIOS = Object.freeze({
  'health-read': {
    path: '/api/health/live',
    method: 'GET',
    auth: 'none',
    description: 'Liveness probe — unauthenticated, unthrottled; measures the HTTP+process floor.',
  },
  'health-ready': {
    path: '/api/health/ready',
    method: 'GET',
    auth: 'none',
    description: 'Readiness probe — includes cached infra state; still unthrottled.',
  },
  'attendance-today-live': {
    path: '/api/attendance/today/live',
    method: 'GET',
    auth: 'bearer',
    permission: 'ATTENDANCE_READ_SELF or ATTENDANCE_READ',
    description: 'Morning-board read pattern (Phase 31 live view) — bounded polling workload.',
  },
  'attendance-presence': {
    path: '/api/attendance/presence',
    method: 'GET',
    auth: 'bearer',
    permission: 'ATTENDANCE_READ',
    description: "Who's Working live board reads (§12) — multiple dashboard clients.",
  },
  'attendance-my': {
    path: '/api/attendance/my',
    method: 'GET',
    auth: 'bearer',
    permission: 'ATTENDANCE_READ_SELF or ATTENDANCE_READ',
    description: 'Per-employee self history read — the most common employee page load.',
  },
  'careers-jobs': {
    path: '/api/public/careers/:companySlug/jobs',
    method: 'GET',
    auth: 'none',
    buildsPath: ({ slug }) => `/api/public/careers/${encodeURIComponent(slug)}/jobs`,
    description: 'Public careers read — RATE-LIMITED by design (32.4); 429s are an expected finding, never bypassed.',
  },
});

export const isKnownScenario = (name) => Boolean(SCENARIOS[name]);

export const scenarioNeedsAuth = (name) => SCENARIOS[name]?.auth === 'bearer';

export const buildRequestFor = (name, { slug } = {}) => {
  const scenario = SCENARIOS[name];
  if (!scenario) return null;
  const path = scenario.buildsPath ? scenario.buildsPath({ slug }) : scenario.path;
  return { path, method: scenario.method, auth: scenario.auth };
};

export default SCENARIOS;
