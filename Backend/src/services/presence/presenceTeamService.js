// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.3 — TEAM AVAILABILITY SERVICE
//
//  Read-only team view of effective presence.
//
//  AUTHORITY (Phase 37.3 §5)
//    This service does NOT introduce a new visibility rule. It reuses
//    utils/scope.js#getScopedUserIds — the same authority that
//    controllers/userController.js#listUsers uses. EMPLOYEE → [self];
//    TEAM_LEAD → self + direct reports; MANAGER → department;
//    HR_MANAGER / COMPANY_ADMIN → unrestricted.
//
//  ONE BATCHED PRESENCE READ (§28 / §29)
//    A single UserPresence.find({ companyId, userId: { $in: ids } })
//    reads every authorized row in one round-trip. There are no
//    per-row presence fetches.
//
//  EXPLICIT USER PROJECTION
//    We project `_id name employeeCode designation avatarUrl department
//    role status` from a UserModel.find and `.populate('department',
//    'name')`. NEVER email / phone / password / salary / Aadhaar / PAN /
//    UAN / bank / address / leave reason / attendance.
//
//  SINGLE RESOLVER AUTHORITY
//    Every presence row runs through presenceResolver.resolvePresence
//    — the 37.1 resolver. We do NOT introduce a team-specific
//    precedence.
//
//  UNKNOWN ≠ OFFLINE (§20)
//    The resolver returns `presence: 'unknown'` when there is no live
//    signal and no manual status. The team view surfaces that honestly.
// ═══════════════════════════════════════════════════════════════════════════

import * as ScopeNS from '../../utils/scope.js';
import { resolvePresence } from './presenceResolver.js';
import { isWorkLocation } from './presenceConfig.js';
import { getPresenceTenantConfigOrThrow } from './presenceTenantConfigService.js';

const getScopedUserIds = ScopeNS.getScopedUserIds;

const PRESENCE_TEAM_ALLOWED_FILTERS = Object.freeze([
  'available',
  'busy',
  'dnd',
  'unknown',
  'office',
  'wfh',
  'remote',
]);

const MAX_SEARCH_LEN = 60;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Safe literal search across display name + employeeCode + designation.
// No raw user input reaches $regex (Phase 32.10 invariant). The caller
// already passed through validator.maxLen(MAX_SEARCH_LEN), so this
// function only escapes and bounds.
const buildSearchFilter = (rawSearch) => {
  if (!rawSearch) return null;
  const trimmed = String(rawSearch).trim().slice(0, MAX_SEARCH_LEN);
  if (trimmed.length === 0) return null;
  const safe = escapeRegex(trimmed);
  return {
    $or: [
      { name: { $regex: safe, $options: 'i' } },
      { employeeCode: { $regex: safe, $options: 'i' } },
      { designation: { $regex: safe, $options: 'i' } },
    ],
  };
};

const DTO_PROJECTION = Object.freeze([
  '_id',
  'name',
  'employeeCode',
  'designation',
  'avatarUrl',
  'department',
  'role',
  'status',
]);

// Apply the Phase 37.1 resolver to one User + (optionally) its UserPresence
// row. The resolver is pure: it never throws. Returns the normalised
// effective presence snapshot for that one user.
const resolveOne = (user, presenceDoc, config) => {
  const { presence, presenceSource, manualStatus, manualStatusExpiresAt,
    statusMessage, statusMessageExpiresAt, workLocation,
    workLocationExpiresAt, livePresenceAvailable } = resolvePresence({
    durable: presenceDoc,
    config,
    now: new Date(),
  });

  return {
    id: String(user._id),
    name: user.name || '',
    employeeCode: user.employeeCode || '',
    designation: user.designation || '',
    avatarUrl: user.avatarUrl || '',
    department: user.department
      ? {
          id:
            (user.department._id && String(user.department._id)) ||
            String(user.department),
          name: user.department.name || '',
        }
      : null,
    role: user.role || '',
    presence,
    presenceSource,
    manualStatus,
    manualStatusExpiresAt,
    statusMessage: config.statusMessagesEnabled ? statusMessage : '',
    statusMessageExpiresAt: config.statusMessagesEnabled
      ? statusMessageExpiresAt
      : null,
    workLocation: config.workLocationEnabled ? workLocation : null,
    workLocationExpiresAt: config.workLocationEnabled
      ? workLocationExpiresAt
      : null,
    livePresenceAvailable,
  };
};

const computeSummary = (rows) => {
  const summary = {
    total: rows.length,
    byPresence: {
      available: 0,
      busy: 0,
      dnd: 0,
      unknown: 0,
    },
    byWorkLocation: {
      office: 0,
      wfh: 0,
      remote: 0,
    },
  };
  for (const r of rows) {
    if (r.presence === 'available') summary.byPresence.available += 1;
    else if (r.presence === 'busy') summary.byPresence.busy += 1;
    else if (r.presence === 'dnd') summary.byPresence.dnd += 1;
    else if (r.presence === 'unknown') summary.byPresence.unknown += 1;
    if (r.workLocation === 'office') summary.byWorkLocation.office += 1;
    else if (r.workLocation === 'wfh') summary.byWorkLocation.wfh += 1;
    else if (r.workLocation === 'remote') summary.byWorkLocation.remote += 1;
  }
  return summary;
};

const matchesPresenceFilter = (row, filter) => {
  if (!filter) return true;
  // Phase 37.3 §16: support a SECOND semantic for 'office' / 'wfh' /
  // 'remote' as presence-shaped filters too (server: a row matches
  // 'office' if workLocation is office, regardless of manual status).
  if (filter === 'office' || filter === 'wfh' || filter === 'remote') {
    return row.workLocation === filter;
  }
  if (filter === 'unknown') {
    // UNKNOWN means "no live signal AND no manual status". A row with a
    // non-expired manual state is NOT unknown, even if the live signal
    // is unavailable. This matches the 37.1 resolver's "manual wins"
    // precedence (capsule §2.8 + 37.1 §16).
    return row.presence === 'unknown';
  }
  return row.presence === filter;
};

const matchesLocationFilter = (row, filter) => {
  if (!filter) return true;
  if (!isWorkLocation(filter)) return true;
  return row.workLocation === filter;
};

const parsePage = (rawPage, rawLimit) => {
  const page = Math.max(1, Number.parseInt(rawPage, 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.parseInt(rawLimit, 10) || DEFAULT_LIMIT),
  );
  return { page, limit };
};

export const presenceTeamService = (deps = {}) => {
  const UserModel = deps.UserModel;
  const UserPresenceModel = deps.UserPresenceModel;
  if (!UserModel) throw new Error('presenceTeamService requires UserModel');
  if (!UserPresenceModel) {
    throw new Error('presenceTeamService requires UserPresenceModel');
  }
  // Inject the scope authority so the hermetic test can swap it without
  // touching the real Mongo via utils/scope.js.
  const scopeReader = deps.scopeReader || getScopedUserIds;
  // Inject the tenant config reader so hermetic tests can stub it.
  // The team view does NOT enforce tenant config (the self-service
  // endpoints do); the reader is here for symmetry and for any future
  // tenant-aware chip (37.3 §32 left a hook for it).
  const tenantConfigReader =
    deps.tenantConfigReader || getPresenceTenantConfigOrThrow;

  const getTeamAvailability = async ({
    companyId,
    actor,
    search,
    presence,
    workLocation,
    page: rawPage,
    limit: rawLimit,
  }) => {
    if (!companyId) {
      throw new Error('companyId is required');
    }
    if (!actor || !actor._id || !actor.role) {
      throw new Error('actor with _id and role is required');
    }
    // Validate presence filter up-front. The validator already does
    // this, but a defense-in-depth check here means a programmatic
    // caller of the service (or the hermetic test) cannot smuggle in
    // an unknown value.
    if (presence !== undefined && presence !== null && !PRESENCE_TEAM_ALLOWED_FILTERS.includes(presence)) {
      throw new Error(`presence filter must be one of: ${PRESENCE_TEAM_ALLOWED_FILTERS.join(', ')}`);
    }

    const config = await tenantConfigReader({ companyId });

    // Build the authorized user-IDs filter. Phase 37.3 §5: presence does
    // NOT grant a new discovery right. We reuse the same
    // `scopedUserFilter` the existing GET /users endpoint uses. That
    // helper takes a `req`-like object; we build a minimal one with
    // only the fields the helper reads.
    const scopeIds = await scopeReader({
      user: { _id: actor._id, role: actor.role, department: actor.department },
      companyId,
    });

    // The user base query: company + scope + ACTIVE only. Employees marked
    // INACTIVE are not in the discoverable population (§6 / §18).
    const baseFilter = { companyId, status: 'ACTIVE' };
    if (Array.isArray(scopeIds) && scopeIds.length > 0) {
      baseFilter._id = { $in: scopeIds };
    } else if (Array.isArray(scopeIds)) {
      // The scope authority returned an explicit empty array — this means
      // the caller has no discoverable coworkers (e.g. EMPLOYEE with
      // themselves; or a manager whose department is empty). Empty
      // population, NOT a bypass.
      return {
        items: [],
        summary: computeSummary([]),
        meta: {
          page: 1,
          pageSize: DEFAULT_LIMIT,
          pages: 1,
          totalPages: 1,
          totalItems: 0,
          total: 0,
          limit: DEFAULT_LIMIT,
        },
        config: {
          enabled: config.enabled,
          statusMessagesEnabled: config.statusMessagesEnabled,
          workLocationEnabled: config.workLocationEnabled,
          employeePresenceVisible: config.employeePresenceVisible,
        },
      };
    }
    // scopeIds === null (HR_MANAGER / COMPANY_ADMIN) → no user-id limit.

    const searchFilter = buildSearchFilter(search);
    const userFilter = searchFilter
      ? { $and: [baseFilter, searchFilter] }
      : baseFilter;

    // 1) Authorised user list — explicit projection. Deterministic sort.
    const users = await UserModel.find(userFilter)
      .select(DTO_PROJECTION.join(' '))
      .populate('department', 'name')
      .sort({ name: 1, _id: 1 })
      .lean();

    if (users.length === 0) {
      return {
        items: [],
        summary: computeSummary([]),
        meta: {
          page: 1,
          pageSize: DEFAULT_LIMIT,
          pages: 1,
          totalPages: 1,
          totalItems: 0,
          total: 0,
          limit: DEFAULT_LIMIT,
        },
        config: {
          enabled: config.enabled,
          statusMessagesEnabled: config.statusMessagesEnabled,
          workLocationEnabled: config.workLocationEnabled,
          employeePresenceVisible: config.employeePresenceVisible,
        },
      };
    }

    // 2) ONE batched presence read for every authorised user. No N+1.
    const userIds = users.map((u) => u._id);
    const presenceRows = await UserPresenceModel.find({
      companyId,
      userId: { $in: userIds },
    })
      .select(
        'userId manualStatus manualStatusExpiresAt statusMessage statusMessageExpiresAt workLocation workLocationExpiresAt',
      )
      .lean();

    const presenceMap = new Map();
    for (const row of presenceRows) presenceMap.set(String(row.userId), row);

    // 3) Resolve every row through the 37.1 resolver. This is the SINGLE
    //    precedence authority (37.1 §16). We do NOT introduce a parallel
    //    team-specific precedence (§8 / §22).
    const resolved = users.map((u) => resolveOne(u, presenceMap.get(String(u._id)), config));

    // 4) Apply presence + workLocation filters in memory. Filter
    //    happens AFTER scope + search so summary counts always
    //    respect authorization.
    const filtered = resolved.filter(
      (r) =>
        matchesPresenceFilter(r, presence) &&
        matchesLocationFilter(r, workLocation),
    );

    // 5) Summary counts are derived from the post-filter rowset. Counts
    //    can never be a side-channel around employee visibility
    //    because we only ever see authorised rows here.
    const summary = computeSummary(filtered);

    // 6) Paginate the filtered result. Limit is bounded; page is >= 1.
    const { page, limit } = parsePage(rawPage, rawLimit);
    const start = (page - 1) * limit;
    const pageItems = filtered.slice(start, start + limit);

    return {
      items: pageItems,
      summary,
      meta: {
        page,
        pageSize: limit,
        limit,
        pages: Math.max(1, Math.ceil(filtered.length / limit)),
        totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
        totalItems: filtered.length,
        total: filtered.length,
      },
      config: {
        enabled: config.enabled,
        statusMessagesEnabled: config.statusMessagesEnabled,
        workLocationEnabled: config.workLocationEnabled,
        employeePresenceVisible: config.employeePresenceVisible,
      },
    };
  };

  return { getTeamAvailability };
};

// NOTE: no `default` export. The service factory MUST be invoked with
// concrete UserModel + UserPresenceModel deps. Wiring a default that
// called `presenceTeamService()` with no deps would throw at module
// load time and break every dynamic import — including the hermetic
// tests. The controller instantiates the service explicitly and
// holds it in module scope.

export { PRESENCE_TEAM_ALLOWED_FILTERS, MAX_SEARCH_LEN, DEFAULT_LIMIT, MAX_LIMIT };