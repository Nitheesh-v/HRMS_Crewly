// ============================================================
// reportingCore.js — the shared toolbox for ALL reports.
// Every analytics page/report uses these small helpers.
// Rule of this layer: NEVER duplicate business data, NEVER
// crash the whole dashboard because one number failed.
// ============================================================

// Turn a Date into a "2026-08-13" string (used for display + file names)
export const dstr = (date) => {
  if (!date) return null;
  return new Date(date).toISOString().slice(0, 10);
};

// The presets allowed in our date-range dropdown
export const REPORT_PRESETS = [
  'today', 'yesterday', 'this_week', 'this_month', 'prev_month',
  'this_quarter', 'prev_quarter', 'this_year', 'prev_year', 'custom',
];

// Convert "?preset=this_month" into real { from, to } Date objects.
// Controllers call this once, then reuse from/to everywhere.
export const rangeFromQuery = (query) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 = January
  const preset = REPORT_PRESETS.includes(query.preset) ? query.preset : 'this_month';

  // helper: today/week/etc always start at midnight
  const midnightOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  let from = new Date(year, month, 1);
  let to = now;

  if (preset === 'today') {
    from = midnightOf(now);
  } else if (preset === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    from = midnightOf(yesterday);
    to = midnightOf(now);
  } else if (preset === 'this_week') {
    const start = new Date(now);
    start.setDate(start.getDate() - start.getDay()); // back to Sunday
    from = midnightOf(start);
  } else if (preset === 'this_month') {
    from = new Date(year, month, 1);
  } else if (preset === 'prev_month') {
    from = new Date(year, month - 1, 1);
    to = new Date(year, month, 1);
  } else if (preset === 'this_quarter') {
    const quarterStartMonth = Math.floor(month / 3) * 3; // 0,3,6,9
    from = new Date(year, quarterStartMonth, 1);
  } else if (preset === 'prev_quarter') {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    from = new Date(year, quarterStartMonth - 3, 1);
    to = new Date(year, quarterStartMonth, 1);
  } else if (preset === 'this_year') {
    from = new Date(year, 0, 1);
  } else if (preset === 'prev_year') {
    from = new Date(year - 1, 0, 1);
    to = new Date(year, 0, 1);
  } else if (preset === 'custom') {
    if (query.from) from = new Date(query.from);
    if (query.to) to = new Date(new Date(query.to).getTime() + 86399999); // include the whole "to" day
  }
  return { from, to, preset };
};

// ------------------------------------------------------------
// safe() — run ONE database query. If it fails, return the
// fallback (0 or []) instead of throwing. This is why one
// broken chart can show "—" while the rest of the page works.
// ------------------------------------------------------------
export const safe = async (runQuery, fallback) => {
  try {
    return await runQuery();
  } catch (error) {
    console.warn('[reporting] one metric failed:', error.message);
    return fallback;
  }
};

// ------------------------------------------------------------
// getModel() — lazy-loads a Mongoose model by name.
// Why? (1) avoids circular-import crashes, (2) if a model file
// does not exist (e.g. Application), we can catch it gently.
// ------------------------------------------------------------
const modelCache = {};
export const getModel = async (name) => {
  if (!modelCache[name]) {
    const module = await import(`../models/${name}.js`);
    modelCache[name] = module.default || module;
  }
  return modelCache[name];
};

// ------------------------------------------------------------
// firstNonNull([...]) — build a Mongo "use the first field that
// exists" expression. Our older modules named things slightly
// differently (netSalary / net / netPay), so instead of guessing
// one name we let Mongo pick the first non-empty one.
// firstNonNull(['$netSalary', '$net'], 0)
//   → { $ifNull: ['$netSalary', { $ifNull: ['$net', 0] }] }
// ------------------------------------------------------------
export const firstNonNull = (fieldPaths, fallback = 0) => {
  let expression = fallback;
  for (let i = fieldPaths.length - 1; i >= 0; i -= 1) {
    expression = { $ifNull: [fieldPaths[i], expression] };
  }
  return expression;
};

// ------------------------------------------------------------
// CSV export: turn rows into a downloadable .csv text file.
// esc() wraps values in quotes when they contain commas/quotes.
// ------------------------------------------------------------
export const toCsv = (columns, rows) => {
  const esc = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    const needsQuotes = text.includes(',') || text.includes('"') || text.includes('\n');
    return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const headerLine = columns.map((col) => esc(col.label)).join(',');
  const dataLines = rows.map((row) => columns.map((col) => esc(row[col.key])).join(','));
  return [headerLine, ...dataLines].join('\n');
};

export const sendCsv = (res, filename, csvText) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${csvText}`); // ﻿ helps Excel read UTF-8 correctly
};

// Excel export: a simple HTML table — Excel opens it like a native .xls
export const sendXls = (res, filename, columns, rows) => {
  const cell = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return `<td>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`;
  };
  const header = columns.map((c) => `<th>${c.label}</th>`).join('');
  const body = rows.map((row) => `<tr>${columns.map((c) => cell(row[c.key])).join('')}</tr>`).join('');
  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`<html><body><table border="1"><tr>${header}</tr>${body}</table></body></html>`);
};

// Small formatters used across the app
export const money = (amount) => {
  return `₹${Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
export const pct = (part, total) => {
  if (!total || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10; // 1 decimal place
};