import { HttpError, clearSessionCookie, json, readJson, safeRedirectPath, sessionCookie } from '../lib/http.js';
import { createSession, deleteSession, nowIso, optionalSession, rateLimit, requireSession } from '../lib/db.js';
import { decrypt, encrypt, hashPassword, otpauthUri, randomId, sha256, verifyPassword, verifyTotp } from '../lib/crypto.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,29}$/;

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_url || '/logos and assets/defualt_profile_pfp.png',
    bannerUrl: row.banner_url || '/logos and assets/defualt_profile_banner.png',
    bio: row.bio || '',
    watchSeconds: Number(row.watch_seconds) || 0,
    twoFactorEnabled: Boolean(row.two_factor_enabled),
    authMethod: row.auth_method || 'email',
    profileVisibility: row.profile_visibility || 'public',
    hideWatchBadges: Boolean(row.hide_watch_badges),
    hideSocials: Boolean(row.hide_socials),
    hideSharedLayouts: Boolean(row.hide_shared_layouts)
  };
}

async function authContext(request, env) {
  const session = await optionalSession(request, env);
  if (!session) return { authenticated: false, user: null, connections: [] };
  await env.DB.prepare('UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2').bind(nowIso(), session.session_id).run();
  const connections = await env.DB.prepare('SELECT platform, platform_username, updated_at FROM oauth_connections WHERE user_id = ?1 ORDER BY platform').bind(session.user_id).all();
  return { authenticated: true, user: publicUser(session), connections: connections.results || [] };
}

async function signUp(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  await rateLimit(env, `signup:${await sha256(ip)}`, 8, 3600);
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
  if (!USERNAME_PATTERN.test(username)) throw new HttpError(400, 'Username must be 3–30 characters and use letters, numbers, dots, dashes, or underscores.', 'invalid_username');
  if (password.length < 10 || password.length > 128) throw new HttpError(400, 'Password must contain 10–128 characters.', 'invalid_password');
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?1 OR username = ?2').bind(email, username).first();
  if (existing) throw new HttpError(409, 'That email or username is already registered.', 'account_exists');
  const id = randomId();
  const timestamp = nowIso();
  const passwordRecord = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, username, password_hash, password_salt, password_iterations, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`).bind(id, email, username, passwordRecord.hash, passwordRecord.salt, passwordRecord.iterations, timestamp),
    env.DB.prepare('INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?1, ?2, ?3)').bind(id, '{}', timestamp),
    env.DB.prepare('INSERT INTO user_state (user_id, channels_json, layout, updated_at) VALUES (?1, ?2, ?3, ?4)').bind(id, '[]', 'grid', timestamp),
    env.DB.prepare('INSERT INTO daily_rewards (user_id, updated_at) VALUES (?1, ?2)').bind(id, timestamp)
  ]);
  const token = await createSession(request, env, id);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  return json({ ok: true, user: publicUser(user) }, { status: 201, headers: { 'set-cookie': sessionCookie(env, token) } });
}

async function login(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  await rateLimit(env, `login:${await sha256(ip)}`, 12, 900);
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash, user.password_salt, user.password_iterations))) {
    throw new HttpError(401, 'Email or password is incorrect.', 'invalid_credentials');
  }
  if (user.two_factor_enabled && user.two_factor_secret) {
    const ticket = randomId(24);
    const timestamp = nowIso();
    await env.DB.prepare(`INSERT INTO auth_challenges (id, user_id, type, created_at, expires_at)
      VALUES (?1, ?2, 'login_totp', ?3, ?4)`).bind(ticket, user.id, timestamp, new Date(Date.now() + 5 * 60_000).toISOString()).run();
    return json({ ok: true, requiresTwoFactor: true, ticket });
  }
  const token = await createSession(request, env, user.id);
  return json({ ok: true, user: publicUser(user) }, { headers: { 'set-cookie': sessionCookie(env, token) } });
}

async function finishTotpLogin(request, env) {
  const body = await readJson(request);
  const ticket = String(body.ticket || '');
  const challenge = await env.DB.prepare(`SELECT c.*, u.two_factor_secret FROM auth_challenges c JOIN users u ON u.id = c.user_id
    WHERE c.id = ?1 AND c.type = 'login_totp' AND c.expires_at > ?2`).bind(ticket, nowIso()).first();
  if (!challenge?.two_factor_secret) throw new HttpError(400, 'The sign-in challenge expired. Please sign in again.', 'challenge_expired');
  const secret = await decrypt(challenge.two_factor_secret, env.TOKEN_ENCRYPTION_KEY);
  if (!(await verifyTotp(secret, body.code))) throw new HttpError(401, 'The authenticator code is incorrect.', 'invalid_totp');
  await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?1').bind(ticket).run();
  const token = await createSession(request, env, challenge.user_id);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(challenge.user_id).first();
  return json({ ok: true, user: publicUser(user) }, { headers: { 'set-cookie': sessionCookie(env, token) } });
}

async function startTotpSetup(request, env) {
  const session = await requireSession(request, env);
  const secret = (await import('../lib/crypto.js')).generateTotpSecret();
  const challengeId = randomId(24);
  const timestamp = nowIso();
  await env.DB.prepare(`INSERT INTO auth_challenges (id, user_id, type, secret, created_at, expires_at)
    VALUES (?1, ?2, 'totp_setup', ?3, ?4, ?5)`).bind(challengeId, session.user_id, await encrypt(secret, env.TOKEN_ENCRYPTION_KEY), timestamp, new Date(Date.now() + 10 * 60_000).toISOString()).run();
  return json({ ok: true, challengeId, secret, otpauthUri: otpauthUri(secret, session.email) });
}

async function verifyTotpSetup(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const challenge = await env.DB.prepare(`SELECT * FROM auth_challenges WHERE id = ?1 AND user_id = ?2 AND type = 'totp_setup' AND expires_at > ?3`)
    .bind(String(body.challengeId || ''), session.user_id, nowIso()).first();
  if (!challenge?.secret) throw new HttpError(400, 'The setup code expired. Start setup again.', 'challenge_expired');
  const secret = await decrypt(challenge.secret, env.TOKEN_ENCRYPTION_KEY);
  if (!(await verifyTotp(secret, body.code))) throw new HttpError(400, 'The authenticator code is incorrect.', 'invalid_totp');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET two_factor_secret = ?1, two_factor_enabled = 1, updated_at = ?2 WHERE id = ?3')
      .bind(await encrypt(secret, env.TOKEN_ENCRYPTION_KEY), nowIso(), session.user_id),
    env.DB.prepare('DELETE FROM auth_challenges WHERE id = ?1').bind(challenge.id)
  ]);
  return json({ ok: true, enabled: true });
}

async function disableTotp(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  if (session.password_hash && !(await verifyPassword(String(body.password || ''), session.password_hash, session.password_salt, session.password_iterations))) {
    throw new HttpError(401, 'Enter your current password to disable two-factor authentication.', 'invalid_credentials');
  }
  await env.DB.prepare('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0, updated_at = ?1 WHERE id = ?2').bind(nowIso(), session.user_id).run();
  return json({ ok: true, enabled: false });
}

async function devices(request, env) {
  const session = await requireSession(request, env);
  const rows = await env.DB.prepare('SELECT id, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ?1 AND expires_at > ?2 ORDER BY last_seen_at DESC')
    .bind(session.user_id, nowIso()).all();
  return json({ ok: true, devices: (rows.results || []).map(row => ({ ...row, current: row.id === session.session_id })) });
}

async function signOutDevice(request, env, deviceId) {
  const session = await requireSession(request, env);
  const device = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?1 AND user_id = ?2').bind(deviceId, session.user_id).first();
  if (!device) throw new HttpError(404, 'That signed-in device was not found.', 'device_not_found');
  const current = device.id === session.session_id;
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?1 AND user_id = ?2').bind(deviceId, session.user_id).run();
  return json({ ok: true, id: deviceId, current }, current ? { headers: { 'set-cookie': clearSessionCookie(env) } } : {});
}

async function updateAccount(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  const updates = [];
  const bindings = [];
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
    updates.push(`email = ?${bindings.length + 1}`); bindings.push(email);
  }
  if (body.password) {
    if (String(body.password).length < 10) throw new HttpError(400, 'Password must contain at least 10 characters.', 'invalid_password');
    const passwordRecord = await hashPassword(String(body.password));
    updates.push(`password_hash = ?${bindings.length + 1}`); bindings.push(passwordRecord.hash);
    updates.push(`password_salt = ?${bindings.length + 1}`); bindings.push(passwordRecord.salt);
    updates.push(`password_iterations = ?${bindings.length + 1}`); bindings.push(passwordRecord.iterations);
  }
  if (!updates.length) throw new HttpError(400, 'No account changes were provided.', 'no_changes');
  updates.push(`updated_at = ?${bindings.length + 1}`); bindings.push(nowIso());
  bindings.push(session.user_id);
  try { await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?${bindings.length}`).bind(...bindings).run(); }
  catch { throw new HttpError(409, 'That email address is already in use.', 'email_in_use'); }
  return json({ ok: true });
}

async function deleteAccount(request, env) {
  const session = await requireSession(request, env);
  const body = await readJson(request);
  if (String(body.confirmation || '').toLowerCase() !== String(session.username).toLowerCase()) {
    throw new HttpError(400, 'Type your username to confirm account deletion.', 'confirmation_required');
  }
  await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(session.user_id).run();
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie(env) } });
}

export async function handleAuthRoute(request, env, url) {
  const path = url.pathname;
  if (path === '/api/auth/session' && request.method === 'GET') return json({ ok: true, ...(await authContext(request, env)) });
  if (path === '/api/auth/signup' && request.method === 'POST') return signUp(request, env);
  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/auth/login/totp' && request.method === 'POST') return finishTotpLogin(request, env);
  if (path === '/api/auth/logout' && request.method === 'POST') {
    await deleteSession(request, env);
    return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie(env) } });
  }
  if (path === '/api/auth/account' && request.method === 'PATCH') return updateAccount(request, env);
  if (path === '/api/auth/account' && request.method === 'DELETE') return deleteAccount(request, env);
  if (path === '/api/security/totp/setup' && request.method === 'POST') return startTotpSetup(request, env);
  if (path === '/api/security/totp/verify' && request.method === 'POST') return verifyTotpSetup(request, env);
  if (path === '/api/security/totp' && request.method === 'DELETE') return disableTotp(request, env);
  if (path === '/api/security/devices' && request.method === 'GET') return devices(request, env);
  const deviceMatch = path.match(/^\/api\/security\/devices\/([^/]+)$/);
  if (deviceMatch && request.method === 'DELETE') return signOutDevice(request, env, deviceMatch[1]);
  return null;
}

export { publicUser };
