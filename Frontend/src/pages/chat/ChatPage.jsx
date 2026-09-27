// PHASE 33.8 — CHAT HUB PAGE (tenant app)
//
// Wires the 33.3/33.4/33.7 REST contracts and the 33.5/33.6/33.7 socket
// events into the Redux chat slice. Text is rendered as plain React text
// nodes everywhere; nothing sensitive is logged; no presence/typing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { AlertTriangle, ArrowLeft, Lock, Search, Unlock, Users } from 'lucide-react';

import usePermission from '../../hooks/usePermission.js';
import chatService from '../../services/chatService.js';
import { hasVisibleText } from '../../utils/chatText.js';
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
  reactionsUpdated,
  threadLoading,
  threadLoaded,
  threadOlderLoaded,
  threadFailed,
  threadMessageDeleted,
  jumpLoaded,
  searchStarted,
  searchLoaded,
  searchMoreLoaded,
  searchFailed,
  searchCleared,
  typingCleared,
  conversationDropped,
  conversationUpdated,
} from '../../redux/slices/chatSlice.js';

import ConversationList from '../../components/chat/ConversationList.jsx';
import MessageList from '../../components/chat/MessageList.jsx';
// 34.2 — threads, feature-local: the panel, its rows and the reply pill.
import ThreadPanel from '../../components/chat/ThreadPanel.jsx';
import ReplyContextPill from '../../components/chat/ReplyContextPill.jsx';
// 34.4 — conversation-scoped search (bar + results panel).
import ConversationSearchBar from '../../components/chat/ConversationSearchBar.jsx';
import ConversationSearchResults from '../../components/chat/ConversationSearchResults.jsx';
// 34.5 — "…is typing" for the open conversation only.
import TypingIndicator from '../../components/chat/TypingIndicator.jsx';
// 34.6 — group membership: who is in the group, add, remove, leave.
import GroupMembersModal from '../../components/chat/GroupMembersModal.jsx';
import MessageComposer from '../../components/chat/MessageComposer.jsx';
import ChatEmptyState from '../../components/chat/ChatEmptyState.jsx';
import Avatar from '../../components/chat/Avatar.jsx';
import EditMessageModal from '../../components/chat/EditMessageModal.jsx';
import NewConversationModal from '../../components/chat/NewConversationModal.jsx';

const PAGE_SIZE = 30;

// 34.4 — the search endpoint accepts AT MOST 20 rows per page (the server
// refuses more), while history and threads take 30. Asking for PAGE_SIZE here
// was the bug the first localhost run found: every search came back 400.
const SEARCH_PAGE_SIZE = 20;

/*
 * 34.5 — typing timers.
 *
 * IDLE: how long after the last keystroke we tell the room we stopped. Long
 * enough that the pause while thinking does not flicker the indicator off and
 * on, short enough that the other side is not left looking at a stale one.
 *
 * HEARTBEAT: a typing session can outlast the RECEIVER's TTL (5 s in the
 * socket client), so a single start per session cannot keep the indicator
 * alive. Re-emitting start every 3 s is the minimum that stays honest; the
 * server's own throttle allows 1 s, and one tiny frame per 3 s per typing
 * person is the whole cost.
 */
const TYPING_IDLE_MS = 2500;
const TYPING_HEARTBEAT_MS = 3000;

/*
 * Error text.
 *
 * The axios layer rejects with `normalizeError(...)` — a PLAIN Error that
 * carries the server's message in `.message` and copies `.status`/`.code`, but
 * has NO `.response`. Reading `err?.response?.data?.message` therefore always
 * fell through to the generic fallback, which is how a real 400 ("limit must be
 * an integer between 1 and 20.") reached the reader as "The search could not be
 * completed." Both shapes are read below, so either one wins.
 */
const chatErrorMessage = (err, fallback) =>
  err?.response?.data?.message || err?.message || fallback;

const chatErrorStatus = (err) => err?.response?.status ?? err?.status;

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

  // 34.2 — THREAD STATE.
  //   replyingTo     : the message the main composer will answer (null = a
  //                    normal top-level send)
  //   openThreadRoot : the ROOT id of the thread shown in the panel
  // Both are view state and live and die with the page: a thread is a read, and
  // nothing about it is persisted (no per-thread cursor, no followers).
  // 34.4 — search: the query lives here (the bar is presentational), and the
  // RESULT state lives in the store so a re-render cannot lose it.
  // 34.6 — the members panel (group conversations only) and its own busy/error
  // state, so a refusal from the server is shown inside the panel that caused
  // it rather than as a page-level notice.
  const [membersOpen, setMembersOpen] = useState(false);
  const [membersBusy, setMembersBusy] = useState(false);
  const [membersError, setMembersError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchingMore, setSearchingMore] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [openThreadRoot, setOpenThreadRoot] = useState(null);
  const [threadLoadingOlder, setThreadLoadingOlder] = useState(false);

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

  // 34.3 — WHO CAN BE MENTIONED: exactly the members of the conversation being
  // written into, taken from the backend read projection that already carries
  // them (`members[].user`). No directory call, no company-wide search, and the
  // server will accept a mention from this same list only.
  const mentionMembers = useMemo(
    () =>
      (activeConversation?.members ?? []).map((member) => ({
        userId: String(member.userId),
        user: member.user ? { name: member.user.name } : null,
      })),
    [activeConversation]
  );

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
      dispatch(conversationsFailed(chatErrorMessage(err, 'Failed to load conversations.')));
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

  // ── 34.5 typing (the emitting side) ──────────────────────────────────
  //
  // The ref holds the ONE room we last told "started" (plus that room's two
  // timers). Nothing is persisted, nothing is shared between users, and every
  // timer dies with the page.
  const typingRef = useRef({ conversationId: null, idleTimer: null, beatTimer: null });

  const clearTypingTimers = () => {
    const state = typingRef.current;

    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.beatTimer) clearInterval(state.beatTimer);

    state.idleTimer = null;
    state.beatTimer = null;
  };

  // Best effort by design: a typing frame is decoration, so a refusal, a
  // throttle or a dead socket is never surfaced to the reader. (The server
  // still enforces membership and the room lock — the silence is about UX, not
  // about skipping a gate.)
  const emitTyping = useCallback((isTyping, roomId) => {
    if (!roomId || !chatRealtime.isConnected()) return;

    const call = isTyping ? chatRealtime.typingStart : chatRealtime.typingStop;

    call({ conversationId: roomId }).catch(() => {});
  }, []);

  const stopTyping = useCallback((roomId) => {
    const state = typingRef.current;
    const target = roomId ?? state.conversationId;

    clearTypingTimers();
    state.conversationId = null;

    if (target) emitTyping(false, target);
  }, [emitTyping]);

  const handleComposerActivity = useCallback((active) => {
    const state = typingRef.current;

    if (!conversationId) return;

    if (!active) {
      if (state.conversationId) stopTyping();

      return;
    }

    // A new room: end the previous room's indicator BEFORE announcing this one,
    // so a switch can never leave a ghost behind.
    if (state.conversationId !== conversationId) {
      if (state.conversationId) stopTyping(state.conversationId);

      state.conversationId = conversationId;
      emitTyping(true, conversationId);
      state.beatTimer = setInterval(() => emitTyping(true, conversationId), TYPING_HEARTBEAT_MS);
    }

    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => stopTyping(), TYPING_IDLE_MS);
  }, [conversationId, emitTyping, stopTyping]);

  // Leaving the page ends the indicator, whatever the reason.
  useEffect(() => () => stopTyping(), [stopTyping]);

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
            error: chatErrorMessage(err, 'Failed to load history.'),
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
      // A reply target and an open thread belong to ONE conversation: carrying
      // either into another room would point at a message that is not there.
      setReplyingTo(null);
      setOpenThreadRoot(null);
      setSearchOpen(false);
      setSearchQuery('');
      dispatch(searchCleared());
      // 34.5 — the room we are leaving is told we stopped, and its indicators
      // are dropped: a claim about another conversation must not follow us here.
      stopTyping();
      dispatch(typingCleared({ conversationId }));
    };
  }, [conversationId, dispatch, applyRead, stopTyping]);

  // ── 34.6 losing access to the open conversation ───────────────────────
  //
  // The server nudges a removed member's personal room; this page refetches the
  // list. If the conversation we KNEW a moment ago is no longer in it, we were
  // removed: leave the socket room (the client half of the server eviction),
  // drop everything cached for that room, and let the reader read the reason.
  const knownConversationIds = useRef(new Set());

  useEffect(() => {
    const ids = new Set(chat.conversations.map((entry) => String(entry._id)));
    const active = conversationId ? String(conversationId) : '';

    const wasKnown = active && knownConversationIds.current.has(active);
    const stillKnown = active && ids.has(active);

    knownConversationIds.current = ids;

    if (!active || !wasKnown || stillKnown) return;
    if (chat.conversationsStatus !== 'ready') return;

    chatRealtime.leave(active);
    dispatch(conversationDropped({ conversationId: active }));
  }, [chat.conversations, chat.conversationsStatus, conversationId, dispatch]);

  const dropped = Boolean(conversationId) && String(chat.droppedId ?? '') === String(conversationId);

  // ── mark read when new messages land while open ───────────────────────
  const newestSeq = activeEntry?.items?.length
    ? activeEntry.items[activeEntry.items.length - 1].seq
    : 0;

  useEffect(() => {
    if (conversationId && newestSeq > 0) applyRead(conversationId, newestSeq);
  }, [conversationId, newestSeq, applyRead]);

  // ── actions ───────────────────────────────────────────────────────────
  /**
   * 34.2 — ONE send path for the composer and the thread panel. The only
   * difference between them is the reply target, so the optimistic pending row,
   * the FILE-vs-TEXT decision and the failure copy cannot drift apart.
   */
  const sendMessage = async ({
    text,
    attachments = [],
    replyToMessageId = null,
    mentionUserIds = [],
  }) => {
    const clientMessageId = newClientMessageId();

    dispatch(pendingAdd({
      conversationId,
      entry: {
        clientMessageId,
        // An invisible body never becomes a blank pending bubble: the
        // fallback reads the same way a FILE message does.
        text: hasVisibleText(text) ? text : 'Attachment',
        attachments: attachments.map((entry) => ({
          attachmentId: entry._id,
          fileName: entry.fileName,
          sizeBytes: entry.sizeBytes,
        })),
        status: 'sending',
      },
    }));

    // 33.10-fix4 — a caption rides WITH the file in the same message (the
    // server validates it: visible only, length-capped). Sending it in the
    // text event instead would split one message into two.
    const caption = hasVisibleText(text) ? text : null;

    // 34.2 — a reply target rides along on BOTH transports, so answering a
    // message with a file attached keeps its context (the server refuses a
    // parent from another conversation or tenant).
    const replyTarget = replyToMessageId ? String(replyToMessageId) : null;

    const ack = attachments.length > 0
      ? await chatRealtime.sendFile({
          conversationId,
          clientMessageId,
          attachmentIds: attachments.map((entry) => entry._id),
          text: caption,
          replyToMessageId: replyTarget,
          // 34.3 — a caption can mention people just like a text body.
          mentions: mentionUserIds,
        })
      : await chatRealtime.send({
          conversationId,
          clientMessageId,
          text,
          replyToMessageId: replyTarget,
          mentions: mentionUserIds,
        });

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

  // The main composer: answers whichever message "Reply" last selected.
  const handleSend = (text, attachments = [], mentionUserIds = []) =>
    sendMessage({
      text,
      attachments,
      replyToMessageId: replyingTo?._id ?? null,
      mentionUserIds,
    }).then((failure) => {
      // The reply target is consumed by a successful send only: a failed send
      // keeps the context so the retry answers the same message.
      if (!failure) setReplyingTo(null);

      return failure;
    });

  // The thread panel: answers the ROOT (see ThreadPanel for why the flat
  // two-level model makes the root the honest target).
  const handleThreadReply = (text, attachments = [], mentionUserIds = []) =>
    sendMessage({
      text,
      attachments,
      // `openThreadRoot` is already the EFFECTIVE root (a reply click sets its
      // threadRootMessageId), so the panel always answers the thread's first
      // message — see ThreadPanel for why that is the honest target.
      replyToMessageId: openThreadRoot,
      mentionUserIds,
    }).then((failure) => {
      if (!failure) setPendingAttachments((current) => ({ ...current, [conversationId]: [] }));

      return failure;
    });

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

  // 34.1 — REACTIONS. Socket-only, ACK-first: the bubble decides ADD vs REMOVE
  // from the viewer-aware summary it was given, and this function sends exactly
  // that intent. The ACK carries the caller's OWN state ({type,count,mine}), so
  // applying it here means the sender sees the result immediately even when the
  // change was a no-op (already reacted / nothing to remove) and therefore
  // produced no broadcast. Everyone else updates from the room broadcast.
  //
  // No optimistic write on purpose: a reaction is cheap, and inventing a state
  // the server has not confirmed is exactly how two clients end up disagreeing
  // about the counts.
  const handleReact = async (message, reactionType, intent = 'ADD') => {
    if (!conversationId || !message?._id) return;

    const call = intent === 'REMOVE' ? chatRealtime.unreact : chatRealtime.react;

    const ack = await call({
      conversationId,
      messageId: message._id,
      reactionType,
    });

    if (!ack.ok) {
      setModerationNotice(ack.message || 'The reaction could not be saved.');

      return;
    }

    dispatch(reactionsUpdated({
      conversationId,
      messageId: ack.data?.messageId ?? message._id,
      reactions: ack.data?.reactions ?? [],
      viewerAware: true,
      myReaction: ack.data?.myReaction ?? null,
    }));

    setModerationNotice(null);
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
        setModerationNotice(chatErrorMessage(err, 'The message could not be removed.'));
      }

      return;
    }

    const sure = globalThis.confirm('Delete this message for everyone?');

    if (!sure) return;

    const ack = await chatRealtime.remove({ conversationId, messageId: message._id });

    // 34.2 — if that message is a reply shown in an open thread, tombstone it
    // there too (the conversation bucket got its own messageDeleted broadcast).
    if (ack?.ok) {
      dispatch(threadMessageDeleted({
        messageId: message._id,
        deletedAt: new Date().toISOString(),
        deletedByUserId: meId,
      }));
    }
  };

  // ── 34.2 threads ──────────────────────────────────────────────────────
  //
  // Opening a thread is a READ: it goes over REST (so it works while realtime
  // is down), it is tenant- and membership-gated server-side, and nothing about
  // it is stored. A message that is itself a reply opens the thread it belongs
  // to — `threadRootMessageId` is the server's answer to "which thread am I in",
  // so the client never has to guess.
  const openThreadFor = async (message, { cursor } = {}) => {
    const rootId = String(message.threadRootMessageId ?? message._id);

    if (!cursor) setOpenThreadRoot(rootId);

    if (cursor) setThreadLoadingOlder(true);

    // The bucket keeps whatever it already shows while this request is in
    // flight, so "load older" never blanks the panel.
    dispatch(threadLoading({ conversationId, rootId }));

    try {
      const result = await chatService.getThread(conversationId, rootId, {
        cursor,
        limit: PAGE_SIZE,
      });

      if (cursor) {
        dispatch(threadOlderLoaded({
          rootId,
          items: result.items,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        }));
      } else {
        dispatch(threadLoaded({
          conversationId,
          rootId,
          root: result.root,
          items: result.items,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        }));
      }
    } catch (err) {
      const status = chatErrorStatus(err);

      dispatch(threadFailed({
        conversationId,
        rootId,
        error:
          status === 404
            ? 'This thread is no longer available.'
            : chatErrorMessage(err, 'The thread could not be loaded.'),
      }));
    } finally {
      if (cursor) setThreadLoadingOlder(false);
    }
  };

  const closeThread = () => setOpenThreadRoot(null);

  // ── 34.4 search ───────────────────────────────────────────────────────
  //
  // The debounce is a plain timer (no dependency, no hook library): 300 ms
  // after the last keystroke, and only for a query the server will accept
  // (>= 2 characters — the same floor as the backend rule, so the client does
  // not spend requests on refusals).
  const searchQ = chat.search.conversationId === conversationId ? chat.search : null;

  const runSearch = useCallback(async (term) => {
    dispatch(searchStarted({ conversationId, q: term }));

    try {
      const result = await chatService.searchMessages(conversationId, {
        q: term,
        limit: SEARCH_PAGE_SIZE,
      });

      dispatch(searchLoaded({
        conversationId,
        q: result.q ?? term,
        items: result.items,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      }));
    } catch (err) {
      dispatch(searchFailed({
        error: chatErrorMessage(err, 'The search could not be completed.'),
      }));
    }
  }, [conversationId, dispatch]);

  useEffect(() => {
    if (!conversationId || !searchOpen) return undefined;

    const term = searchQuery.trim();

    if (term.length < 2) {
      // Below the floor there is nothing to ask for; clear whatever was shown.
      if (searchQ && searchQ.q !== term) dispatch(searchCleared());

      return undefined;
    }

    // Already asked for this exact term (loading, ready, OR failed): do not ask
    // again on every store update. A failure stays failed until the reader edits
    // the term or presses "Try again" — an automatic retry here would be a
    // request loop against an endpoint that is already refusing.
    if (searchQ?.q === term) return undefined;

    const timer = setTimeout(() => {
      runSearch(term);
    }, 300);

    return () => clearTimeout(timer);
  }, [conversationId, searchOpen, searchQuery, searchQ, runSearch, dispatch]);

  const loadMoreMatches = async () => {
    if (!conversationId || !searchQ?.nextCursor) return;

    setSearchingMore(true);

    try {
      const result = await chatService.searchMessages(conversationId, {
        q: searchQ.q,
        cursor: searchQ.nextCursor,
        limit: SEARCH_PAGE_SIZE,
      });

      dispatch(searchMoreLoaded({
        items: result.items,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      }));
    } catch (err) {
      dispatch(searchFailed({
        error: chatErrorMessage(err, 'The search could not be completed.'),
      }));
    } finally {
      setSearchingMore(false);
    }
  };

  /**
   * 34.4 — show one search result.
   *
   * If the message is already in the loaded window, scroll to it (cheap, and
   * the list keeps its place). Otherwise load ONE page that ENDS at the target
   * (`cursor = seq + 1`) — bounded, one request, no page-walking loop — and
   * mark the view as a jump so the reader is told where they are and can go
   * back to the live tail.
   */
  const openSearchResult = async (row) => {
    const loaded = (activeEntry?.items ?? []).some((message) => String(message._id) === String(row._id));

    if (loaded) {
      dispatch(jumpLoaded({
        conversationId,
        items: activeEntry.items,
        nextCursor: activeEntry.nextCursor,
        hasMore: activeEntry.hasMore,
        targetSeq: row.seq,
      }));

      return;
    }

    try {
      const result = await chatService.getMessages(conversationId, {
        cursor: row.seq + 1,
        limit: PAGE_SIZE,
      });

      // A targeted load must still contain the target; if the server's window
      // somehow does not (a message deleted between search and click), say so
      // instead of scrolling nowhere.
      const found = (result.items ?? []).some((message) => String(message._id) === String(row._id));

      if (!found) {
        setModerationNotice('That message is no longer available.');

        return;
      }

      dispatch(jumpLoaded({
        conversationId,
        items: result.items,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        targetSeq: row.seq,
      }));
    } catch (err) {
      setModerationNotice(chatErrorMessage(err, 'That message could not be opened.'));
    }
  };

  // The panel's "Try again": one explicit attempt on the same term (or the term
  // that failed). Deliberately manual — see the effect above.
  const retrySearch = () => {
    const term = (searchQ?.q || searchQuery).trim();

    if (term.length >= 2) runSearch(term);
  };

  // 34.5 — who is typing IN THIS ROOM, resolved to names through the member
  // directory the page already has. Our own id is filtered defensively (the
  // server never echoes to the sender) and an unresolvable member degrades to
  // "Someone" rather than leaking an id into the sentence.
  const typingNames = useMemo(() => {
    const ids = (chat.typing[conversationId] ?? []).filter(
      (id) => String(id) !== String(meId)
    );

    if (ids.length === 0) return [];

    const names = ids.map((id) => nameOfUserId(id)).filter(Boolean);

    return names.length > 0 ? names : ['Someone'];
  }, [chat.typing, conversationId, meId, nameOfUserId]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
    dispatch(searchCleared());
  };

  // Leaving a conversation ends its search too: results belong to the room they
  // were found in, and showing them beside another room's messages would be a
  // quiet lie about what was searched.
  const backToLatest = async () => {
    try {
      const result = await chatService.getMessages(conversationId, { limit: PAGE_SIZE });

      dispatch(messagesLoaded({
        conversationId,
        items: result.items,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      }));
    } catch {
      // keep what we have; the marker stays until the load succeeds
    }
  };

  const thread = openThreadRoot ? chat.threads[openThreadRoot] ?? null : null;

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
      setModerationNotice(chatErrorMessage(err, 'The conversation could not be updated.'));
    } finally {
      setModerationBusy(false);
    }
  };

  // ── 34.6 group membership ─────────────────────────────────────────────
  //
  // The page owns the calls; the panel stays presentational. Every handler
  // returns a FAILURE STRING (or null) for the same reason NewConversationModal
  // does: the panel shows the server's own words next to the control that
  // caused them.

  const applyProjected = (result) => {
    const updated = result?.conversation;

    // The response is the PROJECTED conversation (same shape as list/detail),
    // so merging it keeps names, roles, the caller's own cursor and the unread
    // count consistent.
    if (updated) dispatch(conversationUpdated(updated));
  };

  const handleAddMembers = async (memberUserIds) => {
    setMembersBusy(true);
    setMembersError('');

    try {
      applyProjected(await chatService.addMembers(conversationId, memberUserIds));

      return null;
    } catch (err) {
      const message = chatErrorMessage(err, 'Those members could not be added.');

      setMembersError(message);

      return message;
    } finally {
      setMembersBusy(false);
    }
  };

  const handleRemoveMember = async (member) => {
    const name = nameOfUserId(member.userId) ?? 'this person';

    if (!globalThis.confirm(`Remove ${name} from this group?`)) return null;

    setMembersBusy(true);
    setMembersError('');

    try {
      applyProjected(await chatService.removeMember(conversationId, member.userId));

      return null;
    } catch (err) {
      const message = chatErrorMessage(err, 'That member could not be removed.');

      setMembersError(message);

      return message;
    } finally {
      setMembersBusy(false);
    }
  };

  const handleLeaveGroup = async () => {
    setMembersBusy(true);
    setMembersError('');

    try {
      await chatService.removeMember(conversationId, meId);

      // Leaving removes this conversation from our list, so the page must not
      // stay on it: close the room, drop the panel and go back to the list.
      setMembersOpen(false);
      stopTyping(conversationId);
      chatRealtime.leave(conversationId);
      dispatch(conversationDropped({ conversationId }));
      navigate('/app/chat');

      return null;
    } catch (err) {
      const message = chatErrorMessage(err, 'You could not leave this group.');

      setMembersError(message);

      return message;
    } finally {
      setMembersBusy(false);
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
      return chatErrorMessage(err, 'The conversation could not be created.');
    }
  };

  const title = activeConversation ? nameOfConversation(activeConversation) : 'Chat';

  // Header identity: a DIRECT chat shows the other person's initials, a group
  // shows the group glyph. Purely derived from state we already hold.
  const headerIsDirect = activeConversation?.type === 'DIRECT';
  const memberCount = activeConversation?.members?.length ?? 0;

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
        mobileHidden={Boolean(conversationId)}
      />

      <section className={`min-w-0 flex-1 flex-col ${conversationId ? 'flex' : 'hidden md:flex'}`}>
        <header className="flex items-center gap-3 border-b border-crewly-border px-3 py-2.5 sm:px-4">
          {/* Phones show one pane at a time; this is the way back to the list. */}
          {conversationId && (
            <button
              type="button"
              onClick={() => navigate('/app/chat')}
              aria-label="Back to conversations"
              className="rounded-lg p-1.5 text-crewly-dim transition hover:bg-crewly-card hover:text-crewly-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40 md:hidden"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}

          {activeConversation &&
            (headerIsDirect ? (
              <Avatar name={title} seed={title} size="md" />
            ) : (
              // 34.6 — the group avatar IS the members entry point: it opens the
              // panel where membership is managed. (A 1:1 conversation has no
              // membership to manage, so it stays a plain avatar above.)
              <button
                type="button"
                onClick={() => {
                  setMembersError('');
                  setMembersOpen(true);
                }}
                aria-label={`View members (${memberCount})`}
                title="View members"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-crewly-border/40 text-crewly-dim transition hover:bg-crewly-card hover:text-crewly-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40"
              >
                <Users className="h-4 w-4" aria-hidden="true" />
              </button>
            ))}

          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-sm font-bold text-crewly-text">
              <span className="truncate">{title}</span>
              {conversationLocked && (
                <span className="shrink-0 rounded border border-crewly-red/40 px-1.5 py-0.5 text-[10px] font-semibold text-crewly-red">
                  Disabled
                </span>
              )}
            </h1>
            <p className="truncate text-[11px] text-crewly-dim">
              {chat.realtimeStatus === 'connected'
                ? 'Realtime connected'
                : chat.realtimeStatus === 'unavailable'
                  ? 'Realtime unavailable — read-only history'
                  : 'Connecting...'}
              {memberCount > 1 ? ` · ${memberCount} members` : ''}
              {unreadTotal > 0 ? ` · ${unreadTotal} unread elsewhere` : ''}
            </p>
          </div>

          {conversationId && (
            <button
              type="button"
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              aria-label={searchOpen ? 'Close search' : 'Search in this conversation'}
              title={searchOpen ? 'Close search' : 'Search in this conversation'}
              className={`rounded-lg p-1.5 transition hover:bg-crewly-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green/40 ${
                searchOpen ? 'text-crewly-green' : 'text-crewly-dim hover:text-crewly-text'
              }`}
            >
              <Search className="h-4 w-4" />
            </button>
          )}

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

        {conversationId && searchOpen && (
          <>
            <ConversationSearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              onClose={closeSearch}
              status={searchQ?.status ?? 'idle'}
              resultCount={searchQ?.items?.length ?? 0}
            />

            <ConversationSearchResults
              q={searchQuery}
              items={searchQ?.items ?? []}
              status={searchQ?.status ?? 'idle'}
              error={searchQ?.error ?? ''}
              hasMore={Boolean(searchQ?.hasMore)}
              loadingMore={searchingMore}
              nameOfUserId={nameOfUserId}
              onOpen={openSearchResult}
              onLoadMore={loadMoreMatches}
              onRetry={retrySearch}
            />
          </>
        )}

        {dropped && (
          <div className="border-b border-crewly-red/40 bg-crewly-red/10 px-3 py-2 text-xs text-crewly-red sm:px-4">
            You are no longer a member of this conversation. It has been removed from your list;
            anything it showed you is gone from this window.
          </div>
        )}

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
              onReact={handleReact}
              onReply={setReplyingTo}
              onOpenThread={openThreadFor}
              jump={activeEntry?.jump ?? null}
              onExitJump={backToLatest}
              canModerate={canModerate}
              locked={conversationLocked}
            />
            <TypingIndicator names={typingNames} />

            {!dropped && (
            <MessageComposer
              replyPill={
                replyingTo ? (
                  <ReplyContextPill
                    senderName={nameOfUserId(replyingTo.senderUserId)}
                    snippet={replyingTo.replyTo?.snippet ?? replyingTo.text ?? null}
                    onCancel={() => setReplyingTo(null)}
                  />
                ) : null
              }
              disabled={chat.realtimeStatus !== 'connected' || conversationLocked}
              disabledReason={
                conversationLocked
                  ? 'An admin disabled this conversation. History stays readable; sending resumes when it is re-enabled.'
                  : chat.realtimeStatus !== 'connected'
                    ? 'Realtime is unavailable — history stays readable. Sending returns when the connection is back.'
                    : ''
              }
              onSend={handleSend}
              conversationId={conversationId}
              meId={meId}
              mentionMembers={mentionMembers}
              pendingAttachments={activePending}
              onAddAttachment={addAttachment}
              onRemoveAttachment={removeAttachment}
              onTypingChange={handleComposerActivity}
            />
            )}
          </>
        ) : (
          <ChatEmptyState onNew={() => setShowNew(true)} />
        )}
      </section>

      {/* 34.2 — the thread panel is a sibling of the message column: a column
          on a desktop, a full-screen overlay on a phone (ThreadPanel owns that
          decision). Rendered for the open thread only. */}
      {conversationId && openThreadRoot && (
        <ThreadPanel
          conversationId={conversationId}
          thread={thread}
          nameOfUserId={nameOfUserId}
          onClose={closeThread}
          onLoadOlder={() =>
            thread?.nextCursor
              ? openThreadFor({ _id: openThreadRoot }, { cursor: thread.nextCursor })
              : undefined
          }
          onSendReply={handleThreadReply}
          meId={meId}
          mentionMembers={mentionMembers}
          disabled={chat.realtimeStatus !== 'connected' || conversationLocked}
          disabledReason={
            conversationLocked
              ? 'An admin disabled this conversation. Replies resume when it is re-enabled.'
              : 'Realtime is unavailable — the thread is readable, replying returns with the connection.'
          }
          pendingAttachments={activePending}
          onAddAttachment={addAttachment}
          onRemoveAttachment={removeAttachment}
          loadingOlder={threadLoadingOlder}
        />
      )}

      {membersOpen && activeConversation && (
        <GroupMembersModal
          conversation={activeConversation}
          users={users}
          meId={meId}
          busy={membersBusy}
          error={membersError}
          onClose={() => setMembersOpen(false)}
          onAdd={handleAddMembers}
          onRemove={handleRemoveMember}
          onLeave={handleLeaveGroup}
        />
      )}

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
