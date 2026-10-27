import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  KeyRound,
  MapPin,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  StepBack,
  Wifi,
} from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import usePermission from '../../hooks/usePermission.js';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';

// Phase 31.14 — kiosk station management (HR/admin). A station is a
// TRUSTED DEVICE, not an identity: the station secret authenticates the
// tablet, and each employee still proves themselves with their code and
// Kiosk PIN. The secret is shown exactly once (create/rotate) and only
// its hash is stored; rotating it kills every live station session.
//
// The mock's registry shows device model, IP, auth latency, heartbeats
// and MDM health. None of that exists: the station document carries a
// name, a location binding, a status, a secret version and a last-used
// stamp. So the table shows exactly those five facts, and the tiles say
// when a number is unavailable instead of printing a plausible one.

const PILL = 'rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider';

const fmtStamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const ago = (value) => {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'never';
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const Kpi = ({ label, value, unit, hint, icon: Icon, tone, bar, share = 100 }) => (
  <div className="rounded-xl bg-st-lowest p-4 shadow-sm">
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{label}</span>
      <span className={`rounded-lg p-1 ${tone}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className="text-2xl font-bold text-st-on tabular-nums">{value}</span>
      {unit ? <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{unit}</span> : null}
    </div>
    <p className="mt-0.5 text-[10px] leading-snug text-st-on-variant">{hint}</p>
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-st-high">
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
    </div>
  </div>
);

const CopyButton = ({ value, label, onDone }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
          onDone?.();
        } catch {
          notify.error('Copy failed — select the text manually.');
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded bg-st-low px-1.5 py-1 text-[9px] font-bold text-st-on-variant transition hover:text-st-on"
      aria-label={`Copy ${label}`}
    >
      {done ? <Check className="h-2.5 w-2.5" aria-hidden="true" /> : <Copy className="h-2.5 w-2.5" aria-hidden="true" />}
      {done ? 'Copied' : 'Copy'}
    </button>
  );
};

const KioskStationsPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canManage = hasPermission('ATTENDANCE_CAPTURE_MANAGE');

  const [stations, setStations] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [once, setOnce] = useState(null);
  const [form, setForm] = useState({ name: '', locationId: '' });
  const [saving, setSaving] = useState('');
  const [busyId, setBusyId] = useState('');
  const [query, setQuery] = useState('');
  const [showGuide, setShowGuide] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [stationRes, locationRes] = await Promise.all([
        attendanceCaptureService.listStations(),
        attendanceLocationService.list().catch(() => ({ data: { locations: [] } })),
      ]);
      setStations(stationRes.data?.stations || []);
      setLocations(locationRes.data?.locations || locationRes.data || []);
    } catch (err) {
      setError(err?.message || 'Could not load kiosk stations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManage) return undefined;
    let active = true;
    attendanceCaptureService.listStations()
      .then((res) => { if (active) setStations(res.data?.stations || []); })
      .catch((err) => {
        if (!active) return;
        setStations([]);
        setError(err?.message || 'Could not load kiosk stations');
      })
      .finally(() => { if (active) setLoading(false); });
    attendanceLocationService.list().then(
      (res) => { if (active) setLocations(res.data?.locations || res.data || []); },
      () => { if (active) setLocations([]); },
    );
    return () => { active = false; };
  }, [canManage]);

  const kioskUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/kiosk`;
  const active = stations.filter((station) => station.status === 'ACTIVE');
  const inactive = stations.filter((station) => station.status !== 'ACTIVE');
  const rotated = stations.filter((station) => Number(station.secretVersion) > 1);
  const lastActivity = stations
    .map((station) => (station.lastUsedAt ? new Date(station.lastUsedAt).getTime() : 0))
    .reduce((max, value) => Math.max(max, value), 0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return stations;
    return stations.filter((station) => [station.name, station.locationName, station.id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)));
  }, [stations, query]);

  const createStation = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    setSaving('create');
    setError('');
    try {
      const res = await attendanceCaptureService.createStation({
        name: form.name.trim(),
        locationId: form.locationId || null,
      });
      const station = res.data?.station;
      setOnce({ title: station?.name || form.name.trim(), secret: res.data?.secret || '', stationId: station?.id || '' });
      setForm({ name: '', locationId: '' });
      notify.success('Station registered. The secret is shown once — store it now.');
      await load({ silent: true });
    } catch (err) {
      setError(err?.message || 'Could not register the station');
    } finally {
      setSaving('');
    }
  };

  const toggleStatus = async (station) => {
    setBusyId(station.id);
    try {
      await attendanceCaptureService.updateStation(station.id, {
        status: station.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      });
      notify.success(
        station.status === 'ACTIVE'
          ? 'Station deactivated — its kiosk sessions stop working immediately.'
          : 'Station reactivated.',
      );
      await load({ silent: true });
    } catch (err) {
      notify.error(err, 'Could not update the station');
    } finally {
      setBusyId('');
    }
  };

  const rotate = async (station) => {
    if (!window.confirm(`Rotate the secret for “${station.name}”? Every kiosk session on this station stops working immediately.`)) {
      return;
    }
    setBusyId(station.id);
    try {
      const res = await attendanceCaptureService.rotateStationSecret(station.id);
      setOnce({ title: station.name, secret: res.data?.secret || '', stationId: station.id });
      notify.success('Secret rotated. The old secret and every open station session are dead.');
      await load({ silent: true });
    } catch (err) {
      notify.error(err, 'Could not rotate the secret');
    } finally {
      setBusyId('');
    }
  };

  if (permissionsLoading) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">Loading the kiosk fleet…</div>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Kiosk Stations</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            Kiosk stations are managed by HR. You don’t have the attendance-capture permission for this page.
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
              Hardware device registry · zero-trust station secrets
            </span>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">Kiosk Stations</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Trusted shared terminals employees punch from. Every kiosk punch is station-attributed in
              immutable provenance — the device proves the station, the employee proves themselves.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowGuide((value) => !value)}
              aria-expanded={showGuide}
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> Provisioning guide
            </button>
            <a
              href="#register-station"
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Register new kiosk
            </a>
            <button
              type="button"
              onClick={() => load()}
              className="rounded-lg bg-st-lowest p-2 text-st-on-variant shadow-sm transition hover:text-st-on"
              aria-label="Reload stations"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </section>

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-2.5 text-xs font-medium text-st-on-error-container">
            {error}
            <button type="button" onClick={() => load()} className="rounded bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on">
              Retry
            </button>
          </div>
        ) : null}

        {/* ── counters ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            label="Active terminals"
            value={active.length}
            unit="online"
            icon={MonitorSmartphone}
            tone="bg-st-secondary-container text-st-on-secondary-container"
            hint={`${inactive.length} inactive · ${stations.length} registered station${stations.length === 1 ? '' : 's'}`}
            bar="bg-st-secondary"
            share={stations.length ? (active.length / stations.length) * 100 : 0}
          />
          <Kpi
            label="Secret rotations"
            value={rotated.length}
            unit="stations"
            icon={KeyRound}
            tone="bg-st-primary-fixed text-st-on-primary-fixed-variant"
            hint={rotated.length
              ? `Highest version ${Math.max(...stations.map((station) => Number(station.secretVersion) || 1))}`
              : 'Every station is still on its first secret'}
            bar="bg-st-primary-container"
            share={stations.length ? (rotated.length / stations.length) * 100 : 0}
          />
          <Kpi
            label="Last station activity"
            value={lastActivity ? ago(new Date(lastActivity).toISOString()) : '—'}
            icon={Wifi}
            tone="bg-st-tertiary-fixed text-st-on-tertiary-fixed"
            hint={lastActivity
              ? `Stamp from the newest station record: ${fmtStamp(new Date(lastActivity).toISOString())}`
              : 'No station has ever authenticated'}
            bar="bg-st-tertiary"
            share={lastActivity ? 100 : 0}
          />
          <Kpi
            label="Punch telemetry"
            value="—"
            icon={AlertTriangle}
            tone="bg-st-high text-st-on-variant"
            hint="No per-station punch counter, auth latency or MDM heartbeat is exposed — this tile refuses to invent one"
            bar="bg-st-outline"
            share={0}
          />
        </div>

        {showGuide ? (
          <section className="rounded-xl bg-st-primary-fixed/40 p-4 shadow-sm">
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
              <ShieldCheck className="h-3.5 w-3.5 text-st-on-primary-fixed-variant" aria-hidden="true" />
              How a station works
            </h2>
            <ol className="mt-1.5 grid grid-cols-1 gap-2 text-[10px] leading-relaxed text-st-on-primary-fixed-variant sm:grid-cols-3">
              <li className="rounded-lg bg-st-lowest/70 px-2.5 py-2">
                <strong className="block text-[11px] text-st-on">1 · Register the device</strong>
                Give it a name and, optionally, the premises it stands at. The secret is generated once and
                shown once.
              </li>
              <li className="rounded-lg bg-st-lowest/70 px-2.5 py-2">
                <strong className="block text-[11px] text-st-on">2 · Open the terminal</strong>
                On the shared tablet open <code className="font-mono">/kiosk</code>, paste the station ID and the
                one-time secret. That secret signs the device in.
              </li>
              <li className="rounded-lg bg-st-lowest/70 px-2.5 py-2">
                <strong className="block text-[11px] text-st-on">3 · Employees identify themselves</strong>
                Code + Kiosk PIN per punch, then the punch confirms in their own session. Rotate or deactivate
                to revoke access instantly.
              </li>
            </ol>
          </section>
        ) : null}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          {/* ── register ─────────────────────────────────────────────── */}
          <form id="register-station" onSubmit={createStation} className="rounded-xl bg-st-lowest p-4 shadow-sm">
            <div className="flex items-start gap-2">
              <span className="rounded-lg bg-st-low p-1.5">
                <MonitorSmartphone className="h-4 w-4 text-st-outline" aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-sm font-bold text-st-on">Register a new kiosk terminal</h2>
                <p className="text-[10px] text-st-on-variant">
                  Authorises the device and issues its one-time secret. Nothing about the hardware is stored.
                </p>
              </div>
              <span className={`ml-auto shrink-0 ${PILL} bg-st-secondary-container text-st-on-secondary-container`}>
                Secret v1
              </span>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Station display name</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="HQ Lobby · Main Entrance"
                  maxLength={60}
                  required
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-xs text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                />
                <span className="mt-0.5 block text-[9px] text-st-on-variant">Unique per company — two “Reception”s would confuse everyone.</span>
              </label>
              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Location binding</span>
                <select
                  value={form.locationId}
                  onChange={(event) => setForm({ ...form, locationId: event.target.value })}
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-xs text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                >
                  <option value="">No location binding</option>
                  {(Array.isArray(locations) ? locations : []).map((location) => (
                    <option key={location._id || location.id} value={location._id || location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                <span className="mt-0.5 block text-[9px] text-st-on-variant">
                  Provenance for the station — not browser-GPS evidence.
                </span>
              </label>
            </div>

            <div className="mt-2.5 rounded-lg bg-st-low px-3 py-2">
              <p className="text-[10px] font-bold text-st-on">Employee identification on this station</p>
              <p className="mt-0.5 text-[9px] leading-relaxed text-st-on-variant">
                Employee code + Kiosk PIN, always. There is no per-station biometric, NFC or IP allow-list
                configuration in this build — a station authenticates the device, and the employee authenticates
                themselves. A PIN can be reset by the employee on their own profile; HR can only clear it.
              </p>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={saving === 'create' || !form.name.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95 disabled:opacity-50"
              >
                {saving === 'create' ? 'Registering…' : 'Register & generate secret'}
              </button>
              <span className="text-[9px] text-st-on-variant">
                The secret is returned exactly once. It is hashed at rest and never shown again.
              </span>
            </div>
          </form>

          {/* ── once-only secret + pairing ───────────────────────────── */}
          <div className="flex flex-col gap-3">
            {once?.secret ? (
              <section className="rounded-xl bg-st-primary-fixed/60 p-4 shadow-sm">
                <div className="flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 text-st-on-primary-fixed-variant" aria-hidden="true" />
                  <h2 className="text-sm font-bold text-st-on">Station secret — shown once</h2>
                  <button
                    type="button"
                    onClick={() => setOnce(null)}
                    className="ml-auto rounded bg-st-lowest/70 px-2 py-0.5 text-[9px] font-bold text-st-on"
                  >
                    Dismiss
                  </button>
                </div>
                <p className="mt-0.5 text-[10px] text-st-on-primary-fixed-variant">{once.title}</p>
                <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-st-lowest px-2.5 py-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-[10px] text-st-on">{once.secret}</code>
                  <CopyButton value={once.secret} label="station secret" onDone={() => {}} />
                </div>
                {once.stationId ? (
                  <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-st-lowest/70 px-2.5 py-1.5">
                    <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Station ID</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[9px] text-st-on">{once.stationId}</code>
                    <CopyButton value={once.stationId} label="station ID" />
                  </div>
                ) : null}
                <p className="mt-1.5 flex items-start gap-1 text-[9px] leading-snug text-st-on-primary-fixed-variant">
                  <AlertTriangle className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                  Paste both into the terminal now. Rotating the secret later invalidates every live station
                  session.
                </p>
              </section>
            ) : null}

            <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                <StepBack className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> Provision a shared terminal
              </h2>
              <p className="text-[10px] text-st-on-variant">Three steps on the physical tablet, in guided access.</p>
              <ol className="mt-2 space-y-1.5">
                {[
                  ['Launch the kiosk web app', kioskUrl],
                  ['Enter the station ID', active[0]?.id || 'shown in the table below'],
                  ['Enter the one-time secret', once?.secret ? 'from the panel above' : 'issued at register / rotate'],
                ].map(([title, detail], index) => (
                  <li key={title} className="flex items-start gap-2 rounded-lg bg-st-low px-2.5 py-2">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-st-secondary-container text-[9px] font-bold text-st-on-secondary-container">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-bold text-st-on">{title}</p>
                      <p className="break-all font-mono text-[9px] text-st-on-variant">{detail}</p>
                    </div>
                    {index === 0 ? <CopyButton value={kioskUrl} label="kiosk URL" /> : null}
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-[9px] leading-relaxed text-st-on-variant">
                The terminal’s session is a station JWT: rotating the secret or deactivating the station signs
                it out at its next call. There is no remote-wipe, no screenshot and no camera feed.
              </p>
            </section>
          </div>
        </div>

        {/* ── device table ─────────────────────────────────────────────── */}
        <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <h2 className="text-sm font-bold text-st-on">Active terminal devices</h2>
            <span className="text-[10px] text-st-on-variant">
              {stations.length} registered · {active.length} active
            </span>
            <label className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-st-outline" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={60}
                placeholder="Search stations, locations…"
                className="w-48 rounded-lg bg-st-low py-1.5 pl-7 pr-2 text-[10px] text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Search stations"
              />
            </label>
          </div>

          <div className="overflow-x-auto border-t border-st-high/60">
            <table className="w-full min-w-[48rem] text-left">
              <thead>
                <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                  <th className="py-2 pl-4 pr-2 font-bold">Station name &amp; ID</th>
                  <th className="px-2 py-2 font-bold">Bound location</th>
                  <th className="px-2 py-2 text-right font-bold">Secret</th>
                  <th className="px-2 py-2 font-bold">Last used</th>
                  <th className="px-2 py-2 font-bold">Status</th>
                  <th className="py-2 pl-2 pr-4 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((station) => (
                  <tr key={station.id} className="border-b border-st-high/50 hover:bg-st-low">
                    <td className="py-2.5 pl-4 pr-2">
                      <span className="flex items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-st-low text-st-secondary">
                          <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] font-bold text-st-on">{station.name}</span>
                          <span className="block truncate font-mono text-[9px] text-st-on-variant">{station.id}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-[10px] text-st-on-variant">
                      {station.locationName ? (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-2.5 w-2.5" aria-hidden="true" /> {station.locationName}
                        </span>
                      ) : (
                        <span className="rounded bg-st-low px-1.5 py-0.5 text-[9px]">unbound</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right text-[10px] tabular-nums text-st-on-variant">v{station.secretVersion ?? 1}</td>
                    <td className="px-2 py-2.5 text-[10px]">
                      <span className="block text-st-on">{ago(station.lastUsedAt)}</span>
                      <span className="block text-[9px] text-st-on-variant">
                        {station.lastUsedAt ? fmtStamp(station.lastUsedAt) : 'never authenticated'}
                      </span>
                    </td>
                    <td className="px-2 py-2.5">
                      <span className={`${PILL} ${
                        station.status === 'ACTIVE'
                          ? 'bg-st-secondary-container text-st-on-secondary-container'
                          : 'bg-st-high text-st-on-variant'
                      }`}>
                        {station.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="py-2.5 pl-2 pr-4">
                      <span className="flex flex-wrap items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => rotate(station)}
                          disabled={busyId === station.id}
                          className="rounded bg-st-low px-1.5 py-1 text-[9px] font-bold text-st-on-variant transition hover:text-st-on disabled:opacity-50"
                        >
                          Rotate secret
                        </button>
                        <CopyButton value={station.id} label={`${station.name} station ID`} />
                        <button
                          type="button"
                          onClick={() => toggleStatus(station)}
                          disabled={busyId === station.id}
                          className={`rounded px-1.5 py-1 text-[9px] font-bold transition disabled:opacity-50 ${
                            station.status === 'ACTIVE'
                              ? 'bg-st-error-container text-st-on-error-container hover:opacity-90'
                              : 'bg-st-secondary-container text-st-on-secondary-container hover:opacity-90'
                          }`}
                        >
                          {station.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
                {!loading && filtered.length === 0 ? (
                  <TableEmpty
                    colSpan={6}
                    illustration="box"
                    title={stations.length ? 'No station matches that search' : 'No kiosk stations yet'}
                    description={
                      stations.length
                        ? 'Clear the search to see the whole fleet.'
                        : 'A station is a shared tablet at a site. Register one above, then sign the terminal in with its one-time secret.'
                    }
                  />
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-st-high/60 px-4 py-2 text-[10px] text-st-on-variant">
            <span>
              Showing {filtered.length} of {stations.length} registered station{stations.length === 1 ? '' : 's'}
              {inactive.length ? ` · ${inactive.length} not accepting punches` : ''}
            </span>
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              No heartbeat or firmware state exists — “last used” is the newest recorded call.
            </span>
          </div>
        </section>

        <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[10px] leading-relaxed text-st-on-variant">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-secondary" aria-hidden="true" />
          <span>
            <strong className="font-semibold text-st-on">Device trust, not surveillance.</strong> The station
            secret is stored as a hash, shown once, and rotated on request. Punches carry the station as
            provenance; nothing on this page captures a screen, a camera or an employee’s location. Kiosk punch
            history lives in each employee’s month on{' '}
            <Link to="/app/attendance/team-timesheets" className="font-bold text-st-primary hover:underline">
              Team Timesheets
            </Link>
            .
          </span>
        </p>
      </div>
    </div>
  );
};

export default KioskStationsPage;
