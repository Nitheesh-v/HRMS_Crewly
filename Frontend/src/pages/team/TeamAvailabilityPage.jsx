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

import PresenceIndicator from '../../components/presence/PresenceIndicator.jsx';
import { fetchTeamAvailability } from '../../redux/slices/presenceSlice.js';

const PRESENCE_FILTER_VALUES = ['available', 'busy', 'dnd', 'unknown'];
const LOCATION_FILTER_VALUES = ['office', 'wfh', 'remote'];
const MAX_SEARCH_LEN = 60;
const DEFAULT_LIMIT = 25;

const FilterChip = ({ label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={
      'team-availability-chip' +
      (active ? ' team-availability-chip--active' : '')
    }
    aria-pressed={active}
  >
    {label}
  </button>
);

const SummaryTile = ({ label, value }) => (
  <div className="team-availability-tile" aria-label={`${label}: ${value}`}>
    <div className="team-availability-tile__label">{label}</div>
    <div className="team-availability-tile__value">{value}</div>
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

  return (
    <main className="team-availability-page">
      <header className="team-availability-page__header">
        <h1 className="team-availability-page__title">Team availability</h1>
        <p className="team-availability-page__subtitle">
          Read-only view of your colleagues' presence and work location.
          Visibility follows your existing employee scope.
        </p>
      </header>

      <section className="team-availability-page__controls">
        <label htmlFor="team-availability-search" className="team-availability-page__label">
          Search
        </label>
        <input
          id="team-availability-search"
          type="search"
          value={search}
          maxLength={MAX_SEARCH_LEN}
          onChange={onSearchChange}
          placeholder="Name, employee code, or designation"
          className="team-availability-page__search"
          aria-label="Search teammates"
        />

        <div className="team-availability-page__chips" role="group" aria-label="Presence filter">
          <span className="team-availability-page__chips-label">Presence</span>
          {PRESENCE_FILTER_VALUES.map((value) => (
            <FilterChip
              key={value}
              label={value}
              active={presenceFilter === value}
              onClick={() => togglePresence(value)}
            />
          ))}
        </div>

        <div className="team-availability-page__chips" role="group" aria-label="Work location filter">
          <span className="team-availability-page__chips-label">Location</span>
          {LOCATION_FILTER_VALUES.map((value) => (
            <FilterChip
              key={value}
              label={value}
              active={workLocationFilter === value}
              onClick={() => toggleWorkLocation(value)}
            />
          ))}
        </div>
      </section>

      <section className="team-availability-page__summary" aria-label="Summary">
        <SummaryTile label="Total" value={summary.total || 0} />
        <SummaryTile label="Available" value={(summary.byPresence && summary.byPresence.available) || 0} />
        <SummaryTile label="Busy" value={(summary.byPresence && summary.byPresence.busy) || 0} />
        <SummaryTile label="DND" value={(summary.byPresence && summary.byPresence.dnd) || 0} />
        <SummaryTile label="Unknown" value={(summary.byPresence && summary.byPresence.unknown) || 0} />
        <SummaryTile label="Office" value={(summary.byWorkLocation && summary.byWorkLocation.office) || 0} />
        <SummaryTile label="WFH" value={(summary.byWorkLocation && summary.byWorkLocation.wfh) || 0} />
        <SummaryTile label="Remote" value={(summary.byWorkLocation && summary.byWorkLocation.remote) || 0} />
      </section>

      {teamError ? (
        <div role="alert" className="team-availability-page__error">
          {teamError.message || 'Could not load team availability.'}
        </div>
      ) : null}

      <table className="team-availability-page__table">
        <thead>
          <tr>
            <th scope="col">Teammate</th>
            <th scope="col">Code</th>
            <th scope="col">Department</th>
            <th scope="col">Presence</th>
            <th scope="col">Location</th>
            <th scope="col">Status message</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan="6">
                {teamLoading === 'pending' ? 'Loading…' : 'No teammates match these filters.'}
              </td>
            </tr>
          ) : (
            items.map((item) => (
              <tr key={item.id}>
                <td>
                  <div className="team-availability-page__name">{item.name}</div>
                  <div className="team-availability-page__designation">{item.designation}</div>
                </td>
                <td>{item.employeeCode}</td>
                <td>{item.department && item.department.name}</td>
                <td>
                  <PresenceIndicator
                    presence={item.presence}
                    workLocation={item.workLocation}
                  />
                </td>
                <td>{item.workLocation || '—'}</td>
                <td>{item.statusMessage || '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <nav className="team-availability-page__pager" aria-label="Pagination">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span>
          Page {meta.page || page} of {meta.totalPages || 1}
        </span>
        <button
          type="button"
          onClick={() => setPage((p) => (meta.totalPages && p >= meta.totalPages ? p : p + 1))}
          disabled={meta.totalPages ? page >= meta.totalPages : true}
        >
          Next
        </button>
      </nav>
    </main>
  );
};

export default TeamAvailabilityPage;