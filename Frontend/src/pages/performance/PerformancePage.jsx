// ============================================================
// 🎯 Performance Management
// Employee: goals → progress → self review → final rating + history
// Seniors: team review board · HR: cycle controls
// ============================================================
import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  getCycles, getMyAppraisal, getTeamBoard, createCycle, transitionCycle,
  saveGoals, updateProgress, submitSelfReview, submitReview, getHistory, enrollMissing,
} from '../../services/perfService.js';

const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const btn = 'rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50';
const primary = `${btn} bg-indigo-600 text-white hover:bg-indigo-500`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const PHASES = ['GOAL_SETTING', 'ACTIVE', 'SELF_REVIEW', 'REVIEW', 'CLOSED'];
const PHASE_LABEL = { GOAL_SETTING: '🎯 Set goals', ACTIVE: '💼 Work period', SELF_REVIEW: '📝 Self review', REVIEW: '🧑‍⚖️ TL + Manager review', CLOSED: '⭐ Final rating published' };
const STATUS_CHIP = {
  GOALS: 'bg-slate-500/20 text-slate-300', IN_PROGRESS: 'bg-sky-400/15 text-sky-300',
  SELF_SUBMITTED: 'bg-amber-400/15 text-amber-300', TL_DONE: 'bg-indigo-400/15 text-indigo-300',
  MGR_DONE: 'bg-purple-400/15 text-purple-300', CLOSED: 'bg-emerald-400/15 text-emerald-300',
};
const chip = (txt, cls) => <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{txt}</span>;

const Stars = ({ value, onChange, size = 'text-xl' }) => (
  <span className={`inline-flex gap-1 ${size}`}>
    {[1, 2, 3, 4, 5].map((n) => (
      <button
        key={n} type="button"
        onClick={() => onChange && onChange(n)}
        className={`${onChange ? 'cursor-pointer' : 'cursor-default'} transition ${value >= n ? 'text-amber-400' : 'text-slate-600'}`}
      >
        ★
      </button>
    ))}
  </span>
);

const PhaseStepper = ({ status }) => {
  const idx = PHASES.indexOf(status);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PHASES.map((p, i) => (
        <React.Fragment key={p}>
          {i > 0 && <span className={`h-px w-5 ${i <= idx ? 'bg-indigo-400' : 'bg-slate-600'}`} />}
          {chip(PHASE_LABEL[p], i === idx ? 'bg-indigo-500/25 text-indigo-200 ring-1 ring-indigo-400/50' : i < idx ? 'bg-emerald-400/10 text-emerald-300' : 'bg-slate-700/40 text-slate-500')}
        </React.Fragment>
      ))}
    </div>
  );
};

export default function PerformancePage() {
  const me = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);
  const isSenior = isHR || ['MANAGER', 'TEAM_LEAD'].includes(me?.role);

  const [cyclesBox, setCyclesBox] = useState({ cycles: [], currentId: null });
  const [mine, setMine] = useState(null);          // { appraisal, cycle }
  const [team, setTeam] = useState([]);
  const [historyRows, setHistoryRows] = useState([]);
  const [goalsDraft, setGoalsDraft] = useState([]);
  const [selfForm, setSelfForm] = useState({ summary: '', rating: 0 });
  const [reviewTarget, setReviewTarget] = useState(null); // appraisal being reviewed
  const [reviewForm, setReviewForm] = useState({ rating: 0, feedback: '' });
  const [cycleForm, setCycleForm] = useState({ name: '', startDate: '', endDate: '' });
  const [showNewCycle, setShowNewCycle] = useState(false);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => {
    const list = cyclesBox.cycles || [];
    return list.find((c) => c._id === cyclesBox.currentId) || list[0] || null;
  }, [cyclesBox]);

  const flash = (okv, text) => { setBanner({ ok: okv, text }); setTimeout(() => setBanner(null), 3500); };

  const loadAll = async () => {
    try {
      const box = await getCycles();
      setCyclesBox(Array.isArray(box) ? { cycles: box, currentId: null } : box);
      const cycleId = (Array.isArray(box) ? box : box.cycles)?.find((c) => c._id === (box.currentId))?._id
        || (Array.isArray(box) ? box[0] : box.cycles[0])?._id;
      if (cycleId) {
        try {
          const m = await getMyAppraisal(cycleId);
          setMine(m);
          setGoalsDraft(m?.appraisal?.goals || []);
          setSelfForm({
            summary: m?.appraisal?.selfReview?.summary || '',
            rating: m?.appraisal?.selfReview?.rating || 0,
          });
        } catch { setMine(null); }
        if (isSenior) {
          try {
            const t = await getTeamBoard(cycleId);
            setTeam(t?.appraisals || []);
          } catch { setTeam([]); }
        }
      }
      setHistoryRows(await getHistory());
    } catch {
      flash(false, 'Could not load performance data');
    }
  };
  useEffect(() => { loadAll(); }, []);

  const cycle = mine?.cycle || current;
  const app = mine?.appraisal;
  const phase = cycle?.status;
  const goalsEditable = ['GOAL_SETTING', 'ACTIVE'].includes(phase);

  /* ── actions ── */
  const doCreateCycle = async () => {
    if (!cycleForm.name.trim()) return flash(false, 'Cycle name needed');
    setBusy(true);
    try {
      await createCycle(cycleForm);
      setShowNewCycle(false); setCycleForm({ name: '', startDate: '', endDate: '' });
      flash(true, 'Cycle started — everyone got a 🔔');
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doAdvance = async () => {
    setBusy(true);
    try {
      await transitionCycle(cycle._id, PHASES[PHASES.indexOf(phase) + 1]);
      flash(true, `Phase → ${PHASE_LABEL[PHASES[PHASES.indexOf(phase) + 1]]}`);
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doSaveGoals = async () => {
    setBusy(true);
    try {
      await saveGoals(app._id, goalsDraft);
      flash(true, 'Goals saved 🎯');
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doProgress = async (goalId, progress, note) => {
    try { await updateProgress(app._id, goalId, progress, note); await loadAll(); }
    catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
  };

  const doSelfReview = async () => {
    if (!selfForm.summary.trim() || !selfForm.rating) return flash(false, 'Summary + star rating needed');
    setBusy(true);
    try {
      await submitSelfReview(app._id, selfForm);
      flash(true, 'Self-review submitted ✅');
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doReview = async () => {
    if (!reviewForm.rating) return flash(false, 'Pick a star rating');
    setBusy(true);
    try {
      await submitReview(reviewTarget._id, reviewForm);
      setReviewTarget(null); setReviewForm({ rating: 0, feedback: '' });
      flash(true, 'Review saved ✅');
      await loadAll();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const setGoal = (i, patch) => setGoalsDraft((g) => g.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-slate-100">🎯 Performance</h1>
        {cycle && <span className="text-sm text-slate-400">{cycle.name} {cycle.startDate ? `· ${fmtDate(cycle.startDate)} → ${fmtDate(cycle.endDate)}` : ''}</span>}
      </div>

      {banner && <div className={`rounded-lg px-4 py-2.5 text-sm font-medium ${banner.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{banner.text}</div>}

      {!cycle ? (
        <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-8 text-center text-sm text-slate-400">
          No performance cycle yet.{isHR ? ' Start one below 👇' : ' HR will start one soon.'}
          {isHR && (
            <div className="mt-3"><button onClick={() => setShowNewCycle(true)} className={primary}>＋ Start a cycle</button></div>
          )}
        </div>
      ) : (
        <>
          {/* cycle banner + HR controls */}
          <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1"><PhaseStepper status={phase} /></div>
              {isHR && phase !== 'CLOSED' && (
                <button disabled={busy} onClick={doAdvance} className={primary}>
                  ⏭ Move to: {PHASE_LABEL[PHASES[PHASES.indexOf(phase) + 1]]}
                </button>
              )}
              {isHR && <button onClick={() => setShowNewCycle(true)} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}>＋ New cycle</button>}
              {isHR && <button onClick={async () => { await enrollMissing(cycle._id); flash(true, 'New joiners enrolled'); }} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}>↻ Enroll joiners</button>}
            </div>
          </section>

          {/* MY appraisal */}
          {app && (
            <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4 space-y-4">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-slate-300">📋 My appraisal</h2>
                {chip(app.status.replaceAll('_', ' '), STATUS_CHIP[app.status])}
                {phase === 'CLOSED' && app.finalRating != null && (
                  <span className="ml-auto text-right">
                    <span className="text-2xl font-extrabold text-amber-400">{app.finalRating}</span>
                    <span className="text-sm text-slate-400"> /5</span>
                    <Stars value={Math.round(app.finalRating)} size="ml-2 text-base" />
                  </span>
                )}
              </div>

              {/* goals */}
              <div className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Goals & KPIs {goalsEditable ? '' : '🔒'}</p>
                {goalsDraft.map((g, i) => (
                  <div key={g._id || i} className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <input className={`${inp} flex-1 min-w-[180px]`} placeholder="Goal title" value={g.title}
                        disabled={!goalsEditable} onChange={(e) => setGoal(i, { title: e.target.value })} />
                      <input className={`${inp} flex-1 min-w-[160px]`} placeholder="KPI / target (e.g. ship 6 features)" value={g.kpi}
                        disabled={!goalsEditable} onChange={(e) => setGoal(i, { kpi: e.target.value })} />
                      <input className={`${inp} w-24`} type="number" min="0" max="100" placeholder="Weight %" value={g.weight}
                        disabled={!goalsEditable} onChange={(e) => setGoal(i, { weight: e.target.value })} />
                      {goalsEditable && (
                        <button onClick={() => setGoalsDraft((x) => x.filter((_, j) => j !== i))} className={`${btn} border border-red-500/40 text-red-300 hover:bg-red-500/10`}>🗑</button>
                      )}
                    </div>
                    {(phase === 'ACTIVE' || g.progress > 0) && (
                      <div className="flex items-center gap-3">
                        <input type="range" min="0" max="100" value={g.progress || 0} disabled={phase !== 'ACTIVE'}
                          onChange={(e) => setGoal(i, { progress: Number(e.target.value) })}
                          onMouseUp={() => g._id && doProgress(g._id, goalsDraft[i].progress)}
                          onTouchEnd={() => g._id && doProgress(g._id, goalsDraft[i].progress)}
                          className="flex-1 accent-indigo-500" />
                        <span className="w-10 text-right text-xs font-bold text-indigo-300">{g.progress || 0}%</span>
                      </div>
                    )}
                  </div>
                ))}
                {goalsEditable && goalsDraft.length < 12 && (
                  <button onClick={() => setGoalsDraft((g) => [...g, { title: '', kpi: '', weight: 0, progress: 0, note: '' }])}
                    className={`${btn} border border-dashed border-slate-500 text-slate-300 hover:bg-slate-700/40`}>＋ Add goal</button>
                )}
                {goalsEditable && goalsDraft.length > 0 && (
                  <button disabled={busy} onClick={doSaveGoals} className={primary}>💾 Save goals</button>
                )}
              </div>

              {/* self review */}
              {phase === 'SELF_REVIEW' && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                  <p className="text-xs font-bold uppercase tracking-wide text-amber-300">📝 Self review {app.selfReview?.submittedAt ? '— submitted ✅' : '— open now'}</p>
                  {!app.selfReview?.submittedAt ? (
                    <>
                      <textarea className={`${inp} min-h-[90px]`} placeholder="What did you achieve this cycle? Highlights, numbers, blockers…"
                        value={selfForm.summary} onChange={(e) => setSelfForm({ ...selfForm, summary: e.target.value })} />
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-400">Rate your cycle:</span>
                        <Stars value={selfForm.rating} onChange={(r) => setSelfForm({ ...selfForm, rating: r })} />
                        <button disabled={busy} onClick={doSelfReview} className="ml-auto rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-500 disabled:opacity-50">Submit self review</button>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-slate-300">"{app.selfReview.summary}" <Stars value={app.selfReview.rating} size="ml-2 text-sm" /></p>
                  )}
                </div>
              )}
              {phase === 'REVIEW' && app.selfReview?.submittedAt && (
                <p className="text-xs text-slate-400">✅ Your self-review is in — TL/Manager reviews are running{app.tlReview?.submitted ? ' · TL review done' : ''}{app.mgrReview?.submitted ? ' · Manager review done' : ''}</p>
              )}

              {/* revealed after close */}
              {phase === 'CLOSED' && (
                <div className="grid gap-3 sm:grid-cols-3">
                  {[['🧑‍🤝‍🧑 Self', app.selfReview], ['👥 Team Lead', app.tlReview], ['🧑‍💼 Manager', app.mgrReview]].map(([label, r]) => (
                    <div key={label} className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                      <p className="text-xs font-bold text-slate-300">{label}</p>
                      {r?.at || r?.submittedAt ? (
                        <>
                          <Stars value={r.rating || 0} size="text-base" />
                          <p className="mt-1 text-xs text-slate-400">{r.feedback || r.summary || '—'}</p>
                        </>
                      ) : <p className="mt-1 text-xs text-slate-500">not submitted</p>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* TEAM BOARD (seniors) */}
          {isSenior && (
            <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">👥 Team board ({team.length})</h2>
              {team.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-600 p-4 text-center text-xs text-slate-500">Nobody in your review scope for this cycle.</p>
              ) : (
                <div className="space-y-2">
                  {team.map((a) => {
                    const mySlot = me?.role === 'TEAM_LEAD' ? a.tlReview : a.mgrReview;
                    const canReview = phase === 'REVIEW' && !mySlot?.at && String(a.user?._id) !== String(me?._id);
                    return (
                      <div key={a._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-100">{a.user?.name}</p>
                          <p className="text-xs text-slate-400">{a.user?.designation || a.user?.role} · {a.goals?.length || 0} goal(s)</p>
                        </div>
                        {chip(a.status.replaceAll('_', ' '), STATUS_CHIP[a.status])}
                        <span className="text-[11px] text-slate-500">
                          self {a.selfReview?.submittedAt ? '✅' : '⏳'} · TL {a.tlReview?.at ? '✅' : '⏳'} · Mgr {a.mgrReview?.at ? '✅' : '⏳'}
                        </span>
                        {phase === 'CLOSED' && a.finalRating != null && <span className="text-sm font-extrabold text-amber-400">{a.finalRating}★</span>}
                        {canReview && (
                          <button onClick={() => { setReviewTarget(a); setReviewForm({ rating: 0, feedback: '' }); }} className={primary}>
                            🧑‍⚖️ Review
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* HISTORY */}
          <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">🕓 Performance history</h2>
            {historyRows.length === 0 ? (
              <p className="text-xs text-slate-500">Nothing yet — history builds after the first closed cycle.</p>
            ) : (
              <div className="space-y-2">
                {historyRows.map((h) => (
                  <div key={h._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-sm">
                    <span className="flex-1 font-semibold text-slate-200">{h.cycle?.name || 'Cycle'}</span>
                    <span className="text-xs text-slate-500">{fmtDate(h.cycle?.closedAt)}</span>
                    {h.finalRating != null ? (
                      <span className="font-extrabold text-amber-400">{h.finalRating}★</span>
                    ) : chip('no rating', 'bg-slate-600/30 text-slate-400')}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* new cycle modal */}
      {showNewCycle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowNewCycle(false)}>
          <div className="w-full max-w-md space-y-3 rounded-xl border border-slate-600 bg-slate-800 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-100">🎯 Start performance cycle</h3>
            <input className={inp} placeholder='Name — e.g. "H2 2026"' value={cycleForm.name} onChange={(e) => setCycleForm({ ...cycleForm, name: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <div><label className="mb-1 block text-xs text-slate-400">Start</label><input type="date" className={inp} value={cycleForm.startDate} onChange={(e) => setCycleForm({ ...cycleForm, startDate: e.target.value })} /></div>
              <div><label className="mb-1 block text-xs text-slate-400">End</label><input type="date" className={inp} value={cycleForm.endDate} onChange={(e) => setCycleForm({ ...cycleForm, endDate: e.target.value })} /></div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowNewCycle(false)} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}>Cancel</button>
              <button onClick={doCreateCycle} disabled={busy} className={primary}>{busy ? 'Starting…' : 'Start + notify everyone 🔔'}</button>
            </div>
          </div>
        </div>
      )}

      {/* review modal */}
      {reviewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setReviewTarget(null)}>
          <div className="w-full max-w-md space-y-3 rounded-xl border border-slate-600 bg-slate-800 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-100">
              🧑‍⚖️ Review — {reviewTarget.user?.name} <span className="text-xs font-normal text-slate-400">({me?.role === 'TEAM_LEAD' ? 'Team Lead review' : 'Manager review'})</span>
            </h3>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/40 p-2">
              {(reviewTarget.goals || []).map((g, i) => (
                <p key={i} className="text-xs text-slate-300">• {g.title} <span className="text-slate-500">{g.kpi ? `— ${g.kpi} · ` : ''}{g.progress || 0}%</span></p>
              ))}
              {(!reviewTarget.goals || !reviewTarget.goals.length) && <p className="text-xs text-slate-500">No goals recorded.</p>}
              {reviewTarget.selfReview?.summary && (
                <p className="border-t border-slate-700 pt-1 text-xs text-slate-400">📝 Self: "{reviewTarget.selfReview.summary}" <Stars value={reviewTarget.selfReview.rating || 0} size="text-xs" /></p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">Your rating:</span>
              <Stars value={reviewForm.rating} onChange={(r) => setReviewForm({ ...reviewForm, rating: r })} />
            </div>
            <textarea className={`${inp} min-h-[80px]`} placeholder="Feedback for the employee (visible after the cycle closes)…" value={reviewForm.feedback} onChange={(e) => setReviewForm({ ...reviewForm, feedback: e.target.value })} />
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setReviewTarget(null)} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}>Cancel</button>
              <button onClick={doReview} disabled={busy} className={primary}>{busy ? 'Saving…' : 'Submit review'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}