const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin'
});

export class HttpError extends Error {
  constructor(status, message, code = 'request_error', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return Response.json(data, { ...init, headers });
}

export function apiError(error, requestId) {
  if (error instanceof HttpError) {
    return json({ ok: false, error: { code: error.code, message: error.message, details: error.details }, requestId }, { status: error.status });
  }
  console.error(JSON.stringify({ level: 'error', requestId, message: error?.message || String(error), stack: error?.stack || '' }));
  return json({ ok: false, error: { code: 'internal_error', message: 'An unexpected server error occurred.' }, requestId }, { status: 500 });
}

export async function readJson(request, maxBytes = 32_768) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json.', 'unsupported_media_type');
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw new HttpError(413, 'Request body is too large.', 'payload_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new HttpError(413, 'Request body is too large.', 'payload_too_large');
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new HttpError(400, 'Request body contains invalid JSON.', 'invalid_json'); }
}

export function assertSameOrigin(request, env) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
  const requestUrl = new URL(request.url);
  const requestHost = requestUrl.hostname;
  if (requestHost === 'localhost' || requestHost === '127.0.0.1' || requestHost === '[::1]') return;
  const origin = request.headers.get('origin');
  const allowedUrl = new URL(env.APP_ORIGIN);
  const allowed = allowedUrl.origin;
  try {
    const originUrl = new URL(origin);
    if (requestUrl.protocol === 'http:' && requestUrl.hostname === allowedUrl.hostname && originUrl.protocol === 'http:' && originUrl.hostname === allowedUrl.hostname) return;
  } catch {}
  if (origin && origin !== allowed && !origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:')) {
    throw new HttpError(403, 'The request origin is not allowed.', 'invalid_origin');
  }
}

export function getCookie(request, name) {
  const cookies = request.headers.get('cookie') || '';
  for (const part of cookies.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function sessionCookie(env, value, maxAge = 60 * 60 * 24 * 30) {
  const secure = new URL(env.APP_ORIGIN).protocol === 'https:' ? '; Secure' : '';
  return `${env.SESSION_COOKIE || 'ms_session'}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

export function clearSessionCookie(env) {
  return sessionCookie(env, '', 0);
}

export function safeRedirectPath(value, fallback = '/multistreams') {
  const path = String(value || '');
  return path.startsWith('/') && !path.startsWith('//') ? path : fallback;
}

export function clampInt(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function sanitizeUrl(value, allowedHosts = []) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    if (allowedHosts.length && !allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return '';
    return url.toString();
  } catch { return ''; }
}
