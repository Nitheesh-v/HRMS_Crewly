import { useCallback, useEffect, useState } from 'react';
import api from '../../services/api';
import recruitmentService from '../../services/recruitmentService';
import Modal from '../../components/Modal';
import * as authHook from '../../hooks/useAuth';
import { ROLES } from '../../utils/roles';

const useAuth = authHook.useAuth || authHook.default;

const STAGES = [
  { key: 'APPLIED', label: 'Applied', dot: 'bg-slate-400' },
  { key: 'SCREENING', label: 'Screening', dot: 'bg-yellow-400' },
  { key: 'INTERVIEW', label: 'Interview', dot: 'bg-purple-400' },
  { key: 'OFFER', label: 'Offer', dot: 'bg-crewly-orange' },
  { key: 'HIRED', label: 'Hired 🎉', dot: 'bg-crewly-green' },
  { key: 'REJECTED', label: 'Rejected', dot: 'bg-crewly-red' },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
const OFFER_STYLE = {
  SENT: 'bg-sky-400/10 text-sky-400 border border-sky-400/40',
  ACCEPTED: 'bg-crewly-green/10 text-crewly-green border border-crewly-green/40',
  DECLINED: 'bg-crewly-red/10 text-crewly-red border border-crewly-red/40',
};
const TYPE_LABEL = { FULL_TIME: 'Full Time', PART_TIME: 'Part Time', CONTRACT: 'Contract', INTERN: 'Internship' };

const emptyJobForm = { title: '', department: '', location: 'On-site', employmentType: 'FULL_TIME', openings: 1, description: '' };
const emptyCandForm = { name: '', email: '', phone: '', resumeLink: '', notes: '' };
const isoDate = (d) => (d ? String(d).slice(0, 10) : '');

export default function RecruitmentPage() {
  const { user: me } = useAuth();
  const isHR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(me?.role);

  const [jobs, setJobs] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [banner, setBanner] = useState(null);
  const [loading, setLoading] = useState(true);

  const [jobModal, setJobModal] = useState({ open: false, editing: null });
  const [jobForm, setJobForm] = useState(emptyJobForm);
  const [candModal, setCandModal] = useState(false);
  const [candForm, setCandForm] = useState(emptyCandForm);
  const [offerModal, setOfferModal] = useState(null); // candidate
  const [offerForm, setOfferForm] = useState({ offerSalary: '', offerJoiningDate: '' });
  const [convModal, setConvModal] = useState(null);   // { candidate, result }
  const [busy, setBusy] = useState(false);

  const flash = (type, text) => { setBanner({ type, text }); setTimeout(() => setBanner(null), 5000); };
  const errText = (err) => err?.response?.data?.message || err?.message || 'Something went wrong';

  const loadJobs = useCallback(async () => {
    try {
      const list = await recruitmentService.jobs();
      const arr = Array.isArray(list) ? list : [];
      setJobs(arr);
      setSelectedId((cur) => cur || arr.find((j) => j.status === 'OPEN')?._id || arr[0]?._id || '');
    } catch (err) { flash('error', errText(err)); } finally { setLoading(false); }
  }, []);

  const loadCandidates = useCallback(async () => {
    if (!selectedId) { setCandidates([]); return; }
    try {
      const list = await recruitmentService.candidates(selectedId);
      setCandidates(Array.isArray(list) ? list : []);
    } catch (err) { flash('error', errText(err)); }
  }, [selectedId]);

  useEffect(() => { loadJobs(); }, [loadJobs]);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/departments');
        setDepartments(Array.isArray(res) ? res : res?.departments || res?.data || []);
      } catch { /* non-fatal */ }
    })();
  }, []);

  const selected = jobs.find((j) => j._id === selectedId);

  // ── job create / edit ──
  const openJobModal = (editing) => {
    setJobForm(editing
      ? {
          title: editing.title, department: editing.department?._id || '',
          location: editing.location, employmentType: editing.employmentType,
          openings: editing.openings, description: editing.description || '',
        }
      : emptyJobForm);
    setJobModal({ open: true, editing: editing || null });
  };

  const saveJob = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = { ...jobForm, openings: Number(jobForm.openings) || 1 };
      if (jobModal.editing) {
        await recruitmentService.updateJob(jobModal.editing._id, payload);
        flash('success', 'Job updated ✅');
      } else {
        await recruitmentService.createJob(payload);
        flash('success', 'Job posted 🎉');
      }
      setJobModal({ open: false, editing: null });
      loadJobs();
    } catch (err) { flash('error', errText(err)); } finally { setBusy(false); }
  };

  const toggleJobStatus = async () => {
    if (!selected) return;
    try {
      await recruitmentService.updateJob(selected._id, { status: selected.status === 'OPEN' ? 'CLOSED' : 'OPEN' });
      flash('success', selected.status === 'OPEN' ? 'Job closed' : 'Job reopened');
      loadJobs();
    } catch (err) { flash('error', errText(err)); }
  };

  // ── candidates ──
  const saveCandidate = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await recruitmentService.addCandidate({ ...candForm, job: selectedId });
      flash('success', `${candForm.name} added to pipeline 👤`);
      setCandModal(false);
      setCandForm(emptyCandForm);
      loadCandidates();
      loadJobs(); // refresh counts
    } catch (err) { flash('error', errText(err)); } finally { setBusy(false); }
  };

  const moveStage = async (c, stage) => {
    try {
      await recruitmentService.updateStage(c._id, stage);
      loadCandidates();
    } catch (err) { flash('error', errText(err)); }
  };

  const openOffer = (c) => {
    setOfferForm({ offerSalary: c.offerSalary || '', offerJoiningDate: isoDate(c.offerJoiningDate) });
    setOfferModal(c);
  };

  const sendOffer = async (offerStatus) => {
    setBusy(true);
    try {
      await recruitmentService.updateOffer(offerModal._id, {
        offerStatus,
        offerSalary: Number(offerForm.offerSalary) || 0,
        offerJoiningDate: offerForm.offerJoiningDate,
      });
      flash('success', `Offer ${offerStatus.toLowerCase()} 📨`);
      setOfferModal(null);
      loadCandidates();
    } catch (err) { flash('error', errText(err)); } finally { setBusy(false); }
  };

  const doConvert = async () => {
    setBusy(true);
    try {
      const res = await recruitmentService.convert(convModal.candidate._id);
      const data = res?.data || res; // unwrap { user, tempPassword }
      setConvModal({ candidate: convModal.candidate, result: data });
      loadCandidates();
      loadJobs();
    } catch (err) {
      flash('error', errText(err));
      setConvModal(null);
    } finally { setBusy(false); }
  };

  if (!isHR) {
    return <div className="p-6"><div className="card p-6">🚫 Recruitment is managed by Company Admin &amp; HR Manager only.</div></div>;
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">🧑‍💼 Recruitment</h1>
          <p className="text-sm text-crewly-dim">Jobs → pipeline → offer → employee. The full hiring loop.</p>
        </div>
        <button className="btn-primary" onClick={() => openJobModal(null)}>+ Post Job</button>
      </div>

      {banner && (
        <div className={`card px-4 py-3 text-sm ${banner.type === 'error' ? 'text-crewly-red' : 'text-crewly-green'}`}>{banner.text}</div>
      )}

      {/* job chips */}
      {loading ? (
        <div className="card p-4 text-crewly-dim">Loading jobs…</div>
      ) : jobs.length === 0 ? (
        <div className="card p-8 text-center text-crewly-dim">No jobs yet — click <b>+ Post Job</b> to open your first position 🚀</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {jobs.map((j) => (
            <button key={j._id} onClick={() => setSelectedId(j._id)}
              className={`rounded-lg px-3 py-2 text-sm border transition ${
                j._id === selectedId
                  ? 'border-crewly-green bg-crewly-green/10 text-crewly-green'
                  : 'border-crewly-border text-crewly-dim hover:text-crewly-text'
              }`}>
              📌 {j.title}
              <span className="ml-1 text-xs">({j.candidateCount})</span>
              {j.status === 'CLOSED' && <span className="ml-1 text-[10px] text-crewly-red">CLOSED</span>}
            </button>
          ))}
        </div>
      )}

      {/* selected job header */}
      {selected && (
        <>
          <div className="card p-4 flex flex-wrap items-center gap-3">
            <div className="flex-1">
              <div className="font-semibold">{selected.title}</div>
              <div className="text-xs text-crewly-dim">
                {TYPE_LABEL[selected.employmentType]} · {selected.location} · {selected.openings} opening(s)
                {selected.department?.name ? ` · ${selected.department.name}` : ''}
              </div>
            </div>
            <button className="btn-primary" onClick={() => setCandModal(true)} disabled={selected.status !== 'OPEN'}>+ Add Candidate</button>
            <button className="btn-ghost text-xs" onClick={() => openJobModal(selected)}>✏️ Edit Job</button>
            <button className="btn-ghost text-xs" onClick={toggleJobStatus}>
              {selected.status === 'OPEN' ? '🔒 Close Job' : '🔓 Reopen Job'}
            </button>
          </div>

          {/* pipeline board */}
          <div className="flex gap-3 overflow-x-auto pb-2">
            {STAGES.map(({ key, label, dot }) => {
              const list = candidates.filter((c) => c.stage === key);
              return (
                <div key={key} className="min-w-[215px] flex-1">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-crewly-dim">
                    <span className={`h-2 w-2 rounded-full ${dot}`} /> {label}
                    <span className="ml-auto">{list.length}</span>
                  </div>
                  <div className="space-y-2">
                    {list.length === 0 && <div className="card p-3 text-center text-[11px] text-crewly-dim">—</div>}
                    {list.map((c) => (
                      <div key={c._id} className="card p-3 space-y-2">
                        <div className="font-medium text-sm">{c.name}</div>
                        <div className="truncate text-xs text-crewly-dim" title={c.email}>{c.email}</div>
                        {c.phone && <div className="text-xs text-crewly-dim">📞 {c.phone}</div>}
                        {c.offerStatus !== 'NONE' && (
                          <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] ${OFFER_STYLE[c.offerStatus]}`}>
                            Offer {c.offerStatus.toLowerCase()}
                          </span>
                        )}
                        {c.stage !== 'HIRED' && (
                          <select className="input !py-1 text-xs" value={c.stage} onChange={(e) => moveStage(c, e.target.value)}>
                            {['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'REJECTED'].map((s) => (
                              <option key={s} value={s}>{STAGE_LABEL[s]}</option>
                            ))}
                          </select>
                        )}
                        <div className="flex gap-2">
                          {['INTERVIEW', 'OFFER'].includes(c.stage) && c.stage !== 'REJECTED' && (
                            <button className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => openOffer(c)}>💼 Offer</button>
                          )}
                          {c.offerStatus === 'ACCEPTED' && c.stage !== 'HIRED' && (
                            <button className="btn-ghost px-2 py-0.5 text-[11px] text-crewly-green"
                              onClick={() => setConvModal({ candidate: c, result: null })}>🎉 Convert</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── job modal ── */}
      {jobModal.open && (
        <Modal onClose={() => setJobModal({ open: false, editing: null })}
          title={jobModal.editing ? `✏️ Edit Job` : '📌 Post a Job'}>
          <form onSubmit={saveJob} className="space-y-3">
            <div>
              <label className="label">Job Title *</label>
              <input className="input" value={jobForm.title} onChange={(e) => setJobForm((f) => ({ ...f, title: e.target.value }))}
                required minLength={3} placeholder="Associate DevOps Engineer" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Department</label>
                <select className="input" value={jobForm.department} onChange={(e) => setJobForm((f) => ({ ...f, department: e.target.value }))}>
                  <option value="">— None —</option>
                  {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Employment Type</label>
                <select className="input" value={jobForm.employmentType} onChange={(e) => setJobForm((f) => ({ ...f, employmentType: e.target.value }))}>
                  {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Location</label>
                <input className="input" value={jobForm.location} onChange={(e) => setJobForm((f) => ({ ...f, location: e.target.value }))} placeholder="Coimbatore / Remote" />
              </div>
              <div>
                <label className="label">Openings</label>
                <input className="input" type="number" min="1" value={jobForm.openings} onChange={(e) => setJobForm((f) => ({ ...f, openings: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="label">Description</label>
              <textarea className="input" rows={3} value={jobForm.description} onChange={(e) => setJobForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What will this person work on?" />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setJobModal({ open: false, editing: null })}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : jobModal.editing ? 'Save Job' : 'Post Job'}</button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── add candidate modal ── */}
      {candModal && (
        <Modal onClose={() => setCandModal(false)} title={`👤 Add Candidate — ${selected?.title}`}>
          <form onSubmit={saveCandidate} className="space-y-3">
            <div>
              <label className="label">Full Name *</label>
              <input className="input" value={candForm.name} onChange={(e) => setCandForm((f) => ({ ...f, name: e.target.value }))} required minLength={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Email *</label>
                <input className="input" type="email" value={candForm.email} onChange={(e) => setCandForm((f) => ({ ...f, email: e.target.value }))} required />
              </div>
              <div>
                <label className="label">Phone</label>
                <input className="input" value={candForm.phone} onChange={(e) => setCandForm((f) => ({ ...f, phone: e.target.value }))} placeholder="9876543210" />
              </div>
            </div>
            <div>
              <label className="label">Resume Link (Drive/portfolio URL)</label>
              <input className="input" value={candForm.resumeLink} onChange={(e) => setCandForm((f) => ({ ...f, resumeLink: e.target.value }))} placeholder="https://…" />
            </div>
            <div>
              <label className="label">Notes</label>
              <textarea className="input" rows={2} value={candForm.notes} onChange={(e) => setCandForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setCandModal(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add to Pipeline'}</button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── offer modal ── */}
      {offerModal && (
        <Modal onClose={() => setOfferModal(null)} title={`💼 Offer — ${offerModal.name}`}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Offer Salary (₹/month)</label>
                <input className="input" type="number" min="0" value={offerForm.offerSalary}
                  onChange={(e) => setOfferForm((f) => ({ ...f, offerSalary: e.target.value }))}
                  disabled={offerModal.offerStatus !== 'NONE'} />
              </div>
              <div>
                <label className="label">Joining Date</label>
                <input className="input" type="date" value={offerForm.offerJoiningDate}
                  onChange={(e) => setOfferForm((f) => ({ ...f, offerJoiningDate: e.target.value }))}
                  disabled={offerModal.offerStatus !== 'NONE'} />
              </div>
            </div>

            {offerModal.offerStatus === 'NONE' && (
              <button className="btn-primary w-full" disabled={busy} onClick={() => sendOffer('SENT')}>
                {busy ? 'Sending…' : '📨 Mark Offer Sent'}
              </button>
            )}
            {offerModal.offerStatus === 'SENT' && (
              <>
                <p className="text-xs text-crewly-dim">Offer sent. Now record the candidate's reply:</p>
                <div className="flex gap-2">
                  <button className="btn-primary flex-1" disabled={busy} onClick={() => sendOffer('ACCEPTED')}>✅ Accepted</button>
                  <button className="btn-ghost flex-1 text-crewly-red" disabled={busy} onClick={() => sendOffer('DECLINED')}>❌ Declined</button>
                </div>
              </>
            )}
            {offerModal.offerStatus === 'ACCEPTED' && (
              <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-3 py-2 text-sm text-crewly-green">
                Offer accepted 🎉 Close this and click <b>🎉 Convert</b> on the card to create the employee account.
              </div>
            )}
            {offerModal.offerStatus === 'DECLINED' && (
              <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-3 py-2 text-sm text-crewly-red">
                Offer declined. Move the card to Rejected or keep it in Offer while you re-negotiate.
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── convert modal ── */}
      {convModal && (
        <Modal onClose={() => setConvModal(null)} title={`🎉 Convert — ${convModal.candidate.name}`}>
          {!convModal.result ? (
            <div className="space-y-3">
              <p className="text-sm text-crewly-dim">
                This will create an <b>EMPLOYEE</b> account for <b>{convModal.candidate.name}</b> ({convModal.candidate.email}),
                with designation <b>{selected?.title}</b>{selected?.department?.name ? ` in ${selected.department.name}` : ''},
                joining date from the accepted offer, and an auto employee code. A temporary password will be generated — share it with the new hire.
              </p>
              <div className="flex justify-end gap-2">
                <button className="btn-ghost" onClick={() => setConvModal(null)}>Cancel</button>
                <button className="btn-primary" disabled={busy} onClick={doConvert}>{busy ? 'Converting…' : '🎉 Convert to Employee'}</button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-3 py-2 text-sm text-crewly-green">
                Employee account created! 🎉
              </div>
              <div className="card p-3 space-y-1 text-sm">
                <div><span className="text-crewly-dim">Name:</span> {convModal.result.user?.name}</div>
                <div><span className="text-crewly-dim">Login email:</span> {convModal.result.user?.email}</div>
                <div><span className="text-crewly-dim">Employee code:</span> {convModal.result.user?.employeeCode}</div>
                <div>
                  <span className="text-crewly-dim">Temp password:</span>{' '}
                  <b className="font-mono text-crewly-green">{convModal.result.tempPassword}</b>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-ghost flex-1"
                  onClick={() => {
                    const text = `Crewly HRMS login → email: ${convModal.result.user?.email} | password: ${convModal.result.tempPassword}`;
                    try { navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
                  }}>
                  📋 Copy credentials
                </button>
                <button className="btn-primary flex-1" onClick={() => setConvModal(null)}>Done</button>
              </div>
              <p className="text-xs text-crewly-dim">⚠️ Shown once — share it now. Password can be reset later via Users → Reset PW.</p>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}