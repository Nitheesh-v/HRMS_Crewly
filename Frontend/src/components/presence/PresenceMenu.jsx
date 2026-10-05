// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.2 — PRESENCE MENU (popover)
//
//  The single self-service entry point. Surfaces:
//    · current effective presence + work location
//    · Available / Busy / DND + expiry
//    · Status message + save/clear
//    · Office / WFH / Remote
//
//  Per 37.2 §4 / §43 this menu is the discoverable affordance in the
//  header. It MUST:
//    · show what the server says (no local optimistic fabrication)
//    · recover from API errors (failed mutation does NOT keep Busy
//      selected; controls re-enable)
//    · never write to localStorage
//    · be keyboard-accessible (Escape closes, focus returns to opener)
//    · not call the API for selectors that are never (Away / Offline /
//      On Leave) — those are rendered as informational badges only
//
//  The component renders inside a relative container; the parent decides
//  WHERE the menu button lives. Phase 37.2 places the button in the AppLayout
// header (next to the avatar).
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ChevronDown, Check, X } from 'lucide-react';

import PresenceIndicator from './PresenceIndicator.jsx';
import StatusExpirySelector from './StatusExpirySelector.jsx';
import StatusMessageEditor from './StatusMessageEditor.jsx';
import WorkLocationSelector, { WORK_LOCATION_LABELS } from './WorkLocationSelector.jsx';
import WorkLocationRequestDialog from './WorkLocationRequestDialog.jsx';
import {
  isSelectablePresence,
  presenceLabel,
} from './presenceVisual.js';

import {
  clearError,
  loadMyPresence,
  updateMyStatus,
  updateMyStatusMessage,
  updateMyWorkLocation,
  fetchMyWorkLocationRequests,
} from '../../redux/slices/presenceSlice.js';
import notify from '../../utils/notify.js';

const PRESENCE_OPTIONS = [
  { value: 'available', label: 'Available' },
  { value: 'busy', label: 'Busy' },
  { value: 'dnd', label: 'Do Not Disturb' },
];

export default function PresenceMenu() {
  const dispatch = useDispatch();
  const { current: presence, loading, saving, error } = useSelector(
    (state) => state.presence,
  );
  const wlr = useSelector(
    (state) => state.presence?.workLocationRequests || {},
  );

  const [open, setOpen] = useState(false);
  const [wlrDialogOpen, setWlrDialogOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState(null);
  const [draftExpiry, setDraftExpiry] = useState(undefined);
  const [draftMessage, setDraftMessage] = useState('');
  const [draftLocation, setDraftLocation] = useState(null);

  const menuRef = useRef(null);
  const buttonRef = useRef(null);

  // Initial load. Phase 36 paid for a `loading=true` starter that never
  // cleared (capsule §4.10 / 36.8). This thunk goes pending → fulfilled
  // and clears `loading` exactly once.
  useEffect(() => {
    if (loading === 'idle') {
      dispatch(loadMyPresence());
    }
  }, [dispatch, loading]);

  // Phase 37.5 — load the user's WFH requests when the menu is open
  // so the "Request WFH" CTA can show the right copy (e.g. "pending").
  useEffect(() => {
    if (open && wlr.loading === 'idle') {
      dispatch(fetchMyWorkLocationRequests());
    }
  }, [open, dispatch, wlr.loading]);

  // The popover reads the server snapshot as its default. The draft state
  // is the user's IN-PROGRESS edits only; the rendered controls read the
  // snapshot when the user has not yet typed anything. Each save
  // handler submits the mutation; the slice resolves it and pushes the
  // new snapshot back into `presence`. Drafts are cleared on close so
  // reopening reads the snapshot again. This avoids the
  // set-state-in-effect hazard (Phase 36's React hooks lint).
  const displayedStatus = draftStatus !== null || !presence
    ? draftStatus
    : (presence.manualStatus || null);
  const displayedExpiry = draftExpiry !== undefined || !presence
    ? draftExpiry
    : (presence.manualStatusExpiresAt || undefined);
  const displayedMessage = draftMessage !== '' || !presence
    ? draftMessage
    : (typeof presence.statusMessage === 'string' ? presence.statusMessage : '');
  const displayedLocation = draftLocation !== null || !presence
    ? draftLocation
    : (presence.workLocation || null);

  // Escape closes the menu and returns focus to the opener (37.2 §22).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    if (menuRef.current && buttonRef.current) {
      // Focus the first interactive element when the popover opens.
      const first = menuRef.current.querySelector(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (first) first.focus();
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setOpen(false);
    // Clear drafts on close so the popover re-reads the snapshot when
    // reopened. Done OUTSIDE React render; the setState calls here run
    // after commit and never cause the cascading-renders hazard the
    // React hooks lint watches for.
    setDraftStatus(null);
    setDraftExpiry(undefined);
    setDraftMessage('');
    setDraftLocation(null);
    requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  // Click-outside to close — but only if focus is on the page, not inside
  // the menu (otherwise the picker would close on every click).
  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (e) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(e.target)) return;
      if (buttonRef.current && buttonRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // Toast any error and clear it from state (the header can re-open fresh).
  useEffect(() => {
    if (!error) return;
    notify.error(error.message || 'Presence update failed');
    dispatch(clearError());
  }, [error, dispatch]);

  const isSaving = saving === 'pending';
  const featureEnabled = (presence?.config?.enabled ?? true) !== false;

  if (!featureEnabled) {
    return (
      <button
        type="button"
        disabled
        aria-label="Presence unavailable"
        title="Presence is disabled for your company."
        className="inline-flex h-9 cursor-not-allowed items-center gap-1.5 rounded-lg border border-crewly-border bg-crewly-bg px-2.5 text-xs font-medium text-crewly-dim"
      >
        <span className="h-2 w-2 rounded-full bg-slate-300" aria-hidden="true" />
        <span>Presence unavailable</span>
      </button>
    );
  }

  const applyStatus = async () => {
    const action = await dispatch(
      updateMyStatus({ status: draftStatus, expiresAt: draftExpiry }),
    );
    if (action.error) {
      return; // toast fired from the error effect
    }
    notify.success(
      draftStatus === null
        ? 'Status cleared'
        : `Status set to ${presenceLabel(draftStatus)}`,
    );
  };

  const applyMessage = async () => {
    const action = await dispatch(
      updateMyStatusMessage({ message: draftMessage }),
    );
    if (action.error) return;
    notify.success(draftMessage ? 'Status message saved' : 'Status message cleared');
  };

  const applyLocation = async (location) => {
    setDraftLocation(location);
    const action = await dispatch(updateMyWorkLocation({ location }));
    if (action.error) return;
    notify.success(
      location === null
        ? 'Work location cleared'
        : `Work location set to ${WORK_LOCATION_LABELS[location] || location}`,
    );
  };

  const clearStatus = async () => {
    setDraftStatus(null);
    const action = await dispatch(updateMyStatus({ status: null }));
    if (action.error) return;
    notify.success('Status cleared');
  };

  return (
    <div className="relative" data-testid="presence-menu-root">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          presence
            ? `Set presence. Current: ${presenceLabel(presence.presence)}`
            : 'Set presence'
        }
        className={
          'inline-flex h-9 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition ' +
          (presence?.presence && presence.presence !== 'unknown'
            ? 'border-crewly-green/40 bg-crewly-green/10 text-crewly-text hover:border-crewly-green/60'
            : 'border-crewly-border bg-crewly-bg text-crewly-text hover:border-crewly-green/60')
        }
      >
        <PresenceIndicator presence={presence?.presence} size="xs" showLabel={false} />
        <span className="hidden sm:inline">
          {presence?.presence && presence.presence !== 'unknown'
            ? presenceLabel(presence.presence)
            : 'Set presence'}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="dialog"
          aria-label="Presence"
          className="absolute right-0 top-full z-40 mt-2 w-[20rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-crewly-border bg-crewly-card shadow-xl sm:w-[24rem]"
        >
          <div className="flex items-center justify-between border-b border-crewly-border px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-crewly-text">
                My presence
              </span>
              <PresenceIndicator presence={presence?.presence} size="xs" />
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="space-y-3 px-3 py-3">
            {/* STATUS */}
            <section aria-labelledby="presence-status-heading">
              <h3
                id="presence-status-heading"
                className="mb-1.5 text-xs font-medium text-crewly-dim"
              >
                Status
              </h3>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Manual status">
                {PRESENCE_OPTIONS.map((opt) => {
                  // Highlight the manual state the user has selected
                  // (draft) — fall back to the server snapshot when no
                  // draft edit is in progress. The className/highlight
                  // stays reactive on save without a set-state-in-effect.
                  const isServerCurrent = displayedStatus === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
                        isServerCurrent
                          ? 'border-crewly-green bg-crewly-green/10 text-crewly-green'
                          : 'border-crewly-border bg-crewly-bg text-crewly-text hover:border-crewly-green/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="presence-status"
                        value={opt.value}
                        checked={isServerCurrent}
                        onChange={() => setDraftStatus(opt.value)}
                        disabled={isSaving}
                        className="sr-only"
                      />
                      <span>{opt.label}</span>
                      {isServerCurrent ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : null}
                    </label>
                  );
                })}
                {presence?.manualStatus ? (
                  <button
                    type="button"
                    onClick={clearStatus}
                    disabled={isSaving}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-crewly-border bg-crewly-bg px-2.5 py-1.5 text-xs font-medium text-crewly-dim hover:border-crewly-red/50 hover:text-crewly-red disabled:opacity-50"
                  >
                    Clear status
                  </button>
                ) : null}
              </div>
              {displayedStatus && isSelectablePresence(displayedStatus) ? (
                <div className="mt-2">
                  <StatusExpirySelector
                    value={displayedExpiry}
                    onChange={setDraftExpiry}
                  />
                </div>
              ) : null}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={applyStatus}
                  disabled={isSaving}
                  className="btn-primary inline-flex items-center px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Save status
                </button>
              </div>
            </section>

            {/* STATUS MESSAGE */}
            <section aria-labelledby="presence-message-heading">
              <h3
                id="presence-message-heading"
                className="mb-1.5 text-xs font-medium text-crewly-dim"
              >
                Status message
              </h3>
              {presence?.statusMessageEnabled === false ? (
                <p className="rounded-md border border-crewly-border bg-crewly-bg p-2 text-xs text-crewly-dim">
                  Status messages are disabled for your company.
                </p>
              ) : (
                <>
                  <StatusMessageEditor
                    value={displayedMessage}
                    onChange={setDraftMessage}
                    disabled={isSaving}
                  />
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setDraftMessage('')}
                      disabled={isSaving || !displayedMessage}
                      className="inline-flex items-center rounded-md border border-crewly-border bg-crewly-bg px-2.5 py-1.5 text-xs font-medium text-crewly-dim hover:border-crewly-red/50 hover:text-crewly-red disabled:opacity-50"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={applyMessage}
                      disabled={isSaving}
                      className="btn-primary inline-flex items-center px-3 py-1.5 text-xs disabled:opacity-50"
                    >
                      Save message
                    </button>
                  </div>
                </>
              )}
            </section>

            {/* WORK LOCATION */}
            <section aria-labelledby="presence-location-heading">
              <h3
                id="presence-location-heading"
                className="mb-1.5 text-xs font-medium text-crewly-dim"
              >
                Work location
              </h3>
              <WorkLocationSelector
                current={displayedLocation}
                onChange={applyLocation}
                allowedWorkLocations={presence?.allowedWorkLocations || []}
                workLocationEnabled={presence?.workLocationEnabled !== false}
                wfhMode={presence?.wfhMode || 'self_declare'}
                disabled={isSaving}
                onRequestWfh={() => setWlrDialogOpen(true)}
                pendingWfhRequest={
                  Array.isArray(wlr.myRequests)
                    ? wlr.myRequests.find((r) => r.status === 'pending')
                    : null
                }
              />
            </section>
          </div>
        </div>
      ) : null}

      {/* Phase 37.5 — WFH request dialog. */}
      <WorkLocationRequestDialog
        open={wlrDialogOpen}
        onClose={() => {
          setWlrDialogOpen(false);
          // Refresh the list so the CTA copy reflects the new status.
          dispatch(fetchMyWorkLocationRequests());
        }}
      />
    </div>
  );
}