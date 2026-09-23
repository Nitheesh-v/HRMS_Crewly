// PHASE 33.8 — start a DIRECT or GROUP conversation (33.3 create contract).
import { useState } from 'react';
import { X } from 'lucide-react';

const NewConversationModal = ({ users, meId, onClose, onCreate }) => {
  const [type, setType] = useState('DIRECT');
  const [targetUserId, setTargetUserId] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const others = users.filter((user) => String(user._id) !== String(meId));

  const togglePick = (id) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    );

  const submit = async () => {
    setBusy(true);
    setError('');

    const payload =
      type === 'DIRECT'
        ? { type, targetUserId }
        : { type, name, memberUserIds: picked };

    const result = await onCreate(payload);
    setBusy(false);

    if (typeof result === 'string') {
      setError(result);
      return;
    }

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card w-full max-w-md p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-crewly-text">New conversation</h3>
          <button type="button" className="text-crewly-dim hover:text-crewly-text" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-3 flex gap-2">
          {['DIRECT', 'GROUP'].map((value) => (
            <button
              key={value}
              type="button"
              className={`btn-ghost px-3 py-1.5 text-xs ${type === value ? 'border-crewly-green text-crewly-green' : ''}`}
              onClick={() => setType(value)}
            >
              {value === 'DIRECT' ? 'Direct message' : 'Group'}
            </button>
          ))}
        </div>

        {error && <p className="mb-2 text-xs text-crewly-red">{error}</p>}

        {type === 'DIRECT' ? (
          <div>
            <label className="label">Person</label>
            <select className="input w-full" value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}>
              <option value="">Select a person</option>
              {others.map((user) => (
                <option key={user._id} value={user._id}>
                  {user.name || user.email}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="label">Group name</label>
              <input
                className="input w-full"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Members</label>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-crewly-border p-2">
                {others.map((user) => (
                  <label key={user._id} className="flex items-center gap-2 text-sm text-crewly-text">
                    <input
                      type="checkbox"
                      checked={picked.includes(String(user._id))}
                      onChange={() => togglePick(String(user._id))}
                    />
                    {user.name || user.email}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary px-4 py-2 text-sm" disabled={busy} onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewConversationModal;
