// PHASE 33.8 — start a DIRECT or GROUP conversation (33.3 create contract).
// UI pass: a segmented type switch, a member filter (the directory can hold
// hundreds of people) and a Create button that says why it is disabled.
import { useEffect, useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';

import Avatar from './Avatar.jsx';

const labelOf = (user) => user?.name || user?.fullName || user?.email || 'Unknown user';

const NewConversationModal = ({ users, meId, onClose, onCreate }) => {
  const [type, setType] = useState('DIRECT');
  const [targetUserId, setTargetUserId] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const others = useMemo(
    () => users.filter((user) => String(user._id ?? user.id) !== String(meId)),
    [users, meId]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) return others;

    return others.filter((user) => labelOf(user).toLowerCase().includes(needle));
  }, [others, query]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const togglePick = (id) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    );

  const canCreate =
    type === 'DIRECT' ? Boolean(targetUserId) : name.trim().length > 0 && picked.length > 0;

  const submit = async () => {
    if (!canCreate || busy) return;

    setBusy(true);
    setError('');

    const payload =
      type === 'DIRECT'
        ? { type, targetUserId }
        : { type, name: name.trim(), memberUserIds: picked };

    const result = await onCreate(payload);
    setBusy(false);

    if (typeof result === 'string') {
      setError(result);
      return;
    }

    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-md p-4" role="dialog" aria-modal="true" aria-label="New conversation">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-crewly-text">New conversation</h3>
          <button
            type="button"
            aria-label="Close"
            className="rounded p-1 text-crewly-dim transition hover:text-crewly-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Segmented switch: two choices, one control. */}
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl border border-crewly-border p-1">
          {['DIRECT', 'GROUP'].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={type === value}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                type === value
                  ? 'bg-crewly-green/15 text-crewly-green'
                  : 'text-crewly-dim hover:text-crewly-text'
              }`}
              onClick={() => setType(value)}
            >
              {value === 'DIRECT' ? 'Direct message' : 'Group'}
            </button>
          ))}
        </div>

        {error && (
          <p role="alert" className="mb-2 text-xs text-crewly-red">
            {error}
          </p>
        )}

        {type === 'DIRECT' ? (
          <div>
            <label className="label" htmlFor="direct-target">
              Person
            </label>
            <select
              id="direct-target"
              className="input w-full"
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              autoFocus
            >
              <option value="">Select a person</option>
              {others.map((user) => (
                <option key={user._id ?? user.id} value={user._id ?? user.id}>
                  {labelOf(user)}
                </option>
              ))}
            </select>
            {others.length === 0 && (
              <p className="mt-2 text-[11px] text-crewly-dim">
                No other active people are visible to you right now.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="group-name">
                Group name
              </label>
              <input
                id="group-name"
                className="input w-full"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Design team"
                autoFocus
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <label className="label mb-0" htmlFor="member-filter">
                  Members
                </label>
                <span className="text-[11px] text-crewly-dim">
                  {picked.length > 0 ? `${picked.length} selected` : 'None selected'}
                </span>
              </div>

              <div className="relative mb-2">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim"
                  aria-hidden="true"
                />
                <input
                  id="member-filter"
                  className="input py-2 pl-9 text-sm"
                  placeholder="Filter people"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              <div className="chat-scroll max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-crewly-border p-1">
                {visible.map((user) => {
                  const id = String(user._id ?? user.id);
                  const selected = picked.includes(id);

                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => togglePick(id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                        selected
                          ? 'bg-crewly-green/10 text-crewly-text'
                          : 'text-crewly-text hover:bg-crewly-card'
                      }`}
                    >
                      <Avatar name={labelOf(user)} seed={id} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{labelOf(user)}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-crewly-green" />}
                    </button>
                  );
                })}

                {visible.length === 0 && (
                  <p className="px-2 py-3 text-center text-xs text-crewly-dim">
                    Nobody matches that filter.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            disabled={busy || !canCreate}
            onClick={submit}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewConversationModal;
