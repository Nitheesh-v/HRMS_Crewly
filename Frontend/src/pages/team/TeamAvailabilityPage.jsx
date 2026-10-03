// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.3 — TEAM AVAILABILITY PAGE
//
//  Read-only team view gated by SENIORS (COMPANY_ADMIN / HR_MANAGER /
//  MANAGER / TEAM_LEAD) on the frontend; the backend reuses
//  utils/scope.js so an EMPLOYEE who curls the API gets [self].
//
//  WHAT THIS PAGE SHOWS
//    - A search box (name / employeeCode / designation, max 60 chars).
//    - Filter chips: presence (available / busy / dnd / unknown) and
//      workLocation (office / wfh / remote).
//    - Summary tiles for byPresence and byWorkLocation.
//    - A paginated table.
//
//  WHAT THIS PAGE NEVER DOES
//    - Never writes a presence mutation.
//    - Never falls back to localStorage / sessionStorage.
//    - Never calls AI surfaces.
//    - Never exposes password / email / phone / salary / PAN / Aadhaar /
//      bank / address — only the server-authorised fields.
//    - Never modifies own presence outside the menu view.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link } from 'react-router-dom';
import {
  Briefcase,
  Building2,
  Coffee,
  MapPin,
  RefreshCw,
  Search as SearchIcon,
  UserPlus,
  Users,
} from 'lucide-react';

import PresenceIndicator from '../../components/presence/PresenceIndicator.jsx';
import { fetchTeamAvailability } from '../../redux/slices/presenceSlice.js';

const PRESENCE_FILTER_VALUES = ['available', 'busy', 'dnd', 'unknown'];
const LOCATION_FILTER_VALUES = ['office', 'wfh', 'remote'];
const MAX_SEARCH_LEN = 60;
const DEFAULT_LIMIT = 25;

const PRESENCE_CHIP_TONE = {
  available: 'bg-crewly-green/15 text-crewly-green border-crewly-green/40',
  busy: 'bg-crewly-orange/15 text-crewly-orange border-crewly-orange/40',
  dnd: 'bg-crewly-red/15 text-crewly-red border-crewly-red/40',
  unknown: 'bg-white/10 text-crewly-dim border-crewly-border',
};

const LOCATION_CHIP_TONE = {
  office: 'bg-blue-400/15 text-blue-300 border-blue-400/40',
  wfh: 'bg-purple-400/15 text-purple-300 border-purple-400/40',
  remote: 'bg-amber-400/15 text-amber-300 border-amber-400/40',
};

const initialsOf = (name = '') =>
  String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';

const FilterChip = ({ label, active, tone, onClick, ariaLabel }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    aria-label={ariaLabel || `Filter by ${label}`}
    className={
      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition active:scale-[0.97] ' +
      (active
        ? tone
        : 'border-crewly-border bg-crewly-bg text-crewly-dim hover:border-crewly-green/40 hover:text-crewly-text')
    }
  >
    <span className="capitalize">{label}</span>
  </button>
);

const SummaryTile = ({ icon: Icon, label, value, tone }) => (
  <div className="card flex items-center gap-3 px-4 py-3">
    <span
      className={
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ' + tone
      }
    >
      <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
    </span>
    <span className="min-w-0">
      <span className="block text-xl font-bold leading-tight">{value}</span>
      <span className="block truncate text-xs text-crewly-dim">{label}</span>
    </span>
  </div>
);

const TeamAvailabilityPage = () => {
  const dispatch = useDispatch();

  const [search, setSearch] = useState('');
  const [presenceFilter, setPresenceFilter] = useState('');
  const [workLocationFilter, setWorkLocationFilter] = useState('');
  const [page, setPage] = useState(1);

  const team = useSelector((s) => s.presence && s.presence.team) || {
    items: [],
    summary: {
      total: 0,
      byPresence: { available: 0, busy: 0, dnd: 0, unknown: 0 },
      byWorkLocation: { office: 0, wfh: 0, remote: 0 },
    },
    meta: { page: 1, totalPages: 1, totalItems: 0 },
  };
  const teamLoading = useSelector((s) => s.presence && s.presence.teamLoading);
  const teamError = useSelector((s) => s.presence && s.presence.teamError);
  const actorRole = useSelector(
    (s) =>
      s &&
      s.auth &&
      (s.auth.user?.role ||
        s.auth.role ||
        s.auth.currentUser?.role),
  );
  const actorIsAdmin =
    actorRole === 'COMPANY_ADMIN' || actorRole === 'HR_MANAGER';

  const debouncedFilters = useMemo(
    () => ({
      search: search.trim().slice(0, MAX_SEARCH_LEN) || undefined,
      presence: presenceFilter || undefined,
      workLocation: workLocationFilter || undefined,
      page,
      limit: DEFAULT_LIMIT,
    }),
    [search, presenceFilter, workLocationFilter, page],
  );

  useEffect(() => {
    dispatch(fetchTeamAvailability(debouncedFilters));
  }, [dispatch, debouncedFilters]);

  // 37.4 — the realtime runtime bumps `teamBumpedAt` on every
  // same-company `presence:changed` envelope (debounced 1s). The
  // team page re-fetches on the bump, preserving the current
  // filter chip set. The bump is null on first render, then
  // monotonically non-null.
  const teamBumpedAt = useSelector((s) => s.presence?.teamBumpedAt || null);
  useEffect(() => {
    if (!teamBumpedAt) return;
    dispatch(fetchTeamAvailability(debouncedFilters));
  }, [dispatch, teamBumpedAt, debouncedFilters]);

  const onSearchChange = (e) => {
    setSearch(String(e.target.value || '').slice(0, MAX_SEARCH_LEN));
    setPage(1);
  };

  const togglePresence = (value) => {
    setPresenceFilter((current) => (current === value ? '' : value));
    setPage(1);
  };
  const toggleWorkLocation = (value) => {
    setWorkLocationFilter((current) => (current === value ? '' : value));
    setPage(1);
  };

  const items = Array.isArray(team.items) ? team.items : [];
  const summary = team.summary || {};
  const meta = team.meta || {};
  const byPresence = summary.byPresence || {};
  const byWorkLocation = summary.byWorkLocation || {};
  const totalPages = meta.totalPages || 1;
  const currentPage = meta.page || page;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Users aria-hidden="true" className="h-6 w-6 text-crewly-green" strokeWidth={2} />
            Team availability
          </h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Read-only view of your colleagues&apos; presence and work location.
            Visibility follows your existing employee scope.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-crewly-dim">
          {teamLoading === 'pending' ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-crewly-orange"
              />
              Refreshing…
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full bg-crewly-green"
              />
              {meta.totalItems || summary.total || 0} in view
            </span>
          )}
        </div>
      </div>

      {teamError ? (
        <div
          role="alert"
          className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red"
        >
          {teamError.message || 'Could not load team availability.'}
        </div>
      ) : null}

      <div className="card space-y-4">
        <div>
          <label
            htmlFor="team-availability-search"
            className="label"
          >
            Search
          </label>
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim"
              strokeWidth={2}
            />
            <input
              id="team-availability-search"
              type="search"
              value={search}
              maxLength={MAX_SEARCH_LEN}
              onChange={onSearchChange}
              placeholder="Name, employee code, or designation"
              aria-label="Search teammates"
              className="input pl-9"
            />
          </div>
        </div>

        <div>
          <span className="label">Presence</span>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Presence filter"
          >
            {PRESENCE_FILTER_VALUES.map((value) => (
              <FilterChip
                key={value}
                label={value}
                active={presenceFilter === value}
                tone={PRESENCE_CHIP_TONE[value]}
                onClick={() => togglePresence(value)}
              />
            ))}
          </div>
        </div>

        <div>
          <span className="label">Work location</span>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Work location filter"
          >
            {LOCATION_FILTER_VALUES.map((value) => (
              <FilterChip
                key={value}
                label={value}
                active={workLocationFilter === value}
                tone={LOCATION_CHIP_TONE[value]}
                onClick={() => toggleWorkLocation(value)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-4">
        <SummaryTile
          icon={Users}
          label="Total"
          value={summary.total || 0}
          tone="bg-white/10 text-crewly-text"
        />
        <SummaryTile
          icon={Coffee}
          label="Available"
          value={byPresence.available || 0}
          tone="bg-crewly-green/10 text-crewly-green"
        />
        <SummaryTile
          icon={Briefcase}
          label="Busy"
          value={byPresence.busy || 0}
          tone="bg-crewly-orange/10 text-crewly-orange"
        />
        <SummaryTile
          icon={Briefcase}
          label="DND"
          value={byPresence.dnd || 0}
          tone="bg-crewly-red/10 text-crewly-red"
        />
        <SummaryTile
          icon={SearchIcon}
          label="Unknown"
          value={byPresence.unknown || 0}
          tone="bg-white/10 text-crewly-dim"
        />
        <SummaryTile
          icon={Building2}
          label="Office"
          value={byWorkLocation.office || 0}
          tone="bg-blue-400/10 text-blue-300"
        />
        <SummaryTile
          icon={MapPin}
          label="WFH"
          value={byWorkLocation.wfh || 0}
          tone="bg-purple-400/10 text-purple-300"
        />
        <SummaryTile
          icon={MapPin}
          label="Remote"
          value={byWorkLocation.remote || 0}
          tone="bg-amber-400/10 text-amber-300"
        />
      </div>

      <div className="card p-0">
        <div className="table-wrap">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-crewly-dim">
              <tr className="border-b border-crewly-border">
                <th scope="col" className="px-4 py-3 sm:px-6">
                  Teammate
                </th>
                <th scope="col" className="px-4 py-3">
                  Code
                </th>
                <th scope="col" className="px-4 py-3">
                  Department
                </th>
                <th scope="col" className="px-4 py-3">
                  Presence
                </th>
                <th scope="col" className="px-4 py-3">
                  Location
                </th>
                <th scope="col" className="px-4 py-3">
                  Status message
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td
                    colSpan="6"
                    className="px-4 py-12 text-center sm:px-6"
                  >
                    {teamLoading === 'pending' ? (
                      <div className="flex flex-col items-center gap-2 text-sm text-crewly-dim">
                        <span
                          aria-hidden="true"
                          className="inline-block h-2 w-2 animate-pulse rounded-full bg-crewly-orange"
                        />
                        Loading teammates…
                      </div>
                    ) : summary.total === 0 ? (
                      <div className="space-y-3 text-sm">
                        <p className="font-medium text-crewly-text">
                          No teammates in your scope yet.
                        </p>
                        <p className="text-crewly-dim">
                          {actorIsAdmin
                            ? 'When teammates join your company and are marked ACTIVE, they will appear here. You can invite them from the People page.'
                            : 'When you join a department, your colleagues will appear here.'}
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                          {actorIsAdmin ? (
                            <Link
                              to="/app/users"
                              className="btn-ghost px-3 py-1.5 text-xs"
                            >
                              <UserPlus
                                aria-hidden="true"
                                className="h-3.5 w-3.5"
                                strokeWidth={2}
                              />
                              Open People page
                            </Link>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => {
                              setSearch('');
                              setPresenceFilter('');
                              setWorkLocationFilter('');
                              setPage(1);
                              dispatch(fetchTeamAvailability({ limit: DEFAULT_LIMIT, page: 1 }));
                            }}
                            className="btn-ghost px-3 py-1.5 text-xs"
                          >
                            <RefreshCw
                              aria-hidden="true"
                              className="h-3.5 w-3.5"
                              strokeWidth={2}
                            />
                            Refresh
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2 text-sm">
                        <p className="font-medium text-crewly-text">
                          No teammates match these filters.
                        </p>
                        <p className="text-crewly-dim">
                          {summary.total} teammate
                          {summary.total === 1 ? ' is' : 's are'} in your scope — try a different
                          search or clear the filter chips above.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setSearch('');
                            setPresenceFilter('');
                            setWorkLocationFilter('');
                            setPage(1);
                          }}
                          className="btn-ghost mt-1 px-3 py-1.5 text-xs"
                        >
                          Clear filters
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-crewly-border/60 last:border-b-0"
                  >
                    <td className="px-4 py-3 sm:px-6">
                      <div className="flex items-center gap-3">
                        {item.avatarUrl ? (
                          <img
                            src={item.avatarUrl}
                            alt=""
                            className="h-8 w-8 shrink-0 rounded-full object-cover"
                          />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 text-xs font-bold text-crewly-green"
                          >
                            {initialsOf(item.name)}
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium text-crewly-text">
                            {item.name || '—'}
                          </div>
                          <div className="truncate text-xs text-crewly-dim">
                            {item.designation || '—'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-crewly-dim">
                      {item.employeeCode || '—'}
                    </td>
                    <td className="px-4 py-3 text-crewly-text">
                      {item.department && item.department.name ? (
                        <span className="badge border border-crewly-border bg-crewly-bg text-crewly-text">
                          {item.department.name}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <PresenceIndicator
                        presence={item.presence}
                        size="sm"
                        showLabel
                      />
                    </td>
                    <td className="px-4 py-3">
                      {item.workLocation ? (
                        <span
                          className={
                            'badge border ' +
                            (LOCATION_CHIP_TONE[item.workLocation] ||
                              'border-crewly-border bg-crewly-bg text-crewly-dim')
                          }
                        >
                          {item.workLocation.toUpperCase()}
                        </span>
                      ) : (
                        <span className="text-crewly-dim">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-crewly-text">
                      {item.statusMessage ? (
                        <span className="line-clamp-1">{item.statusMessage}</span>
                      ) : (
                        <span className="text-crewly-dim">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-crewly-dim">
        <div>
          {meta.totalItems
            ? `Showing ${items.length} of ${meta.totalItems} teammates`
            : ''}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1 || teamLoading === 'pending'}
            className="btn-ghost px-3 py-1.5 text-xs"
          >
            Previous
          </button>
          <span className="px-2">
            Page {currentPage} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => (p >= totalPages ? p : p + 1))}
            disabled={currentPage >= totalPages || teamLoading === 'pending'}
            className="btn-ghost px-3 py-1.5 text-xs"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
};

export default TeamAvailabilityPage;