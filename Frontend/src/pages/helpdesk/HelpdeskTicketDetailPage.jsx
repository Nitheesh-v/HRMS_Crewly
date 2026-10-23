/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  MessageCircle,
  Paperclip,
  RefreshCw,
  Send,
  ShieldAlert,
  Star,
  UserRound,
} from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import useAuth from '../../hooks/useAuth.jsx';
import usePermission from '../../hooks/usePermission.js';
import {
  AttachmentButton,
  HelpdeskEmpty,
  HelpdeskError,
  HelpdeskLoading,
  HelpdeskSlaSummary,
  PriorityPill,
  StatusPill,
  ArticleText,
} from '../../components/helpdesk/HelpdeskUi.jsx';
import {
  HELPDESK_PRIORITIES,
  HELPDESK_TRANSITIONS,
  helpdeskAcceptedAttachment,
  helpdeskData,
  helpdeskFeedback,
  helpdeskDateTime,
  helpdeskErrorStatus,
  helpdeskMeta,
  safeHelpdeskError,
} from './helpdeskFormat.js';

const textareaClass = 'mt-1.5 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2.5 text-sm text-crewly-text placeholder:text-crewly-dim/70 focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20';
const fieldClass = 'mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20';
const labelClass = 'block text-xs font-medium text-crewly-dim';
const ACTIVE_MESSAGE_STATUSES = new Set(['open', 'assigned', 'in_progress', 'waiting_for_employee', 'waiting_for_department']);

const HelpdeskTicketDetailPage = () => {
  const { ticketNumber = '' } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const { hasPermission } = usePermission();
  const canReadMine = hasPermission('HELPDESK_TICKET_READ_SELF');
  const canManage = hasPermission('HELPDESK_TICKET_MANAGE');
  const canManageQueues = hasPermission('HELPDESK_QUEUE_MANAGE');
  const canReadQueueConfig = hasPermission('HELPDESK_QUEUE_READ');
  const canReadKb = hasPermission('HELPDESK_KB_READ');
  const [ticket, setTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageMeta, setMessageMeta] = useState(null);
  const [sla, setSla] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [config, setConfig] = useState(null);
  const [queues, setQueues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState(location.state?.notice || '');
  const [busyKey, setBusyKey] = useState('');
  const [messageBody, setMessageBody] = useState('');
  const [messageType, setMessageType] = useState('public');
  const [internalAcknowledged, setInternalAcknowledged] = useState(false);
  const [attachmentFile, setAttachmentFile] = useState(null);
  const [attachmentError, setAttachmentError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [transferQueueId, setTransferQueueId] = useState('');
  const [transferCategoryId, setTransferCategoryId] = useState('');
  const [transferAssigneeId, setTransferAssigneeId] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const [reopenReason, setReopenReason] = useState('');
  const [rating, setRating] = useState(0);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [articleQuery, setArticleQuery] = useState('');
  const [articleResults, setArticleResults] = useState([]);
  const [selectedArticleIds, setSelectedArticleIds] = useState([]);
  const [articleSearchError, setArticleSearchError] = useState('');
  const [articleSearchBusy, setArticleSearchBusy] = useState(false);
  const requestRef = useRef(0);

  const clearRestrictedState = useCallback(() => {
    requestRef.current += 1;
    setTicket(null);
    setMessages([]);
    setMessageMeta(null);
    setSla(null);
    setFeedback(null);
    setConfig(null);
    setQueues([]);
    setLoading(false);
    setLoadingEarlier(false);
    setPageError('');
    setActionError('');
    setNotice('');
    setBusyKey('');
    setMessageBody('');
    setMessageType('public');
    setInternalAcknowledged(false);
    setAttachmentFile(null);
    setAttachmentError('');
    setMessageError('');
    setSelectedStatus('');
    setSelectedPriority('');
    setAssigneeId('');
    setTransferQueueId('');
    setTransferCategoryId('');
    setTransferAssigneeId('');
    setReopenReason('');
    setFeedbackComment('');
    setRating(0);
    setArticleQuery('');
    setArticleResults([]);
    setSelectedArticleIds([]);
    setArticleSearchError('');
    setArticleSearchBusy(false);
    setPendingAction(null);
  }, []);

  const loadTicket = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setPageError('');
    setActionError('');
    try {
      const [ticketResponse, messagesResponse] = await Promise.all([
        helpdeskService.getTicket(ticketNumber),
        helpdeskService.listMessages(ticketNumber, { limit: 50 }),
      ]);
      if (requestRef.current !== requestId) return;
      const nextTicket = helpdeskData(ticketResponse);
      const nextMessages = Array.isArray(helpdeskData(messagesResponse)) ? helpdeskData(messagesResponse) : [];
      setTicket(nextTicket || null);
      setMessages([...nextMessages].reverse());
      setMessageMeta(helpdeskMeta(messagesResponse));
      setSelectedStatus(String(nextTicket?.status || ''));
      setSelectedPriority(String(nextTicket?.priority || 'normal'));
      setAssigneeId(String(nextTicket?.assignedTo || ''));
      setTransferQueueId(String(nextTicket?.queue?.id || ''));
      setTransferCategoryId(String(nextTicket?.category?.id || ''));

      const optionalCalls = await Promise.allSettled([
        helpdeskService.getTicketSla(ticketNumber),
        helpdeskService.getFeedback(ticketNumber),
        canReadQueueConfig ? helpdeskService.getConfig() : Promise.resolve(null),
        canManageQueues ? helpdeskService.listAdminQueues() : Promise.resolve(null),
      ]);
      if (requestRef.current !== requestId) return;
      const revoked = optionalCalls.find((result) => result.status === 'rejected' && [401, 403, 404].includes(helpdeskErrorStatus(result.reason)));
      if (revoked) {
        clearRestrictedState();
        setPageError(safeHelpdeskError(revoked.reason, 'Your access to this ticket changed.'));
        return;
      }
      setSla(optionalCalls[0].status === 'fulfilled' ? helpdeskData(optionalCalls[0].value) : nextTicket?.sla || null);
      setFeedback(optionalCalls[1].status === 'fulfilled' ? helpdeskFeedback(optionalCalls[1].value) : null);
      setConfig(optionalCalls[2].status === 'fulfilled' ? helpdeskData(optionalCalls[2].value) : null);
      setQueues(optionalCalls[3].status === 'fulfilled' && optionalCalls[3].value ? (helpdeskData(optionalCalls[3].value) || []) : []);
    } catch (requestError) {
      if (requestRef.current !== requestId) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setPageError(safeHelpdeskError(requestError, 'This ticket could not be loaded.'));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [canManageQueues, canReadQueueConfig, clearRestrictedState, ticketNumber]);

  useEffect(() => {
    clearRestrictedState();
    loadTicket();
    return () => {
      requestRef.current += 1;
    };
  }, [clearRestrictedState, loadTicket, user?.id, user?._id, user?.companyId]);

  const loadEarlier = async () => {
    if (!messageMeta?.hasMore || !messageMeta?.nextCursor || loadingEarlier) return;
    setLoadingEarlier(true);
    setMessageError('');
    try {
      const response = await helpdeskService.listMessages(ticketNumber, { limit: 50, cursor: messageMeta.nextCursor });
      const older = Array.isArray(helpdeskData(response)) ? [...helpdeskData(response)].reverse() : [];
      const olderMeta = helpdeskMeta(response);
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [...older.filter((message) => !known.has(message.id)), ...current];
      });
      setMessageMeta(olderMeta);
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        clearRestrictedState();
        setPageError(safeHelpdeskError(requestError, 'Your ticket access changed.'));
      } else {
        setMessageError(safeHelpdeskError(requestError, 'Earlier messages could not be loaded.'));
      }
    } finally {
      setLoadingEarlier(false);
    }
  };

  const transferQueue = queues.find((queue) => String(queue.id) === String(transferQueueId));
  const categoriesForTransfer = useMemo(() =>
    (transferQueue?.categories || []).filter((category) => category.enabled !== false),
  [transferQueue]);
  const agentsForTransfer = useMemo(() => {
    const agentIds = transferQueue?.agents || [];
    if (ticket?.confidential) {
      const permittedIds = new Set(transferQueue?.confidentiality?.agentIds || []);
      return agentIds.filter((id) => permittedIds.has(id));
    }
    return agentIds;
  }, [ticket?.confidential, transferQueue]);

  useEffect(() => {
    if (categoriesForTransfer.length && !categoriesForTransfer.some((category) => String(category.id) === String(transferCategoryId))) {
      setTransferCategoryId(String(categoriesForTransfer[0]?.id || ''));
    }
  }, [categoriesForTransfer, transferCategoryId]);

  const performAction = async (key, operation, successMessage) => {
    setBusyKey(key);
    setActionError('');
    setPendingAction(null);
    try {
      await operation();
      setNotice(successMessage);
      await loadTicket();
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        clearRestrictedState();
        setPageError(safeHelpdeskError(requestError, 'Your access changed.'));
      } else {
        setActionError(safeHelpdeskError(requestError, 'The ticket could not be updated.'));
      }
    } finally {
      setBusyKey('');
    }
  };

  const askForConfirmation = ({ kind, value, title, detail, label }) => {
    setPendingAction({ kind, value, title, detail, label });
  };

  const confirmPendingAction = () => {
    if (!pendingAction) return;
    const { kind, value } = pendingAction;
    if (kind === 'status') {
      performAction('status', () => helpdeskService.updateTicketStatus(ticketNumber, value), 'Ticket status updated.');
    } else if (kind === 'cancel') {
      performAction('cancel', () => helpdeskService.cancelTicket(ticketNumber), 'Ticket cancelled.');
    } else if (kind === 'confirm-resolution') {
      performAction('confirm-resolution', () => helpdeskService.confirmResolution(ticketNumber), 'Resolution confirmed.');
    } else if (kind === 'claim') {
      performAction('claim', () => helpdeskService.claimTicket(ticketNumber), 'Ticket claimed.');
    }
  };

  const changePriority = () => performAction(
    'priority',
    () => helpdeskService.updateTicketPriority(ticketNumber, selectedPriority),
    'Ticket priority updated.',
  );

  const assignTicket = (event) => {
    event.preventDefault();
    const id = assigneeId.trim();
    if (!/^[a-f\d]{24}$/i.test(id)) {
      setActionError('Enter a valid agent identifier provided by your administrator.');
      return;
    }
    performAction('assignment', () => helpdeskService.assignTicket(ticketNumber, id), 'Ticket assignment updated.');
  };

  const transferTicket = (event) => {
    event.preventDefault();
    if (!transferQueueId || !transferCategoryId || String(transferQueueId) === String(ticket?.queue?.id)) {
      setActionError('Choose a different destination queue and an available category.');
      return;
    }
    if (ticket?.status === 'assigned' && !transferAssigneeId) {
      setActionError('Choose an active agent in the destination queue before transferring an assigned ticket.');
      return;
    }
    performAction('transfer', () => helpdeskService.transferTicket(ticketNumber, {
      queueId: transferQueueId,
      categoryId: transferCategoryId,
      ...(transferAssigneeId ? { assigneeId: transferAssigneeId } : {}),
    }), 'Ticket transferred.');
  };

  const handleAttachment = (nextFile) => {
    const result = helpdeskAcceptedAttachment(nextFile);
    if (!result.ok) {
      setAttachmentFile(null);
      setAttachmentError(result.reason);
      return;
    }
    setAttachmentFile(nextFile || null);
    setAttachmentError('');
  };

  const searchRelatedArticles = async () => {
    const search = articleQuery.trim();
    if (search.length < 2) {
      setArticleSearchError('Enter at least two characters to search articles.');
      setArticleResults([]);
      return;
    }
    setArticleSearchBusy(true);
    setArticleSearchError('');
    try {
      const response = await helpdeskService.searchKnowledgeBase({ search, limit: 5, ...(ticket?.queue?.id ? { queueId: ticket.queue.id } : {}) });
      setArticleResults(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []);
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setArticleResults([]);
        setArticleQuery('');
      }
      setArticleSearchError(safeHelpdeskError(requestError, 'Knowledge Base suggestions could not be loaded.'));
    } finally {
      setArticleSearchBusy(false);
    }
  };

  const toggleArticle = (articleId) => {
    setSelectedArticleIds((current) => current.includes(articleId)
      ? current.filter((id) => id !== articleId)
      : current.length < 5 ? [...current, articleId] : current);
  };

  const submitMessage = async (event) => {
    event.preventDefault();
    setMessageError('');
    if (messageType === 'internal' && !internalAcknowledged) {
      setMessageError('Confirm that this note is intended for authorized Helpdesk staff only.');
      return;
    }
    if (!messageBody.trim() && !attachmentFile) {
      setMessageError('Write a reply or choose an attachment.');
      return;
    }
    if (messageBody.trim().length > 4000) {
      setMessageError('Messages are limited to 4,000 characters.');
      return;
    }
    const attachmentCheck = helpdeskAcceptedAttachment(attachmentFile);
    if (!attachmentCheck.ok) {
      setAttachmentError(attachmentCheck.reason);
      return;
    }
    setBusyKey('message');
    try {
      if (attachmentFile) {
        await helpdeskService.uploadAttachment(ticketNumber, {
          file: attachmentFile,
          body: messageBody.trim(),
          messageType,
        });
      } else {
        await helpdeskService.createMessage(ticketNumber, {
          body: messageBody.trim(),
          messageType,
          ...(messageType === 'public' && selectedArticleIds.length ? { relatedArticleIds: selectedArticleIds } : {}),
        });
      }
      setMessageBody('');
      setMessageType('public');
      setInternalAcknowledged(false);
      setAttachmentFile(null);
      setSelectedArticleIds([]);
      setArticleQuery('');
      setArticleResults([]);
      await loadTicket();
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        clearRestrictedState();
        setPageError(safeHelpdeskError(requestError, 'Your ticket access changed.'));
      } else {
        setMessageError(safeHelpdeskError(requestError, 'Your reply could not be sent. Refresh the conversation and try again.'));
      }
    } finally {
      setBusyKey('');
    }
  };

  const downloadAttachment = async (attachment) => {
    setBusyKey(`download-${attachment.attachmentId}`);
    setActionError('');
    try {
      const response = await helpdeskService.downloadAttachment(ticketNumber, attachment.attachmentId);
      const blob = response?.data instanceof Blob ? response.data : new Blob([response?.data || '']);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = String(attachment.fileName || 'helpdesk-attachment').replace(/[\\/\r\n]/g, '_').slice(0, 120);
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        clearRestrictedState();
        setPageError(safeHelpdeskError(requestError, 'Your attachment access changed.'));
      } else {
        setActionError(safeHelpdeskError(requestError, 'The attachment could not be downloaded.'));
      }
    } finally {
      setBusyKey('');
    }
  };

  const submitReopen = (event) => {
    event.preventDefault();
    const reason = reopenReason.trim();
    if (!reason || reason.length > 500) {
      setActionError('Add a reason of 1–500 characters to reopen this request.');
      return;
    }
    performAction('reopen', () => helpdeskService.reopenTicket(ticketNumber, reason), 'Ticket reopened.');
    setReopenReason('');
  };

  const submitFeedback = async (event) => {
    event.preventDefault();
    if (!rating) {
      setActionError('Choose a rating from one to five.');
      return;
    }
    setBusyKey('feedback');
    setActionError('');
    try {
      const response = await helpdeskService.submitFeedback(ticketNumber, { rating, comment: feedbackComment.trim() || undefined });
      setFeedback(helpdeskFeedback(response));
      setNotice('Thank you for your feedback.');
      setFeedbackComment('');
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        clearRestrictedState();
        setPageError(safeHelpdeskError(requestError, 'Your ticket access changed.'));
      } else {
        setActionError(safeHelpdeskError(requestError, 'Your feedback could not be saved.'));
      }
    } finally {
      setBusyKey('');
    }
  };

  if (loading) return <HelpdeskLoading label="Loading ticket and conversation…" />;
  if (pageError) return <HelpdeskError message={pageError} onRetry={loadTicket} />;
  if (!ticket) return <HelpdeskEmpty title="Ticket unavailable" detail="This ticket may have been removed or your access may have changed." action={<Link to="/app/helpdesk" className="inline-flex min-h-9 items-center rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg">Back to Helpdesk</Link>} />;

  const status = String(ticket.status || '').toLowerCase();
  const visibleMessages = canManage ? messages : messages.filter((message) => String(message.messageType || '').toLowerCase() !== 'internal');
  const isRequester = canReadMine && String(ticket.requesterId || '') === String(user?.id || user?._id || '');
  const canReply = canManage && ACTIVE_MESSAGE_STATUSES.has(status);
  const allowedStatusTransitions = canManage ? (HELPDESK_TRANSITIONS[status] || []) : [];
  const canCancel = isRequester && ['open', 'assigned'].includes(status);
  const canConfirm = isRequester && status === 'resolved';
  const canReopen = isRequester && status === 'resolved' && config?.allowEmployeeReopen !== false;
  const canLeaveFeedback = isRequester && ['resolved', 'closed'].includes(status) && !feedback;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to={isRequester ? '/app/helpdesk/tickets' : '/app/helpdesk/workspace'} className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-crewly-border px-3 text-xs font-medium text-crewly-text hover:bg-crewly-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />{isRequester ? 'My tickets' : 'Agent workspace'}</Link>
        <button type="button" onClick={loadTicket} disabled={loading || Boolean(busyKey)} className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-crewly-border px-3 text-xs font-medium text-crewly-text hover:bg-crewly-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Refresh conversation</button>
      </div>

      {notice ? <p className="rounded-lg border border-emerald-300/20 bg-emerald-300/5 px-3 py-2 text-sm text-emerald-100" role="status">{notice}<button type="button" onClick={() => setNotice('')} className="ml-3 text-xs underline">Dismiss</button></p> : null}
      {actionError ? <p className="rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-sm text-rose-100" role="alert">{actionError}</p> : null}

      <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-6" aria-labelledby="ticket-title">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold tracking-wide text-crewly-green">{ticket.ticketNumber}</span><StatusPill status={ticket.status} />{ticket.confidential ? <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[11px] font-semibold text-amber-100"><ShieldAlert className="h-3 w-3" aria-hidden="true" />Confidential</span> : null}</div>
            <h2 id="ticket-title" className="mt-3 break-words text-xl font-semibold">{ticket.subject || ticket.ticketNumber}</h2>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-crewly-dim"><span>Created {helpdeskDateTime(ticket.createdAt)}</span><span>Updated {helpdeskDateTime(ticket.updatedAt)}</span><span>{ticket.queue?.name || 'Queue unavailable'}{ticket.category?.name ? ` · ${ticket.category.name}` : ''}</span></div>
          </div>
          <div className="flex flex-wrap items-center gap-2"><PriorityPill priority={ticket.priority} />{ticket.assignedTo ? <span className="inline-flex items-center gap-1.5 rounded-full border border-crewly-border px-2.5 py-1 text-[11px] text-crewly-dim"><UserRound className="h-3 w-3" aria-hidden="true" />Assigned</span> : null}</div>
        </div>
        {ticket.description ? <div className="mt-5 rounded-xl border border-crewly-border bg-crewly-bg/50 p-4"><h3 className="text-xs font-semibold uppercase tracking-wide text-crewly-dim">Request description</h3><div className="mt-2"><ArticleText>{ticket.description}</ArticleText></div></div> : null}
        {sla ? <div className="mt-4"><HelpdeskSlaSummary sla={sla} /></div> : null}
        {!isRequester && ticket.requesterId ? <p className="mt-4 rounded-lg border border-crewly-border bg-crewly-bg/40 px-3 py-2 text-xs text-crewly-dim">Requester identifier: <code className="break-all text-crewly-text">{ticket.requesterId}</code></p> : null}
      </section>

      {pendingAction ? (
        <section className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4" role="alertdialog" aria-labelledby="helpdesk-confirm-title" aria-describedby="helpdesk-confirm-detail">
          <h3 id="helpdesk-confirm-title" className="text-sm font-semibold text-amber-50">{pendingAction.title}</h3>
          <p id="helpdesk-confirm-detail" className="mt-1 text-xs leading-5 text-amber-50/80">{pendingAction.detail}</p>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => setPendingAction(null)} className="min-h-9 rounded-lg border border-amber-100/20 px-3 text-xs font-semibold text-amber-50 hover:bg-amber-50/10">Go back</button><button type="button" onClick={confirmPendingAction} disabled={Boolean(busyKey)} className="min-h-9 rounded-lg bg-amber-200 px-3 text-xs font-semibold text-slate-950 disabled:opacity-50">{busyKey ? 'Working…' : (pendingAction.label || 'Confirm')}</button></div>
        </section>
      ) : null}

      {canManage ? (
        <section className="grid gap-3 rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Agent ticket controls">
          <div className="rounded-xl border border-crewly-border bg-crewly-bg/40 p-3">
            <label className={labelClass}>Change status<select value={selectedStatus} onChange={(event) => setSelectedStatus(event.target.value)} className={fieldClass}><option value={status}>{status.replaceAll('_', ' ')}</option>{allowedStatusTransitions.map((nextStatus) => <option key={nextStatus} value={nextStatus}>{nextStatus.replaceAll('_', ' ')}</option>)}</select></label>
            <button type="button" disabled={!selectedStatus || selectedStatus === status || Boolean(busyKey)} onClick={() => askForConfirmation({ kind: 'status', value: selectedStatus, title: `Move ticket to ${selectedStatus.replaceAll('_', ' ')}?`, detail: 'This updates the backend-authoritative ticket status and may notify authorized participants.', label: 'Confirm status change' })} className="mt-2 min-h-9 w-full rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-card disabled:opacity-40">Save status</button>
          </div>
          <div className="rounded-xl border border-crewly-border bg-crewly-bg/40 p-3">
            <label className={labelClass}>Priority<select value={selectedPriority} onChange={(event) => setSelectedPriority(event.target.value)} className={fieldClass}>{HELPDESK_PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}</select></label>
            <button type="button" disabled={selectedPriority === ticket.priority || Boolean(busyKey)} onClick={changePriority} className="mt-2 min-h-9 w-full rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-card disabled:opacity-40">Update priority</button>
          </div>
          <div className="rounded-xl border border-crewly-border bg-crewly-bg/40 p-3">
            <p className={labelClass}>Assignment</p>
            {ticket.assignedTo ? <p className="mt-1 break-all text-[11px] text-crewly-dim">Current agent ID: <code className="text-crewly-text">{ticket.assignedTo}</code></p> : <p className="mt-1 text-[11px] text-crewly-dim">No agent is currently assigned.</p>}
            {!ticket.assignedTo ? <button type="button" disabled={Boolean(busyKey)} onClick={() => askForConfirmation({ kind: 'claim', title: 'Claim this ticket?', detail: 'The server will verify that you are an authorized agent for this queue before assigning it.', label: 'Claim ticket' })} className="mt-2 min-h-9 w-full rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950 disabled:opacity-50">Claim for me</button> : null}
            <form onSubmit={assignTicket} className="mt-3 space-y-2"><label className={labelClass}>Agent identifier<input value={assigneeId} onChange={(event) => setAssigneeId(event.target.value.slice(0, 24))} maxLength={24} className={fieldClass} placeholder="24-character ID" /></label><button type="submit" disabled={Boolean(busyKey)} className="min-h-9 w-full rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-card disabled:opacity-50">Assign</button></form>
          </div>
          {canManageQueues && queues.length ? (
            <div className="rounded-xl border border-crewly-border bg-crewly-bg/40 p-3">
              <form onSubmit={transferTicket} className="space-y-2">
                <p className="text-xs font-semibold text-crewly-text">Transfer ticket</p>
                <label className={labelClass}>Queue<select value={transferQueueId} onChange={(event) => { setTransferQueueId(event.target.value); setTransferCategoryId(''); setTransferAssigneeId(''); }} className={fieldClass}><option value={ticket.queue?.id} disabled>{ticket.queue?.name || 'Current queue'} (current)</option>{queues.filter((queue) => String(queue.id) !== String(ticket.queue?.id)).map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}</select></label>
                <label className={labelClass}>Category<select value={transferCategoryId} onChange={(event) => setTransferCategoryId(event.target.value)} className={fieldClass} disabled={!categoriesForTransfer.length}>{categoriesForTransfer.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
                <label className={labelClass}>Destination agent<select value={transferAssigneeId} onChange={(event) => setTransferAssigneeId(event.target.value)} className={fieldClass}><option value="">Keep unassigned</option>{agentsForTransfer.map((agentId) => <option key={agentId} value={agentId}>{agentId}</option>)}</select><span className="mt-1 block text-[10px] text-crewly-dim">Only agent identifiers returned for this queue are listed.</span></label>
                <button type="submit" disabled={Boolean(busyKey) || !transferQueueId || !transferCategoryId || String(transferQueueId) === String(ticket.queue?.id)} className="min-h-9 w-full rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-card disabled:opacity-50">Transfer</button>
              </form>
            </div>
          ) : null}
        </section>
      ) : null}

      {(canCancel || canConfirm || canReopen || canLeaveFeedback) ? (
        <section className="grid gap-3 lg:grid-cols-2" aria-label="Requester ticket actions">
          {canCancel ? <div className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">Cancel this request</h3><p className="mt-1 text-xs leading-5 text-crewly-dim">Cancellation is available while the request is open or assigned.</p><button type="button" onClick={() => askForConfirmation({ kind: 'cancel', title: 'Cancel this ticket?', detail: 'This action changes the ticket to cancelled and cannot be undone from this page.', label: 'Cancel ticket' })} className="mt-3 min-h-9 rounded-lg border border-rose-300/20 px-3 text-xs font-semibold text-rose-100 hover:bg-rose-300/10">Cancel ticket</button></div> : null}
          {canConfirm ? <div className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">Was your issue resolved?</h3><p className="mt-1 text-xs leading-5 text-crewly-dim">Confirming closes the request. You can leave feedback after resolution.</p><button type="button" onClick={() => askForConfirmation({ kind: 'confirm-resolution', title: 'Confirm the resolution?', detail: 'This closes the ticket as requester-confirmed. You can still submit feedback after confirmation.', label: 'Confirm resolution' })} className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Confirm resolution</button></div> : null}
          {canReopen ? <form onSubmit={submitReopen} className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">Reopen this request</h3><p className="mt-1 text-xs leading-5 text-crewly-dim">The backend checks the tenant policy and reopening window before changing the ticket.</p><label className={`${labelClass} mt-3`}>Reason<textarea value={reopenReason} onChange={(event) => setReopenReason(event.target.value.slice(0, 500))} maxLength={500} rows={3} className={textareaClass} placeholder="What still needs attention?" /></label><button type="submit" disabled={Boolean(busyKey)} className="mt-3 min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-50">Submit reopen request</button></form> : null}
          {canLeaveFeedback ? <form onSubmit={submitFeedback} className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">Rate your support experience</h3><p className="mt-1 text-xs text-crewly-dim">Your rating is optional and can be submitted once for this resolved request.</p><div className="mt-3 flex gap-1" role="group" aria-label="Satisfaction rating from one to five">
            {[1, 2, 3, 4, 5].map((value) => <button key={value} type="button" onClick={() => setRating(value)} aria-label={`Rate ${value} out of 5`} aria-pressed={rating === value} className={`flex h-10 w-10 items-center justify-center rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green ${rating >= value ? 'border-amber-300/40 bg-amber-300/10 text-amber-200' : 'border-crewly-border text-crewly-dim hover:bg-crewly-bg'}`}><Star className="h-4 w-4" aria-hidden="true" fill={rating >= value ? 'currentColor' : 'none'} /></button>)}
          </div><label className={`${labelClass} mt-3`}>Comment <span className="font-normal">(optional)</span><textarea value={feedbackComment} onChange={(event) => setFeedbackComment(event.target.value.slice(0, 1000))} maxLength={1000} rows={3} className={textareaClass} placeholder="Share any additional feedback" /></label><button type="submit" disabled={Boolean(busyKey)} className="mt-3 min-h-9 rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950 disabled:opacity-50">{busyKey === 'feedback' ? 'Submitting…' : 'Submit feedback'}</button></form> : null}
        </section>
      ) : null}
      {feedback ? <p className="rounded-lg border border-emerald-300/20 bg-emerald-300/5 px-3 py-2 text-xs text-emerald-100" role="status">Feedback received: {feedback.rating}/5{feedback.submittedAt ? ` · ${helpdeskDateTime(feedback.submittedAt)}` : ''}</p> : null}

      <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-6" aria-labelledby="conversation-title">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><MessageCircle className="h-4 w-4 text-crewly-green" aria-hidden="true" /><h3 id="conversation-title" className="text-base font-semibold">Conversation</h3></div><span className="text-xs text-crewly-dim">{visibleMessages.length} message{visibleMessages.length === 1 ? '' : 's'} loaded</span></div>
        {messageMeta?.hasMore ? <div className="mt-4 text-center"><button type="button" onClick={loadEarlier} disabled={loadingEarlier} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-50">{loadingEarlier ? 'Loading…' : 'Load earlier messages'}</button></div> : null}
        {messageError ? <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-100" role="alert">{messageError}</p> : null}
        {!visibleMessages.length ? <div className="mt-4"><HelpdeskEmpty icon={MessageCircle} title="No conversation messages" detail="The original request description appears above. Replies will appear here." /></div> : null}
        <div className="mt-4 space-y-3">
          {visibleMessages.map((message) => {
            const internal = String(message.messageType || '').toLowerCase() === 'internal';
            return (
              <article key={message.id} className={`rounded-xl border p-3 sm:p-4 ${internal ? 'border-amber-300/25 bg-amber-300/5' : message.author?.type === 'requester' ? 'border-crewly-green/20 bg-crewly-green/[0.035]' : 'border-crewly-border bg-crewly-bg/35'}`}>
                <header className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 text-xs"><span className="font-semibold text-crewly-text">{message.author?.displayName || (message.author?.type === 'requester' ? 'Requester' : 'Helpdesk')}</span>{internal ? <span className="rounded-full border border-amber-300/30 px-2 py-0.5 text-[10px] font-semibold text-amber-100">Internal note</span> : null}</div><time className="text-[10px] text-crewly-dim">{helpdeskDateTime(message.createdAt)}</time></header>
                {message.body ? <div className="mt-2"><ArticleText>{message.body}</ArticleText></div> : null}
                {message.attachments?.length ? <div className="mt-3 flex flex-wrap gap-2">{message.attachments.map((attachment) => <AttachmentButton key={attachment.attachmentId} attachment={attachment} onDownload={downloadAttachment} busy={busyKey === `download-${attachment.attachmentId}`} />)}</div> : null}
                {message.knowledgeBaseArticles?.length ? <div className="mt-3 rounded-lg border border-crewly-border/70 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-crewly-dim">Suggested articles</p><ul className="mt-1 space-y-1">{message.knowledgeBaseArticles.map((article) => <li key={article.id}><Link to={`/app/helpdesk/knowledge-base/articles/${encodeURIComponent(article.slug)}`} className="text-xs font-medium text-crewly-green hover:underline">{article.title}</Link></li>)}</ul></div> : null}
              </article>
            );
          })}
        </div>

        {canReply ? (
          <form onSubmit={submitMessage} className="mt-5 border-t border-crewly-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="text-sm font-semibold">Reply to this ticket</h4><p className="mt-1 text-[11px] text-crewly-dim">Only authorized participants can read or update this conversation.</p></div><label className={labelClass}>Message type<select value={messageType} onChange={(event) => { setMessageType(event.target.value); setInternalAcknowledged(false); setSelectedArticleIds([]); }} className="mt-1 min-h-9 rounded-lg border border-crewly-border bg-crewly-bg px-2.5 text-xs text-crewly-text"><option value="public">Public reply</option><option value="internal">Internal note</option></select></label></div>
            {messageType === 'internal' ? <div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/5 p-3"><div className="flex items-start gap-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" /><div><p className="text-xs font-semibold text-amber-100">Staff-only note</p><p className="mt-1 text-[11px] leading-5 text-amber-100/80">This note is not visible to the requester. Do not put passwords, one-time codes, or credentials here.</p></div></div><label className="mt-3 flex items-start gap-2 text-xs text-amber-50"><input type="checkbox" checked={internalAcknowledged} onChange={(event) => setInternalAcknowledged(event.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-300 focus-visible:ring-2 focus-visible:ring-amber-200" />I confirm this content is intended for authorized Helpdesk staff only.</label></div> : null}
            <label className="sr-only" htmlFor="helpdesk-message-body">Message</label><textarea id="helpdesk-message-body" value={messageBody} onChange={(event) => setMessageBody(event.target.value.slice(0, 4000))} maxLength={4000} rows={4} className={`${textareaClass} mt-3`} placeholder={messageType === 'internal' ? 'Write a staff-only note…' : 'Write a public reply…'} />
            <div className="mt-1 flex justify-between text-[10px] text-crewly-dim"><span>Plain text only · up to 4,000 characters</span><span>{messageBody.length}/4000</span></div>
            {messageType === 'public' && canReadKb ? <div className="mt-3 rounded-lg border border-crewly-border p-3"><p className="text-xs font-semibold">Attach a published article reference</p><p className="mt-1 text-[10px] text-crewly-dim">The server rechecks article audience and queue access before storing references.</p><div role="search" className="mt-2 flex gap-2"><label className="sr-only" htmlFor="helpdesk-related-article-search">Search articles to attach</label><input id="helpdesk-related-article-search" value={articleQuery} onChange={(event) => setArticleQuery(event.target.value.slice(0, 80))} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); searchRelatedArticles(); } }} maxLength={80} className="min-h-9 min-w-0 flex-1 rounded-lg border border-crewly-border bg-crewly-bg px-3 text-xs text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20" placeholder="Search published articles" /><button type="button" onClick={searchRelatedArticles} disabled={articleSearchBusy} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-semibold disabled:opacity-50">{articleSearchBusy ? 'Searching…' : 'Search'}</button></div>{articleSearchError ? <p className="mt-2 text-xs text-rose-200" role="alert">{articleSearchError}</p> : null}{articleResults.length ? <div className="mt-2 flex flex-wrap gap-2">{articleResults.map((article) => <button key={article.id} type="button" onClick={() => toggleArticle(article.id)} aria-pressed={selectedArticleIds.includes(article.id)} className={`rounded-lg border px-2.5 py-2 text-left text-xs ${selectedArticleIds.includes(article.id) ? 'border-crewly-green/50 bg-crewly-green/10 text-crewly-text' : 'border-crewly-border text-crewly-dim hover:bg-crewly-bg'}`}>{article.title}{selectedArticleIds.includes(article.id) ? ' · Selected' : ''}</button>)}</div> : null}{selectedArticleIds.length ? <p className="mt-2 text-[10px] text-crewly-dim">{selectedArticleIds.length}/5 article references selected.</p> : null}</div> : null}
            {config?.attachmentsEnabled ? <div className="mt-3"><label className={labelClass} htmlFor="helpdesk-reply-file">Attachment <span className="font-normal">(optional, up to 10 MB)</span></label><div className="mt-1 flex flex-wrap items-center gap-2"><input id="helpdesk-reply-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => handleAttachment(event.target.files?.[0] || null)} className="min-w-0 flex-1 text-xs text-crewly-dim file:mr-2 file:min-h-8 file:rounded-lg file:border-0 file:bg-crewly-bg file:px-3 file:text-xs file:font-semibold file:text-crewly-text" />{attachmentFile ? <span className="inline-flex items-center gap-1 text-xs text-crewly-text"><Paperclip className="h-3.5 w-3.5" aria-hidden="true" />{attachmentFile.name}</span> : null}</div>{attachmentError ? <p className="mt-1 text-xs text-rose-200" role="alert">{attachmentError}</p> : null}</div> : null}
            {messageError ? <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-100" role="alert">{messageError}</p> : null}
            <div className="mt-3 flex justify-end"><button type="submit" disabled={Boolean(busyKey) || (messageType === 'internal' && !internalAcknowledged)} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-crewly-green px-4 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"><Send className="h-4 w-4" aria-hidden="true" />{busyKey === 'message' ? 'Sending…' : 'Send reply'}</button></div>
          </form>
        ) : ticket && canManage && !ACTIVE_MESSAGE_STATUSES.has(status) ? <p className="mt-5 rounded-lg border border-crewly-border bg-crewly-bg/40 p-3 text-xs text-crewly-dim" role="status">This ticket is not accepting new conversation messages in its current state.</p> : null}
      </section>
    </div>
  );
};

export default HelpdeskTicketDetailPage;
