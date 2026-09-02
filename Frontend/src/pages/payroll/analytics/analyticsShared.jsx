import { useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  Inbox,
  Loader2,
  RefreshCcw,
  ShieldAlert,
} from 'lucide-react';

import usePermission from '../../../hooks/usePermission.js';
import payrollAnalyticsService, { saveBlob } from '../../../services/payrollAnalyticsService.js';

import { PERIOD_PRESETS, monthLabel } from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 29.12 — the components the ten analytics pages share.
//
// Everything here exists so the pages stay about their own report:
//   · the month switcher and the §18 filter bar behave identically everywhere
//   · every report exports to CSV / XLSX / PDF the same way (§19)
//   · a report nobody may see is refused by the server, and the page says so
//     rather than rendering an empty table (§25)
// ───────────────────────────────────────────────────────────────────────────

export const KpiCard = ({ icon: Icon, label, value, hint = '', tone = 'default', to = null }) => {
  const tones = {
    default: 'text-crewly-text',
    good: 'text-emerald-300',
    bad: 'text-red-300',
    warn: 'text-amber-300',
    info: 'text-sky-300',
  };
  const body = (
    <div className="card h-full p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-crewly-dim">{label}</span>
        {Icon ? <Icon size={15} className="text-crewly-dim" /> : null}
      </div>
      <p className={`mt-2 text-xl font-semibold ${tones[tone] || tones.default}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-crewly-dim">{hint}</p> : null}
    </div>
  );
  if (!to) return body;
  return (
    <button type="button" onClick={() => { window.location.href = to; }} className="text-left">
      {body}
    </button>
  );
};

export const SectionCard = ({ title, subtitle, actions = null, children, className = '' }) => (
  <section className={`card p-4 ${className}`}>
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-crewly-text">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-xs text-crewly-dim">{subtitle}</p> : null}
      </div>
      {actions}
    </div>
    {children}
  </section>
);

export const EmptyState = ({ message = 'Nothing to report for this month', icon: Icon = Inbox }) => (
  <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
    <Icon size={26} className="text-crewly-dim" />
    <p className="text-sm text-crewly-dim">{message}</p>
  </div>
);

export const Banner = ({ type = 'info', text, onClose = null }) => {
  if (!text) return null;
  const tones = {
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    error: 'border-red-500/30 bg-red-500/10 text-red-200',
    info: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  };
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tones[type] || tones.info}`}>
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <span className="flex-1">{text}</span>
      {onClose ? (
        <button type="button" onClick={onClose} className="text-xs opacity-70 hover:opacity-100">Dismiss</button>
      ) : null}
    </div>
  );
};

export const DataTable = ({ headers = [], rows = [], empty = 'Nothing to report for this month', footer = null }) => {
  if (!rows.length) return <EmptyState message={empty} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wide text-crewly-dim">
          <tr>
            {headers.map((header, index) => (
              <th
                key={header.key || header.label || index}
                className={`whitespace-nowrap py-2 pr-3 ${header.align === 'right' ? 'text-right' : ''}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.key || rowIndex} className="border-t border-white/5">
              {headers.map((header, index) => (
                <td
                  key={header.key || header.label || index}
                  className={`py-2 pr-3 ${header.align === 'right' ? 'text-right tabular-nums' : ''} ${
                    header.strong ? 'font-medium' : ''
                  }`}
                >
                  {header.render ? header.render(row, rowIndex) : row[header.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr className="border-t border-white/10 text-xs uppercase tracking-wide text-crewly-dim">
              {footer.map((cell, index) => (
                <td
                  key={index}
                  className={`py-2 pr-3 ${cell?.align === 'right' ? 'text-right tabular-nums' : ''} ${
                    cell?.strong ? 'font-semibold text-crewly-text' : ''
                  }`}
                >
                  {cell?.value ?? ''}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
};

// §18 — the same filter row on every report: month, department, designation
// and payment status, plus whatever the page adds (period, financial year).
export const FilterBar = ({
  month,
  months,
  onMonthChange,
  departments,
  departmentId,
  onDepartmentChange,
  designations = [],
  designation,
  onDesignationChange,
  status,
  onStatusChange,
  children,
}) => (
  <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
    <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
      Payroll month
      <select
        className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
        value={month}
        onChange={(event) => onMonthChange(event.target.value)}
      >
        {months.length ? (
          months.map((value) => (
            <option key={value} value={value}>{monthLabel(value)}</option>
          ))
        ) : (
          <option value={month}>{monthLabel(month)}</option>
        )}
      </select>
    </label>

    <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
      Department
      <select
        className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
        value={departmentId}
        onChange={(event) => onDepartmentChange(event.target.value)}
      >
        <option value="">All departments</option>
        {departments.map((department) => (
          <option key={department._id} value={department._id}>{department.name}</option>
        ))}
      </select>
    </label>

    {designations.length ? (
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
        Designation
        <select
          className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
          value={designation}
          onChange={(event) => onDesignationChange(event.target.value)}
        >
          <option value="">All designations</option>
          {designations.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </label>
    ) : null}

    {onStatusChange ? (
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
        Payment status
        <select
          className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
          value={status}
          onChange={(event) => onStatusChange(event.target.value)}
        >
          <option value="">Any status</option>
          <option value="PAID">Paid</option>
          <option value="PENDING">Pending</option>
          <option value="FAILED">Failed</option>
          <option value="NOT_IN_BATCH">Not in batch</option>
        </select>
      </label>
    ) : null}

    <div className="ml-auto flex items-end gap-2">{children}</div>
  </div>
);

// §19 — every report, in every format. The filename comes back from the
// server so the browser saves what Finance expects to find.
export const ExportMenu = ({ reportKey, filters = {}, disabled = false, onQueued = null }) => {
  const { hasPermission } = usePermission();
  const canExport = hasPermission('PAYROLL_REPORT_EXPORT');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');

  if (!canExport) return null;

  const download = async (format, queued) => {
    setBusy(format);
    setOpen(false);
    try {
      if (queued) {
        const result = await payrollAnalyticsService.requestExport({ reportKey, format, ...filters });
        onQueued?.(result, format);
      } else {
        const blob = await payrollAnalyticsService.exportReport({ reportKey, format, ...filters });
        saveBlob(blob, `${String(reportKey).toLowerCase()}-${filters.month || 'report'}.${format.toLowerCase()}`);
        onQueued?.(null, format);
      }
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled || Boolean(busy)}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-crewly-text hover:bg-white/5 disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        Export
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-white/10 bg-[#12141c] shadow-lg">
          {[
            { format: 'CSV', icon: FileText, label: 'CSV' },
            { format: 'XLSX', icon: FileSpreadsheet, label: 'Excel' },
            { format: 'PDF', icon: FileText, label: 'PDF' },
          ].map(({ format, icon: Icon, label }) => (
            <button
              key={format}
              type="button"
              onClick={() => download(format, false)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
            >
              <Icon size={14} className="text-crewly-dim" />
              Download {label}
            </button>
          ))}
          <div className="border-t border-white/5" />
          <button
            type="button"
            onClick={() => download('XLSX', true)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
          >
            <RefreshCcw size={14} className="text-crewly-dim" />
            Queue large export
          </button>
        </div>
      ) : null}
    </div>
  );
};

export const PageHeader = ({ icon: Icon, title, subtitle, actions = null }) => (
  <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div className="flex items-start gap-3">
      {Icon ? (
        <span className="mt-0.5 rounded-lg border border-white/10 bg-white/5 p-2 text-crewly-dim">
          <Icon size={18} />
        </span>
      ) : null}
      <div>
        <h1 className="text-lg font-semibold text-crewly-text">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-crewly-dim">{subtitle}</p> : null}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2">{actions}</div>
  </header>
);

// ── 29.13 §4 — the period switcher ─────────────────────────────────────────
//
// One control for "which months is this?": a preset, or a custom range. The
// custom range is two month pickers, because "April 2026 to March 2027" is a
// financial year to an Indian finance team and nobody should have to count.
export const PeriodSelect = ({
  preset,
  onPresetChange,
  fromMonth = '',
  toMonth = '',
  onFromMonthChange,
  onToMonthChange,
  months = [],
}) => {
  const options = months.length ? months : [fromMonth, toMonth].filter(Boolean);
  const custom = preset === 'CUSTOM';

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
        Period
        <select
          className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
          value={preset}
          onChange={(event) => onPresetChange(event.target.value)}
        >
          {PERIOD_PRESETS.map((entry) => (
            <option key={entry.key} value={entry.key}>{entry.label}</option>
          ))}
        </select>
      </label>

      {custom ? (
        <>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            From
            <input
              type="month"
              value={fromMonth}
              onChange={(event) => onFromMonthChange(event.target.value)}
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            To
            <input
              type="month"
              value={toMonth}
              onChange={(event) => onToMonthChange(event.target.value)}
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
            />
          </label>
        </>
      ) : null}

      {custom && !options.length ? (
        <p className="pb-1.5 text-xs text-crewly-dim">Type the two months — empty is fine.</p>
      ) : null}
    </div>
  );
};

// ── 29.13 §22 — the register pages and searches ────────────────────────────
//
// Five thousand employees is a spreadsheet, not a web page: the server slices
// it and this walks the slices. The total beside the buttons stays the WHOLE
// period, so paging never looks like the payroll shrank.
export const Pagination = ({ pagination, onPageChange }) => {
  if (!pagination || !pagination.pages || pagination.pages <= 1) return null;
  const { page = 1, pages = 1, total = 0 } = pagination;

  return (
    <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/5 pt-3 text-xs text-crewly-dim">
      <span>
        {Number(total).toLocaleString('en-IN')} row(s) · page {page} of {pages}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md border border-white/10 px-2 py-1 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md border border-white/10 px-2 py-1 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
};

// Searching matches PEOPLE — code, name, department, designation. The server
// refuses to search amounts, and the placeholder says so, because the obvious
// thing to type into a payroll search box is a salary.
export const SearchBox = ({ value, onChange, placeholder = 'Search by employee, code, department…' }) => (
  <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
    Search
    <input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-56 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
    />
  </label>
);

// §25 — a report the server refused. The server is the gate; this only makes
// the refusal legible instead of showing an empty table.
export const AccessDenied = ({ message = 'You do not have access to payroll analytics.' }) => (
  <div className="card flex items-center gap-3 p-6">
    <ShieldAlert size={22} className="text-amber-300" />
    <div>
      <p className="text-sm font-medium text-crewly-text">{message}</p>
      <p className="mt-1 text-xs text-crewly-dim">
        Ask a Company Admin for payroll report access (§4 — employees never see payroll analytics).
      </p>
    </div>
  </div>
);
