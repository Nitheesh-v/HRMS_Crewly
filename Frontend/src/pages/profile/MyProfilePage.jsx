// ============================================================
// MY PROFILE — self-service profile for EVERY role
//
// Phase 38 splits the page into TWO lanes, because the two kinds of
// data have different risk:
//
//   · DIRECT  — phone, gender, birthday, address, emergency contact.
//               Saved with PUT /profile/me; the page updates immediately.
//   · REQUEST — full name, designation, employee code, date of joining,
//               bank account, IFSC. The employee proposes a value and HR /
//               Company Admin approves it (POST /profile/change-requests).
//               Until then the OLD value stays on the profile — the screen
//               shows the proposal as "pending", never as applied.
//
// Bank details moved out of the direct lane in this phase: an unverified
// bank edit is how a salary gets paid into the wrong account.
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Briefcase, Camera, ClipboardList, Home, Landmark, Loader2, Lock, Save, Send, Siren, User, UserCircle, X,
} from 'lucide-react';
import profileService from '../../services/profileService';
import Modal from '../../components/Modal.jsx';
import { notify } from '../../utils/notify.js';

// ── The fields an employee may ask to change (UI copy only — the server
//    validates the value AND the allowlist in services/profile/
//    profileChangeRules.js; hiding a button proves nothing).
const REQUESTABLE_FIELDS = [
  { field: 'name', label: 'Full name', group: 'IDENTITY' },
  { field: 'designation', label: 'Designation', group: 'EMPLOYMENT' },
  { field: 'employeeCode', label: 'Employee code', group: 'EMPLOYMENT' },
  { field: 'dateOfJoining', label: 'Date of joining', group: 'EMPLOYMENT', inputType: 'date' },
  { field: 'bankAccount', label: 'Bank account number', group: 'PAYMENT' },
  { field: 'ifsc', label: 'IFSC code', group: 'PAYMENT' },
];

const fieldMeta = (field) =>
  REQUESTABLE_FIELDS.find((entry) => entry.field === field) || { field, label: field };

const STATUS_STYLE = {
  pending: 'bg-amber-400/15 text-amber-200',
  approved: 'bg-crewly-green/15 text-crewly-green',
  rejected: 'bg-crewly-red/15 text-crewly-red',
  cancelled: 'bg-white/10 text-crewly-dim',
};

const dayValue = (value) => (value ? String(value).slice(0, 10) : '');

const prettyDay = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// label + value read-only row, with an optional "Request change" action
const InfoRow = ({ label, value, onRequest, locked = false }) => (
  <div>
    <p className="text-[11px] uppercase tracking-wide text-crewly-dim">{label}</p>
    <div className="mt-0.5 flex items-center justify-between gap-2">
      <p className="text-sm font-medium">{value || '—'}</p>
      {onRequest && (
        <button
          type="button"
          onClick={onRequest}
          className="inline-flex items-center gap-1 rounded-md border border-crewly-border px-2 py-1 text-[11px] text-crewly-dim transition hover:text-crewly-text"
        >
          {locked ? <Lock className="h-3 w-3" /> : null}Request change
        </button>
      )}
    </div>
  </div>
);

const MyProfilePage = () => {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState('');
  const [requests, setRequests] = useState([]);
  const [requestDraft, setRequestDraft] = useState(null); // { field, label, value, reason, inputType }
  const [sendingRequest, setSendingRequest] = useState(false);
  const [cancellingId, setCancellingId] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    /* 35.1 — nothing to report; failures are toasted by api.js */
    try {
      const res = await profileService.getMe();
      setProfile(res?.data || res);
    } catch (err) {
      notify.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRequests = useCallback(async () => {
    try {
      const res = await profileService.myChangeRequests();
      setRequests(res?.requests || []);
    } catch {
      // A pending-request list is informational: a failure here must not
      // break the profile screen (the page's own load already reported it).
      setRequests([]);
    }
  }, []);

  useEffect(() => { load(); loadRequests(); }, [load, loadRequests]);

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
    /* 35.1 — nothing to report; failures are toasted by api.js */
    try {
      const res = await profileService.uploadAvatar(file);
      const url = res?.avatarUrl || res?.data?.avatarUrl;
      setProfile((p) => ({ ...p, avatarUrl: url || p?.avatarUrl }));
      notify.success('Photo updated! (Topbar shows it after next login)');
    } catch (err) {
      notify.error(err);
    } finally {
      setUploading(false);
      setPreview('');
    }
  };

  const onRemovePhoto = async () => {
    setUploading(true);
    /* 35.1 — nothing to report; failures are toasted by api.js */
    try {
      await profileService.removeAvatar();
      setProfile((p) => ({ ...p, avatarUrl: '' }));
      notify.success('Photo removed');
    } catch (err) {
      notify.error(err);
    } finally {
      setUploading(false);
    }
  };

  // ── save the DIRECT lane ──────────────────────────────────────────
  const onSave = async () => {
    setSaving(true);
    /* 35.1 — nothing to report; failures are toasted by api.js */
    try {
      // Only the fields the employee owns. Bank / employment values are not
      // in this payload at all — they travel through the approval workflow.
      const payload = {
        phone: profile.phone || '',
        gender: profile.gender || '',
        dateOfBirth: profile.dateOfBirth || null,
        address: profile.address || {},
        emergencyContact: profile.emergencyContact || {},
      };
      const res = await profileService.updateMe(payload);
      setProfile(res?.data || res);
      notify.success('Profile saved');
    } catch (err) {
      notify.error(err);
    } finally {
      setSaving(false);
    }
  };

  // ── the REQUEST lane ──────────────────────────────────────────────
  const openRequest = (field) => {
    const meta = fieldMeta(field);
    setRequestDraft({
      field,
      label: meta.label,
      inputType: meta.inputType || 'text',
      value: meta.inputType === 'date' ? dayValue(profile[field]) : String(profile[field] || ''),
      reason: '',
    });
  };

  const submitRequest = async () => {
    if (!requestDraft) return;
    setSendingRequest(true);
    /* 35.1 — nothing to report; failures are toasted by api.js */
    try {
      await profileService.submitChangeRequest({
        changes: { [requestDraft.field]: requestDraft.value },
        reason: requestDraft.reason || '',
      });
      notify.success('Request sent to HR for approval');
      setRequestDraft(null);
      loadRequests();
    } catch (err) {
      notify.error(err);
    } finally {
      setSendingRequest(false);
    }
  };

  const cancelRequest = async (id) => {
    setCancellingId(id);
    /* 35.1 — nothing to report; failures are toasted by api.js */
    try {
      await profileService.cancelChangeRequest(id);
      notify.success('Request cancelled');
      loadRequests();
    } catch (err) {
      notify.error(err);
    } finally {
      setCancellingId('');
    }
  };

  if (loading && !profile) return <p className="text-crewly-dim">Loading profile…</p>;
  /*
   * 35.1 — a failed load already raised a toast; this line only keeps the
   * screen from rendering an empty form.
   */
  if (!profile) return <p className="text-crewly-red">Profile unavailable. Please refresh and try again.</p>;

  const dobValue = profile.dateOfBirth ? String(profile.dateOfBirth).slice(0, 10) : '';
  const photoSrc = preview || profile.avatarUrl;
  const pendingFields = new Set(
    requests.filter((row) => row.status === 'pending').flatMap((row) => row.changes.map((change) => change.field)),
  );

  return (
    <div className="max-w-5xl">
      <h1 className="flex items-center gap-2 text-2xl font-bold"><UserCircle className="h-6 w-6 text-crewly-green" />My Profile</h1>
      <p className="mt-1 text-sm text-crewly-dim">
        Your photo & personal details. Employment and payment details are approved by HR before they change.
      </p>

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
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
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
          <p className="mt-3 text-[11px] text-crewly-dim">PNG / JPG / WEBP · max 2 MB · auto-cropped to a face square</p>
        </div>

        {/* ══ RIGHT — editable + read-only sections ═════════════════ */}
        <div className="space-y-5">
          {/* Personal (editable) */}
          <section className="card">
            <h3 className="mb-4 flex items-center gap-2 font-semibold"><User className="h-4 w-4 text-crewly-dim" />Personal Details <span className="ml-1 text-xs font-normal text-crewly-green">editable</span></h3>
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
            <h3 className="mb-4 flex items-center gap-2 font-semibold"><Home className="h-4 w-4 text-crewly-dim" />Address <span className="ml-1 text-xs font-normal text-crewly-green">editable</span></h3>
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
            <h3 className="mb-4 flex items-center gap-2 font-semibold"><Siren className="h-4 w-4 text-crewly-dim" />Emergency Contact <span className="ml-1 text-xs font-normal text-crewly-green">editable</span></h3>
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
                {saving ? 'Saving…' : <><Save className="mr-1 inline h-4 w-4" />Save Profile</>}
              </button>
            </div>
          </section>

          {/* Bank — approval lane (Phase 38) */}
          <section className="card">
            <h3 className="mb-1 flex items-center gap-2 font-semibold">
              <Landmark className="h-4 w-4 text-crewly-dim" />Bank Details
              <span className="ml-1 inline-flex items-center gap-1 text-xs font-normal text-crewly-dim"><Lock className="h-3 w-3" />needs HR approval</span>
            </h3>
            <p className="mb-4 text-xs text-crewly-dim">
              Salary is credited to this account, so a change is verified by HR before it is applied.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <InfoRow
                label="Account Number"
                value={profile.bankAccount || ''}
                onRequest={() => openRequest('bankAccount')}
                locked
              />
              <InfoRow
                label="IFSC Code"
                value={profile.ifsc || ''}
                onRequest={() => openRequest('ifsc')}
                locked
              />
            </div>
          </section>

          {/* Employment (read-only, requestable) */}
          <section className="card">
            <h3 className="mb-4 flex items-center gap-2 font-semibold"><Briefcase className="h-4 w-4 text-crewly-dim" />Employment <span className="ml-1 text-xs font-normal text-crewly-dim">managed by HR</span></h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <InfoRow label="Name" value={profile.name} onRequest={() => openRequest('name')} locked />
              <InfoRow label="Employee Code" value={profile.employeeCode} onRequest={() => openRequest('employeeCode')} locked />
              <InfoRow label="Work Email" value={profile.email} />
              <InfoRow label="Department" value={profile.department?.name} />
              <InfoRow label="Designation" value={profile.designation} onRequest={() => openRequest('designation')} locked />
              <InfoRow
                label="Reports To"
                value={profile.reportingTo ? `${profile.reportingTo.name} (${profile.reportingTo.role?.replace('_', ' ')})` : ''}
              />
              <InfoRow
                label="Joined"
                value={profile.dateOfJoining ? prettyDay(profile.dateOfJoining) : ''}
                onRequest={() => openRequest('dateOfJoining')}
                locked
              />
            </div>
          </section>

          {/* My change requests (Phase 38) */}
          <section className="card">
            <h3 className="mb-4 flex items-center gap-2 font-semibold">
              <ClipboardList className="h-4 w-4 text-crewly-dim" />My Change Requests
              {requests.some((row) => row.status === 'pending') && (
                <span className="badge bg-amber-400/15 text-amber-200">
                  {requests.filter((row) => row.status === 'pending').length} pending
                </span>
              )}
            </h3>

            {requests.length === 0 ? (
              <p className="text-sm text-crewly-dim">
                Nothing requested. Use “Request change” next to a field HR manages.
              </p>
            ) : (
              <div className="space-y-3">
                {requests.map((row) => (
                  <div key={row.id} className="rounded-lg border border-crewly-border/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`badge ${STATUS_STYLE[row.status] || STATUS_STYLE.cancelled}`}>{row.status}</span>
                      <span className="text-[11px] text-crewly-dim">Requested {prettyDay(row.requestedAt)}</span>
                    </div>
                    <dl className="mt-2 space-y-1 text-sm">
                      {row.changes.map((change) => (
                        <div key={change.field} className="flex flex-wrap items-center gap-1.5">
                          <dt className="text-crewly-dim">{change.label}:</dt>
                          <dd className="line-through opacity-70">{change.from || '—'}</dd>
                          <dd aria-hidden="true">→</dd>
                          <dd className="font-medium">{change.to || '—'}</dd>
                        </div>
                      ))}
                    </dl>
                    {row.decisionNote && (
                      <p className="mt-2 text-xs text-crewly-dim">HR note: {row.decisionNote}</p>
                    )}
                    {row.canCancel && (
                      <button
                        type="button"
                        onClick={() => cancelRequest(row.id)}
                        disabled={cancellingId === row.id}
                        className="mt-2 inline-flex items-center gap-1 rounded-md border border-crewly-red/40 px-3 py-1.5 text-xs text-crewly-red transition hover:bg-crewly-red/10 disabled:opacity-50"
                      >
                        <X className="h-3 w-3" />
                        {cancellingId === row.id ? 'Cancelling…' : 'Cancel request'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ══ REQUEST MODAL ═════════════════════════════════════════ */}
      {requestDraft && (
        <Modal
          title={`Request a change — ${requestDraft.label}`}
          onClose={() => setRequestDraft(null)}
        >
          <div className="space-y-4">
            <p className="text-sm text-crewly-dim">
              HR reviews this before it is applied. Your current value stays visible until then.
            </p>

            <div>
              <label className="label">{requestDraft.label}</label>
              <input
                className="input"
                type={requestDraft.inputType}
                value={requestDraft.value}
                onChange={(e) => setRequestDraft((draft) => ({ ...draft, value: e.target.value }))}
              />
            </div>

            <div>
              <label className="label">Why is it changing? (optional)</label>
              <textarea
                className="input"
                rows={2}
                maxLength={300}
                value={requestDraft.reason}
                onChange={(e) => setRequestDraft((draft) => ({ ...draft, reason: e.target.value }))}
                placeholder="e.g. Salary account moved to another bank"
              />
            </div>

            {pendingFields.has(requestDraft.field) && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                You already have a pending request for this field. Cancel it first if you want to change the value.
              </p>
            )}

            <button
              type="button"
              onClick={submitRequest}
              disabled={sendingRequest || pendingFields.has(requestDraft.field)}
              className="btn-primary inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm"
            >
              {sendingRequest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {sendingRequest ? 'Sending…' : 'Send for approval'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default MyProfilePage;
