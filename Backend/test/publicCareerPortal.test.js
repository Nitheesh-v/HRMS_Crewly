import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [
  { default: Company },
  { default: JobPosting },
  { default: Subscription },
  { default: express },
  { default: publicCareerRoutes },
  careerService,
  careerValidators,
  careerIdentifiers,
  { updateJob },
] = await Promise.all([
  import('../src/models/Company.js'),
  import('../src/models/JobPosting.js'),
  import('../src/models/Subscription.js'),
  import('express'),
  import('../src/routes/publicCareerRoutes.js'),
  import('../src/services/publicCareerService.js'),
  import('../src/validators/publicCareerValidator.js'),
  import('../src/utils/careerPortalIdentifiers.js'),
  import('../src/controllers/recruitmentController.js'),
]);

const eligibleCompany = {
  _id: 'company-a',
  name: 'Acme Labs',
  careerSlug: 'acme-labs',
  careerPortalEnabled: true,
  careerAbout: 'Build useful systems.',
  careerWebsite: 'https://acme.example',
  careerLocation: 'Chennai',
  logoUrl: 'https://cdn.example/acme.png',
};

const eligibleSubscription = {
  status: 'ACTIVE',
  planRef: {
    features: {
      recruitment: true,
    },
  },
  enabledModules: [],
};

const restorable = (...entries) => {
  const originals = entries.map(([target, method]) => [
    target,
    method,
    target[method],
  ]);

  return () => {
    originals.forEach(([target, method, original]) => {
      target[method] = original;
    });
  };
};

const leanQuery = (value) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
});

const listQuery = (value) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  sort() {
    return this;
  },
  skip() {
    return this;
  },
  limit() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
});

const mockEligibleTenant = () => {
  Company.findOne = () => leanQuery(eligibleCompany);
  Subscription.findOne = () => ({
    populate: async () => eligibleSubscription,
  });
};

const runRules = async (rules, request = {}) => {
  const req = {
    body: {},
    params: {},
    query: {},
    ...request,
  };

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

const invokeController = (controller, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(value) {
        this.statusCode = value;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
        return this;
      },
    };

    controller(req, res, reject);
  });

test('public mappers expose only positive company and job whitelists', () => {
  const company = careerService.publicCompanyFields({
    ...eligibleCompany,
    email: 'private@acme.example',
    subscription: 'subscription-1',
    platformNotes: 'private',
  });
  const job = careerService.publicJobFields({
    _id: 'job-private-id',
    companyId: 'company-a',
    jobCode: 'JOB-0001',
    title: 'Platform Engineer',
    department: { _id: 'department-private-id', name: 'Engineering' },
    manager: 'manager-private-id',
    recruiter: 'recruiter-private-id',
    sourceRequisition: 'requisition-private-id',
    hiringBudget: 500000,
    internalNotes: 'private',
    applicants: ['candidate-private-id'],
    requiredSkills: ['Node.js'],
    preferredSkills: ['Redis'],
    experienceLevel: 'EXPERIENCED',
    minExperience: 2,
    maxExperience: 5,
    employmentType: 'FULL_TIME',
    workMode: 'HYBRID',
    location: 'Chennai',
    openings: 2,
    publicSalaryVisible: false,
    salaryMin: 100000,
    salaryMax: 200000,
  });

  assert.deepEqual(Object.keys(company).sort(), [
    'about',
    'location',
    'logoUrl',
    'name',
    'website',
  ]);
  assert.equal(company.email, undefined);
  assert.equal(company.subscription, undefined);
  assert.equal(
    careerService.publicCompanyFields({
      name: 'Unsafe',
      logoUrl: 'https://storage.example/logo.png?secureToken=private',
      careerWebsite: 'javascript:alert(1)',
    }).logoUrl,
    ''
  );
  assert.equal(
    careerService.publicCompanyFields({
      name: 'Unsafe',
      logoUrl: '',
      careerWebsite: 'javascript:alert(1)',
    }).website,
    ''
  );

  assert.equal(job.jobCode, 'JOB-0001');
  assert.equal(job.department, 'Engineering');
  assert.equal(job.numberOfOpenings, 2);
  assert.equal(job.salary, undefined);
  assert.equal(job._id, undefined);
  assert.equal(job.companyId, undefined);
  assert.equal(job.manager, undefined);
  assert.equal(job.sourceRequisition, undefined);
  assert.equal(job.hiringBudget, undefined);
  assert.equal(job.applicants, undefined);
});

test('salary is included only when explicitly visible and available', () => {
  const visible = careerService.publicJobFields({
    jobCode: 'JOB-0002',
    title: 'Designer',
    publicSalaryVisible: true,
    salaryMin: 80000,
    salaryMax: 120000,
  });
  const empty = careerService.publicJobFields({
    jobCode: 'JOB-0003',
    title: 'Writer',
    publicSalaryVisible: true,
  });

  assert.deepEqual(visible.salary, { min: 80000, max: 120000 });
  assert.equal(empty.salary, undefined);
});

test('public list keeps tenant scope, availability, escaped search and bounded pagination', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne'],
    [JobPosting, 'find'],
    [JobPosting, 'countDocuments']
  );
  let capturedFilter;
  let capturedPopulate;
  let capturedSkip;
  let capturedLimit;

  try {
    mockEligibleTenant();
    JobPosting.find = (filter) => {
      capturedFilter = filter;
      const query = listQuery([]);
      query.populate = (options) => {
        capturedPopulate = options;
        return query;
      };
      query.skip = (value) => {
        capturedSkip = value;
        return query;
      };
      query.limit = (value) => {
        capturedLimit = value;
        return query;
      };
      return query;
    };
    JobPosting.countDocuments = async () => 0;

    const result = await careerService.listPublicJobs({
      companySlug: 'acme-labs',
      query: {
        companyId: 'attacker-company',
        page: -500,
        limit: 500,
        search: '[a-z]+(secret)',
      },
    });

    assert.equal(capturedFilter.companyId, 'company-a');
    assert.equal(capturedFilter.status, 'OPEN');
    assert.equal(capturedFilter.publicationStatus, 'PUBLISHED');
    assert.equal(capturedPopulate.path, 'department');
    assert.equal(capturedPopulate.match.companyId, 'company-a');
    assert.equal(capturedFilter.$or[0].title.source, '\\[a-z\\]\\+\\(secret\\)');
    assert.equal(capturedSkip, 0);
    assert.equal(capturedLimit, 24);
    assert.equal(result.meta.page, 1);
    assert.equal(result.meta.limit, 24);
  } finally {
    restore();
  }
});

test('detail lookup includes tenant, public code and publication availability', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne'],
    [JobPosting, 'findOne'],
    [JobPosting, 'exists']
  );
  let detailFilter;
  let unavailableFilter;

  try {
    mockEligibleTenant();
    JobPosting.findOne = (filter) => {
      detailFilter = filter;
      return leanQuery(null);
    };
    JobPosting.exists = async (filter) => {
      unavailableFilter = filter;
      return { _id: 'previously-public-job' };
    };

    await assert.rejects(
      careerService.getPublicJob({
        companySlug: 'acme-labs',
        jobCode: 'job-0009',
      }),
      (error) =>
        error.statusCode === 410 &&
        /no longer accepting applications/i.test(error.message)
    );

    assert.equal(detailFilter.companyId, 'company-a');
    assert.equal(detailFilter.jobCode, 'JOB-0009');
    assert.equal(detailFilter.status, 'OPEN');
    assert.equal(detailFilter.publicationStatus, 'PUBLISHED');
    assert.ok(Array.isArray(detailFilter.$and));
    assert.equal(unavailableFilter.companyId, 'company-a');
    assert.equal(unavailableFilter.jobCode, 'JOB-0009');
    assert.deepEqual(unavailableFilter.publishedAt, { $ne: null });
  } finally {
    restore();
  }
});

test('unknown cross-tenant job code returns a safe 404', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne'],
    [JobPosting, 'findOne'],
    [JobPosting, 'exists']
  );

  try {
    mockEligibleTenant();
    JobPosting.findOne = () => leanQuery(null);
    JobPosting.exists = async () => null;

    await assert.rejects(
      careerService.getPublicJob({
        companySlug: 'acme-labs',
        jobCode: 'JOB-9999',
      }),
      (error) => error.statusCode === 404 && error.message === 'Job not found'
    );
  } finally {
    restore();
  }
});

test('disabled company portal returns a safe unavailable 404 before subscription access', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne']
  );
  let companyFilter;
  let subscriptionQueried = false;

  try {
    Company.findOne = (filter) => {
      companyFilter = filter;
      return leanQuery({
        ...eligibleCompany,
        careerPortalEnabled: false,
      });
    };
    Subscription.findOne = () => {
      subscriptionQueried = true;
      return { populate: async () => eligibleSubscription };
    };

    await assert.rejects(
      careerService.getCareerHeader({ companySlug: 'acme-labs' }),
      (error) =>
        error.statusCode === 404 &&
        error.message === 'Career portal is not available'
    );
    assert.deepEqual(companyFilter, {
      careerSlug: 'acme-labs',
      status: 'ACTIVE',
      archivedAt: null,
    });
    assert.equal(subscriptionQueried, false);
  } finally {
    restore();
  }
});

test('public validators normalize route values and clamp list query limits', async () => {
  const request = await runRules(careerValidators.careerJobListRules, {
    params: { companySlug: '  Acme-Labs  ' },
    query: {
      page: '-50',
      limit: '500',
      search: ' [a-z]+ ',
      sort: 'newest',
      companyId: 'ignored-public-value',
    },
  });

  assert.equal(request.params.companySlug, 'acme-labs');
  assert.equal(request.query.page, 1);
  assert.equal(request.query.limit, 24);
  assert.equal(request.query.search, '[a-z]+');
  assert.equal(request.query.sort, 'NEWEST');

  await assert.rejects(
    runRules(careerValidators.careerJobDetailRules, {
      params: {
        companySlug: '../private-company',
        jobCode: 'JOB-0001',
      },
    }),
    (error) => error.statusCode === 400
  );
});

test('authenticated publication keeps operational status and applies public controls', async () => {
  const restore = restorable([JobPosting, 'findOne']);
  let capturedFilter;
  let saved = false;
  const futureDeadline = new Date(Date.now() + 86_400_000).toISOString();
  const job = {
    _id: 'job-1',
    status: 'OPEN',
    publicationStatus: 'DRAFT',
    applicationDeadline: null,
    publishedAt: null,
    publicSalaryVisible: false,
    save: async () => {
      saved = true;
    },
  };

  try {
    JobPosting.findOne = async (filter) => {
      capturedFilter = filter;
      return job;
    };

    const response = await invokeController(updateJob, {
      companyId: 'company-a',
      params: { id: 'job-1' },
      body: {
        publicationStatus: 'PUBLISHED',
        applicationDeadline: futureDeadline,
        publicSalaryVisible: true,
      },
    });

    assert.deepEqual(capturedFilter, {
      _id: 'job-1',
      companyId: 'company-a',
    });
    assert.equal(saved, true);
    assert.equal(job.status, 'OPEN');
    assert.equal(job.publicationStatus, 'PUBLISHED');
    assert.equal(job.applicationDeadline, futureDeadline);
    assert.equal(job.publicSalaryVisible, true);
    assert.ok(job.publishedAt instanceof Date);
    assert.equal(response.statusCode, 200);
  } finally {
    restore();
  }
});

test('closed or expired jobs cannot be published', async () => {
  const restore = restorable([JobPosting, 'findOne']);

  try {
    JobPosting.findOne = async () => ({
      status: 'CLOSED',
      publicationStatus: 'DRAFT',
      applicationDeadline: null,
      publishedAt: null,
      save: async () => {
        throw new Error('save must not run');
      },
    });

    await assert.rejects(
      invokeController(updateJob, {
        companyId: 'company-a',
        params: { id: 'job-closed' },
        body: { publicationStatus: 'PUBLISHED' },
      }),
      (error) => error.statusCode === 400 && /reopen/i.test(error.message)
    );

    JobPosting.findOne = async () => ({
      status: 'OPEN',
      publicationStatus: 'DRAFT',
      applicationDeadline: null,
      publishedAt: null,
      save: async () => {
        throw new Error('save must not run');
      },
    });

    await assert.rejects(
      invokeController(updateJob, {
        companyId: 'company-a',
        params: { id: 'job-expired' },
        body: {
          publicationStatus: 'PUBLISHED',
          applicationDeadline: new Date(Date.now() - 86_400_000).toISOString(),
        },
      }),
      (error) => error.statusCode === 400 && /future/i.test(error.message)
    );
  } finally {
    restore();
  }
});

test('career identifiers are URL safe and migration code has no document save loop', async () => {
  assert.equal(
    careerIdentifiers.slugifyCareerValue('  Crewly Research & Development  '),
    'crewly-research-development'
  );
  assert.equal(
    careerIdentifiers.slugifyCareerValue(`${'a'.repeat(62)}--tail`),
    'a'.repeat(62)
  );

  const source = await readFile(
    new URL('../src/utils/careerPortalIdentifiers.js', import.meta.url),
    'utf8'
  );
  assert.equal(source.includes('.save('), false);
  assert.equal(source.includes('findOneAndUpdate'), true);
  assert.equal(source.includes('bulkWrite'), true);

  const jobCodeIndex = JobPosting.schema.indexes().find(
    ([fields]) => fields.companyId === 1 && fields.jobCode === 1
  );
  assert.ok(jobCodeIndex);
  assert.equal(jobCodeIndex[1].unique, true);
});

test('public router is unauthenticated, rate limited and isolated from auth login', async () => {
  const restore = restorable(
    [Company, 'findOne'],
    [Subscription, 'findOne'],
    [JobPosting, 'countDocuments']
  );
  let server;

  try {
    mockEligibleTenant();
    JobPosting.countDocuments = async () => 0;

    const routeTestApp = express();
    routeTestApp.use('/api/public/careers', publicCareerRoutes);
    routeTestApp.post('/api/auth/login', (_req, res) => {
      res.status(400).json({ success: false, message: 'Login validation reached' });
    });

    server = await new Promise((resolve) => {
      const instance = routeTestApp.listen(
        0,
        '127.0.0.1',
        () => resolve(instance)
      );
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const anonymousResponse = await fetch(
      `${baseUrl}/api/public/careers/acme-labs`
    );
    const anonymousBody = await anonymousResponse.json();

    assert.equal(anonymousResponse.status, 200);
    assert.equal(anonymousBody.data.company.name, 'Acme Labs');
    assert.equal(JSON.stringify(anonymousBody).includes('company-a'), false);

    for (let request = 1; request < 60; request += 1) {
      const response = await fetch(`${baseUrl}/api/public/careers/xx`);
      assert.equal(response.status, 400);
    }

    const limitedResponse = await fetch(
      `${baseUrl}/api/public/careers/acme-labs`
    );
    const limitedBody = await limitedResponse.json();
    assert.equal(limitedResponse.status, 429);
    assert.match(limitedBody.message, /too many career portal requests/i);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.notEqual(loginResponse.status, 429);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    restore();
  }
});
