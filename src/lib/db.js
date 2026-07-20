import { HttpError, getCookie } from './http.js';
import { randomId, sha256 } from './crypto.js';

export function nowIso() { return new Date().toISOString(); }

export async function requireSession(request, env) {
  const session = await optionalSession(request, env);
  if (!session) throw new HttpError(401, 'Sign in is required.', 'authentication_required');
  return session;
}

export async function optionalSession(request, env) {
  const token = getCookie(request, env.SESSION_COOKIE || 'ms_session');
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT s.id AS session_id, s.user_id, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2
  `).bind(tokenHash, nowIso()).first();
  if (!row) return null;
  return { token, ...row };
}

export async function createSession(request, env, userId) {
  const token = randomId(32);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, user_agent, ip_hash, created_at, last_seen_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
  `).bind(randomId(), userId, await sha256(token), (request.headers.get('user-agent') || '').slice(0, 400), await sha256(ip), createdAt, expiresAt).run();
  return token;
}

export async function deleteSession(request, env) {
  const token = getCookie(request, env.SESSION_COOKIE || 'ms_session');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
}

export async function rateLimit(env, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT count, window_started_at FROM rate_limits WHERE key = ?1 AND expires_at > ?2').bind(key, now).first();
  if (!row) {
    await env.DB.prepare(`INSERT INTO rate_limits (key, count, window_started_at, expires_at) VALUES (?1, 1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET count = 1, window_started_at = excluded.window_started_at, expires_at = excluded.expires_at`)
      .bind(key, now, now + windowSeconds).run();
    return;
  }
  if (Number(row.count) >= limit) throw new HttpError(429, 'Too many requests. Please wait and try again.', 'rate_limited');
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?1').bind(key).run();
}

export async function cacheGet(env, key) {
  const row = await env.DB.prepare('SELECT payload_json FROM api_cache WHERE key = ?1 AND expires_at > ?2').bind(key, Math.floor(Date.now() / 1000)).first();
  if (!row) return null;
  try { return JSON.parse(row.payload_json); } catch { return null; }
}

export async function cachePut(env, key, value, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO api_cache (key, payload_json, expires_at, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
    .bind(key, JSON.stringify(value), now + ttlSeconds, nowIso()).run();
  return value;
}

export function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

