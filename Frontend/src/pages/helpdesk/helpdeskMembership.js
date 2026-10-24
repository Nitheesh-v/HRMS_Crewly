export const HELPDESK_MEMBER_PAGE_LIMIT = 20;
export const HELPDESK_MEMBER_SEARCH_MAX_LENGTH = 60;

export const HELPDESK_MEMBERSHIP_ROLES = Object.freeze([
  { key: 'agents', label: 'Queue agents', confidential: false },
  { key: 'managers', label: 'Queue managers', confidential: false },
  { key: 'confidentialAgents', label: 'Confidential agents', confidential: true },
  { key: 'confidentialReviewers', label: 'Confidential reviewers', confidential: true },
]);

export const emptyHelpdeskMemberGroups = () => ({
  agents: [],
  managers: [],
  confidentialAgents: [],
  confidentialReviewers: [],
});

const idOf = (member) => String(member?.id || '').trim();

const normalizeMember = (member = {}) => ({
  id: idOf(member),
  name: String(member.name || '').trim() || 'Unavailable member',
  employeeCode: String(member.employeeCode || '').trim(),
  workEmail: String(member.workEmail || '').trim(),
  department: String(member.department || '').trim(),
  employmentStatus: String(member.employmentStatus || 'UNAVAILABLE'),
  displayStatus: String(member.displayStatus || 'Unavailable'),
  eligible: member.eligible === true,
  unavailable: member.unavailable === true,
  accountSetupRequired: member.accountSetupRequired === true,
});

export const unresolvedHelpdeskMember = (id) => normalizeMember({
  id,
  name: 'Member details unavailable',
  employmentStatus: 'UNAVAILABLE',
  displayStatus: 'Unavailable',
  eligible: false,
  unavailable: true,
});

export const helpdeskMemberGroupsFromQueue = (queue) => ({
  agents: (queue?.agents || []).map((id) => unresolvedHelpdeskMember(id)),
  managers: (queue?.managers || []).map((id) => unresolvedHelpdeskMember(id)),
  confidentialAgents: (queue?.confidentiality?.agentIds || []).map((id) => unresolvedHelpdeskMember(id)),
  confidentialReviewers: (queue?.confidentiality?.reviewerIds || []).map((id) => unresolvedHelpdeskMember(id)),
});

export const helpdeskMemberGroupsFromResolution = (membership = {}) => Object.fromEntries(
  HELPDESK_MEMBERSHIP_ROLES.map(({ key }) => [
    key,
    (Array.isArray(membership[key]) ? membership[key] : []).map(normalizeMember),
  ]),
);

export const helpdeskMembershipResolutionMatchesQueue = (queue, membership = {}) => {
  const expected = helpdeskMemberGroupsFromQueue(queue);
  return HELPDESK_MEMBERSHIP_ROLES.every(({ key }) => {
    if (!Array.isArray(membership[key])) return false;
    const expectedIds = expected[key].map((member) => idOf(member).toLowerCase()).sort();
    const resolvedIds = membership[key].map((member) => idOf(member).toLowerCase()).sort();
    return expectedIds.length === resolvedIds.length
      && expectedIds.every((id, index) => id === resolvedIds[index]);
  });
};

export const helpdeskEmployeeLabel = (member) => {
  const normalized = normalizeMember(member);
  if (normalized.unavailable) return 'Unavailable member';
  return [normalized.name, normalized.employeeCode, normalized.department]
    .filter(Boolean)
    .join(' · ') || 'Employee details unavailable';
};

export const summarizeHelpdeskMembershipChanges = ({ before, after } = {}) => HELPDESK_MEMBERSHIP_ROLES.map(({ key, label, confidential }) => {
  const priorMembers = Array.isArray(before?.[key]) ? before[key] : [];
  const nextMembers = Array.isArray(after?.[key]) ? after[key] : [];
  const priorById = new Map(priorMembers.map((member) => [idOf(member).toLowerCase(), member]));
  const nextById = new Map(nextMembers.map((member) => [idOf(member).toLowerCase(), member]));
  return {
    key,
    label,
    confidential,
    added: nextMembers.filter((member) => !priorById.has(idOf(member).toLowerCase())),
    removed: priorMembers.filter((member) => !nextById.has(idOf(member).toLowerCase())),
  };
}).filter((change) => change.added.length || change.removed.length);

export const helpdeskMemberSelectable = (member) =>
  member?.eligible === true && member?.unavailable !== true;

export const nextHelpdeskActiveOption = (currentIndex, direction, optionCount) => {
  if (optionCount < 1) return -1;
  const normalizedCurrent = Number.isInteger(currentIndex) ? currentIndex : -1;
  if (direction < 0) return normalizedCurrent <= 0 ? optionCount - 1 : normalizedCurrent - 1;
  return normalizedCurrent >= optionCount - 1 ? 0 : normalizedCurrent + 1;
};
