import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Delete, LogOut, MapPin, MonitorSmartphone } from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';

// Phase 31.14 completion — shared Kiosk terminal. Chromeless by
// design (no sidebar, no nav, no admin UI): this screen runs on
// the company's shared tablet/PC at the workplace.
//
// Trust model:
// - ONLY the station session (device JWT + station display name)
//   persists in localStorage. Employee code / PIN / name /
//   context token live in memory and are wiped on success,
//   cancel, inactivity, or context expiry.
// - Kiosk 401s are meaningful (bad secret, bad PIN, rotated or
//   deactivated station, expired context) and surface as-is;
//   the kioskApi client never refreshes/retries them.

const STORAGE_KEY = 'crewly_kiosk_session';
const VERIFIED_IDLE_MS = 60 * 1000;
const FORM_IDLE_MS = 90 * 1000;
const SUCCESS_MS = 8 * 1000;

const ACTION_LABELS = {
  CLOCK_IN: 'Clock in',
  BREAK_START: 'Start break',
  BREAK_END: 'End break',
  CLOCK_OUT: 'Clock out',
};

const STATE_LABELS = {
  NOT_IN: 'Not clocked in',
  WORKING: 'Working',
  ON_BREAK: 'On break',
  COMPLETED: 'Day complete',
};

const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

// One-shot terminal GPS, sampled ONLY when the geofence gate
// demands verification (strict policy) — never speculatively.
// Resolves { latitude, longitude, accuracy? } or throws an
// employee-safe Error. getCurrentPosition ONLY — watchPosition
// must never appear in this file.
const readSinglePosition = () =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available on this terminal'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          reject(new Error('Could not determine the terminal location — please retry'));
          return;
        }
        resolve({
          latitude,
          longitude,
          ...(Number.isFinite(accuracy) ? { accuracy } : {}),
        });
      },
      (failure) => {
        // GeolocationPositionError codes: 1 denied, 2 unavailable, 3 timeout.
        if (failure?.code === 1) {
          reject(new Error('Location permission was denied on this terminal'));
        } else if (failure?.code === 3) {
          reject(new Error('Location request timed out — please retry'));
        } else {
          reject(new Error('Could not determine the terminal location — please retry'));
        }
      },
      { timeout: 10000, maximumAge: 0 },
    );
  });

const readStoredSession = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!stored?.token || !stored?.station) return null;
    if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) return null;
    return stored;
  } catch {
    return null;
  }
};

const KioskTerminalPage = () => {
  // provision → kiosk → verified → success (then back to kiosk).
  const [stored, setStored] = useState(readStoredSession);
  const [mode, setMode] = useState(readStoredSession() ? 'kiosk' : 'provision');
  const [stationId, setStationId] = useState('');
  const [secret, setSecret] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const [pin, setPin] = useState('');
  const [verified, setVerified] = useState(null);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const idleTimer = useRef(null);
  const successTimer = useRef(null);

  const clearTimers = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (successTimer.current) clearTimeout(successTimer.current);
    idleTimer.current = null;
    successTimer.current = null;
  };

  useEffect(() => clearTimers, []);

  // Wipe every trace of the employee; the terminal stays signed in.
  const resetEmployee = () => {
    clearTimers();
    setEmployeeCode('');
    setPin('');
    setVerified(null);
    setSuccess(null);
    setError('');
    setBusy('');
    setMode('kiosk');
  };

  // Station-level failure (rotated/deactivated/expired): the stored
  // device session is dead — return to provisioning.
  const dropSession = (message) => {
    clearTimers();
    localStorage.removeItem(STORAGE_KEY);
    setStored(null);
    setSecret('');
    resetEmployee();
    setMode('provision');
    setError(message || '');
  };

  // Inactivity: verified context 60s, half-typed form 90s.
  useEffect(() => {
    clearTimers();
    if (mode === 'verified') {
      idleTimer.current = setTimeout(resetEmployee, VERIFIED_IDLE_MS);
    } else if (mode === 'kiosk' && (employeeCode || pin)) {
      idleTimer.current = setTimeout(resetEmployee, FORM_IDLE_MS);
    } else if (mode === 'success') {
      successTimer.current = setTimeout(resetEmployee, SUCCESS_MS);
    }
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, employeeCode, pin, verified, success]);

  const isSessionError = (message) =>
    /kiosk session|station unavailable|sign in again|station credentials/i.test(message || '');

  const handleProvision = async (event) => {
    event.preventDefault();
    setBusy('provision');
    setError('');
    try {
      const res = await attendanceCaptureService.openKioskSession({ stationId: stationId.trim(), secret });
      const session = {
        token: res.data?.token,
        expiresAt: res.data?.expiresAt || null,
        station: res.data?.station || null,
      };
      if (!session.token || !session.station) throw new Error('Terminal sign-in failed — please retry');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      setStored(session);
      setStationId('');
      setSecret('');
      setMode('kiosk');
    } catch (provisionError) {
      setError(provisionError?.message || 'Terminal sign-in failed');
    } finally {
      setBusy('');
    }
  };

  const handleIdentify = async (event) => {
    event.preventDefault();
    setBusy('identify');
    setError('');
    try {
      const res = await attendanceCaptureService.identifyKioskEmployee(stored.token, {
        employeeCode: employeeCode.trim(),
        pin,
      });
      setPin('');
      setVerified(res.data);
      setMode('verified');
    } catch (identifyError) {
      const message = identifyError?.message || 'Verification failed';
      if (stored && isSessionError(message) && identifyError?.status === 401 && /session|station/i.test(message)) {
        dropSession(message);
        return;
      }
      setError(message);
      setPin('');
    } finally {
      setBusy('');
    }
  };

  const handlePunch = async (action) => {
    setBusy(action);
    setError('');
    // One logical action, one idempotency key — shared by the
    // first attempt and any verification-demanded GPS retry (the
    // refused first attempt writes nothing).
    const idempotencyKey = newIdempotencyKey();
    const attempt = (position) =>
      attendanceCaptureService.punchKiosk(stored.token, {
        employeeToken: verified.employeeToken,
        action,
        idempotencyKey,
        ...(position ? { position } : {}),
      });
    try {
      let res;
      try {
        // CLOCK_IN first tries WITHOUT GPS: lax policies record
        // immediately and the terminal never prompts for location.
        // Break/out actions never carry GPS (never collected).
        res = await attempt(null);
      } catch (firstError) {
        const firstMessage = firstError?.message || '';
        const verificationDemanded =
          action === 'CLOCK_IN' &&
          firstError?.status === 400 &&
          /verification is required by company policy/i.test(firstMessage);
        if (!verificationDemanded) throw firstError;
        // Strict policy: sample the terminal position once and
        // retry — the server verifies it against the station fence.
        setBusy(`${action}:locating`);
        const position = await readSinglePosition();
        setBusy(action);
        res = await attempt(position);
      }
      setSuccess({
        action,
        replayed: Boolean(res.meta?.idempotentReplay || res.data?.replayed),
        at: new Date(),
      });
      setVerified(null);
      setMode('success');
    } catch (punchError) {
      const message = punchError?.message || 'Could not record the punch';
      if (/invalid or expired/i.test(message)) {
        resetEmployee();
        setError('Verification expired — please identify again.');
        return;
      }
      if (isSessionError(message)) {
        dropSession(message);
        return;
      }
      setError(message);
    } finally {
      setBusy('');
    }
  };

  const sessionExpiry = stored?.expiresAt
    ? new Date(stored.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-crewly-bg p-4">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <div className="text-2xl font-extrabold tracking-wide text-crewly-green">
            Crewly <span className="text-crewly-orange">HRMS</span>
          </div>
          {stored?.station ? (
            <div className="mt-2 space-y-1">
              <p className="flex items-center justify-center gap-1 text-lg font-semibold text-crewly-ink">
                <MonitorSmartphone className="h-5 w-5" /> {stored.station.name}
              </p>
              {stored.station.locationName && (
                <p className="flex items-center justify-center gap-1 text-sm text-crewly-dim">
                  <MapPin className="h-4 w-4" /> {stored.station.locationName}
                </p>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-crewly-dim">Shared attendance terminal</p>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-crewly-red/40 bg-crewly-red/10 p-4 text-sm text-crewly-red">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {mode === 'provision' && (
          <form onSubmit={handleProvision} className="space-y-4 rounded-xl border border-crewly-line bg-crewly-card p-6">
            <p className="text-center text-sm text-crewly-dim">
              Provision this terminal once with the station ID and secret from Attendance → Kiosk Stations.
            </p>
            <div>
              <label className="mb-1 block text-sm text-crewly-dim" htmlFor="kiosk-station">Station ID</label>
              <input
                id="kiosk-station"
                className="input"
                value={stationId}
                onChange={(event) => setStationId(event.target.value)}
                placeholder="Paste the station ID"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-crewly-dim" htmlFor="kiosk-secret">Station secret</label>
              <input
                id="kiosk-secret"
                type="password"
                className="input"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="One-time station secret"
                autoComplete="off"
              />
            </div>
            <button
              type="submit"
              disabled={busy === 'provision' || !stationId.trim() || !secret}
              className="w-full rounded-lg bg-crewly-accent px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy === 'provision' ? 'Signing in terminal…' : 'Provision this terminal'}
            </button>
          </form>
        )}

        {mode === 'kiosk' && (
          <form onSubmit={handleIdentify} className="space-y-4 rounded-xl border border-crewly-line bg-crewly-card p-6">
            <div>
              <label className="mb-1 block text-sm text-crewly-dim" htmlFor="kiosk-code">Employee code</label>
              <input
                id="kiosk-code"
                className="input text-center text-lg tracking-widest"
                value={employeeCode}
                onChange={(event) => setEmployeeCode(event.target.value)}
                placeholder="EMP-0012"
                autoComplete="off"
                autoCapitalize="characters"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-crewly-dim" htmlFor="kiosk-pin">Kiosk PIN</label>
              <input
                id="kiosk-pin"
                type="password"
                inputMode="numeric"
                className="input text-center text-lg tracking-[0.5em]"
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/[^\d]/g, '').slice(0, 12))}
                placeholder="••••"
                autoComplete="off"
              />
            </div>
            <button
              type="submit"
              disabled={busy === 'identify' || !employeeCode.trim() || !pin}
              className="w-full rounded-lg bg-crewly-accent px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy === 'identify' ? 'Verifying…' : 'Continue'}
            </button>
            <p className="text-center text-xs text-crewly-dim">
              Set your Kiosk PIN in My Attendance before your first terminal punch.
            </p>
          </form>
        )}

        {mode === 'verified' && verified && (
          <div className="space-y-4 rounded-xl border border-crewly-line bg-crewly-card p-6 text-center">
            <div>
              <p className="text-xl font-semibold text-crewly-ink">{verified.maskedName}</p>
              <p className="mt-1 flex items-center justify-center gap-1 text-sm text-crewly-dim">
                <Clock className="h-4 w-4" /> Current: {STATE_LABELS[verified.liveState] || verified.liveState}
              </p>
            </div>
            <div className="space-y-3">
              {(verified.allowedActions || []).map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={!!busy}
                  onClick={() => handlePunch(action)}
                  className="w-full rounded-lg bg-crewly-accent px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy === `${action}:locating` ? 'Locating…' : busy === action ? 'Recording…' : ACTION_LABELS[action] || action}
                </button>
              ))}
              {!(verified.allowedActions || []).length && (
                <p className="text-sm text-crewly-dim">No actions available right now.</p>
              )}
            </div>
            <button
              type="button"
              onClick={resetEmployee}
              className="inline-flex items-center gap-1 text-sm text-crewly-dim underline hover:text-crewly-ink"
            >
              <Delete className="h-4 w-4" /> Done / Clear
            </button>
          </div>
        )}

        {mode === 'success' && success && (
          <div className="space-y-3 rounded-xl border border-green-500/40 bg-green-500/10 p-6 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-green-300" />
            <p className="font-semibold text-green-200">
              {ACTION_LABELS[success.action] || success.action} recorded
              {success.replayed ? ' (already recorded)' : ''}
            </p>
            <p className="text-sm text-green-200/70">
              {success.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
            <p className="text-xs text-crewly-dim">Returning to kiosk…</p>
          </div>
        )}

        {stored && (
          <div className="flex items-center justify-between text-xs text-crewly-dim">
            <span>{sessionExpiry ? `Terminal session until ${sessionExpiry}` : 'Terminal session active'}</span>
            <button
              type="button"
              onClick={() => dropSession('')}
              className="inline-flex items-center gap-1 underline hover:text-crewly-ink"
            >
              <LogOut className="h-3 w-3" /> Remove terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default KioskTerminalPage;
