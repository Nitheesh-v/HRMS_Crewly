/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Copy,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  UserX,
  Users,
} from 'lucide-react';
import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import salaryStructureService from '../../services/salaryStructureService.js';
import employeePayrollService from '../../services/employeePayrollService.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';
import {
  Panel,
  Pill,
  StageBand,
  StageButton,
  StatCard,
} from '../../components/payroll/PayrollCockpit.jsx';

// ── display mirrors of the backend rules (the server always decides) ────────

const CATEGORIES = [
  { value: 'EARNING', label: 'Earnings' },
  { value: 'DEDUCTION', label: 'Deductions' },
  { value: 'EMPLOYER_CONTRIBUTION', label: 'Employer Contributions' },
];

const METHODS = [
  { value: 'FIXED_AMOUNT', label: 'Fixed Amount', unit: 'Rs', needsValue: true },
  { value: 'PERCENTAGE_OF_GROSS', label: 'Percentage of Gross', unit: '%', needsValue: true },
  { value: 'PERCENTAGE_OF_BASIC', label: 'Percentage of Basic', unit: '%', needsValue: true },
  { value: 'PERCENTAGE_OF_CTC', label: 'Percentage of CTC', unit: '%', needsValue: true },
  { value: 'REMAINING', label: 'Remaining Amount', unit: '', needsValue: false },
];

const STATUSES = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'ARCHIVED', label: 'Archived' },
];

/** One preview line, as the builder's live-preview table renders it. */
const previewRows = (rows) =>
  rows.map((line) => (
    <tr key={line.componentCode} className="border-b border-crewly-border/60 last:border-0">
      <td className="py-1.5">
        {line.name}
        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-crewly-dim">
          {line.methodLabel}
        </span>
      </td>
      <td className="py-1.5 text-right tabular-nums">{formatMoney(line.amount)}</td>
    </tr>
  ));

const CARDS_PER_PAGE = 6;

const emptyForm = {
  name: '',
  code: '',
  description: '',
  designation: '',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  items: [],
};

const toForm = (structure) => ({
  ...emptyForm,
  ...(structure || {}),
  designation: structure?.designation || '',
  effectiveFrom: structure?.effectiveFrom
    ? new Date(structure.effectiveFrom).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10),
  items: (structure?.items || []).map((item, index) => ({
    componentCode: item.componentCode,
    calculationMethod: item.calculationMethod,
    value: item.value ?? '',
    order: Number.isInteger(item.order) ? item.order : index,
  })),
});

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN');

/*
 * The band colours the distribution chart uses. They are the Warm Organic
 * roles in a fixed order, so the same component keeps the same colour in every
 * structure card on the page.
 */
const BAND_CLASSES = [
  'bg-st-primary',
  'bg-st-primary-container',
  'bg-st-secondary',
  'bg-st-tertiary',
  'bg-st-secondary-fixed-dim',
  'bg-st-on-variant',
];

const methodOf = (value) => METHODS.find((method) => method.value === value) || METHODS[0];

const statusBadge = (status) => {
  const styles = {
    ACTIVE: 'bg-emerald-500/15 text-emerald-300',
    DRAFT: 'bg-indigo-500/15 text-indigo-300',
    INACTIVE: 'bg-slate-700/40 text-slate-300',
    ARCHIVED: 'bg-amber-500/15 text-amber-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${styles[status] || styles.INACTIVE}`}>
      {status ? status.charAt(0) + status.slice(1).toLowerCase() : '—'}
    </span>
  );
};

const SalaryStructuresPage = () => {
  const { loading: permsLoading, hasPermission, hasAnyPermission } = usePermission();

  const [loading, setLoading] = useState(true);
  const [structures, setStructures] = useState([]);
  const [components, setComponents] = useState([]);
  const [accessDenied, setAccessDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState({ search: '', status: 'ALL', page: 1 });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  // The builder's live preview uses `sampleGross`; the card grid uses the same
  // number, so the two can never disagree about what an amount is priced at.
  const [sampleGross, setSampleGross] = useState('100000');
  const [preview, setPreview] = useState(null);
  const [previews, setPreviews] = useState({});
  const [assignment, setAssignment] = useState(null);
  const [detail, setDetail] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [addCode, setAddCode] = useState('');

  const canView = hasAnyPermission([
    'SALARY_STRUCTURE_READ',
    'SALARY_STRUCTURE_MANAGE',
    'SALARY_STRUCTURE_ACTIVATE',
  ]);
  const canManage = hasPermission('SALARY_STRUCTURE_MANAGE');
  const canActivate = hasPermission('SALARY_STRUCTURE_ACTIVATE');
  const noAccess = !permsLoading && !canView;

  /*
   * 35.1 — feedback is a toast now. The signature is unchanged so every call
   * site keeps working; only the destination moved (out of the page flow and
   * into the app-wide stack).
   */
  /*
   * 35.1 — feedback is a toast now. The signature is unchanged so every call
   * site keeps working; only the destination moved (out of the page flow and
   * into the app-wide stack).
   */
  const flash = useCallback((type, text) => {
    const body = typeof text === 'string' && text ? text : '';

    if (!body) return;

    const kind = String(type).toLowerCase();

    if (kind === 'error' || kind === 'danger' || kind === 'failed') notify.error(body);
    else if (kind === 'warning' || kind === 'warn') notify.warning(body);
    else if (kind === 'info') notify.info(body);
    else notify.success(body);
  }, []);

  /*
   * The template list is small (a company keeps a handful of structures), and
   * the cards need the whole set to report "3 active of 5" honestly. So the
   * whole tenant list is read once — the API caps it at 100 — and the search,
   * status filter and paging happen here, mirroring what the server's own
   * filterStructures() does. Nothing is widened: the server still decides which
   * structures this person may see at all.
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await salaryStructureService.list({ limit: 100 });
      setStructures(data?.data ?? data ?? []);
      setComponents(data?.meta?.components || []);
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.code === 'PERMISSION_DENIED') {
        setAccessDenied(true);
      } else {
        flash('error', error?.message || 'Unable to load salary structures');
      }
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    if (!permsLoading && canView) load();
    if (!permsLoading && !canView) setLoading(false);
  }, [permsLoading, canView, load]);

  // ── §9 live preview — pure, server-computed, never stored
  useEffect(() => {
    if (!formOpen || form.items.length === 0) {
      setPreview(null);
      return undefined;
    }

    const timer = setTimeout(async () => {
      try {
        const data = await salaryStructureService.preview({
          items: form.items.map((item) => ({
            componentCode: item.componentCode,
            calculationMethod: item.calculationMethod,
            value: item.value === '' ? null : Number(item.value),
            order: item.order,
          })),
          gross: Number(sampleGross) || 0,
        });
        setPreview(data?.data ?? data ?? null);
      } catch {
        setPreview(null);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [formOpen, form.items, sampleGross]);

  /*
   * §17 — who is actually assigned. This is a READ of the employee payroll
   * profiles (the only place an assignment exists), not a second structure
   * endpoint: `structureId` on the current profile is the assignment.
   *
   * It needs EMPLOYEE_SALARY_READ. A payroll administrator who only configures
   * structures may not hold it, so the card row says "not visible" rather than
   * printing a zero it cannot vouch for.
   */
  useEffect(() => {
    if (permsLoading || !canView) return undefined;
    let active = true;
    employeePayrollService
      .list()
      .then((data) => {
        if (!active) return;
        const profiles = data?.data ?? data?.profiles ?? [];
        const employees = data?.meta?.employees ?? data?.employees ?? [];
        const activeEmployees = employees.length || profiles.length;
        const assigned = new Set(
          (profiles || []).map((row) => String(row.structureId || '')).filter(Boolean),
        );
        const profileEmployees = new Set((profiles || []).map((row) => String(row.employeeId)));
        const withoutProfile = (employees || []).filter(
          (row) => !profileEmployees.has(String(row._id)),
        ).length;
        setAssignment({
          activeEmployees,
          assignedEmployees: (profiles || []).filter((row) => row.structureId).length,
          unassigned: activeEmployees - profileEmployees.size || withoutProfile,
          perStructure: (profiles || []).reduce((map, row) => {
            const key = String(row.structureId || '');
            if (!key) return map;
            map[key] = (map[key] || 0) + 1;
            return map;
          }, {}),
          structureIds: assigned,
        });
      })
      .catch(() => {
        if (active) setAssignment(null);
      });
    return () => {
      active = false;
    };
  }, [permsLoading, canView]);

  // §15 — the same three filters the server applies, applied to the one read.
  const filtered = useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    return structures.filter((structure) => {
      if (filters.status !== 'ALL' && structure.status !== filters.status) return false;
      if (!needle) return true;
      return [structure.name, structure.code, structure.description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [structures, filters.search, filters.status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / CARDS_PER_PAGE));
  const meta = {
    page: Math.min(filters.page, pageCount),
    pages: pageCount,
  };
  const pageRows = filtered.slice((meta.page - 1) * CARDS_PER_PAGE, meta.page * CARDS_PER_PAGE);

  const activeStructures = structures.filter((structure) => structure.status === 'ACTIVE').length;
  const assignedCount = assignment?.assignedEmployees || 0;
  const coveragePercent = assignment?.activeEmployees
    ? Math.round((assignedCount / assignment.activeEmployees) * 100)
    : 0;
  const assignedFor = (structure) => assignment?.perStructure?.[String(structure._id)] || 0;

  /*
   * §9 — the amounts under each card are the SERVER's preview for that
   * structure at the sample gross above. One POST per visible card, and the
   * server explicitly does not store the result.
   */
  useEffect(() => {
    if (!pageRows.length) {
      setPreviews({});
      return undefined;
    }
    let active = true;
    const gross = Number(sampleGross) || 0;
    if (!gross) {
      setPreviews({});
      return undefined;
    }

    Promise.all(
      pageRows.map((structure) =>
        salaryStructureService
          .preview({
            items: (structure.items || []).map((item) => ({
              componentCode: item.componentCode,
              calculationMethod: item.calculationMethod,
              value: item.value === '' ? null : Number(item.value),
              order: item.order,
            })),
            gross,
          })
          .then((data) => [structure._id, data?.data ?? data ?? null])
          .catch(() => [structure._id, null]),
      ),
    ).then((pairs) => {
      if (active) setPreviews(Object.fromEntries(pairs));
    });

    return () => {
      active = false;
    };
    // pageRows is derived from `filtered`, which is derived from structures —
    // depending on the ids keeps this from re-firing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structures, filters.search, filters.status, filters.page, sampleGross]);

  /** The card's distribution bar: earnings as a share of gross, biggest first. */
  const distribution = (structurePreview) => {
    const gross = Number(structurePreview?.totals?.gross || 0);
    if (!gross) return [];
    return (structurePreview.earnings || [])
      .filter((line) => Number(line.amount) > 0)
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 5)
      .map((line, index) => ({
        code: line.componentCode,
        name: line.name,
        amount: Number(line.amount),
        percent: Math.round((Number(line.amount) / gross) * 100),
        className: BAND_CLASSES[index % BAND_CLASSES.length],
      }));
  };

  const componentByCode = useMemo(
    () => Object.fromEntries(components.map((component) => [component.code, component])),
    [components],
  );

  const availableComponents = useMemo(
    () => components.filter((component) => !form.items.some((item) => item.componentCode === component.code)),
    [components, form.items],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setAddCode('');
    setFormOpen(true);
  };

  const openEdit = async (structure) => {
    if (!components.length) await load();
    setEditingId(structure._id);
    setForm(toForm(structure));
    setAddCode('');
    setFormOpen(true);
  };

  const openDetail = async (structure) => {
    try {
      const data = await salaryStructureService.get(structure._id);
      setDetail(data?.data ?? data ?? structure);
    } catch {
      setDetail(structure);
    }
  };

  const addComponent = () => {
    if (!addCode) return;
    setForm((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          componentCode: addCode,
          calculationMethod: 'FIXED_AMOUNT',
          value: '',
          order: prev.items.length,
        },
      ],
    }));
    setAddCode('');
  };

  /*
   * A starting point, not a policy. The classic Indian split is Basic at half
   * of gross, HRA at 40% of Basic and the balance as special allowance — and PF
   * at 12% of Basic on both sides. Every line is drawn from a component this
   * company actually has; anything missing is simply left out, and the toast
   * says which. Amounts stay editable, and Professional Tax is deliberately not
   * guessed because the slab belongs to the employee's state.
   */
  const prefillIndianStandard = () => {
    const available = new Set(components.map((component) => component.code));
    const gross = Number(sampleGross) || 0;
    const items = [];
    const add = (code, calculationMethod, value) => {
      if (!available.has(code)) return false;
      items.push({ componentCode: code, calculationMethod, value, order: items.length });
      return true;
    };

    const skipped = [];
    if (!add('BASIC', 'FIXED_AMOUNT', Math.round(gross * 0.5))) skipped.push('Basic Salary');
    else {
      if (!add('HRA', 'PERCENTAGE_OF_BASIC', 40)) skipped.push('House Rent Allowance');
      if (!add('SPECIAL_ALLOWANCE', 'REMAINING', null)) skipped.push('Special Allowance');
    }
    if (!add('PF', 'PERCENTAGE_OF_BASIC', 12)) skipped.push('Provident Fund');
    if (!add('EMPLOYER_PF', 'PERCENTAGE_OF_BASIC', 12)) skipped.push('Employer PF');

    if (!items.length) {
      notify.warning('This company has none of the standard components yet.');
      return;
    }

    setEditingId(null);
    setForm({
      ...emptyForm,
      name: 'Standard Indian CTC',
      code: 'STD-CTC',
      description:
        'Basic 50% of gross, HRA 40% of Basic, special allowance as the balance, PF at 12% on both sides.',
      items,
    });
    setAddCode('');
    setFormOpen(true);
    notify.info(
      skipped.length
        ? `Pre-filled ${items.length} component(s). Not in your component library: ${skipped.join(', ')}.`
        : `Pre-filled ${items.length} component(s) — review before saving.`,
    );
  };

  const updateItem = (index, patch) =>
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((item, position) =>
        position === index
          ? {
              ...item,
              ...patch,
              // Remaining Amount has no value of its own.
              value: patch.calculationMethod === 'REMAINING' ? null : (patch.value ?? item.value),
            }
          : item,
      ),
    }));

  const removeItem = (index) =>
    setForm((prev) => ({
      ...prev,
      items: prev.items
        .filter((_, position) => position !== index)
        .map((item, position) => ({ ...item, order: position })),
    }));

  const moveItem = (index, direction) =>
    setForm((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.items.length) return prev;
      const items = [...prev.items];
      [items[index], items[target]] = [items[target], items[index]];
      return { ...prev, items: items.map((item, position) => ({ ...item, order: position })) };
    });

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        name: form.name,
        code: form.code,
        description: form.description,
        designation: form.designation,
        effectiveFrom: form.effectiveFrom,
        sampleGross: Number(sampleGross) || 0,
        items: form.items.map((item, index) => ({
          componentCode: item.componentCode,
          calculationMethod: item.calculationMethod,
          value: item.value === '' || item.value === null ? null : Number(item.value),
          order: index,
        })),
      };

      const data = editingId
        ? await salaryStructureService.update(editingId, payload)
        : await salaryStructureService.create(payload);

      flash('success', data?.message || 'Salary structure saved successfully.');
      setFormOpen(false);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not save this salary structure');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (structure, status) => {
    setBusy(true);
    try {
      const data = await salaryStructureService.setStatus(structure._id, status);
      flash('success', data?.message || 'Salary structure updated successfully.');
      setConfirm(null);
      if (detail?._id === structure._id) setDetail(null);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not change the structure status');
    } finally {
      setBusy(false);
    }
  };

  const clone = async (structure) => {
    setBusy(true);
    try {
      const data = await salaryStructureService.clone(structure._id, {
        name: `${structure.name} Copy`,
        code: `${structure.code}_COPY`,
      });
      flash('success', data?.message || 'Salary structure cloned successfully.');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not clone this structure');
    } finally {
      setBusy(false);
    }
  };

  if (noAccess || accessDenied) {
    return (
      <div className="st-surface min-h-screen space-y-4">
        <StageBand eyebrow="Salary architecture" title="Salary structures" />
        <Panel title="Payroll access required">
          <div className="p-4 text-sm text-st-on-variant">
            You don&apos;t have permission to manage salary structures. Contact your Company Admin
            or Payroll Administrator.
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <StageBand
        eyebrow="Payroll · Salary structures"
        title="Salary structures"
        description="Reusable templates that assemble this company's active components into a complete salary. A structure is not an employee's salary — employees are assigned to one, and the engine prices it."
        pills={[
          { label: `${formatNumber(activeStructures)} active`, tone: 'good' },
          { label: `${formatNumber(structures.length)} template(s)`, tone: 'default' },
          ...(assignment ? [] : [{ label: 'assignment not visible', tone: 'warn' }]),
        ]}
        aside={
          <label className="flex items-center gap-2 text-[11px] font-semibold text-st-on-variant">
            <span className="uppercase tracking-wide">Sample gross</span>
            <input
              type="number"
              min="0"
              step="5000"
              value={sampleGross}
              onChange={(event) => setSampleGross(event.target.value)}
              className="w-24 rounded-lg border border-st-outline-variant/70 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on tabular-nums"
            />
          </label>
        }
        actions={
          canManage ? (
            <>
              <StageButton variant="primary" icon={Plus} onClick={openCreate} disabled={busy}>
                Create structure
              </StageButton>
              <StageButton
                icon={Sparkles}
                onClick={prefillIndianStandard}
                disabled={busy || !components.length}
                title={
                  components.length
                    ? 'Pre-fill the builder with the standard Indian CTC split, using only components this company has'
                    : 'No active components to build from yet'
                }
              >
                Add Indian standard CTC
              </StageButton>
            </>
          ) : null
        }
      />

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Layers}
          label="Active structures"
          value={formatNumber(activeStructures)}
          tone={activeStructures ? 'good' : 'default'}
          hint={`${formatNumber(structures.length)} template(s) on file`}
        />
        <StatCard
          icon={Users}
          label="Assigned employees"
          value={assignment ? `${formatNumber(assignedCount)} / ${formatNumber(assignment.activeEmployees)}` : '—'}
          hint={
            assignment
              ? `${coveragePercent}% of active employees carry a structure`
              : 'needs EMPLOYEE_SALARY_READ to read assignments'
          }
        />
        <StatCard
          icon={UserX}
          label="Unassigned"
          value={assignment ? formatNumber(assignment.unassigned) : '—'}
          tone={assignment?.unassigned ? 'warn' : 'default'}
          hint={assignment ? 'Active employees with no payroll profile' : 'not visible with your permissions'}
        />
        <StatCard
          icon={Boxes}
          label="Components available"
          value={formatNumber(components.length)}
          hint="Active components a structure may use"
        />
      </div>

      <Panel
        title="Structure templates"
        subtitle={
          sampleGross > 0
            ? `Amounts are the server's preview at a ${formatMoney(sampleGross)} sample gross — nothing is stored`
            : 'Set a sample gross to see the amounts the server would pay'
        }
        right={
          <span className="text-[10px] text-st-on-variant">
            showing {formatNumber(pageRows.length)} of {formatNumber(filtered.length)}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 border-t border-st-high px-3 py-2">
          <input
            className="min-w-[10rem] flex-1 rounded-lg border border-st-outline-variant/60 bg-st-lowest px-2.5 py-1.5 text-[11px] text-st-on placeholder:text-st-on-variant/70"
            placeholder="Search name, code or description"
            value={filters.search}
            onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value, page: 1 }))}
          />
          <select
            className="rounded-lg border border-st-outline-variant/60 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on"
            value={filters.status}
            onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value, page: 1 }))}
          >
            {STATUSES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Link
            to="/app/payroll/components"
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1.5 text-[11px] font-semibold text-st-on hover:bg-st-low"
          >
            <Boxes aria-hidden="true" size={12} /> Manage components
          </Link>
        </div>

        {loading ? (
          <p className="flex items-center gap-2 px-4 py-8 text-[11px] text-st-on-variant">
            <Loader2 aria-hidden="true" className="animate-spin" size={14} /> Loading structures…
          </p>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState
              illustration="payslip"
              title={structures.length ? 'No structure matches this filter' : 'No salary structures yet'}
              description={
                structures.length
                  ? 'Clear the search or pick a different status to see the templates on file.'
                  : "A structure assembles this company's salary components — say Basic + HRA + Special Allowance − PF. Create the components first, then build the structure here."
              }
              action={
                canManage && !structures.length ? (
                  <button type="button" className="btn-primary" onClick={openCreate}>
                    Create salary structure
                  </button>
                ) : null
              }
            />
          </div>
        ) : (
          <div className="grid gap-2.5 border-t border-st-high p-3 lg:grid-cols-2 2xl:grid-cols-3">
            {pageRows.map((structure) => {
              const preview = previews[structure._id];
              return (
                <article
                  key={structure._id}
                  className="flex flex-col gap-2.5 rounded-xl border border-st-high bg-st-low/30 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={structure.status === 'ACTIVE' ? 'good' : structure.status === 'DRAFT' ? 'warn' : 'default'}>
                        {structure.status || 'draft'}
                      </Pill>
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-st-container px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-st-on"
                        title={
                          assignment
                            ? 'Employees whose current pay profile carries this structure'
                            : 'Assignment counts need EMPLOYEE_SALARY_READ'
                        }
                      >
                        <Users aria-hidden="true" size={9} />
                        {assignment ? `${formatNumber(assignedFor(structure))} assigned` : 'assignment hidden'}
                      </span>
                      {structure.designation ? (
                        <span className="text-[10px] text-st-on-variant">{structure.designation}</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="rounded-md px-1.5 py-0.5 text-[10px] text-st-on-variant hover:bg-st-low"
                      title="Open the full component breakup"
                      onClick={() => openDetail(structure)}
                    >
                      Details
                    </button>
                  </div>

                  <div>
                    <h3 className="text-[13px] font-bold leading-tight text-st-on">{structure.name}</h3>
                    <p className="mt-0.5 text-[10px] text-st-on-variant">
                      <span className="font-mono">{structure.code}</span> · v{structure.version || 1} ·{' '}
                      {formatNumber(structure.componentCount)} component(s) · effective{' '}
                      {formatDate(structure.effectiveFrom)}
                    </p>
                  </div>

                  {preview ? (
                    <>
                      <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-st-lowest p-2">
                        <div>
                          <p className="text-[9px] font-bold uppercase tracking-wide text-st-on-variant">
                            Take-home
                          </p>
                          <p className="text-[15px] font-bold leading-none tabular-nums text-st-on">
                            {preview.totals?.gross
                              ? `${Math.round((Number(preview.totals.netPay) / Number(preview.totals.gross)) * 100)}%`
                              : '—'}
                          </p>
                          <p className="mt-0.5 text-[9px] text-st-on-variant">
                            {formatMoney(preview.totals?.netPay)} net
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] font-bold uppercase tracking-wide text-st-on-variant">
                            Employer cost
                          </p>
                          <p className="text-[15px] font-bold leading-none tabular-nums text-st-on">
                            {formatMoney(preview.totals?.employerCost)}
                          </p>
                          <p className="mt-0.5 text-[9px] text-st-on-variant">
                            CTC {formatMoney(preview.totals?.ctc)}
                          </p>
                        </div>
                      </div>

                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <p className="text-[9px] font-bold uppercase tracking-wide text-st-on-variant">
                            Distribution of gross
                          </p>
                          <span className="text-[9px] text-st-on-variant">server preview</span>
                        </div>
                        <div className="flex h-1.5 overflow-hidden rounded-full bg-st-container">
                          {distribution(preview).map((band) => (
                            <span
                              key={band.code}
                              title={`${band.name}: ${formatMoney(band.amount)} (${band.percent}%)`}
                              style={{ width: `${band.percent}%` }}
                              className={band.className}
                            />
                          ))}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
                          {distribution(preview).map((band) => (
                            <span key={band.code} className="text-[9px] text-st-on-variant">
                              <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${band.className}`} />
                              {band.name} {band.percent}%
                            </span>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="rounded-lg bg-st-lowest px-2 py-2 text-[10px] leading-snug text-st-on-variant">
                      No preview yet for this structure at {formatMoney(sampleGross)} — the server
                      returns amounts only for components that are still active.
                    </p>
                  )}

                  <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-st-high pt-2">
                    {canManage ? (
                      <>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low"
                          onClick={() => openEdit(structure)}
                        >
                          <Pencil aria-hidden="true" size={10} /> Edit
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low"
                          onClick={() => clone(structure)}
                        >
                          <Copy aria-hidden="true" size={10} /> Duplicate
                        </button>
                      </>
                    ) : null}
                    {canActivate && structure.status !== 'ARCHIVED' ? (
                      <button
                        type="button"
                        className="rounded-lg px-2 py-1 text-[10px] font-semibold text-st-primary hover:bg-st-low"
                        onClick={() =>
                          structure.status === 'ACTIVE'
                            ? setConfirm({ structure, status: 'INACTIVE' })
                            : changeStatus(structure, 'ACTIVE')
                        }
                      >
                        {structure.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                      </button>
                    ) : null}
                    <Link
                      to="/app/payroll/employees"
                      className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline"
                    >
                      View staff ({formatNumber(assignedFor(structure))})
                      <ArrowRight aria-hidden="true" size={10} />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {filtered.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-st-high px-3 py-2 text-[10px] text-st-on-variant">
            <span>
              Page {meta.page} of {meta.pages} · {formatNumber(filtered.length)} structure(s)
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-md px-2 py-1 font-semibold text-st-on hover:bg-st-low disabled:opacity-40"
                disabled={meta.page <= 1}
                onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}
              >
                <ChevronLeft aria-hidden="true" size={12} />
              </button>
              <span className="rounded-md bg-st-primary-container px-2 py-1 font-bold text-st-on-primary-container">
                {meta.page}
              </span>
              <button
                type="button"
                className="rounded-md px-2 py-1 font-semibold text-st-on hover:bg-st-low disabled:opacity-40"
                disabled={meta.page >= meta.pages}
                onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}
              >
                <ChevronRight aria-hidden="true" size={12} />
              </button>
            </div>
          </div>
        ) : null}
      </Panel>

      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-st-lowest px-4 py-3 shadow-sm">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-st-primary-fixed text-st-on-primary-fixed">
          <Boxes aria-hidden="true" size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold text-st-on">Need a component this structure can&apos;t use?</p>
          <p className="text-[10px] leading-snug text-st-on-variant">
            Only active components can be added to a structure. Manage the catalogue — earnings,
            deductions, employer contributions and their calculation rules — in Salary architecture.
          </p>
        </div>
        <Link
          to="/app/payroll/components"
          className="rounded-lg border border-st-outline-variant/70 px-3 py-1.5 text-[11px] font-semibold text-st-on hover:bg-st-low"
        >
          Manage salary components
        </Link>
      </div>

      {/* §6 / §9 — builder with live preview */}
      {formOpen && (
        <Modal
          title={editingId ? 'Edit Salary Structure' : 'Create Salary Structure'}
          onClose={() => setFormOpen(false)}
          wide
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Structure Details</h3>

              <label className="label block">
                Structure Name
                <input
                  className="input mt-1 w-full"
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Standard Monthly Structure"
                />
              </label>

              <label className="label block">
                Structure Code
                <input
                  className="input mt-1 w-full"
                  value={form.code}
                  onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
                  placeholder="STD-2026"
                />
              </label>

              <label className="label block">
                Description
                <textarea
                  className="input mt-1 w-full"
                  rows={2}
                  value={form.description}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, description: event.target.value }))
                  }
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="label block">
                  Designation (optional)
                  <input
                    className="input mt-1 w-full"
                    value={form.designation}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, designation: event.target.value }))
                    }
                    placeholder="Software Engineer"
                  />
                </label>
                <label className="label block">
                  Effective From
                  <input
                    type="date"
                    className="input mt-1 w-full"
                    value={form.effectiveFrom}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, effectiveFrom: event.target.value }))
                    }
                  />
                </label>
              </div>

              {/* §11 — up / down ordering, no drag-and-drop dependency */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Components</h3>
                  <span className="text-xs text-crewly-dim">{form.items.length} selected</span>
                </div>

                <div className="flex gap-2">
                  <select
                    className="input flex-1"
                    value={addCode}
                    onChange={(event) => setAddCode(event.target.value)}
                  >
                    <option value="">Add a component…</option>
                    {CATEGORIES.map((category) => {
                      const rows = availableComponents.filter(
                        (component) => component.category === category.value,
                      );
                      if (!rows.length) return null;
                      return (
                        <optgroup key={category.value} label={category.label}>
                          {rows.map((component) => (
                            <option key={component.code} value={component.code}>
                              {component.name} ({component.code})
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={addComponent}
                    disabled={!addCode}
                  >
                    Add
                  </button>
                </div>

                {form.items.length === 0 ? (
                  <EmptyState
                    illustration="tasks"
                    title="No components added yet"
                    description="Pick at least one earning component above — deductions are added the same way."
                    size="sm"
                  />
                ) : (
                  <div className="space-y-2">
                    {form.items.map((item, index) => {
                      const component = componentByCode[item.componentCode] || {};
                      const method = methodOf(item.calculationMethod);
                      return (
                        <div
                          key={`${item.componentCode}-${index}`}
                          className="rounded border border-crewly-border p-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium">
                                {component.name || item.componentCode}
                              </div>
                              <div className="text-[11px] uppercase tracking-wide text-crewly-dim">
                                {component.category || '—'}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                className="btn-ghost px-1"
                                title="Move up"
                                onClick={() => moveItem(index, -1)}
                                disabled={index === 0}
                              >
                                <ArrowUp size={12} />
                              </button>
                              <button
                                type="button"
                                className="btn-ghost px-1"
                                title="Move down"
                                onClick={() => moveItem(index, 1)}
                                disabled={index === form.items.length - 1}
                              >
                                <ArrowDown size={12} />
                              </button>
                              <button
                                type="button"
                                className="btn-ghost px-1 text-red-300"
                                title="Remove"
                                onClick={() => removeItem(index)}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>

                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <select
                              className="input"
                              value={item.calculationMethod}
                              onChange={(event) =>
                                updateItem(index, { calculationMethod: event.target.value })
                              }
                            >
                              {METHODS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <input
                              className="input"
                              type="number"
                              min="0"
                              step="0.01"
                              disabled={!method.needsValue}
                              placeholder={method.needsValue ? method.unit : 'Calculated'}
                              value={method.needsValue ? item.value ?? '' : ''}
                              onChange={(event) => updateItem(index, { value: event.target.value })}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* §9 — live preview, never stored */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Live Preview</h3>

              <label className="label block">
                Sample Gross Salary (Rs)
                <input
                  className="input mt-1 w-full"
                  type="number"
                  min="0"
                  value={sampleGross}
                  onChange={(event) => setSampleGross(event.target.value)}
                />
              </label>

              {!preview ? (
                <p className="text-xs text-crewly-dim">
                  Add at least one component to see how this structure splits the salary.
                </p>
              ) : (
                <div className="space-y-3">
                  {CATEGORIES.map((category) => {
                    const rows =
                      category.value === 'EARNING'
                        ? preview.earnings
                        : category.value === 'DEDUCTION'
                          ? preview.deductions
                          : preview.employerContributions;
                    if (!rows || rows.length === 0) return null;
                    return (
                      <div key={category.value}>
                        <div className="text-xs uppercase tracking-wide text-crewly-dim">
                          {category.label}
                        </div>
                        <table className="w-full text-left text-xs">
                          <tbody>{previewRows(rows)}</tbody>
                        </table>
                      </div>
                    );
                  })}

                  <div className="rounded border border-crewly-border p-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Gross Salary</span>
                      <span>{formatMoney(preview.totals.gross)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Total Deductions</span>
                      <span>{formatMoney(preview.totals.totalDeductions)}</span>
                    </div>
                    <div className="flex justify-between font-semibold">
                      <span>Net Pay</span>
                      <span>{formatMoney(preview.totals.netPay)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Employer Cost</span>
                      <span>{formatMoney(preview.totals.employerCost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">CTC</span>
                      <span>{formatMoney(preview.totals.ctc)}</span>
                    </div>
                  </div>

                  <p className="text-[11px] text-crewly-dim">
                    This preview only visualises the sample gross you typed. Nothing is saved and no
                    employee salary is calculated here.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={busy || form.items.length === 0}
            >
              {editingId ? 'Save Changes' : 'Create Structure'}
            </button>
          </div>
        </Modal>
      )}

      {/* §13 / §17 / §16 — detail with usage and version history */}
      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)} wide>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 text-sm">
              <h3 className="text-sm font-semibold">Details</h3>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Code</span>
                <span className="font-mono text-xs">{detail.code}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Status</span>
                <span>{statusBadge(detail.status)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Version</span>
                <span>v{detail.version || 1}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Effective From</span>
                <span>{formatDate(detail.effectiveFrom)}</span>
              </div>
              {detail.designation ? (
                <div className="flex justify-between">
                  <span className="text-crewly-dim">Designation</span>
                  <span>{detail.designation}</span>
                </div>
              ) : null}
              {detail.description ? (
                <p className="pt-2 text-sm text-crewly-dim">{detail.description}</p>
              ) : null}
            </div>

            <div className="space-y-2 text-sm">
              <h3 className="text-sm font-semibold">Usage</h3>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Employees using</span>
                <span>
                  {assignment
                    ? formatNumber(assignedFor(detail))
                    : formatNumber(detail.usage?.employees || 0)}
                </span>
              </div>
              {!assignment ? (
                <p className="text-[11px] text-crewly-dim">
                  Assignment is read from the employee pay profiles, which need EMPLOYEE_SALARY_READ.
                </p>
              ) : null}
              <p className="text-xs text-crewly-dim">
                Payroll history: {detail.usage?.hasProcessedPayroll ? 'present' : 'none'}.
              </p>
              <h3 className="pt-2 text-sm font-semibold">Versions</h3>
              <ul className="space-y-1 text-xs">
                {(detail.history || []).map((version) => (
                  <li key={version._id} className="flex justify-between">
                    <span>
                      v{version.version} · {version.status}
                      {version.isCurrent ? ' · current' : ''}
                    </span>
                    <span className="text-crewly-dim">{formatDate(version.effectiveFrom)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-semibold">Components</h3>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-xs uppercase tracking-wide text-crewly-dim">
                  <th className="py-1.5 pr-3">Component</th>
                  <th className="py-1.5 pr-3">Method</th>
                  <th className="py-1.5">Value</th>
                </tr>
              </thead>
              <tbody>
                {(detail.items || []).map((item, index) => (
                  <tr key={`${item.componentCode}-${index}`} className="border-b border-crewly-border/60">
                    <td className="py-1.5 pr-3">
                      {(detail.components || []).find((row) => row.code === item.componentCode)?.name ||
                        item.componentCode}
                    </td>
                    <td className="py-1.5 pr-3">{methodOf(item.calculationMethod).label}</td>
                    <td className="py-1.5">
                      {item.calculationMethod === 'REMAINING'
                        ? 'Calculated'
                        : `${item.value}${methodOf(item.calculationMethod).unit === '%' ? '%' : ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {confirm && (
        <Modal title="Change structure status" onClose={() => setConfirm(null)}>
          <p className="text-sm text-crewly-dim">
            Set <span className="text-crewly-text">{confirm.structure.name}</span> to{' '}
            {confirm.status.toLowerCase()}? Existing assignments keep using the structure until you
            replace them.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => changeStatus(confirm.structure, confirm.status)}
              disabled={busy}
            >
              Confirm
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default SalaryStructuresPage;
