/* eslint-disable react-hooks/set-state-in-effect */
// ═══════════════════════════════════════════════════════════════════════════
// PHASE 37.7 — TENANT PRESENCE / WORK-LOCATION SETTINGS
//
// WHAT THIS PAGE IS
//   The single company-admin surface for the Phase 37 tenant
//   configuration. The backend already exposes the GET / PUT on
//   /api/presence/config (gated by SETTINGS_MANAGE); this page is the
//   discoverable UI for that contract.
//
// WHO CAN SEE IT
//   COMPANY_ADMIN (the same gate the AI settings page uses, and the same
//   gate the backend re-uses). The route is hidden from the sidebar for
//   any other role; a non-admin who curls the API still gets 403.
//
// WHAT THIS PAGE NEVER DOES
//   · never sends companyId / userId / employeeId in the body — identity
//     is the auth handshake (Phase 37 §7, paid-for)
//   · never writes the tenant config to localStorage / sessionStorage
//     (Phase 36 capsule §4.3)
//   · never invents a config key — every key here maps 1:1 to a
//     PRESENCE_UPDATABLE_FIELDS entry in presenceTenantConfigService
//   · never sets a global "everything is dirty" flag — the page uses a
//     per-field diff so an unrelated edit is not sent (Phase 36 capsule
//     §4.4, pay-for)
//   · never hides a failed read behind a permissive defaults view — a
//     failed load is rendered as an error state, not as zeros
//   · never calls `useBlocker` — the project uses BrowserRouter and
//     useBlocker silently no-ops; we use a beforeunload prompt for the
//     browser refresh / close case (Phase 36 capsule §4.5)
//
// SHAPE
//   Follows AiSettingsPage.jsx: plain useState + useReducer pattern,
//   one service module, no Redux, one sticky bottom Save bar
//   (Phase 36 found a second top bar conflicts with the app shell).
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Check, Loader2, RotateCcw, Save } from 'lucide-react';

import notify from '../../../utils/notify.js';

import {
  loadPresenceConfig,
} from '../../../redux/slices/presenceSlice.js';
import { getTenantConfig, updateTenantConfig } from '../../../services/presenceService.js';

// ─────────────────────────────────────────────────────────────────────
// CONSTANTS
//
// Mirrors the backend's `PRESENCE_UPDATABLE_FIELDS`. If the backend
// grows a new key, the page is updated here, the validator on the
// backend grows the same key, and the source-pin test pins both.
// ─────────────────────────────────────────────────────────────────────
const WORK_LOCATIONS = Object.freeze([
  { value: 'office', label: 'Office' },
  { value: 'wfh', label: 'Work From Home' },
  { value: 'remote', label: 'Remote' },
]);

const WFH_MODES = Object.freeze([
  {
    value: 'self_declare',
    label: 'Self declare',
    help: 'Employees pick Office / WFH / Remote directly. No approval required.',
  },
  {
    value: 'approval_required',
    label: 'Approval required',
    help: 'Employees submit a WFH request; an authorised manager / HR approves it.',
  },
  {
    value: 'disabled',
    label: 'Disabled',
    help: 'WFH is not available at this company. Only Office and Remote are allowed.',
  },
]);

// Defaults, only used as the SHAPE for the form. They are NOT what
// the page shows when the load fails — a failed load is an error
// state, not a permissive defaults view.
const FORM_DEFAULTS = Object.freeze({
  enabled: true,
  employeePresenceVisible: true,
  statusMessagesEnabled: true,
  workLocationEnabled: true,
  wfhMode: 'self_declare',
  awayAfterMinutes: 5,
  offlineAfterMinutes: 15,
  lastSeenVisible: false,
  allowedWorkLocations: ['office', 'wfh', 'remote'],
});

// Compute the per-field diff between the current snapshot and the
// user's draft. Returns an object whose keys are the keys that
// differ; the value is the new value. Equality is by deep-equality
// for arrays and value-equality for primitives.
//
//   WHY PER-FIELD
//     The backend's PUT /api/presence/config is a PATCH — the
//     service filters by PRESENCE_UPDATABLE_FIELDS but the
//     operational effect is "send the keys that changed". A
//     page-wide diff (the Phase 36 bug) means an admin who only
//     toggles "Status messages" would also overwrite every other
//     field, and the next save would be a 400 because two fields
//     constructed an invalid combo. Per-field diffs avoid this.
const diffSnapshot = (snapshot, draft) => {
  if (!snapshot || !draft) return {};
  const out = {};
  for (const key of Object.keys(FORM_DEFAULTS)) {
    const a = snapshot[key];
    const b = draft[key];
    if (Array.isArray(a) || Array.isArray(b)) {
      const sa = Array.isArray(a) ? a.slice().sort().join('|') : '';
      const sb = Array.isArray(b) ? b.slice().sort().join('|') : '';
      if (sa !== sb) out[key] = b;
    } else if (a !== b) {
      out[key] = b;
    }
  }
  return out;
};

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

// ─────────────────────────────────────────────────────────────────────
//  Page component
// ─────────────────────────────────────────────────────────────────────
const PresenceSettingsPage = () => {
  // `snapshot` is the last server-confirmed state. `draft` is the
  // operator's local edits. `loading` / `saving` / `error` are the
  // lifecycle flags. The three are independent so a save error does
  // not flip the form into a "loading" state.
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Dispatch only — used to mirror the saved snapshot into the
  // redux sub-state so other surfaces (team page) see the fresh
  // enabled flags.
  const dispatch = useDispatch();

  // ─────────────────────────────────────────────────────────────────
  //  The anti-pattern this page exists to AVOID.
  //
  //  Phase 36 paid for a "save button disabled forever" bug where:
  //    - useState(true) set loading=true
  //    - the mount effect called a *different* function (read) that
  //      never touched the loading flag
  //    - every control on the page was gated on loading
  //
  //  The fix is the SAME one in AiSettingsPage.jsx: the load
  //  function owns the loading flag, and the mount effect calls
  //  load(), not read(). read() only mutates snapshot/draft/error.
  // ─────────────────────────────────────────────────────────────────
  const read = useCallback(async () => {
    try {
      const data = await getTenantConfig();
      // Guard against a backend that returned null. The service
      // already throws on error, so reaching this branch with null
      // is a server bug — surface it as an error, not as defaults.
      if (!data) {
        setError(
          'Presence configuration could not be loaded (empty response).',
        );
        setSnapshot(null);
        setDraft(null);
        return;
      }
      setSnapshot(data);
      setDraft({ ...FORM_DEFAULTS, ...data });
      setError(null);
    } catch (requestError) {
      // The service throws a wrapped Error with .message.
      // A failed read is NOT a permissive default.
      setError(
        requestError?.message ||
          'The presence settings could not be loaded. Please try again.',
      );
      setSnapshot(null);
      setDraft(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await read();
    } finally {
      // ALWAYS clear loading, success or failure. The 36.6 fix.
      setLoading(false);
    }
  }, [read]);

  useEffect(() => {
    load();
  }, [load]);

  // ─────────────────────────────────────────────────────────────────
  //  Dirty map + per-field dirty count for the sticky bar.
  // ─────────────────────────────────────────────────────────────────
  const dirtyMap = useMemo(
    () => (snapshot && draft ? diffSnapshot(snapshot, draft) : {}),
    [snapshot, draft],
  );
  const dirtyKeys = useMemo(() => Object.keys(dirtyMap), [dirtyMap]);
  const dirtyCount = dirtyKeys.length;
  const isDirty = dirtyCount > 0;

  // ─────────────────────────────────────────────────────────────────
  //  Client-side invariant checks. The backend remains
  //  authoritative; this is a UX guard so the operator does not
  //  easily construct an unsavable state.
  //
  //  - awayAfterMinutes > 0
  //  - offlineAfterMinutes > awayAfterMinutes
  //  - if workLocationEnabled === true, at least one of the three
  //    locations must remain checked.
  // ─────────────────────────────────────────────────────────────────
  const validationError = useMemo(() => {
    if (!draft) return null;
    if (!isPositiveInt(draft.awayAfterMinutes)) {
      return 'Away after must be a positive whole number of minutes.';
    }
    if (!isPositiveInt(draft.offlineAfterMinutes)) {
      return 'Offline after must be a positive whole number of minutes.';
    }
    if (draft.offlineAfterMinutes <= draft.awayAfterMinutes) {
      return 'Offline after must be greater than Away after.';
    }
    if (
      draft.workLocationEnabled &&
      (!Array.isArray(draft.allowedWorkLocations) ||
        draft.allowedWorkLocations.length === 0)
    ) {
      return 'Work location is enabled but no locations are allowed. Turn work location off, or allow at least one.';
    }
    if (draft.wfhMode === 'disabled' && Array.isArray(draft.allowedWorkLocations) && draft.allowedWorkLocations.includes('wfh')) {
      return 'WFH is disabled but WFH is in the allowed locations. Remove WFH from the allowed list, or change the WFH policy.';
    }
    return null;
  }, [draft]);

  // ─────────────────────────────────────────────────────────────────
  //  Mutators. Each one updates a single field; the dirty map
  //  recomputes via useMemo.
  // ─────────────────────────────────────────────────────────────────
  const setField = (key, value) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const toggleLocation = (loc) => {
    setDraft((d) => {
      if (!d) return d;
      const list = Array.isArray(d.allowedWorkLocations)
        ? [...d.allowedWorkLocations]
        : [];
      const has = list.includes(loc);
      const next = has ? list.filter((x) => x !== loc) : [...list, loc];
      return { ...d, allowedWorkLocations: next };
    });
  };

  // ─────────────────────────────────────────────────────────────────
  //  Discard. Reset the draft to the snapshot. The form fields
  //  re-render with the canonical values; the dirty map empties.
  // ─────────────────────────────────────────────────────────────────
  const onDiscard = () => {
    if (!snapshot) return;
    setDraft({ ...FORM_DEFAULTS, ...snapshot });
    setError(null);
  };

  // ─────────────────────────────────────────────────────────────────
  //  Save. Sends ONLY the per-field diff (Phase 36 §4.4 pay-for).
  //  On success, the page canonicalises against the new snapshot.
  //  On failure, the draft is preserved so the operator can fix
  //  the bad field and retry.
  // ─────────────────────────────────────────────────────────────────
  const onSave = async () => {
    if (!isDirty || saving || loading) return;
    if (validationError) {
      notify.error(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Per-field diff. The backend's UPDATABLE_FIELDS whitelist is
      // the authority on what the keys MEAN; the frontend is just
      // careful not to send stale or unrelated state.
      const result = await updateTenantConfig(dirtyMap);
      if (result) {
        setSnapshot(result);
        setDraft({ ...FORM_DEFAULTS, ...result });
        setSavedAt(new Date().toISOString());
        notify.success('Presence settings saved.');
        // Mirror to redux so the team page and the self menu read
        // the same enabled flags. We do NOT trigger a team refetch
        // here — the next team page load will pick up the snapshot.
        // (The thunks fire-and-forget; we do not await them.)
        dispatch(loadPresenceConfig());
      }
    } catch (requestError) {
      // Backend messages are user-facing (e.g. "offlineAfterMinutes
      // must be greater than awayAfterMinutes"). Show them verbatim.
      const message =
        requestError?.message ||
        'The presence settings could not be saved.';
      setError(message);
      notify.error(message);
    } finally {
      setSaving(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────
  //  beforeunload guard. NOT useBlocker — that does not work
  //  under BrowserRouter (Phase 36 §4.5). A beforeunload prompt
  //  covers the browser refresh / close case; in-app nav cannot
  //  be safely blocked here, so the page just shows the dirty chip
  //  and the operator is expected to use Save or Discard.
  // ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isDirty) return undefined;
    const handler = (e) => {
      e.preventDefault();
      // Modern browsers ignore the return value; setting
      // returnValue is the contract.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // ─────────────────────────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────────────────────────
  if (loading && !snapshot && !draft && !error) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2
          aria-hidden="true"
          className="h-5 w-5 animate-spin text-crewly-dim"
        />
        <span className="ml-2 text-sm text-crewly-dim">
          Loading presence settings...
        </span>
      </div>
    );
  }

  // Hard error state — the load failed. We deliberately do NOT
  // render the form with permissive defaults.
  if (error && !snapshot) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <header>
          <h1 className="text-lg font-semibold text-crewly-text">
            Presence settings
          </h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Company-wide configuration for the presence and work-location
            features.
          </p>
        </header>
        <section className="rounded-xl border border-crewly-red/40 bg-crewly-red/5 p-4">
          <p className="text-sm text-crewly-red">
            {error}
          </p>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-crewly-border bg-crewly-card px-2.5 py-1.5 text-xs font-medium text-crewly-text hover:border-crewly-green/50 disabled:opacity-50"
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            Retry
          </button>
        </section>
      </div>
    );
  }

  // No draft yet (e.g. snapshot loaded but a single field check
  // below). Render the shell with a spinner.
  if (!draft) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2
          aria-hidden="true"
          className="h-5 w-5 animate-spin text-crewly-dim"
        />
      </div>
    );
  }

  const canSave = isDirty && !saving && !loading && !validationError;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-crewly-text">
            Presence settings
          </h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Company-wide configuration for the presence and work-location
            features.
          </p>
        </div>
        {isDirty ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-crewly-orange/40 bg-crewly-orange/10 px-2 py-1 text-[11px] font-medium text-crewly-orange"
            data-testid="presence-settings-dirty-chip"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-crewly-orange"
            />
            {dirtyCount} unsaved{' '}
            {dirtyCount === 1 ? 'change' : 'changes'}
          </span>
        ) : savedAt ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-crewly-green/40 bg-crewly-green/10 px-2 py-1 text-[11px] font-medium text-crewly-green"
            data-testid="presence-settings-saved-chip"
          >
            <Check aria-hidden="true" className="h-3 w-3" />
            Saved
          </span>
        ) : null}
      </header>

      {error && snapshot ? (
        <section
          role="alert"
          className="rounded-xl border border-crewly-red/40 bg-crewly-red/5 p-3 text-sm text-crewly-red"
        >
          {error}
        </section>
      ) : null}

      {validationError ? (
        <section
          role="alert"
          data-testid="presence-settings-validation"
          className="rounded-xl border border-crewly-orange/40 bg-crewly-orange/5 p-3 text-sm text-crewly-orange"
        >
          {validationError}
        </section>
      ) : null}

      {/* ───── PRESENCE ───── */}
      <section className="rounded-xl border border-crewly-border bg-crewly-card p-4">
        <h2 className="text-[13px] font-bold text-crewly-text">Presence</h2>
        <p className="mt-1 text-xs text-crewly-dim">
          How the presence menu, status messages, and last-seen indicators
          work for the employees in this company.
        </p>

        <div className="mt-4 space-y-3">
          <ToggleRow
            label="Presence enabled"
            help="When off, the presence menu and team availability read as if no data is configured for this company."
            checked={!!draft.enabled}
            disabled={loading || saving}
            onChange={(v) => setField('enabled', v)}
          />
          <ToggleRow
            label="Employee presence visibility"
            help="When off, ordinary employees do not see coworker presence on the team page, in counts, or in summaries."
            checked={!!draft.employeePresenceVisible}
            disabled={loading || saving}
            onChange={(v) => setField('employeePresenceVisible', v)}
          />
          <ToggleRow
            label="Status messages"
            help="Short availability messages like 'In a meeting until 3 PM'. When off, the input is hidden and existing messages are not displayed."
            checked={!!draft.statusMessagesEnabled}
            disabled={loading || saving}
            onChange={(v) => setField('statusMessagesEnabled', v)}
          />
          <ToggleRow
            label="Show last seen"
            help="Display a last-seen timestamp next to coworkers who are not currently online. Does not track a history."
            checked={!!draft.lastSeenVisible}
            disabled={loading || saving}
            onChange={(v) => setField('lastSeenVisible', v)}
          />
        </div>
      </section>

      {/* ───── WORK LOCATION ───── */}
      <section className="rounded-xl border border-crewly-border bg-crewly-card p-4">
        <h2 className="text-[13px] font-bold text-crewly-text">
          Work location
        </h2>
        <p className="mt-1 text-xs text-crewly-dim">
          Whether employees can declare a work location, and which locations
          are valid.
        </p>

        <div className="mt-4 space-y-3">
          <ToggleRow
            label="Work location enabled"
            help="When off, employees cannot declare Office / WFH / Remote, and the work-location selector is hidden."
            checked={!!draft.workLocationEnabled}
            disabled={loading || saving}
            onChange={(v) => setField('workLocationEnabled', v)}
          />

          <div>
            <p className="text-xs font-medium text-crewly-dim">
              Allowed locations
            </p>
            <p className="mt-1 text-[11px] text-crewly-dim/80">
              At least one must remain checked while work location is on. To
              clear the list, turn work location off first.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {WORK_LOCATIONS.map((loc) => {
                const checked = (
                  draft.allowedWorkLocations || []
                ).includes(loc.value);
                // Disable the LAST checked box so the operator
                // cannot construct an unsavable empty list. If the
                // operator really wants an empty list, they must
                // turn work location off first.
                const wouldBeLast =
                  checked &&
                  (draft.allowedWorkLocations || []).length === 1;
                return (
                  <label
                    key={loc.value}
                    className={
                      'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ' +
                      (checked
                        ? 'border-crewly-green bg-crewly-green/10 text-crewly-green'
                        : 'border-crewly-border bg-crewly-bg text-crewly-text hover:border-crewly-green/50') +
                      (draft.workLocationEnabled && wouldBeLast
                        ? ' opacity-50'
                        : '')
                    }
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      disabled={
                        loading ||
                        saving ||
                        !draft.workLocationEnabled ||
                        (checked && wouldBeLast)
                      }
                      onChange={() => toggleLocation(loc.value)}
                      data-testid={`presence-settings-loc-${loc.value}`}
                    />
                    <span>{loc.label}</span>
                    {checked ? (
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ───── WFH POLICY ───── */}
      <section className="rounded-xl border border-crewly-border bg-crewly-card p-4">
        <h2 className="text-[13px] font-bold text-crewly-text">WFH policy</h2>
        <p className="mt-1 text-xs text-crewly-dim">
          How employees may declare a work-from-home day.
        </p>

        <div
          className="mt-3 space-y-2"
          role="radiogroup"
          aria-label="WFH policy"
        >
          {WFH_MODES.map((m) => {
            const selected = draft.wfhMode === m.value;
            return (
              <label
                key={m.value}
                className={
                  'flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-xs transition ' +
                  (selected
                    ? 'border-crewly-green bg-crewly-green/5'
                    : 'border-crewly-border bg-crewly-bg hover:border-crewly-green/40')
                }
              >
                <input
                  type="radio"
                  name="wfhMode"
                  className="mt-0.5"
                  checked={selected}
                  disabled={loading || saving}
                  onChange={() => setField('wfhMode', m.value)}
                  data-testid={`presence-settings-wfh-${m.value}`}
                />
                <span>
                  <span className="block font-semibold text-crewly-text">
                    {m.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-crewly-dim">
                    {m.help}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* ───── AVAILABILITY TIMING ───── */}
      <section className="rounded-xl border border-crewly-border bg-crewly-card p-4">
        <h2 className="text-[13px] font-bold text-crewly-text">
          Availability timing
        </h2>
        <p className="mt-1 text-xs text-crewly-dim">
          How the automatic Available / Away / Offline behaviour transitions.
          Manual statuses (Busy, DND) are not affected.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <NumberRow
            label="Away after (minutes)"
            help="A live user with no recent activity past this many minutes is shown as Away."
            value={draft.awayAfterMinutes}
            min={1}
            step={1}
            disabled={loading || saving}
            onChange={(v) => setField('awayAfterMinutes', v)}
            testId="presence-settings-away"
          />
          <NumberRow
            label="Offline after (minutes)"
            help="A user with no live connection and no recent activity past this many minutes is shown as Offline."
            value={draft.offlineAfterMinutes}
            min={Math.max(2, Number(draft.awayAfterMinutes) + 1)}
            step={1}
            disabled={loading || saving}
            onChange={(v) => setField('offlineAfterMinutes', v)}
            testId="presence-settings-offline"
          />
        </div>
      </section>

      {/* ───── STICKY BOTTOM SAVE BAR ───── */}
      <div
        className="sticky bottom-0 -mx-4 mt-2 border-t border-crewly-border bg-crewly-card/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6"
        data-testid="presence-settings-save-bar"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-crewly-dim">
            {isDirty
              ? `${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}.`
              : savedAt
              ? 'Settings are up to date.'
              : 'Settings are up to date.'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDiscard}
              disabled={!isDirty || saving || loading}
              className="inline-flex items-center gap-1.5 rounded-md border border-crewly-border bg-crewly-bg px-3 py-1.5 text-xs font-medium text-crewly-text hover:border-crewly-red/50 hover:text-crewly-red disabled:opacity-50"
              data-testid="presence-settings-discard"
            >
              <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
              Discard
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!canSave}
              className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50"
              data-testid="presence-settings-save"
            >
              {saving ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
//  Reusable small bits
// ─────────────────────────────────────────────────────────────────────
const ToggleRow = ({ label, help, checked, onChange, disabled, testId }) => (
  <label className="flex items-start justify-between gap-3 rounded-md border border-crewly-border bg-crewly-bg p-2.5">
    <span>
      <span className="block text-xs font-semibold text-crewly-text">
        {label}
      </span>
      <span className="mt-0.5 block text-[11px] text-crewly-dim">{help}</span>
    </span>
    <span className="relative inline-flex shrink-0 items-center">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      <span
        aria-hidden="true"
        className={
          'h-5 w-9 rounded-full transition ' +
          (checked
            ? 'bg-crewly-green'
            : 'bg-crewly-border') +
          (disabled ? ' opacity-50' : '')
        }
      />
      <span
        aria-hidden="true"
        className={
          'absolute top-0.5 h-4 w-4 rounded-full bg-white transition ' +
          (checked ? 'left-[18px]' : 'left-0.5')
        }
      />
    </span>
  </label>
);

const NumberRow = ({
  label,
  help,
  value,
  min,
  step,
  onChange,
  disabled,
  testId,
}) => (
  <label className="flex flex-col gap-1 rounded-md border border-crewly-border bg-crewly-bg p-2.5">
    <span className="text-xs font-semibold text-crewly-text">{label}</span>
    <span className="text-[11px] text-crewly-dim">{help}</span>
    <input
      type="number"
      inputMode="numeric"
      min={min}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="input mt-1 py-1.5 text-xs"
      data-testid={testId}
    />
  </label>
);

export default PresenceSettingsPage;
