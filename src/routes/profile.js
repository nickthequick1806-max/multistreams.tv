import { HttpError, json, readJson, sanitizeUrl } from '../lib/http.js';
import { nowIso, optionalSession, parseJson, requireSession } from '../lib/db.js';

const SOCIAL_HOSTS = {
  twitch: ['twitch.tv'], youtube: ['youtube.com', 'youtu.be'], x: ['x.com', 'twitter.com'], instagram: ['instagram.com'],
  tiktok: ['tiktok.com'], discord: ['discord.com', 'discord.gg'], facebook: ['facebook.com'], kick: ['kick.com'], snapchat: ['snapchat.com'], rumble: ['rumble.com']
};

async function socials(env, userId) {
  const rows = await env.DB.prepare('SELECT platform, url FROM social_links WHERE user_id = ?1 ORDER BY platform').bind(userId).all();
  return Object.fromEntries((rows.results || []).map(row => [row.platform, row.url]));
}

async function layouts(env, userId) {
  const rows = await env.DB.prepare('SELECT id, name, channels_json, layout, created_at FROM community_layouts WHERE user_id = ?1 AND status = ?2 ORDER BY created_at DESC').bind(userId, 'published').all();
  return (rows.results || []).map(row => ({ id: row.id, name: row.name, channels: parseJson(row.channels_json, []), layout: row.layout, streamCount: parseJson(row.channels_json, []).length, createdAt: row.created_at }));
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
  const [profileSocials, profileLayouts, followingRow] = await Promise.all([
    target.hide_socials && !access.own ? Promise.resolve({}) : socials(env, target.id),
    target.hide_shared_layouts && !access.own ? Promise.resolve([]) : layouts(env, target.id),
    viewerId && !access.own ? env.DB.prepare('SELECT 1 AS following FROM profile_follows WHERE follower_user_id = ?1 AND followed_user_id = ?2').bind(viewerId, target.id).first() : Promise.resolve(null)
  ]);
  const watchSeconds = target.hide_watch_badges && !access.own ? null : Number(target.watch_seconds || 0);
  return {
    id: target.id, username: target.username, avatarUrl: target.avatar_url || '/logos and assets/defualt_profile_pfp.png',
    bannerUrl: target.banner_url || '/logos and assets/defualt_profile_banner.png', bio: target.bio || '', watchSeconds,
    verified: watchSeconds !== null && watchSeconds >= 10_000 * 3600, profileVisibility: target.profile_visibility,
    hideWatchBadges: Boolean(target.hide_watch_badges), hideSocials: Boolean(target.hide_socials), hideSharedLayouts: Boolean(target.hide_shared_layouts),
    socials: profileSocials, layouts: profileLayouts, following: Boolean(followingRow), access
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
  const target = await env.DB.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first();
  if (!target) throw new HttpError(404, 'Profile not found.', 'profile_not_found');
  if (target.id === session.user_id) throw new HttpError(400, 'You cannot follow your own profile.', 'cannot_follow_self');
  if (enabled) await env.DB.prepare('INSERT OR IGNORE INTO profile_follows (follower_user_id, followed_user_id, created_at) VALUES (?1, ?2, ?3)').bind(session.user_id, target.id, nowIso()).run();
  else await env.DB.prepare('DELETE FROM profile_follows WHERE follower_user_id = ?1 AND followed_user_id = ?2').bind(session.user_id, target.id).run();
  return json({ ok: true, following: enabled });
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
  const rows = await env.DB.prepare(`SELECT u.username, u.avatar_url FROM profile_blocks b JOIN users u ON u.id = b.blocked_user_id
    WHERE b.blocker_user_id = ?1 ORDER BY b.created_at DESC`).bind(session.user_id).all();
  return json({ ok: true, profiles: (rows.results || []).map(row => ({ username: row.username, avatarUrl: row.avatar_url || '' })) });
}

export async function handleProfileRoute(request, env, url) {
  if (url.pathname === '/api/profile/me' && request.method === 'GET') return getMe(request, env);
  if (url.pathname === '/api/profile/me' && request.method === 'PATCH') return updateProfile(request, env);
  if (url.pathname === '/api/profiles' && request.method === 'GET') return searchProfiles(request, env, url);
  if (url.pathname === '/api/profiles/followed' && request.method === 'GET') return followed(request, env);
  if (url.pathname === '/api/profiles/blocked' && request.method === 'GET') return blocked(request, env);
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
