/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  Columns3,
  Eye,
  FilePenLine,
  FilePlus2,
  Filter,
  History,
  List,
  Search,
  Send,
  Users,
  X,
} from 'lucide-react';
import useAuth from '../../hooks/useAuth.jsx';
import usePermission from '../../hooks/usePermission.js';
import requisitionService from '../../services/requisitionService.js';
import { ROLES } from '../../utils/roles.js';

const STATUS_COLUMNS = [
  { key: 'DRAFT', label: 'Draft', accent: 'bg-slate-400' },
  { key: 'PENDING_HR', label: 'Pending HR', accent: 'bg-amber-400' },
  { key: 'APPROVED', label: 'Approved', accent: 'bg-emerald-400' },
  { key: 'SENT_BACK', label: 'Sent back', accent: 'bg-sky-400' },
  { key: 'REJECTED', label: 'Rejected', accent: 'bg-rose-400' },
  { key: 'FULFILLED', label: 'Fulfilled', accent: 'bg-indigo-400' },
  { key: 'CANCELLED', label: 'Cancelled', accent: 'bg-slate-600' },
];

const STATUS_STYLE = {
  DRAFT: 'border-slate-500/40 bg-slate-500/10 text-slate-300',
  SUBMITTED: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  PENDING_HR: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  APPROVED: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  REJECTED: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  SENT_BACK: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  CANCELLED: 'border-slate-600 bg-slate-800 text-slate-400',
  FULFILLED: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300',
};

const PRIORITY_STYLE = {
  LOW: 'text-slate-400',
  MEDIUM: 'text-sky-300',
  HIGH: 'text-amber-300',
  CRITICAL: 'text-rose-300',
};

const EMPTY_FORM = {
  department: '',
  team: '',
  position: '',
  openings: 1,
  experienceLevel: 'EXPERIENCED',
  minExperience: 1,
  maxExperience: 3,
  requiredSkills: '',
  preferredSkills: '',
  salaryMin: '',
  salaryMax: '',
  hiringBudget: '',
  employmentType: 'FULL_TIME',
  workMode: 'ONSITE',
  location: '',
  hiringReason: 'NEW_POSITION',
  hiringReasonDetails: '',
  priority: 'MEDIUM',
  expectedJoiningDate: '',
};

const fullAccessRoles = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];
const creatorRoles = [...fullAccessRoles, ROLES.MANAGER, ROLES.TEAM_LEAD];

const enumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : 'Not set';

const dateTimeLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : 'Not set';

const moneyLabel = (value) =>
  value === null || value === undefined || value === ''
    ? 'Not set'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(value);

const splitSkills = (value) =>
  String(value || '')
    .split(',')
    .map((skill) => skill.trim())
    .filter(Boolean);

const personId = (person) => String(person?._id || person || '');

const StatusBadge = ({ status }) => (
  <span
    className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
      STATUS_STYLE[status] || STATUS_STYLE.DRAFT
    }`}
  >
    {enumLabel(status)}
  </span>
);

const PanelModal = ({ title, subtitle = '', onClose, wide = false, children }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    onMouseDown={onClose}
  >
    <section
      className={`max-h-[92vh] w-full overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl ${
        wide ? 'max-w-5xl' : 'max-w-xl'
      }`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-700 bg-slate-900/95 px-6 py-4 backdrop-blur">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="p-6">{children}</div>
    </section>
  </div>
);

const Field = ({ label, hint = '', children, className = '' }) => (
  <label className={`block ${className}`}>
    <span className="mb-1.5 block text-xs font-medium text-slate-300">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
  </label>
);

const DetailItem = ({ label, value }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
    <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
    <div className="mt-1 text-sm text-slate-200">{value || 'Not set'}</div>
  </div>
);

const RequisitionCard = ({ requisition, onView, onEdit, onSubmit, canManage }) => {
  const editable = ['DRAFT', 'SENT_BACK'].includes(requisition.status);

  return (
    <article className="rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-sm transition hover:border-slate-600">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-indigo-300">
            {requisition.requisitionNumber}
          </p>
          <h3 className="mt-1 truncate text-sm font-semibold text-slate-100">
            {requisition.position}
          </h3>
        </div>
        <span className={`text-[10px] font-semibold ${PRIORITY_STYLE[requisition.priority]}`}>
          {requisition.priority}
        </span>
      </div>

      <div className="mt-3 space-y-1.5 text-xs text-slate-400">
        <p className="flex items-center gap-2">
          <Building2 className="h-3.5 w-3.5" />
          <span className="truncate">{requisition.department?.name || 'Department unavailable'}</span>
        </p>
        <p className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5" />
          {requisition.openings} opening{requisition.openings === 1 ? '' : 's'}
        </p>
        <p className="flex items-center gap-2">
          <CalendarDays className="h-3.5 w-3.5" />
          Join by {dateLabel(requisition.expectedJoiningDate)}
        </p>
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-slate-800 pt-3">
        <button
          type="button"
          onClick={() => onView(requisition)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white"
        >
          <Eye className="h-3.5 w-3.5" /> View
        </button>
        {canManage(requisition) && editable && (
          <>
            <button
              type="button"
              onClick={() => onEdit(requisition)}
              className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 hover:text-sky-200"
            >
              <FilePenLine className="h-3.5 w-3.5" /> Edit
            </button>
            <button
              type="button"
              onClick={() => onSubmit(requisition)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300 hover:text-emerald-200"
            >
              <Send className="h-3.5 w-3.5" /> Submit
            </button>
          </>
        )}
      </div>
    </article>
  );
};

const RequisitionsPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { hasAnyPermission, hasPermission } = usePermission();
  const isFullAccess = fullAccessRoles.includes(user?.role);
  const canCreate = creatorRoles.includes(user?.role);
  const canCreateJob = hasPermission('RECRUITMENT_CREATE');
  const canReadCandidates = hasPermission('CANDIDATE_READ');
  const canReview = hasAnyPermission([
    'REQUISITION_APPROVE',
    'REQUISITION_REJECT',
    'REQUISITION_SEND_BACK',
  ]);

  const [requisitions, setRequisitions] = useState([]);
  const [summary, setSummary] = useState({});
  const [options, setOptions] = useState({ departments: [] });
  const [filters, setFilters] = useState({ search: '', status: '', priority: '' });
  const [appliedSearch, setAppliedSearch] = useState('');
  const [view, setView] = useState('KANBAN');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [formModal, setFormModal] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [detail, setDetail] = useState(null);
  const [submitTarget, setSubmitTarget] = useState(null);
  const [submitComment, setSubmitComment] = useState('');

  const errorText = (error) => error?.message || 'Something went wrong';
  const flash = (type, message) => {
    setBanner({ type, message });
    window.setTimeout(() => setBanner(null), 5000);
  };

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const result = await requisitionService.list({
        search: appliedSearch || undefined,
        status: filters.status || undefined,
        priority: filters.priority || undefined,
        limit: 200,
      });
      setRequisitions(result.requisitions);
      setSummary(result.summary || result.meta?.summary || {});
    } catch (error) {
      flash('error', errorText(error));
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, filters.priority, filters.status]);

  const loadOptions = useCallback(async () => {
    try {
      const result = await requisitionService.options();
      setOptions(result || { departments: [] });
    } catch (error) {
      flash('error', errorText(error));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  const totalOpenings = useMemo(
    () => requisitions.reduce((total, item) => total + (Number(item.openings) || 0), 0),
    [requisitions]
  );

  const canManageRecord = (requisition) =>
    isFullAccess || personId(requisition.requester) === personId(user);

  const openCreate = () => {
    setForm({
      ...EMPTY_FORM,
      department: options.departments?.length === 1 ? options.departments[0]._id : '',
    });
    setFormModal({ mode: 'CREATE', requisition: null });
  };

  const openEdit = (requisition) => {
    setForm({
      department: requisition.department?._id || requisition.department || '',
      team: requisition.team || '',
      position: requisition.position || '',
      openings: requisition.openings || 1,
      experienceLevel: requisition.experienceLevel || 'EXPERIENCED',
      minExperience: requisition.minExperience ?? 0,
      maxExperience: requisition.maxExperience ?? 0,
      requiredSkills: (requisition.requiredSkills || []).join(', '),
      preferredSkills: (requisition.preferredSkills || []).join(', '),
      salaryMin: requisition.salaryMin ?? '',
      salaryMax: requisition.salaryMax ?? '',
      hiringBudget: requisition.hiringBudget ?? '',
      employmentType: requisition.employmentType || 'FULL_TIME',
      workMode: requisition.workMode || 'ONSITE',
      location: requisition.location || '',
      hiringReason: requisition.hiringReason || 'NEW_POSITION',
      hiringReasonDetails: requisition.hiringReasonDetails || '',
      priority: requisition.priority || 'MEDIUM',
      expectedJoiningDate: requisition.expectedJoiningDate
        ? String(requisition.expectedJoiningDate).slice(0, 10)
        : '',
    });
    setFormModal({ mode: 'EDIT', requisition });
  };

  const formValue = (field) => (event) => {
    const value = event.target.value;
    setForm((current) => ({
      ...current,
      [field]: value,
      ...(field === 'experienceLevel' && value === 'FRESHER'
        ? { minExperience: 0, maxExperience: 0 }
        : {}),
    }));
  };

  const formPayload = () => ({
    ...form,
    openings: Number(form.openings),
    minExperience: Number(form.minExperience || 0),
    maxExperience: Number(form.maxExperience || 0),
    requiredSkills: splitSkills(form.requiredSkills),
    preferredSkills: splitSkills(form.preferredSkills),
    salaryMin: form.salaryMin === '' ? null : Number(form.salaryMin),
    salaryMax: form.salaryMax === '' ? null : Number(form.salaryMax),
    hiringBudget: form.hiringBudget === '' ? null : Number(form.hiringBudget),
    expectedJoiningDate: form.expectedJoiningDate || null,
  });

  const saveDraft = async (event) => {
    event.preventDefault();
    setBusy(true);

    try {
      if (formModal.mode === 'EDIT') {
        await requisitionService.update(formModal.requisition._id, formPayload());
        flash('success', 'Requisition draft updated');
      } else {
        const created = await requisitionService.create(formPayload());
        flash('success', `${created.requisitionNumber} saved as draft`);
      }
      setFormModal(null);
      await load();
    } catch (error) {
      flash('error', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (requisition) => {
    setDetail({ ...requisition, loading: true });

    try {
      const full = await requisitionService.getById(requisition._id);
      setDetail(full);
    } catch (error) {
      setDetail(null);
      flash('error', errorText(error));
    }
  };

  const confirmSubmit = async () => {
    if (!submitTarget) return;
    setBusy(true);

    try {
      const submitted = await requisitionService.submit(
        submitTarget._id,
        submitComment.trim()
      );
      setSubmitTarget(null);
      setSubmitComment('');
      setDetail((current) =>
        current?._id === submitted._id ? submitted : current
      );
      flash('success', `${submitted.requisitionNumber} submitted to HR`);
      await load();
    } catch (error) {
      flash('error', errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const visibleByColumn = (status) =>
    requisitions.filter((item) =>
      status === 'PENDING_HR'
        ? ['SUBMITTED', 'PENDING_HR'].includes(item.status)
        : item.status === status
    );

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-indigo-300">
            <BriefcaseBusiness className="h-4 w-4" /> Recruitment workspace
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-100">Job requisitions</h1>
          <p className="mt-1 text-sm text-slate-400">
            Plan hiring demand, preserve request history, and submit approved needs to HR.
          </p>
        </div>
        {canCreate && (
          <button type="button" className="btn-primary gap-2" onClick={openCreate}>
            <FilePlus2 className="h-4 w-4" /> New requisition
          </button>
        )}
      </header>

      <nav className="flex gap-6 overflow-x-auto border-b border-slate-800 text-sm">
        <Link
          to="/app/recruitment"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Dashboard
        </Link>
        <span className="border-b-2 border-indigo-400 px-1 pb-3 font-semibold text-indigo-300">
          Requisitions
        </span>
        {isFullAccess && (
          <Link
            to="/app/recruitment/legacy"
            className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
          >
            Existing jobs & candidate pipeline
          </Link>
        )}
        {canReview && (
          <Link
            to="/app/recruitment/approvals"
            className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
          >
            HR approvals
          </Link>
        )}
        {canReadCandidates && (
          <Link
            to="/app/recruitment/candidates"
            className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
          >
            Candidates
          </Link>
        )}
        <Link
          to="/app/recruitment"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Analytics
        </Link>
      </nav>

      {banner && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            banner.type === 'error'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {banner.message}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Drafts', value: summary.DRAFT || 0, icon: FilePenLine, tone: 'text-slate-300' },
          { label: 'Pending HR', value: (summary.PENDING_HR || 0) + (summary.SUBMITTED || 0), icon: Clock3, tone: 'text-amber-300' },
          { label: 'Approved', value: summary.APPROVED || 0, icon: CheckCircle2, tone: 'text-emerald-300' },
          { label: 'Visible openings', value: totalOpenings, icon: Users, tone: 'text-indigo-300' },
        ].map(({ label, value, icon: Icon, tone }) => (
          <article key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
              <Icon className={`h-4 w-4 ${tone}`} />
            </div>
            <p className="mt-3 text-2xl font-bold text-slate-100">{value}</p>
          </article>
        ))}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <form
            className="relative flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedSearch(filters.search.trim());
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              className="input !py-2 !pl-9 text-sm"
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              placeholder="Search JR number, position, team or location"
            />
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-4 w-4 text-slate-500" />
            <select
              className="input w-auto !py-2 text-sm"
              value={filters.status}
              onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="">All statuses</option>
              {(options.statuses || []).map((status) => (
                <option key={status} value={status}>{enumLabel(status)}</option>
              ))}
            </select>
            <select
              className="input w-auto !py-2 text-sm"
              value={filters.priority}
              onChange={(event) => setFilters((current) => ({ ...current, priority: event.target.value }))}
            >
              <option value="">All priorities</option>
              {(options.priorities || []).map((priority) => (
                <option key={priority} value={priority}>{enumLabel(priority)}</option>
              ))}
            </select>
            <div className="flex rounded-lg border border-slate-700 bg-slate-950 p-1">
              <button
                type="button"
                onClick={() => setView('KANBAN')}
                className={`rounded-md p-1.5 ${view === 'KANBAN' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-500'}`}
                title="Kanban view"
              >
                <Columns3 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setView('LIST')}
                className={`rounded-md p-1.5 ${view === 'LIST' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-500'}`}
                title="List view"
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-10 text-center text-sm text-slate-400">
          Loading requisitions…
        </div>
      ) : requisitions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/60 p-12 text-center">
          <ClipboardCheck className="mx-auto h-9 w-9 text-slate-600" />
          <h2 className="mt-3 font-semibold text-slate-200">No requisitions found</h2>
          <p className="mt-1 text-sm text-slate-500">
            {canCreate ? 'Create a draft to start a traceable hiring request.' : 'No permitted requisitions are available.'}
          </p>
        </div>
      ) : view === 'KANBAN' ? (
        <section className="flex gap-4 overflow-x-auto pb-3">
          {STATUS_COLUMNS.map((column) => {
            const records = visibleByColumn(column.key);
            return (
              <div key={column.key} className="w-[290px] shrink-0 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <header className="mb-3 flex items-center gap-2 px-1">
                  <span className={`h-2.5 w-2.5 rounded-full ${column.accent}`} />
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-300">{column.label}</h2>
                  <span className="ml-auto rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">{records.length}</span>
                </header>
                <div className="space-y-3">
                  {records.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-800 px-3 py-8 text-center text-xs text-slate-600">
                      No requisitions
                    </div>
                  ) : (
                    records.map((requisition) => (
                      <RequisitionCard
                        key={requisition._id}
                        requisition={requisition}
                        onView={openDetail}
                        onEdit={openEdit}
                        onSubmit={(item) => setSubmitTarget(item)}
                        canManage={canManageRecord}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-950/50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Requisition</th>
                  <th className="px-4 py-3">Department</th>
                  <th className="px-4 py-3">Requester</th>
                  <th className="px-4 py-3">Openings</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {requisitions.map((requisition) => (
                  <tr key={requisition._id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-200">{requisition.position}</p>
                      <p className="text-xs text-indigo-300">{requisition.requisitionNumber}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{requisition.department?.name || '—'}</td>
                    <td className="px-4 py-3 text-slate-400">{requisition.requester?.name || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{requisition.openings}</td>
                    <td className={`px-4 py-3 text-xs font-semibold ${PRIORITY_STYLE[requisition.priority]}`}>
                      {enumLabel(requisition.priority)}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={requisition.status} /></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => openDetail(requisition)}>
                          View
                        </button>
                        {canManageRecord(requisition) && ['DRAFT', 'SENT_BACK'].includes(requisition.status) && (
                          <button type="button" className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => openEdit(requisition)}>
                            Edit
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {formModal && (
        <PanelModal
          wide
          title={formModal.mode === 'EDIT' ? `Edit ${formModal.requisition.requisitionNumber}` : 'Create job requisition'}
          subtitle="Save a draft now. Complete all required planning details before submitting to HR."
          onClose={() => !busy && setFormModal(null)}
        >
          <form className="space-y-6" onSubmit={saveDraft}>
            <section>
              <h3 className="mb-3 text-sm font-semibold text-slate-200">Hiring requirement</h3>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Field label="Department *">
                  <select className="input" value={form.department} onChange={formValue('department')} required>
                    <option value="">Choose department</option>
                    {(options.departments || []).map((department) => (
                      <option key={department._id} value={department._id}>{department.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Team" hint="Crewly currently stores this as a team name.">
                  <input className="input" value={form.team} onChange={formValue('team')} placeholder="Web Platform" maxLength={80} />
                </Field>
                <Field label="Position / designation *">
                  <input className="input" value={form.position} onChange={formValue('position')} placeholder="React Developer" required minLength={2} maxLength={120} />
                </Field>
                <Field label="Number of openings *">
                  <input className="input" type="number" min="1" max="500" value={form.openings} onChange={formValue('openings')} required />
                </Field>
                <Field label="Employment type">
                  <select className="input" value={form.employmentType} onChange={formValue('employmentType')}>
                    {(options.employmentTypes || ['FULL_TIME']).map((value) => (
                      <option key={value} value={value}>{enumLabel(value)}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Priority">
                  <select className="input" value={form.priority} onChange={formValue('priority')}>
                    {(options.priorities || ['MEDIUM']).map((value) => (
                      <option key={value} value={value}>{enumLabel(value)}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </section>

            <section className="border-t border-slate-800 pt-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-200">Candidate profile</h3>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Field label="Fresher / Experienced">
                  <select className="input" value={form.experienceLevel} onChange={formValue('experienceLevel')}>
                    {(options.experienceLevels || ['FRESHER', 'EXPERIENCED']).map((value) => (
                      <option key={value} value={value}>{enumLabel(value)}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Minimum experience (years)">
                  <input className="input" type="number" min="0" max="60" step="0.5" disabled={form.experienceLevel === 'FRESHER'} value={form.minExperience} onChange={formValue('minExperience')} />
                </Field>
                <Field label="Maximum experience (years)">
                  <input className="input" type="number" min="0" max="60" step="0.5" disabled={form.experienceLevel === 'FRESHER'} value={form.maxExperience} onChange={formValue('maxExperience')} />
                </Field>
                <Field label="Required skills *" hint="Separate skills with commas." className="md:col-span-2">
                  <input className="input" value={form.requiredSkills} onChange={formValue('requiredSkills')} placeholder="React, JavaScript, REST APIs" />
                </Field>
                <Field label="Preferred skills" hint="Separate skills with commas.">
                  <input className="input" value={form.preferredSkills} onChange={formValue('preferredSkills')} placeholder="TypeScript, Redis" />
                </Field>
              </div>
            </section>

            <section className="border-t border-slate-800 pt-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-200">Budget and workplace</h3>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Field label="Salary minimum (annual INR) *">
                  <input className="input" type="number" min="0" value={form.salaryMin} onChange={formValue('salaryMin')} placeholder="600000" />
                </Field>
                <Field label="Salary maximum (annual INR) *">
                  <input className="input" type="number" min="0" value={form.salaryMax} onChange={formValue('salaryMax')} placeholder="900000" />
                </Field>
                <Field label="Total hiring budget (INR) *">
                  <input className="input" type="number" min="0" value={form.hiringBudget} onChange={formValue('hiringBudget')} placeholder="1800000" />
                </Field>
                <Field label="Work mode">
                  <select className="input" value={form.workMode} onChange={formValue('workMode')}>
                    {(options.workModes || ['ONSITE', 'HYBRID', 'REMOTE']).map((value) => (
                      <option key={value} value={value}>{enumLabel(value)}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Location *">
                  <input className="input" value={form.location} onChange={formValue('location')} placeholder="Chennai / Remote" maxLength={120} />
                </Field>
                <Field label="Expected joining date *">
                  <input className="input" type="date" value={form.expectedJoiningDate} onChange={formValue('expectedJoiningDate')} />
                </Field>
              </div>
            </section>

            <section className="border-t border-slate-800 pt-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-200">Business reason</h3>
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Hiring reason">
                  <select className="input" value={form.hiringReason} onChange={formValue('hiringReason')}>
                    {(options.hiringReasons || ['NEW_POSITION', 'REPLACEMENT', 'EXPANSION', 'SEASONAL', 'OTHER']).map((value) => (
                      <option key={value} value={value}>{enumLabel(value)}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Reason / context" className="md:col-span-2" hint="Required when the reason is Other.">
                  <textarea className="input min-h-24" value={form.hiringReasonDetails} onChange={formValue('hiringReasonDetails')} placeholder="Explain the workforce requirement or replacement context" maxLength={500} />
                </Field>
              </div>
            </section>

            <footer className="flex flex-col-reverse gap-2 border-t border-slate-800 pt-5 sm:flex-row sm:justify-end">
              <button type="button" className="btn-ghost" onClick={() => setFormModal(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary gap-2" disabled={busy}>
                <FilePenLine className="h-4 w-4" />
                {busy ? 'Saving…' : 'Save draft'}
              </button>
            </footer>
          </form>
        </PanelModal>
      )}

      {detail && (
        <PanelModal
          wide
          title={detail.requisitionNumber || 'Requisition'}
          subtitle={detail.position || 'Loading details…'}
          onClose={() => setDetail(null)}
        >
          {detail.loading ? (
            <p className="py-10 text-center text-sm text-slate-400">Loading full history…</p>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={detail.status} />
                <span className={`text-xs font-semibold ${PRIORITY_STYLE[detail.priority]}`}>{enumLabel(detail.priority)} priority</span>
                <span className="text-xs text-slate-500">Requested by {detail.requester?.name || detail.requesterName || 'Unknown'}</span>
                {detail.status === 'APPROVED' && canCreateJob && (
                  <div className="ml-auto">
                    <button
                      type="button"
                      className="btn-primary gap-2 !px-3 !py-2 text-xs"
                      onClick={() => {
                        const jobId = detail.jobPosting?._id || detail.jobPosting;
                        setDetail(null);
                        navigate(
                          jobId
                            ? `/app/recruitment/legacy?job=${jobId}`
                            : `/app/recruitment/legacy?requisition=${detail._id}`
                        );
                      }}
                    >
                      <BriefcaseBusiness className="h-3.5 w-3.5" />
                      {detail.jobPosting ? 'Open created job' : 'Create job from approval'}
                    </button>
                  </div>
                )}
                {canManageRecord(detail) && ['DRAFT', 'SENT_BACK'].includes(detail.status) && (
                  <div className="ml-auto flex gap-2">
                    <button type="button" className="btn-ghost gap-2 !px-3 !py-2 text-xs" onClick={() => { setDetail(null); openEdit(detail); }}>
                      <FilePenLine className="h-3.5 w-3.5" /> Edit
                    </button>
                    <button type="button" className="btn-primary gap-2 !px-3 !py-2 text-xs" onClick={() => setSubmitTarget(detail)}>
                      <Send className="h-3.5 w-3.5" /> Submit to HR
                    </button>
                  </div>
                )}
              </div>

              <section>
                <h3 className="mb-3 text-sm font-semibold text-slate-200">Requirement details</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <DetailItem label="Department" value={detail.department?.name} />
                  <DetailItem label="Team" value={detail.team} />
                  <DetailItem label="Openings" value={String(detail.openings)} />
                  <DetailItem label="Employment" value={enumLabel(detail.employmentType)} />
                  <DetailItem label="Experience" value={detail.experienceLevel === 'FRESHER' ? 'Fresher' : `${detail.minExperience}–${detail.maxExperience} years`} />
                  <DetailItem label="Work mode" value={enumLabel(detail.workMode)} />
                  <DetailItem label="Location" value={detail.location} />
                  <DetailItem label="Expected joining" value={dateLabel(detail.expectedJoiningDate)} />
                </div>
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <h3 className="text-sm font-semibold text-slate-200">Skills</h3>
                  <p className="mt-3 text-xs text-slate-500">Required</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(detail.requiredSkills || []).length
                      ? detail.requiredSkills.map((skill) => <span key={skill} className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-300">{skill}</span>)
                      : <span className="text-xs text-slate-500">Not set</span>}
                  </div>
                  <p className="mt-4 text-xs text-slate-500">Preferred</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(detail.preferredSkills || []).length
                      ? detail.preferredSkills.map((skill) => <span key={skill} className="rounded-full bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300">{skill}</span>)
                      : <span className="text-xs text-slate-500">Not set</span>}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200"><CircleDollarSign className="h-4 w-4 text-emerald-300" /> Budget</h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <DetailItem label="Salary min" value={moneyLabel(detail.salaryMin)} />
                    <DetailItem label="Salary max" value={moneyLabel(detail.salaryMax)} />
                    <DetailItem label="Hiring budget" value={moneyLabel(detail.hiringBudget)} />
                  </div>
                  <p className="mt-4 text-xs text-slate-500">Reason</p>
                  <p className="mt-1 text-sm text-slate-300">{enumLabel(detail.hiringReason)}{detail.hiringReasonDetails ? ` — ${detail.hiringReasonDetails}` : ''}</p>
                </div>
              </section>

              <section>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200"><History className="h-4 w-4 text-indigo-300" /> Requisition history</h3>
                <div className="space-y-3">
                  {[...(detail.history || [])].reverse().map((entry, index) => (
                    <div key={entry._id || `${entry.action}-${index}`} className="flex gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                      <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-indigo-400" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-slate-200">{enumLabel(entry.action)}</p>
                          {entry.fromStatus && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                              {enumLabel(entry.fromStatus)} <ArrowRight className="h-3 w-3" /> {enumLabel(entry.toStatus)}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {entry.actor?.name || entry.actorName || 'System'} · {dateTimeLabel(entry.at)}
                        </p>
                        {entry.comment && <p className="mt-2 text-xs text-slate-300">{entry.comment}</p>}
                        {entry.changedFields?.length > 0 && (
                          <p className="mt-2 text-[11px] text-slate-500">Changed: {entry.changedFields.map(enumLabel).join(', ')}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
        </PanelModal>
      )}

      {submitTarget && (
        <PanelModal
          title={`Submit ${submitTarget.requisitionNumber}`}
          subtitle="This locks the draft and places it in the HR review queue."
          onClose={() => !busy && setSubmitTarget(null)}
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
              Confirm that the role, required skills, experience, salary range, budget, location, and expected joining date are complete.
            </div>
            <Field label="Submission note (optional)">
              <textarea
                className="input min-h-24"
                maxLength={500}
                value={submitComment}
                onChange={(event) => setSubmitComment(event.target.value)}
                placeholder="Context for the HR recruitment team"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => setSubmitTarget(null)}>Keep as draft</button>
              <button type="button" className="btn-primary gap-2" disabled={busy} onClick={confirmSubmit}>
                <Send className="h-4 w-4" /> {busy ? 'Submitting…' : 'Submit to HR'}
              </button>
            </div>
          </div>
        </PanelModal>
      )}
    </div>
  );
};

export default RequisitionsPage;
