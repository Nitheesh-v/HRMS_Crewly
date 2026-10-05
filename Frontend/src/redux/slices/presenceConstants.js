// Phase 37.1 — shared constants for the presence slice and service.
// Hoisted out of presenceService.js to break the slice <-> service
// circular import (Phase 36 capsule §4.9).

export const EMPTY_PRESENCE = Object.freeze({
  presence: 'unknown',
  presenceSource: 'none',
  manualStatus: null,
  manualStatusExpiresAt: null,
  statusMessage: '',
  statusMessageExpiresAt: null,
  statusMessageEnabled: true,
  workLocation: null,
  workLocationExpiresAt: null,
  workLocationEnabled: true,
  allowedWorkLocations: ['office', 'wfh', 'remote'],
  wfhMode: 'self_declare',
  livePresenceAvailable: false,
  // Phase 37.6 — the two new authoritative facts. `null` is
  // "HR read failed / unavailable" — distinct from `false`
  // ("definitely not on leave" / "definitely within shift").
  onLeave: null,
  outsideWorkingHours: null,
  workingHoursSource: null,
  workingHoursPhase: null,
  workingHoursIsWorkingDay: null,
  config: {
    enabled: true,
    statusMessagesEnabled: true,
    workLocationEnabled: true,
    wfhMode: 'self_declare',
    allowedWorkLocations: ['office', 'wfh', 'remote'],
  },
});
