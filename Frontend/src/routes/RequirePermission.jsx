import { useState } from 'react';
import usePermission from '../hooks/usePermission.js';

/*
 * 35.2 — "THE PAGE IS NOT OPENING" HAS THREE DIFFERENT ANSWERS.
 *
 * This guard used to render two states: a bare "Checking permissions…" line
 * while the request was in flight, and — for ANY other outcome — the amber
 * "Your account cannot open this page yet" card, whose advice was to restart
 * the backend and sign in again.
 *
 * That conflated two completely different things:
 *
 *   · the account genuinely lacks the permission (a real answer), and
 *   · the permission request FAILED — offline, timed out, server error —
 *     which says nothing at all about what the account may do.
 *
 * A failed check therefore told the person their account was not allowed, and
 * sent them to re-login, when the honest answer is "we could not check, try
 * again". With no request timeout (fixed in api.js, same unit) a slow request
 * could also sit on "Checking permissions…" forever, which is exactly the
 * "selected pages are not opening" report.
 *
 * So: while loading we say so; on failure we say the check failed and offer
 * Retry; only a resolved check may deny.
 */
const RequirePermission = ({
  permission,
  any = [],
  all = [],
  children,
}) => {
  const {
    loading,
    error,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    refreshPermissions,
  } = usePermission();

  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);

    try {
      await refreshPermissions();
    } catch {
      // the failure card below is the report; nothing more to say here
    } finally {
      setRetrying(false);
    }
  };

  /*
   * The slice records the failure AND marks itself loaded (fail-closed), so
   * the error, not `loaded`, is what tells a broken check apart from a
   * refusal. It is cleared the moment a refresh succeeds.
   */
  const checkFailed = !loading && Boolean(error);

  if (loading || retrying) {
    return (
      <div className="p-6 text-crewly-dim">
        Checking permissions…
      </div>
    );
  }

  if (checkFailed) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6 text-amber-50">
        <h1 className="text-lg font-semibold">We could not check your permissions</h1>

        <p className="mt-2 text-sm leading-6 text-amber-100/90">
          The request that loads your access rights did not complete, so this page cannot
          open yet. This is a connection or timeout problem, not a decision about your account.
        </p>

        <p className="mt-2 text-xs leading-6 text-amber-100/70">
          {error}
        </p>

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            className="btn-primary"
            onClick={retry}
            disabled={retrying}
          >
            Retry
          </button>

          <a href="/app" className="btn-ghost inline-flex">
            Back to dashboard
          </a>
        </div>
      </div>
    );
  }

  let allowed = true;

  if (permission) {
    allowed = hasPermission(permission);
  }

  if (any.length) {
    allowed = allowed && hasAnyPermission(any);
  }

  if (all.length) {
    allowed = allowed && hasAllPermissions(all);
  }

  if (!allowed) {
    // Soft-fail with a clear message instead of a silent dashboard bounce.
    // Common right after a deploy, before the session carries new permissions.
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6 text-amber-50">
        <h1 className="text-lg font-semibold">Permission required</h1>
        <p className="mt-2 text-sm leading-6 text-amber-100/90">
          Your account cannot open this page yet
          {permission ? (
            <>
              {' '}
              (<code className="rounded bg-slate-950/40 px-1.5 py-0.5 text-xs">{permission}</code>)
            </>
          ) : null}
          .
        </p>
        <p className="mt-3 text-sm leading-6 text-amber-100/80">
          If your role was changed recently, sign out and back in so the new permissions load.
        </p>
        <a href="/app" className="btn-ghost mt-5 inline-flex">
          Back to dashboard
        </a>
      </div>
    );
  }

  return children;
};

export default RequirePermission;
