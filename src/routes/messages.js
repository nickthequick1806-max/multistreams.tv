import { HttpError, json, readJson } from '../lib/http.js';
import { nowIso, requireSession } from '../lib/db.js';
import { randomId } from '../lib/crypto.js';

function conversationId(firstId, secondId) {
  return [String(firstId), String(secondId)].sort().join(':');
}

async function targetUser(env, username) {
  const user = await env.DB.prepare('SELECT id, username, avatar_url FROM users WHERE username = ?1 COLLATE NOCASE').bind(username).first();
  if (!user) throw new HttpError(404, 'Profile not found.', 'profile_not_found');
  return user;
}

async function assertCanMessage(env, senderId, recipient) {
  if (senderId === recipient.id) throw new HttpError(400, 'You cannot message your own profile.', 'cannot_message_self');
  const blocked = await env.DB.prepare(`SELECT 1 AS blocked FROM profile_blocks WHERE
    (blocker_user_id = ?1 AND blocked_user_id = ?2) OR (blocker_user_id = ?2 AND blocked_user_id = ?1) LIMIT 1`)
    .bind(senderId, recipient.id).first();
  if (blocked) throw new HttpError(403, 'Messaging is unavailable because one of these profiles is blocked.', 'profile_blocked');
}

async function listConversations(request, env) {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare(`SELECT c.id, c.updated_at,
      CASE WHEN c.user_low_id = ?1 THEN hi.id ELSE lo.id END AS peer_id,
      CASE WHEN c.user_low_id = ?1 THEN hi.username ELSE lo.username END AS peer_username,
      CASE WHEN c.user_low_id = ?1 THEN hi.avatar_url ELSE lo.avatar_url END AS peer_avatar,
      m.id AS message_id, m.body, m.sender_user_id, m.created_at, m.read_at,
      (SELECT COUNT(*) FROM direct_messages unread WHERE unread.conversation_id = c.id
        AND unread.recipient_user_id = ?1 AND unread.read_at IS NULL) AS unread_count
    FROM conversations c
    JOIN users lo ON lo.id = c.user_low_id
    JOIN users hi ON hi.id = c.user_high_id
    LEFT JOIN direct_messages m ON m.id = (
      SELECT latest.id FROM direct_messages latest WHERE latest.conversation_id = c.id
      ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
    )
    WHERE c.user_low_id = ?1 OR c.user_high_id = ?1
    ORDER BY c.updated_at DESC LIMIT 100`).bind(session.user_id).all();
  return json({ ok: true, conversations: (rows.results || []).map(row => ({
    id: row.id,
    user: { id: row.peer_id, username: row.peer_username, avatarUrl: row.peer_avatar || '/logos and assets/defualt_profile_pfp.png' },
    lastMessage: row.message_id ? { id: row.message_id, body: row.body, outgoing: row.sender_user_id === session.user_id, createdAt: row.created_at, readAt: row.read_at } : null,
    unreadCount: Number(row.unread_count || 0),
    updatedAt: row.updated_at
  })) });
}

async function getConversation(request, env, username) {
  const session = await requireSession(request, env);
  const peer = await targetUser(env, username);
  await assertCanMessage(env, session.user_id, peer);
  const id = conversationId(session.user_id, peer.id);
  const timestamp = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE direct_messages SET read_at = ?1 WHERE conversation_id = ?2 AND recipient_user_id = ?3 AND read_at IS NULL').bind(timestamp, id, session.user_id),
    env.DB.prepare(`UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND type = 'message'
      AND json_extract(metadata_json, '$.senderUserId') = ?3 AND read_at IS NULL`).bind(timestamp, session.user_id, peer.id)
  ]);
  const rows = await env.DB.prepare(`SELECT m.id, m.body, m.sender_user_id, m.recipient_user_id, m.read_at, m.created_at,
      u.username AS sender_username, u.avatar_url AS sender_avatar
    FROM direct_messages m JOIN users u ON u.id = m.sender_user_id
    WHERE m.conversation_id = ?1 ORDER BY m.created_at ASC, m.id ASC LIMIT 500`).bind(id).all();
  return json({ ok: true, conversation: { id, user: { id: peer.id, username: peer.username, avatarUrl: peer.avatar_url || '/logos and assets/defualt_profile_pfp.png' } }, messages: (rows.results || []).map(row => ({
    id: row.id, body: row.body, outgoing: row.sender_user_id === session.user_id, senderUsername: row.sender_username,
    senderAvatarUrl: row.sender_avatar || '/logos and assets/defualt_profile_pfp.png', readAt: row.read_at, createdAt: row.created_at
  })) });
}

async function sendMessage(request, env, username) {
  const session = await requireSession(request, env);
  const recipient = await targetUser(env, username);
  await assertCanMessage(env, session.user_id, recipient);
  const body = await readJson(request, 16_000);
  const message = String(body.message || '').trim();
  if (!message) throw new HttpError(400, 'Enter a message before sending.', 'message_required');
  if (message.length > 2000) throw new HttpError(400, 'Messages can be up to 2,000 characters.', 'message_too_long');
  const id = conversationId(session.user_id, recipient.id);
  const messageId = randomId();
  const notificationId = randomId();
  const timestamp = nowIso();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO conversations (id, user_low_id, user_high_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`)
      .bind(id, ...[session.user_id, recipient.id].sort(), timestamp),
    env.DB.prepare(`INSERT INTO direct_messages (id, conversation_id, sender_user_id, recipient_user_id, body, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(messageId, id, session.user_id, recipient.id, message, timestamp),
    env.DB.prepare(`INSERT INTO notifications (id, user_id, type, message, metadata_json, created_at)
      VALUES (?1, ?2, 'message', ?3, ?4, ?5)`).bind(notificationId, recipient.id, message.slice(0, 180), JSON.stringify({
        senderUserId: session.user_id,
        senderUsername: session.username,
        senderAvatarUrl: session.avatar_url || '',
        conversationId: id,
        messageId
      }), timestamp)
  ]);
  return json({ ok: true, message: { id: messageId, body: message, outgoing: true, createdAt: timestamp } });
}

export async function handleMessageRoute(request, env, url) {
  if (url.pathname === '/api/messages' && request.method === 'GET') return listConversations(request, env);
  const match = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (match && request.method === 'GET') return getConversation(request, env, decodeURIComponent(match[1]));
  if (match && request.method === 'POST') return sendMessage(request, env, decodeURIComponent(match[1]));
  return null;
}
