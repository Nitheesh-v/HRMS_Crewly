// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.2 — WORK LOCATION SELECTOR
//
//  Three values: Office, WFH, Remote. Each renders only when the
//  tenant config allows it AND (for WFH) when the policy is
//  self_declare.
//
//  Three guards, one binding per the 37.1 §15 / 37.2 §12:
//    · wfhMode = 'disabled'              → WFH is rendered disabled with
//                                        an explanatory label
//    · wfhMode = 'approval_required'    → WFH is rendered disabled with
//                                        a different explanatory label
//    · wfhMode = 'self_declare'         → WFH is interactive
//
//  The component NEVER mutates; the parent menu owns the dispatch.
// ═══════════════════════════════════════════════════════════════════════════

const LABELS = {
  office: 'Office',
  wfh: 'Work From Home',
  remote: 'Remote',
};

const wfhDisabledCopy = (wfhMode) => {
  if (wfhMode === 'disabled') {
    return 'WFH is disabled for your company.';
  }
  if (wfhMode === 'approval_required') {
    return 'WFH requires approval for your company. (Request flow ships in a later update.)';
  }
  return null;
};

export default function WorkLocationSelector({
  current,
  onChange,
  allowedWorkLocations = [],
  workLocationEnabled = true,
  wfhMode = 'self_declare',
  disabled = false,
}) {
  if (!workLocationEnabled) {
    return (
      <div
        className="rounded-md border border-crewly-border bg-crewly-bg p-2 text-xs text-crewly-dim"
        data-testid="work-location-disabled"
      >
        Work location is disabled for your company.
      </div>
    );
  }

  const allLocations = ['office', 'wfh', 'remote'];
  const wfhDisabledReason = wfhDisabledCopy(wfhMode);

  return (
    <div className="space-y-1.5" data-testid="work-location-selector">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Work location">
        {allLocations.map((loc) => {
          const allowed = allowedWorkLocations.includes(loc);
          const isWfhBlocked =
            loc === 'wfh' && wfhMode !== 'self_declare';
          const interactive = allowed && !isWfhBlocked && !disabled;
          const isCurrent = current === loc;

          return (
            <label
              key={loc}
              className={`inline-flex min-w-[160px] cursor-pointer flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
                isCurrent
                  ? 'border-crewly-green bg-crewly-green/10 text-crewly-green'
                  : interactive
                  ? 'border-crewly-border bg-crewly-bg text-crewly-text hover:border-crewly-green/50'
                  : 'border-crewly-border bg-crewly-bg/60 text-crewly-dim cursor-not-allowed'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="presence-work-location"
                  value={loc}
                  checked={isCurrent}
                  disabled={!interactive}
                  onChange={() => interactive && onChange(loc)}
                  className="sr-only"
                />
                <span>{LABELS[loc]}</span>
              </span>
              {!allowed ? (
                <span className="text-[10px] text-crewly-dim">
                  Not enabled for your company
                </span>
              ) : loc === 'wfh' && isWfhBlocked ? (
                <span
                  className="text-[10px] text-crewly-dim"
                  data-testid="wfh-policy-notice"
                >
                  {wfhDisabledReason}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}

export const WORK_LOCATION_LABELS = LABELS;