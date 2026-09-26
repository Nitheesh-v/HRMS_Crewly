// PHASE 33.8 — edit own message. Carries expectedEditVersion so a stale
// editor fails with CONFLICT_EDIT_VERSION instead of clobbering newer text.
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

const TEXT_MAX = 4000;

const EditMessageModal = ({ message, onClose, onSubmit }) => {
  const [text, setText] = useState(message.text ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  // Escape closes — the reflex every dialog should honour.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    boxRef.current?.focus();
    boxRef.current?.setSelectionRange(text.length, text.length);
    // Focus once on open — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-md p-4" role="dialog" aria-modal="true" aria-label="Edit message">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-crewly-text">Edit message</h3>
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

        <textarea
          ref={boxRef}
          className="input max-h-64 min-h-[96px] w-full resize-y"
          maxLength={TEXT_MAX}
          value={text}
          aria-label="Message text"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="mt-1 flex items-center justify-between text-[10px] text-crewly-dim">
          <span className="hidden sm:block">Ctrl/⌘ + Enter to save</span>
          <span className="tabular-nums">
            {text.length}/{TEXT_MAX}
          </span>
        </div>

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
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EditMessageModal;
