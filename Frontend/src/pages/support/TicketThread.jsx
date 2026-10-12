// 🎫 Ticket conversation — Figma fidelity: "135" breadcrumb + inset meta
// card, "130 Messages" bubbles (near-white sent / grey-blue received,
// meta line with time + read ticks under the bubble) and pane composer
// with circular green action.
import { useState } from 'react';
import { CheckCheck, ChevronRight, Send } from 'lucide-react';
import { HD, HR_STATUSES, PRIORITY_LABELS, categoryLabel, fmtTime, statusMeta } from './supportMeta';

const TicketThread = ({ ticket, listLabel, isHR, meId, busy, onBack, onReply, onStatus }) => {
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
    <div>
      {/* Breadcrumb — 135 pattern */}
      <button onClick={onBack} className="flex max-w-full items-center gap-1.5 text-[13px] transition hover:brightness-125" style={{ color: HD.dim }}>
        Help Center<ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate" style={{ color: HD.text }}>{listLabel}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate" style={{ color: HD.text }}>{ticket.subject}</span>
      </button>

      {/* Meta card with inset bordered box (135 "Customer Contact Support") */}
      <div className="mt-4 rounded-xl p-5 sm:p-6" style={{ backgroundColor: HD.panel }}>
        <div className="rounded-lg border p-5 sm:p-6" style={{ borderColor: HD.border }}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="break-words text-lg font-bold" style={{ color: HD.text }}>{ticket.subject}</h1>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" style={{ color: HD.dim }}>
                <span className={`rounded-full px-3 py-1 font-semibold ${sm.badge}`}>{sm.label}</span>
                <span className="rounded-full border px-3 py-1" style={{ borderColor: HD.border }}>{categoryLabel(ticket.category)}</span>
                <span className="rounded-full border px-3 py-1" style={{ borderColor: HD.border }}>
                  {PRIORITY_LABELS[ticket.priority] || 'Medium priority'}
                </span>
                <span>Raised {fmtTime(ticket.createdAt)}</span>
                {isHR && ticket.user?.name && <span>· by {ticket.user.name}</span>}
              </div>
            </div>
            {isHR && (
              <div className="flex flex-wrap gap-2">
                {HR_STATUSES.filter((s) => s !== ticket.status).map((s) => (
                  <button
                    key={s}
                    disabled={busy}
                    onClick={() => onStatus(s)}
                    className="rounded-lg border px-3 py-1.5 text-xs transition hover:brightness-125 disabled:opacity-50"
                    style={{ borderColor: HD.border, color: HD.dim }}
                  >
                    Mark {statusMeta(s).label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Conversation — 130 bubble language */}
      <div className="mt-6 space-y-4">
        {messages.map((m) => {
          const mine = String(m.by?._id || m.by) === String(meId);
          const name = mine ? 'You' : (m.by?.name || 'Support team');
          return (
            <div key={m.key} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
              <div
                className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed sm:max-w-[65%]"
                style={mine
                  ? { backgroundColor: HD.sent, color: HD.sentInk, borderBottomRightRadius: 6 }
                  : { backgroundColor: HD.recv, color: HD.recvInk, borderBottomLeftRadius: 6 }}
              >
                <p className="whitespace-pre-wrap break-words">{m.message}</p>
              </div>
              <p className="mt-1.5 flex items-center gap-1 text-[11px]" style={{ color: HD.dim }}>
                {name} · {fmtTime(m.createdAt)}
                {mine && <CheckCheck className="h-3.5 w-3.5" style={{ color: HD.green }} aria-hidden="true" />}
              </p>
            </div>
          );
        })}
      </div>

      {/* Composer pane — circular green action like 130 */}
      <div className="mt-6 flex items-center gap-3 rounded-xl p-3" style={{ backgroundColor: HD.panel }}>
        <input
          className="h-10 flex-1 bg-transparent px-2 text-sm outline-none"
          style={{ color: HD.text }}
          placeholder="Write message here…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          aria-label="Write a reply"
        />
        <button
          onClick={send}
          disabled={!reply.trim() || busy}
          title="Send reply"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ backgroundColor: HD.green }}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default TicketThread;
