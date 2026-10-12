// 🎫 Raise-a-ticket modal — Figma modal language: panel sheet, 13px dim
// labels, inset inputs, green primary action (34/35 New Request pattern).
import { useState } from 'react';
import { X } from 'lucide-react';
import { DEPARTMENTS, HD } from './supportMeta';

const OPTIONS = [
  ...DEPARTMENTS.map(({ code, label }) => ({ code, label })),
  { code: 'LEAVE', label: 'Leave & Attendance' },
];

const fieldCls = 'w-full rounded-lg border px-4 py-3 text-sm outline-none transition';
const fieldStyle = { borderColor: HD.border, backgroundColor: HD.panel2, color: HD.text };

const RaiseTicketModal = ({ defaultCategory = 'IT', busy, onClose, onSubmit }) => {
  const [form, setForm] = useState({ subject: '', category: defaultCategory, message: '' });
  const valid = form.subject.trim() && form.message.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-xl p-6"
        style={{ backgroundColor: HD.panel }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold" style={{ color: HD.text }}>Raise a Ticket</h2>
          <button onClick={onClose} title="Close" className="transition hover:brightness-125" style={{ color: HD.dim }}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-[13px]" style={{ color: HD.dim }} htmlFor="ticket-subject">Subject *</label>
            <input
              id="ticket-subject"
              className={fieldCls}
              style={fieldStyle}
              autoFocus
              placeholder="e.g. PF amount wrong in June payslip"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-2 block text-[13px]" style={{ color: HD.dim }} htmlFor="ticket-dept">Department</label>
            <select
              id="ticket-dept"
              className={fieldCls}
              style={fieldStyle}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-2 block text-[13px]" style={{ color: HD.dim }} htmlFor="ticket-message">Describe the issue *</label>
            <textarea
              id="ticket-message"
              className={fieldCls}
              style={fieldStyle}
              rows="4"
              placeholder="What happened? What did you expect instead?"
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t pt-4" style={{ borderColor: HD.divider }}>
          <button className="rounded-lg px-5 py-2.5 text-sm transition hover:brightness-125" style={{ color: HD.dim }} onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded-lg px-6 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: HD.green }}
            disabled={busy || !valid}
            onClick={() => onSubmit({ subject: form.subject.trim(), category: form.category, message: form.message.trim() })}
          >
            {busy ? 'Raising…' : 'Raise ticket'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RaiseTicketModal;
