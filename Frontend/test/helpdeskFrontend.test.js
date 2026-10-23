import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  HELPDESK_PRIORITIES,
  HELPDESK_STATUSES,
  HELPDESK_TRANSITIONS,
  helpdeskAcceptedAttachment,
  helpdeskCanTransition,
  helpdeskData,
  helpdeskDateOnly,
  helpdeskDateTime,
  helpdeskErrorStatus,
  helpdeskMeta,
  nextUtcDate,
  safeHelpdeskError,
} from '../src/pages/helpdesk/helpdeskFormat.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const ROUTES = read('src/routes/AppRoutes.jsx');
const ROUTER = read('src/pages/helpdesk/HelpdeskRouter.jsx');
const SHELL = read('src/pages/helpdesk/HelpdeskShell.jsx');
const HOME = read('src/pages/helpdesk/HelpdeskHomePage.jsx');
const TICKETS = read('src/pages/helpdesk/HelpdeskTicketsPage.jsx');
const CREATE = read('src/pages/helpdesk/HelpdeskTicketCreatePage.jsx');
const DETAIL = read('src/pages/helpdesk/HelpdeskTicketDetailPage.jsx');
const AGENT = read('src/pages/helpdesk/HelpdeskAgentWorkspacePage.jsx');
const KB_PAGE = read('src/pages/helpdesk/HelpdeskKnowledgeBasePage.jsx');
const KB_ARTICLE = read('src/pages/helpdesk/HelpdeskKnowledgeArticlePage.jsx');
const KB_ADMIN = read('src/pages/helpdesk/HelpdeskKnowledgeBaseAdminPage.jsx');
const QUEUE_ADMIN = read('src/pages/helpdesk/HelpdeskQueueAdminPage.jsx');
const ADMIN = read('src/pages/helpdesk/HelpdeskAdminPage.jsx');
const ANALYTICS = read('src/pages/helpdesk/HelpdeskAnalyticsPage.jsx');
const API = read('src/services/helpdeskService.js');
const WORKSPACE_API = read('src/services/helpdeskWorkspaceService.js');
const UI = read('src/components/helpdesk/HelpdeskUi.jsx');
const APP_LAYOUT = read('src/layout/AppLayout.jsx');
const SIDEBAR = read('src/layout/SidebarNav.jsx');
const HELP_DESK_SOURCES = [
  ROUTER, SHELL, HOME, TICKETS, CREATE, DETAIL, AGENT, KB_PAGE, KB_ARTICLE,
  KB_ADMIN, QUEUE_ADMIN, ADMIN, ANALYTICS, API, WORKSPACE_API,
];

test('format helpers expose the backend lifecycle and keep terminal states closed', () => {
  assert.deepEqual(HELPDESK_STATUSES, [
    'open', 'assigned', 'in_progress', 'waiting_for_employee',
    'waiting_for_department', 'resolved', 'closed', 'cancelled',
  ]);
  assert.deepEqual(HELPDESK_PRIORITIES, ['low', 'normal', 'high', 'urgent']);
  assert.deepEqual(HELPDESK_TRANSITIONS.closed, []);
  assert.deepEqual(HELPDESK_TRANSITIONS.cancelled, []);
  assert.equal(helpdeskCanTransition('in_progress', 'resolved'), true);
  assert.equal(helpdeskCanTransition('closed', 'in_progress'), false);
  assert.equal(helpdeskCanTransition('unknown', 'open'), false);
});

test('API errors are reduced to safe user messages instead of server details', () => {
  assert.equal(helpdeskErrorStatus({ response: { status: 403 } }), 403);
  const denied = safeHelpdeskError({
    response: { status: 403, data: { message: 'Confidential ticket subject' } },
  });
  assert.match(denied, /access changed/i);
  assert.doesNotMatch(denied, /Confidential ticket subject/);
  assert.match(safeHelpdeskError({ response: { status: 413 } }), /10 MB/);
  assert.match(safeHelpdeskError({ code: 'ECONNABORTED' }), /too long/i);
});

test('response helpers unwrap API data and pagination metadata', () => {
  const response = { data: { success: true, data: [{ id: 'a' }], meta: { nextCursor: 'next' } } };
  assert.deepEqual(helpdeskData(response), [{ id: 'a' }]);
  assert.deepEqual(helpdeskMeta(response), { nextCursor: 'next' });
  assert.equal(helpdeskData({ data: { id: 'b' } }).id, 'b');
  const unwrappedConfig = { enabled: true, allowEmployeeTickets: true };
  assert.deepEqual(helpdeskData(unwrappedConfig), unwrappedConfig);
  const unwrappedPage = { data: [{ id: 'c' }], meta: { total: 1 } };
  assert.deepEqual(helpdeskData(unwrappedPage), [{ id: 'c' }]);
  assert.deepEqual(helpdeskMeta(unwrappedPage), { total: 1 });
  assert.equal(helpdeskMeta({}), null);
});

test('date helpers reject invalid input and advance UTC date boundaries', () => {
  assert.equal(helpdeskDateTime('not-a-date'), '—');
  assert.equal(helpdeskDateOnly(''), '—');
  assert.equal(nextUtcDate('2024-02-28'), '2024-02-29');
  assert.equal(nextUtcDate('2024-02-29'), '2024-03-01');
  assert.equal(nextUtcDate('2024-02-30'), '');
  assert.equal(nextUtcDate('2024-2-01'), '');
});

test('attachment preflight enforces size and supported type hints', () => {
  assert.deepEqual(helpdeskAcceptedAttachment(null), { ok: true, reason: '' });
  assert.equal(helpdeskAcceptedAttachment({ name: 'guide.pdf', type: 'application/pdf', size: 10_000 }).ok, true);
  assert.equal(helpdeskAcceptedAttachment({ name: 'photo.JPEG', type: '', size: 100 }).ok, true);
  assert.match(helpdeskAcceptedAttachment({ name: 'large.pdf', type: 'application/pdf', size: 10 * 1024 * 1024 + 1 }).reason, /10 MB/);
  assert.equal(helpdeskAcceptedAttachment({ name: 'program.exe', type: 'application/pdf', size: 100 }).ok, false);
  assert.equal(helpdeskAcceptedAttachment({ name: '', type: '', size: 100 }).ok, false);
  assert.equal(helpdeskAcceptedAttachment({ name: 'image.png', type: 'image/png', size: Number.NaN }).ok, false);
});

test('Helpdesk routes are lazy-loaded inside the authenticated app route tree', () => {
  assert.match(ROUTES, /const HelpdeskRouter = lazy\(\(\) => import\("\.\.\/pages\/helpdesk\/HelpdeskRouter\.jsx"\)\)/);
  assert.match(ROUTES, /path="helpdesk\/\*"[\s\S]{0,120}<HelpdeskRouter\s*\/>/);
  assert.match(APP_LAYOUT, /'HELPDESK_TICKET_READ_SELF'/);
  assert.match(APP_LAYOUT, /'HELPDESK_KB_MANAGE'/);
  assert.match(SIDEBAR, /id: "support",\s*label: "Support"/);
});

test('Helpdesk router guards employee, agent, queue, and Knowledge Base routes independently', () => {
  assert.match(ROUTER, /<RequirePermission any=\{AVAILABLE_PERMISSIONS\}>/);
  assert.match(ROUTER, /permission="HELPDESK_TICKET_READ_SELF"/);
  assert.match(ROUTER, /permission="HELPDESK_TICKET_CREATE_SELF"/);
  assert.match(ROUTER, /permission="HELPDESK_TICKET_READ"/);
  assert.match(ROUTER, /permission="HELPDESK_QUEUE_MANAGE"/);
  assert.match(ROUTER, /permission="HELPDESK_KB_MANAGE"/);
  assert.match(ROUTER, /any=\{\['HELPDESK_TICKET_READ_SELF', 'HELPDESK_TICKET_READ'\]\}/);
});

test('router remounts Helpdesk state when the authenticated user or company changes', () => {
  assert.match(ROUTER, /const identityKey = \[user\?\.id \|\| user\?\._id/);
  assert.match(ROUTER, /user\?\.companyId\?\._id \|\| user\?\.companyId/);
  assert.match(ROUTER, /<div key=\{identityKey\}>/);
});

test('employee shortcuts and ticket lists are permission-scoped and self-service labelled', () => {
  assert.match(HOME, /hasPermission\('HELPDESK_TICKET_CREATE_SELF'\)/);
  assert.match(TICKETS, /Only your own requests are shown here\./);
  assert.match(TICKETS, /listMyTickets\(params\)/);
  assert.match(ROUTER, /permission="HELPDESK_TICKET_READ_SELF"/);
});

test('ticket service uses tenant-relative routes without accepting client tenant or actor ids', () => {
  assert.match(API, /const ROOT = '\/helpdesk';/);
  assert.match(API, /createTicket: \(payload\) => api\.post\(`\$\{ROOT\}\/tickets`, payload\)/);
  assert.match(API, /listMyTickets: \(params = \{\}\) => api\.get\(`\$\{ROOT\}\/tickets\/mine`/);
  assert.doesNotMatch(API, /https?:\/\/|localhost|127\.0\.0\.1/);
  assert.doesNotMatch(API, /api\.get\([^\n]*(companyId|requesterId|actorId)/);
});

test('attachment upload and download use private API requests, not stored URLs', () => {
  assert.match(API, /const form = new FormData\(\)/);
  assert.match(API, /form\.append\('file', file\)/);
  assert.match(API, /multipart\/form-data/);
  assert.match(API, /responseType: 'blob'/);
  assert.match(DETAIL, /URL\.createObjectURL\(blob\)/);
  assert.match(DETAIL, /URL\.revokeObjectURL\(url\)/);
  assert.doesNotMatch(DETAIL, /window\.open\(/);
});

test('new ticket creation clears sensitive form state after a successful create and prevents resubmission', () => {
  assert.match(CREATE, /if \(createdTicket\) return/);
  assert.match(CREATE, /setCreatedTicket\(ticket \|\| \{\}\);\s*clearSensitiveForm\(\);/);
  assert.match(CREATE, /uploadAttachment\(ticketNumber, \{ file: submittedFile, body: '', messageType: 'public' \}\)/);
  assert.match(CREATE, /setDescription\(''\)/);
  assert.match(CREATE, /ticket description and attachment selection were cleared from this form/i);
  assert.match(CREATE, /if \(\[401, 403, 404\]\.includes\(helpdeskErrorStatus\(requestError\)\)\) clearRestrictedState\(\)/);
});

test('ticket detail clears restricted ticket, conversation, draft, and attachment state', () => {
  const clearBlock = DETAIL.slice(DETAIL.indexOf('const clearRestrictedState'), DETAIL.indexOf('const loadTicket'));
  for (const marker of [
    'requestRef.current += 1', 'setTicket(null)', 'setMessages([])', 'setMessageBody(\'\')',
    'setAttachmentFile(null)', 'setFeedbackComment(\'\')', 'setTransferAssigneeId(\'\')',
  ]) assert.ok(clearBlock.includes(marker), `restricted-state clearing must include ${marker}`);
  assert.match(DETAIL, /clearRestrictedState\(\);\s*setPageError\(safeHelpdeskError/);
});

test('requester conversations defensively hide internal notes and only agents can reply', () => {
  assert.match(DETAIL, /const visibleMessages = canManage \? messages : messages\.filter/);
  assert.match(DETAIL, /message\.messageType \|\| ''\)\.toLowerCase\(\) !== 'internal'/);
  assert.match(DETAIL, /const canReply = canManage && ACTIVE_MESSAGE_STATUSES\.has\(status\)/);
  assert.match(DETAIL, /messageType === 'internal' && !internalAcknowledged/);
  assert.match(DETAIL, /Internal note/);
});

test('Helpdesk components do not persist ticket bodies, internal notes, or attachments in browser storage', () => {
  const appSources = [...HELP_DESK_SOURCES, UI].join('\n');
  assert.doesNotMatch(appSources, /\b(localStorage|sessionStorage|indexedDB)\b/);
  assert.doesNotMatch(appSources, /dangerouslySetInnerHTML/);
  assert.match(UI, /whitespace-pre-wrap break-words/);
});

test('agent queue selector is explicitly not treated as proof of ticket membership', () => {
  assert.match(AGENT, /listAdminQueues\(\).*listQueues\(\)/s);
  assert.match(AGENT, /The queue directory is only a selector/);
  assert.match(AGENT, /listAssignedTickets\(queueId, params\)/);
  assert.match(AGENT, /\[401, 403, 404\]\.includes\(helpdeskErrorStatus\(requestError\)\)/);
});

test('queue and SLA writes are reviewed before being sent', () => {
  assert.match(QUEUE_ADMIN, /setConfirmingQueue\(true\)/);
  assert.match(QUEUE_ADMIN, /Review access and queue changes/);
  assert.match(QUEUE_ADMIN, /Confirm and save/);
  assert.match(QUEUE_ADMIN, /updateQueueSlaPolicy\(selectedId, payload\)/);
  assert.doesNotMatch(QUEUE_ADMIN, /expectedVersion:\s*selectedQueue/);
});

test('tenant-wide sensitive settings require an explicit confirmation step', () => {
  assert.match(ADMIN, /onSubmit=\{reviewSave\}/);
  assert.match(ADMIN, /Confidential ticket access is changing/);
  assert.match(ADMIN, /role="alertdialog"/);
  assert.match(ADMIN, /Confirm and save settings/);
  assert.match(ADMIN, /updateConfig\(/);
});

test('Knowledge Base drafts, publication, and revision restoration use current-version compare-and-swap', () => {
  assert.match(KB_ADMIN, /expectedVersion:\s*category\.version/);
  assert.match(KB_ADMIN, /expectedVersion:\s*selectedArticle\.version/);
  assert.match(KB_ADMIN, /restoreKnowledgeBaseRevision\(selectedArticle\.id, revision, selectedArticle\.version\)/);
  assert.match(KB_ADMIN, /const canPublish = hasPermission\('HELPDESK_KB_PUBLISH'\)/);
  assert.match(KB_ADMIN, /selectedArticle\.status !== 'archived' && canPublish/);
  assert.match(API, /publishKnowledgeBaseArticle: \(articleId, expectedVersion\)/);
});

test('Knowledge Base revision failures clear restricted article and revision data', () => {
  assert.match(KB_ADMIN, /const clearRestrictedState = useCallback/);
  assert.match(KB_ADMIN, /setSelectedArticle\(null\)/);
  assert.match(KB_ADMIN, /setSelectedRevision\(null\)/);
  assert.match(KB_ADMIN, /listKnowledgeBaseRevisions\(articleId, \{ limit: 20 \}\)/);
  assert.match(KB_ADMIN, /if \(\[401, 403, 404\]\.includes\(helpdeskErrorStatus\(requestError\)\)\) clearRestrictedState\(\)/);
  assert.match(KB_ARTICLE, /requestRef\.current !== requestId/);
});

test('analytics only submits supported date and bounded pagination filters', () => {
  assert.match(ANALYTICS, /return \{ from: start\.toISOString\(\), to: end\.toISOString\(\), page: 1, limit: 50 \}/);
  assert.doesNotMatch(ANALYTICS, /params\.(status|priority|categoryId|agentId)\s*=/);
  assert.match(WORKSPACE_API, /getAnalyticsOverview: \(params = \{\}\)/);
  assert.match(WORKSPACE_API, /getQueueAnalytics: \(queueId, params = \{\}\)/);
  assert.match(WORKSPACE_API, /getKnowledgeBaseUsage: \(params = \{\}\)/);
});

test('optional analytics reports fail independently of the authorized overview', () => {
  assert.match(ANALYTICS, /Promise\.all\(jobs\.map\(async/);
  assert.match(ANALYTICS, /queueReportError/);
  assert.match(ANALYTICS, /agentReportError/);
  assert.match(ANALYTICS, /kbReportError/);
  assert.match(ANALYTICS, /This aggregate report could not be loaded/);
});

test('Helpdesk does not open extra realtime connections or fabricate mutation events', () => {
  const source = HELP_DESK_SOURCES.join('\n');
  assert.doesNotMatch(source, /socket\.io-client|new WebSocket|new EventSource|setInterval\(/);
});

test('Helpdesk page surfaces loading, error, and accessibility semantics', () => {
  assert.match(UI, /role="status" aria-live="polite"/);
  assert.match(UI, /role="alert"/);
  assert.match(TICKETS, /aria-label="Filter your tickets"/);
  assert.match(AGENT, /role="tablist" aria-label="Ticket view"/);
  assert.match(QUEUE_ADMIN, /scope="col"/);
  assert.match(DETAIL, /aria-labelledby="conversation-title"/);
  assert.match(SHELL, /overflow-x-auto/);
});

test('published Knowledge Base articles render as plain text, not raw HTML', () => {
  assert.match(KB_ARTICLE, /<ArticleText>\{article\.body\}<\/ArticleText>/);
  assert.match(UI, /export const ArticleText/);
  assert.doesNotMatch(KB_ARTICLE + UI, /dangerouslySetInnerHTML/);
});
