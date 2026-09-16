import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  MapPin,
  MonitorSmartphone,
  Plus,
  RefreshCw,
} from 'lucide-react';
import attendanceCaptureService from '../../services/attendanceCaptureService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import usePermission from '../../hooks/usePermission.js';

// Phase 31.14 — kiosk station management (HR/admin). Stations are
// trusted shared devices: the secret is shown ONCE at create /
// rotate and never again; rotation kills live kiosk sessions.
// Punching itself happens on the device, not on this page.

const KioskStationsPage = () => {
  const { hasPermission } = usePermission();
  const canManage = hasPermission('ATTENDANCE_CAPTURE_MANAGE');

  const [stations, setStations] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [once, setOnce] = useState(null); // { title, secret }
  const [form, setForm] = useState({ name: '', locationId: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [stationRes, locationRes] = await Promise.all([
        attendanceCaptureService.listStations(),
        attendanceLocationService.list().catch(() => ({ data: { locations: [] } })),
      ]);
      setStations(stationRes.data?.stations || []);
      setLocations(locationRes.data?.locations || locationRes.data || []);
    } catch (loadError) {
      setError(loadError?.message || 'Could not load kiosk stations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) load();
    else setLoading(false);
  }, [canManage, load]);

  if (!canManage) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-crewly-line bg-crewly-card p-6 text-crewly-dim">
          Kiosk stations are managed by HR. You don&apos;t have access to this page.
        </div>
      </div>
    );
  }

  const copySecret = async () => {
    if (!once?.secret) return;
    try {
      await navigator.clipboard.writeText(once.secret);
      setNotice('Secret copied to clipboard.');
    } catch {
      setNotice('Copy failed — select the secret text manually.');
    }
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await attendanceCaptureService.createStation({
        name: form.name.trim(),
        locationId: form.locationId || null,
      });
      setOnce({ title: `Station secret — ${res.data?.station?.name || ''}`, secret: res.data?.secret || '' });
      setForm({ name: '', locationId: '' });
      setNotice('Station registered. Store the secret now — it cannot be shown again.');
      await load();
    } catch (saveError) {
      setError(saveError?.message || 'Could not register the station');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (station) => {
    setError('');
    setNotice('');
    try {
      await attendanceCaptureService.updateStation(station.id, {
        status: station.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      });
      setNotice(
        station.status === 'ACTIVE'
          ? 'Station deactivated — its kiosk sessions stop working immediately.'
          : 'Station reactivated.'
      );
      await load();
    } catch (toggleError) {
      setError(toggleError?.message || 'Could not update the station');
    }
  };

  const handleRotate = async (station) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Rotate the secret for "${station.name}"? All kiosk sessions on this station stop working immediately.`)) {
      return;
    }
    setError('');
    setNotice('');
    try {
      const res = await attendanceCaptureService.rotateStationSecret(station.id);
      setOnce({ title: `New secret — ${station.name}`, secret: res.data?.secret || '' });
      setNotice('Secret rotated. Store the new secret now — it cannot be shown again.');
      await load();
    } catch (rotateError) {
      setError(rotateError?.message || 'Could not rotate the secret');
    }
  };

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-crewly-ink">
            <MonitorSmartphone className="h-5 w-5" /> Kiosk Stations
          </h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Trusted shared devices employees punch from. Every kiosk punch is station-attributed in
            immutable provenance.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-2 rounded-lg border border-crewly-line px-3 py-2 text-sm text-crewly-ink hover:bg-crewly-card"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-crewly-red/40 bg-crewly-red/10 p-4 text-sm text-crewly-red">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-green-500/40 bg-green-500/10 p-4 text-sm text-green-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      )}

      {once?.secret && (
        <div className="rounded-xl border border-crewly-orange/50 bg-crewly-orange/10 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-crewly-orange">
            <KeyRound className="h-4 w-4" /> {once.title} — shown once
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg bg-black/40 px-3 py-2 font-mono text-sm text-crewly-ink">
              {once.secret}
            </code>
            <button
              type="button"
              onClick={copySecret}
              className="inline-flex items-center gap-1 rounded-lg border border-crewly-line px-3 py-2 text-sm text-crewly-ink hover:bg-crewly-card"
            >
              <Copy className="h-4 w-4" /> Copy
            </button>
            <button
              type="button"
              onClick={() => setOnce(null)}
              className="rounded-lg px-3 py-2 text-sm text-crewly-dim hover:text-crewly-ink"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleCreate} className="rounded-xl border border-crewly-line bg-crewly-card p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-crewly-ink">
          <Plus className="h-4 w-4" /> Register a station
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block text-crewly-dim">Station name</span>
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="HQ Lobby Kiosk"
              maxLength={60}
              required
              className="w-full rounded-lg border border-crewly-line bg-transparent px-3 py-2 text-crewly-ink"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-crewly-dim">Location (optional binding)</span>
            <select
              value={form.locationId}
              onChange={(event) => setForm({ ...form, locationId: event.target.value })}
              className="w-full rounded-lg border border-crewly-line bg-transparent px-3 py-2 text-crewly-ink"
            >
              <option value="">No location binding</option>
              {(Array.isArray(locations) ? locations : []).map((location) => (
                <option key={location._id || location.id} value={location._id || location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-crewly-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving ? 'Registering…' : 'Register station'}
            </button>
          </div>
        </div>
      </form>

      <div className="overflow-hidden rounded-xl border border-crewly-line">
        <table className="w-full text-left text-sm">
          <thead className="bg-crewly-card text-crewly-dim">
            <tr>
              <th className="px-4 py-3 font-medium">Station</th>
              <th className="px-4 py-3 font-medium">Location</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last used</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-crewly-dim">Loading…</td></tr>
            )}
            {!loading && stations.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-crewly-dim">No stations yet.</td></tr>
            )}
            {stations.map((station) => (
              <tr key={station.id} className="border-t border-crewly-line">
                <td className="px-4 py-3 font-medium text-crewly-ink">{station.name}</td>
                <td className="px-4 py-3 text-crewly-dim">
                  {station.locationName ? (
                    <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{station.locationName}</span>
                  ) : '—'}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-1 text-xs ${station.status === 'ACTIVE' ? 'bg-green-500/15 text-green-300' : 'bg-crewly-red/15 text-crewly-red'}`}>
                    {station.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-crewly-dim">
                  {station.lastUsedAt ? new Date(station.lastUsedAt).toLocaleString() : 'Never'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleToggle(station)}
                      className="rounded-lg border border-crewly-line px-3 py-1.5 text-xs text-crewly-ink hover:bg-crewly-card"
                    >
                      {station.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRotate(station)}
                      className="rounded-lg border border-crewly-line px-3 py-1.5 text-xs text-crewly-ink hover:bg-crewly-card"
                    >
                      Rotate secret
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default KioskStationsPage;
