// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.2 — STATUS EXPIRY SELECTOR
//
//  Three pre-canned options + a "Custom" datetime-local picker, plus
//  "Until cleared" (= no expiry). Submits an ISO string compatible
//  with the 37.1 validator's EXPIRY_MAX_DAYS (7 days).
//
//  The backend remains authoritative — the picker is a UX accelerator,
//  not a bypass. If the client clock drifts past the chosen expiry by
//  the time the request arrives, the server returns EXPIRY_IN_PAST.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useId } from 'react';

const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const PRESETS = [
  { id: 'none', label: 'Until cleared' },
  { id: '30m', label: '30 minutes' },
  { id: '1h', label: '1 hour' },
  { id: '4h', label: '4 hours' },
  { id: 'today', label: 'Today' },
  { id: 'custom', label: 'Custom' },
];

const toIsoFromPreset = (id) => {
  if (id === 'none') return undefined; // no expiry
  if (id === '30m') return new Date(Date.now() + 30 * 60 * 1000).toISOString();
  if (id === '1h') return new Date(Date.now() + ONE_HOUR_MS).toISOString();
  if (id === '4h') return new Date(Date.now() + FOUR_HOURS_MS).toISOString();
  if (id === 'today') {
    // end-of-local-today
    const d = new Date();
    d.setHours(23, 59, 0, 0);
    return d.toISOString();
  }
  return undefined;
};

const toLocalInputFromIso = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fromLocalInput = (value) => {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
};

function StatusExpirySelector({ onChange }) {
  // The current preset is derived from the controlled `value` prop. The
  // preset is local UI state for the duration of the popover; the parent
  // owns the authoritative `value`. We do NOT mirror `value` into state.
  const [presetOverride, setPresetOverride] = useState(null);
  const [customLocal, setCustomLocal] = useState('');

  const preset = presetOverride || 'none';
  const groupId = useId();

  const handlePresetChange = (next) => {
    setPresetOverride(next);
    if (next === 'custom') {
      onChange(fromLocalInput(customLocal));
      return;
    }
    onChange(toIsoFromPreset(next));
  };

  const handleCustomChange = (v) => {
    setCustomLocal(v);
    onChange(fromLocalInput(v));
  };

  return (
    <div className="space-y-2" data-testid="status-expiry-selector">
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Expiry</legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Expiry">
          {PRESETS.map((p) => (
            <label
              key={p.id}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
                preset === p.id
                  ? 'border-crewly-green bg-crewly-green/10 text-crewly-green'
                  : 'border-crewly-border bg-crewly-bg text-crewly-text hover:border-crewly-green/50'
              }`}
            >
              <input
                type="radio"
                name={`${groupId}-expiry`}
                value={p.id}
                checked={preset === p.id}
                onChange={() => handlePresetChange(p.id)}
                className="sr-only"
              />
              <span>{p.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {preset === 'custom' ? (
        <div>
          <label
            htmlFor={`${groupId}-custom`}
            className="mb-1 block text-xs font-medium text-crewly-dim"
          >
            Custom expiry
          </label>
          <input
            id={`${groupId}-custom`}
            type="datetime-local"
            value={customLocal}
            onChange={(e) => handleCustomChange(e.target.value)}
            min={toLocalInputFromIso(new Date().toISOString())}
            className="w-full rounded-md border border-crewly-border bg-crewly-bg px-3 py-1.5 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-1 focus:ring-crewly-green"
          />
        </div>
      ) : null}
    </div>
  );
}

export default StatusExpirySelector;