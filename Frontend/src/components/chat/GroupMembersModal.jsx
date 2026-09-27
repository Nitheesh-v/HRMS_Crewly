// PHASE 34.6 — who is in this group, and how to change it.
//
// ONE panel for the whole membership surface: the current members (with their
// role), a filter, a picker for adding people we are not in the group with yet,
// and the way out ("Leave group").
//
// The server owns every rule — only an in-group ADMIN may add or remove
// others, a group keeps at least two members and at least one admin, adding is
// capped, and only same-company ACTIVE users can be added. This panel therefore
// does NOT re-implement them: it hides the controls an actor cannot use (so
// nobody is invited to click a button that will be refused) and shows the
// server's own words when it does refuse.
import { useEffect, useMemo, useState } from 'react';
import { Search, UserMinus, UserPlus, X } from 'lucide-react';

import Avatar from './Avatar.jsx';

const labelOf = (member) =>
  member?.user?.name || member?.user?.email || 'Unknown user';

const GroupMembersModal = ({
  conversation,
  users = [],
  meId,
  busy = false,
  error = '',
  onClose,
  onAdd,
  onRemove,
  onLeave,
}) => {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const members = useMemo(() => conversation?.members ?? [], [conversation]);

  const me = members.find((member) => String(member.userId) === String(meId));

  const isAdmin = me?.role === 'ADMIN';

  const memberIds = useMemo(
    () => new Set(members.map((member) => String(member.userId))),
    [members]
  );

  // Candidates come from the SAME directory source the New-conversation modal
  // uses (the active people this reader can already see) minus everybody who is
  // already in the group. There is no directory endpoint of its own.
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return users
      .filter((user) => {
        const id = String(user._id ?? user.id);

        if (memberIds.has(id)) return false;
        if (!needle) return true;

        return `${user.name ?? ''} ${user.email ?? ''}`.toLowerCase().includes(needle);
      })
      .slice(0, 50);
  }, [users, memberIds, query]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const togglePick = (id) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );

  const submitAdd = async () => {
    if (picked.length === 0 || busy) return;

    const failure = await onAdd(picked);

    if (!failure) setPicked([]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="card flex max-h-[85vh] w-full max-w-md flex-col p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Group members"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-crewly-text">
            Members <span className="text-crewly-dim">({members.length})</span>
          </h3>
          <button
            type="button"
            aria-label="Close"
            className="rounded p-1 text-crewly-dim transition hover:text-crewly-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <p role="alert" className="mb-2 text-xs text-crewly-red">
            {error}
          </p>
        )}

        {/* ── who is here ── */}
        <ul className="chat-scroll mb-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-crewly-border">
          {members.map((member) => {
            const isMe = String(member.userId) === String(meId);
            const admin = member.role === 'ADMIN';

            return (
              <li
                key={String(member.userId)}
                className="flex items-center gap-2 border-b border-crewly-border/60 px-3 py-2 last:border-b-0"
              >
                <Avatar name={labelOf(member)} seed={labelOf(member)} size="sm" />

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-semibold text-crewly-text">
                      {labelOf(member)}
                    </span>
                    {isMe && (
                      <span className="shrink-0 rounded border border-crewly-green/50 px-1 text-[10px] font-semibold text-crewly-green">
                        You
                      </span>
                    )}
                    {admin && (
                      <span className="shrink-0 rounded border border-crewly-border px-1 text-[10px] font-semibold text-crewly-dim">
                        Admin
                      </span>
                    )}
                  </span>
                </span>

                {/* Removing OTHERS is an admin action. Removing yourself is
                    "Leave group", below — one path, not two spellings of it. */}
                {isAdmin && !isMe && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRemove(member)}
                    aria-label={`Remove ${labelOf(member)}`}
                    title={`Remove ${labelOf(member)}`}
                    className="shrink-0 rounded p-1 text-crewly-dim transition hover:text-crewly-red disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-red/40"
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {/* ── who could be added ── */}
        {isAdmin ? (
          <div className="min-h-0">
            <div className="relative mb-2">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim"
                aria-hidden="true"
              />
              <input
                className="input w-full pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Add people"
                aria-label="Add people"
                maxLength={80}
              />
            </div>

            {picked.length > 0 && (
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] text-crewly-dim">{picked.length} selected</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={submitAdd}
                  className="rounded-lg bg-crewly-green/15 px-2.5 py-1 text-[11px] font-semibold text-crewly-green disabled:opacity-50"
                >
                  {busy ? 'Adding…' : 'Add to group'}
                </button>
              </div>
            )}

            {candidates.length > 0 ? (
              <ul className="chat-scroll max-h-40 overflow-y-auto rounded-xl border border-crewly-border">
                {candidates.map((user) => {
                  const id = String(user._id ?? user.id);
                  const selected = picked.includes(id);

                  return (
                    <li key={id} className="border-b border-crewly-border/60 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => togglePick(id)}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition ${
                          selected ? 'bg-crewly-green/10' : 'hover:bg-crewly-card'
                        }`}
                      >
                        <Avatar name={user.name} seed={user.name} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-xs text-crewly-text">
                          {user.name || user.email || 'Unknown user'}
                        </span>
                        <UserPlus
                          className={`h-3.5 w-3.5 shrink-0 ${
                            selected ? 'text-crewly-green' : 'text-crewly-dim'
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[11px] text-crewly-dim">
                {query.trim()
                  ? 'Nobody visible matches that name.'
                  : 'Everyone visible is already in this group.'}
              </p>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-crewly-dim">
            Only group admins can add or remove other members.
          </p>
        )}

        {/* ── leaving is available to everyone, admin included ── */}
        <div className="mt-3 flex items-center justify-between border-t border-crewly-border pt-3">
          <p className="pr-2 text-[11px] text-crewly-dim">
            Leaving removes you from the group; the conversation disappears from your list.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => (confirmLeave ? onLeave() : setConfirmLeave(true))}
            className="shrink-0 rounded-lg border border-crewly-red/50 px-2.5 py-1 text-[11px] font-semibold text-crewly-red transition hover:bg-crewly-red/10 disabled:opacity-50"
          >
            {confirmLeave ? 'Confirm leave' : 'Leave group'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GroupMembersModal;
