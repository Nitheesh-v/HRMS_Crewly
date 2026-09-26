// PHASE 33.10 — composer attachment picker.
//
// Upload happens on SELECT (REST, multipart) so the send stays a fast socket
// message carrying ids; a failed upload never leaves a half-sent message.
// Pending files are shown as chips the sender can remove before sending.
// The caps are mirrored from the server for a fast message — the server is
// still the authority (utils/chatFileRules.js).
import { useRef, useState } from 'react';
import { Loader2, Paperclip, X } from 'lucide-react';

import chatService from '../../services/chatService.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

const AttachmentPicker = ({ conversationId, pending, onAdd, onRemove, disabled }) => {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const remaining = MAX_FILES - pending.length;

  const pick = async (event) => {
    const file = event.target.files?.[0];

    // Reset immediately so picking the same file twice still fires onChange.
    event.target.value = '';

    if (!file) return;

    if (file.size > MAX_BYTES) {
      setError('File must be 10 MB or smaller.');
      return;
    }

    if (remaining < 1) {
      setError(`A message can carry at most ${MAX_FILES} files.`);
      return;
    }

    setError('');
    setBusy(true);

    try {
      const result = await chatService.uploadAttachment(conversationId, file);
      const attachment = result?.attachment;

      if (!attachment) {
        setError('The file could not be uploaded.');
        return;
      }

      onAdd(attachment);
    } catch (err) {
      setError(
        err?.response?.data?.message ||
          (err?.response?.status === 404
            ? 'You are not a member of this conversation.'
            : 'The file could not be uploaded.')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {error && <p className="text-[11px] text-crewly-red">{error}</p>}

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pending.map((attachment) => (
            <span
              key={attachment._id}
              className="flex items-center gap-1.5 rounded border border-crewly-border bg-crewly-card px-2 py-1 text-[11px] text-crewly-text"
            >
              <span className="max-w-[180px] truncate">{attachment.fileName}</span>
              <button
                type="button"
                title="Remove file"
                onClick={() => onRemove(attachment._id)}
                className="text-crewly-dim hover:text-crewly-red"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        onChange={pick}
      />

      <button
        type="button"
        title="Attach a file"
        disabled={disabled || busy || remaining < 1}
        onClick={() => inputRef.current?.click()}
        className="text-crewly-dim hover:text-crewly-green disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
      </button>
    </div>
  );
};

export default AttachmentPicker;
