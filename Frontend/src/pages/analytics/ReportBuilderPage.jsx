// Report Builder — pick a module, tick fields, set filters, generate.
// Then export the SAME result as CSV / Excel, or print to PDF.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import analyticsService from '../../services/analyticsService';

const inp = 'rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500';
const primary = 'rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const ghost = 'rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm text-slate-200';
const PRESETS = [['this_month', 'This month'], ['prev_month', 'Prev month'], ['this_quarter', 'This quarter'], ['this_year', 'This year'], ['custom', 'Custom range']];

export default function ReportBuilderPage() {
  const [modules, setModules] = useState([]);   // what the backend says we may report on
  const [module, setModuleKey] = useState('');  // currently chosen module key
  const [fields, setFields] = useState([]);     // ticked columns
  const [preset, setPreset] = useState('this_month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const flash = (message) => { setToast(message); setTimeout(() => setToast(''), 3500); };

  // chosen module's full definition (fields list etc.)
  const currentModule = modules.find((m) => m.key === module);

  // STEP 1: on page load, get the list of modules + their fields
  useEffect(() => {
    analyticsService.builderMeta()
      .then((d) => {
        const list = d.modules || [];
        setModules(list);
        if (list.length) {
          setModuleKey(list[0].key);
          setFields(list[0].fields.map((f) => f.key)); // all fields ticked by default
        }
      })
      .catch((e) => flash(e?.response?.data?.message || e.message));
  }, []);

  // when the module changes, re-tick its default fields
  const pickModule = (key) => {
    const def = modules.find((m) => m.key === key);
    setModuleKey(key);
    setFields(def ? def.fields.map((f) => f.key) : []);
    setResult(null);
  };

  const toggleField = (key) => {
    setFields(fields.includes(key) ? fields.filter((f) => f !== key) : [...fields, key]);
  };

  // the payload both run + export share (same query → same data → same RBAC)
  const buildPayload = (pageNumber) => {
    return {
      module,
      fields,
      preset,
      from: from || undefined,
      to: to || undefined,
      filters: { status: status || undefined },
      page: pageNumber,
      pageSize: 25,
    };
  };

  const run = async (pageNumber) => {
    setBusy(true);
    setPage(pageNumber);
    try {
      const d = await analyticsService.runReport(buildPayload(pageNumber));
      setResult(d);
    } catch (e) {
      flash(e?.response?.data?.message || e.message);
    }
    setBusy(false);
  };

  const download = async (format) => {
    try {
      const blobOrText = await analyticsService.exportReport(buildPayload(1), format);
      const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText]);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${module}-report.${format === 'xls' ? 'xls' : 'csv'}`;
      link.click();
      URL.revokeObjectURL(link.href);
      flash(`Exported ${format.toUpperCase()} ✔ (logged in audit)`);
    } catch (e) {
      flash(e?.response?.data?.message || 'Export failed');
    }
  };

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <div className="p-6 space-y-5 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">📑 Report Builder</h1>
          <p className="text-sm text-slate-400">Module → fields → filters → generate → export · every run is audited</p>
        </div>
        <Link to="/app/analytics" className={ghost}>📊 Analytics</Link>
      </div>

      {toast && <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2 text-sm text-indigo-200">{toast}</div>}

      {/* configuration card */}
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Module</label>
            <select className={inp} value={module} onChange={(e) => pickModule(e.target.value)}>
              {modules.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Date range</label>
            <select className={inp} value={preset} onChange={(e) => setPreset(e.target.value)}>
              {PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {preset === 'custom' && (
            <>
              <div><label className="mb-1 block text-xs text-slate-400">From</label><input type="date" className={inp} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div><label className="mb-1 block text-xs text-slate-400">To</label><input type="date" className={inp} value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </>
          )}
          <div>
            <label className="mb-1 block text-xs text-slate-400">Status filter (optional)</label>
            <input className={inp} placeholder="APPROVED / ACTIVE…" value={status} onChange={(e) => setStatus(e.target.value)} />
          </div>
          <div className="ml-auto flex gap-2">
            <button className={primary} disabled={busy || !module} onClick={() => run(1)}>{busy ? 'Running…' : '▶ Generate'}</button>
            <button className={ghost} disabled={!result} onClick={() => download('csv')}>⬇ CSV</button>
            <button className={ghost} disabled={!result} onClick={() => download('xls')}>⬇ Excel</button>
            <button className={ghost} disabled={!result} onClick={() => window.print()}>🖨 PDF / Print</button>
          </div>
        </div>

        {/* field picker = simple toggle chips */}
        {currentModule && (
          <div>
            <label className="mb-1 block text-xs text-slate-400">Fields to include</label>
            <div className="flex flex-wrap gap-2">
              {currentModule.fields.map((f) => {
                const isOn = fields.includes(f.key);
                return (
                  <button type="button" key={f.key} onClick={() => toggleField(f.key)}
                    className={isOn ? 'rounded-full bg-indigo-600/70 px-3 py-1 text-xs text-white' : 'rounded-full border border-slate-600 px-3 py-1 text-xs text-slate-400'}>
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* result table */}
      {result && (
        <div className="rounded-xl border border-slate-700 bg-slate-900 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2 text-xs text-slate-400">
            <span>{result.total} records · {result.from} → {result.to}</span>
            <span className="flex items-center gap-2">
              <button className={ghost} disabled={page <= 1} onClick={() => run(page - 1)}>← Prev</button>
              Page {page}/{totalPages}
              <button className={ghost} disabled={page >= totalPages} onClick={() => run(page + 1)}>Next →</button>
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs uppercase text-slate-400">
                  {result.columns.map((c) => <th key={c.key} className="px-4 py-2">{c.label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {result.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-800/40">
                    {result.columns.map((c) => <td key={c.key} className="px-4 py-2 text-slate-200">{row[c.key] ?? '—'}</td>)}
                  </tr>
                ))}
                {!result.rows.length && (
                  <tr><td colSpan={result.columns.length} className="px-4 py-8 text-center text-slate-500">No records match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}