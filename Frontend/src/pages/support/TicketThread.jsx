// 🎫 Ticket conversation — Figma "130. Messages" bubble thread adapted to a
// single-pane ticket view: meta header, chat bubbles, rounded composer.
import { useState } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import { HR_STATUSES, PRIORITY_LABELS, categoryLabel, fmtTime, statusMeta } from './supportMeta';

const TicketThread = ({ ticket, isHR, meId, busy, onBack, onReply, onStatus }) => {
  const [reply, setReply] = useState('');
  const sm = statusMeta(ticket.status);

  const messages = [
    { key: 'root', by: ticket.user, message: ticket.message, createdAt: ticket.createdAt },
    ...(ticket.replies || []).map((r, i) => ({ key: `r${i}`, by: r.by, message: r.message, createdAt: r.createdAt })),
  ];

  const send = () => {
    if (!reply.trim() || busy) return;
    onReply(reply.trim());
    setReply('');
  };

  return (
    <div className="mx-auto max-w-3xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-crewly-dim transition hover:text-crewly-text">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />Back to tickets
      </button>

      {/* Meta header */}
      <div className="card mt-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-lg font-bold sm:text-xl">{ticket.subject}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-crewly-dim">
              <span className={`badge ${sm.badge}`}>{sm.label}</span>
              <span className="rounded-full border border-crewly-border px-2.5 py-0.5">{categoryLabel(ticket.category)}</span>
              <span className="rounded-full border border-crewly-border px-2.5 py-0.5">
                {PRIORITY_LABELS[ticket.priority] || 'Medium priority'}
              </span>
              <span>Raised {fmtTime(ticket.createdAt)}</span>
              {isHR && ticket.user?.name && <span>· by {ticket.user.name}</span>}
            </div>
          </div>
          {isHR && (
            <div className="flex flex-wrap gap-1.5">
              {HR_STATUSES.filter((s) => s !== ticket.status).map((s) => (
                <button
                  key={s}
                  disabled={busy}
                  onClick={() => onStatus(s)}
                  className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Mark {statusMeta(s).label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Conversation */}
      <div className="mt-4 space-y-3">
        {messages.map((m) => {
          const mine = String(m.by?._id || m.by) === String(meId);
          const name = mine ? 'You' : (m.by?.name || 'Support team');
          return (
            <div key={m.key} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-2xl border px-4 py-3 text-sm sm:max-w-[75%] ${
                  mine
                    ? 'rounded-br-sm border-crewly-green/25 bg-crewly-green/10'
                    : 'rounded-bl-sm border-crewly-border bg-crewly-card'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{m.message}</p>
                <p className="mt-1.5 text-[11px] text-crewly-dim">{name} · {fmtTime(m.createdAt)}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer — Figma rounded input + circular send */}
      <div className="card mt-4 flex items-center gap-2 p-2 sm:p-3">
        <input
          className="input flex-1 rounded-full"
          placeholder="Write a reply…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          aria-label="Write a reply"
        />
        <button
          onClick={send}
          disabled={!reply.trim() || busy}
          title="Send reply"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-crewly-green text-crewly-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default TicketThread;
