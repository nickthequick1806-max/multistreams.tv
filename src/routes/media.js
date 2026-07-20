import { HttpError, json } from '../lib/http.js';
import { nowIso, requireSession } from '../lib/db.js';
import { randomId } from '../lib/crypto.js';

const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAXIMUM_BYTES = 900 * 1024;

function mediaKeyFromUrl(value, origin) {
  if (!value) return '';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/media/')) return '';
    return decodeURIComponent(url.pathname.slice('/api/media/'.length));
  } catch {
    return '';
  }
}

async function uploadProfileMedia(request, env) {
  const session = await requireSession(request, env);
  const type = new URL(request.url).searchParams.get('type') === 'banner' ? 'banner' : 'avatar';
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Choose an image to upload.', 'file_required');
  if (!TYPES.has(file.type)) throw new HttpError(415, 'Use a JPG, PNG, WebP, or GIF image.', 'unsupported_image_type');
  if (file.size < 1 || file.size > MAXIMUM_BYTES) {
    throw new HttpError(413, `${type === 'banner' ? 'Banner' : 'Profile'} images must be smaller than 900 KB.`, 'image_too_large');
  }
  const key = `profiles/${session.user_id}/${type}-${randomId(12)}`;
  const body = new Uint8Array(await file.arrayBuffer());
  const url = `${new URL(env.APP_ORIGIN).origin}/api/media/${key}`;
  const column = type === 'banner' ? 'banner_url' : 'avatar_url';
  const previous = await env.DB.prepare(`SELECT ${column} AS media_url FROM users WHERE id = ?1`).bind(session.user_id).first();
  const previousKey = mediaKeyFromUrl(previous?.media_url, new URL(env.APP_ORIGIN).origin);
  const statements = [
    env.DB.prepare(`INSERT INTO profile_media (key, user_id, media_type, content_type, body, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(key, session.user_id, type, file.type, body, nowIso()),
    env.DB.prepare(`UPDATE users SET ${column} = ?1, updated_at = ?2 WHERE id = ?3`).bind(url, nowIso(), session.user_id)
  ];
  if (previousKey) statements.push(env.DB.prepare('DELETE FROM profile_media WHERE key = ?1 AND user_id = ?2').bind(previousKey, session.user_id));
  await env.DB.batch(statements);
  return json({ ok: true, type, url });
}

async function getMedia(env, key) {
  const object = await env.DB.prepare('SELECT content_type, body FROM profile_media WHERE key = ?1').bind(key).first();
  if (!object?.body) throw new HttpError(404, 'Image not found.', 'media_not_found');
  const body = Array.isArray(object.body)
    ? new Uint8Array(object.body)
    : ArrayBuffer.isView(object.body)
      ? new Uint8Array(object.body.buffer, object.body.byteOffset, object.body.byteLength)
      : object.body;
  const headers = new Headers({ 'content-type': object.content_type || 'application/octet-stream' });
  headers.set('etag', `"${key}"`);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(body, { headers });
}

export async function handleMediaRoute(request, env, url) {
  if (url.pathname === '/api/uploads/profile' && request.method === 'POST') return uploadProfileMedia(request, env);
  if (url.pathname.startsWith('/api/media/') && request.method === 'GET') return getMedia(env, decodeURIComponent(url.pathname.slice('/api/media/'.length)));
  return null;
}
