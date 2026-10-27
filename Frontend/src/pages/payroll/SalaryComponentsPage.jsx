/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Landmark,
  Layers,
  Lock,
  Pencil,
  Percent,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wallet,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import salaryComponentService from '../../services/salaryComponentService.js';
import salaryStructureService from '../../services/salaryStructureService.js';
import payrollSetupService from '../../services/payrollSetupService.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

// ═══════════════════════════════════════════════════════════════════════════
// SALARY STRUCTURES & STATUTORY CONFIGURATION — the Stitch "Configuration &
// Salary Architecture" export, rebuilt on live responses.
//
//   · the component catalogue ....... /payroll/components (paginated, filtered)
//   · setup completeness ............ /payroll/setup → evaluation.sections
//   · legal / statutory / bank ...... /payroll/setup → config.*
//   · the CTC builder ............... /payroll/salary-structures/preview
//
// The preview is the API's own calculation: the page posts the selected
// structure's items plus a sample gross and renders what comes back, so the
// numbers on the rail can never drift from the ones a run would use.
//
// What the mock claims and this build does not have: a statutory revision
// stamp, registry-verification badges (MCA / NSDL / EPFO), a live bank
// balance, and a wages-code compliance verdict. Those blocks keep their place
// and say what they are instead.
// ═══════════════════════════════════════════════════════════════════════════

const PILL = 'rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider';

const CATEGORIES = [
  { value: 'EARNING', label: 'Earning', heading: 'Earnings components' },
  { value: 'DEDUCTION', label: 'Deduction', heading: 'Deductions & statutory rules' },
  { value: 'EMPLOYER_CONTRIBUTION', label: 'Employer contribution', heading: 'Employer contributions' },
];

const CALCULATION_TYPES = [
  { value: 'FIXED_AMOUNT', label: 'Fixed Amount' },
  { value: 'PERCENTAGE', label: 'Percentage' },
  { value: 'FORMULA', label: 'Formula' },
];

const CALCULATION_BASES = [
  { value: 'BASIC', label: 'Basic Salary' },
  { value: 'GROSS', label: 'Gross Salary' },
  { value: 'CTC', label: 'CTC' },
  { value: 'COMPONENT', label: 'Another Component' },
];

const TAXABILITIES = [
  { value: 'TAXABLE', label: 'Taxable' },
  { value: 'NON_TAXABLE', label: 'Non-taxable' },
  { value: 'PARTIALLY_TAXABLE', label: 'Partially Taxable' },
  { value: 'DEFERRED', label: 'Configured Later' },
];

const emptyForm = {
  name: '',
  code: '',
  description: '',
  category: 'EARNING',
  calculationType: 'FIXED_AMOUNT',
  defaultAmount: '',
  percentage: '',
  calculationBase: '',
  dependsOnCode: '',
  taxability: 'TAXABLE',
  pfApplicable: false,
  esiApplicable: false,
  tdsApplicable: true,
  professionalTaxApplicable: false,
  status: 'ACTIVE',
  effectiveFrom: new Date().toISOString().slice(0, 10),
};

const toForm = (component) => ({
  ...emptyForm,
  ...(component || {}),
  defaultAmount: component?.defaultAmount ?? '',
  percentage: component?.percentage ?? '',
  effectiveFrom: component?.effectiveFrom
    ? new Date(component.effectiveFrom).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10),
});

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const num = (value) => Number(value || 0).toLocaleString('en-IN');

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const initials = (component) => {
  const code = String(component.code || '');
  if (code.length <= 2) return code.toUpperCase();
  return String(component.name || code)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
};

const calculationCopy = (component) => {
  const label = component.calculationLabel || '';
  if (component.calculationType === 'FIXED_AMOUNT') {
    return component.defaultAmount
      ? `Fixed ${money(component.defaultAmount)} / month`
      : 'Fixed amount — set per employee';
  }
  if (component.calculationType === 'PERCENTAGE') {
    const base = CALCULATION_BASES.find((option) => option.value === component.calculationBase)?.label;
    const of = base || (component.dependsOnCode ? component.dependsOnCode : 'gross');
    return `${component.percentage ? `${component.percentage}%` : '—'} of ${of}`;
  }
  return label || 'Formula — configured with the controlled rule builder';
};

const statutoryBasis = (component) => {
  const flags = [];
  if (component.pfApplicable) flags.push('PF');
  if (component.esiApplicable) flags.push('ESI');
  if (component.professionalTaxApplicable) flags.push('PT');
  if (component.tdsApplicable) flags.push('TDS');
  return flags;
};

const SalaryComponentsPage = () => {
  const { loading: permsLoading, hasPermission, hasAnyPermission } = usePermission();

  const [loading, setLoading] = useState(true);
  const [components, setComponents] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 25, pages: 1 });
  const [accessDenied, setAccessDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState({
    search: '',
    category: 'ALL',
    status: 'ALL',
    calculationType: 'ALL',
    taxability: 'ALL',
    page: 1,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [confirm, setConfirm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [defaults, setDefaults] = useState(null);

  // setup + structures feed the completion strip and the CTC builder
  const [setup, setSetup] = useState(null);
  const [setupGap, setSetupGap] = useState('');
  const [structures, setStructures] = useState([]);
  const [structureGap, setStructureGap] = useState('');
  const [structureId, setStructureId] = useState('');
  const [sampleGross, setSampleGross] = useState(100000);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');

  const canView = hasAnyPermission([
    'SALARY_COMPONENT_READ',
    'SALARY_COMPONENT_MANAGE',
    'SALARY_COMPONENT_ACTIVATE',
  ]);
  const canManage = hasPermission('SALARY_COMPONENT_MANAGE');
  const canActivate = hasPermission('SALARY_COMPONENT_ACTIVATE');
  const canStructureRead = hasPermission('SALARY_STRUCTURE_READ');
  const canSetupRead = hasPermission('PAYROLL_SETUP_READ');
  const noAccess = !permsLoading && !canView;

  const flash = useCallback((type, text) => {
    const body = typeof text === 'string' && text ? text : '';
    if (!body) return;
    const kind = String(type).toLowerCase();
    if (kind === 'error' || kind === 'danger' || kind === 'failed') notify.error(body);
    else if (kind === 'warning' || kind === 'warn') notify.warning(body);
    else if (kind === 'info') notify.info(body);
    else notify.success(body);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await salaryComponentService.list({
        search: filters.search || undefined,
        category: filters.category === 'ALL' ? undefined : filters.category,
        status: filters.status === 'ALL' ? undefined : filters.status,
        calculationType: filters.calculationType === 'ALL' ? undefined : filters.calculationType,
        taxability: filters.taxability === 'ALL' ? undefined : filters.taxability,
        page: filters.page,
      });
      setComponents(data?.data ?? data ?? []);
      setMeta(data?.meta || { total: 0, page: 1, limit: 25, pages: 1 });
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.code === 'PERMISSION_DENIED') setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load salary components');
    } finally {
      setLoading(false);
    }
  }, [filters, flash]);

  useEffect(() => {
    if (!permsLoading && canView) load();
    if (!permsLoading && !canView) setLoading(false);
  }, [permsLoading, canView, load]);

  useEffect(() => {
    if (permsLoading || !canSetupRead) return undefined;
    let active = true;
    payrollSetupService.get().then(
      (response) => {
        if (!active) return;
        setSetup(response?.data || response || null);
        setSetupGap('');
      },
      () => { if (active) setSetupGap('Payroll setup needs PAYROLL_SETUP_READ.'); },
    );
    return () => { active = false; };
  }, [permsLoading, canSetupRead]);

  useEffect(() => {
    if (permsLoading || !canStructureRead) return undefined;
    let active = true;
    salaryStructureService.list({ status: 'ACTIVE', limit: 20 }).then(
      (response) => {
        if (!active) return;
        const rows = response?.data ?? response ?? [];
        setStructures(Array.isArray(rows) ? rows : []);
        setStructureId((current) => current || rows?.[0]?._id || '');
        setStructureGap('');
      },
      () => { if (active) setStructureGap('Saved structures need SALARY_STRUCTURE_READ.'); },
    );
    return () => { active = false; };
  }, [permsLoading, canStructureRead]);

  const selectedStructure = useMemo(
    () => structures.find((row) => String(row._id) === String(structureId)) || null,
    [structures, structureId],
  );

  // The preview is the server's calculation, debounced while the gross moves.
  useEffect(() => {
    if (!selectedStructure) return undefined;
    const timer = setTimeout(() => {
      salaryStructureService
        .preview({
          items: (selectedStructure.items || []).map((item) => ({
            componentCode: item.componentCode,
            calculationMethod: item.calculationMethod,
            value: item.value === '' || item.value === null ? null : Number(item.value),
            order: item.order,
          })),
          gross: Number(sampleGross) || 0,
        })
        .then(
          (response) => {
            setPreview(response?.data ?? response ?? null);
            setPreviewError('');
          },
          (error) => {
            setPreview(null);
            setPreviewError(error?.message || 'The preview engine could not price this structure');
          },
        );
    }, 350);
    return () => clearTimeout(timer);
  }, [selectedStructure, sampleGross]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (component) => {
    setEditingId(component._id);
    setForm(toForm(component));
    setFormOpen(true);
  };

  const openDetail = async (component) => {
    try {
      const data = await salaryComponentService.get(component._id);
      setDetail(data?.data ?? data ?? component);
    } catch {
      setDetail(component);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        ...form,
        defaultAmount: form.defaultAmount === '' ? null : Number(form.defaultAmount),
        percentage: form.percentage === '' ? null : Number(form.percentage),
        calculationBase: form.calculationType === 'PERCENTAGE' ? form.calculationBase || null : null,
        dependsOnCode:
          form.calculationType === 'PERCENTAGE' && form.calculationBase === 'COMPONENT'
            ? form.dependsOnCode
            : '',
      };

      if (editingId) {
        const data = await salaryComponentService.update(editingId, payload);
        flash('success', data?.message || 'Salary component updated successfully.');
      } else {
        const data = await salaryComponentService.create(payload);
        flash('success', data?.message || 'Salary component created successfully.');
      }

      setFormOpen(false);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not save this salary component');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (component, status) => {
    setBusy(true);
    try {
      const data = await salaryComponentService.setStatus(component._id, status);
      flash('success', data?.message || 'Salary component updated successfully.');
      setConfirm(null);
      if (detail?._id === component._id) setDetail(null);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not change the component status');
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (component) => {
    setBusy(true);
    try {
      const data = await salaryComponentService.duplicate(component._id, {
        name: `${component.name} Copy`,
        code: `${component.code}_COPY`,
      });
      flash('success', data?.message || 'Salary component duplicated successfully.');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not duplicate this component');
    } finally {
      setBusy(false);
    }
  };

  const createDefaults = async () => {
    setBusy(true);
    try {
      const data = await salaryComponentService.createDefaults();
      flash('success', data?.message || 'Default salary components created.');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not create default components');
    } finally {
      setBusy(false);
    }
  };

  const loadDefaults = async () => {
    try {
      const data = await salaryComponentService.defaults();
      setDefaults(data?.data ?? data ?? []);
    } catch {
      setDefaults([]);
    }
  };

  useEffect(() => {
    if (canManage) loadDefaults();
  }, [canManage]);

  const showAmount = form.calculationType === 'FIXED_AMOUNT';
  const showPercentage = form.calculationType === 'PERCENTAGE';
  const showBase = showPercentage;
  const showDependency = showPercentage && form.calculationBase === 'COMPONENT';

  const formPreview = useMemo(() => {
    if (showAmount) {
      return form.defaultAmount === ''
        ? 'Fixed amount (set per employee)'
        : `Fixed ${money(form.defaultAmount)}`;
    }
    if (showPercentage) {
      const pct = form.percentage === '' ? '—' : form.percentage;
      if (form.calculationBase === 'COMPONENT') {
        const dep = components.find((component) => component.code === form.dependsOnCode);
        return `${pct}% of ${dep?.name || form.dependsOnCode || 'another component'}`;
      }
      const base = CALCULATION_BASES.find((option) => option.value === form.calculationBase);
      return `${pct}% of ${base?.label || 'Gross Salary'}`;
    }
    return 'Formula — configured with the controlled rule builder';
  }, [form, showAmount, showPercentage, components]);

  // ── setup facts (all real, all from /payroll/setup) ─────────────────────
  const config = setup?.config || null;
  const evaluation = setup?.evaluation || null;
  const sections = evaluation?.sections || [];
  const completedCount = Number(evaluation?.completedCount || 0);
  const totalSections = Number(evaluation?.totalCount || 4);
  const completionPct = totalSections ? Math.round((completedCount / totalSections) * 100) : 0;
  const legal = config?.legal || null;
  const statutory = config?.statutory || null;
  const policy = config?.payrollPolicy || null;
  const bank = config?.bankAccount || null;
  const statutoryOn = ['pf', 'esi', 'professionalTax', 'labourWelfareFund', 'gratuity', 'tds']
    .filter((key) => statutory?.[key]?.applicable);
  const warnings = evaluation?.warnings || [];
  const setupStatus = config?.status || '';

  const grouped = useMemo(() => {
    const buckets = { EARNING: [], DEDUCTION: [], EMPLOYER_CONTRIBUTION: [] };
    (components || []).forEach((component) => {
      if (buckets[component.category]) buckets[component.category].push(component);
    });
    return buckets;
  }, [components]);

  const previewEarnings = preview?.earnings || [];
  const previewDeductions = preview?.deductions || [];
  const previewEmployer = preview?.employerContributions || [];
  const previewTotals = preview?.totals || null;
  const grossForBar = Number(previewTotals?.gross || 0);
  const takeHomePct = grossForBar ? Math.round((Number(previewTotals?.netPay || 0) / grossForBar) * 1000) / 10 : 0;

  if (noAccess || accessDenied) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Salary Components &amp; Structures</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            Salary architecture needs <span className="font-semibold text-st-on">SALARY_COMPONENT_READ</span>.
            Your role doesn&apos;t hold it — ask your Company Admin or Payroll Administrator.
          </p>
        </div>
      </div>
    );
  }

  const renderComponentCard = (component) => {
    const flags = statutoryBasis(component);
    return (
      <li key={component._id} className="rounded-xl bg-st-lowest p-3 shadow-sm">
        <div className="flex items-start gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-st-low text-[10px] font-bold text-st-secondary">
            {initials(component)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => openDetail(component)}
                className="text-[12px] font-bold text-st-on hover:underline"
              >
                {component.name}
              </button>
              <span className={`${PILL} bg-st-high text-st-on-variant`}>{component.code}</span>
              {component.isSystemDefault ? (
                <span className={`${PILL} bg-st-secondary-container text-st-on-secondary-container`}>bundled</span>
              ) : null}
              <span className={`${PILL} bg-st-low text-st-on-variant`}>
                {TAXABILITIES.find((option) => option.value === component.taxability)?.label || component.taxability}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-st-on-variant">
              {calculationCopy(component)}
              {flags.length ? ` · ${flags.join(' / ')} basis` : ''}
              {component.effectiveFrom ? ` · from ${formatDate(component.effectiveFrom)}` : ''}
            </p>
            {component.usage?.structures ? (
              <p className="mt-0.5 text-[9px] text-st-on-variant">
                Used in {component.usage.structures} structure{component.usage.structures === 1 ? '' : 's'}
                {component.usage.payrollRuns ? ` · ${component.usage.payrollRuns} run(s)` : ''}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className={`${PILL} ${component.status === 'ACTIVE' ? 'bg-st-secondary-container text-st-on-secondary-container' : 'bg-st-high text-st-on-variant'}`}>
              {component.status === 'ACTIVE' ? 'Active' : 'Inactive'}
            </span>
            <div className="flex items-center gap-1">
              {canManage ? (
                <button
                  type="button"
                  onClick={() => openEdit(component)}
                  className="rounded p-1 text-st-on-variant transition hover:bg-st-low hover:text-st-on"
                  aria-label={`Edit ${component.name}`}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              ) : null}
              {canActivate ? (
                <button
                  type="button"
                  onClick={() =>
                    component.status === 'ACTIVE'
                      ? setConfirm({ component, status: 'INACTIVE' })
                      : changeStatus(component, 'ACTIVE')
                  }
                  className="rounded p-1 text-st-on-variant transition hover:bg-st-low hover:text-st-on"
                  aria-label={component.status === 'ACTIVE' ? `Deactivate ${component.name}` : `Activate ${component.name}`}
                >
                  <Lock className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </li>
    );
  };

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
              Payroll · Configuration &amp; Salary Architecture
            </span>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">
              Salary Structures &amp; Statutory Configuration
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Build modular earning and deduction components, configure statutory applicability, and price a
              structure against a sample gross — before it ever touches a payroll run.
            </p>
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={createDefaults}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Add default Indian CTC bundle
              </button>
              <button
                type="button"
                onClick={openCreate}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Create component
              </button>
            </div>
          ) : null}
        </section>

        {/* ── tab bar + status chips ───────────────────────────────────── */}
        <section className="flex flex-col gap-2 xl:flex-row xl:items-center">
          <div className="flex rounded-lg bg-st-lowest p-1 shadow-sm">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-st-primary-container px-2.5 py-1.5 text-[11px] font-bold text-st-on-primary-container">
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" /> Salary components &amp; rules
              {meta.total ? (
                <span className="rounded-full bg-st-lowest px-1.5 text-[9px] tabular-nums text-st-on">{meta.total}</span>
              ) : null}
            </span>
            <Link
              to="/app/payroll/setup"
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-bold text-st-on-variant transition hover:text-st-on"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Company statutory &amp; bank setup
            </Link>
            <Link
              to="/app/payroll/structures"
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-bold text-st-on-variant transition hover:text-st-on"
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" /> Structures
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 xl:ml-auto">
            <span className={`${PILL} ${setupStatus === 'ACTIVE' ? 'bg-st-secondary-container text-st-on-secondary-container' : 'bg-st-primary-fixed text-st-on-primary-fixed-variant'}`}>
              Engine {setupStatus === 'ACTIVE' ? 'active' : setupStatus ? setupStatus.toLowerCase() : 'not configured'}
            </span>
            <span className={`${PILL} bg-st-high text-st-on-variant`}>
              {statutoryOn.length ? `${statutoryOn.length} statutory rule${statutoryOn.length === 1 ? '' : 's'} on` : 'No statutory rules on'}
            </span>
            <span
              title="No statutory revision stamp is published by this build — rates live in the engine, not in a versioned notice."
              className="rounded-full bg-st-low px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-st-on-variant"
            >
              No rule revision badge
            </span>
          </div>
        </section>

        {/* ── setup completion strip ───────────────────────────────────── */}
        <section className="rounded-xl bg-st-low p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-st-lowest">
              <Settings2 className="h-3.5 w-3.5 text-st-secondary" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-st-on">
                Payroll setup completion: {completedCount}/{totalSections} sections configured
              </h2>
              <p className="text-[10px] text-st-on-variant">
                {evaluation?.allComplete
                  ? 'Ready for automated payroll execution — every section is saved and valid.'
                  : `Saved sections only count once they validate. ${warnings.length} advisory warning${warnings.length === 1 ? '' : 's'} open.`}
              </p>
            </div>
            <div className="ml-auto flex min-w-[9rem] items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-st-high">
                <div className="h-full rounded-full bg-st-secondary" style={{ width: `${completionPct}%` }} />
              </div>
              <span className="text-[10px] font-bold tabular-nums text-st-on">{completionPct}%</span>
            </div>
          </div>

          {setupGap ? (
            <p className="mt-2 rounded-lg bg-st-lowest px-2.5 py-2 text-[10px] text-st-on-variant">{setupGap}</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                {
                  key: 'LEGAL',
                  label: 'Legal entity',
                  icon: Building2,
                  lines: legal
                    ? [
                        legal.legalName || 'Legal name not set',
                        `CIN ${legal.cin || '—'} · PAN ${legal.pan || '—'} · TAN ${legal.tan || '—'}`,
                        [legal.city, legal.state].filter(Boolean).join(', ') || 'Registered address incomplete',
                      ]
                    : ['Not saved'],
                  to: '/app/payroll/setup',
                },
                {
                  key: 'STATUTORY',
                  label: 'Statutory rules',
                  icon: ShieldCheck,
                  lines: [
                    statutoryOn.length
                      ? statutoryOn.map((key) => key.toUpperCase()).join(' · ')
                      : 'No statutory component enabled',
                    statutory?.professionalTax?.state
                      ? `PT state: ${statutory.professionalTax.state}`
                      : 'PT state: not chosen',
                    statutory?.pf?.establishmentNumber
                      ? `EPFO ${statutory.pf.establishmentNumber}`
                      : 'No EPFO establishment code',
                  ],
                  to: '/app/payroll/setup',
                },
                {
                  key: 'POLICY',
                  label: 'Calendar & policy',
                  icon: CalendarDays,
                  lines: [
                    policy?.cycleType === 'CUSTOM_RANGE'
                      ? `Cycle ${policy.cycleStartDay}–${policy.cycleEndDay}`
                      : `Cycle day ${policy?.cycleStartDay ?? '—'}–${policy?.cycleEndDay ?? '—'}`,
                    policy?.paymentDateType === 'LAST_WORKING_DAY'
                      ? 'Paid on the last working day'
                      : policy?.paymentDayOfMonth
                        ? `Paid on day ${policy.paymentDayOfMonth}${policy.paymentMonthOffset ? ' of next month' : ''}`
                        : 'Payment day not set',
                    `${policy?.frequency || 'MONTHLY'} · LOP ${String(policy?.lopPolicy?.basis || '—').toLowerCase()}`,
                  ],
                  to: '/app/payroll/setup',
                },
                {
                  key: 'BANK',
                  label: 'Disbursement',
                  icon: Landmark,
                  lines: [
                    bank?.bankName || 'No company bank account',
                    bank?.maskedAccountNumber || (bank?.accountNumberLast4 ? `•••• ${bank.accountNumberLast4}` : '—'),
                    bank?.ifsc ? `IFSC ${bank.ifsc}` : 'IFSC not set',
                  ],
                  to: '/app/payroll/setup',
                },
              ].map((card) => {
                const state = sections.find((section) => section.key === card.key);
                const complete = Boolean(state?.complete);
                const Icon = card.icon;
                return (
                  <div key={card.key} className="rounded-lg bg-st-lowest p-2.5">
                    <div className="flex items-center gap-1.5">
                      <Icon className="h-3 w-3 text-st-outline" aria-hidden="true" />
                      <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">{card.label}</span>
                      {complete ? (
                        <CheckCircle2 className="ml-auto h-3 w-3 text-st-secondary" aria-label="Section complete" />
                      ) : (
                        <AlertTriangle className="ml-auto h-3 w-3 text-st-primary" aria-label="Section incomplete" />
                      )}
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {card.lines.map((line, index) => (
                        <li
                          key={`${card.key}-${index}`}
                          className={`truncate text-[9px] leading-snug ${index === 0 ? 'font-bold text-st-on' : 'text-st-on-variant'}`}
                          title={line}
                        >
                          {line}
                        </li>
                      ))}
                    </ul>
                    <Link to={card.to} className="mt-1 inline-flex items-center gap-0.5 text-[9px] font-bold text-st-primary hover:underline">
                      {complete ? 'Manage' : 'Configure'} <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          {/* ── catalogue ─────────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-3">
            <section className="rounded-xl bg-st-lowest p-3 shadow-sm">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-st-outline" aria-hidden="true" />
                  <input
                    value={filters.search}
                    onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value, page: 1 }))}
                    maxLength={60}
                    placeholder="Search component name or code (BASIC, HRA, PF)…"
                    className="w-full rounded-lg bg-st-low py-2 pl-8 pr-2 text-[11px] text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                    aria-label="Search salary components"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    value={filters.category}
                    onChange={(event) => setFilters((prev) => ({ ...prev, category: event.target.value, page: 1 }))}
                    className="rounded-lg bg-st-low px-2 py-2 text-[10px] font-semibold text-st-on focus:outline-none"
                    aria-label="Filter by category"
                  >
                    <option value="ALL">Category: all</option>
                    {CATEGORIES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={filters.calculationType}
                    onChange={(event) => setFilters((prev) => ({ ...prev, calculationType: event.target.value, page: 1 }))}
                    className="rounded-lg bg-st-low px-2 py-2 text-[10px] font-semibold text-st-on focus:outline-none"
                    aria-label="Filter by calculation"
                  >
                    <option value="ALL">Formula: all</option>
                    {CALCULATION_TYPES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={filters.taxability}
                    onChange={(event) => setFilters((prev) => ({ ...prev, taxability: event.target.value, page: 1 }))}
                    className="rounded-lg bg-st-low px-2 py-2 text-[10px] font-semibold text-st-on focus:outline-none"
                    aria-label="Filter by tax treatment"
                  >
                    <option value="ALL">Tax: all</option>
                    {TAXABILITIES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={filters.status}
                    onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value, page: 1 }))}
                    className="rounded-lg bg-st-low px-2 py-2 text-[10px] font-semibold text-st-on focus:outline-none"
                    aria-label="Filter by status"
                  >
                    <option value="ALL">Status: all</option>
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                  </select>
                </div>
              </div>
            </section>

            {loading ? (
              <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">
                Reading the component catalogue…
              </div>
            ) : components.length === 0 ? (
              <div className="rounded-xl bg-st-lowest shadow-sm">
                <EmptyState
                  illustration="tasks"
                  title="No salary components yet"
                  description="Components are the building blocks — Basic, HRA, allowances, bonuses, deductions and employer contributions. Create them, then assemble a structure."
                  action={
                    canManage ? (
                      <button
                        type="button"
                        onClick={openCreate}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Create salary component
                      </button>
                    ) : null
                  }
                />
                {defaults?.length ? (
                  <div className="border-t border-st-high/60 px-4 py-3">
                    <p className="text-[10px] font-bold text-st-on">Suggested for your company</p>
                    <p className="text-[9px] text-st-on-variant">
                      Derived from your Payroll Setup statutory flags — adding them creates the real records.
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-1">
                      {defaults.map((item) => (
                        <li key={item.code} className={`${PILL} bg-st-low text-st-on-variant`}>
                          {item.name} ({item.code})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                {CATEGORIES.map((category, index) => {
                  const rows = grouped[category.value] || [];
                  if (!rows.length) return null;
                  const activeCount = rows.filter((row) => row.status === 'ACTIVE').length;
                  return (
                    <section key={category.value}>
                      <div className="flex flex-wrap items-center gap-2 px-1">
                        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-st-secondary" />
                        <h2 className="text-[11px] font-bold uppercase tracking-wider text-st-on">
                          Category {index + 1}: {category.heading}
                        </h2>
                        <span className={`${PILL} bg-st-secondary-container text-st-on-secondary-container`}>
                          {activeCount} active
                        </span>
                        <span className="text-[9px] text-st-on-variant">
                          {category.value === 'EARNING'
                            ? 'Included in CTC computation'
                            : category.value === 'DEDUCTION'
                              ? 'Automatic calculation rules'
                              : 'Never reduces net pay'}
                        </span>
                      </div>
                      <ul className="mt-1.5 space-y-1.5">{rows.map(renderComponentCard)}</ul>
                    </section>
                  );
                })}

                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-st-lowest px-4 py-2 text-[10px] text-st-on-variant shadow-sm">
                  <span>
                    Showing {components.length} of {meta.total} component{meta.total === 1 ? '' : 's'} · page{' '}
                    {meta.page} of {meta.pages}
                  </span>
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={meta.page <= 1}
                      onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}
                      className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                      aria-label="Previous page of components"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="px-1 text-st-on">
                      {meta.page} / {meta.pages}
                    </span>
                    <button
                      type="button"
                      disabled={meta.page >= meta.pages}
                      onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}
                      className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                      aria-label="Next page of components"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>

          {/* ── live CTC builder ──────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
              <div className="flex items-start gap-2">
                <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                  <Percent className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> Live CTC structure builder
                </h2>
                <span className={`${PILL} ml-auto bg-st-primary-fixed text-st-on-primary-fixed-variant`}>Preview engine</span>
              </div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-st-on-variant">
                Prices a saved structure against a sample gross using{' '}
                <span className="font-mono">/payroll/salary-structures/preview</span>. Nothing is stored, and the
                engine that runs payroll is the one that answers.
              </p>

              {structureGap ? (
                <p className="mt-2 rounded-lg bg-st-low px-2.5 py-2 text-[10px] text-st-on-variant">{structureGap}</p>
              ) : structures.length === 0 ? (
                <div className="mt-2 rounded-lg border border-dashed border-st-high px-3 py-4 text-center">
                  <Layers className="mx-auto h-5 w-5 text-st-outline" aria-hidden="true" />
                  <p className="mt-1 text-[11px] font-bold text-st-on">No saved structure to price</p>
                  <p className="text-[10px] text-st-on-variant">
                    The builder reads a structure&apos;s real items — assemble one first.
                  </p>
                  <Link
                    to="/app/payroll/structures"
                    className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-st-low px-2.5 py-1.5 text-[10px] font-bold text-st-on"
                  >
                    Open structures <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              ) : (
                <>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Structure</span>
                      <select
                        value={structureId}
                        onChange={(event) => setStructureId(event.target.value)}
                        className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none"
                      >
                        {structures.map((row) => (
                          <option key={row._id} value={row._id}>
                            {row.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-variant">
                        Sample monthly gross
                      </span>
                      <div className="mt-0.5 flex items-center gap-1 rounded-lg bg-st-low px-2 py-1.5">
                        <span className="text-[11px] font-bold text-st-on-variant">₹</span>
                        <input
                          type="number"
                          min="0"
                          step="1000"
                          value={sampleGross}
                          onChange={(event) => setSampleGross(event.target.value)}
                          className="w-full bg-transparent text-[11px] font-bold tabular-nums text-st-on focus:outline-none"
                          aria-label="Sample monthly gross"
                        />
                      </div>
                    </label>
                  </div>
                  <input
                    type="range"
                    min="10000"
                    max="500000"
                    step="5000"
                    value={Number(sampleGross) || 0}
                    onChange={(event) => setSampleGross(event.target.value)}
                    className="mt-2 w-full accent-[var(--color-st-primary)]"
                    aria-label="Sample gross slider"
                  />

                  {previewError ? (
                    <p className="mt-2 rounded-lg bg-st-error-container px-2.5 py-2 text-[10px] text-st-on-error-container">
                      {previewError}
                    </p>
                  ) : !previewTotals ? (
                    <p className="mt-2 text-[10px] text-st-on-variant">Pricing this structure…</p>
                  ) : (
                    <>
                      <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-st-high">
                        {previewEarnings.map((line, index) => {
                          const share = grossForBar ? (Number(line.amount || 0) / grossForBar) * 100 : 0;
                          const palette = ['bg-st-primary', 'bg-st-secondary', 'bg-st-tertiary', 'bg-st-outline'];
                          return (
                            <span
                              key={`${line.componentCode}-${index}`}
                              className={palette[index % palette.length]}
                              style={{ width: `${share}%` }}
                              title={`${line.name}: ${money(line.amount)}`}
                            />
                          );
                        })}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        {previewEarnings.map((line, index) => (
                          <span key={`${line.componentCode}-legend-${index}`} className="inline-flex items-center gap-1 text-[9px] text-st-on-variant">
                            <span className={`h-1.5 w-1.5 rounded-full ${['bg-st-primary', 'bg-st-secondary', 'bg-st-tertiary', 'bg-st-outline'][index % 4]}`} />
                            {line.name}
                          </span>
                        ))}
                      </div>

                      <div className="mt-2 rounded-lg bg-st-low p-2.5">
                        <div className="flex items-center justify-between text-[10px] font-bold text-st-on">
                          <span>Monthly gross earnings</span>
                          <span className="tabular-nums">{money(previewTotals.gross)}</span>
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {previewEarnings.map((line, index) => (
                            <li key={`${line.componentCode}-earn-${index}`} className="flex items-center justify-between gap-2 text-[9px]">
                              <span className="min-w-0 truncate text-st-on-variant">
                                {line.name}
                                {line.isRemaining ? ' (balancing)' : ''}
                              </span>
                              <span className="shrink-0 font-semibold tabular-nums text-st-on">{money(line.amount)}</span>
                            </li>
                          ))}
                          {previewEarnings.length === 0 ? (
                            <li className="text-[9px] text-st-on-variant">
                              This structure has no earning lines — the preview has nothing to price.
                            </li>
                          ) : null}
                        </ul>
                      </div>

                      <div className="mt-2 rounded-lg bg-st-error-container/50 p-2.5">
                        <div className="flex items-center justify-between text-[10px] font-bold text-st-on">
                          <span>Deductions in the preview</span>
                          <span className="tabular-nums">−{money(previewTotals.totalDeductions)}</span>
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {previewDeductions.map((line, index) => (
                            <li key={`${line.componentCode}-ded-${index}`} className="flex items-center justify-between gap-2 text-[9px]">
                              <span className="min-w-0 truncate text-st-on-variant">{line.name}</span>
                              <span className="shrink-0 font-semibold tabular-nums text-st-on">−{money(line.amount)}</span>
                            </li>
                          ))}
                          {previewDeductions.length === 0 ? (
                            <li className="text-[9px] text-st-on-variant">
                              No deduction component in this structure — statutory deductions are applied by the
                              payroll engine, not the preview.
                            </li>
                          ) : null}
                        </ul>
                        {previewEmployer.length ? (
                          <p className="mt-1 border-t border-st-high/60 pt-1 text-[9px] text-st-on-variant">
                            Employer contributions ({money(previewTotals.employerCost)}) are informational and
                            never reduce net pay.
                          </p>
                        ) : null}
                      </div>

                      <div className="mt-2 rounded-lg bg-st-secondary-container/60 p-2.5">
                        <div className="flex flex-wrap items-end justify-between gap-2">
                          <div>
                            <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-st-on-secondary-container">
                              Preview take-home
                            </p>
                            <p className="text-xl font-bold tabular-nums text-st-on">{money(previewTotals.netPay)}</p>
                          </div>
                          <p className="text-[10px] font-bold text-st-on-secondary-container">
                            {takeHomePct}% of sample gross
                          </p>
                        </div>
                        <p className="mt-0.5 text-[9px] text-st-on-secondary-container">
                          Gross {money(previewTotals.gross)} − deductions {money(previewTotals.totalDeductions)} ·
                          CTC {money(previewTotals.ctc)}
                        </p>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Link
                          to="/app/payroll/structures"
                          className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-2.5 py-1.5 text-[10px] font-bold text-st-on-primary"
                        >
                          <Layers className="h-3 w-3" aria-hidden="true" /> Open in structures
                        </Link>
                        <span className="text-[9px] text-st-on-variant">
                          Assigning a structure to employees happens in the structures workspace, where the
                          assignment is audited.
                        </span>
                      </div>
                    </>
                  )}
                </>
              )}
            </section>

            <section className="rounded-xl bg-st-low p-4 shadow-sm">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-secondary" aria-hidden="true" />
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-st-on">Configuration check</h2>
                  <p className="text-[10px] leading-relaxed text-st-on-variant">
                    What Payroll Setup reports about this configuration. It is a structural check — not a legal
                    opinion, and not a statutory revision notice.
                  </p>
                </div>
              </div>

              {setupGap ? (
                <p className="mt-1.5 rounded-lg bg-st-lowest px-2.5 py-2 text-[10px] text-st-on-variant">{setupGap}</p>
              ) : warnings.length ? (
                <ul className="mt-1.5 space-y-1">
                  {warnings.map((warning) => (
                    <li key={warning.code || warning.message} className="flex items-start gap-1.5 rounded-lg bg-st-lowest px-2 py-1.5">
                      <AlertTriangle className="mt-0.5 h-2.5 w-2.5 shrink-0 text-st-primary" aria-hidden="true" />
                      <span className="text-[9px] leading-snug text-st-on-variant">{warning.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-st-lowest px-2.5 py-2 text-[10px] font-semibold text-st-on">
                  <BadgeCheck className="h-3 w-3 text-st-secondary" aria-hidden="true" />
                  Setup reports no warnings{completedCount === totalSections ? ' and every section is complete' : ''}.
                </p>
              )}

              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <div className="rounded-lg bg-st-lowest px-2 py-1.5">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Components</p>
                  <p className="text-[12px] font-bold tabular-nums text-st-on">{num(meta.total)}</p>
                </div>
                <div className="rounded-lg bg-st-lowest px-2 py-1.5">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Saved structures</p>
                  <p className="text-[12px] font-bold tabular-nums text-st-on">{num(structures.length)}</p>
                </div>
              </div>
              <Link
                to="/app/payroll/setup"
                className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline"
              >
                Open statutory &amp; bank setup <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
              </Link>
            </section>
          </div>
        </div>

        <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[10px] leading-relaxed text-st-on-variant">
          <Wallet className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-outline" aria-hidden="true" />
          <span>
            <strong className="font-semibold text-st-on">Components describe; the engine decides.</strong> A
            component&apos;s taxability and PF/ESI flags are configuration. Real deductions are computed by the
            payroll engine from the statutory rules and appear on{' '}
            <Link to="/app/payroll/statutory" className="font-bold text-st-primary hover:underline">
              Statutory &amp; Compliance
            </Link>{' '}
            — this page never prices an employee&apos;s month.
          </span>
        </p>
      </div>

      {/* ── create / edit form ─────────────────────────────────────────── */}
      {formOpen ? (
        <Modal
          title={editingId ? 'Edit salary component' : 'Create salary component'}
          onClose={() => setFormOpen(false)}
          wide
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2.5">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-st-on">Basic information</h3>
              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Component name</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="House Rent Allowance"
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                />
              </label>
              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Component code</span>
                <input
                  value={form.code}
                  onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value.toUpperCase() }))}
                  placeholder="HRA"
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 font-mono text-[11px] uppercase text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                />
              </label>
              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Description</span>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                />
              </label>
              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Category</span>
                <select
                  value={form.category}
                  onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] font-semibold text-st-on focus:outline-none"
                >
                  {CATEGORIES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="space-y-2.5">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-st-on">Calculation</h3>
              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Method</span>
                <select
                  value={form.calculationType}
                  onChange={(event) => setForm((prev) => ({ ...prev, calculationType: event.target.value }))}
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] font-semibold text-st-on focus:outline-none"
                >
                  {CALCULATION_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {showAmount ? (
                <label className="block">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Default amount (₹)</span>
                  <input
                    type="number"
                    min="0"
                    value={form.defaultAmount}
                    onChange={(event) => setForm((prev) => ({ ...prev, defaultAmount: event.target.value }))}
                    placeholder="2000"
                    className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  />
                  <span className="mt-0.5 block text-[9px] text-st-on-variant">
                    Reference only — structures and employees can override it.
                  </span>
                </label>
              ) : null}

              {showPercentage ? (
                <label className="block">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Percentage</span>
                  <input
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={form.percentage}
                    onChange={(event) => setForm((prev) => ({ ...prev, percentage: event.target.value }))}
                    placeholder="40"
                    className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  />
                </label>
              ) : null}

              {showBase ? (
                <label className="block">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Calculated from</span>
                  <select
                    value={form.calculationBase}
                    onChange={(event) => setForm((prev) => ({ ...prev, calculationBase: event.target.value }))}
                    className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] font-semibold text-st-on focus:outline-none"
                  >
                    <option value="">Select a base</option>
                    {CALCULATION_BASES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {showDependency ? (
                <label className="block">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Depends on</span>
                  <select
                    value={form.dependsOnCode}
                    onChange={(event) => setForm((prev) => ({ ...prev, dependsOnCode: event.target.value }))}
                    className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] font-semibold text-st-on focus:outline-none"
                  >
                    <option value="">Select a component</option>
                    {components
                      .filter((component) => component.code !== form.code)
                      .map((component) => (
                        <option key={component._id} value={component.code}>
                          {component.name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}

              <h3 className="pt-1 text-[10px] font-bold uppercase tracking-wider text-st-on">Tax &amp; statutory</h3>
              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Tax treatment</span>
                <select
                  value={form.taxability}
                  onChange={(event) => setForm((prev) => ({ ...prev, taxability: event.target.value }))}
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] font-semibold text-st-on focus:outline-none"
                >
                  {TAXABILITIES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-1.5">
                {[
                  ['pfApplicable', 'PF applicable'],
                  ['esiApplicable', 'ESI applicable'],
                  ['tdsApplicable', 'TDS applicable'],
                  ['professionalTaxApplicable', 'Professional tax'],
                ].map(([field, label]) => (
                  <label key={field} className="flex items-center gap-1.5 text-[10px] text-st-on">
                    <input
                      type="checkbox"
                      checked={Boolean(form[field])}
                      onChange={(event) => setForm((prev) => ({ ...prev, [field]: event.target.checked }))}
                      className="h-3 w-3 accent-[var(--color-st-primary)]"
                    />
                    {label}
                  </label>
                ))}
              </div>

              <label className="block">
                <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Effective from</span>
                <input
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(event) => setForm((prev) => ({ ...prev, effectiveFrom: event.target.value }))}
                  className="mt-0.5 w-full rounded-lg bg-st-low px-2.5 py-2 text-[11px] text-st-on focus:outline-none"
                />
              </label>
            </div>
          </div>

          <div className="mt-3 rounded-lg bg-st-low p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Preview</p>
            <p className="mt-0.5 text-[11px] text-st-on">
              {form.name || 'Unnamed component'} ·{' '}
              {CATEGORIES.find((option) => option.value === form.category)?.label} · {formPreview}
            </p>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-bold text-st-on"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save component'}
            </button>
          </div>
        </Modal>
      ) : null}

      {/* ── deactivation is never a delete ─────────────────────────────── */}
      {confirm ? (
        <Modal title="Deactivate salary component?" onClose={() => setConfirm(null)}>
          <p className="text-[11px] text-st-on-variant">
            Deactivating <span className="font-bold text-st-on">{confirm.component.name}</span> means:
          </p>
          <ul className="mt-2 space-y-1 text-[11px] text-st-on-variant">
            <li>· It will not be offered to new salary structures.</li>
            <li>· Historical payroll and every stored snapshot stay unchanged.</li>
            <li>
              · It is currently used in {confirm.component.usage?.structures ?? 0} structure
              {(confirm.component.usage?.structures ?? 0) === 1 ? '' : 's'} — nothing is deleted.
            </li>
          </ul>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-bold text-st-on"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => changeStatus(confirm.component, confirm.status)}
              className="rounded-lg bg-st-error px-3 py-2 text-[11px] font-bold text-st-lowest"
            >
              Deactivate
            </button>
          </div>
        </Modal>
      ) : null}

      {/* ── component detail ───────────────────────────────────────────── */}
      {detail ? (
        <Modal title={detail.name} onClose={() => setDetail(null)}>
          <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
            {[
              ['Code', detail.code, true],
              ['Category', CATEGORIES.find((option) => option.value === detail.category)?.label || detail.category],
              ['Calculation', detail.calculationLabel || calculationCopy(detail)],
              ['Taxability', TAXABILITIES.find((option) => option.value === detail.taxability)?.label || detail.taxability],
              ['PF / ESI / TDS', `${detail.pfApplicable ? 'PF yes' : 'PF no'} · ${detail.esiApplicable ? 'ESI yes' : 'ESI no'} · ${detail.tdsApplicable ? 'TDS yes' : 'TDS no'}`],
              ['Status', detail.status === 'ACTIVE' ? 'Active' : 'Inactive'],
              ['Effective from', formatDate(detail.effectiveFrom)],
              ['Version', detail.version || 1],
            ].map(([label, value, mono]) => (
              <div key={label} className="rounded-lg bg-st-low px-2.5 py-1.5">
                <dt className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">{label}</dt>
                <dd className={`text-[11px] text-st-on ${mono ? 'font-mono' : ''}`}>{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-2 rounded-lg bg-st-low p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Usage</p>
            <p className="mt-0.5 text-[11px] text-st-on">
              {detail.usage?.structures ?? 0} salary structure(s) · {detail.usage?.payrollRuns ?? 0} payroll run(s)
              {detail.usage?.hasHistoricalVersions ? ' · historical versions kept' : ''}
            </p>
          </div>

          {detail.description ? (
            <p className="mt-2 text-[11px] leading-relaxed text-st-on-variant">{detail.description}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {canManage ? (
              <button
                type="button"
                onClick={() => { setDetail(null); duplicate(detail); }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-low px-3 py-2 text-[11px] font-bold text-st-on"
              >
                <Copy className="h-3 w-3" aria-hidden="true" /> Duplicate
              </button>
            ) : null}
            {canManage ? (
              <button
                type="button"
                onClick={() => { setDetail(null); openEdit(detail); }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" /> Edit component
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default SalaryComponentsPage;
