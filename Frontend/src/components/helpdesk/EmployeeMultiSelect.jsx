/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useId, useRef, useState } from 'react';
import {
  helpdeskData,
  helpdeskErrorStatus,
  helpdeskMeta,
  safeHelpdeskError,
} from '../../pages/helpdesk/helpdeskFormat.js';
import {
  HELPDESK_MEMBER_PAGE_LIMIT,
  HELPDESK_MEMBER_SEARCH_MAX_LENGTH,
  helpdeskEmployeeLabel,
  helpdeskMemberSelectable,
  nextHelpdeskActiveOption,
} from '../../pages/helpdesk/helpdeskMembership.js';

const sameMember = (left, right) => String(left?.id || '').toLowerCase() === String(right?.id || '').toLowerCase();
const noAccessError = () => {};

const pageRows = (response) => {
  const data = helpdeskData(response);
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.candidates) ? data.candidates : [];
};

export const EmployeeMultiSelect = ({
  label,
  value = [],
  onChange,
  searchCandidates,
  onAccessError = noAccessError,
  canSelectCandidate = () => true,
  disabled = false,
  helpText = '',
  emptySelectionText = 'No employees selected.',
  selectionHint = '',
  id: suppliedId,
}) => {
  const generatedId = useId();
  const inputId = suppliedId || `helpdesk-members-${generatedId.replaceAll(':', '')}`;
  const listboxId = `${inputId}-results`;
  const inputRef = useRef(null);
  const requestRef = useRef(0);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const normalizedSearch = search.trim();
  const selectableCandidates = candidates.filter((candidate) =>
    helpdeskMemberSelectable(candidate) && canSelectCandidate(candidate));

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (normalizedSearch.length < 2) {
      setCandidates([]);
      setPage(1);
      setPages(0);
      setError('');
      setLoading(false);
      setLoadingMore(false);
      setActiveIndex(-1);
      return undefined;
    }

    setLoading(true);
    setLoadingMore(false);
    setError('');
    setCandidates([]);
    setPage(1);
    setPages(0);
    setActiveIndex(-1);
    const timer = setTimeout(async () => {
      try {
        const response = await searchCandidates({
          search: normalizedSearch,
          page: 1,
          limit: HELPDESK_MEMBER_PAGE_LIMIT,
        });
        if (requestRef.current !== requestId) return;
        setCandidates(pageRows(response));
        setPage(Number(helpdeskMeta(response)?.page) || 1);
        setPages(Number(helpdeskMeta(response)?.pages) || 1);
      } catch (requestError) {
        if (requestRef.current !== requestId) return;
        const status = helpdeskErrorStatus(requestError);
        if ([401, 403].includes(status)) onAccessError(requestError);
        setError([401, 403].includes(status)
          ? safeHelpdeskError(requestError)
          : 'Employee search could not be loaded. Check your connection and try again.');
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      if (requestRef.current === requestId) requestRef.current += 1;
    };
  }, [normalizedSearch, onAccessError, searchCandidates]);

  const selectCandidate = (candidate) => {
    if (!helpdeskMemberSelectable(candidate) || !canSelectCandidate(candidate)) return;
    if (value.some((member) => sameMember(member, candidate))) return;
    onChange([...value, candidate]);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const removeCandidate = (candidate) => {
    onChange(value.filter((member) => !sameMember(member, candidate)));
    inputRef.current?.focus();
  };

  const loadMore = async () => {
    const nextPage = page + 1;
    const requestId = requestRef.current;
    setLoadingMore(true);
    setError('');
    try {
      const response = await searchCandidates({
        search: normalizedSearch,
        page: nextPage,
        limit: HELPDESK_MEMBER_PAGE_LIMIT,
      });
      if (requestRef.current !== requestId) return;
      const rows = pageRows(response);
      setCandidates((current) => {
        const next = new Map(current.map((candidate) => [String(candidate.id).toLowerCase(), candidate]));
        rows.forEach((candidate) => next.set(String(candidate.id).toLowerCase(), candidate));
        return [...next.values()];
      });
      setPage(Number(helpdeskMeta(response)?.page) || nextPage);
      setPages(Number(helpdeskMeta(response)?.pages) || pages);
    } catch {
      if (requestRef.current === requestId) setError('More employees could not be loaded. Try again.');
    } finally {
      if (requestRef.current === requestId) setLoadingMore(false);
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => nextHelpdeskActiveOption(current, 1, selectableCandidates.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => nextHelpdeskActiveOption(current, -1, selectableCandidates.length));
      return;
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (selectableCandidates.length) {
        const index = activeIndex >= 0 && activeIndex < selectableCandidates.length ? activeIndex : 0;
        selectCandidate(selectableCandidates[index]);
      }
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  const showResults = open;

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-xs font-medium text-crewly-dim">{label}</label>
      {helpText ? <p className="text-[11px] leading-4 text-crewly-dim">{helpText}</p> : null}
      {selectionHint ? <p className="text-[11px] leading-4 text-amber-100/80">{selectionHint}</p> : null}
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={showResults}
          aria-controls={showResults && !loading && !error && selectableCandidates.length ? listboxId : undefined}
          aria-activedescendant={activeIndex >= 0 && selectableCandidates[activeIndex] ? `${inputId}-option-${activeIndex}` : undefined}
          aria-busy={loading || loadingMore}
          autoComplete="off"
          maxLength={HELPDESK_MEMBER_SEARCH_MAX_LENGTH}
          value={search}
          onChange={(event) => { setSearch(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className="min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20 disabled:opacity-50"
          placeholder="Search by name, employee code, or work email"
        />
        {showResults ? (
          <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-crewly-border bg-crewly-card p-1 shadow-xl" aria-label={`${label} search results`}>
            {loading ? <p className="px-3 py-3 text-xs text-crewly-dim" role="status">Searching employees…</p> : null}
            {!loading && error ? <p className="px-3 py-3 text-xs text-rose-100" role="alert">{error}</p> : null}
            {!loading && !error && selectableCandidates.length === 0 ? (
              <p className="px-3 py-3 text-xs text-crewly-dim" role="status">
                {normalizedSearch.length < 2
                  ? 'Type at least two characters to search.'
                  : candidates.length && selectionHint
                    ? 'Select this employee as a queue agent first.'
                    : 'No eligible employees found.'}
              </p>
            ) : null}
            {!loading && !error && selectableCandidates.length ? (
              <ul id={listboxId} role="listbox" aria-label={`${label} employees`} aria-multiselectable="true">
                {selectableCandidates.map((candidate, index) => {
                  const selected = value.some((member) => sameMember(member, candidate));
                  const labelText = helpdeskEmployeeLabel(candidate);
                  return (
                    <li
                      key={candidate.id}
                      id={`${inputId}-option-${index}`}
                      role="option"
                      aria-selected={selected}
                      className={`rounded-md px-3 py-2 ${index === activeIndex ? 'bg-crewly-green/10' : ''} ${selected ? 'opacity-60' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectCandidate(candidate)}
                    >
                      <span className="block text-xs font-semibold text-crewly-text">{labelText}</span>
                      <span className="mt-0.5 block break-all text-[10px] text-crewly-dim">
                        {[candidate.workEmail, candidate.displayStatus].filter(Boolean).join(' · ')}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {!loading && !error && page < pages ? (
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={loadMore} disabled={loadingMore} className="min-h-9 w-full rounded-md px-3 text-left text-xs font-semibold text-crewly-green hover:bg-crewly-bg disabled:opacity-50">
                {loadingMore ? 'Loading more…' : 'Load more employees'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2" aria-label={`${label} selected employees`}>
        {value.length ? value.map((member) => (
          <span key={member.id} className={`inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 ${member.eligible ? 'border-crewly-border bg-crewly-bg/70' : 'border-amber-300/30 bg-amber-300/5'}`}>
            <span className="min-w-0">
              <span className="block break-words text-[11px] font-medium text-crewly-text">{helpdeskEmployeeLabel(member)}</span>
              <span className="block break-all text-[10px] text-crewly-dim">
                {[member.workEmail, member.displayStatus || 'Unavailable'].filter(Boolean).join(' · ')}
              </span>
            </span>
            <button
              type="button"
              onClick={() => removeCandidate(member)}
              disabled={disabled}
              aria-label={`Remove ${member.unavailable ? 'unavailable member' : member.name} from ${label}`}
              className="min-h-7 min-w-7 rounded-md border border-crewly-border px-1.5 text-xs font-semibold text-crewly-dim hover:text-rose-200 disabled:opacity-50"
            >
              Remove
            </button>
          </span>
        )) : <p className="text-[11px] text-crewly-dim">{emptySelectionText}</p>}
      </div>
    </div>
  );
};

export default EmployeeMultiSelect;
