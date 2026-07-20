import { HttpError, json } from '../lib/http.js';
import { nowIso, requireSession } from '../lib/db.js';
import { randomId } from '../lib/crypto.js';

const TYPES = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']
]);

async function uploadProfileMedia(request, env) {
  const session = await requireSession(request, env);
  const type = new URL(request.url).searchParams.get('type') === 'banner' ? 'banner' : 'avatar';
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Choose an image to upload.', 'file_required');
  const extension = TYPES.get(file.type);
  if (!extension) throw new HttpError(415, 'Use a JPG, PNG, WebP, or GIF image.', 'unsupported_image_type');
  const maximum = type === 'banner' ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
  if (file.size < 1 || file.size > maximum) throw new HttpError(413, `${type === 'banner' ? 'Banner' : 'Profile'} images must be smaller than ${maximum / 1024 / 1024} MB.`, 'image_too_large');
  const key = `profiles/${session.user_id}/${type}-${randomId(12)}.${extension}`;
  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { owner: session.user_id, type }
  });
  const url = `${new URL(env.APP_ORIGIN).origin}/api/media/${key}`;
  const column = type === 'banner' ? 'banner_url' : 'avatar_url';
  await env.DB.prepare(`UPDATE users SET ${column} = ?1, updated_at = ?2 WHERE id = ?3`).bind(url, nowIso(), session.user_id).run();
  return json({ ok: true, type, url });
}

async function getMedia(env, key) {
  const object = await env.MEDIA.get(key);
  if (!object) throw new HttpError(404, 'Image not found.', 'media_not_found');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
}

export async function handleMediaRoute(request, env, url) {
  if (url.pathname === '/api/uploads/profile' && request.method === 'POST') return uploadProfileMedia(request, env);
  if (url.pathname.startsWith('/api/media/') && request.method === 'GET') return getMedia(env, decodeURIComponent(url.pathname.slice('/api/media/'.length)));
  return null;
}
