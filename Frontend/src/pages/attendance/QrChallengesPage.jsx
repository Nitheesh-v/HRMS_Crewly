import { useEffect, useState } from 'react';
import { AlertTriangle, QrCode, RefreshCw, Timer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import usePermission from '../../hooks/usePermission.js';

// Phase 31.14 — QR challenge issuance (HR/admin). Each challenge is
// single-use and expires in 5 minutes; the QR encodes an SPA path,
// and the token itself travels in POST bodies only. Challenges are
// ephemeral by design — this page issues and displays, never lists.

const TICK_MS = 1000;

const QrChallengesPage = () => {
  const { hasPermission } = usePermission();
  const canManage = hasPermission('ATTENDANCE_CAPTURE_MANAGE');

  const [locations, setLocations] = useState([]);
  const [stations, setStations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [stationId, setStationId] = useState('');
  const [issued, setIssued] = useState(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canManage) return;
    attendanceLocationService.list().then(
      (res) => setLocations(res.data?.locations || res.data || []),
      () => setLocations([])
    );
    attendanceCaptureService.listStations().then(
      (res) => setStations((res.data?.stations || []).filter((s) => s.status === 'ACTIVE')),
      () => setStations([])
    );
  }, [canManage]);

  useEffect(() => {
    if (!issued?.expiresAt) return;
    const update = () => setRemainingMs(Date.parse(issued.expiresAt) - Date.now());
    update();
    const timer = setInterval(update, TICK_MS);
    return () => clearInterval(timer);
  }, [issued]);

  if (!canManage) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-crewly-line bg-crewly-card p-6 text-crewly-dim">
          QR challenges are issued by HR. You don&apos;t have access to this page.
        </div>
      </div>
    );
  }

  const expired = issued && remainingMs <= 0;
  const mmss = expired
    ? 'expired'
    : `${Math.floor(Math.max(remainingMs, 0) / 60000)}:${String(Math.floor((Math.max(remainingMs, 0) % 60000) / 1000)).padStart(2, '0')}`;

  const handleIssue = async (event) => {
    event.preventDefault();
    setIssuing(true);
    setError('');
    try {
      const res = await attendanceCaptureService.createChallenge({
        locationId: locationId || null,
        stationId: stationId || null,
      });
      setIssued(res.data);
    } catch (issueError) {
      setError(issueError?.message || 'Could not issue the challenge');
    } finally {
      setIssuing(false);
    }
  };

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-crewly-ink">
          <QrCode className="h-5 w-5" /> QR Challenges
        </h1>
        <p className="mt-1 text-sm text-crewly-dim">
          Issue a single-use 5-minute QR code bound to a place. Employees scan it with their phone
          and confirm the punch in their own authenticated session.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-crewly-red/40 bg-crewly-red/10 p-4 text-sm text-crewly-red">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <form onSubmit={handleIssue} className="rounded-xl border border-crewly-line bg-crewly-card p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block text-crewly-dim">Location</span>
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              className="w-full rounded-lg border border-crewly-line bg-transparent px-3 py-2 text-crewly-ink"
            >
              <option value="">Select a location…</option>
              {(Array.isArray(locations) ? locations : []).map((location) => (
                <option key={location._id || location.id} value={location._id || location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-crewly-dim">Station (optional)</span>
            <select
              value={stationId}
              onChange={(event) => setStationId(event.target.value)}
              className="w-full rounded-lg border border-crewly-line bg-transparent px-3 py-2 text-crewly-ink"
            >
              <option value="">No station</option>
              {stations.map((station) => (
                <option key={station.id} value={station.id}>{station.name}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={issuing || (!locationId && !stationId)}
              className="rounded-lg bg-crewly-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {issuing ? 'Issuing…' : 'Issue QR code'}
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-crewly-dim">
          A challenge must bind to a location or a station — that binding is stamped into the punch provenance.
        </p>
      </form>

      {issued && (
        <div className="rounded-xl border border-crewly-line bg-crewly-card p-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-crewly-orange/15 px-3 py-1 text-sm text-crewly-orange">
            <Timer className="h-4 w-4" /> {expired ? 'Expired — issue a fresh code' : `Expires in ${mmss}`}
          </div>
          <div className={`mx-auto mt-4 w-fit rounded-2xl bg-white p-4 ${expired ? 'opacity-30 grayscale' : ''}`}>
            <QRCodeSVG value={`${window.location.origin}${issued.punchPath}`} size={220} />
          </div>
          <p className="mt-3 text-sm text-crewly-dim">
            {issued.challenge?.locationName || ''}{' '}
            {issued.challenge?.stationName ? `· ${issued.challenge.stationName}` : ''}
          </p>
          <button
            type="button"
            onClick={handleIssue}
            disabled={issuing}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-crewly-line px-3 py-2 text-sm text-crewly-ink hover:bg-crewly-card"
          >
            <RefreshCw className="h-4 w-4" /> Issue a fresh code
          </button>
        </div>
      )}
    </div>
  );
};

export default QrChallengesPage;
