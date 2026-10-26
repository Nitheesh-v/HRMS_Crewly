// ============================================================
// Assets — the company's hardware register, and what is in your hands.
//
// Two audiences on one page, divided by permission:
//   everyone      → "In my hands": the equipment they are accountable for
//   HR / Admin    → the create-and-assign form, and the full pool
//
// Everything shown comes back from /assets, /assets/my and /users. The page
// counts what the API returned and says "—" where nothing was returned; it
// never estimates stock, condition or battery health, because the register
// does not record any of that.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import {
  Backpack, Boxes, CheckCircle2, Download, IdCard, Keyboard, Laptop, LayoutGrid,
  List, Monitor, Mouse, Package, Plus, Search, Send, Smartphone, Trash2, Undo2,
  UserPlus, Users, X,
} from 'lucide-react';
import { useSelector } from 'react-redux';
import { getMyAssets, getAllAssets, createAsset, assignAsset, returnAsset, deleteAsset } from '../../services/assetService.js';
import { getEmployees } from '../../services/docsService.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const CATS = {
  LAPTOP: 'Laptop', MONITOR: 'Monitor', KEYBOARD: 'Keyboard', MOUSE: 'Mouse',
  MOBILE: 'Mobile', ID_CARD: 'ID card', OTHER: 'Other',
};

const CAT_ICONS = {
  LAPTOP: Laptop, MONITOR: Monitor, KEYBOARD: Keyboard,
  MOUSE: Mouse, MOBILE: Smartphone, ID_CARD: IdCard, OTHER: Package,
};

const CatIcon = ({ cat, className = 'h-4 w-4' }) => {
  const Icon = CAT_ICONS[cat] || Package;
  return <Icon className={className} aria-hidden="true" />;
};

/* Tabs are groups of categories, not a filter of their own: "Peripherals" is
   the two categories the register keeps apart but the shelf keeps together. */
const GROUPS = [
  { id: 'ALL', label: 'All', match: () => true },
  { id: 'COMPUTER', label: 'Laptops', match: (c) => c === 'LAPTOP' },
  { id: 'DISPLAY', label: 'Displays', match: (c) => c === 'MONITOR' },
  { id: 'PERIPHERAL', label: 'Peripherals', match: (c) => c === 'KEYBOARD' || c === 'MOUSE' },
  { id: 'PHONE', label: 'Phones', match: (c) => c === 'MOBILE' },
  { id: 'ID_CARD', label: 'ID cards', match: (c) => c === 'ID_CARD' },
  { id: 'OTHER', label: 'Other', match: (c) => c === 'OTHER' },
];

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const holderSince = (asset) => {
  const open = [...(asset?.assignments || [])].reverse().find((a) => !a.returnedAt);
  return open?.assignedAt || asset?.updatedAt || null;
};

const Tile = ({ icon: Icon, label, value, sub, active, onClick }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      className={`flex items-start gap-3 p-4 text-left transition sm:p-5 ${
        active ? 'bg-crewly-selected' : `bg-crewly-card ${onClick ? 'hover:bg-crewly-inset' : ''}`
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${active ? 'text-crewly-selected-text' : 'text-crewly-dim'}`}>{label}</p>
        <p className="mt-1.5 text-xl font-bold leading-tight sm:text-2xl">{value}</p>
        {sub ? (
          <p className={`mt-1 text-xs leading-snug ${active ? 'text-crewly-selected-text/80' : 'text-crewly-dim'}`}>{sub}</p>
        ) : null}
      </div>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
    </Tag>
  );
};

const StatusChip = ({ status }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
      status === 'ASSIGNED'
        ? 'bg-amber-400/15 text-amber-300'
        : 'bg-crewly-green/15 text-crewly-green'
    }`}
  >
    {status === 'ASSIGNED' ? 'In use' : 'In stock'}
  </span>
);

const Modal = ({ title, onClose, children, width = 'max-w-lg' }) => (
  <div
    className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    onClick={onClose}
    role="presentation"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className={`w-full ${width} rounded-t-2xl border border-crewly-border bg-crewly-card p-5 shadow-xl sm:rounded-2xl`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-4 flex items-start gap-3">
        <h3 className="min-w-0 flex-1 text-base font-bold">{title}</h3>
        <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-1 text-crewly-dim hover:text-crewly-text" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      {children}
    </div>
  </div>
);

export default function AssetsPage() {
  const me = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);

  const [mine, setMine] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState({ name: '', category: 'LAPTOP', serialNumber: '', note: '', assignTo: '' });
  const [assignTarget, setAssignTarget] = useState(null);
  const [assignForm, setAssignForm] = useState({ userId: '', note: '' });
  const [poolPicker, setPoolPicker] = useState(false);
  const [poolForm, setPoolForm] = useState({ assetId: '', userId: '', note: '' });
  const [returnTarget, setReturnTarget] = useState(null);
  const [returnNote, setReturnNote] = useState('');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [view, setView] = useState('TABLE');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);

  const flash = (ok, text) => {
    if (!text) return;
    if (ok) notify.success(text);
    else notify.error(text);
  };

  const load = async () => {
    try {
      setMine(await getMyAssets());
      if (isHR) {
        setInventory(await getAllAssets());
        if (!employees.length) setEmployees(await getEmployees());
      }
    } catch {
      flash(false, 'Could not load assets');
    }
  };
  useEffect(() => { load(); }, []);

  const available = useMemo(() => inventory.filter((a) => a.status !== 'ASSIGNED'), [inventory]);
  const holders = useMemo(
    () => new Set(inventory.filter((a) => a.currentHolder?._id).map((a) => a.currentHolder._id)).size,
    [inventory],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const inGroup = GROUPS.find((g) => g.id === group)?.match || (() => true);
    return inventory.filter((a) => {
      if (!inGroup(a.category)) return false;
      if (statusFilter !== 'ALL' && a.status !== statusFilter) return false;
      if (!term) return true;
      return [a.name, a.serialNumber, a.currentHolder?.name, CATS[a.category]]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
  }, [inventory, group, statusFilter, search]);

  const PER_PAGE = 8;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  const resetForm = () => setForm({ name: '', category: 'LAPTOP', serialNumber: '', note: '', assignTo: '' });

  const doCreate = async () => {
    if (!form.name.trim()) return flash(false, 'Give the asset a name first');
    setBusy(true);
    try {
      const created = await createAsset({
        name: form.name.trim(),
        category: form.category,
        serialNumber: form.serialNumber.trim(),
        note: form.note.trim(),
      });
      const newId = created?.data?._id || created?._id;
      if (form.assignTo && newId) {
        await assignAsset(newId, { userId: form.assignTo, note: form.note.trim() });
        const who = employees.find((e) => e._id === form.assignTo)?.name || 'the employee';
        flash(true, `${form.name.trim()} added and assigned to ${who}`);
      } else {
        flash(true, `${form.name.trim()} added to the register`);
      }
      resetForm();
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not add the asset');
    } finally {
      setBusy(false);
    }
  };

  const doAssign = async () => {
    if (!assignForm.userId) return flash(false, 'Pick an employee');
    setBusy(true);
    try {
      await assignAsset(assignTarget._id, assignForm);
      setAssignTarget(null);
      setAssignForm({ userId: '', note: '' });
      flash(true, 'Assigned — the employee has been notified');
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not assign the asset');
    } finally {
      setBusy(false);
    }
  };

  /* The header action: pick something already in stock, pick a person, done.
     Same endpoint as the row action, so nothing new is trusted. */
  const doAssignFromPool = async () => {
    if (!poolForm.assetId) return flash(false, 'Pick an asset from the register');
    if (!poolForm.userId) return flash(false, 'Pick an employee');
    setBusy(true);
    try {
      await assignAsset(poolForm.assetId, { userId: poolForm.userId, note: poolForm.note.trim() });
      setPoolPicker(false);
      setPoolForm({ assetId: '', userId: '', note: '' });
      flash(true, 'Assigned — the employee has been notified');
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not assign the asset');
    } finally {
      setBusy(false);
    }
  };

  const doReturn = async () => {
    if (!returnTarget) return;
    setBusy(true);
    try {
      await returnAsset(returnTarget._id, returnNote.trim());
      setReturnTarget(null);
      setReturnNote('');
      flash(true, 'Back in stock — the register is updated');
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not process the return');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (asset) => {
    if (!window.confirm(`Delete "${asset.name}" from the register? Its assignment history goes with it.`)) return;
    try {
      await deleteAsset(asset._id);
      flash(true, 'Removed from the register');
      await load();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Could not delete the asset');
    }
  };

  const exportInventory = () => {
    const rows = [
      ['Item', 'Category', 'Serial', 'Status', 'Holder', 'Assigned on', 'Note'],
      ...inventory.map((a) => [
        a.name || '',
        CATS[a.category] || a.category || '',
        a.serialNumber || '',
        a.status === 'ASSIGNED' ? 'In use' : 'In stock',
        a.currentHolder?.name || '',
        a.status === 'ASSIGNED' ? String(holderSince(a) || '').slice(0, 10) : '',
        a.note || '',
      ]),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `assets-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const groupCount = (id) => inventory.filter((a) => (GROUPS.find((g) => g.id === id)?.match || (() => true))(a.category)).length;

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-crewly-inset text-crewly-green">
            <Boxes className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold sm:text-2xl">Assets &amp; Hardware</h1>
              {isHR ? (
                <span className="rounded-full bg-crewly-green/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-crewly-green">
                  {inventory.length} tracked
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
              {isHR
                ? 'Every device the company owns, who is holding it, and what is back on the shelf. Assigning an asset notifies the person it lands with.'
                : 'The equipment you are accountable for. HR records what leaves the store and who holds it — this is your half of that record.'}
            </p>
          </div>
        </div>
        {isHR ? (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <button type="button" onClick={exportInventory} disabled={!inventory.length} className="btn-ghost inline-flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm disabled:opacity-50 sm:flex-none">
              <Download className="h-4 w-4" />Export inventory
            </button>
            <button
              type="button"
              onClick={() => { setAssignTarget(null); setPoolPicker(true); setPoolForm({ assetId: '', userId: '', note: '' }); }}
              disabled={!available.length || !employees.length}
              className="btn-primary inline-flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm disabled:opacity-50 sm:flex-none"
              title={available.length ? 'Assign something already in stock' : 'Nothing is in stock to assign'}
            >
              <UserPlus className="h-4 w-4" />Assign asset
            </button>
          </div>
        ) : null}
      </div>

      {/* ── counts ─────────────────────────────────────────────────────── */}
      {isHR ? (
        <div className="card grid grid-cols-2 gap-px overflow-hidden border-crewly-border bg-crewly-border p-0 sm:grid-cols-2 xl:grid-cols-4">
          <Tile icon={Backpack} label="In my hands" value={mine.length} sub={mine.length ? 'Assigned to you' : 'Nothing assigned to you'} />
          <Tile icon={Boxes} label="Total pool" value={inventory.length} sub={inventory.length ? `Across ${new Set(inventory.map((a) => a.category)).size} categories` : 'The register is empty'} />
          <Tile
            icon={CheckCircle2}
            label="In stock"
            value={available.length}
            sub={available.length ? 'Ready to assign' : 'Nothing spare right now'}
            active={statusFilter === 'AVAILABLE'}
            onClick={() => { setStatusFilter(statusFilter === 'AVAILABLE' ? 'ALL' : 'AVAILABLE'); setPage(1); }}
          />
          <Tile
            icon={Users}
            label="In use"
            value={inventory.length - available.length}
            sub={holders ? `Held by ${holders} ${holders === 1 ? 'person' : 'people'}` : 'Nobody is holding anything'}
            active={statusFilter === 'ASSIGNED'}
            onClick={() => { setStatusFilter(statusFilter === 'ASSIGNED' ? 'ALL' : 'ASSIGNED'); setPage(1); }}
          />
        </div>
      ) : (
        <div className="card grid grid-cols-2 gap-px overflow-hidden border-crewly-border bg-crewly-border p-0">
          <Tile icon={Backpack} label="In my hands" value={mine.length} sub={mine.length ? 'Assigned to you' : 'Nothing assigned to you'} />
          <Tile icon={Boxes} label="Categories" value={new Set(mine.map((a) => a.category)).size} sub="Kinds of equipment with you" />
        </div>
      )}

      {/* ── in my hands ────────────────────────────────────────────────── */}
      <section className="card">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Backpack className="h-4 w-4 text-crewly-dim" />In my hands
            <span className="rounded-full bg-crewly-inset px-2 py-0.5 text-[11px] font-semibold text-crewly-dim">{mine.length}</span>
          </h2>
          <p className="text-[11px] text-crewly-dim">Returning something? HR closes it from the register.</p>
        </div>
        {mine.length === 0 ? (
          <EmptyState
            illustration="box"
            title="Nothing in your hands"
            description="When HR assigns you a laptop, phone or ID card, it appears here with its serial number and the date it became yours."
            size="sm"
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {mine.map((asset) => (
              <article key={asset._id} className="rounded-xl border border-crewly-border bg-crewly-inset/40 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crewly-card text-crewly-green">
                    <CatIcon cat={asset.category} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{asset.name}</p>
                    <p className="text-xs text-crewly-dim">{CATS[asset.category] || 'Equipment'}</p>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <dt className="uppercase tracking-wide text-crewly-dim">Serial</dt>
                    <dd className="mt-0.5 truncate font-semibold">{asset.serialNumber || '—'}</dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-wide text-crewly-dim">With you since</dt>
                    <dd className="mt-0.5 font-semibold">{fmtDate(holderSince(asset))}</dd>
                  </div>
                </dl>
                {asset.note ? <p className="mt-2 text-[11px] text-crewly-dim">“{asset.note}”</p> : null}
              </article>
            ))}
          </div>
        )}
      </section>

      {isHR ? (
        <>
          {/* ── add & assign ───────────────────────────────────────────── */}
          <section className="card">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold">
                <Plus className="h-4 w-4 text-crewly-green" />Add &amp; assign equipment
              </h2>
              <p className="text-[11px] text-crewly-dim">Log a device into the register, optionally straight to a person.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="label" htmlFor="asset-name">Asset name</label>
                <input
                  id="asset-name"
                  className="input"
                  placeholder="MacBook Pro 14”"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="asset-category">Category</label>
                <select
                  id="asset-category"
                  className="input"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                >
                  {Object.entries(CATS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="asset-serial">Serial number</label>
                <input
                  id="asset-serial"
                  className="input"
                  placeholder="C02XK0WJMD6M"
                  value={form.serialNumber}
                  onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="asset-holder">Assign to</label>
                <select
                  id="asset-holder"
                  className="input"
                  value={form.assignTo}
                  onChange={(e) => setForm({ ...form, assignTo: e.target.value })}
                >
                  <option value="">Keep in stock</option>
                  {employees.map((emp) => (
                    <option key={emp._id} value={emp._id}>
                      {emp.name}{emp.employeeCode ? ` · ${emp.employeeCode}` : ''}{emp.designation ? ` · ${emp.designation}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2 lg:col-span-2">
                <label className="label" htmlFor="asset-note">Note</label>
                <input
                  id="asset-note"
                  className="input"
                  placeholder="Charger and sleeve included"
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                />
              </div>
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={resetForm} className="btn-ghost px-3 py-2 text-sm">Clear form</button>
              <button type="button" onClick={doCreate} disabled={busy} className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50">
                <Plus className="h-4 w-4" />
                {busy ? 'Saving…' : form.assignTo ? 'Add & assign' : 'Add to register'}
              </button>
            </div>
          </section>

          {/* ── the pool ───────────────────────────────────────────────── */}
          <section className="card p-0">
            <div className="flex flex-wrap items-start justify-between gap-3 p-4 pb-0 sm:p-5 sm:pb-0">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-bold">
                  <Package className="h-4 w-4 text-crewly-dim" />Company inventory &amp; hardware pool
                  <span className="rounded-full bg-crewly-inset px-2 py-0.5 text-[11px] font-semibold text-crewly-dim">{inventory.length}</span>
                </h2>
                <p className="mt-1 text-[11px] text-crewly-dim">Who holds what, and what is spare. Returns land back here as stock.</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-5">
              <div className="relative min-w-[200px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" />
                <input
                  className="input pl-9"
                  placeholder="Search by item, serial, holder…"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  aria-label="Search the register"
                />
              </div>
              <select
                className="input w-auto"
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                aria-label="Filter by status"
              >
                <option value="ALL">Any status</option>
                <option value="AVAILABLE">In stock</option>
                <option value="ASSIGNED">In use</option>
              </select>
              {/* Table or cards — the same rows, read two ways. */}
              <div className="flex items-center rounded-lg border border-crewly-border p-0.5" role="group" aria-label="Register layout">
                {[
                  ['TABLE', 'Table', List],
                  ['CARDS', 'Cards', LayoutGrid],
                ].map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setView(id)}
                    aria-pressed={view === id}
                    aria-label={`${label} view`}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
                      view === id ? 'bg-crewly-selected text-crewly-selected-text' : 'text-crewly-dim hover:text-crewly-text'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="-mx-1 mt-2 flex items-center gap-1 overflow-x-auto px-4 pb-1 sm:px-5">
              {GROUPS.map((g) => {
                const count = groupCount(g.id);
                if (g.id !== 'ALL' && count === 0) return null;
                const active = group === g.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => { setGroup(g.id); setPage(1); }}
                    aria-pressed={active}
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${
                      active ? 'bg-crewly-selected text-crewly-selected-text' : 'text-crewly-dim hover:bg-crewly-inset'
                    }`}
                  >
                    {g.label} <span className="opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>

            {filtered.length === 0 ? (
              <div className="p-4 sm:p-5">
                <EmptyState
                  illustration="box"
                  title={inventory.length ? 'Nothing matches that' : 'No assets issued yet'}
                  description={
                    inventory.length
                      ? 'Try another category, clear the search, or switch the status filter back to any.'
                      : 'Laptops, phones, keys, ID cards — record what leaves the store and who holds it.'
                  }
                  size="sm"
                />
              </div>
            ) : (
              <>
                {view === 'CARDS' ? (
                  <ul className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                    {visible.map((asset) => (
                      <li key={asset._id} className="rounded-xl border border-crewly-border bg-crewly-inset/40 p-3">
                        <div className="flex items-start gap-2.5">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crewly-card text-crewly-dim">
                            <CatIcon cat={asset.category} className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 pr-14 text-sm font-semibold leading-tight">{asset.name}</p>
                            <p className="truncate text-[11px] text-crewly-dim">
                              {CATS[asset.category] || 'Other'} · {asset.serialNumber || 'no serial'}
                            </p>
                          </div>
                          <StatusChip status={asset.status} />
                        </div>
                        <p className="mt-2 truncate text-xs">
                          {asset.status === 'ASSIGNED'
                            ? `${asset.currentHolder?.name || 'Holder not recorded'} · since ${fmtDate(holderSince(asset))}`
                            : 'On the shelf'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {asset.status === 'ASSIGNED' ? (
                            <button
                              type="button"
                              onClick={() => { setReturnTarget(asset); setReturnNote(''); }}
                              className="btn-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
                            >
                              <Undo2 className="h-3.5 w-3.5" />Return
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => { setAssignTarget(asset); setAssignForm({ userId: '', note: '' }); }}
                                className="btn-primary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
                              >
                                <UserPlus className="h-3.5 w-3.5" />Assign
                              </button>
                              <button
                                type="button"
                                onClick={() => doDelete(asset)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-crewly-red/40 px-2 py-1.5 text-xs font-semibold text-crewly-red hover:bg-crewly-red/10"
                                title="Delete from the register"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <>
                {/* column headings — desktop only, the rows keep their labels below */}
                <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_auto] gap-3 border-b border-crewly-border px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim sm:grid sm:px-5">
                  <span>Hardware</span>
                  <span>Category</span>
                  <span>Serial / tag</span>
                  <span>Current assignee</span>
                  <span>Status</span>
                  <span className="text-right">Actions</span>
                </div>
                <ul className="divide-y divide-crewly-border">
                  {visible.map((asset) => (
                    <li
                      key={asset._id}
                      className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_auto] sm:items-center sm:gap-3 sm:px-5"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crewly-inset text-crewly-dim">
                          <CatIcon cat={asset.category} className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{asset.name}</p>
                          <p className="truncate text-[11px] text-crewly-dim">
                            {asset.note || 'No note on the register'}
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-crewly-dim sm:text-sm sm:text-crewly-text">{CATS[asset.category] || 'Other'}</p>
                      <p className="truncate font-mono text-[11px] text-crewly-dim sm:text-xs">
                        {asset.serialNumber || '—'}
                      </p>
                      <div className="min-w-0 text-xs sm:text-sm">
                        {asset.status === 'ASSIGNED' ? (
                          <>
                            <p className="truncate font-semibold">{asset.currentHolder?.name || 'Holder not recorded'}</p>
                            <p className="truncate text-[11px] text-crewly-dim">since {fmtDate(holderSince(asset))}</p>
                          </>
                        ) : (
                          <p className="text-crewly-dim">On the shelf</p>
                        )}
                      </div>
                      <div><StatusChip status={asset.status} /></div>
                      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        {asset.status === 'ASSIGNED' ? (
                          <button
                            type="button"
                            onClick={() => { setReturnTarget(asset); setReturnNote(''); }}
                            className="btn-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
                          >
                            <Undo2 className="h-3.5 w-3.5" />Return
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => { setAssignTarget(asset); setAssignForm({ userId: '', note: '' }); }}
                              className="btn-primary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
                            >
                              <UserPlus className="h-3.5 w-3.5" />Assign
                            </button>
                            <button
                              type="button"
                              onClick={() => doDelete(asset)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-crewly-red/40 px-2 py-1.5 text-xs font-semibold text-crewly-red hover:bg-crewly-red/10"
                              title="Delete from the register"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                  </>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-crewly-border px-4 py-3 text-xs text-crewly-dim sm:px-5">
                  <p>
                    Showing {visible.length} of {filtered.length}
                    {filtered.length !== inventory.length ? ` (${inventory.length} in the register)` : ''}
                  </p>
                  {pageCount > 1 ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="rounded-md px-2 py-1 hover:bg-crewly-inset disabled:opacity-40"
                      >Prev</button>
                      {Array.from({ length: pageCount }, (_, i) => i + 1).slice(0, 6).map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setPage(n)}
                          aria-current={n === currentPage ? 'page' : undefined}
                          className={`rounded-md px-2 py-1 ${n === currentPage ? 'bg-crewly-selected text-crewly-selected-text font-semibold' : 'hover:bg-crewly-inset'}`}
                        >
                          {n}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                        disabled={currentPage === pageCount}
                        className="rounded-md px-2 py-1 hover:bg-crewly-inset disabled:opacity-40"
                      >Next</button>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </section>
        </>
      ) : null}

      {/* ── assign from stock ──────────────────────────────────────────── */}
      {poolPicker ? (
        <Modal title="Assign an asset" onClose={() => setPoolPicker(false)}>
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="pool-asset">Asset in stock</label>
              <select
                id="pool-asset"
                className="input"
                value={poolForm.assetId}
                onChange={(e) => setPoolForm({ ...poolForm, assetId: e.target.value })}
              >
                <option value="">Pick from the shelf…</option>
                {available.map((asset) => (
                  <option key={asset._id} value={asset._id}>
                    {asset.name}{asset.serialNumber ? ` · ${asset.serialNumber}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="pool-user">Employee</label>
              <select
                id="pool-user"
                className="input"
                value={poolForm.userId}
                onChange={(e) => setPoolForm({ ...poolForm, userId: e.target.value })}
              >
                <option value="">Pick an employee…</option>
                {employees.map((emp) => (
                  <option key={emp._id} value={emp._id}>
                    {emp.name}{emp.employeeCode ? ` · ${emp.employeeCode}` : ''}{emp.designation ? ` · ${emp.designation}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="pool-note">Note (optional)</label>
              <input
                id="pool-note"
                className="input"
                placeholder="Charger included, handle with care…"
                value={poolForm.note}
                onChange={(e) => setPoolForm({ ...poolForm, note: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setPoolPicker(false)} className="btn-ghost px-3 py-2 text-sm">Cancel</button>
              <button
                type="button"
                onClick={doAssignFromPool}
                disabled={busy || !poolForm.assetId || !poolForm.userId}
                className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
              >
                <Send className="h-4 w-4" />{busy ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* ── assign modal ───────────────────────────────────────────────── */}
      {assignTarget ? (
        <Modal title={`Assign ${assignTarget.name}`} onClose={() => setAssignTarget(null)}>
          <div className="space-y-3">
            <p className="text-xs text-crewly-dim">
              {CATS[assignTarget.category] || 'Equipment'}
              {assignTarget.serialNumber ? ` · S/N ${assignTarget.serialNumber}` : ''} — the employee is notified the moment you assign it.
            </p>
            <div>
              <label className="label" htmlFor="assign-user">Employee</label>
              <select
                id="assign-user"
                className="input"
                value={assignForm.userId}
                onChange={(e) => setAssignForm({ ...assignForm, userId: e.target.value })}
              >
                <option value="">Pick an employee…</option>
                {employees.map((emp) => (
                  <option key={emp._id} value={emp._id}>
                    {emp.name}{emp.employeeCode ? ` · ${emp.employeeCode}` : ''}{emp.designation ? ` · ${emp.designation}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="assign-note">Note (optional)</label>
              <input
                id="assign-note"
                className="input"
                placeholder="Charger included, handle with care…"
                value={assignForm.note}
                onChange={(e) => setAssignForm({ ...assignForm, note: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setAssignTarget(null)} className="btn-ghost px-3 py-2 text-sm">Cancel</button>
              <button type="button" onClick={doAssign} disabled={busy || !assignForm.userId} className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50">
                <Send className="h-4 w-4" />{busy ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* ── return modal ───────────────────────────────────────────────── */}
      {returnTarget ? (
        <Modal title={`Return ${returnTarget.name}`} onClose={() => setReturnTarget(null)}>
          <div className="space-y-3">
            <p className="text-xs text-crewly-dim">
              Currently with <span className="font-semibold text-crewly-text">{returnTarget.currentHolder?.name || 'the holder'}</span>.
              Closing the assignment puts it back in stock and keeps the history on the asset.
            </p>
            <div>
              <label className="label" htmlFor="return-note">Condition note (optional)</label>
              <input
                id="return-note"
                className="input"
                placeholder="Screen scratch, charger missing…"
                value={returnNote}
                onChange={(e) => setReturnNote(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setReturnTarget(null)} className="btn-ghost px-3 py-2 text-sm">Cancel</button>
              <button type="button" onClick={doReturn} disabled={busy} className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50">
                <Undo2 className="h-4 w-4" />{busy ? 'Saving…' : 'Back to stock'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
