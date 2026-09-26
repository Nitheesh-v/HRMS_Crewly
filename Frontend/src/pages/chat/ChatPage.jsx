// PHASE 33.8 — CHAT HUB PAGE (tenant app)
//
// Wires the 33.3/33.4/33.7 REST contracts and the 33.5/33.6/33.7 socket
// events into the Redux chat slice. Text is rendered as plain React text
// nodes everywhere; nothing sensitive is logged; no presence/typing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { AlertTriangle, Lock, Unlock } from 'lucide-react';

import usePermission from '../../hooks/usePermission.js';
import chatService from '../../services/chatService.js';
import userService from '../../services/userService.js';
import {
  connectChatSocket,
  disconnectChatSocket,
  retryChatSocket,
  chatRealtime,
} from '../../services/realtime/chatSocketClient.js';
import {
  conversationsLoading,
  conversationsLoaded,
  conversationsFailed,
  conversationAdded,
  setActive,
  messagesLoading,
  messagesLoaded,
  messagesFailed,
  olderLoaded,
  pendingAdd,
  pendingFail,
  readUpToApplied,
  messageDeleted,
  conversationUpdated,
} from '../../redux/slices/chatSlice.js';

import ConversationList from '../../components/chat/ConversationList.jsx';
import MessageList from '../../components/chat/MessageList.jsx';
import MessageComposer from '../../components/chat/MessageComposer.jsx';
import ChatEmptyState from '../../components/chat/ChatEmptyState.jsx';
import EditMessageModal from '../../components/chat/EditMessageModal.jsx';
import NewConversationModal from '../../components/chat/NewConversationModal.jsx';

const PAGE_SIZE = 30;

const newClientMessageId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const displayName = (user) =>
  user?.name ||
  user?.fullName ||
  [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
  user?.email ||
  'Unknown user';

const ChatPage = () => {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const me = useSelector((state) => state.auth.user);
  const chat = useSelector((state) => state.chat);

  // Repo truth: login stores the user via publicUser(), which exposes `id`
  // (not `_id`). Accept both so the chat never mis-resolves "me".
  const meId = me?._id ?? me?.id ?? null;

  // 33.9 — moderation powers come from the server-resolved permission set
  // (never from a role name). While permissions are still loading the
  // controls stay hidden; the backend refuses them anyway.
  const { hasPermission } = usePermission();
  const canModerate = hasPermission('CHAT_MODERATE');
  const [moderationBusy, setModerationBusy] = useState(false);
  const [moderationNotice, setModerationNotice] = useState(null);

  // 33.10 — files already uploaded and waiting for the send that will
  // reference them. Keyed per conversation so switching rooms cannot leak a
  // pending file into the wrong chat.
  const [pendingAttachments, setPendingAttachments] = useState({});
  const activePending = conversationId ? pendingAttachments[conversationId] ?? [] : [];

  const addAttachment = useCallback((attachment) => {
    setPendingAttachments((current) => ({
      ...current,
      [conversationId]: [...(current[conversationId] ?? []), attachment],
    }));
  }, [conversationId]);

  const removeAttachment = useCallback((attachmentId) => {
    setPendingAttachments((current) => ({
      ...current,
      [conversationId]: (current[conversationId] ?? []).filter(
        (entry) => String(entry._id) !== String(attachmentId)
      ),
    }));
  }, [conversationId]);

  const [users, setUsers] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null);

  const activeEntry = conversationId ? chat.byId[conversationId] : null;
  const activeConversation = chat.conversations.find(
    (entry) => String(entry._id) === String(conversationId)
  );

  // ── names for DIRECT titles + sender labels ───────────────────────────
  // 33.8-fix: the /users directory can be scoped narrower than a
  // conversation (an EMPLOYEE with EMPLOYEE_READ_SELF lists only
  // themselves), so member identities projected by the backend read
  // projection (members[].user) are the fallback source of names.
  const memberNames = useMemo(() => {
    const map = new Map();
    for (const conversation of chat.conversations) {
      for (const member of conversation?.members ?? []) {
        if (member?.userId != null && member?.user) {
          map.set(String(member.userId), member.user);
        }
      }
    }
    return map;
  }, [chat.conversations]);

  const nameOfUserId = useCallback(
    (userId) => {
      const user =
        users.find((entry) => String(entry._id ?? entry.id) === String(userId)) ??
        memberNames.get(String(userId));
      return user ? displayName(user) : 'Unknown user';
    },
    [users, memberNames]
  );

  const nameOfConversation = useCallback(
    (conversation) => {
      if (conversation.type !== 'DIRECT') return conversation.title || 'Group conversation';
      const other = (conversation.members ?? []).find(
        (member) => String(member.userId) !== String(meId)
      );
      return other ? nameOfUserId(other.userId) : 'Direct message';
    },
    [users, meId, nameOfUserId]
  );

  // ── socket lifecycle (page-scoped) ────────────────────────────────────
  useEffect(() => {
    connectChatSocket();

    return () => {
      disconnectChatSocket();
    };
  }, []);

  // ── conversations + people ────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    dispatch(conversationsLoading());
    try {
      const result = await chatService.listConversations({ limit: PAGE_SIZE });
      dispatch(conversationsLoaded(result.conversations));
    } catch (err) {
      dispatch(conversationsFailed(err?.response?.data?.message || 'Failed to load conversations.'));
    }
  }, [dispatch]);

  useEffect(() => {
    loadConversations();

    userService
      .getAll({ status: 'ACTIVE', limit: 200 })
      .then((res) => {
        // api.js unwraps meta-carrying bodies once: the user array sits at
        // res.data when meta exists, or IS res otherwise.
        const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
        setUsers(list);
      })
      .catch(() => setUsers([]));
  }, [loadConversations]);

  // 33.8-fix — the data-less socket nudge (chat:conversations:changed)
  // flagged the list stale: refetch once so a conversation created in
  // another window appears live, with names, without a manual reload.
  const conversationsStale = chat.conversationsStale;
  useEffect(() => {
    if (conversationsStale) loadConversations();
  }, [conversationsStale, loadConversations]);

  // ── read marker helper (socket first, REST fallback) ──────────────────
  const lastMarkedSeq = useRef(0);

  const applyRead = useCallback(
    async (id, seq) => {
      if (!id || seq <= 0 || seq <= lastMarkedSeq.current) return;

      if (chatRealtime.isConnected()) {
        const ack = await chatRealtime.readUpTo({ conversationId: id, lastReadSeq: seq });

        if (ack.ok) {
          lastMarkedSeq.current = seq;
          dispatch(readUpToApplied({
            conversationId: id,
            myLastReadSeq: ack.data.myLastReadSeq,
            unreadCount: ack.data.unreadCount,
          }));
          return;
        }
      }

      try {
        const result = await chatService.markRead(id, seq);
        lastMarkedSeq.current = seq;
        dispatch(readUpToApplied({
          conversationId: id,
          myLastReadSeq: result?.myLastReadSeq ?? seq,
          unreadCount: result?.unreadCount ?? 0,
        }));
      } catch {
        // best-effort; the next open retries
      }
    },
    [dispatch]
  );

  // ── open a conversation: history + join + read ────────────────────────
  useEffect(() => {
    dispatch(setActive(conversationId ?? null));
    lastMarkedSeq.current = 0;

    if (!conversationId) return undefined;

    let cancelled = false;

    (async () => {
      dispatch(messagesLoading(conversationId));

      try {
        const result = await chatService.getMessages(conversationId, { limit: PAGE_SIZE });
        if (cancelled) return;

        dispatch(messagesLoaded({
          conversationId,
          items: result.items,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        }));

        const newest = result.items[0]?.seq ?? 0;
        applyRead(conversationId, newest);
      } catch (err) {
        if (!cancelled) {
          dispatch(messagesFailed({
            conversationId,
            error: err?.response?.data?.message || 'Failed to load history.',
          }));
        }
      }

      if (!cancelled && chatRealtime.isConnected()) {
        await chatRealtime.join(conversationId);
      }
    })();

    return () => {
      cancelled = true;
      if (chatRealtime.isConnected()) chatRealtime.leave(conversationId);
    };
  }, [conversationId, dispatch, applyRead]);

  // ── mark read when new messages land while open ───────────────────────
  const newestSeq = activeEntry?.items?.length
    ? activeEntry.items[activeEntry.items.length - 1].seq
    : 0;

  useEffect(() => {
    if (conversationId && newestSeq > 0) applyRead(conversationId, newestSeq);
  }, [conversationId, newestSeq, applyRead]);

  // ── actions ───────────────────────────────────────────────────────────
  const handleSend = async (text, attachments = []) => {
    const clientMessageId = newClientMessageId();

    dispatch(pendingAdd({
      conversationId,
      entry: {
        clientMessageId,
        text: text || 'Attachment',
        attachments: attachments.map((entry) => ({
          attachmentId: entry._id,
          fileName: entry.fileName,
          sizeBytes: entry.sizeBytes,
        })),
        status: 'sending',
      },
    }));

    const ack = attachments.length > 0
      ? await chatRealtime.sendFile({
          conversationId,
          clientMessageId,
          attachmentIds: attachments.map((entry) => entry._id),
        })
      : await chatRealtime.send({ conversationId, clientMessageId, text });

    if (!ack.ok) {
      dispatch(pendingFail({ conversationId, clientMessageId }));

      if (ack.code === 'FEATURE_UNAVAILABLE') {
        return 'Chat realtime is unavailable right now. History still loads read-only.';
      }

      // The uploaded files stay in the tray so the sender can retry without
      // re-uploading; the ids are still unclaimed.
      return ack.message || 'The message could not be sent.';
    }

    if (attachments.length > 0) {
      setPendingAttachments((current) => ({ ...current, [conversationId]: [] }));
    }

    return null;
  };

  const handleOlder = async () => {
    if (!activeEntry?.nextCursor) return;

    try {
      const result = await chatService.getMessages(conversationId, {
        cursor: activeEntry.nextCursor,
        limit: PAGE_SIZE,
      });

      dispatch(olderLoaded({
        conversationId,
        items: result.items,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      }));
    } catch {
      // keep what we have; the reader can scroll again
    }
  };

  const handleEditSubmit = async (newText) => {
    const ack = await chatRealtime.edit({
      conversationId,
      messageId: editing._id,
      expectedEditVersion: editing.editVersion ?? 0,
      newText,
    });

    if (!ack.ok) {
      if (ack.code === 'CONFLICT_EDIT_VERSION') {
        // Someone edited first: refresh history so the reader sees the truth.
        try {
          const result = await chatService.getMessages(conversationId, { limit: PAGE_SIZE });
          dispatch(messagesLoaded({
            conversationId,
            items: result.items,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
          }));
        } catch {
          // the warning below still explains what happened
        }

        return 'The message changed since you loaded it. The list has been refreshed.';
      }

      return ack.message || 'The edit could not be applied.';
    }

    return null;
  };

  const handleDelete = async (message) => {
    const mineMessage = String(message.senderUserId) === String(meId);

    // 33.9 — moderator removal goes over REST (audited, permission-gated) so
    // it works even while realtime is down; the socket path covers the
    // sender's own delete.
    if (!mineMessage && canModerate) {
      const sure = globalThis.confirm("Remove this message as a moderator? It is replaced by a placeholder.");

      if (!sure) return;

      try {
        await chatService.moderateDelete(conversationId, message._id);

        dispatch(messageDeleted({
          conversationId,
          messageId: message._id,
          deletedAt: new Date().toISOString(),
          deletedByUserId: meId,
        }));
      } catch (err) {
        setModerationNotice(err?.response?.data?.message || 'The message could not be removed.');
      }

      return;
    }

    const sure = globalThis.confirm('Delete this message for everyone?');

    if (!sure) return;

    await chatRealtime.remove({ conversationId, messageId: message._id });
  };

  // 33.9 — lock / unlock the conversation (CHAT_MODERATE only).
  const handleToggleLock = async (conversation) => {
    const isDisabled = Boolean(conversation.isDisabled);
    const question = isDisabled
      ? 'Re-open this conversation for everyone?'
      : 'Disable this conversation? Nobody can send or edit until it is re-enabled. History stays readable.';

    if (!globalThis.confirm(question)) return;

    setModerationBusy(true);
    setModerationNotice(null);

    try {
      const result = isDisabled
        ? await chatService.enableConversation(conversation._id)
        : await chatService.disableConversation(conversation._id);

      const updated = result?.conversation;

      if (updated) dispatch(conversationUpdated(updated));
    } catch (err) {
      setModerationNotice(err?.response?.data?.message || 'The conversation could not be updated.');
    } finally {
      setModerationBusy(false);
    }
  };

  const handleCreate = async (payload) => {
    try {
      const result = await chatService.createConversation(payload);
      const conversation = result?.conversation;

      if (!conversation) return 'The conversation could not be created.';

      dispatch(conversationAdded({ ...conversation, unreadCount: 0 }));
      navigate(`/app/chat/${conversation._id}`);
      return null;
    } catch (err) {
      return err?.response?.data?.message || 'The conversation could not be created.';
    }
  };

  const title = activeConversation ? nameOfConversation(activeConversation) : 'Chat';

  // 33.9 — the lock comes from the Mongo row (via the list projection), so a
  // member who is merely reading sees it without any extra request.
  const conversationLocked = Boolean(activeConversation?.isDisabled);

  const unreadTotal = useMemo(
    () => chat.conversations.reduce((sum, entry) => sum + (entry.unreadCount ?? 0), 0),
    [chat.conversations]
  );

  return (
    <div className="flex h-[calc(100vh-140px)] min-h-[480px] overflow-hidden rounded-xl border border-crewly-border bg-crewly-bg">
      <ConversationList
        conversations={chat.conversations}
        status={chat.conversationsStatus}
        error={chat.conversationsError}
        activeId={conversationId}
        nameOf={nameOfConversation}
        onSelect={(id) => navigate(`/app/chat/${id}`)}
        onNew={() => setShowNew(true)}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-crewly-border px-4 py-3">
          <div>
            <h1 className="text-sm font-bold text-crewly-text">
              {title}
              {conversationLocked && (
                <span className="ml-2 rounded border border-crewly-red/40 px-1.5 py-0.5 text-[10px] font-semibold text-crewly-red">
                  Disabled
                </span>
              )}
            </h1>
            <p className="text-[11px] text-crewly-dim">
              {chat.realtimeStatus === 'connected'
                ? 'Realtime connected'
                : chat.realtimeStatus === 'unavailable'
                  ? 'Realtime unavailable — read-only history'
                  : 'Connecting...'}
              {unreadTotal > 0 ? ` · ${unreadTotal} unread elsewhere` : ''}
            </p>
          </div>

          {canModerate && activeConversation && (
            <button
              type="button"
              disabled={moderationBusy}
              onClick={() => handleToggleLock(activeConversation)}
              className="flex items-center gap-1.5 rounded border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-dim hover:text-crewly-text disabled:opacity-50"
            >
              {conversationLocked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              {conversationLocked ? 'Re-enable' : 'Disable'}
            </button>
          )}
        </header>

        {moderationNotice && (
          <div className="flex items-center gap-2 border-b border-crewly-red/40 bg-crewly-red/10 px-4 py-2 text-xs text-crewly-red">
            <AlertTriangle className="h-3.5 w-3.5" />
            {moderationNotice}
          </div>
        )}

        {conversationLocked && (
          <div className="flex items-center gap-2 border-b border-crewly-red/40 bg-crewly-red/10 px-4 py-2 text-xs text-crewly-red">
            <Lock className="h-3.5 w-3.5" />
            Conversation disabled by an admin. You can still read history; sending, editing and deleting are paused.
          </div>
        )}

        {chat.realtimeStatus === 'unavailable' && (
          <div className="flex items-center gap-2 border-b border-crewly-orange/40 bg-crewly-orange/10 px-4 py-2 text-xs text-crewly-orange">
            <AlertTriangle className="h-3.5 w-3.5" />
            Chat realtime unavailable. History still loads; sending returns when realtime is back.
            <button
              type="button"
              onClick={() => retryChatSocket()}
              className="ml-auto rounded border border-crewly-orange/50 px-2 py-0.5 font-semibold hover:bg-crewly-orange/20"
            >
              Retry
            </button>
          </div>
        )}

        {conversationId ? (
          <>
            <MessageList
              conversationId={conversationId}
              entry={activeEntry}
              pending={chat.pending[conversationId] ?? []}
              meId={meId}
              nameOfUserId={nameOfUserId}
              onOlder={handleOlder}
              onEdit={setEditing}
              onDelete={handleDelete}
              canModerate={canModerate}
              locked={conversationLocked}
            />
            <MessageComposer
              disabled={chat.realtimeStatus !== 'connected' || conversationLocked}
              onSend={handleSend}
              conversationId={conversationId}
              pendingAttachments={activePending}
              onAddAttachment={addAttachment}
              onRemoveAttachment={removeAttachment}
            />
          </>
        ) : (
          <ChatEmptyState />
        )}
      </section>

      {showNew && (
        <NewConversationModal
          users={users}
          meId={meId}
          onClose={() => setShowNew(false)}
          onCreate={handleCreate}
        />
      )}

      {editing && (
        <EditMessageModal
          message={editing}
          onClose={() => setEditing(null)}
          onSubmit={handleEditSubmit}
        />
      )}
    </div>
  );
};

export default ChatPage;
