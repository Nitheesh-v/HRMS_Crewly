import { useEffect, useState } from 'react';
import payrollService from '../../services/payrollService.js';
import Modal from '../../components/Modal.jsx';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

const MyPayslipsPage = () => {
  const [rows, setRows] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    payrollService.my().then(setRows).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">🧾 My Payslips</h1>

      {error && <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((r) => (
          <div key={r._id} className="card">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-semibold">{monthLabel(r.month)}</div>
                <div className="mt-1 text-2xl font-bold text-crewly-green">{money(r.netPay)}</div>
                <div className="mt-1 text-xs text-crewly-dim">
                  Gross {money(r.earnings.gross)} − Deductions {money(r.deductions.total)}
                </div>
              </div>
              <span className={`badge ${r.status === 'PAID' ? 'bg-crewly-green/15 text-crewly-green' : 'bg-crewly-orange/15 text-crewly-orange'}`}>{r.status}</span>
            </div>
            <div className="mt-4 flex gap-2">
              <button className="btn-ghost flex-1 py-2 text-sm" onClick={() => setViewing(r)}>View Breakdown</button>
              <button className="btn-primary flex-1 py-2 text-sm" onClick={() => payrollService.openPayslip(r._id)}>⬇ Download</button>
            </div>
          </div>
        ))}
      </div>
      {rows.length === 0 && !error && (
        <div className="card py-10 text-center text-crewly-dim">No payslips yet — they appear after HR runs payroll.</div>
      )}

      {/* BREAKDOWN MODAL */}
      {viewing && (
        <Modal title={`Payslip — ${monthLabel(viewing.month)}`} onClose={() => setViewing(null)}>
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-4 gap-2 text-center text-xs text-crewly-dim">
              <div className="rounded-lg bg-crewly-bg p-2">Working<br /><span className="text-crewly-text">{viewing.workingDays}</span></div>
              <div className="rounded-lg bg-crewly-bg p-2">Present<br /><span className="text-crewly-green">{viewing.presentDays}</span></div>
              <div className="rounded-lg bg-crewly-bg p-2">Paid Leave<br /><span className="text-crewly-text">{viewing.paidLeaveDays}</span></div>
              <div className="rounded-lg bg-crewly-bg p-2">LOP<br /><span className="text-crewly-red">{viewing.absentDays}</span></div>
            </div>
            <div>
              <div className="mb-1 font-semibold text-crewly-dim">Earnings</div>
              {[['Basic', viewing.earnings.basic], ['HRA', viewing.earnings.hra], ['Allowances', viewing.earnings.allowances]].map(([l, v]) => (
                <div key={l} className="flex justify-between border-b border-crewly-border/50 py-1.5"><span>{l}</span><span>{money(v)}</span></div>
              ))}
              <div className="flex justify-between py-1.5 font-medium"><span>Gross</span><span>{money(viewing.earnings.gross)}</span></div>
            </div>
            <div>
              <div className="mb-1 font-semibold text-crewly-dim">Deductions</div>
              {[['Provident Fund', viewing.deductions.pf], ['Professional Tax', viewing.deductions.professionalTax], [`Attendance / LOP (${viewing.absentDays}d)`, viewing.deductions.attendanceDeduction]].map(([l, v]) => (
                <div key={l} className="flex justify-between border-b border-crewly-border/50 py-1.5 text-crewly-red"><span>{l}</span><span>-{money(v)}</span></div>
              ))}
            </div>
            <div className="flex justify-between rounded-lg bg-crewly-green/10 px-4 py-3 text-lg font-bold text-crewly-green">
              <span>NET PAY</span><span>{money(viewing.netPay)}</span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default MyPayslipsPage;