// PHASE 33.10 — an attachment inside a message bubble.
//
// The button calls the AUTH-GATED download endpoint through the api client
// (Bearer token), receives the bytes as a blob and hands them to the browser.
// No provider URL, no storage key and no permanent link reaches this layer —
// a retry simply asks the API again, which re-checks membership each time.
import { useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';

import chatService from '../../services/chatService.js';

const formatBytes = (value) => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const AttachmentBubble = ({ attachment }) => {
  const [busy, setBusy] = useState(false);
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
    <div className="min-w-[180px]">
      <div className="flex items-center gap-2 rounded-lg border border-crewly-border bg-crewly-bg/40 px-2.5 py-2">
        <FileText className="h-4 w-4 shrink-0 text-crewly-dim" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-crewly-text" title={attachment.fileName}>
            {attachment.fileName}
          </p>
          <p className="text-[10px] text-crewly-dim">{formatBytes(attachment.sizeBytes)}</p>
        </div>
        <button
          type="button"
          title="Download file"
          onClick={download}
          disabled={busy}
          className="shrink-0 text-crewly-dim hover:text-crewly-green disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        </button>
      </div>
      {error && <p className="mt-1 text-[10px] text-crewly-red">{error}</p>}
    </div>
  );
};

export default AttachmentBubble;
