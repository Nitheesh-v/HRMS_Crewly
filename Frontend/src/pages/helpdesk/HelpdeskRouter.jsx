import { Navigate, Route, Routes } from 'react-router-dom';
import RequirePermission from '../../routes/RequirePermission.jsx';
import useAuth from '../../hooks/useAuth.jsx';
import HelpdeskShell from './HelpdeskShell.jsx';
import HelpdeskHomePage from './HelpdeskHomePage.jsx';
import HelpdeskTicketsPage from './HelpdeskTicketsPage.jsx';
import HelpdeskTicketCreatePage from './HelpdeskTicketCreatePage.jsx';
import HelpdeskTicketDetailPage from './HelpdeskTicketDetailPage.jsx';
import HelpdeskAgentWorkspacePage from './HelpdeskAgentWorkspacePage.jsx';
import HelpdeskKnowledgeBasePage from './HelpdeskKnowledgeBasePage.jsx';
import HelpdeskKnowledgeArticlePage from './HelpdeskKnowledgeArticlePage.jsx';
import HelpdeskAnalyticsPage from './HelpdeskAnalyticsPage.jsx';
import HelpdeskQueueAdminPage from './HelpdeskQueueAdminPage.jsx';
import HelpdeskAdminPage from './HelpdeskAdminPage.jsx';
import HelpdeskKnowledgeBaseAdminPage from './HelpdeskKnowledgeBaseAdminPage.jsx';

const AVAILABLE_PERMISSIONS = [
  'HELPDESK_TICKET_READ_SELF',
  'HELPDESK_TICKET_CREATE_SELF',
  'HELPDESK_TICKET_READ',
  'HELPDESK_TICKET_MANAGE',
  'HELPDESK_QUEUE_READ',
  'HELPDESK_QUEUE_MANAGE',
  'HELPDESK_KB_READ',
  'HELPDESK_KB_MANAGE',
  'HELPDESK_KB_PUBLISH',
];

const HelpdeskRouter = () => {
  const { user } = useAuth();
  const identityKey = [user?.id || user?._id || '', user?.companyId?._id || user?.companyId || ''].join(':');

  return (
    <div key={identityKey}>
      <RequirePermission any={AVAILABLE_PERMISSIONS}>
        <Routes>
          <Route element={<HelpdeskShell />}>
            <Route index element={<HelpdeskHomePage />} />
            <Route
              path="tickets"
              element={<RequirePermission permission="HELPDESK_TICKET_READ_SELF"><HelpdeskTicketsPage /></RequirePermission>}
            />
            <Route
              path="tickets/new"
              element={<RequirePermission permission="HELPDESK_TICKET_CREATE_SELF"><HelpdeskTicketCreatePage /></RequirePermission>}
            />
            <Route
              path="tickets/:ticketNumber"
              element={<RequirePermission any={['HELPDESK_TICKET_READ_SELF', 'HELPDESK_TICKET_READ']}><HelpdeskTicketDetailPage /></RequirePermission>}
            />
            <Route
              path="workspace"
              element={<RequirePermission permission="HELPDESK_TICKET_READ"><HelpdeskAgentWorkspacePage /></RequirePermission>}
            />
            <Route
              path="knowledge-base"
              element={<RequirePermission permission="HELPDESK_KB_READ"><HelpdeskKnowledgeBasePage /></RequirePermission>}
            />
            <Route
              path="knowledge-base/articles/:slug"
              element={<RequirePermission permission="HELPDESK_KB_READ"><HelpdeskKnowledgeArticlePage /></RequirePermission>}
            />
            <Route
              path="analytics"
              element={<RequirePermission permission="HELPDESK_TICKET_READ"><HelpdeskAnalyticsPage /></RequirePermission>}
            />
            <Route
              path="queues"
              element={<RequirePermission permission="HELPDESK_QUEUE_MANAGE"><HelpdeskQueueAdminPage /></RequirePermission>}
            />
            <Route
              path="admin"
              element={<RequirePermission permission="HELPDESK_QUEUE_MANAGE"><HelpdeskAdminPage /></RequirePermission>}
            />
            <Route
              path="admin/knowledge-base"
              element={<RequirePermission permission="HELPDESK_KB_MANAGE"><HelpdeskKnowledgeBaseAdminPage /></RequirePermission>}
            />
          </Route>
          <Route path="*" element={<Navigate to="/app/helpdesk" replace />} />
        </Routes>
      </RequirePermission>
    </div>
  );
};

export default HelpdeskRouter;
