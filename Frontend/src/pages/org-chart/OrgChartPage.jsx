// ============================================================
// ORGANIZATION STRUCTURE — who reports to whom, three ways.
//
// Data: GET /api/users/hierarchy → { data: [rootNodes] }
// Each node: { _id, name, email, role, designation, department,
//              employeeCode, avatarUrl, reportingTo, children: [...] }
// Backend already scopes: admin/HR → whole company · others → own dept
//
// The page has three readings of the same tree, because the same data answers
// three different questions:
//   Chart Canvas    — "who sits under whom" (the reporting shape)
//   Hierarchy List  — "show me everyone, in order" (scanning, searching)
//   Department Grid — "who is in Payroll" (per-team roster)
// All three read the one payload the API already returns: nothing here is
// invented, and the counters are counted, never typed.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  LayoutGrid,
  ListTree,
  Lock,
  Network,
  Plus,
  Search,
  Users,
  X,
} from 'lucide-react';
import api from '../../services/api';
import useAuth from '../../hooks/useAuth';
import usePermission from '../../hooks/usePermission';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const FULL_ORG_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];

// One tone per role: the avatar tile, the role chip and the stat dot all read
// from here, so a MANAGER looks the same everywhere on the page.
const ROLE_BADGE = {
  COMPANY_ADMIN: 'bg-crewly-green/15 text-crewly-green',
  HR_MANAGER: 'bg-crewly-accent/20 text-crewly-text',
  MANAGER: 'bg-crewly-selected text-crewly-selected-text',
  TEAM_LEAD: 'bg-crewly-orange/15 text-crewly-orange',
  EMPLOYEE: 'bg-crewly-inset-strong text-crewly-dim',
};

const ROLE_LABEL = {
  COMPANY_ADMIN: 'Company Admin',
  HR_MANAGER: 'HR Manager',
  MANAGER: 'Manager',
  TEAM_LEAD: 'Team Lead',
  EMPLOYEE: 'Employee',
};

const TABS = [
  { id: 'canvas', label: 'Chart Canvas', short: 'Chart', icon: Network },
  { id: 'list', label: 'Hierarchy List', short: 'List', icon: ListTree },
  { id: 'departments', label: 'Department Grid', short: 'Departments', icon: LayoutGrid },
];

const errMsg = (err, fallback) =>
  err?.response?.data?.message || err?.data?.message || err?.message || fallback;

/* ── tree helpers ───────────────────────────────────────────────────────── */

// Depth-first, with the depth kept: the list and grid views both need it.
const flattenTree = (nodes, depth = 0) =>
  (nodes || []).flatMap((node) => [
    { ...node, depth },
    ...flattenTree(node.children, depth + 1),
  ]);

const departmentsIn = (nodes) =>
  [...new Set(flattenTree(nodes).map((node) => node.department).filter(Boolean))].sort();

const searchable = (node) =>
  [node.name, node.employeeCode, node.designation, node.department, ROLE_LABEL[node.role] || node.role]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

/**
 * Keep the people who match, plus the ancestors needed to see where they sit.
 * A department filter keeps the same shape: the tree stays a tree, it just
 * carries fewer people.
 */
const filterTree = (nodes, { query, department }) => {
  const q = query.trim().toLowerCase();

  return (nodes || []).flatMap((node) => {
    const children = filterTree(node.children, { query, department });
    const self =
      (!q || searchable(node).includes(q)) && (!department || node.department === department);

    return self || children.length ? [{ ...node, children }] : [];
  });
};

const initials = (name) =>
  (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

/* ── pieces ─────────────────────────────────────────────────────────────── */

const AvatarTile = ({ node, large = false }) => {
  const shape = large ? 'h-12 w-12 rounded-xl text-lg' : 'h-10 w-10 rounded-lg text-sm';

  if (node.avatarUrl) {
    return (
      <img
        src={node.avatarUrl}
        alt=""
        className={`${shape} shrink-0 object-cover ring-1 ring-crewly-border`}
      />
    );
  }

  return (
    <div
      className={`${shape} flex shrink-0 items-center justify-center font-bold ${
        ROLE_BADGE[node.role] || ROLE_BADGE.EMPLOYEE
      }`}
    >
      {initials(node.name)}
    </div>
  );
};

const RoleChip = ({ role }) => (
  <span className={`badge shrink-0 ${ROLE_BADGE[role] || ROLE_BADGE.EMPLOYEE}`}>
    {ROLE_LABEL[role] || role?.replaceAll('_', ' ') || 'Employee'}
  </span>
);

const CodeChip = ({ code }) =>
  code ? (
    <span className="shrink-0 rounded-md bg-crewly-inset px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-crewly-dim">
      {code}
    </span>
  ) : null;

// Designation and department are two separate fields, and they are often the
// same words ("Human Resource · Human Resource"). The line reads as a position
// and its team, so a department already named in the designation is not
// repeated — the API is left alone, this is only how it is shown.
const placementLine = (node) => {
  const designation = (node.designation || '').trim();
  const department = (node.department || '').trim();

  if (!designation) return department;
  if (!department) return designation;
  if (designation.toLowerCase().includes(department.toLowerCase())) return designation;
  return `${designation} · ${department}`;
};

const Placement = ({ node }) => {
  const line = placementLine(node);

  return (
    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-crewly-dim">
      <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{line || 'Designation not set'}</span>
    </p>
  );
};

const StatPill = ({ tone, value, label }) => (
  <span className="inline-flex items-center gap-2 rounded-full border border-crewly-border bg-crewly-card px-3 py-1.5 text-xs">
    <span className={`h-1.5 w-1.5 rounded-full ${tone}`} aria-hidden="true" />
    <span className="font-bold text-crewly-text">{value}</span>
    <span className="text-crewly-dim">{label}</span>
  </span>
);

/* ── view 1: the tree ───────────────────────────────────────────────────── */

const PersonNode = ({ node, root = false, openMap, toggle }) => {
  const kids = node.children || [];
  const open = openMap[node._id] !== false; // default: expanded

  return (
    <div>
      <div
        className={`flex items-center gap-3 rounded-2xl border bg-crewly-card px-3 py-3 transition sm:gap-4 sm:px-4 ${
          root
            ? 'border-crewly-green/40 shadow-sm'
            : 'border-crewly-border hover:border-crewly-green/40'
        }`}
      >
        <AvatarTile node={node} large={root} />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`truncate font-semibold leading-tight text-crewly-text ${
                root ? 'text-base' : 'text-sm'
              }`}
            >
              {node.name}
            </span>
            <RoleChip role={node.role} />
            <CodeChip code={node.employeeCode} />
          </div>
          <Placement node={node} />
        </div>

        {kids.length > 0 && (
          <button
            type="button"
            onClick={() => toggle(node._id)}
            aria-expanded={open}
            className={
              root
                ? 'inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-crewly-green/30 bg-crewly-green/10 px-3 py-2 text-xs font-semibold text-crewly-green transition hover:bg-crewly-green/15'
                : 'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-crewly-border bg-crewly-card px-2.5 py-1.5 text-xs text-crewly-dim transition hover:border-crewly-green/40 hover:text-crewly-text'
            }
            title={open ? 'Collapse reports' : 'Expand reports'}
          >
            {root ? (
              <>
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">
                  {kids.length} Direct Lead{kids.length > 1 ? 's' : ''} / Report{kids.length > 1 ? 's' : ''}
                </span>
                <span className="sm:hidden">
                  {kids.length} report{kids.length > 1 ? 's' : ''}
                </span>
              </>
            ) : (
              <>
                <span className="hidden sm:inline">
                  {kids.length} direct report{kids.length > 1 ? 's' : ''}
                </span>
                <span className="sm:hidden">{kids.length}</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </>
            )}
          </button>
        )}
      </div>

      {open && kids.length > 0 && (
        <div className="relative ml-4 border-l border-crewly-border pl-4 sm:ml-6 sm:pl-5">
          <div className="space-y-2 pt-2">
            {kids.map((kid) => (
              <div key={kid._id} className="relative">
                {/* the elbow that ties this card back to the spine */}
                <span
                  aria-hidden="true"
                  className="absolute -left-4 top-6 h-px w-4 bg-crewly-border sm:-left-5 sm:w-5"
                />
                <PersonNode node={kid} openMap={openMap} toggle={toggle} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ── view 2: everyone, in order ─────────────────────────────────────────── */

const HierarchyList = ({ nodes }) => {
  const rows = useMemo(() => flattenTree(nodes), [nodes]);

  return (
    <div className="overflow-hidden rounded-2xl border border-crewly-border bg-crewly-card">
      <ul>
        {rows.map((node, index) => (
          <li
            key={node._id}
            className={`flex items-center gap-3 px-3 py-2.5 sm:px-4 ${
              index === 0 ? '' : 'border-t border-crewly-hairline'
            }`}
          >
            <div
              className="flex min-w-0 flex-1 items-center gap-3"
              style={{ paddingLeft: Math.min(node.depth, 6) * 18 }}
            >
              {node.depth > 0 && (
                <span className="shrink-0 text-crewly-dim/50" aria-hidden="true">
                  └
                </span>
              )}
              <AvatarTile node={node} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-semibold text-crewly-text">{node.name}</span>
                  <RoleChip role={node.role} />
                  <CodeChip code={node.employeeCode} />
                </div>
                <Placement node={node} />
              </div>
            </div>

            <span className="hidden shrink-0 text-xs text-crewly-dim sm:block">
              {(node.children || []).length} report{(node.children || []).length === 1 ? '' : 's'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/* ── view 3: per department ─────────────────────────────────────────────── */

const DepartmentGrid = ({ nodes }) => {
  const groups = useMemo(() => {
    const map = new Map();

    flattenTree(nodes).forEach((node) => {
      const key = node.department || 'No department';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(node);
    });

    return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [nodes]);

  if (!groups.length) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {groups.map(([name, members]) => (
        <section key={name} className="rounded-2xl border border-crewly-border bg-crewly-card p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-crewly-text">{name}</h3>
              <p className="mt-0.5 text-xs text-crewly-dim">
                {members.length} {members.length === 1 ? 'person' : 'people'}
              </p>
            </div>
            <span className="badge shrink-0 bg-crewly-inset text-crewly-dim">{members.length}</span>
          </div>

          <ul className="mt-3 space-y-2">
            {members.slice(0, 5).map((member) => (
              <li key={member._id} className="flex min-w-0 items-center gap-2">
                <AvatarTile node={member} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-crewly-text">{member.name}</p>
                  <p className="truncate text-[11px] text-crewly-dim">
                    {ROLE_LABEL[member.role] || member.role}
                    {member.designation ? ` · ${member.designation}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          {members.length > 5 && (
            <p className="mt-3 text-[11px] font-medium text-crewly-dim">
              + {members.length - 5} more in this department
            </p>
          )}
        </section>
      ))}
    </div>
  );
};

/* ── page ───────────────────────────────────────────────────────────────── */

const OrgChartPage = () => {
  const { user } = useAuth();
  const { hasAnyPermission } = usePermission();
  const navigate = useNavigate();

  const [roots, setRoots] = useState([]);
  const [openMap, setOpenMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('canvas');
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/users/hierarchy');
      setRoots(Array.isArray(res) ? res : res?.data || []);
    } catch (err) {
      notify.error(errMsg(err, 'Failed to load org chart'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const everyone = useMemo(() => flattenTree(roots), [roots]);
  const departments = useMemo(() => departmentsIn(roots), [roots]);
  const fullAccess = FULL_ORG_ROLES.includes(user?.role);
  const canAddMember = hasAnyPermission(['USER_CREATE']);

  // Counted, never typed: the numbers under the title describe the payload.
  const stats = useMemo(() => {
    const me = everyone.find((node) => String(node._id) === String(user?._id));
    const top = me || roots[0];

    return {
      people: everyone.length,
      departments: departments.length,
      direct: (top?.children || []).length,
    };
  }, [everyone, departments, roots, user]);

  const visible = useMemo(
    () => filterTree(roots, { query, department }),
    [roots, query, department],
  );
  const visibleCount = useMemo(() => flattenTree(visible).length, [visible]);
  const filtering = Boolean(query.trim() || department);

  const allOpen = everyone.every((node) => openMap[node._id] !== false);
  const toggle = (id) => setOpenMap((map) => ({ ...map, [id]: map[id] === false }));
  const toggleAll = () =>
    setOpenMap(allOpen ? Object.fromEntries(everyone.map((node) => [node._id, false])) : {});

  const clearFilters = () => {
    setQuery('');
    setDepartment('');
  };

  return (
    <div>
      {/* ── title block ───────────────────────────────────────────────── */}
      <div className="mb-4">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-crewly-dim">
          <Network className="h-3.5 w-3.5 text-crewly-green" aria-hidden="true" />
          Hierarchy &amp; Roles
        </p>

        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-extrabold text-crewly-text">Organization Structure</h1>
            <p className="mt-1 flex items-center gap-1 text-sm text-crewly-dim">
              {fullAccess ? (
                'Whole company view — reporting lines and team members across every department.'
              ) : (
                <>
                  Scoped view — your department only.
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                </>
              )}
            </p>
          </div>

          {!loading && everyone.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <StatPill tone="bg-crewly-green" value={stats.people} label="Total Members" />
              <StatPill tone="bg-crewly-orange" value={stats.departments} label="Departments" />
              <StatPill tone="bg-crewly-accent" value={stats.direct} label="Direct Reports" />
            </div>
          )}
        </div>
      </div>

      {/* ── toolbar ───────────────────────────────────────────────────── */}
      {!loading && everyone.length > 0 && (
        <div className="card mb-4 p-2 sm:p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-xl bg-crewly-inset p-1">
              {TABS.map(({ id, label, short, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  aria-pressed={tab === id}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition sm:px-3 ${
                    tab === id
                      ? 'bg-crewly-selected font-semibold text-crewly-selected-text shadow-sm'
                      : 'text-crewly-dim hover:text-crewly-text'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="sm:hidden">{short}</span>
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {departments.length > 1 && (
                <select
                  value={department}
                  onChange={(event) => setDepartment(event.target.value)}
                  className="input w-auto py-1.5 text-xs"
                  aria-label="Filter by department"
                >
                  <option value="">All departments ({departments.length})</option>
                  {departments.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}

              {tab === 'canvas' && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-crewly-border bg-crewly-card px-2.5 py-1.5 text-xs font-semibold text-crewly-dim transition hover:text-crewly-text"
                >
                  {allOpen ? (
                    <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {allOpen ? 'Collapse All' : 'Expand All'}
                </button>
              )}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim"
                aria-hidden="true"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by name, role, or EMP ID…"
                aria-label="Filter people"
                className="input w-full py-1.5 pl-8 text-xs"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-crewly-dim hover:text-crewly-text"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            {canAddMember && (
              <button
                type="button"
                onClick={() => navigate('/app/users')}
                className="btn-primary shrink-0 gap-1.5 px-3 py-1.5 text-xs"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add Member
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── body ──────────────────────────────────────────────────────── */}
      {loading && (
        <div className="space-y-2" aria-busy="true" aria-live="polite">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="h-[68px] animate-pulse rounded-2xl border border-crewly-border bg-crewly-inset"
            />
          ))}
          <span className="sr-only">Loading structure…</span>
        </div>
      )}

      {!loading && roots.length === 0 && (
        <div className="card">
          <EmptyState
            illustration="team"
            title="No reporting lines yet"
            description="The chart draws itself from each person's manager and department. Set those in User Management and the structure appears here."
          />
        </div>
      )}

      {!loading && roots.length > 0 && visibleCount === 0 && (
        <div className="card">
          <EmptyState
            illustration="search"
            title="Nobody matches that"
            description="Try a different name, role or employee code — or clear the filters to see the whole structure."
            action={
              <button type="button" onClick={clearFilters} className="btn-ghost px-4 py-2 text-sm">
                Clear filters
              </button>
            }
          />
        </div>
      )}

      {!loading && visibleCount > 0 && (
        <>
          {filtering && (
            <p className="mb-2 text-xs text-crewly-dim">
              Showing <span className="font-semibold text-crewly-text">{visibleCount}</span> of{' '}
              {everyone.length} people
            </p>
          )}

          {tab === 'canvas' && (
            <div className="space-y-3">
              {visible.map((root) => (
                <PersonNode key={root._id} node={root} root openMap={openMap} toggle={toggle} />
              ))}
            </div>
          )}

          {tab === 'list' && <HierarchyList nodes={visible} />}
          {tab === 'departments' && <DepartmentGrid nodes={visible} />}
        </>
      )}
    </div>
  );
};

export default OrgChartPage;
