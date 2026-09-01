/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Printer } from 'lucide-react';

import payslipService, { saveBlob } from '../../services/payslipService.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 29.9 — the on-screen payslip (§16)
//
// A read-only rendering of the SAME frozen snapshot the PDF is drawn from, so
// what an employee previews and what they download can never disagree.
//
// §11 — employer contributions are shown as "Company Contributions" and are
// explicitly labelled as NOT reducing the net salary.
// §13 — bank details are masked; the full number exists nowhere on this page.
// ───────────────────────────────────────────────────────────────────────────

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const Field = ({ label, value }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide text-crewly-dim">{label}</p>
    <p className="text-sm font-medium">{value || '—'}</p>
  </div>
);

const LineTable = ({ title, subtitle, rows, totalLabel, total, tone = 'default' }) => {
  const tones = {
    default: 'text-crewly-text',
    good: 'text-emerald-300',
    bad: 'text-red-300',
  };

  return (
    <div className="rounded-lg border border-white/5">
      <div className="border-b border-white/5 px-3 py-2">
        <p className="text-sm font-semibold">{title}</p>
        {subtitle ? <p className="text-[11px] text-crewly-dim">{subtitle}</p> : null}
      </div>
      <table className="w-full text-left text-sm">
        <tbody>
          {(rows || []).length === 0 ? (
            <tr>
              <td className="px-3 py-3 text-xs text-crewly-dim">No components recorded</td>
            </tr>
          ) : (
            (rows || []).map((row, index) => (
              <tr key={`${row.name}-${index}`} className={index % 2 ? 'bg-white/5' : ''}>
                <td className="px-3 py-1.5">{row.name}</td>
                <td className="px-3 py-1.5 text-right">{formatMoney(row.amount)}</td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-white/10 font-semibold">
            <td className="px-3 py-2">{totalLabel}</td>
            <td className={`px-3 py-2 text-right ${tones[tone] || tones.default}`}>
              {formatMoney(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
};

const PayslipDocument = ({ snapshot, onDownload, downloading = false }) => {
  const printRef = useRef(null);
  const [localDownloading, setLocalDownloading] = useState(false);

  const company = snapshot?.company || {};
  const employee = snapshot?.employee || {};
  const payroll = snapshot?.payroll || {};
  const salary = snapshot?.salary || {};
  const attendance = snapshot?.attendance || {};
  const payment = snapshot?.payment || null;

  const earnings = useMemo(
    () => [...(snapshot?.earnings || []), ...(snapshot?.variableEarnings || [])],
    [snapshot],
  );

  // Printing the preview instead of the whole app (§16 "Print").
  useEffect(() => {
    if (!printRef.current) return undefined;
    const style = document.createElement('style');
    style.setAttribute('data-payslip-print', 'true');
    style.textContent = `
      @media print {
        body * { visibility: hidden; }
        [data-payslip-print-area], [data-payslip-print-area] * { visibility: visible; }
        [data-payslip-print-area] { position: absolute; left: 0; top: 0; width: 100%; }
      }
    `;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  const handleDownload = async () => {
    if (onDownload) {
      setLocalDownloading(true);
      try {
        await onDownload();
      } finally {
        setLocalDownloading(false);
      }
    }
  };

  const busy = downloading || localDownloading;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
        <button
          className="btn-secondary"
          disabled={busy || !onDownload}
          onClick={handleDownload}
        >
          <Download size={15} /> {busy ? 'Preparing…' : 'Download PDF'}
        </button>
        <button className="btn-secondary" onClick={() => window.print()}>
          <Printer size={15} /> Print
        </button>
      </div>

      <div ref={printRef} data-payslip-print-area className="space-y-4 rounded-lg bg-white p-6 text-slate-900">
        {/* §8 — header */}
        <div className="flex items-start justify-between border-b border-slate-200 pb-3">
          <div>
            <p className="text-lg font-bold uppercase tracking-wide text-slate-900">
              {company.name || 'Company'}
            </p>
            <p className="text-xs text-slate-500">{company.address || 'Address not set'}</p>
            <p className="text-xs text-slate-500">
              {[company.pan ? `PAN: ${company.pan}` : '', company.tan ? `TAN: ${company.tan}` : '']
                .filter(Boolean)
                .join('   ·   ')}
            </p>
          </div>
          <div className="text-right">
            <p className="text-base font-bold">Payslip — {payroll.monthLabel || payroll.month}</p>
            <p className="text-xs text-slate-500">Cycle: {payroll.cycle || 'MONTHLY'}</p>
            <p className="text-xs text-slate-500">Payslip No: {payroll.payslipNumber || '—'}</p>
          </div>
        </div>

        {/* §8 — employee details */}
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-5">
          <Field label="Employee ID" value={employee.employeeCode || employee.employeeId} />
          <Field label="Name" value={employee.name} />
          <Field label="Department" value={employee.department} />
          <Field label="Designation" value={employee.designation} />
          <Field label="Joining Date" value={formatDate(employee.joiningDate)} />
          <Field label="UAN" value={employee.uan} />
          <Field label="PAN" value={employee.pan} />
          <Field label="Bank" value={payment?.bankName || employee.bankName} />
          {/* §13 / §26 — masked, always */}
          <Field label="Account" value={payment?.accountNumberMasked || employee.accountNumberMasked} />
          <Field label="Payment Mode" value={payment?.method || 'Bank Transfer'} />
        </div>

        {/* §12 — attendance */}
        <div className="grid grid-cols-5 gap-2">
          {[
            ['Working Days', attendance.workingDays],
            ['Present Days', attendance.presentDays],
            ['Paid Days', attendance.paidDays],
            ['LOP', attendance.lopDays],
            ['OT Hours', attendance.overtimeHours],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-slate-50 p-2 text-center">
              <p className="text-[10px] uppercase text-slate-500">{label}</p>
              <p className="text-sm font-semibold">{value ?? '—'}</p>
            </div>
          ))}
        </div>

        {/* §9 / §10 — earnings and deductions, never merged */}
        <div className="grid gap-3 md:grid-cols-2">
          <LineTable
            title="Earnings"
            subtitle="Every earning component, shown separately"
            rows={earnings}
            totalLabel="Total Earnings"
            total={salary.totalEarnings}
            tone="good"
          />
          <LineTable
            title="Deductions"
            subtitle="Why money was deducted from your salary"
            rows={snapshot?.deductions || []}
            totalLabel="Total Deductions"
            total={salary.totalDeductions}
            tone="bad"
          />
        </div>

        {(snapshot?.reimbursements || []).length ? (
          <LineTable
            title="Reimbursements"
            subtitle="Claimed and approved outside the salary structure"
            rows={snapshot.reimbursements}
            totalLabel="Total Reimbursements"
            total={salary.totalReimbursements}
          />
        ) : null}

        {/* §11 — company contributions */}
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-indigo-900">Company Contributions</p>
              <p className="text-[11px] text-indigo-700">
                Paid by the employer on top of your salary — these do NOT reduce your Net Pay.
              </p>
            </div>
            <p className="text-sm font-semibold text-indigo-900">
              {formatMoney(salary.totalEmployerContributions)}
            </p>
          </div>
          {(snapshot?.employerContributions || []).length ? (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-indigo-800">
              {snapshot.employerContributions.map((row, index) => (
                <span key={`${row.name}-${index}`}>
                  {row.name}: {formatMoney(row.amount)}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* §8 — salary summary */}
        <div className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3">
          <div>
            <p className="text-[10px] uppercase text-slate-500">Gross Salary</p>
            <p className="text-lg font-semibold">{formatMoney(salary.grossSalary)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-slate-500">Total Deductions</p>
            <p className="text-lg font-semibold">- {formatMoney(salary.totalDeductions)}</p>
          </div>
          <div className="rounded-lg bg-emerald-100 p-2">
            <p className="text-[10px] uppercase text-emerald-700">Net Salary</p>
            <p className="text-lg font-bold text-emerald-800">{formatMoney(salary.netSalary)}</p>
          </div>
        </div>

        {/* §13 — payment information */}
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4">
          <Field label="Payment Date" value={formatDate(payment?.paymentDate || payroll.paymentDate)} />
          <Field label="Payment Mode" value={payment?.method || 'Bank Transfer'} />
          <Field label="Payment Reference" value={payment?.reference} />
          <Field label="Payslip Number" value={payroll.payslipNumber} />
        </div>

        {/* §8 — footer: no manual signatures */}
        <p className="border-t border-slate-200 pt-2 text-center text-[10px] text-slate-400">
          Payslip {payroll.payslipNumber || ''} · Generated {formatDate(snapshot?.generatedAt)} ·
          System generated — no signature required
        </p>
      </div>
    </div>
  );
};

// Used by both the admin preview and the employee portal: one download path,
// so the filename always comes from the server.
export const downloadPayslipFile = async ({ service, payslipId, filename, isOwn = false }) => {
  const blob = isOwn ? await service.downloadMine(payslipId) : await service.download(payslipId);
  saveBlob(blob, filename || `payslip-${payslipId}.pdf`);
};

export default PayslipDocument;
