// Hermetic suite for platform plan seeding/migration (subscription limits).
// No MongoDB: ensureDefaultPlans accepts an injected plan model.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.REDIS_ENABLED ||= 'false';

const { DEFAULT_PLATFORM_PLANS, ensureDefaultPlans } = await import(
  '../src/utils/platformPlans.js'
);

const makeFakePlanModel = (docs = []) => {
  const store = new Map(docs.map((doc) => [doc.key, { ...doc, saves: 0 }]));
  return {
    store,
    findOne: async ({ key }) => {
      const doc = store.get(key) || null;
      if (doc && !doc.save) {
        doc.save = async () => {
          doc.saves += 1;
          return doc;
        };
      }
      return doc;
    },
    create: async (doc) => {
      store.set(doc.key, { ...doc });
      return store.get(doc.key);
    },
  };
};

test('no current plan sells manager/lead seats', () => {
  for (const plan of Object.values(DEFAULT_PLATFORM_PLANS)) {
    const limits = plan.limits || {};
    assert.equal('managers' in limits, false, `${plan.name} must not cap managers`);
    assert.equal('teamLeads' in limits, false, `${plan.name} must not cap teamLeads`);
    assert.equal('hrManagers' in limits, false, `${plan.name} must not cap hrManagers`);
  }
});

test('stale seat limits are healed by the v3 plan migration', async () => {
  const fake = makeFakePlanModel([
    {
      key: 'ENTERPRISE',
      configVersion: 1,
      limits: { employees: 500, managers: 1, teamLeads: 1 },
      features: { payroll: false },
      enabledModules: ['ATTENDANCE'],
    },
  ]);

  await ensureDefaultPlans(null, fake);

  const healed = fake.store.get('ENTERPRISE');
  assert.equal('managers' in (healed.limits || {}), false, 'managers cap removed');
  assert.equal('teamLeads' in (healed.limits || {}), false, 'teamLeads cap removed');
  assert.equal(healed.limits.employees, DEFAULT_PLATFORM_PLANS.ENTERPRISE.limits.employees);
  assert.equal(healed.features.payroll, true, 'features migrated too');
  assert.ok(healed.configVersion >= 3, 'configVersion bumped');

  const savesBefore = healed.saves;
  await ensureDefaultPlans(null, fake);
  assert.equal(fake.store.get('ENTERPRISE').saves, savesBefore);
});

test('missing plans are created from current defaults', async () => {
  const fake = makeFakePlanModel([]);
  await ensureDefaultPlans(null, fake);
  for (const key of Object.keys(DEFAULT_PLATFORM_PLANS)) {
    const doc = fake.store.get(key);
    assert.ok(doc, `${key} seeded`);
    assert.deepEqual(doc.limits, DEFAULT_PLATFORM_PLANS[key].limits);
  }
});
