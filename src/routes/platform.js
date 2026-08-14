import { HttpError, json } from '../lib/http.js';
import { browse, channelDetail, featured, followingLive, globalSearch, PLATFORM_CAPABILITIES } from '../platforms.js';

export async function handlePlatformRoute(request, env, url) {
  if (url.pathname === '/api/platform/capabilities' && request.method === 'GET') return json({ ok: true, capabilities: PLATFORM_CAPABILITIES });
  if (url.pathname === '/api/following/live' && request.method === 'GET') return json({ ok: true, ...(await followingLive(request, env)) });
  if (url.pathname === '/api/featured' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') || 20);
    return json({ ok: true, items: await featured(env, Math.max(1, Math.min(20, limit))) }, { headers: { 'cache-control': 'public, max-age=30, s-maxage=60' } });
  }
  if (url.pathname === '/api/search/global' && request.method === 'GET') {
    return json({ ok: true, items: await globalSearch(env, url.searchParams.get('q'), Number(url.searchParams.get('limit') || 20)) });
  }
  const browseMatch = url.pathname.match(/^\/api\/browse\/(twitch|youtube|kick|rumble)$/);
  if (browseMatch && request.method === 'GET') {
    const view = url.searchParams.get('view') || 'live';
    if (!['live', 'categories', 'category-stats', 'clips'].includes(view)) throw new HttpError(400, 'Browse view must be live, categories, category-stats, or clips.', 'invalid_browse_view');
    return json({ ok: true, ...(await browse(env, browseMatch[1], view, {
      limit: url.searchParams.get('limit'), query: url.searchParams.get('q'), categoryId: url.searchParams.get('categoryId'), broadcasterId: url.searchParams.get('broadcasterId'),
      channelId: url.searchParams.get('channelId'), chart: url.searchParams.get('chart'), cursor: url.searchParams.get('cursor')
    })) });
  }
  const channelMatch = url.pathname.match(/^\/api\/channel\/(twitch|youtube|kick|rumble)\/([^/]+)$/);
  if (channelMatch && request.method === 'GET') return json({ ok: true, channel: await channelDetail(env, channelMatch[1], decodeURIComponent(channelMatch[2])) });
  return null;
}
