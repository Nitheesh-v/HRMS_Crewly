import { useEffect, useState } from 'react';
import { KeyRound, Lock, ShieldCheck } from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import { notify } from '../../utils/notify.js';

// Phase 31.14 completion — Kiosk PIN self-service (My Attendance).
// The employee sets/changes ONLY their own PIN (backend identity
// is req.user). The PIN is digits-only, 4–12 chars; the API never
// returns it — only { configured }.

const digitsOnly = (value) => String(value || '').replace(/[^\d]/g, '').slice(0, 12);

const KioskPinCard = () => {
  const [configured, setConfigured] = useState(null);
  const [currentPin, setCurrentPin] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    attendanceCaptureService.getKioskPinStatus().then(
      (res) => setConfigured(Boolean(res.data?.configured)),
      () => setConfigured(null)
    );
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();


    if (pin.length < 4) {
      notify.warning('Kiosk PIN must be 4–12 digits.');
      return;
    }
    if (pin !== confirm) {
      notify.warning('The PIN entries do not match.');
      return;
    }
    setBusy(true);
    try {
      await attendanceCaptureService.setKioskPin(
        configured ? { pin, currentPin } : { pin }
      );
      setConfigured(true);
      setCurrentPin('');
      setPin('');
      setConfirm('');
      notify.success(configured ? 'Kiosk PIN changed.' : 'Kiosk PIN set — you can now punch at the shared terminal.');
    } catch (saveError) {
      notify.error(saveError, 'Could not save the Kiosk PIN');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crewly-accent/15 text-crewly-orange">
          <KeyRound className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="card-title flex items-center gap-2 text-sm font-bold">Kiosk &amp; mobile PIN</h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-crewly-dim">
            A short PIN for punching at a shared terminal. It is not your login password and it
            never leaves this company.
          </p>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-crewly-dim">
        {configured === null && 'Checking whether a PIN is set…'}
        {configured === false &&
          'No PIN yet. Set one to punch at the company kiosk without signing in there.'}
        {configured === true &&
          'A PIN is set. Changing it signs out any pending terminal verifications.'}
      </p>

      {configured !== null && (
        <form onSubmit={handleSubmit} className="mt-3 space-y-3">
          {configured && (
            <label className="block text-xs">
              <span className="mb-1 block font-semibold text-crewly-dim">Current PIN</span>
              <span className="relative block">
                <input
                  type="password"
                  inputMode="numeric"
                  className="input w-full pr-9 tracking-[0.3em]"
                  value={currentPin}
                  onChange={(event) => setCurrentPin(digitsOnly(event.target.value))}
                  autoComplete="off"
                  aria-label="Current PIN"
                />
                <Lock className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
              </span>
            </label>
          )}

          <label className="block text-xs">
            <span className="mb-1 block font-semibold text-crewly-dim">
              {configured ? 'New PIN' : 'PIN'} · 4–12 digits
            </span>
            <span className="relative block">
              <input
                type="password"
                inputMode="numeric"
                className="input w-full pr-9 tracking-[0.3em]"
                value={pin}
                onChange={(event) => setPin(digitsOnly(event.target.value))}
                autoComplete="new-password"
                aria-label={configured ? 'New PIN' : 'PIN'}
              />
              <Lock className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
            </span>
          </label>

          <label className="block text-xs">
            <span className="mb-1 block font-semibold text-crewly-dim">Confirm PIN</span>
            <span className="relative block">
              <input
                type="password"
                inputMode="numeric"
                className="input w-full pr-9 tracking-[0.3em]"
                value={confirm}
                onChange={(event) => setConfirm(digitsOnly(event.target.value))}
                autoComplete="new-password"
                aria-label="Confirm PIN"
              />
              <ShieldCheck className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
            </span>
          </label>

          <button
            type="submit"
            disabled={busy || pin.length < 4 || pin !== confirm}
            className="btn-primary inline-flex w-full items-center justify-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {busy ? 'Saving…' : configured ? 'Update kiosk PIN' : 'Set kiosk PIN'}
          </button>
          <p className="text-[11px] text-crewly-dim">
            {pin.length > 0 && pin.length < 4
              ? 'A PIN is at least 4 digits.'
              : pin && confirm && pin !== confirm
                ? 'The two entries do not match yet.'
                : 'Digits only. The PIN is never displayed back to you.'}
          </p>
        </form>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-crewly-inset/60 px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold">
          <ShieldCheck className="h-3.5 w-3.5 text-crewly-green" aria-hidden="true" />
          {configured ? 'PIN configured' : configured === false ? 'Not set yet' : 'Reading status'}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-crewly-dim">Self-service</span>
      </div>
    </section>
  );
};

export default KioskPinCard;
