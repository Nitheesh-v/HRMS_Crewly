import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileText,
  GraduationCap,
  IdCard,
  Loader2,
  MapPin,
  Send,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import bgvCollectionService from '../../services/bgvCollectionService.js';

// Phase 30.5 — candidate BGV information & documents portal.
// Rendered only AFTER explicit 30.4 consent. Sections appear ONLY for the
// purchased checks (the backend enforces the same rule — the UI is never
// the security boundary). Draft-first: nothing is released until the
// candidate explicitly submits. No sensitive form data in localStorage —
// the backend is the source of truth. Styled with the Crewly brand theme.

const ID_TYPES = [
  { value: 'PAN', label: 'PAN card' },
  { value: 'AADHAAR', label: 'Aadhaar (uploaded copy — not e-KYC)' },
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'DRIVING_LICENSE', label: 'Driving licence' },
  { value: 'OTHER_APPROVED_ID', label: 'Other approved ID' },
];

const SectionCard = ({ icon: Icon, title, subtitle, complete, locked, children }) => (
  <section className="card">
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-crewly-green/10 text-crewly-green">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-semibold text-crewly-text">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-crewly-dim">{subtitle}</p> : null}
        </div>
      </div>
      {complete ? (
        <span className="badge bg-crewly-green/10 text-crewly-green">Complete</span>
      ) : locked ? (
        <span className="badge bg-crewly-border/40 text-crewly-dim">Locked</span>
      ) : null}
    </div>
    {children}
  </section>
);

const FileRow = ({ file, onRemove, downloadUrl, locked }) => (
  <div className="flex items-center justify-between gap-3 rounded-lg border border-crewly-border bg-crewly-bg/60 px-3 py-2 text-sm">
    <div className="flex min-w-0 items-center gap-2">
      <FileText className="h-4 w-4 shrink-0 text-crewly-dim" />
      <span className="truncate text-crewly-text">{file.fileName}</span>
      <span className="shrink-0 rounded bg-crewly-border/40 px-1.5 py-0.5 text-[10px] font-medium text-crewly-dim">
        v{file.version}
      </span>
      {file.scanStatus === 'NOT_CONFIGURED' ? (
        <span className="shrink-0 text-[10px] text-crewly-dim" title="Automated malware scanning is not configured on this deployment">
          scan: not configured
        </span>
      ) : null}
    </div>
    <div className="flex shrink-0 items-center gap-3">
      <a href={downloadUrl} className="text-xs font-medium text-crewly-green hover:underline" target="_blank" rel="noreferrer">
        View
      </a>
      {!locked && onRemove ? (
        <button type="button" onClick={onRemove} className="text-crewly-dim hover:text-crewly-red" aria-label="Remove file">
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  </div>
);

const UploadButton = ({ label, onPick, busy, progress }) => (
  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-crewly-border bg-crewly-bg/40 px-3 py-2 text-sm font-medium text-crewly-green transition hover:border-crewly-green">
    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
    {busy && progress !== null ? `Uploading ${progress}%` : label}
    <input
      type="file"
      accept=".pdf,.jpg,.jpeg,.png,.webp"
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) onPick(file);
      }}
    />
  </label>
);

const MissingList = ({ missing }) =>
  missing?.length ? (
    <ul className="mt-2 space-y-1 text-xs text-crewly-orange">
      {missing.map((entry) => (
        <li key={`${entry.checkType}-${entry.requirement}`} className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {entry.checkType}: {entry.requirement}
        </li>
      ))}
    </ul>
  ) : null;

const BgvCollectionPortal = ({ secureToken }) => {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [missing, setMissing] = useState(null);
  const [busy, setBusy] = useState('');
  const [uploadState, setUploadState] = useState({ key: '', progress: null });

  // Forms the candidate has typed into — a background refresh must never
  // overwrite unsaved edits (server seeding only happens when untouched).
  const touchedRef = useRef({ identity: false, address: false });

  // Form state (drafts live in the backend; these are just edit buffers).
  const [identityForm, setIdentityForm] = useState({ legalName: '', dateOfBirth: '', documentType: 'PAN', identifier: '' });
  const [addressForm, setAddressForm] = useState({ line1: '', line2: '', locality: '', city: '', state: '', pincode: '', country: 'India', residenceType: '', evidenceCategory: '' });
  const [educationForm, setEducationForm] = useState({ recordId: '', institution: '', universityBoard: '', qualification: '', specialization: '', enrollmentNumber: '', startYear: '', endYear: '', location: '' });
  const [employmentForm, setEmploymentForm] = useState({ recordId: '', employer: '', designation: '', employeeId: '', startDate: '', endDate: '', employmentType: 'PREVIOUS', hrContactName: '', hrContactEmail: '', hrContactPhone: '' });
  const [referenceForm, setReferenceForm] = useState({ recordId: '', name: '', organization: '', designation: '', relationship: '', email: '', phone: '', context: '' });
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const load = useCallback(async () => {
    const data = await bgvCollectionService.read(secureToken);
    setSummary(data);
    if (data.collection && !touchedRef.current.identity) {
      const identity = data.collection.identity || {};
      setIdentityForm((current) => ({
        ...current,
        legalName: identity.legalName || current.legalName,
        dateOfBirth: identity.dateOfBirth ? String(identity.dateOfBirth).slice(0, 10) : current.dateOfBirth,
        documentType: identity.documentType || current.documentType,
      }));
    }
    if (data.collection && !touchedRef.current.address) {
      const address = data.collection.address || {};
      setAddressForm((current) => ({ ...current, ...address, residenceType: address.residenceType || '', evidenceCategory: address.evidenceCategory || '' }));
    }
    return data;
  }, [secureToken]);

  useEffect(() => {
    let active = true;
    load()
      .catch((requestError) => {
        if (active) setError(requestError.message || 'BGV collection is unavailable');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const purchasedChecks = summary?.purchasedChecks || [];
  const hasCheck = (type) => purchasedChecks.includes(type);
  const locked = summary?.collection?.status === 'SUBMITTED';
  const perCheck = summary?.readiness?.perCheck || {};
  const filesFor = (checkType, recordId = null) =>
    (summary?.files || []).filter(
      (file) => file.checkType === checkType && (recordId === null ? !file.recordId : file.recordId === recordId)
    );

  const refresh = async (message) => {
    const data = await load();
    setNotice(message || '');
    setMissing(null);
    return data;
  };

  const run = async (key, action, message) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh(message);
    } catch (requestError) {
      setError(requestError.message || 'Something went wrong');
    } finally {
      setBusy('');
    }
  };

  const upload = (key, category, recordId, file) =>
    run(key, async () => {
      setUploadState({ key, progress: 0 });
      try {
        await bgvCollectionService.uploadFile(secureToken, {
          category,
          recordId,
          file,
          onProgress: (progress) => setUploadState({ key, progress }),
        });
      } finally {
        setUploadState({ key: '', progress: null });
      }
    }, 'Evidence uploaded');

  const downloadUrl = (fileId) => bgvCollectionService.fileDownloadUrl(secureToken, fileId);

  const submit = () =>
    run('submit', async () => {
      try {
        await bgvCollectionService.submit(secureToken);
        setConfirmSubmit(false);
      } catch (requestError) {
        setMissing(requestError.missingRequirements || null);
        throw requestError;
      }
    }, 'BGV information submitted successfully');

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-crewly-dim">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading your BGV information…
      </div>
    );
  }
  if (error && !summary) {
    return <div className="rounded-xl border border-crewly-red/30 bg-crewly-red/10 p-6 text-sm text-crewly-red">{error}</div>;
  }
  if (!summary) return null;

  const completedCount = purchasedChecks.filter((type) => perCheck[type] === 'COMPLETE').length;

  return (
    <div className="space-y-5">
      {/* Progress — purchased checks only */}
      <section className="card">
        <h3 className="font-semibold text-crewly-text">Your progress</h3>
        <p className="mt-1 text-xs text-crewly-dim">
          {locked
            ? 'Submitted — your information is now locked for verification.'
            : 'Save as you go; nothing is released until you submit. You can close this page and return with the same link.'}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {purchasedChecks.map((type) => (
            <div
              key={type}
              className={`rounded-lg border px-3 py-2 text-xs font-medium ${
                perCheck[type] === 'COMPLETE'
                  ? 'border-crewly-green/30 bg-crewly-green/10 text-crewly-green'
                  : 'border-crewly-border bg-crewly-bg/40 text-crewly-dim'
              }`}
            >
              {type}
              <span className="block text-[10px] font-normal">
                {locked || perCheck[type] === 'COMPLETE' ? 'complete' : 'pending'}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-crewly-border/40">
          <div
            className="h-full rounded-full bg-crewly-green transition-all"
            style={{ width: `${purchasedChecks.length ? (completedCount / purchasedChecks.length) * 100 : 0}%` }}
          />
        </div>
      </section>

      {notice ? (
        <div className="flex items-center gap-2 rounded-xl border border-crewly-green/30 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-crewly-red/30 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}

      {/* ── IDENTITY ── */}
      {hasCheck('IDENTITY') ? (
        <SectionCard icon={IdCard} title="Identity" subtitle="Provide one supported identity document. Your document number is masked — the full number is never stored." complete={perCheck.IDENTITY === 'COMPLETE'} locked={locked}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Legal name (as on document)</label>
              <input className="input" value={identityForm.legalName} disabled={locked}
                onChange={(event) => { touchedRef.current.identity = true; setIdentityForm({ ...identityForm, legalName: event.target.value }); }} />
            </div>
            <div>
              <label className="label">Date of birth</label>
              <input type="date" className="input" value={identityForm.dateOfBirth} disabled={locked}
                onChange={(event) => { touchedRef.current.identity = true; setIdentityForm({ ...identityForm, dateOfBirth: event.target.value }); }} />
            </div>
            <div>
              <label className="label">Document type</label>
              <select className="input" value={identityForm.documentType} disabled={locked}
                onChange={(event) => { touchedRef.current.identity = true; setIdentityForm({ ...identityForm, documentType: event.target.value }); }}>
                {ID_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Document number</label>
              <input className="input" value={identityForm.identifier} disabled={locked} autoComplete="off"
                placeholder={summary.collection?.identity?.identifierMasked ? `saved: ${summary.collection.identity.identifierMasked}` : 'e.g. ABCDE1234F'}
                onChange={(event) => { touchedRef.current.identity = true; setIdentityForm({ ...identityForm, identifier: event.target.value }); }} />
              {summary.collection?.identity?.identifierMasked ? (
                <p className="mt-1 text-[11px] text-crewly-dim">
                  Saved as {summary.collection.identity.identifierMasked} — leave blank to keep it
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!locked ? (
              <button type="button" className="btn-primary gap-2 !px-4 !py-2 text-sm" disabled={busy === 'identity'}
                onClick={() => run('identity', async () => { touchedRef.current.identity = false; await bgvCollectionService.saveIdentity(secureToken, identityForm); }, 'Identity information saved')}>
                {busy === 'identity' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save identity
              </button>
            ) : null}
            {!locked ? (
              <UploadButton label="Upload ID document (PDF/JPG/PNG, max 5 MB)"
                busy={uploadState.key === 'id-file'} progress={uploadState.key === 'id-file' ? uploadState.progress : null}
                onPick={(file) => upload('id-file', 'IDENTITY_DOCUMENT', null, file)} />
            ) : null}
          </div>
          <div className="mt-3 space-y-2">
            {filesFor('IDENTITY_DOCUMENT').map((file) => (
              <FileRow key={file.id} file={file} downloadUrl={downloadUrl(file.id)} locked={locked}
                onRemove={() => run('id-remove', () => bgvCollectionService.removeFile(secureToken, file.id), 'File removed')} />
            ))}
            {filesFor('IDENTITY_SELFIE').map((file) => (
              <FileRow key={file.id} file={file} downloadUrl={downloadUrl(file.id)} locked={locked}
                onRemove={() => run('selfie-remove', () => bgvCollectionService.removeFile(secureToken, file.id), 'File removed')} />
            ))}
          </div>
          {!locked ? (
            <div className="mt-3">
              <UploadButton label="Optional: current photo / selfie (image only, private)"
                busy={uploadState.key === 'selfie'} progress={uploadState.key === 'selfie' ? uploadState.progress : null}
                onPick={(file) => upload('selfie', 'IDENTITY_SELFIE', null, file)} />
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {/* ── ADDRESS ── */}
      {hasCheck('ADDRESS') ? (
        <SectionCard icon={MapPin} title="Address" subtitle="Your current residential address and one supporting proof." complete={perCheck.ADDRESS === 'COMPLETE'} locked={locked}>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              ['line1', 'Address line 1 *'],
              ['line2', 'Address line 2'],
              ['locality', 'Locality'],
              ['city', 'City *'],
              ['state', 'State *'],
              ['pincode', 'PIN code *'],
              ['country', 'Country *'],
            ].map(([key, label]) => (
              <div key={key}>
                <label className="label">{label}</label>
                <input className="input" value={addressForm[key] || ''} disabled={locked}
                  onChange={(event) => { touchedRef.current.address = true; setAddressForm({ ...addressForm, [key]: event.target.value }); }} />
              </div>
            ))}
            <div>
              <label className="label">Residence type</label>
              <select className="input" value={addressForm.residenceType || ''} disabled={locked}
                onChange={(event) => { touchedRef.current.address = true; setAddressForm({ ...addressForm, residenceType: event.target.value }); }}>
                <option value="">Select…</option>
                {['OWNED', 'RENTED', 'FAMILY', 'HOSTEL', 'OTHER'].map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!locked ? (
              <button type="button" className="btn-primary gap-2 !px-4 !py-2 text-sm" disabled={busy === 'address'}
                onClick={() => run('address', async () => { touchedRef.current.address = false; await bgvCollectionService.saveAddress(secureToken, addressForm); }, 'Address saved')}>
                {busy === 'address' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save address
              </button>
            ) : null}
            {!locked ? (
              <UploadButton label="Upload address proof"
                busy={uploadState.key === 'addr-file'} progress={uploadState.key === 'addr-file' ? uploadState.progress : null}
                onPick={(file) => upload('addr-file', 'ADDRESS_PROOF', null, file)} />
            ) : null}
          </div>
          <div className="mt-3 space-y-2">
            {filesFor('ADDRESS_PROOF').map((file) => (
              <FileRow key={file.id} file={file} downloadUrl={downloadUrl(file.id)} locked={locked}
                onRemove={() => run('addr-remove', () => bgvCollectionService.removeFile(secureToken, file.id), 'File removed')} />
            ))}
          </div>
        </SectionCard>
      ) : null}

      {/* ── EDUCATION ── */}
      {hasCheck('EDUCATION') ? (
        <SectionCard icon={GraduationCap} title="Education" subtitle="Add each qualification separately with its certificate or marksheet." complete={perCheck.EDUCATION === 'COMPLETE'} locked={locked}>
          <div className="space-y-2">
            {(summary.collection?.educations || []).map((record, index) => (
              <div key={record.id} className="rounded-lg border border-crewly-border bg-crewly-bg/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm text-crewly-text">
                    <span className="font-medium">{record.qualification}</span> — {record.institution}
                    <span className="block text-xs text-crewly-dim">
                      {record.startYear}{record.endYear ? ` – ${record.endYear}` : ''} {record.universityBoard ? `· ${record.universityBoard}` : ''}
                    </span>
                  </div>
                  {!locked ? (
                    <div className="flex shrink-0 gap-3">
                      <button type="button" className="text-xs text-crewly-green hover:underline"
                        onClick={() => setEducationForm({ ...record, startYear: record.startYear || '', endYear: record.endYear || '' })}>
                        Edit
                      </button>
                      <button type="button" className="text-xs text-crewly-red hover:underline"
                        onClick={() => run('edu-remove', () => bgvCollectionService.removeEducation(secureToken, record.id), 'Education record removed')}>
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {filesFor('EDUCATION_CERTIFICATE', record.id).map((file) => (
                    <div key={file.id} className="min-w-[220px] flex-1">
                      <FileRow file={file} downloadUrl={downloadUrl(file.id)} locked={locked}
                        onRemove={() => run('edu-file-remove', () => bgvCollectionService.removeFile(secureToken, file.id), 'File removed')} />
                    </div>
                  ))}
                  {!locked ? (
                    <UploadButton label={`Certificate #${index + 1}`}
                      busy={uploadState.key === `edu-${record.id}`} progress={uploadState.key === `edu-${record.id}` ? uploadState.progress : null}
                      onPick={(file) => upload(`edu-${record.id}`, 'EDUCATION_CERTIFICATE', record.id, file)} />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {!locked ? (
            <div className="mt-4 rounded-lg border border-dashed border-crewly-border p-3">
              <p className="mb-2 text-xs font-semibold text-crewly-text">{educationForm.recordId ? 'Edit education record' : 'Add education record'}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input className="input" placeholder="Institution *" value={educationForm.institution}
                  onChange={(event) => setEducationForm({ ...educationForm, institution: event.target.value })} />
                <input className="input" placeholder="University / Board" value={educationForm.universityBoard}
                  onChange={(event) => setEducationForm({ ...educationForm, universityBoard: event.target.value })} />
                <input className="input" placeholder="Qualification *" value={educationForm.qualification}
                  onChange={(event) => setEducationForm({ ...educationForm, qualification: event.target.value })} />
                <input className="input" placeholder="Specialization" value={educationForm.specialization}
                  onChange={(event) => setEducationForm({ ...educationForm, specialization: event.target.value })} />
                <input className="input" placeholder="Enrollment / registration no." value={educationForm.enrollmentNumber}
                  onChange={(event) => setEducationForm({ ...educationForm, enrollmentNumber: event.target.value })} />
                <input className="input" placeholder="Location" value={educationForm.location}
                  onChange={(event) => setEducationForm({ ...educationForm, location: event.target.value })} />
                <input className="input" placeholder="Start year *" inputMode="numeric" value={educationForm.startYear}
                  onChange={(event) => setEducationForm({ ...educationForm, startYear: event.target.value })} />
                <input className="input" placeholder="End / passing year" inputMode="numeric" value={educationForm.endYear}
                  onChange={(event) => setEducationForm({ ...educationForm, endYear: event.target.value })} />
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" className="btn-primary gap-2 !px-4 !py-2 text-sm" disabled={busy === 'education'}
                  onClick={() => run('education', () => bgvCollectionService.saveEducation(secureToken, educationForm), 'Education record saved').then(() => setEducationForm({ recordId: '', institution: '', universityBoard: '', qualification: '', specialization: '', enrollmentNumber: '', startYear: '', endYear: '', location: '' }))}>
                  {busy === 'education' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {educationForm.recordId ? 'Update record' : 'Add record'}
                </button>
                {educationForm.recordId ? (
                  <button type="button" className="btn-ghost !px-4 !py-2 text-sm"
                    onClick={() => setEducationForm({ recordId: '', institution: '', universityBoard: '', qualification: '', specialization: '', enrollmentNumber: '', startYear: '', endYear: '', location: '' })}>
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {/* ── EMPLOYMENT ── */}
      {hasCheck('EMPLOYMENT') ? (
        <SectionCard icon={Building2} title="Employment" subtitle="Add your previous (and current) employers. Bank statements are not required; payslips are optional and treated as highly sensitive." complete={perCheck.EMPLOYMENT === 'COMPLETE'} locked={locked}>
          <div className="space-y-2">
            {(summary.collection?.employments || []).map((record, index) => (
              <div key={record.id} className="rounded-lg border border-crewly-border bg-crewly-bg/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm text-crewly-text">
                    <span className="font-medium">{record.designation}</span> — {record.employer}
                    <span className="ml-2 rounded bg-crewly-border/40 px-1.5 py-0.5 text-[10px] text-crewly-dim">{record.employmentType}</span>
                    <span className="block text-xs text-crewly-dim">
                      {String(record.startDate || '').slice(0, 10)}{record.endDate ? ` – ${String(record.endDate).slice(0, 10)}` : ' – present'}
                    </span>
                  </div>
                  {!locked ? (
                    <div className="flex shrink-0 gap-3">
                      <button type="button" className="text-xs text-crewly-green hover:underline"
                        onClick={() => setEmploymentForm({
                          ...record,
                          startDate: String(record.startDate || '').slice(0, 10),
                          endDate: record.endDate ? String(record.endDate).slice(0, 10) : '',
                        })}>
                        Edit
                      </button>
                      <button type="button" className="text-xs text-crewly-red hover:underline"
                        onClick={() => run('emp-remove', () => bgvCollectionService.removeEmployment(secureToken, record.id), 'Employment record removed')}>
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {filesFor('EMPLOYMENT_EVIDENCE', record.id).map((file) => (
                    <div key={file.id} className="min-w-[220px] flex-1">
                      <FileRow file={file} downloadUrl={downloadUrl(file.id)} locked={locked}
                        onRemove={() => run('emp-file-remove', () => bgvCollectionService.removeFile(secureToken, file.id), 'File removed')} />
                    </div>
                  ))}
                  {!locked ? (
                    <UploadButton label={`Evidence #${index + 1}`}
                      busy={uploadState.key === `emp-${record.id}`} progress={uploadState.key === `emp-${record.id}` ? uploadState.progress : null}
                      onPick={(file) => upload(`emp-${record.id}`, 'EMPLOYMENT_EVIDENCE', record.id, file)} />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {!locked ? (
            <div className="mt-4 rounded-lg border border-dashed border-crewly-border p-3">
              <p className="mb-2 text-xs font-semibold text-crewly-text">{employmentForm.recordId ? 'Edit employment record' : 'Add employment record'}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input className="input" placeholder="Employer *" value={employmentForm.employer}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, employer: event.target.value })} />
                <input className="input" placeholder="Designation *" value={employmentForm.designation}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, designation: event.target.value })} />
                <div>
                  <label className="label">Start date *</label>
                  <input type="date" className="input" value={employmentForm.startDate}
                    onChange={(event) => setEmploymentForm({ ...employmentForm, startDate: event.target.value })} />
                </div>
                <div>
                  <label className="label">End date (blank if current)</label>
                  <input type="date" className="input" value={employmentForm.endDate}
                    onChange={(event) => setEmploymentForm({ ...employmentForm, endDate: event.target.value })} />
                </div>
                <input className="input" placeholder="Employee ID (if known)" value={employmentForm.employeeId}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, employeeId: event.target.value })} />
                <select className="input" value={employmentForm.employmentType}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, employmentType: event.target.value })}>
                  <option value="PREVIOUS">Previous employment</option>
                  <option value="CURRENT">Current employment</option>
                </select>
                <input className="input" placeholder="HR contact name (optional)" value={employmentForm.hrContactName}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, hrContactName: event.target.value })} />
                <input className="input" placeholder="HR contact email (optional)" value={employmentForm.hrContactEmail}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, hrContactEmail: event.target.value })} />
                <input className="input" placeholder="HR contact phone (optional)" value={employmentForm.hrContactPhone}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, hrContactPhone: event.target.value })} />
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" className="btn-primary gap-2 !px-4 !py-2 text-sm" disabled={busy === 'employment'}
                  onClick={() => run('employment', () => bgvCollectionService.saveEmployment(secureToken, employmentForm), 'Employment record saved').then(() => setEmploymentForm({ recordId: '', employer: '', designation: '', employeeId: '', startDate: '', endDate: '', employmentType: 'PREVIOUS', hrContactName: '', hrContactEmail: '', hrContactPhone: '' }))}>
                  {busy === 'employment' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {employmentForm.recordId ? 'Update record' : 'Add record'}
                </button>
                {employmentForm.recordId ? (
                  <button type="button" className="btn-ghost !px-4 !py-2 text-sm"
                    onClick={() => setEmploymentForm({ recordId: '', employer: '', designation: '', employeeId: '', startDate: '', endDate: '', employmentType: 'PREVIOUS', hrContactName: '', hrContactEmail: '', hrContactPhone: '' })}>
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {/* ── REFERENCE ── */}
      {hasCheck('REFERENCE') ? (
        <SectionCard icon={Users} title="References" subtitle="People who can vouch for your work. No calls or emails are sent at this stage." complete={perCheck.REFERENCE === 'COMPLETE'} locked={locked}>
          <div className="space-y-2">
            {(summary.collection?.references || []).map((record) => (
              <div key={record.id} className="flex items-start justify-between gap-2 rounded-lg border border-crewly-border bg-crewly-bg/40 p-3 text-sm text-crewly-text">
                <div>
                  <span className="font-medium">{record.name}</span> — {record.relationship}
                  <span className="block text-xs text-crewly-dim">
                    {record.organization}{record.designation ? ` · ${record.designation}` : ''}
                    {record.email ? ` · ${record.email}` : ''}{record.phone ? ` · ${record.phone}` : ''}
                  </span>
                </div>
                {!locked ? (
                  <div className="flex shrink-0 gap-3">
                    <button type="button" className="text-xs text-crewly-green hover:underline"
                      onClick={() => setReferenceForm({ ...record })}>
                      Edit
                    </button>
                    <button type="button" className="text-xs text-crewly-red hover:underline"
                      onClick={() => run('ref-remove', () => bgvCollectionService.removeReference(secureToken, record.id), 'Reference removed')}>
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {!locked ? (
            <div className="mt-4 rounded-lg border border-dashed border-crewly-border p-3">
              <p className="mb-2 text-xs font-semibold text-crewly-text">{referenceForm.recordId ? 'Edit reference' : 'Add reference'}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input className="input" placeholder="Referee name *" value={referenceForm.name}
                  onChange={(event) => setReferenceForm({ ...referenceForm, name: event.target.value })} />
                <input className="input" placeholder="Relationship * (e.g. Former Manager)" value={referenceForm.relationship}
                  onChange={(event) => setReferenceForm({ ...referenceForm, relationship: event.target.value })} />
                <input className="input" placeholder="Organization" value={referenceForm.organization}
                  onChange={(event) => setReferenceForm({ ...referenceForm, organization: event.target.value })} />
                <input className="input" placeholder="Designation" value={referenceForm.designation}
                  onChange={(event) => setReferenceForm({ ...referenceForm, designation: event.target.value })} />
                <input className="input" placeholder="Email" value={referenceForm.email}
                  onChange={(event) => setReferenceForm({ ...referenceForm, email: event.target.value })} />
                <input className="input" placeholder="Phone" value={referenceForm.phone}
                  onChange={(event) => setReferenceForm({ ...referenceForm, phone: event.target.value })} />
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" className="btn-primary gap-2 !px-4 !py-2 text-sm" disabled={busy === 'reference'}
                  onClick={() => run('reference', () => bgvCollectionService.saveReference(secureToken, referenceForm), 'Reference saved').then(() => setReferenceForm({ recordId: '', name: '', organization: '', designation: '', relationship: '', email: '', phone: '', context: '' }))}>
                  {busy === 'reference' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {referenceForm.recordId ? 'Update reference' : 'Add reference'}
                </button>
                {referenceForm.recordId ? (
                  <button type="button" className="btn-ghost !px-4 !py-2 text-sm"
                    onClick={() => setReferenceForm({ recordId: '', name: '', organization: '', designation: '', relationship: '', email: '', phone: '', context: '' })}>
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {/* ── REVIEW & SUBMIT (explicit POST; GET/refresh never submits) ── */}
      <SectionCard icon={Send} title="Review & submit" subtitle="Confirm everything looks right, then submit. After submission the information is locked." complete={locked} locked={locked}>
        <div className="space-y-1 text-sm text-crewly-text">
          <p>
            Purchased checks: <span className="font-medium text-crewly-green">{purchasedChecks.join(', ')}</span>
          </p>
          <p>
            Progress: <span className="font-medium">{completedCount} of {purchasedChecks.length} complete</span>
          </p>
          <p>
            Evidence files: <span className="font-medium">{(summary.files || []).length}</span>
          </p>
          {summary.collection?.identity?.identifierMasked ? (
            <p>Identity number (masked): <span className="font-medium">{summary.collection.identity.identifierMasked}</span></p>
          ) : null}
        </div>
        {!locked && summary.readiness && !summary.readiness.ready ? (
          <div className="mt-3 rounded-lg border border-crewly-orange/30 bg-crewly-orange/10 p-3">
            <p className="text-xs font-semibold text-crewly-orange">Still missing:</p>
            <MissingList missing={summary.readiness.missing} />
          </div>
        ) : null}
        {missing ? (
          <div className="mt-3 rounded-lg border border-crewly-red/30 bg-crewly-red/10 p-3">
            <p className="text-xs font-semibold text-crewly-red">Submission refused — please complete:</p>
            <MissingList missing={missing} />
          </div>
        ) : null}
        {locked ? (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-crewly-green/30 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Submitted{summary.collection?.submittedAt ? ` on ${new Date(summary.collection.submittedAt).toLocaleString()}` : ''}. Your information is locked; verification has not started yet.
          </div>
        ) : confirmSubmit ? (
          <div className="mt-4 rounded-lg border border-crewly-border bg-crewly-bg/40 p-4">
            <p className="text-sm text-crewly-text">Submit your BGV information now? You will not be able to edit it afterwards.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn-primary gap-2 !px-4 !py-2 text-sm" disabled={busy === 'submit'} onClick={submit}>
                {busy === 'submit' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Yes, submit now
              </button>
              <button type="button" className="btn-ghost !px-4 !py-2 text-sm" onClick={() => setConfirmSubmit(false)}>
                Not yet
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-primary mt-4 gap-2" onClick={() => setConfirmSubmit(true)}>
            <Send className="h-4 w-4" /> Submit BGV information
          </button>
        )}
      </SectionCard>
    </div>
  );
};

export default BgvCollectionPortal;
