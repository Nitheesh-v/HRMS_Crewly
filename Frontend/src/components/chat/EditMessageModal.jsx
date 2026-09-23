// PHASE 33.8 — edit own message. Carries expectedEditVersion so a stale
// editor fails with CONFLICT_EDIT_VERSION instead of clobbering newer text.
import { useState } from 'react';
import { X } from 'lucide-react';

const TEXT_MAX = 4000;

const EditMessageModal = ({ message, onClose, onSubmit }) => {
  const [text, setText] = useState(message.text ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = text.trim();

    if (!trimmed) {
      setError('The edited text must not be empty.');
      return;
    }

    setBusy(true);
    setError('');
    const failure = await onSubmit(trimmed);
    setBusy(false);

    if (failure) {
      setError(failure);
      return;
    }

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card w-full max-w-md p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-crewly-text">Edit message</h3>
          <button type="button" className="text-crewly-dim hover:text-crewly-text" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="mb-2 text-xs text-crewly-red">{error}</p>}

        <textarea
          className="input min-h-[96px] w-full resize-none"
          maxLength={TEXT_MAX}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            disabled={busy}
            onClick={submit}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default EditMessageModal;
