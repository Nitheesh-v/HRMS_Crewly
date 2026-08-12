import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  getTask, updateTaskStatus, addComment, uploadAttachment, deleteTask, obj,
} from '../services/workService.js';

export const STATUS_META = {
  TODO: { label: 'To Do', cls: 'bg-slate-100 text-slate-600' },
  IN_PROGRESS: { label: 'In Progress', cls: 'bg-blue-100 text-blue-700' },
  IN_REVIEW: { label: 'In Review', cls: 'bg-amber-100 text-amber-700' },
  COMPLETED: { label: 'Completed', cls: 'bg-green-100 text-green-700' },
  BLOCKED: { label: 'Blocked', cls: 'bg-red-100 text-red-700' },
};

export const PRIORITY_META = {
  LOW: 'bg-slate-100 text-slate-500',
  MEDIUM: 'bg-blue-50 text-blue-600',
  HIGH: 'bg-orange-100 text-orange-700',
  CRITICAL: 'bg-red-100 text-red-700',
};

const SENIOR_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'];

const EMP_NEXT = {
  TODO: [{ to: 'IN_PROGRESS', label: '▶ Start work' }],
  IN_PROGRESS: [
    { to: 'IN_REVIEW', label: '📤 Submit for review', primary: true },
    { to: 'BLOCKED', label: '🚧 Mark blocked' },
  ],
  BLOCKED: [{ to: 'IN_PROGRESS', label: '▶ Resume' }],
  IN_REVIEW: [],
  COMPLETED: [],
};

const inp2 = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-400';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function TaskDetailModal({ taskId, onClose, onChanged }) {
  const user = useSelector((s) => s.auth.user);
  const role = user?.role;
  const [task, setTask] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!taskId) return;
    setErr('');
    try {
      setTask(obj(await getTask(taskId)));
    } catch (e) {
      setErr(e?.response?.data?.message || 'Could not load task');
    }
  }, [taskId]);

  useEffect(() => { setTask(null); load(); }, [load]);

  if (!taskId) return null;

  const me = String(user?._id || '');
  const isAssignee = String(task?.assignedTo?._id || task?.assignedTo) === me;
  const isCreator = String(task?.assignedBy?._id || task?.assignedBy) === me;
  const canReview = SENIOR_ROLES.includes(role);

  const doStatus = async (status, noteText = '') => {
    setBusy(true);
    setErr('');
    try {
      await updateTaskStatus(taskId, { status, note: noteText });
      setNote('');
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e?.response?.data?.message || 'Status update failed');
    }
    setBusy(false);
  };

  const sendComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await addComment(taskId, comment.trim());
      setComment('');
      await load();
    } catch (e) {
      setErr(e?.response?.data?.message || 'Comment failed');
    }
    setBusy(false);
  };

  const sendFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    setBusy(true);
    try {
      await uploadAttachment(taskId, fd);
      await load();
    } catch (err2) {
      setErr(err2?.response?.data?.message || 'Upload failed');
    }
    setBusy(false);
  };

  const removeTask = async () => {
    if (!window.confirm('Delete this task permanently?')) return;
    try {
      await deleteTask(taskId);
      onChanged?.();
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.message || 'Delete failed');
    }
  };

  const meta = task ? STATUS_META[task.status] || STATUS_META.TODO : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-700 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-slate-100">{task?.title || 'Loading…'}</h2>
            {task && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded-full px-2 py-0.5 font-semibold ${meta.cls}`}>{meta.label}</span>
                <span className={`rounded-full px-2 py-0.5 font-semibold ${PRIORITY_META[task.priority] || ''}`}>{task.priority}</span>
                {task.project?.name && <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 font-semibold text-indigo-300">📁 {task.project.name}</span>}
                <span className="text-slate-400">📅 Due: {fmtDate(task.dueDate)}</span>
              </div>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200">✖</button>
        </div>

        {/* body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {err && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{err}</div>}
          {!task && !err && <p className="text-sm text-slate-500">Loading task…</p>}

          {task && (
            <>
              {/* people */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-slate-700/40 p-3">
                  <p className="text-xs font-semibold uppercase text-slate-400">Assigned to</p>
                  <p className="mt-1 font-semibold text-slate-100">{task.assignedTo?.name || '—'}</p>
                  <p className="text-xs text-slate-400">{task.assignedTo?.designation || task.assignedTo?.role || ''}</p>
                </div>
                <div className="rounded-xl bg-slate-700/40 p-3">
                  <p className="text-xs font-semibold uppercase text-slate-400">Assigned by</p>
                  <p className="mt-1 font-semibold text-slate-100">{task.assignedBy?.name || '—'}</p>
                </div>
              </div>

              {task.description && (
                <div>
                  <p className="text-xs font-semibold uppercase text-slate-400">Description</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{task.description}</p>
                </div>
              )}

              {/* workflow actions */}
              <div className="rounded-xl border border-slate-700 p-3">
                <p className="mb-2 text-xs font-semibold uppercase text-slate-400">Workflow</p>

                {isAssignee && (EMP_NEXT[task.status] || []).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {EMP_NEXT[task.status].map((a) => (
                      <button
                        key={a.to}
                        disabled={busy}
                        onClick={() => doStatus(a.to)}
                        className={`rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${
                          a.primary ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                        }`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
                {isAssignee && task.status === 'IN_REVIEW' && (
                  <p className="text-sm text-amber-400">⏳ Waiting for your reviewer…</p>
                )}
                {isAssignee && task.status === 'COMPLETED' && (
                  <p className="text-sm text-green-400">🎉 Completed{task.reviewedBy?.name ? ` — approved by ${task.reviewedBy.name}` : ''}</p>
                )}

                {canReview && (
                  <div className={isAssignee ? 'mt-3 border-t border-slate-700 pt-3' : ''}>
                    {task.status === 'IN_REVIEW' && (
                      <div className="mb-2 rounded-lg bg-amber-500/10 p-3">
                        <p className="mb-2 text-sm font-semibold text-amber-300">📤 Submitted for your review</p>
                        <textarea
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="Review note (optional) — shown to the employee"
                          rows={2}
                          className={`${inp2} mb-2`}
                        />
                        <div className="flex gap-2">
                          <button disabled={busy} onClick={() => doStatus('COMPLETED', note)} className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-50">✅ Approve &amp; Complete</button>
                          <button disabled={busy} onClick={() => doStatus('IN_PROGRESS', note)} className="rounded-lg bg-slate-600 px-3 py-1.5 text-sm font-semibold text-slate-100 hover:bg-slate-500 disabled:opacity-50">🔁 Send back</button>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">Set status:</span>
                      <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${inp2} w-auto`}>
                        <option value="">Choose…</option>
                        {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                      </select>
                      <button
                        disabled={busy || !pick}
                        onClick={() => { doStatus(pick); setPick(''); }}
                        className="rounded-lg bg-indigo-600 px-3 py-1 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                )}

                {task.reviewNote && (
                  <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">🗒️ Review note: {task.reviewNote}</p>
                )}
              </div>

              {/* attachments */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase text-slate-400">Attachments ({task.attachments?.length || 0})</p>
                  <label className="cursor-pointer rounded-lg bg-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-600">
                    📎 Upload
                    <input type="file" className="hidden" onChange={sendFile} />
                  </label>
                </div>
                {(task.attachments || []).length === 0 && <p className="text-xs text-slate-500">No files yet.</p>}
                <ul className="space-y-1">
                  {(task.attachments || []).map((a) => (
                    <li key={a._id} className="flex items-center justify-between rounded-lg bg-slate-700/40 px-3 py-1.5 text-sm">
                      <a href={a.url} target="_blank" rel="noreferrer" className="truncate text-indigo-400 hover:underline">📎 {a.name}</a>
                      <span className="ml-2 shrink-0 text-xs text-slate-400">{a.uploadedBy?.name || ''}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* comments */}
              <div>
                <p className="mb-1 text-xs font-semibold uppercase text-slate-400">Comments ({task.comments?.length || 0})</p>
                <div className="space-y-2">
                  {(task.comments || []).map((c) => (
                    <div key={c._id} className="rounded-lg bg-slate-700/40 px-3 py-2">
                      <p className="text-xs font-semibold text-slate-300">
                        {c.user?.name || 'User'} <span className="font-normal text-slate-500">· {fmtTime(c.createdAt)}</span>
                      </p>
                      <p className="text-sm text-slate-200">{c.text}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendComment()}
                    placeholder="Write a comment…"
                    className={inp2}
                  />
                  <button disabled={busy || !comment.trim()} onClick={sendComment} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40">Send</button>
                </div>
              </div>

              {(isCreator || canReview) && (
                <button onClick={removeTask} className="text-xs font-semibold text-red-400 hover:text-red-300">🗑 Delete task</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}