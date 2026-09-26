// PHASE 33.10 — an attachment inside a message bubble.
//
// The button calls the AUTH-GATED download endpoint through the api client
// (Bearer token), receives the bytes as a blob and hands them to the browser.
// No provider URL, no storage key and no permanent link reaches this layer —
// a retry simply asks the API again, which re-checks membership each time.
import { useState } from 'react';
import { Check, Download, FileText, Loader2 } from 'lucide-react';

import chatService from '../../services/chatService.js';

const formatBytes = (value) => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const AttachmentBubble = ({ attachment }) => {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    if (busy) return;

    setBusy(true);
    setError('');

    try {
      const blob = await chatService.downloadAttachment(attachment.attachmentId);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download = attachment.fileName || 'attachment';
      document.body.appendChild(link);
      link.click();
      link.remove();

      // Release the object URL once the download has been handed off.
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      setDone(true);
      window.setTimeout(() => setDone(false), 2500);
    } catch (err) {
      setError(
        err?.response?.data?.message ||
          (err?.response?.status === 404
            ? 'This file is no longer available.'
            : 'The file could not be downloaded.')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-[190px]">
      <div className="flex items-center gap-2.5 rounded-xl border border-crewly-border bg-crewly-bg/50 px-3 py-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crewly-border/40 text-crewly-dim">
          <FileText className="h-4 w-4" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-crewly-text" title={attachment.fileName}>
            {attachment.fileName}
          </p>
          <p className="text-[10px] text-crewly-dim">{formatBytes(attachment.sizeBytes)}</p>
        </div>

        <button
          type="button"
          title="Download file"
          aria-label={`Download ${attachment.fileName || 'attachment'}`}
          onClick={download}
          disabled={busy}
          className="shrink-0 rounded-lg p-1.5 text-crewly-dim transition hover:bg-crewly-border/40 hover:text-crewly-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : done ? (
            <Check className="h-4 w-4 text-crewly-green" aria-hidden="true" />
          ) : (
            <Download className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {error && <p className="mt-1 text-[10px] text-crewly-red">{error}</p>}
    </div>
  );
};

export default AttachmentBubble;
