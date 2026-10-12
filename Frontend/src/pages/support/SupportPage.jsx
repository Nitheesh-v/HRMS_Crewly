// ============================================================
// 🎫 HELPDESK (Phase 38) — hub → list → conversation, UI/UX per Figma
// exports (desktop + mobile), inside the existing Crewly shell.
// Uses only existing backend endpoints (create / my / all / reply / status).
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import useAuth from '../../hooks/useAuth';
import { supportService } from '../../services/selfService';
import { notify } from '../../utils/notify.js';
import SupportHub from './SupportHub';
import TicketList from './TicketList';
import TicketThread from './TicketThread';
import RaiseTicketModal from './RaiseTicketModal';
import { DEPARTMENTS, categoryLabel, isOpen, statusMeta } from './supportMeta';

const HR_SIDE = ['COMPANY_ADMIN', 'HR_MANAGER'];

const SupportPage = () => {
  const { user } = useAuth();
  const isHR = HR_SIDE.includes(user?.role);

  const [scope, setScope] = useState('my'); // 'my' | 'all' (HR only)
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState('hub'); // 'hub' | 'list' | 'thread'
  const [listCat, setListCat] = useState(null);
  const [listStatus, setListStatus] = useState('ALL');
  const [listQuery, setListQuery] = useState('');
  const [activeId, setActiveId] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createCat, setCreateCat] = useState(null);
  const [busy, setBusy] = useState(false);

  // Fetch helper shared by the mount/scope effect and manual refreshes.
  const fetchTickets = (sc) =>
    (sc === 'all' ? supportService.listAll() : supportService.my())
      .then((res) => (Array.isArray(res) ? res : res?.data || []));

  // setState only inside promise callbacks (repo eslint rule set-state-in-effect).
  useEffect(() => {
    let alive = true;
    fetchTickets(scope)
      .then((list) => { if (alive) setTickets(list); })
      .catch((err) => { if (alive) notify.error(err); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scope]);

  const refresh = async () => {
    try {
      setTickets(await fetchTickets(scope));
    } catch (err) {
      notify.error(err);
    }
  };

  const openCountByCat = useMemo(() => {
    const counts = {};
    for (const t of tickets) if (isOpen(t)) counts[t.category] = (counts[t.category] || 0) + 1;
    return counts;
  }, [tickets]);

  const myOpenCount = useMemo(() => tickets.filter(isOpen).length, [tickets]);

  const filtered = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    return tickets.filter((t) => {
      if (listCat && t.category !== listCat) return false;
      if (listStatus !== 'ALL' && t.status !== listStatus) return false;
      if (q && !`${t.subject} ${t.message}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tickets, listCat, listStatus, listQuery]);

  const active = tickets.find((t) => t._id === activeId) || null;

  const openList = (cat) => {
    setListCat(cat);
    setListStatus('ALL');
    setListQuery('');
    setView('list');
  };

  const onCreate = async (payload) => {
    setBusy(true);
    try {
      await supportService.create(payload);
      notify.success('Support ticket raised — HR has been notified.');
      setCreateOpen(false);
      setListCat(null);
      setListStatus('ALL');
      setView('list');
      await refresh();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  const onReply = async (message) => {
    setBusy(true);
    try {
      await supportService.reply(activeId, message);
      notify.success('Reply sent.');
      await refresh();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  const onStatus = async (status) => {
    setBusy(true);
    try {
      await supportService.setStatus(activeId, status);
      notify.success(`Ticket marked ${statusMeta(status).label.toLowerCase()}.`);
      await refresh();
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(false);
    }
  };

  const onScope = (next) => {
    if (next === scope) return;
    setLoading(true);
    setScope(next);
    setActiveId(null);
    setView('list');
  };

  const listTitle = listCat
    ? (DEPARTMENTS.find((d) => d.code === listCat)?.label || categoryLabel(listCat))
    : (scope === 'all' ? 'All Tickets' : 'My Tickets');

  return (
    <div className="mx-auto w-full max-w-6xl">
      {view === 'hub' && (
        <SupportHub
          myOpenCount={myOpenCount}
          openCountByCat={openCountByCat}
          onOpenDepartment={openList}
          onOpenMy={() => openList(null)}
          onRaise={() => { setCreateCat(null); setCreateOpen(true); }}
          onSearch={(q) => { setListQuery(q); setListCat(null); setListStatus('ALL'); setView('list'); }}
        />
      )}

      {view === 'list' && (
        <TicketList
          title={listTitle}
          tickets={filtered}
          loading={loading}
          isHR={isHR}
          scope={scope}
          onScope={onScope}
          statusTab={listStatus}
          onStatusTab={setListStatus}
          categoryCode={listCat}
          onCategory={setListCat}
          query={listQuery}
          onQuery={setListQuery}
          onSelect={(id) => { setActiveId(id); setView('thread'); }}
          onRaise={() => { setCreateCat(listCat); setCreateOpen(true); }}
          onBack={() => setView('hub')}
        />
      )}

      {view === 'thread' && active && (
        <TicketThread
          ticket={active}
          isHR={isHR}
          meId={user?._id}
          busy={busy}
          onBack={() => setView('list')}
          onReply={onReply}
          onStatus={onStatus}
        />
      )}

      {view === 'thread' && !active && !loading && (
        <div className="card text-center text-sm text-crewly-dim">
          Ticket not found in this view.{' '}
          <button className="text-crewly-green underline" onClick={() => setView('list')}>Back to tickets</button>
        </div>
      )}

      {createOpen && (
        <RaiseTicketModal
          defaultCategory={createCat || 'IT'}
          busy={busy}
          onClose={() => setCreateOpen(false)}
          onSubmit={onCreate}
        />
      )}
    </div>
  );
};

export default SupportPage;
