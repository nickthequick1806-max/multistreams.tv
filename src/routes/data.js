import { HttpError, json, readJson } from '../lib/http.js';
import { nowIso, optionalSession, parseJson, rateLimit, requireSession } from '../lib/db.js';
import { randomId, sha256 } from '../lib/crypto.js';

function parseLayoutChannels(value) {
  const channels = Array.isArray(value) ? value : [];
  if (channels.length > 16) throw new HttpError(400, 'A layout can contain at most 16 streams.', 'layout_too_large');
  return channels.map(channel => ({
    name: String(channel?.name || '').trim().slice(0, 120),
    platform: String(channel?.platform || 'twitch').toLowerCase(),
    displayName: String(channel?.displayName || channel?.name || '').trim().slice(0, 120),
    muted: channel?.muted !== false
  })).filter(channel => channel.name && ['twitch', 'youtube', 'kick', 'rumble'].includes(channel.platform));
}

function normalizeLayout(value) {
  return ['grid', 'vertical', 'horizontal'].includes(String(value)) ? String(value) : 'grid';
}

async function getState(request, env) {
  const session = await requireSession(request, env);
  const row = await env.DB.prepare('SELECT channels_json, layout, updated_at FROM user_state WHERE user_id = ?1').bind(session.user_id).first();
  return json({ ok: true, state: { channels: parseJson(row?.channels_json, []), layout: row?.layout || 'grid', updatedAt: row?.updated_at || null } });
}

async function putState(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const channels = parseLayoutChannels(body.channels);
  const layout = normalizeLayout(body.layout);
  const timestamp = nowIso();
  await env.DB.prepare(`INSERT INTO user_state (user_id, channels_json, layout, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(user_id) DO UPDATE SET channels_json = excluded.channels_json, layout = excluded.layout, updated_at = excluded.updated_at`)
    .bind(session.user_id, JSON.stringify(channels), layout, timestamp).run();
  return json({ ok: true, state: { channels, layout, updatedAt: timestamp } });
}

async function listSavedLayouts(request, env) {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare('SELECT * FROM saved_layouts WHERE user_id = ?1 ORDER BY updated_at DESC').bind(session.user_id).all();
  return json({ ok: true, layouts: (rows.results || []).map(row => ({ id: row.id, name: row.name, channels: parseJson(row.channels_json, []), layout: row.layout, createdAt: row.created_at, updatedAt: row.updated_at })) });
}

async function createSavedLayout(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Enter a layout name.', 'layout_name_required');
  const channels = parseLayoutChannels(body.channels);
  if (!channels.length) throw new HttpError(400, 'Add at least one stream before saving.', 'layout_empty');
  const id = randomId();
  const timestamp = nowIso();
  await env.DB.prepare('INSERT INTO saved_layouts (id, user_id, name, channels_json, layout, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)')
    .bind(id, session.user_id, name, JSON.stringify(channels), normalizeLayout(body.layout), timestamp).run();
  return json({ ok: true, layout: { id, name, channels, layout: normalizeLayout(body.layout), createdAt: timestamp, updatedAt: timestamp } }, { status: 201 });
}

async function deleteSavedLayout(request, env, id) {
  const session = await requireSession(request, env);
  await env.DB.prepare('DELETE FROM saved_layouts WHERE id = ?1 AND user_id = ?2').bind(id, session.user_id).run();
  return json({ ok: true });
}

async function listCommunityLayouts(request, env, url) {
  const query = String(url.searchParams.get('q') || '').trim();
  const rows = await env.DB.prepare(`SELECT c.*, u.username, u.avatar_url FROM community_layouts c JOIN users u ON u.id = c.user_id
    WHERE c.status = 'published' AND (?1 = '' OR c.name LIKE ?2 OR u.username LIKE ?2) ORDER BY c.created_at DESC LIMIT 100`)
    .bind(query, `%${query.replace(/[%_]/g, '')}%`).all();
  return json({ ok: true, layouts: (rows.results || []).map(row => ({
    id: row.id, name: row.name, streams: parseJson(row.channels_json, []), layoutType: row.layout, categories: parseJson(row.categories_json, []),
    streamCount: parseJson(row.channels_json, []).length, submittedBy: row.username, submittedByUserId: row.user_id,
    submitterAvatar: row.avatar_url || '/logos and assets/defualt_profile_pfp.png', createdAt: row.created_at
  })) });
}

async function createCommunityLayout(request, env, context) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const name = String(body.name || '').trim().slice(0, 80);
  const channels = parseLayoutChannels(body.channels);
  if (!name || !channels.length) throw new HttpError(400, 'A name and at least one stream are required.', 'invalid_layout');
  const id = randomId();
  const timestamp = nowIso();
  const categories = [...new Set(channels.map(channel => channel.platform))];
  await env.DB.prepare(`INSERT INTO community_layouts (id, user_id, name, channels_json, layout, categories_json, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`).bind(id, session.user_id, name, JSON.stringify(channels), normalizeLayout(body.layout), JSON.stringify(categories), timestamp).run();
  if (env.DISCORD_WEBHOOK_URL) {
    context.waitUntil(fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ embeds: [{ title: 'New Community Layout', color: 0x38bdf8, fields: [{ name: 'Layout', value: name, inline: true }, { name: 'Submitted by', value: session.username, inline: true }, { name: 'Streams', value: String(channels.length), inline: true }], timestamp }] }) }).catch(error => console.error(JSON.stringify({ event: 'discord_layout_webhook_failed', error: error.message }))));
  }
  return json({ ok: true, id }, { status: 201 });
}

async function getSettings(request, env) {
  const session = await requireSession(request, env);
  const row = await env.DB.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?1').bind(session.user_id).first();
  return json({ ok: true, settings: parseJson(row?.settings_json, {}) });
}

async function putSettings(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request, 64_000);
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
  const timestamp = nowIso();
  await env.DB.prepare(`INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`)
    .bind(session.user_id, JSON.stringify(settings), timestamp).run();
  return json({ ok: true, settings });
}

async function submitFeedback(request, env, context) {
  const session = await optionalSession(request, env);
  const body = await readJson(request);
  const category = ['general', 'bug', 'feature'].includes(body.category) ? body.category : 'general';
  const message = String(body.message || '').trim().slice(0, 4000);
  if (message.length < 5) throw new HttpError(400, 'Enter at least 5 characters.', 'feedback_too_short');
  const id = randomId();
  await env.DB.prepare('INSERT INTO reports (id, reporter_user_id, category, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, session?.user_id || null, category, message, nowIso()).run();
  if (env.DISCORD_WEBHOOK_URL) {
    context.waitUntil(fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ embeds: [{ title: `Feedback: ${category}`, description: message, color: 0x38bdf8, footer: { text: session?.username ? `From ${session.username}` : 'Anonymous' }, timestamp: nowIso() }] }) }).catch(error => console.error(JSON.stringify({ event: 'discord_feedback_webhook_failed', error: error.message }))));
  }
  return json({ ok: true, id }, { status: 201 });
}

async function submitContact(request, env, context) {
  const session = await optionalSession(request, env);
  const address = request.headers.get('cf-connecting-ip') || 'local';
  await rateLimit(env, `contact:${await sha256(address)}`, 5, 3600);
  const body = await readJson(request);
  const name = String(body.name || '').trim().slice(0, 100);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
  const subject = String(body.subject || 'General Inquiry').trim().slice(0, 120);
  const message = String(body.message || '').trim().slice(0, 4000);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length < 5) throw new HttpError(400, 'Enter your name, a valid email, and a message.', 'invalid_contact_form');
  const id = randomId();
  const timestamp = nowIso();
  await env.DB.prepare('INSERT INTO reports (id, reporter_user_id, category, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, session?.user_id || null, 'contact', JSON.stringify({ name, email, subject, message }), timestamp).run();
  if (env.DISCORD_WEBHOOK_URL) {
    const payload = { embeds: [{ title: 'New Contact Form Submission', color: 0x5dd2ff, fields: [
      { name: 'Name', value: name, inline: true }, { name: 'Email', value: email, inline: true },
      { name: 'Subject', value: subject || 'General Inquiry', inline: false }, { name: 'Message', value: message.slice(0, 1024), inline: false }
    ], footer: { text: session?.username ? `Signed in as ${session.username}` : 'Multistreams.tv Contact Form' }, timestamp }] };
    context.waitUntil(fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .catch(error => console.error(JSON.stringify({ event: 'discord_contact_webhook_failed', error: error.message }))));
  }
  return json({ ok: true, id }, { status: 201 });
}

export async function handleDataRoute(request, env, url, context) {
  if (url.pathname === '/api/state' && request.method === 'GET') return getState(request, env);
  if (url.pathname === '/api/state' && request.method === 'PUT') return putState(request, env);
  if (url.pathname === '/api/layouts' && request.method === 'GET') return listSavedLayouts(request, env);
  if (url.pathname === '/api/layouts' && request.method === 'POST') return createSavedLayout(request, env);
  const savedMatch = url.pathname.match(/^\/api\/layouts\/([^/]+)$/);
  if (savedMatch && request.method === 'DELETE') return deleteSavedLayout(request, env, savedMatch[1]);
  if (url.pathname === '/api/community-layouts' && request.method === 'GET') return listCommunityLayouts(request, env, url);
  if (url.pathname === '/api/community-layouts' && request.method === 'POST') return createCommunityLayout(request, env, context);
  if (url.pathname === '/api/settings' && request.method === 'GET') return getSettings(request, env);
  if (url.pathname === '/api/settings' && request.method === 'PUT') return putSettings(request, env);
  if (url.pathname === '/api/feedback' && request.method === 'POST') return submitFeedback(request, env, context);
  if (url.pathname === '/api/contact' && request.method === 'POST') return submitContact(request, env, context);
  return null;
}
