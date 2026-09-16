import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, MapPin, QrCode } from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';

// Phase 31.14 — employee QR punch (scan → confirm → punch). The URL
// carries the token to the SPA route only; resolve + redeem are
// POST calls with the token in the body. GET never punches.
// Identity comes from the employee's own session.

const ACTION_LABELS = {
  CLOCK_IN: 'Clock in',
  BREAK_START: 'Start break',
  BREAK_END: 'End break',
  CLOCK_OUT: 'Clock out',
};

const QrPunchPage = () => {
  const { token } = useParams();
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [redeeming, setRedeeming] = useState('');
  const [done, setDone] = useState(null);

  const resolve = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await attendanceCaptureService.resolveChallenge(token);
      setPreview(res.data);
    } catch (resolveError) {
      const status = resolveError?.response?.status || resolveError?.status;
      if (status === 410) {
        setError('This QR code has expired or was already used. Please scan a fresh one at the workplace.');
      } else if (status === 404) {
        setError('This QR code was not recognized. Please scan a fresh one at the workplace.');
      } else {
        setError(resolveError?.message || 'Could not read this QR code');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    resolve();
  }, [resolve]);

  const handleRedeem = async (action) => {
    setRedeeming(action);
    setError('');
    try {
      const res = await attendanceCaptureService.redeemChallenge({
        token,
        action,
        idempotencyKey: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
      });
      setDone({ action, event: res.data?.event || res.data });
    } catch (redeemError) {
      const status = redeemError?.response?.status || redeemError?.status;
      if (status === 410) {
        setError('This QR code has expired or was already used. Please scan a fresh one at the workplace.');
      } else {
        setError(redeemError?.message || 'Could not record the punch');
      }
    } finally {
      setRedeeming('');
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-5 p-6">
      <div className="text-center">
        <h1 className="flex items-center justify-center gap-2 text-xl font-semibold text-crewly-ink">
          <QrCode className="h-5 w-5" /> QR Punch
        </h1>
        {preview && !done && (
          <p className="mt-1 flex items-center justify-center gap-1 text-sm text-crewly-dim">
            <MapPin className="h-4 w-4" />
            {preview.locationName || preview.stationName || 'Workplace'}
            {preview.stationName && preview.locationName ? ` · ${preview.stationName}` : ''}
          </p>
        )}
      </div>

      {loading && (
        <div className="rounded-xl border border-crewly-line bg-crewly-card p-6 text-center text-crewly-dim">
          Reading the QR code…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-crewly-red/40 bg-crewly-red/10 p-4 text-sm text-crewly-red">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {done && (
        <div className="rounded-xl border border-green-500/40 bg-green-500/10 p-6 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-green-300" />
          <div className="mt-2 font-semibold text-green-200">
            {ACTION_LABELS[done.action] || done.action} recorded
          </div>
          <Link to="/app/attendance" className="mt-3 inline-block text-sm text-crewly-dim underline hover:text-crewly-ink">
            Back to My Attendance
          </Link>
        </div>
      )}

      {preview && !done && !loading && (
        <div className="space-y-3 rounded-xl border border-crewly-line bg-crewly-card p-6">
          <p className="text-center text-sm text-crewly-dim">
            Confirm your punch as <span className="font-semibold text-crewly-ink">{preview.employeeCode}</span>
          </p>
          {(preview.allowedActions || []).map((action) => (
            <button
              key={action}
              type="button"
              disabled={!!redeeming}
              onClick={() => handleRedeem(action)}
              className="w-full rounded-lg bg-crewly-accent px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {redeeming === action ? 'Recording…' : ACTION_LABELS[action] || action}
            </button>
          ))}
          {!(preview.allowedActions || []).length && (
            <p className="text-center text-sm text-crewly-dim">No actions available right now.</p>
          )}
        </div>
      )}
    </div>
  );
};

export default QrPunchPage;
