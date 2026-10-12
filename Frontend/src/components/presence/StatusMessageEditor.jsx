// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.2 — STATUS MESSAGE EDITOR
//
//  Plain textarea + a small character counter. Bounded client-side to
//  the backend limit (160 chars, Phase 37 §14 / presenceConfig). The
//  message is rendered as plain text — no HTML, no markdown.
//
//  The component is presentational; it does NOT call the service. The
//  parent menu owns the dispatch and the layout (37.2 §35: "Keep
//  business authority in backend/services").
// ═══════════════════════════════════════════════════════════════════════════

import { useId } from 'react';

export const STATUS_MESSAGE_MAX = 160;

export default function StatusMessageEditor({
  value,
  onChange,
  disabled = false,
  placeholder = 'Client call until 3 PM, focus time, etc.',
}) {
  const id = useId();
  const len = typeof value === 'string' ? value.length : 0;

  return (
    <div className="space-y-1.5" data-testid="status-message-editor">
      <label
        htmlFor={id}
        className="block text-xs font-medium text-crewly-dim"
      >
        Status message
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={STATUS_MESSAGE_MAX}
        rows={2}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full resize-none rounded-md border border-crewly-border bg-crewly-bg px-3 py-2 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-1 focus:ring-crewly-green disabled:opacity-50"
      />
      <div
        className={`flex items-center justify-between text-[11px] ${
          len >= STATUS_MESSAGE_MAX ? 'text-amber-600' : 'text-crewly-dim'
        }`}
      >
        <span className="sr-only">Character limit</span>
        <span>{len} / {STATUS_MESSAGE_MAX}</span>
        {len >= STATUS_MESSAGE_MAX ? (
          <span>Maximum reached</span>
        ) : null}
      </div>
    </div>
  );
}