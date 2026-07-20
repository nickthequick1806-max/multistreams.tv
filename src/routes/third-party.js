import { HttpError, json } from '../lib/http.js';
import { cacheGet, cachePut, rateLimit } from '../lib/db.js';
import { sha256 } from '../lib/crypto.js';

async function throttle(request, env, scope) {
  const address = request.headers.get('cf-connecting-ip') || 'local';
  await rateLimit(env, `third-party:${scope}:${await sha256(address)}`, 40, 300);
}

async function scrapeCreators(env, path, cacheKey, ttlSeconds) {
  if (!env.SCRAPECREATORS_API_KEY) throw new HttpError(503, 'This content provider is not configured.', 'provider_not_configured');
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  const response = await fetch(`https://api.scrapecreators.com${path}`, { headers: { 'x-api-key': env.SCRAPECREATORS_API_KEY, accept: 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, 'The content provider could not complete this request.', 'provider_api_error');
  return cachePut(env, cacheKey, payload, ttlSeconds);
}

function normalizeRumbleSearch(payload, limit) {
  const rows = payload.results || payload.videos || payload.items || [];
  return rows.slice(0, limit).map(item => {
    const channel = item.channel || item.creator || {};
    const username = channel.slug || item.channelSlug || item.slug || channel.username || '';
    return {
      id: String(item.id || channel.id || username), platform: 'rumble', name: username,
      username, displayName: channel.name || channel.title || item.channelTitle || item.title || username || 'Rumble channel',
      avatar: channel.thumbnail || channel.avatar || item.channelThumbnail || item.thumbnail || '',
      thumbnail: item.thumbnail || channel.thumbnail || '', title: item.title || '',
      live: Boolean(item.live || item.is_live), viewers: Number(item.viewers || item.watching_now || 0),
      url: item.url || (username ? `https://rumble.com/c/${encodeURIComponent(username)}` : '')
    };
  }).filter(item => item.name || item.url);
}

export async function handleThirdPartyRoute(request, env, url) {
  if (request.method !== 'GET') return null;
  if (url.pathname === '/api/third-party/rumble/video') {
    await throttle(request, env, 'rumble-video');
    const value = String(url.searchParams.get('url') || url.searchParams.get('id') || '').trim().slice(0, 500);
    if (!value) throw new HttpError(400, 'A Rumble URL or video ID is required.', 'rumble_video_required');
    const isUrl = /^https?:\/\//i.test(value);
    if (isUrl && !/^https?:\/\/(?:www\.)?rumble\.com\//i.test(value)) throw new HttpError(400, 'Only Rumble video URLs are supported.', 'invalid_rumble_url');
    const parameter = isUrl ? `url=${encodeURIComponent(value)}` : `id=${encodeURIComponent(value)}`;
    return json({ ok: true, data: await scrapeCreators(env, `/v1/rumble/video?${parameter}`, `scrape:rumble:video:${await sha256(value)}`, 300) });
  }
  if (url.pathname === '/api/third-party/rumble/search') {
    await throttle(request, env, 'rumble-search');
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 120);
    if (query.length < 2) return json({ ok: true, items: [] });
    const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 10));
    const payload = await scrapeCreators(env, `/v1/rumble/search?query=${encodeURIComponent(query)}`, `scrape:rumble:search:${query.toLowerCase()}`, 120);
    return json({ ok: true, items: normalizeRumbleSearch(payload, limit) });
  }
  if (url.pathname === '/api/third-party/youtube/shorts/trending') {
    await throttle(request, env, 'youtube-shorts');
    const payload = await scrapeCreators(env, '/v1/youtube/shorts/trending', 'scrape:youtube:shorts:trending', 300);
    return json(payload, { headers: { 'cache-control': 'public, max-age=60, s-maxage=300' } });
  }
  return null;
}
