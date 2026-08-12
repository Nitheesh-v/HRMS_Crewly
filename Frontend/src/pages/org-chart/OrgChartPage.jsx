// ============================================================
// 🌳 ORGANIZATION STRUCTURE — recursive tree (v2)
// Data: GET /api/users/hierarchy → data: [rootNodes]
// Each node: { _id, name, email, role, designation, department,
//              employeeCode, avatarUrl, children: [...] }
// Backend already scopes: admin/HR → whole company · others → own dept
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../services/api';
import useAuth from '../../hooks/useAuth';




const FULL_ORG_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];

const ROLE_BADGE = {
  COMPANY_ADMIN: 'bg-crewly-green/15 text-crewly-green',
  HR_MANAGER: 'bg-blue-500/15 text-blue-400',
  MANAGER: 'bg-purple-500/15 text-purple-400',
  TEAM_LEAD: 'bg-crewly-orange/15 text-crewly-orange',
  EMPLOYEE: 'bg-gray-500/15 text-gray-400',
};

const errMsg = (err, fb) =>
  err?.response?.data?.message || err?.data?.message || err?.message || fb;

// recursive people counter (roots + every level of children)
const countNodes = (node) =>
  1 + (node.children || []).reduce((sum, c) => sum + countNodes(c), 0);

// ── one person card + its (collapsible) subtree ─────────────────────────────
const PersonNode = ({ node, depth, openMap, toggle }) => {
  const kids = node.children || [];
  const open = openMap[node._id] !== false; // default: expanded

  return (
    <div className={depth > 0 ? 'ml-7 border-l-2 border-crewly-border pl-4' : ''}>
      <div className="card mb-2 flex items-center gap-3 py-3">
        {/* avatar */}
        {node.avatarUrl ? (
          <img src={node.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover ring-2 ring-crewly-border" />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 font-bold text-crewly-green">
            {node.name?.[0]?.toUpperCase() || '?'}
          </div>
        )}

        {/* info */}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">
            {node.name}
            <span className={`badge ml-2 ${ROLE_BADGE[node.role] || ROLE_BADGE.EMPLOYEE}`}>
              {node.role?.replace('_', ' ')}
            </span>
          </p>
          <p className="truncate text-xs text-crewly-dim">
            {node.designation || '—'}
            {node.department ? ` · 🏬 ${node.department}` : ''}
            {node.employeeCode ? ` · ${node.employeeCode}` : ''}
          </p>
        </div>

        {/* expand/collapse */}
        {kids.length > 0 && (
          <button
            onClick={() => toggle(node._id)}
            className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
            title={open ? 'Collapse' : 'Expand'}
          >
            {open ? '▾' : '▸'} {kids.length} report{kids.length > 1 ? 's' : ''}
          </button>
        )}
      </div>

      {open && kids.map((kid) => (
        <PersonNode key={kid._id} node={kid} depth={depth + 1} openMap={openMap} toggle={toggle} />
      ))}
    </div>
  );
};

// ── page ────────────────────────────────────────────────────────────────────
const OrgChartPage = () => {
  const { user } = useAuth();
  const [roots, setRoots] = useState([]);
  const [openMap, setOpenMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/users/hierarchy');
      const list = Array.isArray(res) ? res : res?.data || [];
      setRoots(list);
    } catch (err) {
      setError(errMsg(err, 'Failed to load org chart'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalPeople = useMemo(
    () => roots.reduce((sum, r) => sum + countNodes(r), 0),
    [roots]
  );

  const toggle = (id) => setOpenMap((m) => ({ ...m, [id]: m[id] === false }));
  const fullAccess = FULL_ORG_ROLES.includes(user?.role);

  return (
    <div>
      {/* header */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">🌳 Organization Structure</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            {fullAccess
              ? 'Whole company view — every department.'
              : 'Scoped view — your department only. 🔒'}
          </p>
        </div>
        <span className="badge bg-crewly-green/15 text-crewly-green">{totalPeople} people</span>
      </div>

      {error && (
        <div className="mb-5 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
        </div>
      )}

      {loading && <p className="text-crewly-dim">Loading structure…</p>}

      {!loading && !error && roots.length === 0 && (
        <div className="card text-center text-crewly-dim">
          No people to show yet — assign departments & managers in User Management.
        </div>
      )}

      {roots.map((root) => (
        <PersonNode key={root._id} node={root} depth={0} openMap={openMap} toggle={toggle} />
      ))}
    </div>
  );
};

export default OrgChartPage;