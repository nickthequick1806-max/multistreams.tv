import { HttpError, json, readJson, sanitizeUrl } from '../lib/http.js';
import { nowIso, optionalSession, parseJson, requireSession } from '../lib/db.js';
import { randomId } from '../lib/crypto.js';
import { profileMedia } from '../platforms.js';

const SOCIAL_HOSTS = {
  twitch: ['twitch.tv'], youtube: ['youtube.com', 'youtu.be'], x: ['x.com', 'twitter.com'], instagram: ['instagram.com'],
  tiktok: ['tiktok.com'], discord: ['discord.com', 'discord.gg'], facebook: ['facebook.com'], kick: ['kick.com'], snapchat: ['snapchat.com'], rumble: ['rumble.com']
};

function profilePlatformHint(platform, value) {
  try {
    const url = new URL(String(value || ''));
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (platform === 'twitch') return parts[0] || '';
    if (platform !== 'youtube') return '';
    if (parts[0]?.startsWith('@')) return parts[0];
    if (['channel', 'user', 'c'].includes(String(parts[0] || '').toLowerCase())) return parts[1] || '';
    return parts[0] || '';
  } catch {
    return '';
  }
}

async function socials(env, userId) {
  const rows = await env.DB.prepare('SELECT platform, url FROM social_links WHERE user_id = ?1 ORDER BY platform').bind(userId).all();
  return Object.fromEntries((rows.results || []).map(row => [row.platform, row.url]));
}

async function layouts(env, userId) {
  const rows = await env.DB.prepare('SELECT id, name, channels_json, layout, created_at FROM community_layouts WHERE user_id = ?1 AND status = ?2 ORDER BY created_at DESC').bind(userId, 'published').all();
  return (rows.results || []).map(row => ({ id: row.id, name: row.name, channels: parseJson(row.channels_json, []), layout: row.layout, streamCount: parseJson(row.channels_json, []).length, createdAt: row.created_at }));
}

async function panels(env, userId) {
  const rows = await env.DB.prepare(`SELECT id, position, title, image_url, description, link_url, created_at, updated_at
    FROM profile_panels WHERE user_id = ?1 ORDER BY position, created_at`).bind(userId).all();
  return (rows.results || []).map(row => ({ id: row.id, position: Number(row.position), title: row.title, imageUrl: row.image_url, description: row.description, url: row.link_url, createdAt: row.created_at, updatedAt: row.updated_at }));
}

async function profileStats(env, userId) {
  const row = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM community_layouts WHERE user_id = ?1 AND status = 'published') AS layouts,
      (SELECT COUNT(*) FROM profile_follows WHERE followed_user_id = ?1) AS followers,
      (SELECT COUNT(*) FROM profile_follows WHERE follower_user_id = ?1) AS following`).bind(userId).first();
  return { layouts: Number(row?.layouts || 0), followers: Number(row?.followers || 0), following: Number(row?.following || 0) };
}

async function profileConnections(env, userId) {
  const rows = await env.DB.prepare(`SELECT platform, platform_user_id, platform_username, metadata_json
    FROM oauth_connections WHERE user_id = ?1 AND platform IN ('twitch','youtube') ORDER BY platform`).bind(userId).all();
  return Object.fromEntries((rows.results || []).map(row => [row.platform, { userId: row.platform_user_id, username: row.platform_username, metadata: parseJson(row.metadata_json, {}) }]));
}

async function accessState(env, target, viewer) {
  const viewerId = viewer?.user_id || viewer?.id;
  if (viewerId === target.id) return { allowed: true, own: true, reason: '' };
  if (viewer) {
    const blocked = await env.DB.prepare(`SELECT 1 AS blocked FROM profile_blocks WHERE
      (blocker_user_id = ?1 AND blocked_user_id = ?2) OR (blocker_user_id = ?2 AND blocked_user_id = ?1) LIMIT 1`)
      .bind(target.id, viewerId).first();
    if (blocked) return { allowed: false, own: false, reason: 'blocked' };
  }
  if (target.profile_visibility === 'hidden') return { allowed: false, own: false, reason: 'hidden' };
  return { allowed: true, own: false, reason: '' };
}

async function serializeProfile(env, target, viewer) {
  const access = await accessState(env, target, viewer);
  const viewerId = viewer?.user_id || viewer?.id;
  if (!access.allowed) return { username: target.username, avatarUrl: target.avatar_url || '', bannerUrl: target.banner_url || '', access };
  const [profileSocials, profileLayouts, profilePanels, stats, connections, followingRow] = await Promise.all([
    target.hide_socials && !access.own ? Promise.resolve({}) : socials(env, target.id),
    target.hide_shared_layouts && !access.own ? Promise.resolve([]) : layouts(env, target.id),
    panels(env, target.id),
    profileStats(env, target.id),
    profileConnections(env, target.id),
    viewerId && !access.own ? env.DB.prepare('SELECT 1 AS following FROM profile_follows WHERE follower_user_id = ?1 AND followed_user_id = ?2').bind(viewerId, target.id).first() : Promise.resolve(null)
  ]);
  const watchSeconds = target.hide_watch_badges && !access.own ? null : Number(target.watch_seconds || 0);
  return {
    id: target.id, username: target.username, avatarUrl: target.avatar_url || '/logos and assets/defualt_profile_pfp.png',
    bannerUrl: target.banner_url || '/logos and assets/defualt_profile_banner.png', bio: target.bio || '', watchSeconds,
    verified: watchSeconds !== null && watchSeconds >= 10_000 * 3600, profileVisibility: target.profile_visibility,
    hideWatchBadges: Boolean(target.hide_watch_badges), hideSocials: Boolean(target.hide_socials), hideSharedLayouts: Boolean(target.hide_shared_layouts),
    socials: profileSocials, layouts: profileLayouts, panels: profilePanels, stats, connections, following: Boolean(followingRow), access
  };
}

async function getProfile(request, env, username) {
  const viewer = await optionalSession(request, env);
  const target = await env.DB.prepare('SELECT * FROM users WHERE username = ?1').bind(username).first();
  if (!target) throw new HttpError(404, 'Profile not found.', 'profile_not_found');
  return json({ ok: true, profile: await serializeProfile(env, target, viewer) });
}

async function getMe(request, env) {
  const session = await requireSession(request, env);
  return json({ ok: true, profile: await serializeProfile(env, session, session) });
}

async function searchProfiles(request, env, url) {
  const viewer = await optionalSession(request, env);
  const query = String(url.searchParams.get('q') || '').trim().replace(/[%_]/g, '');
  if (query.length < 2) return json({ ok: true, profiles: [] });
  const rows = await env.DB.prepare(`SELECT id, username, avatar_url, banner_url, profile_visibility FROM users
    WHERE username LIKE ?1 ORDER BY CASE WHEN username = ?2 THEN 0 WHEN username LIKE ?3 THEN 1 ELSE 2 END, username LIMIT 20`)
    .bind(`%${query}%`, query, `${query}%`).all();
  const profiles = [];
  for (const row of rows.results || []) {
    const access = await accessState(env, row, viewer);
    profiles.push({ id: row.id, username: row.username, avatarUrl: row.avatar_url || '/logos and assets/defualt_profile_pfp.png', bannerUrl: row.banner_url || '/logos and assets/defualt_profile_banner.png', access });
  }
  return json({ ok: true, profiles });
}

async function updateProfile(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request, 64_000);
  const fields = [];
  const bindings = [];
  const add = (column, value) => { fields.push(`${column} = ?${bindings.length + 1}`); bindings.push(value); };
  if (body.username !== undefined) {
    const username = String(body.username || '').trim();
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{2,29}$/.test(username)) throw new HttpError(400, 'Username must be 3–30 valid characters.', 'invalid_username');
    add('username', username);
  }
  if (body.bio !== undefined) add('bio', String(body.bio || '').slice(0, 500));
  if (body.avatarUrl !== undefined) add('avatar_url', sanitizeUrl(body.avatarUrl) || '');
  if (body.bannerUrl !== undefined) add('banner_url', sanitizeUrl(body.bannerUrl) || '');
  if (body.profileVisibility !== undefined) add('profile_visibility', body.profileVisibility === 'hidden' ? 'hidden' : 'public');
  if (body.hideWatchBadges !== undefined) add('hide_watch_badges', body.hideWatchBadges ? 1 : 0);
  if (body.hideSocials !== undefined) add('hide_socials', body.hideSocials ? 1 : 0);
  if (body.hideSharedLayouts !== undefined) add('hide_shared_layouts', body.hideSharedLayouts ? 1 : 0);
  if (fields.length) {
    add('updated_at', nowIso()); bindings.push(session.user_id);
    try { await env.DB.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?${bindings.length}`).bind(...bindings).run(); }
    catch { throw new HttpError(409, 'That username is already in use.', 'username_in_use'); }
  }
  if (body.socials && typeof body.socials === 'object') {
    const statements = [];
    for (const [platform, value] of Object.entries(body.socials)) {
      if (!SOCIAL_HOSTS[platform]) continue;
      const url = value ? sanitizeUrl(value, SOCIAL_HOSTS[platform]) : '';
      statements.push(url
        ? env.DB.prepare(`INSERT INTO social_links (user_id, platform, url, updated_at) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(user_id, platform) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`).bind(session.user_id, platform, url, nowIso())
        : env.DB.prepare('DELETE FROM social_links WHERE user_id = ?1 AND platform = ?2').bind(session.user_id, platform));
    }
    if (statements.length) await env.DB.batch(statements);
  }
  const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(session.user_id).first();
  return json({ ok: true, profile: await serializeProfile(env, updated, updated) });
}

async function follow(request, env, username, enabled) {
  const session = await requireSession(request, env);
  const target = await env.DB.prepare('SELECT id, username FROM users WHERE username = ?1').bind(username).first();
  if (!target) throw new HttpError(404, 'Profile not found.', 'profile_not_found');
  if (target.id === session.user_id) throw new HttpError(400, 'You cannot follow your own profile.', 'cannot_follow_self');
  if (enabled) {
    const timestamp = nowIso();
    const inserted = await env.DB.prepare('INSERT OR IGNORE INTO profile_follows (follower_user_id, followed_user_id, created_at) VALUES (?1, ?2, ?3)').bind(session.user_id, target.id, timestamp).run();
    if (Number(inserted.meta?.changes || 0) > 0) {
      await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, message, metadata_json, created_at)
        VALUES (?1, ?2, 'follow', ?3, ?4, ?5)`).bind(randomId(), target.id, `${session.username} followed you.`, JSON.stringify({
          followerUserId: session.user_id, followerUsername: session.username, followerAvatarUrl: session.avatar_url || ''
        }), timestamp).run();
    }
  } else await env.DB.prepare('DELETE FROM profile_follows WHERE follower_user_id = ?1 AND followed_user_id = ?2').bind(session.user_id, target.id).run();
  const stats = await profileStats(env, target.id);
  return json({ ok: true, following: enabled, stats });
}

async function followed(request, env) {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare(`SELECT u.id, u.username, u.avatar_url, u.banner_url FROM profile_follows f
    JOIN users u ON u.id = f.followed_user_id WHERE f.follower_user_id = ?1 ORDER BY f.created_at DESC`).bind(session.user_id).all();
  return json({ ok: true, profiles: (rows.results || []).map(row => ({
    id: row.id,
    username: row.username,
    avatarUrl: row.avatar_url || '/logos and assets/defualt_profile_pfp.png',
    bannerUrl: row.banner_url || '/logos and assets/defualt_profile_banner.png',
    access: { allowed: true, own: false, reason: '' }
  })) });
}

async function block(request, env, username, enabled) {
  const session = await requireSession(request, env);
  const target = await env.DB.prepare('SELECT id, username, avatar_url FROM users WHERE username = ?1').bind(username).first();
  if (!target) throw new HttpError(404, 'Profile not found.', 'profile_not_found');
  if (target.id === session.user_id) throw new HttpError(400, 'You cannot block your own profile.', 'cannot_block_self');
  if (enabled) await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO profile_blocks (blocker_user_id, blocked_user_id, created_at) VALUES (?1, ?2, ?3)').bind(session.user_id, target.id, nowIso()),
    env.DB.prepare('DELETE FROM profile_follows WHERE (follower_user_id = ?1 AND followed_user_id = ?2) OR (follower_user_id = ?2 AND followed_user_id = ?1)').bind(session.user_id, target.id)
  ]);
  else await env.DB.prepare('DELETE FROM profile_blocks WHERE blocker_user_id = ?1 AND blocked_user_id = ?2').bind(session.user_id, target.id).run();
  return json({ ok: true, blocked: enabled, profile: { username: target.username, avatarUrl: target.avatar_url || '' } });
}

async function blocked(request, env) {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare(`SELECT u.username, u.avatar_url, u.banner_url, u.bio FROM profile_blocks b JOIN users u ON u.id = b.blocked_user_id
    WHERE b.blocker_user_id = ?1 ORDER BY b.created_at DESC`).bind(session.user_id).all();
  return json({ ok: true, profiles: (rows.results || []).map(row => ({
    username: row.username,
    avatarUrl: row.avatar_url || '/logos and assets/defualt_profile_pfp.png',
    bannerUrl: row.banner_url || '/logos and assets/defualt_profile_banner.png',
    bio: row.bio || ''
  })) });
}

async function profileUsers(request, env, username, type) {
  const viewer = await optionalSession(request, env);
  const target = await env.DB.prepare('SELECT id FROM users WHERE username = ?1 COLLATE NOCASE').bind(username).first();
  if (!target) throw new HttpError(404, 'Profile not found.', 'profile_not_found');
  const rows = type === 'followers'
    ? await env.DB.prepare(`SELECT u.* FROM profile_follows f JOIN users u ON u.id = f.follower_user_id
        WHERE f.followed_user_id = ?1 ORDER BY f.created_at DESC LIMIT 250`).bind(target.id).all()
    : await env.DB.prepare(`SELECT u.* FROM profile_follows f JOIN users u ON u.id = f.followed_user_id
        WHERE f.follower_user_id = ?1 ORDER BY f.created_at DESC LIMIT 250`).bind(target.id).all();
  const profiles = [];
  for (const user of rows.results || []) {
    const access = await accessState(env, user, viewer);
    profiles.push({ id: user.id, username: user.username, avatarUrl: user.avatar_url || '/logos and assets/defualt_profile_pfp.png', bannerUrl: user.banner_url || '/logos and assets/defualt_profile_banner.png', access });
  }
  return json({ ok: true, profiles, type });
}

function panelValues(body) {
  return {
    title: String(body.title || '').trim().slice(0, 100),
    imageUrl: body.imageUrl ? sanitizeUrl(body.imageUrl) : '',
    description: String(body.description || '').trim().slice(0, 1000),
    url: body.url ? sanitizeUrl(body.url) : ''
  };
}

async function createPanel(request, env) {
  const session = await requireSession(request, env);
  const values = panelValues(await readJson(request, 64_000));
  if (!values.title && !values.imageUrl && !values.description) throw new HttpError(400, 'Add a title, image, or description to the panel.', 'panel_empty');
  const position = Number((await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM profile_panels WHERE user_id = ?1').bind(session.user_id).first())?.position || 0);
  const id = randomId();
  const timestamp = nowIso();
  await env.DB.prepare(`INSERT INTO profile_panels (id, user_id, position, title, image_url, description, link_url, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`).bind(id, session.user_id, position, values.title, values.imageUrl, values.description, values.url, timestamp).run();
  return json({ ok: true, panels: await panels(env, session.user_id) });
}

async function updatePanel(request, env, panelId) {
  const session = await requireSession(request, env);
  const values = panelValues(await readJson(request, 64_000));
  const result = await env.DB.prepare(`UPDATE profile_panels SET title = ?1, image_url = ?2, description = ?3, link_url = ?4, updated_at = ?5
    WHERE id = ?6 AND user_id = ?7`).bind(values.title, values.imageUrl, values.description, values.url, nowIso(), panelId, session.user_id).run();
  if (!Number(result.meta?.changes || 0)) throw new HttpError(404, 'About panel not found.', 'panel_not_found');
  return json({ ok: true, panels: await panels(env, session.user_id) });
}

async function deletePanel(request, env, panelId) {
  const session = await requireSession(request, env);
  await env.DB.prepare('DELETE FROM profile_panels WHERE id = ?1 AND user_id = ?2').bind(panelId, session.user_id).run();
  const current = await panels(env, session.user_id);
  if (current.length) await env.DB.batch(current.map((panel, index) => env.DB.prepare('UPDATE profile_panels SET position = ?1 WHERE id = ?2 AND user_id = ?3').bind(index, panel.id, session.user_id)));
  return json({ ok: true, panels: await panels(env, session.user_id) });
}

async function reorderPanels(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request, 32_000);
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))].slice(0, 50);
  if (ids.length) await env.DB.batch(ids.map((id, index) => env.DB.prepare('UPDATE profile_panels SET position = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4').bind(index, nowIso(), id, session.user_id)));
  return json({ ok: true, panels: await panels(env, session.user_id) });
}

async function media(request, env, username, type) {
  const viewer = await optionalSession(request, env);
  const target = await env.DB.prepare('SELECT * FROM users WHERE username = ?1 COLLATE NOCASE').bind(username).first();
  if (!target) throw new HttpError(404, 'Profile not found.', 'profile_not_found');
  const access = await accessState(env, target, viewer);
  if (!access.allowed) throw new HttpError(403, 'This profile is unavailable.', 'profile_unavailable');
  const platform = type === 'clips' ? 'twitch' : 'youtube';
  const [connection, social] = await Promise.all([
    env.DB.prepare('SELECT platform_user_id, platform_username FROM oauth_connections WHERE user_id = ?1 AND platform = ?2').bind(target.id, platform).first(),
    env.DB.prepare('SELECT url FROM social_links WHERE user_id = ?1 AND platform = ?2').bind(target.id, platform).first()
  ]);
  if (!connection) return json({ ok: true, type, connected: false, items: [] });
  const items = await profileMedia(env, platform, connection.platform_user_id, connection.platform_username, 24, profilePlatformHint(platform, social?.url));
  return json({ ok: true, type, connected: true, items }, { headers: { 'cache-control': 'private, max-age=60' } });
}

export async function handleProfileRoute(request, env, url) {
  if (url.pathname === '/api/profile/me' && request.method === 'GET') return getMe(request, env);
  if (url.pathname === '/api/profile/me' && request.method === 'PATCH') return updateProfile(request, env);
  if (url.pathname === '/api/profiles' && request.method === 'GET') return searchProfiles(request, env, url);
  if (url.pathname === '/api/profiles/followed' && request.method === 'GET') return followed(request, env);
  if (url.pathname === '/api/profiles/blocked' && request.method === 'GET') return blocked(request, env);
  if (url.pathname === '/api/profile/panels' && request.method === 'POST') return createPanel(request, env);
  if (url.pathname === '/api/profile/panels/reorder' && request.method === 'PUT') return reorderPanels(request, env);
  const panelMatch = url.pathname.match(/^\/api\/profile\/panels\/([^/]+)$/);
  if (panelMatch && request.method === 'PATCH') return updatePanel(request, env, panelMatch[1]);
  if (panelMatch && request.method === 'DELETE') return deletePanel(request, env, panelMatch[1]);
  const usersMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)\/(followers|following)$/);
  if (usersMatch && request.method === 'GET') return profileUsers(request, env, decodeURIComponent(usersMatch[1]), usersMatch[2]);
  const mediaMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)\/(clips|videos)$/);
  if (mediaMatch && request.method === 'GET') return media(request, env, decodeURIComponent(mediaMatch[1]), mediaMatch[2]);
  const followMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)\/follow$/);
  if (followMatch && request.method === 'PUT') return follow(request, env, decodeURIComponent(followMatch[1]), true);
  if (followMatch && request.method === 'DELETE') return follow(request, env, decodeURIComponent(followMatch[1]), false);
  const blockMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)\/block$/);
  if (blockMatch && request.method === 'PUT') return block(request, env, decodeURIComponent(blockMatch[1]), true);
  if (blockMatch && request.method === 'DELETE') return block(request, env, decodeURIComponent(blockMatch[1]), false);
  const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (profileMatch && request.method === 'GET') return getProfile(request, env, decodeURIComponent(profileMatch[1]));
  return null;
}
