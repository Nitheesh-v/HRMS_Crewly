// ═══════════════════════════════════════════════════════════════════════════
//  A MONGODB-SHAPED AGGREGATION EVALUATOR FOR THE TEST FAKES
//
//  29.13's fast path computes the dashboard in MongoDB instead of loading
//  every snapshot into Node. A fake that simply ANSWERED the pipeline would
//  test nothing: an unsupported operator would throw, the service would fall
//  back to the row path, and the tests would stay green while the
//  aggregation was quietly never used. So the fake genuinely EVALUATES the
//  pipeline — and the tests assert which route the service took.
//
//  Supports: $match, $unwind, $group, $sort; accumulators $sum and $addToSet;
//  expressions $ifNull, $cond, $gt, $divide, $multiply and $add.
//  Anything else throws, loudly, on purpose.
// ═══════════════════════════════════════════════════════════════════════════

// ── a MongoDB-shaped aggregation evaluator ─────────────────────────────────
//
// The 29.13 fast path computes the dashboard in MongoDB instead of loading
// every snapshot into Node. A fake that simply ANSWERED the pipeline would
// test nothing: an unsupported operator would throw, the service would fall
// back to the row path, and the tests would stay green while the aggregation
// was quietly never used. So the fake genuinely EVALUATES the pipeline, and
// a test asserts the dashboard reports `source: 'AGGREGATION'`.

export const aggregatePath = (doc, path) =>
  String(path).replace(/^\$/, '').split('.').reduce((node, key) => (node == null ? undefined : node[key]), doc);

export const evalExpr = (doc, expr, vars = {}) => {
  if (expr === null || expr === undefined) return undefined;
  if (typeof expr === 'string') {
    if (expr.startsWith('$$')) return vars[expr.slice(2)];
    if (expr.startsWith('$')) return aggregatePath(doc, expr);
    return expr;
  }
  if (typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if (Array.isArray(expr)) return expr.map((item) => evalExpr(doc, item, vars));

  const [[operator, argument]] = Object.entries(expr);
  switch (operator) {
    case '$ifNull': {
      const [candidate, fallback] = evalExpr(doc, argument, vars);
      return candidate === undefined || candidate === null ? fallback : candidate;
    }
    case '$cond': {
      const [test, whenTrue, whenFalse] = argument;
      return evalExpr(doc, test, vars) ? evalExpr(doc, whenTrue, vars) : evalExpr(doc, whenFalse, vars);
    }
    case '$gt': {
      const [left, right] = evalExpr(doc, argument, vars);
      return Number(left) > Number(right);
    }
    case '$divide': {
      const [left, right] = evalExpr(doc, argument, vars);
      return Number(right) === 0 ? null : Number(left) / Number(right);
    }
    case '$multiply': {
      const [left, right] = evalExpr(doc, argument, vars);
      return Number(left) * Number(right);
    }
    case '$add': {
      const [left, right] = evalExpr(doc, argument, vars);
      return Number(left) + Number(right);
    }
    default:
      throw new Error(`fake aggregate: unsupported operator ${operator}`);
  }
};

export const aggregateMatches = (doc, filter = {}) => matches(doc, filter);

export const runPipeline = (rows, pipeline = []) => {
  let docs = (rows || []).map((row) => ({ ...row }));

  (pipeline || []).forEach((stage) => {
    const [[operator, argument]] = Object.entries(stage);

    if (operator === '$match') {
      docs = docs.filter((doc) => aggregateMatches(doc, argument));
      return;
    }
    if (operator === '$unwind') {
      const path = String(argument || '').replace(/^\$/, '');
      docs = docs.flatMap((doc) => {
        const value = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), doc);
        if (Array.isArray(value)) return value.map((item) => ({ ...doc, [path]: item }));
        return value === undefined ? [] : [doc];
      });
      return;
    }
    if (operator === '$sort') {
      const fields = Object.entries(argument || {});
      docs = [...docs].sort((left, right) => {
        for (const [field, direction] of fields) {
          const a = aggregatePath(left, field);
          const b = aggregatePath(right, field);
          if (String(a) === String(b)) continue;
          return (String(a) > String(b) ? 1 : -1) * (Number(direction) === -1 ? -1 : 1);
        }
        return 0;
      });
      return;
    }
    if (operator === '$group') {
      const groups = new Map();
      docs.forEach((doc) => {
        const identity = argument._id === null ? null : evalExpr(doc, argument._id);
        const key = JSON.stringify(identity);
        if (!groups.has(key)) groups.set(key, { identity, docs: [] });
        groups.get(key).docs.push(doc);
      });

      docs = [...groups.values()].map(({ identity, docs: members }) => {
        const out = { _id: identity };
        Object.entries(argument).forEach(([field, spec]) => {
          if (field === '_id') return;
          const [[accumulator, expression]] = Object.entries(spec);
          if (accumulator === '$sum') {
            out[field] = members.reduce((total, doc) => total + (Number(evalExpr(doc, expression)) || 0), 0);
            return;
          }
          if (accumulator === '$addToSet') {
            const set = new Set();
            members.forEach((doc) => {
              const value = evalExpr(doc, expression);
              if (value !== undefined && value !== null) set.add(value);
            });
            out[field] = [...set];
            return;
          }
          throw new Error(`fake aggregate: unsupported accumulator ${accumulator}`);
        });
        return out;
      });
      return;
    }
    throw new Error(`fake aggregate: unsupported stage ${operator}`);
  });

  return docs;
};

// ── a MongoDB-shaped filter matcher ────────────────────────────────────────
//
// The fake models answer real queries, so this has to be honest about the
// operators the services actually use: $in, $ne, $regex, and the range
// operators. Dates are compared as dates — stringifying a Date gives "Mon
// Aug 03 …" against "Sat Aug 01 …", "Mon" sorts before "Sat", and a
// lexicographic compare then silently answers the wrong question.

export const pathValue = (row, path) =>
  String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), row);

export const matches = (row, filter = {}) =>
  Object.entries(filter).every(([key, condition]) => {
    const value = pathValue(row, key);
    if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
      if (condition.$in) return condition.$in.some((item) => String(item) === String(value));
      if (condition.$ne !== undefined) return String(value) !== String(condition.$ne);
      // Range operators are what the leave-balance query and the §9 join/exit
      // counts use. Dates must be compared as dates: stringifying a Date gives
      // "Mon Aug 03 …" against "Sat Aug 01 …", and "Mon" sorts before "Sat",
      // so a lexicographic compare silently answers the wrong question.
      const ranged = ['$gte', '$gt', '$lte', '$lt'].some((op) => condition[op] !== undefined);
      if (ranged) {
        const isDate = (side) => side instanceof Date;
        if (isDate(value) || ['$gte', '$gt', '$lte', '$lt'].some((op) => isDate(condition[op]))) {
          const when = isDate(value) ? value.getTime() : new Date(value).getTime();
          if (Number.isNaN(when)) return false;
          const bound = (op) => (condition[op] === undefined ? null : new Date(condition[op]).getTime());
          if (bound('$gte') !== null && when < bound('$gte')) return false;
          if (bound('$gt') !== null && when <= bound('$gt')) return false;
          if (bound('$lte') !== null && when > bound('$lte')) return false;
          if (bound('$lt') !== null && when >= bound('$lt')) return false;
          return true;
        }
        if (condition.$gte !== undefined && !(String(value) >= String(condition.$gte))) return false;
        if (condition.$gt !== undefined && !(String(value) > String(condition.$gt))) return false;
        if (condition.$lte !== undefined && !(String(value) <= String(condition.$lte))) return false;
        if (condition.$lt !== undefined && !(String(value) < String(condition.$lt))) return false;
        return true;
      }
      return String(value) === String(condition);
    }
    if (condition instanceof Date) return String(value) === String(condition);
    return String(value) === String(condition);
  });

const applyUpdate = (row, update = {}) => {
  Object.entries(update.$set || {}).forEach(([key, value]) => {
    if (key.includes('.')) {
      const [head, tail] = key.split('.');
      row[head] = { ...(row[head] || {}), [tail]: value };
    } else {
      row[key] = value;
    }
  });
  Object.entries(update.$inc || {}).forEach(([key, delta]) => {
    const path = key.split('.');
    if (path.length === 1) {
      row[key] = Number(row[key] || 0) + Number(delta);
    } else {
      row[path[0]] = { ...(row[path[0]] || {}) };
      row[path[0]][path[1]] = Number(row[path[0]][path[1]] || 0) + Number(delta);
    }
  });
};

const makeFakeModel = (defaults = {}) => {
  const rows = [];
  let counter = 0;

  const buildQuery = (filter, sortKey = null) => ({
    lean: async () => {
      const found = rows.filter((row) => matches(row, filter));
      if (sortKey) {
        const [field, direction] = sortKey;
        found.sort((a, b) => (direction === -1 ? String(b[field]).localeCompare(String(a[field])) : String(a[field]).localeCompare(String(b[field]))));
      }
      // Mongoose's .lean() returns detached plain objects.
      return found.map((row) => ({ ...row }));
    },
    select: () => buildQuery(filter, sortKey),
    sort: (spec) => {
      const field = Object.keys(spec || {})[0];
      return buildQuery(filter, field ? [field, spec[field]] : sortKey);
    },
    limit: () => buildQuery(filter, sortKey),
  });

  // A live document: mutating it mutates the store, and .save() is a no-op
  // that just marks the write (exactly what the service relies on).
  const asDocument = (row) =>
    Object.assign(row, {
      async save() {
        row.updatedAt = new Date();
        return row;
      },
    });

  const model = {
    rows,
    find: (filter = {}) => buildQuery(filter),
    findOne: (filter = {}) => {
      const chain = {
        lean: async () => {
          const found = rows.find((row) => matches(row, filter));
          return found ? { ...found } : null;
        },
        // .select('+binary') also has to be awaitable AND chainable: the
        // download route reads the artefact through it.
        select: () => chain,
        sort: () => chain,
        then: (resolve, reject) => (async () => {
          const found = rows.find((row) => matches(row, filter));
          return found ? asDocument(found) : null;
        })().then(resolve, reject),
        catch: (reject) => chain.then(undefined, reject),
      };
      return chain;
    },
    findById: (id) => {
      const lean = async () => {
        const found = rows.find((row) => String(row._id) === String(id));
        return found ? { ...found } : null;
      };
      // .select('logoUrl') is how the PDF renderer reads the company mark.
      return { lean, select: () => ({ lean }) };
    },
    countDocuments: async (filter = {}) => rows.filter((row) => matches(row, filter)).length,
    aggregate: async (pipeline = []) => runPipeline(rows, pipeline),
    async create(doc) {
      counter += 1;
      const row = {
        _id: oid(counter + 500),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...defaults,
        ...doc,
      };
      rows.push(row);
      return asDocument(row);
    },
    async updateOne(filter, update = {}, options = {}) {
      const row = rows.find((item) => matches(item, filter));
      if (!row) {
        if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
        const inserted = await model.create({ ...(filter || {}) });
        applyUpdate(inserted, update);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      applyUpdate(row, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, update = {}, options = {}) {
      const existing = rows.find((item) => matches(item, filter));
      if (existing) {
        applyUpdate(existing, update);
        return existing;
      }
      if (!options.upsert) return null;
      const inserted = await model.create({ ...(filter || {}), ...(update.$setOnInsert || {}) });
      applyUpdate(inserted, update);
      return inserted;
    },
  };

  return model;
};
