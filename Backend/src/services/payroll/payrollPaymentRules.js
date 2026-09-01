// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.8 — BANK TRANSFER FILE & SALARY PAYMENT PREPARATION (pure)
//
//  No mongoose, no redis, no req, no Date.now(). Everything here is a
//  function of its inputs, so a 2,000-employee disbursement can be tested
//  without a database, a bank or a queue.
//
//  CREWLY NEVER MOVES MONEY (§1 / §25). This phase prepares a file that the
//  company's finance team uploads to their own banking portal; the bank
//  performs the transfer. There is no bank API here.
//
//  SECURITY (§23): a full account number exists in exactly one place — the
//  encrypted profile (29.4) and the bank file this module renders. Every list,
//  every JSON response and every screen shows the masked form.
// ═══════════════════════════════════════════════════════════════════════════

// ── statuses (§8) ──────────────────────────────────────────────────────────

export const PAYMENT_STATUSES = [
  'DRAFT',
  'READY',
  'FILE_GENERATED',
  'DOWNLOADED',
  'PROCESSING',
  'PAID',
  'PARTIALLY_PAID',
  'FAILED',
  'CANCELLED',
];

// §8 — the legal moves. A failed batch can be reopened (§4, Company Admin);
// a paid batch is finished and a cancelled one is dead.
export const PAYMENT_TRANSITIONS = {
  DRAFT: ['READY', 'CANCELLED'],
  // §7 — validation happens on creation; READY means "validated, file not
  // built yet". Confirmation is refused from READY (see the service): there
  // would be no artefact behind the claim that salaries were paid.
  READY: ['FILE_GENERATED', 'CANCELLED'],
  // Once a file exists, outcomes are allowed: the artefact is the file, and
  // the download is tracked separately for history (§12). Re-generating a
  // corrected file is also allowed — it produces a NEW file record and never
  // edits the old one.
  FILE_GENERATED: ['DOWNLOADED', 'READY', 'CANCELLED', 'PROCESSING', 'PAID', 'PARTIALLY_PAID', 'FAILED'],
  DOWNLOADED: ['FILE_GENERATED', 'PROCESSING', 'PAID', 'PARTIALLY_PAID', 'FAILED'],
  PROCESSING: ['PAID', 'PARTIALLY_PAID', 'FAILED'],
  // A paid batch is finished: reopening it would put money back in play.
  PAID: [],
  // A partially paid batch keeps working until the failures are resolved,
  // either here or in a retry batch (§15 / §16).
  PARTIALLY_PAID: ['PROCESSING', 'PAID', 'FAILED'],
  FAILED: ['READY', 'PROCESSING'],
  CANCELLED: [],
};

export const canTransition = (from, to) => (PAYMENT_TRANSITIONS[from] || []).includes(to);

export const transitionError = (from, to) =>
  `Payment batch cannot move from ${String(from || '?').replace(/_/g, ' ').toLowerCase()} to ${String(
    to || '?',
  )
    .replace(/_/g, ' ')
    .toLowerCase()}`;

// A batch that still accepts file generation or edits.
export const OPEN_PAYMENT_STATUSES = ['DRAFT', 'READY', 'FILE_GENERATED', 'FAILED', 'PARTIALLY_PAID'];

export const isOpenBatch = (status) => OPEN_PAYMENT_STATUSES.includes(status);

// Terminal: nothing about the money can change any more.
export const CLOSED_PAYMENT_STATUSES = ['PAID', 'CANCELLED'];

// ── employee payment statuses ──────────────────────────────────────────────

export const EMPLOYEE_PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED'];

// §14 — the reasons finance may record for a returned salary.
export const FAILURE_REASONS = [
  'INVALID_ACCOUNT',
  'ACCOUNT_CLOSED',
  'IFSC_ERROR',
  'BANK_REJECTED',
  'AMOUNT_FAILED',
];

export const FAILURE_REASON_LABELS = {
  INVALID_ACCOUNT: 'Invalid account',
  ACCOUNT_CLOSED: 'Account closed',
  IFSC_ERROR: 'IFSC error',
  BANK_REJECTED: 'Bank rejected',
  AMOUNT_FAILED: 'Amount failed',
};

// ── bank validation (§7) ───────────────────────────────────────────────────
//
// An employee with a broken bank record is EXCLUDED from the file and shown in
// the error report. We never emit a payment line we know the bank will bounce.

const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const isValidIfsc = (value) => IFSC_PATTERN.test(String(value || '').trim().toUpperCase());

export const BANK_VALIDATION_ERRORS = {
  MISSING_BANK_NAME: 'Bank name is missing on the payroll profile',
  MISSING_ACCOUNT_HOLDER: 'Account holder name is missing',
  MISSING_ACCOUNT_NUMBER: 'Bank account number is missing',
  INVALID_ACCOUNT_NUMBER: 'Bank account number could not be read',
  MISSING_IFSC: 'IFSC is missing',
  INVALID_IFSC: 'IFSC is not a valid 11-character code',
  INACTIVE_PAYROLL_PROFILE: 'Payroll profile is missing or not active',
  ZERO_NET_SALARY: 'Net salary is zero — nothing to pay',
  NEGATIVE_NET_SALARY: 'Net salary is negative — nothing to pay',
};

export const validateEmployeeForPayment = ({ employee = null, profile = null, result = null } = {}) => {
  const errors = [];

  if (!employee || employee.status !== 'ACTIVE') errors.push('INACTIVE_PAYROLL_PROFILE');
  if (!profile || (profile.payrollStatus && profile.payrollStatus !== 'ACTIVE')) {
    errors.push('INACTIVE_PAYROLL_PROFILE');
  }

  const bank = profile?.bank || {};
  if (!String(bank.bankName || '').trim()) errors.push('MISSING_BANK_NAME');
  if (!String(bank.accountHolderName || '').trim()) errors.push('MISSING_ACCOUNT_HOLDER');
  if (!String(bank.accountNumber || '').trim()) errors.push('MISSING_ACCOUNT_NUMBER');
  if (!String(bank.ifsc || '').trim()) errors.push('MISSING_IFSC');
  else if (!isValidIfsc(bank.ifsc)) errors.push('INVALID_IFSC');

  const net = Number(result?.totals?.netPay || 0);
  if (!result) errors.push('ZERO_NET_SALARY');
  else if (net < 0) errors.push('NEGATIVE_NET_SALARY');
  else if (net === 0) errors.push('ZERO_NET_SALARY');

  // One code can appear twice (no profile + no result) — keep it once.
  return [...new Set(errors)];
};

export const validationMessages = (errors = []) =>
  (errors || []).map((code) => ({ code, message: BANK_VALIDATION_ERRORS[code] || code }));

// ── numbers: batch number (§6) and payment reference (§11) ─────────────────

// SAL-2026-08-001 — unique inside one company.
export const buildBatchNumber = ({ month = '', sequence = 1 } = {}) =>
  `SAL-${month}-${String(Math.max(1, Number(sequence) || 1)).padStart(3, '0')}`;

// CREWLYSAL-2026-08-0001 — the prefix is configured in 29.1 Payroll Setup,
// one reference per employee transaction so finance can reconcile later.
export const DEFAULT_PAYMENT_REFERENCE_PREFIX = 'SAL';

export const sanitisePrefix = (value) => {
  const cleaned = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.slice(0, 20) || DEFAULT_PAYMENT_REFERENCE_PREFIX;
};

export const buildPaymentReference = ({ prefix = '', month = '', sequence = 1 } = {}) =>
  `${sanitisePrefix(prefix)}-${month}-${String(Math.max(1, Number(sequence) || 1)).padStart(4, '0')}`;

// ── KPIs and summaries (§6 / §17) ──────────────────────────────────────────

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

export const batchSummary = ({ payments = [], excluded = [] } = {}) => {
  const rows = payments || [];
  const paid = rows.filter((row) => row.status === 'PAID');
  const failed = rows.filter((row) => row.status === 'FAILED');
  const pending = rows.filter((row) => row.status === 'PENDING');

  return {
    totalEmployees: rows.length,
    totalNetSalary: money(rows.reduce((sum, row) => sum + Number(row.netSalary || 0), 0)),
    totalTransactions: rows.length,
    successfulTransactions: paid.length,
    failedTransactions: failed.length,
    pendingTransactions: pending.length,
    totalPaid: money(paid.reduce((sum, row) => sum + Number(row.netSalary || 0), 0)),
    excludedEmployees: (excluded || []).length,
  };
};

// §17 — the payment dashboard tracks money movement, never payroll calculation.
export const paymentKpis = ({ batches = [] } = {}) => {
  const rows = batches || [];
  const sum = (pick) => money(rows.reduce((total, batch) => total + Number(pick(batch) || 0), 0));

  const live = rows.filter((row) => !['CANCELLED'].includes(row.status));

  return {
    batches: rows.length,
    totalPayroll: sum((batch) => batch.summary?.totalNetSalary),
    paidEmployees: sum((batch) => batch.summary?.successfulTransactions),
    failedPayments: sum((batch) => batch.summary?.failedTransactions),
    pendingPayments: sum((batch) => batch.summary?.pendingTransactions),
    totalAmountPaid: sum((batch) => batch.summary?.totalPaid),
    // §17 — batches that still need a retry batch for their failures.
    retryRequired: live.filter(
      (batch) => Number(batch.summary?.failedTransactions || 0) > 0 && batch.status !== 'CANCELLED',
    ).length,
  };
};

// The status that follows from what finance just marked (§13 / §15).
export const statusAfterMarking = (summary = {}) => {
  const total = Number(summary.totalTransactions || 0);
  const paid = Number(summary.successfulTransactions || 0);
  const failed = Number(summary.failedTransactions || 0);

  if (total === 0) return 'DRAFT';
  if (paid === total) return 'PAID';
  if (failed === total) return 'FAILED';
  if (paid > 0 || failed > 0) return 'PARTIALLY_PAID';
  return 'PROCESSING';
};

// ── bank transfer file (§10) ───────────────────────────────────────────────

export const BANK_FILE_FORMATS = ['CSV', 'XLSX'];

export const BANK_FILE_COLUMNS = [
  'employeeCode',
  'employeeName',
  'accountHolderName',
  'accountNumber',
  'ifsc',
  'bankName',
  'netSalary',
  'paymentReference',
];

export const BANK_FILE_HEADERS = [
  'Employee ID',
  'Employee Name',
  'Account Holder',
  'Account Number',
  'IFSC',
  'Bank Name',
  'Net Salary',
  'Payment Reference',
];

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (headers = [], rows = []) =>
  [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n');

// ── minimal XLSX writer (dependency-free) ──────────────────────────────────
//
// An .xlsx file is a ZIP container of a handful of XML parts. Writing it by
// hand keeps the project dependency-free (the same call 29.5 and 29.7 made for
// Excel-shaped output) and stays well under a page of code. Cells use inline
// strings, so there is no shared-strings table to keep in sync.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
};

// ZIP with STORED entries (no compression): smaller code, and the payloads
// here are a few kilobytes.
const buildZip = (files = []) => {
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach(({ name, data }) => {
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBuffer, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(0, 10); // stored
    entry.writeUInt16LE(0, 12); // time
    entry.writeUInt16LE(0, 14); // date
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk number
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);

    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + size;
  });

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
};

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const columnName = (index) => {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
};

const sheetXml = (headers = [], rows = []) => {
  const headerCells = headers
    .map(
      (label, index) =>
        `<c r="${columnName(index)}1" t="inlineStr"><is><t>${escapeXml(label)}</t></is></c>`,
    )
    .join('');

  const body = rows
    .map((row, rowIndex) => {
      const cells = (row || [])
        .map((value, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowIndex + 2}`;
          if (value === '' || value === null || value === undefined) return '';
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${reference}"><v>${value}</v></c>`;
          }
          return `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 2}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${headerCells}</row>${body}</sheetData></worksheet>`;
};

export const buildXlsx = (headers = [], rows = []) =>
  buildZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Salary Payment" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'utf8',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(sheetXml(headers, rows), 'utf8'),
    },
  ]);

// The file is built from APPROVED payroll only, and only from employees who
// passed §7 validation — callers filter before they get here.
export const bankFileRows = ({ payments = [] } = {}) =>
  (payments || []).map((row) => [
    row.employeeCode || '',
    row.employeeName || '',
    row.accountHolderName || '',
    row.accountNumber || '',
    String(row.ifsc || '').toUpperCase(),
    row.bankName || '',
    money(row.netSalary),
    row.paymentReference || '',
  ]);

export const buildBankFile = ({ format = 'CSV', payments = [] } = {}) => {
  const rows = bankFileRows({ payments });
  const key = String(format || 'CSV').toUpperCase();

  if (key === 'XLSX') {
    return {
      format: 'XLSX',
      content: buildXlsx(BANK_FILE_HEADERS, rows),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
      rowCount: rows.length,
    };
  }

  return {
    format: 'CSV',
    content: toCsv(BANK_FILE_HEADERS, rows),
    mime: 'text/csv; charset=utf-8',
    extension: 'csv',
    rowCount: rows.length,
  };
};

// ── notification audience (§21) ────────────────────────────────────────────
//
// Same rule as 29.7: the audience is a PERMISSION, never a role name.
export const NOTIFICATION_AUDIENCE = {
  PAYMENT_BATCH_CREATED: ['PAYROLL_PAYMENT_CONFIRM', 'PAYROLL_PAYMENT_GENERATE'],
  PAYMENT_FILE_READY: ['PAYROLL_PAYMENT_GENERATE', 'PAYROLL_PAYMENT_READ'],
  PAYMENT_CONFIRMED: ['PAYROLL_PAYMENT_READ', 'PAYROLL_RUN_READ'],
  PAYMENT_FAILED: ['PAYROLL_PAYMENT_GENERATE', 'PAYROLL_PAYMENT_CONFIRM'],
  PAYMENT_RETRY_CREATED: ['PAYROLL_PAYMENT_CONFIRM', 'PAYROLL_PAYMENT_GENERATE'],
  PAYMENT_CANCELLED: ['PAYROLL_PAYMENT_READ', 'PAYROLL_PAYMENT_GENERATE'],
};

export const NOTIFICATION_COPY = {
  PAYMENT_BATCH_CREATED: 'Payment batch created',
  PAYMENT_FILE_READY: 'Bank transfer file is ready',
  PAYMENT_CONFIRMED: 'Salary payment confirmed',
  PAYMENT_FAILED: 'A salary payment failed',
  PAYMENT_RETRY_CREATED: 'Retry batch created for failed payments',
  PAYMENT_CANCELLED: 'Payment batch cancelled',
};

export const notificationCopy = (type, { batchNumber = '', month = '' } = {}) => {
  const base = NOTIFICATION_COPY[type] || 'Salary payment update';
  return `${base}${batchNumber ? ` · ${batchNumber}` : month ? ` · ${month}` : ''}`;
};

export const audiencePermissions = (type) => NOTIFICATION_AUDIENCE[type] || [];

export default {
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  EMPLOYEE_PAYMENT_STATUSES,
  FAILURE_REASONS,
  FAILURE_REASON_LABELS,
  BANK_FILE_FORMATS,
  BANK_FILE_COLUMNS,
  BANK_FILE_HEADERS,
  buildBankFile,
  buildBatchNumber,
  buildPaymentReference,
  batchSummary,
  paymentKpis,
  statusAfterMarking,
  validateEmployeeForPayment,
  validationMessages,
  isValidIfsc,
  canTransition,
  transitionError,
  isOpenBatch,
  audiencePermissions,
  notificationCopy,
};
