import { useEffect, useMemo, useState } from 'react';
import payrollService from '../../services/payrollService.js';
import userService from '../../services/userService.js';
import Modal from '../../components/Modal.jsx';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const emptyStruct = { basic: '', hra: '', allowances: '', pfPercent: 12, professionalTax: 0 };

const PayrollPage = () => {
  const [tab, setTab] = useState('run');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [payroll, setPayroll] = useState({ rows: [] });
  const [users, setUsers] = useState([]);
  const [structures, setStructures] = useState([]);
  const [editing, setEditing] = useState(null); // { user, form }
  const [genResult, setGenResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadRun = () => payrollService.list(month).then(setPayroll).catch((e) => setError(e.message));
  const loadStructures = () => {
    userService.getAll({ limit: 200 }).then((res) => setUsers(res.data)).catch(() => {});
    payrollService.structures().then(setStructures).catch(() => {});
  };

  useEffect(() => { if (tab === 'run') loadRun(); }, [tab, month]);
  useEffect(() => { if (tab === 'structures') loadStructures(); }, [tab]);

  const structMap = useMemo(() => {
    const m = {};
    structures.forEach((s) => { m[String(s.user?._id)] = s; });
    return m;
  }, [structures]);

  const runGenerate = async () => {
    setError(''); setGenResult(null); setBusy(true);
    try {
      const res = await payrollService.generate(month);
      setGenResult(res);
      loadRun();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const payNow = async (row) => {
    setError('');
    try { await payrollService.markPaid(row._id); loadRun(); }
    catch (err) { setError(err.message); }
  };

  const saveStructure = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await payrollService.setStructure(editing.user._id, {
        basic: Number(editing.form.basic || 0),
        hra: Number(editing.form.hra || 0),
        allowances: Number(editing.form.allowances || 0),
        pfPercent: Number(editing.form.pfPercent || 0),
        professionalTax: Number(editing.form.professionalTax || 0),
      });
      setEditing(null);
      loadStructures();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const openEdit = (u) => {
    const s = structMap[String(u._id)];
    setEditing({
      user: u,
      form: s ? { basic: s.basic, hra: s.hra, allowances: s.allowances, pfPercent: s.pfPercent, professionalTax: s.professionalTax } : emptyStruct,
    });
  };

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">💰 Payroll</h1>

      {error && <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}
      {genResult && (
        <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
          ✅ Generated for {genResult.generated.length} employee(s)
          {genResult.skipped.length > 0 && (
            <span className="text-crewly-orange"> · Skipped: {genResult.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}</span>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {[['run', '🧾 Payroll Run'], ['structures', '⚙️ Salary Structures']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`rounded-lg px-4 py-2 text-sm transition ${tab === key ? 'bg-crewly-green/15 text-crewly-green' : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ===== TAB: PAYROLL RUN ===== */}
      {tab === 'run' && (
        <>
          <div className="card flex flex-wrap items-end gap-3">
            <div>
              <label className="label">Month</label>
              <input type="month" className="input" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
            <button className="btn-primary" onClick={runGenerate} disabled={busy}>
              {busy ? 'Generating…' : '⚙️ Generate Payroll'}
            </button>
            <span className="pb-2 text-xs text-crewly-dim">Uses attendance + approved leaves for LOP deductions. Safe to re-run (PAID records are locked).</span>
          </div>

          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-crewly-dim">
                  <th className="px-5 py-3">Employee</th>
                  <th className="px-5 py-3">Gross</th>
                  <th className="px-5 py-3">PF</th>
                  <th className="px-5 py-3">Tax</th>
                  <th className="px-5 py-3">LOP</th>
                  <th className="px-5 py-3">Net Pay</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
           {(payroll.rows || []).map((r) => (
                  <tr key={r._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-medium">{r.user?.name}</div>
                      <div className="text-xs text-crewly-dim">{r.absentDays} LOP day(s)</div>
                    </td>
                    <td className="px-5 py-3">{money(r.earnings.gross)}</td>
                    <td className="px-5 py-3 text-crewly-red">{money(r.deductions.pf)}</td>
                    <td className="px-5 py-3 text-crewly-red">{money(r.deductions.professionalTax)}</td>
                    <td className="px-5 py-3 text-crewly-red">{money(r.deductions.attendanceDeduction)}</td>
                    <td className="px-5 py-3 font-semibold text-crewly-green">{money(r.netPay)}</td>
                    <td className="px-5 py-3">
                      <span className={`badge ${r.status === 'PAID' ? 'bg-crewly-green/15 text-crewly-green' : 'bg-crewly-orange/15 text-crewly-orange'}`}>{r.status}</span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button className="btn-ghost px-3 py-1 text-xs" onClick={() => payrollService.openPayslip(r._id)}>Payslip</button>
                      {r.status !== 'PAID' && (
                        <button className="ml-2 rounded-lg border border-crewly-green/40 px-3 py-1 text-xs text-crewly-green hover:bg-crewly-green/10"
                          onClick={() => payNow(r)}>Mark Paid</button>
                      )}
                    </td>
                  </tr>
                ))}
              {(payroll.rows || []).length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-8 text-center text-crewly-dim">No payroll for {month} yet — click Generate.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ===== TAB: STRUCTURES ===== */}
      {tab === 'structures' && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-crewly-border text-crewly-dim">
                <th className="px-5 py-3">Employee</th>
                <th className="px-5 py-3">Basic</th>
                <th className="px-5 py-3">HRA</th>
                <th className="px-5 py-3">Allowances</th>
                <th className="px-5 py-3">PF %</th>
                <th className="px-5 py-3">Gross</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const s = structMap[String(u._id)];
                const gross = s ? s.basic + s.hra + s.allowances : 0;
                return (
                  <tr key={u._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-medium">{u.name}</div>
                      <div className="text-xs text-crewly-dim">{u.role.replace('_', ' ')}</div>
                    </td>
                    <td className="px-5 py-3">{s ? money(s.basic) : '—'}</td>
                    <td className="px-5 py-3">{s ? money(s.hra) : '—'}</td>
                    <td className="px-5 py-3">{s ? money(s.allowances) : '—'}</td>
                    <td className="px-5 py-3">{s ? `${s.pfPercent}%` : '—'}</td>
                    <td className="px-5 py-3 font-medium">{s ? money(gross) : <span className="text-crewly-orange text-xs">not set</span>}</td>
                    <td className="px-5 py-3 text-right">
                      <button className="btn-ghost px-3 py-1 text-xs" onClick={() => openEdit(u)}>{s ? 'Edit' : '+ Set Salary'}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* STRUCTURE MODAL */}
      {editing && (
        <Modal title={`Salary: ${editing.user.name}`} onClose={() => setEditing(null)}>
          <form onSubmit={saveStructure} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div><label className="label">Basic (₹/mo)</label>
                <input type="number" min="0" className="input" value={editing.form.basic} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, basic: e.target.value } })} required /></div>
              <div><label className="label">HRA (₹/mo)</label>
                <input type="number" min="0" className="input" value={editing.form.hra} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, hra: e.target.value } })} /></div>
              <div><label className="label">Allowances (₹/mo)</label>
                <input type="number" min="0" className="input" value={editing.form.allowances} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, allowances: e.target.value } })} /></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="label">PF % of Basic (0 = off)</label>
                <input type="number" min="0" max="12" className="input" value={editing.form.pfPercent} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, pfPercent: e.target.value } })} /></div>
              <div><label className="label">Professional Tax (₹/mo)</label>
                <input type="number" min="0" className="input" value={editing.form.professionalTax} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, professionalTax: e.target.value } })} /></div>
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Saving…' : 'Save Structure'}</button>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default PayrollPage;