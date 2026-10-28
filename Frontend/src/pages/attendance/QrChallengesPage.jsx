import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  Copy,
  Fingerprint,
  History,
  MapPin,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Timer,
  Wifi,
} from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import attendanceService from '../../services/attendanceService.js';
import usePermission from '../../hooks/usePermission.js';
import { notify } from '../../utils/notify.js';

// Phase 31.14 — QR challenge issuance (HR/admin). A challenge binds an
// authenticated employee session to a PLACE for five minutes: the token
// is hashed at rest, single-use, and the punch itself happens in the
// employee's own session. Admin-side QR is therefore an ISSUING screen —
// the API exposes create/resolve/redeem and nothing else.
//
// What the mock adds but the platform does not have: a scan telemetry
// feed, a daily session summary, a historical challenge log, HMAC /
// Wi-Fi / device-posture chips, and a 2/5/10-minute expiry picker. All
// of those are shown as fixed facts or as an explicit "not exposed"
// block — with the two things that ARE real (the capture mix from
// Attendance Analytics and the audit trail) linked instead.

const PILL = 'rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider';
const TTL_MINUTES = 5;

const fmtClock = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
};

const mmss = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const Card = ({ title, icon: Icon, badge = null, note = null, children, className = '' }) => (
  <section className={`rounded-xl bg-st-lowest p-4 shadow-sm ${className}`}>
    <div className="flex items-start gap-2">
      <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
        {Icon ? <Icon className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> : null}
        {title}
      </h2>
      {badge ? <span className={`ml-auto shrink-0 ${PILL} bg-st-high text-st-on-variant`}>{badge}</span> : null}
    </div>
    {note ? <p className="mt-1 text-[10px] leading-relaxed text-st-on-variant">{note}</p> : null}
    <div className="mt-2.5">{children}</div>
  </section>
);

const QrChallengesPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canManage = hasPermission('ATTENDANCE_CAPTURE_MANAGE');
  const canAnalyze = hasPermission('ATTENDANCE_ANALYTICS_READ');

  const [locations, setLocations] = useState([]);
  const [stations, setStations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [stationId, setStationId] = useState('');
  const [issued, setIssued] = useState(null);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const [sources, setSources] = useState(null);
  const [sourcesError, setSourcesError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!canManage) return;
    attendanceLocationService.list().then(
      (res) => setLocations(res.data?.locations || res.data || []),
      () => setLocations([]),
    );
    attendanceCaptureService.listStations().then(
      (res) => setStations((res.data?.stations || []).filter((station) => station.status === 'ACTIVE')),
      () => setStations([]),
    );
  }, [canManage]);

  // Capture mix for the current month, straight from the analytics
  // endpoint — the only real QR aggregate the API publishes.
  const month = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const [reloadSources, setReloadSources] = useState(0);

  // The overview endpoint is the only real QR aggregate; it needs
  // ATTENDANCE_ANALYTICS_READ, so a missing permission degrades to a
  // sentence rather than an error toast.
  useEffect(() => {
    if (!canAnalyze) return undefined;
    let active = true;
    attendanceService.analyticsOverview({ month })
      .then((res) => {
        if (!active) return;
        const data = res?.data ?? res;
        setSources(data?.sources || null);
        setSourcesError('');
      })
      .catch((err) => {
        if (!active) return;
        setSources(null);
        setSourcesError(err?.message || 'Capture mix unavailable for your role');
      });
    return () => { active = false; };
  }, [canAnalyze, month, reloadSources]);

  // Live countdown for the issued challenge (server owns expiresAt).
  // The tick seeds the clock in the interval callback, never in the
  // effect body, so no render cascades out of this effect.
  useEffect(() => {
    if (!issued?.expiresAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [issued]);

  const remainingMs = issued?.expiresAt ? Date.parse(issued.expiresAt) - now : 0;

  const selectedLocation = locations.find((row) => (row._id || row.id) === locationId) || null;
  const expired = Boolean(issued) && remainingMs <= 0;
  const punchUrl = issued ? `${typeof window !== 'undefined' ? window.location.origin : ''}${issued.punchPath || ''}` : '';

  const issue = async (event) => {
    event?.preventDefault?.();
    setIssuing(true);
    setError('');
    try {
      const res = await attendanceCaptureService.createChallenge({
        locationId: locationId || null,
        stationId: stationId || null,
      });
      setIssued(res.data || null);
      setNow(Date.now());
      notify.success('Challenge issued — it expires in 5 minutes and can be redeemed once.');
    } catch (err) {
      setError(err?.message || 'Could not issue the challenge');
    } finally {
      setIssuing(false);
    }
  };

  const copy = async (value, key) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(''), 1600);
    } catch {
      notify.error('Copy failed — select the text manually.');
    }
  };

  const qrShare = useMemo(() => {
    if (!sources?.counts) return null;
    const total = Number(sources.total) || 0;
    const qr = Number(sources.counts.QR) || 0;
    return {
      total,
      qr,
      pct: total ? Math.round((qr / total) * 1000) / 10 : 0,
      entries: Object.entries(sources.counts).sort((a, b) => b[1] - a[1]),
    };
  }, [sources]);

  if (permissionsLoading) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">Loading QR controls…</div>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">QR Challenges</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            QR challenges are issued by HR. You don’t have the attendance-capture permission for this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
              On-premise verification · QR challenges
            </span>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">QR Challenges</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Single-use codes bound to a premises. Employees scan with their own phone and confirm the punch
              in their own session.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${PILL} bg-st-secondary-container text-st-on-secondary-container`}>
              Token engine · sha-256 · single use
            </span>
            {issued && !expired ? (
              <a
                href={issued.punchPath}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95"
              >
                <ScanLine className="h-3.5 w-3.5" aria-hidden="true" /> Project to kiosk display
              </a>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-3 py-2 text-[11px] font-bold text-st-on-variant">
                <ScanLine className="h-3.5 w-3.5" aria-hidden="true" /> Issue a code to project it
              </span>
            )}
            <Link
              to="/app/attendance/kiosks"
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low"
            >
              Kiosk stations
            </Link>
          </div>
        </section>

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-2.5 text-xs font-medium text-st-on-error-container">
            {error}
            <button type="button" onClick={() => issue()} className="rounded bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on">
              Retry
            </button>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ── issue ─────────────────────────────────────────────────── */}
          <form onSubmit={issue} className="flex flex-col gap-3">
            <Card
              title="Issue geofenced challenge"
              icon={QrCode}
              badge="5-minute TTL"
              note="A challenge must bind to a location or a station — that binding is stamped into the punch provenance."
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Designated workplace</span>
                  <select
                    value={locationId}
                    onChange={(event) => setLocationId(event.target.value)}
                    className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-xs text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  >
                    <option value="">No location binding</option>
                    {locations.map((location) => (
                      <option key={location._id || location.id} value={location._id || location.id}>
                        {location.name}
                        {location.isActive === false ? ' (inactive)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Terminal / pod binding</span>
                  <select
                    value={stationId}
                    onChange={(event) => setStationId(event.target.value)}
                    className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-xs text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  >
                    <option value="">No station binding</option>
                    {stations.map((station) => (
                      <option key={station.id} value={station.id}>{station.name}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-lg bg-st-low px-2.5 py-2">
                  <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Expiry window</span>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-st-on">
                    <Timer className="h-3 w-3 text-st-outline" aria-hidden="true" /> {TTL_MINUTES}:00 minutes
                  </p>
                  <p className="text-[9px] leading-snug text-st-on-variant">
                    Fixed server-side by the QR rules — there is no 2/10-minute option to pick.
                  </p>
                </div>
                <div className="rounded-lg bg-st-low px-2.5 py-2">
                  <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Challenge binding</span>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-st-on">
                    <MapPin className="h-3 w-3 text-st-outline" aria-hidden="true" />
                    {selectedLocation?.name || (stationId ? stations.find((s) => s.id === stationId)?.name : '') || 'Not bound yet'}
                  </p>
                  <p className="text-[9px] leading-snug text-st-on-variant">
                    {selectedLocation
                      ? `${Number(selectedLocation.radiusMeters) || 0} m geofence · premises ${Number(selectedLocation.latitude).toFixed(4)}, ${Number(selectedLocation.longitude).toFixed(4)}`
                      : 'Coordinates shown here are company premises, never people.'}
                  </p>
                </div>
              </div>

              <div className="mt-2 rounded-lg bg-st-low px-2.5 py-2">
                <p className="text-[10px] font-bold text-st-on">What the server verifies on redemption</p>
                <ul className="mt-1 space-y-0.5 text-[9px] leading-relaxed text-st-on-variant">
                  <li className="flex items-start gap-1">
                    <CheckCircle2 className="mt-0.5 h-2.5 w-2.5 shrink-0 text-st-secondary" aria-hidden="true" />
                    Token hash, tenant, purpose, expiry and single use — checked atomically, one winner.
                  </li>
                  <li className="flex items-start gap-1">
                    <CheckCircle2 className="mt-0.5 h-2.5 w-2.5 shrink-0 text-st-secondary" aria-hidden="true" />
                    The employee’s own session supplies identity; the token never carries it.
                  </li>
                  <li className="flex items-start gap-1">
                    <CheckCircle2 className="mt-0.5 h-2.5 w-2.5 shrink-0 text-st-secondary" aria-hidden="true" />
                    If policy requires a geofence, the one-shot position is measured against the bound premises.
                  </li>
                </ul>
                <div className="mt-1 flex flex-wrap gap-1">
                  {['No HMAC chip', 'No Wi-Fi BSSID check', 'No liveness capture'].map((label) => (
                    <span key={label} className={`${PILL} bg-st-high text-st-on-variant`}>{label}</span>
                  ))}
                </div>
                <Link to="/app/attendance/policy" className="mt-1 inline-flex items-center gap-1 text-[9px] font-bold text-st-primary hover:underline">
                  Geofence policy <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
                </Link>
              </div>

              <button
                type="submit"
                disabled={issuing || (!locationId && !stationId)}
                className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary transition hover:opacity-95 disabled:opacity-50"
              >
                {issuing ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Issuing…
                  </>
                ) : (
                  <>
                    <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
                    {issued ? 'Issue a fresh QR code' : 'Issue dynamic QR code'}
                  </>
                )}
              </button>
              <p className="mt-1 text-center text-[9px] text-st-on-variant">
                Issuing revokes nothing — an older code simply expires on its own and can never be redeemed
                twice.
              </p>
            </Card>
          </form>

          {/* ── live challenge ────────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <Card
              title="Live challenge"
              icon={ShieldCheck}
              badge={issued ? (expired ? 'Expired' : 'Active') : 'None issued'}
              note={issued
                ? `${issued.challenge?.locationName || 'No location'}${issued.challenge?.stationName ? ` · ${issued.challenge.stationName}` : ''}`
                : 'The code appears here the moment it is issued. Nothing is cached after it expires.'}
            >
              {issued ? (
                <>
                  <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                    <div className={`rounded-xl bg-st-lowest p-3 shadow-sm ${expired ? 'opacity-40 grayscale' : ''}`}>
                      <QRCodeSVG value={punchUrl} size={148} bgColor="#ffffff" fgColor="#161d17" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold ${
                        expired
                          ? 'bg-st-error-container text-st-on-error-container'
                          : 'bg-st-secondary-container text-st-on-secondary-container'
                      }`}>
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        {expired ? 'Expired — issue a fresh code' : `Expires in ${mmss(remainingMs)}`}
                      </div>
                      <dl className="mt-2 space-y-1 text-[10px]">
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-st-on-variant">Issued</dt>
                          <dd className="font-semibold text-st-on">
                            {issued.challenge?.createdAt ? fmtClock(issued.challenge.createdAt) : fmtClock(new Date())}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-st-on-variant">Expires</dt>
                          <dd className="font-semibold text-st-on">{fmtClock(issued.expiresAt)}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-st-on-variant">Challenge id</dt>
                          <dd className="truncate font-mono text-[9px] text-st-on">{issued.challenge?.id}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-st-on-variant">Redeemed</dt>
                          <dd className="font-semibold text-st-on">
                            {issued.challenge?.usedAt ? fmtClock(issued.challenge.usedAt) : 'not yet'}
                          </dd>
                        </div>
                      </dl>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => copy(punchUrl, 'link')}
                          className="inline-flex items-center gap-1 rounded bg-st-low px-1.5 py-1 text-[9px] font-bold text-st-on-variant transition hover:text-st-on"
                        >
                          <Copy className="h-2.5 w-2.5" aria-hidden="true" /> {copied === 'link' ? 'Copied' : 'Copy punch link'}
                        </button>
                        <button
                          type="button"
                          onClick={issue}
                          disabled={issuing}
                          className="inline-flex items-center gap-1 rounded bg-st-low px-1.5 py-1 text-[9px] font-bold text-st-on-variant transition hover:text-st-on disabled:opacity-50"
                        >
                          <RefreshCw className="h-2.5 w-2.5" aria-hidden="true" /> Regenerate now
                        </button>
                        <span className={`${PILL} bg-st-high text-st-on-variant`}>single use</span>
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 flex items-start gap-1 text-[9px] leading-snug text-st-on-variant">
                    <Fingerprint className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                    The raw token exists in this browser and in the QR pixels only — the server keeps its sha-256
                    hash. “Expire immediately” is absent because revoking an issued token is not an endpoint; a
                    five-minute TTL is the bound.
                  </p>
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-st-high px-3 py-6 text-center">
                  <QrCode className="mx-auto h-6 w-6 text-st-outline" aria-hidden="true" />
                  <p className="mt-1.5 text-[11px] font-bold text-st-on">No live challenge</p>
                  <p className="text-[10px] text-st-on-variant">
                    Choose a workplace or a station and issue one. It will be valid for {TTL_MINUTES} minutes.
                  </p>
                </div>
              )}
            </Card>

            {/* The mock's scan feed has no endpoint; the real aggregate does. */}
            <Card
              title="Scan evidence"
              icon={ScanLine}
              badge={`${month}`}
              note="There is no per-scan feed to subscribe to: redemption is written straight into the punch ledger."
            >
              {sourcesError ? (
                <div className="rounded-lg bg-st-high px-2.5 py-2">
                  <p className="text-[10px] text-st-on-variant">{sourcesError}</p>
                  <button
                    type="button"
                    onClick={() => setReloadSources((value) => value + 1)}
                    className="mt-1 inline-flex items-center gap-1 rounded bg-st-lowest px-1.5 py-1 text-[9px] font-bold text-st-on"
                  >
                    <RefreshCw className="h-2.5 w-2.5" aria-hidden="true" /> Try again
                  </button>
                </div>
              ) : qrShare ? (
                <>
                  <div className="flex items-end justify-between gap-2 rounded-lg bg-st-low px-3 py-2">
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">QR punches this month</p>
                      <p className="text-xl font-bold text-st-on tabular-nums">{qrShare.qr}</p>
                    </div>
                    <p className="pb-1 text-[10px] font-bold text-st-on-variant">
                      {qrShare.pct}% of {qrShare.total.toLocaleString('en-IN')} punches
                    </p>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {qrShare.entries.map(([source, count]) => {
                      const pct = qrShare.total ? Math.round((count / qrShare.total) * 1000) / 10 : 0;
                      return (
                        <li key={source}>
                          <div className="flex items-center justify-between gap-2 text-[10px]">
                            <span className={`font-semibold ${source === 'QR' ? 'text-st-on' : 'text-st-on-variant'}`}>{source}</span>
                            <span className="text-st-on-variant">{pct}% ({count})</span>
                          </div>
                          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-st-high">
                            <div
                              className={`h-full rounded-full ${source === 'QR' ? 'bg-st-secondary' : 'bg-st-outline'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <Link to="/app/attendance/analytics" className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
                    Full capture mix in analytics <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
                  </Link>
                </>
              ) : (
                <p className="text-[10px] text-st-on-variant">Reading this month’s capture mix…</p>
              )}
            </Card>
          </div>
        </div>

        {/* ── what is not exposed ──────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card
            title="Scan telemetry feed"
            icon={Wifi}
            badge="Not exposed"
            note="No live scan feed — the API writes the punch and returns it."
          >
            <p className="text-[10px] leading-relaxed text-st-on-variant">
              The mock’s live feed (employee, GPS delta, BSSID, verdict) does not exist here. What does exist is
              the punch each employee received — visible in their month on Team Timesheets — and the capture
              mix above.
            </p>
            <Link to="/app/attendance/team-timesheets" className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
              Open team timesheets <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
            </Link>
          </Card>

          <Card
            title="Challenge audit trail"
            icon={History}
            badge="Audit log"
            note="Audited as ATTENDANCE_QR_CHALLENGE_CREATED — id, place, expiry, never the token."
          >
            <p className="text-[10px] leading-relaxed text-st-on-variant">
              Challenge rows themselves are ephemeral: a TTL index reaps them minutes after expiry, so there is
              no historical challenge list to page through. The durable record is the security audit log.
            </p>
            <Link to="/app/security/audit-logs" className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
              Open the audit log <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
            </Link>
          </Card>

          <Card
            title="Anti-spoof posture"
            icon={ShieldCheck}
            badge="By construction"
            note="Short-lived, single-use, tenant-scoped, hash-at-rest, session-bound identity."
          >
            <ul className="space-y-0.5 text-[10px] leading-relaxed text-st-on-variant">
              <li>· A forwarded screenshot dies within {TTL_MINUTES} minutes.</li>
              <li>· A second scan of the same code is refused — the first claim wins.</li>
              <li>· A code from another company resolves as not found.</li>
              <li>· No token is ever logged, queued or shown again after issuance.</li>
            </ul>
            <p className="mt-1 text-[9px] text-st-on-variant">
              No &ldquo;anti-screenshot watermark&rdquo; or device-posture claim is made — those would be new
              capabilities, not documentation of this build.
            </p>
          </Card>
        </div>

        <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[10px] leading-relaxed text-st-on-variant">
          <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-outline" aria-hidden="true" />
          <span>
            <strong className="font-semibold text-st-on">Place, not person.</strong> A challenge proves someone
            was standing in front of a fresh workplace code. The employee still authenticates, the punch is
            stamped with the challenge’s place, and no employee coordinates are stored or displayed on this
            screen.
          </span>
        </p>
      </div>
    </div>
  );
};

export default QrChallengesPage;
