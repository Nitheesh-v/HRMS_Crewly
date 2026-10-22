/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, FilePlus2, Paperclip, Search } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import { HelpdeskError, HelpdeskLoading } from '../../components/helpdesk/HelpdeskUi.jsx';
import usePermission from '../../hooks/usePermission.js';
import { helpdeskAcceptedAttachment, helpdeskData, helpdeskErrorStatus, safeHelpdeskError } from './helpdeskFormat.js';

const fieldClass = 'mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-sm text-crewly-text placeholder:text-crewly-dim/70 focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20';
const labelClass = 'block text-xs font-medium text-crewly-dim';

const HelpdeskTicketCreatePage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { hasPermission } = usePermission();
  const canReadKb = hasPermission('HELPDESK_KB_READ');
  const [queues, setQueues] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [queueId, setQueueId] = useState(searchParams.get('queueId') || '');
  const [categoryId, setCategoryId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [requestedPriority, setRequestedPriority] = useState('');
  const [confidential, setConfidential] = useState(false);
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [kbQuery, setKbQuery] = useState('');
  const [kbArticles, setKbArticles] = useState([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbError, setKbError] = useState('');
  const [createdTicket, setCreatedTicket] = useState(null);

  const selectedQueue = useMemo(() => queues.find((queue) => String(queue.id) === String(queueId)) || null, [queues, queueId]);
  const categories = useMemo(() => (selectedQueue?.categories || []).filter((category) => category.enabled !== false), [selectedQueue]);

  const loadOptions = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [queueResponse, configResponse] = await Promise.all([
        helpdeskService.listQueues(),
        helpdeskService.getConfig(),
      ]);
      const nextQueues = Array.isArray(helpdeskData(queueResponse)) ? helpdeskData(queueResponse) : [];
      setQueues(nextQueues);
      setConfig(helpdeskData(configResponse) || null);
      setQueueId((current) => nextQueues.some((queue) => String(queue.id) === String(current)) ? current : String(nextQueues[0]?.id || ''));
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setQueues([]);
        setConfig(null);
      }
      setLoadError(safeHelpdeskError(requestError, 'Available queues could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    if (!categories.some((category) => String(category.id) === String(categoryId))) {
      setCategoryId(String(categories[0]?.id || ''));
    }
  }, [categories, categoryId]);

  const searchArticles = async (event) => {
    event.preventDefault();
    const query = kbQuery.trim();
    if (query.length < 2) {
      setKbError('Enter at least two characters to search published articles.');
      setKbArticles([]);
      return;
    }
    setKbLoading(true);
    setKbError('');
    try {
      const response = await helpdeskService.searchKnowledgeBase({ search: query, limit: 5 });
      setKbArticles(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []);
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) setKbArticles([]);
      setKbError(safeHelpdeskError(requestError, 'The Knowledge Base search could not be completed.'));
    } finally {
      setKbLoading(false);
    }
  };

  const handleFile = (nextFile) => {
    const result = helpdeskAcceptedAttachment(nextFile);
    if (!result.ok) {
      setFile(null);
      setFileError(result.reason);
      return;
    }
    setFile(nextFile || null);
    setFileError('');
  };

  const clearSensitiveForm = () => {
    setSubject('');
    setDescription('');
    setRequestedPriority('');
    setConfidential(false);
    setFile(null);
    setFileError('');
    setKbArticles([]);
    setKbQuery('');
  };

  const clearRestrictedState = () => {
    clearSensitiveForm();
    setQueues([]);
    setConfig(null);
    setQueueId('');
    setCategoryId('');
    setKbError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (createdTicket) return;
    setFormError('');
    if (!queueId || !categoryId) {
      setFormError('Choose an available queue and category.');
      return;
    }
    if (subject.trim().length < 2 || description.trim().length < 1) {
      setFormError('Add a subject and a description before submitting.');
      return;
    }
    const fileCheck = helpdeskAcceptedAttachment(file);
    if (!fileCheck.ok) {
      setFileError(fileCheck.reason);
      return;
    }

    setBusy(true);
    try {
      const payload = {
        queueId,
        categoryId,
        subject: subject.trim(),
        description: description.trim(),
        ...(confidential && config?.confidentialTicketsEnabled ? { confidential: true } : {}),
        ...(requestedPriority ? { requestedPriority } : {}),
      };
      const submittedFile = file;
      const response = await helpdeskService.createTicket(payload);
      const ticket = helpdeskData(response);
      const ticketNumber = String(ticket?.ticketNumber || '');
      setCreatedTicket(ticket || {});
      clearSensitiveForm();
      let notice = 'Your request has been submitted.';
      if (submittedFile && ticketNumber && config?.attachmentsEnabled) {
        try {
          await helpdeskService.uploadAttachment(ticketNumber, { file: submittedFile, body: '', messageType: 'public' });
        } catch (uploadError) {
          if ([401, 403, 404].includes(helpdeskErrorStatus(uploadError))) {
            setQueues([]);
            setConfig(null);
            setQueueId('');
            setCategoryId('');
          }
          notice = `Ticket ${ticketNumber} was created, but the attachment was not added. Open the ticket and retry the upload there. ${safeHelpdeskError(uploadError, 'The attachment could not be uploaded.')}`;
        }
      }
      if (ticketNumber) {
        navigate(`/app/helpdesk/tickets/${encodeURIComponent(ticketNumber)}`, { replace: true, state: { notice } });
      } else {
        setFormError('Your request was submitted, but its reference number could not be loaded. Open My tickets to view it.');
      }
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setFormError(safeHelpdeskError(requestError, 'Your ticket could not be submitted.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <HelpdeskLoading label="Loading available support options…" />;
  if (loadError) return <HelpdeskError message={loadError} onRetry={loadOptions} />;
  if (createdTicket) {
    return (
      <section className="rounded-2xl border border-crewly-border bg-crewly-card p-5" role="status" aria-labelledby="ticket-submitted-title">
        <h2 id="ticket-submitted-title" className="text-lg font-semibold">Your request was submitted</h2>
        <p className="mt-2 text-sm text-crewly-dim">The ticket description and attachment selection were cleared from this form.</p>
        <Link to={createdTicket.ticketNumber ? `/app/helpdesk/tickets/${encodeURIComponent(createdTicket.ticketNumber)}` : '/app/helpdesk/tickets'} className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-crewly-green px-4 text-sm font-semibold text-slate-950">{createdTicket.ticketNumber ? `Open ticket ${createdTicket.ticketNumber}` : 'Open My tickets'}</Link>
      </section>
    );
  }
  if (!config?.enabled || !config?.allowEmployeeTickets || !queues.length) {
    return (
      <section className="rounded-2xl border border-crewly-border bg-crewly-card p-5" role="status">
        <h2 className="text-lg font-semibold">Ticket submission is unavailable</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-crewly-dim">There are no enabled support queues available to your account right now. You can still review your existing requests or search the Knowledge Base.</p>
        <div className="mt-4 flex flex-wrap gap-2"><Link to="/app/helpdesk/tickets" className="inline-flex min-h-9 items-center rounded-lg border border-crewly-border px-3 text-sm hover:bg-crewly-bg">My tickets</Link>{canReadKb ? <Link to="/app/helpdesk/knowledge-base" className="inline-flex min-h-9 items-center rounded-lg border border-crewly-border px-3 text-sm hover:bg-crewly-bg">Knowledge Base</Link> : null}</div>
      </section>
    );
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.58fr)]">
      <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-6" aria-labelledby="new-ticket-title">
        <div className="mb-5 flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-crewly-green/10 text-crewly-green"><FilePlus2 className="h-5 w-5" aria-hidden="true" /></span>
          <div><h2 id="new-ticket-title" className="text-lg font-semibold">Create a support ticket</h2><p className="mt-1 text-xs leading-5 text-crewly-dim">Tell us what you need. Queue assignment and the final priority are handled by Helpdesk rules.</p></div>
        </div>
        {createdTicket && formError ? <div className="mb-4 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100" role="status">{formError}{createdTicket.ticketNumber ? <div className="mt-2"><Link to={`/app/helpdesk/tickets/${encodeURIComponent(createdTicket.ticketNumber)}`} className="font-semibold underline">Open ticket {createdTicket.ticketNumber}</Link></div> : null}</div> : null}
        {!createdTicket && formError ? <p className="mb-4 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-sm text-rose-100" role="alert">{formError}</p> : null}
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>Support queue
              <select value={queueId} onChange={(event) => setQueueId(event.target.value)} className={fieldClass} required>
                <option value="">Select a queue</option>{queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}
              </select>
              {selectedQueue?.description ? <span className="mt-1 block text-[11px] leading-5 text-crewly-dim">{selectedQueue.description}</span> : null}
            </label>
            <label className={labelClass}>Category
              <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className={fieldClass} required disabled={!categories.length}>
                <option value="">Select a category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
          </div>
          <label className={labelClass}>Subject
            <input value={subject} onChange={(event) => setSubject(event.target.value.slice(0, 120))} maxLength={120} required className={fieldClass} placeholder="Briefly describe your request" />
            <span className="mt-1 block text-right text-[10px] text-crewly-dim">{subject.length}/120</span>
          </label>
          <label className={labelClass}>Description
            <textarea value={description} onChange={(event) => setDescription(event.target.value.slice(0, 5000))} maxLength={5000} required rows={7} className={`${fieldClass} resize-y`} placeholder="Include the details support will need. Avoid passwords, one-time codes, or other secrets." />
            <span className="mt-1 block text-right text-[10px] text-crewly-dim">{description.length}/5000</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>Requested priority <span className="font-normal">(optional)</span>
              <select value={requestedPriority} onChange={(event) => setRequestedPriority(event.target.value)} className={fieldClass}>
                <option value="">No request</option><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
              </select>
              <span className="mt-1 block text-[11px] leading-5 text-crewly-dim">This is a request only; the queue policy determines the ticket priority.</span>
            </label>
            {config.confidentialTicketsEnabled ? (
              <label className="flex min-h-10 items-start gap-2.5 rounded-lg border border-crewly-border bg-crewly-bg/50 p-3 text-xs leading-5 text-crewly-text">
                <input type="checkbox" checked={confidential} onChange={(event) => setConfidential(event.target.checked)} className="mt-0.5 h-4 w-4 accent-crewly-green focus-visible:ring-2 focus-visible:ring-crewly-green" />
                <span><strong className="font-semibold">Request confidential handling</strong><span className="mt-0.5 block text-crewly-dim">Access remains limited by Helpdesk authorization and queue policy.</span></span>
              </label>
            ) : <div className="rounded-lg border border-crewly-border bg-crewly-bg/50 p-3 text-xs leading-5 text-crewly-dim">Confidential handling is not enabled for employee requests in this tenant.</div>}
          </div>
          {config.attachmentsEnabled ? (
            <div>
              <label className={labelClass} htmlFor="helpdesk-new-ticket-file">Attachment <span className="font-normal">(optional, up to 10 MB)</span></label>
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <input id="helpdesk-new-ticket-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => handleFile(event.target.files?.[0] || null)} className="block min-w-0 flex-1 text-xs text-crewly-dim file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-crewly-bg file:px-3 file:text-xs file:font-semibold file:text-crewly-text hover:file:bg-crewly-border" />
                {file ? <span className="inline-flex items-center gap-1.5 text-xs text-crewly-text"><Paperclip className="h-3.5 w-3.5 text-crewly-green" aria-hidden="true" />{file.name}</span> : null}
              </div>
              <p className="mt-1 text-[11px] text-crewly-dim">PDF, JPG, JPEG, PNG, and WEBP files are checked again by the server.</p>
              {fileError ? <p className="mt-1 text-xs text-rose-200" role="alert">{fileError}</p> : null}
            </div>
          ) : null}
          <div className="flex flex-col-reverse gap-2 border-t border-crewly-border pt-4 sm:flex-row sm:justify-end">
            <Link to="/app/helpdesk" className="inline-flex min-h-10 items-center justify-center rounded-lg border border-crewly-border px-4 text-sm font-medium hover:bg-crewly-bg">Cancel</Link>
            <button type="submit" disabled={busy || !categories.length} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-crewly-green px-4 text-sm font-semibold text-slate-950 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green">
              <FilePlus2 className="h-4 w-4" aria-hidden="true" />{busy ? 'Submitting…' : 'Submit ticket'}
            </button>
          </div>
        </form>
      </section>

      <aside className="space-y-4">
        {canReadKb ? (
          <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-5" aria-labelledby="related-help-title">
            <div className="flex items-center gap-2"><BookOpen className="h-4 w-4 text-crewly-green" aria-hidden="true" /><h2 id="related-help-title" className="text-sm font-semibold">Search help before submitting</h2></div>
            <p className="mt-1 text-xs leading-5 text-crewly-dim">Search separately; ticket text is not sent as a Knowledge Base query.</p>
            <form onSubmit={searchArticles} className="mt-3 flex gap-2">
              <label className="sr-only" htmlFor="helpdesk-kb-search-before-ticket">Search published articles</label>
              <input id="helpdesk-kb-search-before-ticket" value={kbQuery} onChange={(event) => setKbQuery(event.target.value.slice(0, 80))} maxLength={80} className="min-h-10 min-w-0 flex-1 rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20" placeholder="Search published articles" />
              <button type="submit" disabled={kbLoading} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-50"><Search className="h-4 w-4" aria-hidden="true" /><span className="sr-only sm:not-sr-only">Search</span></button>
            </form>
            {kbError ? <p className="mt-2 text-xs text-rose-200" role="alert">{kbError}</p> : null}
            {kbLoading ? <p className="mt-3 text-xs text-crewly-dim" role="status">Searching…</p> : null}
            {!kbLoading && kbArticles.length ? <ul className="mt-3 divide-y divide-crewly-border rounded-lg border border-crewly-border">{kbArticles.map((article) => <li key={article.id}><Link to={`/app/helpdesk/knowledge-base/articles/${encodeURIComponent(article.slug)}`} className="block p-3 hover:bg-crewly-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-crewly-green"><span className="text-xs font-semibold text-crewly-text">{article.title}</span>{article.summary ? <span className="mt-1 block line-clamp-2 text-[11px] leading-5 text-crewly-dim">{article.summary}</span> : null}</Link></li>)}</ul> : null}
          </section>
        ) : null}
        <div className="rounded-xl border border-sky-300/15 bg-sky-300/5 p-4 text-xs leading-5 text-sky-100/80">
          Do not include passwords, authentication codes, or payment details in a ticket. Your request and any public replies are visible only to authorized Helpdesk participants.
        </div>
      </aside>
    </div>
  );
};

export default HelpdeskTicketCreatePage;
