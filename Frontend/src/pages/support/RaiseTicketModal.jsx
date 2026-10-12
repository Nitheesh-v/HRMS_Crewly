// 🎫 Raise-a-ticket modal — Figma "New Request" form pattern in Crewly styling
import { useState } from 'react';
import Modal from '../../components/Modal';
import { DEPARTMENTS } from './supportMeta';

const OPTIONS = [
  ...DEPARTMENTS.map(({ code, label }) => ({ code, label })),
  { code: 'LEAVE', label: 'Leave & Attendance' },
];

const RaiseTicketModal = ({ defaultCategory = 'IT', busy, onClose, onSubmit }) => {
  const [form, setForm] = useState({ subject: '', category: defaultCategory, message: '' });
  const valid = form.subject.trim() && form.message.trim();

  return (
    <Modal onClose={onClose} title="Raise a Ticket">
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="ticket-subject">Subject *</label>
          <input
            id="ticket-subject"
            className="input"
            autoFocus
            placeholder="e.g. PF amount wrong in June payslip"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="ticket-dept">Department</label>
          <select
            id="ticket-dept"
            className="input"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            {OPTIONS.map((o) => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ticket-message">Describe the issue *</label>
          <textarea
            id="ticket-message"
            className="input"
            rows="4"
            placeholder="What happened? What did you expect instead?"
            value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value })}
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t border-crewly-border pt-3">
        <button className="btn-ghost px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
        <button
          className="btn-primary px-5 py-2 text-sm"
          disabled={busy || !valid}
          onClick={() => onSubmit({ subject: form.subject.trim(), category: form.category, message: form.message.trim() })}
        >
          {busy ? 'Raising…' : 'Raise ticket'}
        </button>
      </div>
    </Modal>
  );
};

export default RaiseTicketModal;
