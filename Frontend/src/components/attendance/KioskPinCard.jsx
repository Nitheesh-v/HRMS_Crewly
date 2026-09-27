import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
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
    <div className="card p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-crewly-ink">
        <KeyRound className="h-4 w-4" /> Kiosk PIN
      </div>
      <p className="mt-1 text-sm text-crewly-dim">
        {configured === null && 'Loading…'}
        {configured === false && 'Set a terminal PIN to punch at the company kiosk. It is not your login password.'}
        {configured === true && 'PIN configured. Change it any time — changing signs out pending terminal verifications.'}
      </p>




      {configured !== null && (
        <form onSubmit={handleSubmit} className="mt-3 grid gap-3 sm:grid-cols-4">
          {configured && (
            <label className="block text-sm">
              <span className="mb-1 block text-crewly-dim">Current PIN</span>
              <input
                type="password"
                inputMode="numeric"
                className="input"
                value={currentPin}
                onChange={(event) => setCurrentPin(digitsOnly(event.target.value))}
                autoComplete="off"
              />
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-crewly-dim">{configured ? 'New PIN' : 'PIN'} (4–12 digits)</span>
            <input
              type="password"
              inputMode="numeric"
              className="input"
              value={pin}
              onChange={(event) => setPin(digitsOnly(event.target.value))}
              autoComplete="new-password"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-crewly-dim">Confirm PIN</span>
            <input
              type="password"
              inputMode="numeric"
              className="input"
              value={confirm}
              onChange={(event) => setConfirm(digitsOnly(event.target.value))}
              autoComplete="new-password"
            />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-crewly-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : configured ? 'Change PIN' : 'Set PIN'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

export default KioskPinCard;
