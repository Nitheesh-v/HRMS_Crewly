// ============================================================
// 👤 MY PROFILE — self-service profile for EVERY role
// Photo upload (Cloudinary), personal info, address, emergency
// contact. Employment details are read-only (HR controls them).
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import profileService from '../../services/profileService';

const errMsg = (err, fb) =>
  err?.response?.data?.message || err?.data?.message || err?.message || fb;

// label + value read-only row
const InfoRow = ({ label, value }) => (
  <div>
    <p className="text-[11px] uppercase tracking-wide text-crewly-dim">{label}</p>
    <p className="mt-0.5 text-sm font-medium">{value || '—'}</p>
  </div>
);

const MyProfilePage = () => {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await profileService.getMe();
      setProfile(res?.data || res);
    } catch (err) {
      setError(errMsg(err, 'Failed to load profile'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // dotted-path setter: setField('address.city', 'Chennai')
  const setField = (path, value) =>
    setProfile((p) => {
      const next = JSON.parse(JSON.stringify(p || {}));
      const keys = path.split('.');
      let cur = next;
      keys.slice(0, -1).forEach((k) => { cur[k] = cur[k] || {}; cur = cur[k]; });
      cur[keys[keys.length - 1]] = value;
      return next;
    });

  // ── photo upload (instant) ────────────────────────────────────────
  const onPickPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setUploading(true);
    setError('');
    setNotice('');
    try {
      const res = await profileService.uploadAvatar(file);
      const url = res?.avatarUrl || res?.data?.avatarUrl;
      setProfile((p) => ({ ...p, avatarUrl: url || p?.avatarUrl }));
      setNotice('Photo updated! (Topbar shows it after next login) 📸');
    } catch (err) {
      setError(errMsg(err, 'Photo upload failed'));
    } finally {
      setUploading(false);
      setPreview('');
    }
  };

  const onRemovePhoto = async () => {
    setUploading(true);
    setError('');
    try {
      await profileService.removeAvatar();
      setProfile((p) => ({ ...p, avatarUrl: '' }));
      setNotice('Photo removed');
    } catch (err) {
      setError(errMsg(err, 'Remove failed'));
    } finally {
      setUploading(false);
    }
  };

  // ── save editable sections ────────────────────────────────────────
  const onSave = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        phone: profile.phone || '',
        gender: profile.gender || '',
        dateOfBirth: profile.dateOfBirth || null,
        address: profile.address || {},
        emergencyContact: profile.emergencyContact || {},
      };
      const res = await profileService.updateMe(payload);
      setProfile(res?.data || res);
      setNotice('Profile saved ✅');
    } catch (err) {
      setError(errMsg(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !profile) return <p className="text-crewly-dim">Loading profile…</p>;
  if (!profile) return <p className="text-crewly-red">{error || 'Profile unavailable'}</p>;

  const dobValue = profile.dateOfBirth ? String(profile.dateOfBirth).slice(0, 10) : '';
  const photoSrc = preview || profile.avatarUrl;

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold">👤 My Profile</h1>
      <p className="mt-1 text-sm text-crewly-dim">
        Your photo & personal details. Employment info is managed by HR (read-only here).
      </p>

      {error && <div className="mt-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}
      {notice && <div className="mt-4 rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">{notice}</div>}

      <div className="mt-6 grid gap-5 lg:grid-cols-[320px_1fr]">
        {/* ══ LEFT — photo + identity ═══════════════════════════════ */}
        <div className="card self-start text-center">
          <div className="relative mx-auto h-36 w-36">
            {photoSrc ? (
              <img src={photoSrc} alt="profile" className="h-36 w-36 rounded-full object-cover ring-4 ring-crewly-border" />
            ) : (
              <div className="flex h-36 w-36 items-center justify-center rounded-full bg-crewly-green/15 text-5xl font-extrabold text-crewly-green ring-4 ring-crewly-border">
                {profile.name?.[0]?.toUpperCase() || '?'}
              </div>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="absolute bottom-1 right-1 flex h-9 w-9 items-center justify-center rounded-full bg-crewly-orange text-sm shadow-lg transition hover:scale-105 disabled:opacity-50"
              title="Change photo"
            >
              {uploading ? '⏳' : '📷'}
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickPhoto} />

          <h2 className="mt-4 text-lg font-bold">{profile.name}</h2>
          <p className="text-sm text-crewly-dim">{profile.designation || profile.role?.replace('_', ' ')}</p>
          <span className="badge mt-2 inline-block bg-crewly-green/15 text-crewly-green">{profile.role?.replace('_', ' ')}</span>

          <div className="mt-4 flex justify-center gap-2 text-xs">
            <button className="btn-ghost px-3 py-1.5" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {profile.avatarUrl ? 'Change photo' : 'Upload photo'}
            </button>
            {profile.avatarUrl && (
              <button className="rounded-md bg-crewly-red/15 px-3 py-1.5 text-crewly-red transition hover:bg-crewly-red/25" onClick={onRemovePhoto} disabled={uploading}>
                Remove
              </button>
            )}
          </div>
          <p className="mt-3 text-[11px] text-crewly-dim">PNG / JPG / WEBP · max 2 MB · auto-cropped to a face square ☁️</p>
        </div>

        {/* ══ RIGHT — editable + read-only sections ═════════════════ */}
        <div className="space-y-5">
          {/* Personal (editable) */}
          <section className="card">
            <h3 className="mb-4 font-semibold">🙋 Personal Details <span className="ml-1 text-xs font-normal text-crewly-green">editable</span></h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Phone</label>
                <input className="input" value={profile.phone || ''} onChange={(e) => setField('phone', e.target.value)} placeholder="+91 98765 43210" />
              </div>
              <div>
                <label className="label">Gender</label>
                <select className="input" value={profile.gender || ''} onChange={(e) => setField('gender', e.target.value)}>
                  <option value="">Select…</option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div>
                <label className="label">Date of Birth</label>
                <input type="date" className="input" value={dobValue} onChange={(e) => setField('dateOfBirth', e.target.value)} />
              </div>
            </div>
          </section>

          {/* Address (editable) */}
          <section className="card">
            <h3 className="mb-4 font-semibold">🏠 Address <span className="ml-1 text-xs font-normal text-crewly-green">editable</span></h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Street / Area</label>
                <input className="input" value={profile.address?.line || ''} onChange={(e) => setField('address.line', e.target.value)} />
              </div>
              <div>
                <label className="label">City</label>
                <input className="input" value={profile.address?.city || ''} onChange={(e) => setField('address.city', e.target.value)} />
              </div>
              <div>
                <label className="label">State</label>
                <input className="input" value={profile.address?.state || ''} onChange={(e) => setField('address.state', e.target.value)} />
              </div>
              <div>
                <label className="label">Pincode</label>
                <input className="input" value={profile.address?.pincode || ''} onChange={(e) => setField('address.pincode', e.target.value)} />
              </div>
            </div>
          </section>

          {/* Emergency contact (editable) */}
          <section className="card">
            <h3 className="mb-4 font-semibold">🚨 Emergency Contact <span className="ml-1 text-xs font-normal text-crewly-green">editable</span></h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="label">Name</label>
                <input className="input" value={profile.emergencyContact?.name || ''} onChange={(e) => setField('emergencyContact.name', e.target.value)} />
              </div>
              <div>
                <label className="label">Phone</label>
                <input className="input" value={profile.emergencyContact?.phone || ''} onChange={(e) => setField('emergencyContact.phone', e.target.value)} />
              </div>
              <div>
                <label className="label">Relation</label>
                <input className="input" value={profile.emergencyContact?.relation || ''} onChange={(e) => setField('emergencyContact.relation', e.target.value)} placeholder="Father / Spouse…" />
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button className="btn-primary px-6 py-2.5 text-sm" onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : '💾 Save Profile'}
              </button>
            </div>
          </section>

                    {/* Bank (editable) */}
          <section className="card">
            <h3 className="mb-4 font-semibold">🏦 Bank Details <span className="ml-1 text-xs font-normal text-crewly-green">editable</span> <span className="ml-1 text-xs font-normal text-crewly-dim">used for salary credit</span></h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Account Number</label>
                <input className="input" value={profile.bankAccount || ''} onChange={(e) => setField('bankAccount', e.target.value)} placeholder="XXXX XXXX XXXX" />
              </div>
              <div>
                <label className="label">IFSC Code</label>
                <input className="input uppercase" value={profile.ifsc || ''} onChange={(e) => setField('ifsc', e.target.value.toUpperCase())} placeholder="HDFC0001234" />
              </div>
            </div>
          </section>

          {/* Employment (read-only) */}
          <section className="card">
            <h3 className="mb-4 font-semibold">💼 Employment <span className="ml-1 text-xs font-normal text-crewly-dim">managed by HR</span></h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <InfoRow label="Employee Code" value={profile.employeeCode} />
              <InfoRow label="Work Email" value={profile.email} />
              <InfoRow label="Department" value={profile.department?.name} />
              <InfoRow label="Designation" value={profile.designation} />
              <InfoRow label="Reports To" value={profile.reportingTo ? `${profile.reportingTo.name} (${profile.reportingTo.role?.replace('_', ' ')})` : ''} />
              <InfoRow label="Joined" value={profile.dateOfJoining ? new Date(profile.dateOfJoining).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default MyProfilePage;