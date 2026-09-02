/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, FileText, Loader2, Search, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';

import Modal from '../../components/Modal.jsx';
import PayslipDocument, { downloadPayslipFile } from './PayslipDocument.jsx';
import payslipService from '../../services/payslipService.js';
import statutoryService from '../../services/statutoryService.js';
import fnfService from '../../services/fnfService.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 29.9 — Employee Salary Portal (§14 / §15 / §16)
//
// My Payroll → Payslips. Everything here is read-only and addressed to the
// signed-in employee: the employee id never leaves the server, because the
// backend reads it from the JWT (§3 / §26).
//
// §29: Salary paid → payslip generated → notification → this page → download.
// ───────────────────────────────────────────────────────────────────────────

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const STATUS_STYLES = {
  PENDING: 'bg-slate-500/15 text-slate-300',
  GENERATED: 'bg-emerald-500/15 text-emerald-300',
  EMAILED: 'bg-sky-500/15 text-sky-300',
  DOWNLOADED: 'bg-violet-500/15 text-violet-300',
  FAILED: 'bg-red-500/15 text-red-300',
};

const statusBadge = (status, label) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${STATUS_STYLES[status] || STATUS_STYLES.PENDING}`}>
    {label || status}
  </span>
);

// §15 — financial year and year filters, plus a month search.
const financialYearOf = (month, fyStartMonth = 4) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return '';
  const [year, part] = String(month).split('-').map(Number);
  const start = part >= fyStartMonth ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

// §17 — one read-only statutory field.
const Field = ({ label, value }) => (
  <div>
    <dt className="text-xs uppercase tracking-wide text-crewly-dim">{label}</dt>
    <dd className="mt-0.5 text-sm font-medium">{value || '—'}</dd>
  </div>
);

const MyPayslipsPortalPage = () => {
  const [rows, setRows] = useState([]);
  // §23 — the latest payslip is cached on its own and opens the page.
  const [recent, setRecent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState(null);

  const [search, setSearch] = useState('');
  const [financialYear, setFinancialYear] = useState('');
  const [year, setYear] = useState('');

  const [viewing, setViewing] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  // Phase 29.10 §17 — the employee's own statutory IDs, read-only.
  const [statutory, setStatutory] = useState(null);
  // Phase 29.11 §18 — the employee's own final settlement, if there is one.
  const [settlement, setSettlement] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await payslipService.mine();
      setRows(data?.payslips || []);
      setRecent(data?.recent || null);
      setError('');
    } catch (requestError) {
      setError(requestError?.message || 'Unable to load your payslips');
    } finally {
      setLoading(false);
    }
    // The statutory card is a bonus read, never a reason to fail the page.
    statutoryService
      .mine()
      .then((data) => setStatutory(data || null))
      .catch(() => setStatutory(null));
    // Phase 29.11 §18 — a leaving employee sees their F&F here too.
    fnfService
      .mine()
      .then((data) => setSettlement(data || null))
      .catch(() => setSettlement(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const financialYears = useMemo(
    () => [...new Set(rows.map((row) => financialYearOf(row.month)).filter(Boolean))].sort().reverse(),
    [rows],
  );
  const years = useMemo(
    () => [...new Set(rows.map((row) => String(row.month || '').slice(0, 4)).filter(Boolean))].sort().reverse(),
    [rows],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (financialYear && financialYearOf(row.month) !== financialYear) return false;
      if (year && String(row.month || '').slice(0, 4) !== year) return false;
      if (!needle) return true;
      return [row.monthLabel, row.month, row.payslipNumber]
        .map((value) => String(value || '').toLowerCase())
        .join(' ')
        .includes(needle);
    });
  }, [rows, search, financialYear, year]);

  const openPayslip = async (row) => {
    try {
      // §25 — opening the preview is the audited "viewed" action.
      const detail = await payslipService.mineDetail(row._id);
      setViewing(detail);
    } catch (requestError) {
      setBanner({ type: 'error', text: requestError?.message || 'Unable to open this payslip' });
    }
  };

  const download = async (row) => {
    setDownloadingId(row._id);
    try {
      await downloadPayslipFile({
        service: payslipService,
        payslipId: row._id,
        filename: `payslip-${row.month}.pdf`,
        isOwn: true,
      });
      await load();
    } catch (requestError) {
      setBanner({ type: 'error', text: requestError?.message || 'Unable to download this payslip' });
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">My Payslips</h1>
        <div className="card py-10 text-center text-crewly-dim">
          <Loader2 className="mx-auto animate-spin" size={18} /> Loading your payslips…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">My Payslips</h1>
        <p className="mt-1 text-sm text-crewly-dim">
          Your salary history. Payslips appear here once your salary for the month has been paid.
        </p>
      </div>

      {recent ? (
        <div className="card flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-crewly-dim">Latest payslip</p>
            <p className="mt-1 text-lg font-semibold">{recent.monthLabel || recent.month}</p>
            <p className="text-sm text-crewly-dim">
              Net {formatMoney(recent.net)} · Paid{' '}
              {formatDate(recent.paymentDate) !== '—' ? formatDate(recent.paymentDate) : 'on record'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {statusBadge(recent.status, recent.statusLabel)}
            <button
              className="btn-secondary"
              disabled={downloadingId === recent._id}
              onClick={() => openPayslip(recent)}
            >
              <FileText size={15} /> View
            </button>
            <button
              className="btn-primary"
              disabled={downloadingId === recent._id}
              onClick={() => download(recent)}
            >
              <Download size={15} /> Download PDF
            </button>
          </div>
        </div>
      ) : null}

      {banner ? (
        <div className="card border-l-4 border-red-500 text-sm text-red-200">{banner.text}</div>
      ) : null}
      {error ? (
        <div className="card border-l-4 border-red-500 text-sm text-red-200">{error}</div>
      ) : null}

      {/* §17 — statutory details, read-only (§17: employees cannot modify
          statutory IDs). */}
      {statutory ? (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Statutory details</h2>
            <span className="text-[11px] text-crewly-dim">
              Read-only · corrections go through your HR or Payroll Admin
            </span>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="PAN" value={statutory.pan} />
            <Field label="UAN" value={statutory.uan} />
            <Field label="ESI Number" value={statutory.esiNumber} />
            <Field label="PF Member" value={statutory.pfMember ? 'Yes' : 'No'} />
            <Field label="Professional Tax State" value={statutory.ptState} />
            <Field label="Tax Regime" value={statutory.taxRegime} />
            <Field label="Gratuity Eligible" value={statutory.gratuityEligible ? 'Yes' : 'No'} />
            <Field label="TDS Applicable" value={statutory.tdsApplicable ? 'Yes' : 'No'} />
          </dl>
          {statutory.current ? (
            <p className="text-xs text-crewly-dim">
              Deducted for {statutory.current.monthLabel}: PF {formatMoney(statutory.current.pf)} ·
              ESI {formatMoney(statutory.current.esi)} · PT {formatMoney(statutory.current.pt)} · TDS{' '}
              {formatMoney(statutory.current.tds)} · LWF {formatMoney(statutory.current.lwf)}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Phase 29.11 §18 — the employee's own settlement, read-only. The
          figures live on the dedicated page; this is only a pointer. */}
      {settlement ? (
        <div className="card flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Final Settlement</h2>
            <p className="mt-0.5 text-xs text-crewly-dim">
              {settlement.settlementNumber} · {settlement.statusLabel} · net{' '}
              {formatMoney(settlement.totals?.netSettlement)}
            </p>
          </div>
          <Link
            to="/app/payroll/my-final-settlement"
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Wallet size={15} /> View settlement
          </Link>
        </div>
      ) : null}

      {/* §15 — filters */}
      {rows.length > 0 ? (
        <div className="card flex flex-wrap items-end gap-3">
          <div className="min-w-[180px] flex-1">
            <label className="text-xs uppercase tracking-wide text-crewly-dim">Search month</label>
            <div className="mt-1 flex items-center gap-2">
              <Search size={15} className="text-crewly-dim" />
              <input
                className="input w-full"
                placeholder="August 2026, 2026-08…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-crewly-dim">Financial year</label>
            <select
              className="input mt-1"
              value={financialYear}
              onChange={(event) => setFinancialYear(event.target.value)}
            >
              <option value="">All</option>
              {financialYears.map((fy) => (
                <option key={fy} value={fy}>
                  FY {fy}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-crewly-dim">Year</label>
            <select className="input mt-1" value={year} onChange={(event) => setYear(event.target.value)}>
              <option value="">All</option>
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {/* §14 — month, gross, net, payment date, status, download */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
            <tr>
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2">Gross</th>
              <th className="px-3 py-2">Net</th>
              <th className="px-3 py-2">Payment Date</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Download</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-crewly-dim">
                  {rows.length === 0
                    ? 'No payslips yet — they appear here once your salary for the month has been paid.'
                    : 'No payslip matches these filters.'}
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row._id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-3 py-2">
                    <button className="font-medium text-indigo-300 hover:underline" onClick={() => openPayslip(row)}>
                      {row.monthLabel || row.month}
                    </button>
                    <p className="text-[10px] text-crewly-dim">{row.payslipNumber}</p>
                  </td>
                  <td className="px-3 py-2">{formatMoney(row.gross)}</td>
                  <td className="px-3 py-2 font-semibold text-emerald-300">{formatMoney(row.net)}</td>
                  <td className="px-3 py-2 text-xs">{formatDate(row.paymentDate)}</td>
                  <td className="px-3 py-2">
                    {statusBadge(row.status, row.statusLabel)}
                    {row.downloadCount ? (
                      <p className="mt-1 text-[10px] text-crewly-dim">
                        {row.downloadCount} download{row.downloadCount === 1 ? '' : 's'}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      className="text-sm text-indigo-300 hover:underline disabled:opacity-50"
                      disabled={downloadingId === row._id}
                      onClick={() => download(row)}
                    >
                      {downloadingId === row._id ? (
                        <Loader2 className="inline animate-spin" size={14} />
                      ) : (
                        <Download className="inline" size={14} />
                      )}{' '}
                      PDF
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-crewly-dim">
        Every payslip is a permanent record: values are frozen when it is generated and are never
        recalculated. Bank details are masked.
      </p>

      {/* §16 — preview before downloading */}
      {viewing ? (
        <Modal
          title={`Payslip — ${viewing.monthLabel || viewing.month}`}
          onClose={() => setViewing(null)}
          wide
        >
          {viewing.snapshot ? (
            <PayslipDocument
              snapshot={viewing.snapshot}
              downloading={downloadingId === viewing._id}
              onDownload={async () => {
                await download(viewing);
                setViewing(null);
              }}
            />
          ) : (
            <p className="flex items-center gap-2 text-sm text-crewly-dim">
              <AlertTriangle size={15} /> This payslip has no snapshot yet.
            </p>
          )}
        </Modal>
      ) : null}
    </div>
  );
};

export default MyPayslipsPortalPage;
