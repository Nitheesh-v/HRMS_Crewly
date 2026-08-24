import { useEffect, useMemo, useState } from 'react';
import { FileText, Save, X } from 'lucide-react';
import offerService from '../../services/offerService.js';

const isoDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');
const futureDate = (days) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const initialForm = (offer) => ({
  candidateId: offer?.candidate || '',
  templateId: offer?.template || '',
  designation: offer?.terms?.designation || '',
  departmentName: offer?.terms?.departmentName || '',
  location: offer?.terms?.location || '',
  employmentType: offer?.terms?.employmentType || 'FULL_TIME',
  workMode: offer?.terms?.workMode || 'ONSITE',
  reportingManagerId: offer?.terms?.reportingManager || '',
  joiningDate: isoDate(offer?.terms?.joiningDate) || futureDate(30),
  offerDate: isoDate(offer?.terms?.offerDate) || isoDate(new Date()),
  expiryDate: isoDate(offer?.terms?.expiryDate) || futureDate(7),
  probationMonths: offer?.terms?.probationMonths ?? 6,
  noticePeriodDays: offer?.terms?.noticePeriodDays ?? 30,
  additionalTerms: offer?.terms?.additionalTerms || '',
  currency: offer?.compensationSnapshot?.currency || 'INR',
  annualCTC: offer?.compensationSnapshot?.annualCTC || '',
  basic: offer?.compensationSnapshot?.monthly?.basic || '',
  hra: offer?.compensationSnapshot?.monthly?.hra || '',
  allowances: offer?.compensationSnapshot?.monthly?.allowances || '',
  variablePay: offer?.compensationSnapshot?.variablePay || '',
  bonus: offer?.compensationSnapshot?.bonus || '',
});

const enumLabel = (value) => String(value || '').toLowerCase().split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : '';
const money = (value, currency) => {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
  } catch {
    return `${currency || ''} ${value || 0}`;
  }
};

const OfferEditor = ({ offer = null, revisionSource = null, presetCandidateId = '', replacesOfferId = '', onSaved, onCancel }) => {
  const sourceOffer = offer || revisionSource;
  const [form, setForm] = useState(() => initialForm(sourceOffer));
  const [options, setOptions] = useState({ candidates: [], reportingManagers: [], currency: 'INR' });
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([offerService.templates(), offerService.options()])
      .then(([templateResult, optionResult]) => {
        if (!active) return;
        setTemplates(templateResult.templates);
        setOptions(optionResult);
        const candidateId = presetCandidateId || sourceOffer?.candidate || '';
        const candidate = optionResult.candidates?.find((item) => item.id === candidateId);
        const templateId = sourceOffer?.template || templateResult.templates.find((item) => item.isDefault)?._id || templateResult.templates[0]?._id || '';
        setForm((current) => ({
          ...current,
          candidateId,
          templateId,
          currency: current.currency || optionResult.currency || 'INR',
          designation: current.designation || candidate?.job?.title || '',
          departmentName: current.departmentName || candidate?.job?.department || '',
          location: current.location || candidate?.job?.location || '',
          employmentType: current.employmentType || candidate?.job?.employmentType || 'FULL_TIME',
          workMode: current.workMode || candidate?.job?.workMode || 'ONSITE',
          reportingManagerId: current.reportingManagerId || candidate?.hiringManagerId || '',
        }));
      })
      .catch((requestError) => setError(requestError.message || 'Offer editor could not be loaded'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [presetCandidateId, sourceOffer]);

  const selectedCandidate = options.candidates?.find((item) => item.id === form.candidateId);
  const selectedManager = options.reportingManagers?.find((item) => item.id === form.reportingManagerId);
  const selectedTemplate = templates.find((item) => item._id === form.templateId);

  const preview = useMemo(() => {
    if (sourceOffer?.renderedContent && !selectedTemplate) return sourceOffer.renderedContent;
    const values = {
      candidateName: selectedCandidate?.name || sourceOffer?.candidateSnapshot?.name || '',
      candidateEmail: selectedCandidate?.email || sourceOffer?.candidateSnapshot?.email || '',
      companyName: sourceOffer?.companySnapshot?.name || 'Your company',
      companyAddress: sourceOffer?.companySnapshot?.address || '',
      offerCode: offer?.offerCode || 'Assigned when saved',
      offerDate: dateLabel(form.offerDate),
      expiryDate: dateLabel(form.expiryDate),
      jobTitle: selectedCandidate?.job?.title || sourceOffer?.jobSnapshot?.title || form.designation,
      designation: form.designation,
      department: form.departmentName,
      location: form.location,
      employmentType: enumLabel(form.employmentType),
      workMode: enumLabel(form.workMode),
      reportingManager: selectedManager?.name || '',
      joiningDate: dateLabel(form.joiningDate),
      currency: form.currency,
      salary: money(form.annualCTC, form.currency),
      annualCTC: money(form.annualCTC, form.currency),
      monthlyBasic: money(form.basic, form.currency),
      monthlyHra: money(form.hra, form.currency),
      monthlyAllowances: money(form.allowances, form.currency),
      variablePay: money(form.variablePay, form.currency),
      bonus: money(form.bonus, form.currency),
      probationMonths: form.probationMonths,
      probationPeriod: `${form.probationMonths || 0} months`,
      noticePeriodDays: form.noticePeriodDays,
      noticePeriod: `${form.noticePeriodDays || 0} days`,
      additionalTerms: form.additionalTerms,
    };
    return String(selectedTemplate?.content || sourceOffer?.templateSnapshot?.content || '')
      .replace(/{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g, (_token, name) => values[name] === '' || values[name] === undefined ? `[Missing: ${name}]` : String(values[name]));
  }, [form, offer?.offerCode, selectedCandidate, selectedManager, selectedTemplate, sourceOffer]);

  const change = (field) => (event) => {
    const value = event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
    if (field === 'candidateId') {
      const candidate = options.candidates.find((item) => item.id === value);
      if (candidate) {
        setForm((current) => ({
          ...current,
          candidateId: value,
          designation: candidate.job.title,
          departmentName: candidate.job.department,
          location: candidate.job.location,
          employmentType: candidate.job.employmentType,
          workMode: candidate.job.workMode,
          reportingManagerId: candidate.hiringManagerId || current.reportingManagerId,
        }));
      }
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const payload = {
      ...(offer ? {} : {
        candidateId: form.candidateId,
        ...(replacesOfferId ? { replacesOfferId } : {}),
      }),
      templateId: form.templateId,
      terms: {
        designation: form.designation,
        departmentName: form.departmentName,
        location: form.location,
        employmentType: form.employmentType,
        workMode: form.workMode,
        reportingManagerId: form.reportingManagerId || null,
        joiningDate: form.joiningDate,
        offerDate: form.offerDate,
        expiryDate: form.expiryDate,
        probationMonths: Number(form.probationMonths),
        noticePeriodDays: Number(form.noticePeriodDays),
        additionalTerms: form.additionalTerms,
      },
      compensation: {
        currency: form.currency.toUpperCase(),
        annualCTC: Number(form.annualCTC),
        monthly: { basic: Number(form.basic) || 0, hra: Number(form.hra) || 0, allowances: Number(form.allowances) || 0 },
        variablePay: Number(form.variablePay) || 0,
        bonus: Number(form.bonus) || 0,
      },
    };
    try {
      const saved = offer ? await offerService.update(offer._id, payload) : await offerService.create(payload);
      onSaved?.(saved);
    } catch (requestError) {
      setError(requestError.message || 'Offer could not be saved');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="h-80 animate-pulse rounded-2xl bg-slate-900" />;

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">{offer ? `Edit ${offer.offerCode}` : 'Create offer draft'}</h2>
          <p className="mt-1 text-xs text-slate-500">All terms remain Draft until submitted and independently approved.</p>
        </div>
        {onCancel ? <button type="button" className="btn-ghost" onClick={onCancel} aria-label="Close editor"><X className="h-4 w-4" /></button> : null}
      </div>

      {error ? <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        {!offer ? (
          <label className="md:col-span-2"><span className="label">Selected candidate</span><select className="input" required value={form.candidateId} onChange={change('candidateId')}><option value="">Choose a selected candidate</option>{options.candidates.map((item) => <option key={item.id} value={item.id}>{item.candidateCode} · {item.name} · {item.job.title}</option>)}</select></label>
        ) : null}
        <label className="md:col-span-2"><span className="label">Offer template</span><select className="input" required value={form.templateId} onChange={change('templateId')}>{templates.map((item) => <option key={item._id} value={item._id}>{item.name} · v{item.version}{item.isDefault ? ' · Default' : ''}</option>)}</select></label>
        <label><span className="label">Designation</span><input className="input" required maxLength="180" value={form.designation} onChange={change('designation')} /></label>
        <label><span className="label">Department</span><input className="input" maxLength="160" value={form.departmentName} onChange={change('departmentName')} /></label>
        <label><span className="label">Location</span><input className="input" required maxLength="240" value={form.location} onChange={change('location')} /></label>
        <label><span className="label">Reporting manager</span><select className="input" value={form.reportingManagerId} onChange={change('reportingManagerId')}><option value="">To be assigned</option>{options.reportingManagers.map((item) => <option key={item.id} value={item.id}>{item.name} · {enumLabel(item.role)}</option>)}</select></label>
        <label><span className="label">Employment type</span><select className="input" value={form.employmentType} onChange={change('employmentType')}>{['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'].map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label>
        <label><span className="label">Work mode</span><select className="input" value={form.workMode} onChange={change('workMode')}>{['ONSITE', 'REMOTE', 'HYBRID'].map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label>
        <label><span className="label">Offer date</span><input className="input" type="date" required value={form.offerDate} onChange={change('offerDate')} /></label>
        <label><span className="label">Offer expiry</span><input className="input" type="date" required value={form.expiryDate} onChange={change('expiryDate')} /></label>
        <label><span className="label">Joining date</span><input className="input" type="date" required value={form.joiningDate} onChange={change('joiningDate')} /></label>
        <label><span className="label">Currency</span><input className="input uppercase" required minLength="3" maxLength="3" value={form.currency} onChange={change('currency')} /></label>
        <label><span className="label">Annual CTC</span><input className="input" type="number" required min="0.01" step="0.01" value={form.annualCTC} onChange={change('annualCTC')} /></label>
        <label><span className="label">Monthly basic</span><input className="input" type="number" min="0" step="0.01" value={form.basic} onChange={change('basic')} /></label>
        <label><span className="label">Monthly HRA</span><input className="input" type="number" min="0" step="0.01" value={form.hra} onChange={change('hra')} /></label>
        <label><span className="label">Monthly allowances</span><input className="input" type="number" min="0" step="0.01" value={form.allowances} onChange={change('allowances')} /></label>
        <label><span className="label">Variable pay</span><input className="input" type="number" min="0" step="0.01" value={form.variablePay} onChange={change('variablePay')} /></label>
        <label><span className="label">Offer bonus</span><input className="input" type="number" min="0" step="0.01" value={form.bonus} onChange={change('bonus')} /></label>
        <label><span className="label">Probation months</span><input className="input" type="number" min="0" max="36" value={form.probationMonths} onChange={change('probationMonths')} /></label>
        <label><span className="label">Notice period days</span><input className="input" type="number" min="0" max="365" value={form.noticePeriodDays} onChange={change('noticePeriodDays')} /></label>
        <label className="md:col-span-2"><span className="label">Additional terms</span><textarea className="input min-h-24" maxLength="5000" value={form.additionalTerms} onChange={change('additionalTerms')} /></label>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
        <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-indigo-300" /><h3 className="font-semibold text-slate-100">Safe plain-text preview</h3></div>
        <pre className="mt-4 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-slate-300">{preview || 'Choose a template to preview the offer.'}</pre>
      </section>

      <div className="flex justify-end gap-3">
        {onCancel ? <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button> : null}
        <button type="submit" className="btn-primary gap-2" disabled={busy}><Save className="h-4 w-4" />{busy ? 'Saving…' : 'Save Draft'}</button>
      </div>
    </form>
  );
};

export default OfferEditor;
