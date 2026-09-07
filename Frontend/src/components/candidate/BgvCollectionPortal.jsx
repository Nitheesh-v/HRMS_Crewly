import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  FileText,
  GraduationCap,
  IdCard,
  Loader2,
  MapPin,
  Paperclip,
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
// the backend is the source of truth.

const ID_TYPES = [
  { value: 'PAN', label: 'PAN card' },
  { value: 'AADHAAR', label: 'Aadhaar (uploaded copy — not e-KYC)' },
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'DRIVING_LICENSE', label: 'Driving licence' },
  { value: 'OTHER_APPROVED_ID', label: 'Other approved ID' },
];

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

const SectionCard = ({ icon: Icon, title, subtitle, complete, locked, children }) => (
  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-semibold text-slate-900">{title}</h3>
          {subtitle ? <p className="text-xs text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {complete ? (
        <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> Complete
        </span>
      ) : locked ? (
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">Locked</span>
      ) : null}
    </div>
    {children}
  </section>
);

const FileRow = ({ file, onRemove, downloadUrl, locked }) => (
  <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
    <div className="flex min-w-0 items-center gap-2">
      <FileText className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="truncate text-slate-700">{file.fileName}</span>
      <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
        v{file.version}
      </span>
      {file.scanStatus === 'NOT_CONFIGURED' ? (
        <span className="shrink-0 text-[10px] text-slate-400" title="Automated malware scanning is not configured on this deployment">
          scan: not configured
        </span>
      ) : null}
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <a
        href={downloadUrl}
        className="text-xs font-medium text-indigo-600 hover:underline"
        target="_blank"
        rel="noreferrer"
      >
        View
      </a>
      {!locked && onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="text-slate-400 hover:text-rose-600"
          aria-label="Remove file"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  </div>
);

const UploadButton = ({ label, onPick, busy, progress }) => (
  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50">
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
    <ul className="mt-2 space-y-1 text-xs text-amber-700">
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
    if (data.collection) {
      const identity = data.collection.identity || {};
      setIdentityForm((current) => ({
        ...current,
        legalName: identity.legalName || current.legalName,
        dateOfBirth: identity.dateOfBirth ? String(identity.dateOfBirth).slice(0, 10) : current.dateOfBirth,
        documentType: identity.documentType || current.documentType,
      }));
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
      <div className="flex items-center justify-center py-16 text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading your BGV information…
      </div>
    );
  }
  if (error && !summary) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{error}</div>
    );
  }
  if (!summary) return null;

  const completedCount = purchasedChecks.filter((type) => perCheck[type] === 'COMPLETE').length;

  return (
    <div className="space-y-6">
      {/* Progress — purchased checks only */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="font-semibold text-slate-900">Your progress</h3>
        <p className="mt-1 text-xs text-slate-500">
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
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              {type}
              <span className="block text-[10px] font-normal">
                {locked || perCheck[type] === 'COMPLETE' ? 'complete' : 'pending'}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-indigo-500 transition-all"
            style={{ width: `${purchasedChecks.length ? (completedCount / purchasedChecks.length) * 100 : 0}%` }}
          />
        </div>
      </section>

      {notice ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}

      {/* ── IDENTITY ── */}
      {hasCheck('IDENTITY') ? (
        <SectionCard icon={IdCard} title="Identity" subtitle="Provide one supported identity document. Your document number is masked — the full number is never stored." complete={perCheck.IDENTITY === 'COMPLETE'} locked={locked}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Legal name (as on document)</label>
              <input className={inputClass} value={identityForm.legalName} disabled={locked}
                onChange={(event) => setIdentityForm({ ...identityForm, legalName: event.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Date of birth</label>
              <input type="date" className={inputClass} value={identityForm.dateOfBirth} disabled={locked}
                onChange={(event) => setIdentityForm({ ...identityForm, dateOfBirth: event.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Document type</label>
              <select className={inputClass} value={identityForm.documentType} disabled={locked}
                onChange={(event) => setIdentityForm({ ...identityForm, documentType: event.target.value })}>
                {ID_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Document number</label>
              <input className={inputClass} value={identityForm.identifier} disabled={locked} autoComplete="off"
                placeholder={summary.collection?.identity?.identifierMasked ? `saved: ${summary.collection.identity.identifierMasked}` : 'e.g. ABCDE1234F'}
                onChange={(event) => setIdentityForm({ ...identityForm, identifier: event.target.value })} />
              {summary.collection?.identity?.identifierMasked ? (
                <p className="mt-1 text-[11px] text-slate-500">
                  Saved as {summary.collection.identity.identifierMasked} — leave blank to keep it
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {!locked ? (
              <button type="button" disabled={busy === 'identity'}
                onClick={() => run('identity', () => bgvCollectionService.saveIdentity(secureToken, identityForm), 'Identity information saved')}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
                {busy === 'identity' ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null} Save identity
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
                <label className="mb-1 block text-xs font-medium text-slate-600">{label}</label>
                <input className={inputClass} value={addressForm[key] || ''} disabled={locked}
                  onChange={(event) => setAddressForm({ ...addressForm, [key]: event.target.value })} />
              </div>
            ))}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Residence type</label>
              <select className={inputClass} value={addressForm.residenceType || ''} disabled={locked}
                onChange={(event) => setAddressForm({ ...addressForm, residenceType: event.target.value })}>
                <option value="">Select…</option>
                {['OWNED', 'RENTED', 'FAMILY', 'HOSTEL', 'OTHER'].map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {!locked ? (
              <button type="button" disabled={busy === 'address'}
                onClick={() => run('address', () => bgvCollectionService.saveAddress(secureToken, addressForm), 'Address saved')}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
                {busy === 'address' ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null} Save address
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
              <div key={record.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm text-slate-800">
                    <span className="font-medium">{record.qualification}</span> — {record.institution}
                    <span className="block text-xs text-slate-500">
                      {record.startYear}{record.endYear ? ` – ${record.endYear}` : ''} {record.universityBoard ? `· ${record.universityBoard}` : ''}
                    </span>
                  </div>
                  {!locked ? (
                    <div className="flex shrink-0 gap-2">
                      <button type="button" className="text-xs text-indigo-600 hover:underline"
                        onClick={() => setEducationForm({ ...record, startYear: record.startYear || '', endYear: record.endYear || '' })}>
                        Edit
                      </button>
                      <button type="button" className="text-xs text-rose-600 hover:underline"
                        onClick={() => run('edu-remove', () => bgvCollectionService.removeEducation(secureToken, record.id), 'Education record removed')}>
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {filesFor('EDUCATION_CERTIFICATE', record.id).map((file) => (
                    <div key={file.id} className="flex-1 min-w-[220px]">
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
            <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
              <p className="mb-2 text-xs font-semibold text-slate-600">{educationForm.recordId ? 'Edit education record' : 'Add education record'}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input className={inputClass} placeholder="Institution *" value={educationForm.institution}
                  onChange={(event) => setEducationForm({ ...educationForm, institution: event.target.value })} />
                <input className={inputClass} placeholder="University / Board" value={educationForm.universityBoard}
                  onChange={(event) => setEducationForm({ ...educationForm, universityBoard: event.target.value })} />
                <input className={inputClass} placeholder="Qualification *" value={educationForm.qualification}
                  onChange={(event) => setEducationForm({ ...educationForm, qualification: event.target.value })} />
                <input className={inputClass} placeholder="Specialization" value={educationForm.specialization}
                  onChange={(event) => setEducationForm({ ...educationForm, specialization: event.target.value })} />
                <input className={inputClass} placeholder="Enrollment / registration no." value={educationForm.enrollmentNumber}
                  onChange={(event) => setEducationForm({ ...educationForm, enrollmentNumber: event.target.value })} />
                <input className={inputClass} placeholder="Location" value={educationForm.location}
                  onChange={(event) => setEducationForm({ ...educationForm, location: event.target.value })} />
                <input className={inputClass} placeholder="Start year *" inputMode="numeric" value={educationForm.startYear}
                  onChange={(event) => setEducationForm({ ...educationForm, startYear: event.target.value })} />
                <input className={inputClass} placeholder="End / passing year" inputMode="numeric" value={educationForm.endYear}
                  onChange={(event) => setEducationForm({ ...educationForm, endYear: event.target.value })} />
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy === 'education'}
                  onClick={() => run('education', () => bgvCollectionService.saveEducation(secureToken, educationForm), 'Education record saved').then(() => setEducationForm({ recordId: '', institution: '', universityBoard: '', qualification: '', specialization: '', enrollmentNumber: '', startYear: '', endYear: '', location: '' }))}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
                  {busy === 'education' ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
                  {educationForm.recordId ? 'Update record' : 'Add record'}
                </button>
                {educationForm.recordId ? (
                  <button type="button" className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600"
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
              <div key={record.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm text-slate-800">
                    <span className="font-medium">{record.designation}</span> — {record.employer}
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{record.employmentType}</span>
                    <span className="block text-xs text-slate-500">
                      {String(record.startDate || '').slice(0, 10)}{record.endDate ? ` – ${String(record.endDate).slice(0, 10)}` : ' – present'}
                    </span>
                  </div>
                  {!locked ? (
                    <div className="flex shrink-0 gap-2">
                      <button type="button" className="text-xs text-indigo-600 hover:underline"
                        onClick={() => setEmploymentForm({
                          ...record,
                          startDate: String(record.startDate || '').slice(0, 10),
                          endDate: record.endDate ? String(record.endDate).slice(0, 10) : '',
                        })}>
                        Edit
                      </button>
                      <button type="button" className="text-xs text-rose-600 hover:underline"
                        onClick={() => run('emp-remove', () => bgvCollectionService.removeEmployment(secureToken, record.id), 'Employment record removed')}>
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {filesFor('EMPLOYMENT_EVIDENCE', record.id).map((file) => (
                    <div key={file.id} className="flex-1 min-w-[220px]">
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
            <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
              <p className="mb-2 text-xs font-semibold text-slate-600">{employmentForm.recordId ? 'Edit employment record' : 'Add employment record'}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input className={inputClass} placeholder="Employer *" value={employmentForm.employer}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, employer: event.target.value })} />
                <input className={inputClass} placeholder="Designation *" value={employmentForm.designation}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, designation: event.target.value })} />
                <div>
                  <label className="mb-1 block text-xs text-slate-500">Start date *</label>
                  <input type="date" className={inputClass} value={employmentForm.startDate}
                    onChange={(event) => setEmploymentForm({ ...employmentForm, startDate: event.target.value })} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-500">End date (blank if current)</label>
                  <input type="date" className={inputClass} value={employmentForm.endDate}
                    onChange={(event) => setEmploymentForm({ ...employmentForm, endDate: event.target.value })} />
                </div>
                <input className={inputClass} placeholder="Employee ID (if known)" value={employmentForm.employeeId}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, employeeId: event.target.value })} />
                <select className={inputClass} value={employmentForm.employmentType}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, employmentType: event.target.value })}>
                  <option value="PREVIOUS">Previous employment</option>
                  <option value="CURRENT">Current employment</option>
                </select>
                <input className={inputClass} placeholder="HR contact name (optional)" value={employmentForm.hrContactName}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, hrContactName: event.target.value })} />
                <input className={inputClass} placeholder="HR contact email (optional)" value={employmentForm.hrContactEmail}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, hrContactEmail: event.target.value })} />
                <input className={inputClass} placeholder="HR contact phone (optional)" value={employmentForm.hrContactPhone}
                  onChange={(event) => setEmploymentForm({ ...employmentForm, hrContactPhone: event.target.value })} />
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy === 'employment'}
                  onClick={() => run('employment', () => bgvCollectionService.saveEmployment(secureToken, employmentForm), 'Employment record saved').then(() => setEmploymentForm({ recordId: '', employer: '', designation: '', employeeId: '', startDate: '', endDate: '', employmentType: 'PREVIOUS', hrContactName: '', hrContactEmail: '', hrContactPhone: '' }))}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
                  {busy === 'employment' ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
                  {employmentForm.recordId ? 'Update record' : 'Add record'}
                </button>
                {employmentForm.recordId ? (
                  <button type="button" className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600"
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
              <div key={record.id} className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm text-slate-800">
                <div>
                  <span className="font-medium">{record.name}</span> — {record.relationship}
                  <span className="block text-xs text-slate-500">
                    {record.organization}{record.designation ? ` · ${record.designation}` : ''}
                    {record.email ? ` · ${record.email}` : ''}{record.phone ? ` · ${record.phone}` : ''}
                  </span>
                </div>
                {!locked ? (
                  <div className="flex shrink-0 gap-2">
                    <button type="button" className="text-xs text-indigo-600 hover:underline"
                      onClick={() => setReferenceForm({ ...record })}>
                      Edit
                    </button>
                    <button type="button" className="text-xs text-rose-600 hover:underline"
                      onClick={() => run('ref-remove', () => bgvCollectionService.removeReference(secureToken, record.id), 'Reference removed')}>
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {!locked ? (
            <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
              <p className="mb-2 text-xs font-semibold text-slate-600">{referenceForm.recordId ? 'Edit reference' : 'Add reference'}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input className={inputClass} placeholder="Referee name *" value={referenceForm.name}
                  onChange={(event) => setReferenceForm({ ...referenceForm, name: event.target.value })} />
                <input className={inputClass} placeholder="Relationship * (e.g. Former Manager)" value={referenceForm.relationship}
                  onChange={(event) => setReferenceForm({ ...referenceForm, relationship: event.target.value })} />
                <input className={inputClass} placeholder="Organization" value={referenceForm.organization}
                  onChange={(event) => setReferenceForm({ ...referenceForm, organization: event.target.value })} />
                <input className={inputClass} placeholder="Designation" value={referenceForm.designation}
                  onChange={(event) => setReferenceForm({ ...referenceForm, designation: event.target.value })} />
                <input className={inputClass} placeholder="Email" value={referenceForm.email}
                  onChange={(event) => setReferenceForm({ ...referenceForm, email: event.target.value })} />
                <input className={inputClass} placeholder="Phone" value={referenceForm.phone}
                  onChange={(event) => setReferenceForm({ ...referenceForm, phone: event.target.value })} />
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy === 'reference'}
                  onClick={() => run('reference', () => bgvCollectionService.saveReference(secureToken, referenceForm), 'Reference saved').then(() => setReferenceForm({ recordId: '', name: '', organization: '', designation: '', relationship: '', email: '', phone: '', context: '' }))}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
                  {busy === 'reference' ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
                  {referenceForm.recordId ? 'Update reference' : 'Add reference'}
                </button>
                {referenceForm.recordId ? (
                  <button type="button" className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600"
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
        <div className="space-y-1 text-sm text-slate-700">
          <p>
            <Paperclip className="mr-1 inline h-4 w-4 text-slate-400" />
            Purchased checks: <span className="font-medium">{purchasedChecks.join(', ')}</span>
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
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-800">Still missing:</p>
            <MissingList missing={summary.readiness.missing} />
          </div>
        ) : null}
        {missing ? (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs font-semibold text-rose-800">Submission refused — please complete:</p>
            <MissingList missing={missing} />
          </div>
        ) : null}
        {locked ? (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Submitted{summary.collection?.submittedAt ? ` on ${new Date(summary.collection.submittedAt).toLocaleString()}` : ''}. Your information is locked; verification has not started yet.
          </div>
        ) : confirmSubmit ? (
          <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
            <p className="text-sm text-slate-700">Submit your BGV information now? You will not be able to edit it afterwards.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy === 'submit'} onClick={submit}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60">
                {busy === 'submit' ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null} Yes, submit now
              </button>
              <button type="button" className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600"
                onClick={() => setConfirmSubmit(false)}>
                Not yet
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmSubmit(true)}
            className="mt-4 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700">
            Submit BGV information
          </button>
        )}
      </SectionCard>
    </div>
  );
};

export default BgvCollectionPortal;
