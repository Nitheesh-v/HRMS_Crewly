// PHASE 33.10 — composer attachment picker.
//
// Upload happens on SELECT (REST, multipart) so the send stays a fast socket
// message carrying ids; a failed upload never leaves a half-sent message.
// Pending files are shown as chips the sender can remove before sending.
// The caps are mirrored from the server for a fast message — the server is
// still the authority (utils/chatFileRules.js).
//
// UI pass: the picker accepts several files at once (they upload one after
// another, so a slow connection cannot half-fail the batch) and every failure
// names the file it belongs to.
import { useRef, useState } from 'react';
import { FileText, Loader2, Paperclip, X } from 'lucide-react';

import chatService from '../../services/chatService.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

const AttachmentPicker = ({ conversationId, pending, onAdd, onRemove, disabled }) => {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const remaining = MAX_FILES - pending.length;

  const pick = async (event) => {
    const files = Array.from(event.target.files ?? []);

    // Reset immediately so picking the same file twice still fires onChange.
    event.target.value = '';

    if (files.length === 0) return;

    if (remaining < 1) {
      setError(`A message can carry at most ${MAX_FILES} files.`);
      return;
    }

    const batch = files.slice(0, remaining);

    if (files.length > remaining) {
      setError(`Only ${remaining} more file${remaining === 1 ? '' : 's'} fit in this message.`);
    } else {
      setError('');
    }

    setBusy(true);

    try {
      for (const file of batch) {
        if (file.size > MAX_BYTES) {
          setError(`${file.name} is larger than 10 MB.`);
          continue;
        }

        try {
          const result = await chatService.uploadAttachment(conversationId, file);
          const attachment = result?.attachment;

          if (!attachment) {
            setError(`${file.name} could not be uploaded.`);
            continue;
          }

          onAdd(attachment);
        } catch (err) {
          // api.js normalizes every failure to { message, status, code, data } —
          // there is no `response` on the thrown error, so reading it showed a
          // generic sentence instead of the server's real reason (e.g. the size
          // cap or a locked conversation).
          const serverMessage = err?.data?.message || err?.message;

          setError(
            serverMessage ||
              (err?.status === 404
                ? 'You are not a member of this conversation.'
                : `${file.name} could not be uploaded.`)
          );
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {error && <p className="max-w-[16rem] text-[11px] text-crewly-red">{error}</p>}

      {pending.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1.5">
          {pending.map((attachment) => (
            <span
              key={attachment._id}
              className="flex items-center gap-1.5 rounded-lg border border-crewly-border bg-crewly-card py-1 pl-2 pr-1 text-[11px] text-crewly-text"
            >
              <FileText className="h-3 w-3 shrink-0 text-crewly-dim" aria-hidden="true" />
              <span className="max-w-[160px] truncate">{attachment.fileName}</span>
              <button
                type="button"
                title={`Remove ${attachment.fileName}`}
                aria-label={`Remove ${attachment.fileName}`}
                onClick={() => onRemove(attachment._id)}
                className="rounded p-0.5 text-crewly-dim transition hover:text-crewly-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-red/40"
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
        multiple
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        onChange={pick}
      />

      <button
        type="button"
        title={
          remaining < 1
            ? `At most ${MAX_FILES} files per message`
            : 'Attach files (PDF, JPG, PNG, WEBP · 10 MB each)'
        }
        aria-label="Attach files"
        disabled={disabled || busy || remaining < 1}
        onClick={() => inputRef.current?.click()}
        className="mb-5 rounded-lg p-2 text-crewly-dim transition hover:bg-crewly-border/40 hover:text-crewly-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Paperclip className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  );
};

export default AttachmentPicker;
