import { HttpError, clampInt } from './lib/http.js';
import { cacheGet, cachePut, nowIso, optionalSession, parseJson, requireSession } from './lib/db.js';
import { decrypt, encrypt } from './lib/crypto.js';

const PLATFORM_CAPABILITIES = Object.freeze({
  twitch: { oauth: true, follows: true, live: true, categories: true, clips: true, search: true },
  youtube: { oauth: true, follows: true, live: true, categories: true, clips: true, search: true, followsNote: 'YouTube has no followed-live feed; subscriptions are checked individually and may be quota-limited.' },
  kick: { oauth: true, follows: false, live: true, categories: true, clips: false, search: false, followsNote: 'Kick’s official API does not expose the viewer’s followed channels.', clipsNote: 'Kick’s official API does not expose clips.' },
  rumble: { oauth: false, follows: false, live: 'connected-creator-only', categories: false, clips: false, search: false, oauthNote: 'Rumble provides a private creator Live Stream API URL instead of public OAuth.', followsNote: 'Rumble does not expose a followed-channel API.', browseNote: 'Rumble does not expose an official public browse API.' }
});

function compactNumber(value) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function availableNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function twitchThumbnail(value, width = 640, height = 360) {
  return String(value || '').replace('{width}', String(width)).replace('{height}', String(height));
}

async function appToken(env, platform) {
  if (platform === 'twitch' && env.TWITCH_APP_ACCESS_TOKEN) return env.TWITCH_APP_ACCESS_TOKEN;
  const key = `${platform}:app-token`;
  const cached = await cacheGet(env, key);
  if (cached?.ciphertext) {
    try { return await decrypt(cached.ciphertext, env.TOKEN_ENCRYPTION_KEY); } catch {}
  }
  const isTwitch = platform === 'twitch';
  const endpoint = isTwitch ? 'https://id.twitch.tv/oauth2/token' : 'https://id.kick.com/oauth/token';
  const clientId = isTwitch ? env.TWITCH_CLIENT_ID : env.KICK_CLIENT_ID;
  const clientSecret = isTwitch ? env.TWITCH_CLIENT_SECRET : env.KICK_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new HttpError(503, `${platform} API credentials are not configured.`, 'platform_not_configured');
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new HttpError(502, `${platform} app authentication failed.`, 'platform_auth_failed');
  await cachePut(env, key, { ciphertext: await encrypt(payload.access_token, env.TOKEN_ENCRYPTION_KEY) }, Math.max(60, Number(payload.expires_in || 3600) - 120));
  return payload.access_token;
}

async function twitchApi(env, path, accessToken) {
  const token = accessToken || await appToken(env, 'twitch');
  const response = await fetch(`https://api.twitch.tv/helix${path}`, { headers: { authorization: `Bearer ${token}`, 'client-id': env.TWITCH_CLIENT_ID } });
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, `Twitch API request failed (${response.status}).`, 'twitch_api_error');
  return response.json();
}

async function kickApi(env, path, accessToken) {
  const token = accessToken || await appToken(env, 'kick');
  const response = await fetch(`https://api.kick.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, `Kick API request failed (${response.status}).`, 'kick_api_error');
  return response.json();
}

async function youtubeApi(env, path, accessToken) {
  const publicCacheKey = accessToken ? '' : `youtube:response:v4:${path}`;
  if (publicCacheKey) {
    const cached = await cacheGet(env, publicCacheKey);
    if (cached) return cached;
  }
  const keys = accessToken ? [''] : [...new Set([env.YOUTUBE_API_KEY, env.YOUTUBE_API_KEY_FALLBACK].filter(Boolean))];
  if (!accessToken && !keys.length) throw new HttpError(503, 'YouTube Data API is not configured.', 'platform_not_configured');
  let lastFailure = null;
  for (const key of keys) {
    const url = new URL(`https://www.googleapis.com/youtube/v3${path}`);
    const headers = {};
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    else url.searchParams.set('key', key);
    const response = await fetch(url, { headers });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      if (publicCacheKey) {
        const isSearch = path.startsWith('/search?');
        const isLiveSearch = isSearch && /(?:^|[?&])eventType=live(?:&|$)/.test(path);
        const ttl = isLiveSearch ? 300 : isSearch ? 1800 : path.startsWith('/videoCategories?') ? 86400 : 900;
        await cachePut(env, publicCacheKey, payload, ttl);
      }
      return payload;
    }
    lastFailure = { response, payload };
    if (accessToken || ![400, 403].includes(response.status)) break;
  }
  const reason = lastFailure?.payload?.error?.errors?.[0]?.reason || '';
  const status = lastFailure?.response?.status || 502;
  const quotaLimited = status === 429 || status === 403 && /quota|rateLimit/i.test(reason);
  throw new HttpError(quotaLimited ? 429 : 502, quotaLimited ? 'YouTube data is temporarily using its cached results. Please try again shortly.' : `YouTube API request failed (${reason || status}).`, quotaLimited ? 'youtube_rate_limited' : 'youtube_api_error');
}

async function connection(env, userId, platform) {
  return env.DB.prepare('SELECT * FROM oauth_connections WHERE user_id = ?1 AND platform = ?2').bind(userId, platform).first();
}

async function connectionToken(env, row) {
  return decrypt(row.access_token, env.TOKEN_ENCRYPTION_KEY);
}

async function refreshConnection(env, row) {
  if (!row.refresh_token) return row;
  if (!row.expires_at || new Date(row.expires_at).getTime() > Date.now() + 120_000) return row;
  const refreshToken = await decrypt(row.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  let endpoint;
  let clientId;
  let clientSecret;
  if (row.platform === 'twitch') { endpoint = 'https://id.twitch.tv/oauth2/token'; clientId = env.TWITCH_CLIENT_ID; clientSecret = env.TWITCH_CLIENT_SECRET; }
  else if (row.platform === 'youtube') { endpoint = 'https://oauth2.googleapis.com/token'; clientId = env.GOOGLE_CLIENT_ID; clientSecret = env.GOOGLE_CLIENT_SECRET; }
  else if (row.platform === 'kick') { endpoint = 'https://id.kick.com/oauth/token'; clientId = env.KICK_CLIENT_ID; clientSecret = env.KICK_CLIENT_SECRET; }
  else return row;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) return row;
  const expiresAt = payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : row.expires_at;
  await env.DB.prepare('UPDATE oauth_connections SET access_token = ?1, refresh_token = ?2, expires_at = ?3, updated_at = ?4 WHERE id = ?5')
    .bind(await encrypt(payload.access_token, env.TOKEN_ENCRYPTION_KEY), payload.refresh_token ? await encrypt(payload.refresh_token, env.TOKEN_ENCRYPTION_KEY) : row.refresh_token, expiresAt, nowIso(), row.id).run();
  return { ...row, access_token: await encrypt(payload.access_token, env.TOKEN_ENCRYPTION_KEY), expires_at: expiresAt };
}

async function twitchUsers(env, ids = [], logins = []) {
  const params = new URLSearchParams();
  [...new Set(ids)].slice(0, 100).forEach(id => params.append('id', id));
  [...new Set(logins)].slice(0, 100).forEach(login => params.append('login', login));
  if (![...params].length) return [];
  return (await twitchApi(env, `/users?${params}`)).data || [];
}

function normalizeTwitchStream(stream, user) {
  return {
    id: stream.id,
    platform: 'twitch',
    name: stream.user_name || stream.user_login,
    username: stream.user_login,
    title: stream.title || '',
    category: stream.game_name || 'Live',
    categoryId: stream.game_id || '',
    viewers: Number(stream.viewer_count) || 0,
    startedAt: stream.started_at || '',
    durationSeconds: stream.started_at ? Math.max(0, Math.floor((Date.now() - new Date(stream.started_at).getTime()) / 1000)) : 0,
    language: stream.language || '',
    tags: stream.tags || [],
    thumbnail: twitchThumbnail(stream.thumbnail_url),
    avatar: user?.profile_image_url || '',
    banner: user?.offline_image_url || '',
    url: `https://www.twitch.tv/${encodeURIComponent(stream.user_login)}`,
    live: true
  };
}

async function twitchLive(env, limit = 40, categoryId = '', query = '') {
  const params = new URLSearchParams({ first: String(Math.min(100, limit)), language: 'en' });
  if (categoryId) params.set('game_id', categoryId);
  if (query) {
    const search = await twitchApi(env, `/search/channels?query=${encodeURIComponent(query)}&first=${Math.min(100, limit)}&live_only=true`);
    const liveChannels = (search.data || []).filter(item => item.is_live);
    if (!liveChannels.length) return [];
    const streamsParams = new URLSearchParams();
    liveChannels.slice(0, 100).forEach(item => streamsParams.append('user_id', item.id));
    const payload = await twitchApi(env, `/streams?${streamsParams}`);
    const users = await twitchUsers(env, (payload.data || []).map(item => item.user_id));
    const byId = new Map(users.map(user => [user.id, user]));
    return (payload.data || []).map(stream => normalizeTwitchStream(stream, byId.get(stream.user_id))).sort((a, b) => b.viewers - a.viewers);
  }
  const payload = await twitchApi(env, `/streams?${params}`);
  const users = await twitchUsers(env, (payload.data || []).map(item => item.user_id));
  const byId = new Map(users.map(user => [user.id, user]));
  return (payload.data || []).map(stream => normalizeTwitchStream(stream, byId.get(stream.user_id))).sort((a, b) => b.viewers - a.viewers);
}

async function twitchCategories(env, limit = 30, query = '') {
  if (query) {
    const payload = await twitchApi(env, `/search/categories?query=${encodeURIComponent(query)}&first=${Math.min(100, limit)}`);
    return (payload.data || []).map(item => ({ id: item.id, platform: 'twitch', name: item.name, image: twitchThumbnail(item.box_art_url, 285, 380), watching: 0, followers: null, tags: [] }));
  }
  const streams = await twitchLive(env, 100);
  const aggregate = new Map();
  for (const stream of streams) {
    const entry = aggregate.get(stream.categoryId) || { id: stream.categoryId, name: stream.category, watching: 0, liveChannels: 0 };
    entry.watching += stream.viewers; entry.liveChannels += 1; aggregate.set(stream.categoryId, entry);
  }
  const ids = [...aggregate.keys()].filter(Boolean);
  const params = new URLSearchParams(); ids.forEach(id => params.append('id', id));
  const games = ids.length ? (await twitchApi(env, `/games?${params}`)).data || [] : [];
  const gamesById = new Map(games.map(game => [game.id, game]));
  return [...aggregate.values()].sort((a, b) => b.watching - a.watching).slice(0, limit).map(item => ({
    ...item, platform: 'twitch', image: twitchThumbnail(gamesById.get(item.id)?.box_art_url, 285, 380), followers: null, tags: []
  }));
}

async function twitchClips(env, limit = 24, categoryId = '', broadcasterId = '') {
  let targetIds = categoryId ? [categoryId] : [];
  if (!targetIds.length && !broadcasterId) targetIds = (await twitchCategories(env, 4)).map(item => item.id).filter(Boolean);
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400_000);
  const batches = broadcasterId ? [broadcasterId] : targetIds;
  const results = await Promise.all(batches.map(async id => {
    const params = new URLSearchParams({ first: String(Math.min(100, limit)), started_at: start.toISOString(), ended_at: end.toISOString() });
    params.set(broadcasterId ? 'broadcaster_id' : 'game_id', id);
    return (await twitchApi(env, `/clips?${params}`)).data || [];
  }));
  const clips = results.flat().sort((a, b) => Number(b.view_count) - Number(a.view_count)).slice(0, limit);
  const users = await twitchUsers(env, clips.map(clip => clip.broadcaster_id));
  const usersById = new Map(users.map(user => [user.id, user]));
  return clips.map(clip => ({
    id: clip.id, platform: 'twitch', title: clip.title || 'Twitch clip', username: clip.broadcaster_name || '', creator: clip.broadcaster_name || '',
    category: '', views: Number(clip.view_count) || 0, duration: Number(clip.duration) || 0, createdAt: clip.created_at || '',
    thumbnail: clip.thumbnail_url || '', avatar: usersById.get(clip.broadcaster_id)?.profile_image_url || '', url: clip.url || '',
    embedUrl: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clip.id)}&parent=${encodeURIComponent(new URL(env.APP_ORIGIN).hostname)}`
  }));
}

async function youtubeVideoDetails(env, ids, accessToken) {
  if (!ids.length) return [];
  return (await youtubeApi(env, `/videos?part=snippet,statistics,contentDetails,liveStreamingDetails,status&id=${encodeURIComponent(ids.slice(0, 50).join(','))}`, accessToken)).items || [];
}

async function youtubeChannels(env, ids, accessToken) {
  if (!ids.length) return [];
  return (await youtubeApi(env, `/channels?part=snippet,statistics,brandingSettings,contentDetails&id=${encodeURIComponent([...new Set(ids)].slice(0, 50).join(','))}`, accessToken)).items || [];
}

function normalizeYoutubeVideo(video, channel, categoryNames = new Map()) {
  const liveDetails = video.liveStreamingDetails || {};
  const isLive = Boolean(liveDetails.actualStartTime && !liveDetails.actualEndTime);
  return {
    id: video.id,
    channelId: video.snippet?.channelId || '',
    platform: 'youtube',
    name: video.snippet?.channelTitle || channel?.snippet?.title || '',
    username: channel?.snippet?.customUrl || video.snippet?.channelId || '',
    title: video.snippet?.title || '',
    category: categoryNames.get(video.snippet?.categoryId) || 'YouTube',
    categoryId: video.snippet?.categoryId || '',
    viewers: availableNumber(liveDetails.concurrentViewers),
    viewerCountAvailable: liveDetails.concurrentViewers !== null && liveDetails.concurrentViewers !== undefined && liveDetails.concurrentViewers !== '',
    views: Number(video.statistics?.viewCount || 0),
    startedAt: liveDetails.actualStartTime || video.snippet?.publishedAt || '',
    durationSeconds: liveDetails.actualStartTime ? Math.floor((Date.now() - new Date(liveDetails.actualStartTime).getTime()) / 1000) : 0,
    tags: video.snippet?.tags?.slice(0, 5) || [],
    thumbnail: video.snippet?.thumbnails?.high?.url || video.snippet?.thumbnails?.medium?.url || '',
    avatar: channel?.snippet?.thumbnails?.high?.url || channel?.snippet?.thumbnails?.default?.url || '',
    banner: channel?.brandingSettings?.image?.bannerExternalUrl || '',
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
    embedUrl: video.status?.embeddable === false ? '' : `https://www.youtube.com/embed/${encodeURIComponent(video.id)}?autoplay=1`,
    live: isLive,
    createdAt: video.snippet?.publishedAt || ''
  };
}

function normalizeCreatorYoutubeVideo(item, forceLive = false) {
  const channel = item.channel || {};
  const badges = Array.isArray(item.badges) ? item.badges.map(badge => String(badge?.text || badge)).join(' ') : '';
  const live = forceLive || item.type === 'live' || /\blive\b/i.test(badges);
  const viewers = availableNumber(item.concurrentViewers, item.concurrentViewersInt, item.viewCountInt, item.viewCount);
  return {
    id: item.id || item.videoId || '',
    channelId: channel.id || item.channelId || '',
    platform: 'youtube',
    name: channel.title || item.channelTitle || item.author || 'YouTube',
    username: String(channel.handle || channel.title || item.channelTitle || '').replace(/^@/, ''),
    title: item.title || 'YouTube livestream',
    category: 'YouTube Live',
    categoryId: '',
    viewers: live ? viewers : null,
    viewerCountAvailable: live && viewers !== null,
    views: Number(item.viewCountInt || item.viewCount || 0),
    startedAt: item.publishedTime || item.publishedAt || '',
    durationSeconds: Number(item.lengthSeconds || 0),
    tags: [],
    thumbnail: item.thumbnail || item.thumbnailUrl || '',
    avatar: channel.thumbnail || channel.avatar || '',
    banner: '',
    url: item.url || `https://www.youtube.com/watch?v=${encodeURIComponent(item.id || item.videoId || '')}`,
    embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(item.id || item.videoId || '')}?autoplay=1`,
    live,
    createdAt: item.publishedTime || item.publishedAt || ''
  };
}

async function youtubeCreatorSearchFallback(env, { limit, query, live, channelId }) {
  const payload = channelId
    ? await creatorSearch(env, `/v1/youtube/channel/lives?channelId=${encodeURIComponent(channelId)}`)
    : await creatorSearch(env, `/v1/youtube/search?query=${encodeURIComponent(query || 'live now')}&sortBy=popular`);
  const candidates = channelId
    ? [...(payload.lives || []), ...(payload.videos || []), ...(payload.contents || [])]
    : [...(payload.lives || []), ...(live ? [] : payload.videos || [])];
  const normalized = candidates
    .map(item => normalizeCreatorYoutubeVideo(item, live))
    .filter(item => item.id)
    .slice(0, Math.min(50, Math.max(limit, 16)));
  if (live && normalized.length) {
    try {
      const videos = await youtubeVideoDetails(env, normalized.map(item => item.id));
      const channels = await youtubeChannels(env, videos.map(video => video.snippet?.channelId).filter(Boolean));
      const byId = new Map(channels.map(channel => [channel.id, channel]));
      const verified = videos
        .map(video => normalizeYoutubeVideo(video, byId.get(video.snippet?.channelId)))
        .filter(video => video.live)
        .sort((a, b) => Number(b.viewers || 0) - Number(a.viewers || 0))
        .slice(0, limit);
      if (verified.length) return verified;
    } catch {}
  }
  if (live) throw new HttpError(429, 'YouTube live results are temporarily unavailable. Please try again shortly.', 'youtube_rate_limited');
  const usable = normalized.slice(0, limit);
  if (!usable.length) throw new HttpError(429, 'YouTube live results are temporarily unavailable. Please try again shortly.', 'youtube_rate_limited');
  return usable;
}

async function youtubeSearchVideos(env, { limit = 24, query = '', live = false, categoryId = '', channelId = '', accessToken } = {}) {
  const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: String(Math.min(50, limit)), order: live ? 'viewCount' : 'viewCount', videoEmbeddable: 'true', safeSearch: 'moderate' });
  if (query) params.set('q', query);
  if (live) params.set('eventType', 'live');
  else params.set('publishedAfter', new Date(Date.now() - 30 * 86400_000).toISOString());
  if (categoryId) params.set('videoCategoryId', categoryId);
  if (channelId) params.set('channelId', channelId);
  let search;
  try {
    search = await youtubeApi(env, `/search?${params}`, accessToken);
  } catch (error) {
    if (error.status === 429 && env.SCRAPECREATORS_API_KEY) {
      return youtubeCreatorSearchFallback(env, { limit, query, live, channelId });
    }
    throw error;
  }
  const ids = (search.items || []).map(item => item.id?.videoId).filter(Boolean);
  const videos = await youtubeVideoDetails(env, ids, accessToken);
  const channels = await youtubeChannels(env, videos.map(video => video.snippet?.channelId).filter(Boolean), accessToken);
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  let categoryNames = new Map();
  try {
    const categoryPayload = await youtubeApi(env, '/videoCategories?part=snippet&regionCode=US', accessToken);
    categoryNames = new Map((categoryPayload.items || []).map(item => [item.id, item.snippet?.title || 'YouTube']));
  } catch {}
  return videos.map(video => normalizeYoutubeVideo(video, byId.get(video.snippet?.channelId), categoryNames));
}

async function youtubeMostPopular(env, limit = 24) {
  const payload = await youtubeApi(env, `/videos?part=snippet,statistics,contentDetails,liveStreamingDetails,status&chart=mostPopular&regionCode=US&maxResults=${Math.min(50, limit)}`);
  const videos = (payload.items || []).filter(video => video.status?.embeddable !== false);
  const channels = await youtubeChannels(env, videos.map(video => video.snippet?.channelId).filter(Boolean));
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  let categoryNames = new Map();
  try {
    const categoryPayload = await youtubeApi(env, '/videoCategories?part=snippet&regionCode=US');
    categoryNames = new Map((categoryPayload.items || []).map(item => [item.id, item.snippet?.title || 'YouTube']));
  } catch {}
  return videos.map(video => normalizeYoutubeVideo(video, byId.get(video.snippet?.channelId), categoryNames));
}

async function youtubeCategories(env, limit = 30, query = '') {
  const categoriesPayload = await youtubeApi(env, '/videoCategories?part=snippet&regionCode=US');
  let categories = (categoriesPayload.items || []).filter(item => item.snippet?.assignable);
  if (query) categories = categories.filter(item => item.snippet?.title?.toLowerCase().includes(query.toLowerCase()));
  let live = [];
  try { live = await youtubeSearchVideos(env, { limit: 50, live: true }); } catch {}
  const counts = new Map();
  const images = new Map();
  for (const video of live) {
    counts.set(video.categoryId, (counts.get(video.categoryId) || 0) + video.viewers);
    if (!images.has(video.categoryId) && video.thumbnail) images.set(video.categoryId, video.thumbnail);
  }
  return categories.map(item => {
    const name = item.snippet?.title || '';
    return { id: item.id, platform: 'youtube', name, image: images.get(item.id) || youtubeCategoryImage(name), watching: null, followers: null, tags: [] };
  })
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

function youtubeCategoryImage(name) {
  const images = {
    'film & animation': 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=570&h=760&q=80',
    'autos & vehicles': 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=570&h=760&q=80',
    music: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=570&h=760&q=80',
    'pets & animals': 'https://images.unsplash.com/photo-1450778869180-41d0601e046e?auto=format&fit=crop&w=570&h=760&q=80',
    sports: 'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=570&h=760&q=80',
    'travel & events': 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=570&h=760&q=80',
    gaming: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=570&h=760&q=80',
    'people & blogs': 'https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=570&h=760&q=80',
    comedy: 'https://images.unsplash.com/photo-1527224857830-43a7acc85260?auto=format&fit=crop&w=570&h=760&q=80',
    entertainment: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=570&h=760&q=80',
    'news & politics': 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=570&h=760&q=80',
    'howto & style': 'https://images.unsplash.com/photo-1452860606245-08befc0ff44b?auto=format&fit=crop&w=570&h=760&q=80',
    education: 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=570&h=760&q=80',
    'science & technology': 'https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=570&h=760&q=80',
    'nonprofits & activism': 'https://images.unsplash.com/photo-1559027615-cd4628902d4a?auto=format&fit=crop&w=570&h=760&q=80'
  };
  return images[String(name || '').toLowerCase()] || 'https://images.unsplash.com/photo-1492724441997-5dc865305da7?auto=format&fit=crop&w=570&h=760&q=80';
}

function normalizeKickLive(item) {
  const channel = item.channel || item.livestream?.channel || {};
  const category = item.category || item.livestream?.category || {};
  const user = item.user || channel.user || {};
  const slug = channel.slug || item.channel_slug || item.slug || user.username || '';
  const viewerCount = availableNumber(item.viewer_count, item.viewers, item.livestream?.viewer_count);
  return {
    id: String(item.id || item.livestream_id || slug), platform: 'kick', name: channel.name || user.username || slug, username: slug,
    title: item.stream_title || item.title || channel.stream_title || '', category: category.name || category.title || 'Live', categoryId: String(category.id || category.category_id || ''),
    viewers: viewerCount, viewerCountAvailable: viewerCount !== null, startedAt: item.start_time || item.created_at || '',
    durationSeconds: item.start_time ? Math.floor((Date.now() - new Date(item.start_time).getTime()) / 1000) : 0,
    tags: item.custom_tags || category.tags || [], thumbnail: item.thumbnail || item.thumbnail_url || channel.thumbnail || '',
    avatar: '', banner: channel.banner_image || channel.banner || '',
    url: `https://kick.com/${encodeURIComponent(slug)}`, live: true
  };
}

async function kickLive(env, limit = 40, categoryId = '') {
  const params = new URLSearchParams({ limit: String(Math.min(100, limit)), sort: 'viewer_count' });
  if (categoryId) params.set('category_id', categoryId);
  const payload = await kickApi(env, `/public/v2/livestreams?${params}`);
  const rows = payload.data || payload.livestreams || [];
  return rows.map(normalizeKickLive).sort((a, b) => b.viewers - a.viewers).slice(0, limit);
}

async function kickCategories(env, limit = 30, query = '') {
  const params = new URLSearchParams({ limit: String(Math.min(100, limit)) });
  if (query) params.set('q', query);
  const payload = await kickApi(env, `/public/v2/categories?${params}`);
  const rows = payload.data || payload.categories || [];
  return rows.map(item => ({ id: String(item.id || item.category_id || ''), platform: 'kick', name: item.name || item.title || '', image: item.thumbnail || item.thumbnail_url || item.banner || '', watching: null, followers: Number(item.followers || 0) || null, tags: item.tags || [] })).slice(0, limit);
}

async function channelDetail(env, platform, identifier, options = {}) {
  const normalized = String(identifier || '').trim().replace(/^@/, '');
  if (!normalized) throw new HttpError(400, 'A channel name is required.', 'channel_required');
  if (platform === 'twitch') {
    const users = await twitchUsers(env, [], [normalized]);
    const user = users[0];
    if (!user) throw new HttpError(404, 'Twitch channel not found.', 'channel_not_found');
    const streams = await twitchLive(env, 1, '', user.login);
    const stream = streams.find(item => item.username.toLowerCase() === user.login.toLowerCase()) || null;
    const channel = (await twitchApi(env, `/channels?broadcaster_id=${encodeURIComponent(user.id)}`)).data?.[0] || {};
    return { platform, id: user.id, username: user.login, name: user.display_name, description: user.description || '', avatar: user.profile_image_url || '', banner: user.offline_image_url || '', followers: null, live: Boolean(stream), stream, category: stream?.category || channel.game_name || '', title: stream?.title || channel.title || '', viewers: stream?.viewers || 0, url: `https://www.twitch.tv/${encodeURIComponent(user.login)}`, socials: [{ platform: 'twitch', url: `https://www.twitch.tv/${encodeURIComponent(user.login)}` }] };
  }
  if (platform === 'youtube') {
    let channel;
    let requestedVideo = null;
    if (/^[A-Za-z0-9_-]{11}$/.test(normalized)) {
      const video = (await youtubeVideoDetails(env, [normalized]))[0];
      if (!video) throw new HttpError(404, 'YouTube video not found.', 'video_not_found');
      channel = (await youtubeChannels(env, [video.snippet?.channelId].filter(Boolean)))[0];
      requestedVideo = normalizeYoutubeVideo(video, channel);
    } else if (/^UC[A-Za-z0-9_-]{20,}$/.test(normalized)) channel = (await youtubeChannels(env, [normalized]))[0];
    else {
      const handlePayload = await youtubeApi(env, `/channels?part=snippet,statistics,brandingSettings&forHandle=${encodeURIComponent(normalized)}`);
      channel = handlePayload.items?.[0] || null;
      if (!channel) {
        const search = await youtubeApi(env, `/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(normalized)}`);
        const id = search.items?.[0]?.id?.channelId;
        channel = id ? (await youtubeChannels(env, [id]))[0] : null;
      }
    }
    if (!channel) throw new HttpError(404, 'YouTube channel not found.', 'channel_not_found');
    const streams = requestedVideo?.live || options.skipLiveSearch
      ? (requestedVideo?.live ? [requestedVideo] : [])
      : await youtubeSearchVideos(env, { limit: 1, live: true, channelId: channel.id });
    const stream = streams[0] || null;
    return { platform, id: channel.id, username: channel.snippet?.customUrl || channel.id, name: channel.snippet?.title || '', description: channel.snippet?.description || '', avatar: channel.snippet?.thumbnails?.high?.url || '', banner: channel.brandingSettings?.image?.bannerExternalUrl || '', followers: Number(channel.statistics?.subscriberCount || 0), live: Boolean(stream), stream, requestedVideo, category: stream?.category || requestedVideo?.category || '', title: stream?.title || requestedVideo?.title || '', viewers: stream?.viewers || 0, url: requestedVideo?.url || `https://www.youtube.com/channel/${channel.id}`, socials: [{ platform: 'youtube', url: `https://www.youtube.com/channel/${channel.id}` }] };
  }
  if (platform === 'kick') {
    const params = new URLSearchParams(); params.append('slug', normalized);
    const payload = await kickApi(env, `/public/v1/channels?${params}`);
    const row = payload.data?.[0] || payload.data || null;
    if (!row) throw new HttpError(404, 'Kick channel not found.', 'channel_not_found');
    const live = await kickLive(env, 1, String(row.category?.id || ''));
    const stream = live.find(item => item.username.toLowerCase() === normalized.toLowerCase()) || null;
    return { platform, id: String(row.broadcaster_user_id || row.id || normalized), username: row.slug || normalized, name: row.name || row.slug || normalized, description: row.description || '', avatar: '', banner: row.banner_image || '', followers: Number(row.followers_count || 0) || null, live: Boolean(stream), stream, category: stream?.category || row.category?.name || '', title: stream?.title || row.stream_title || '', viewers: stream?.viewers ?? null, viewerCountAvailable: Boolean(stream?.viewerCountAvailable), url: `https://kick.com/${encodeURIComponent(row.slug || normalized)}`, socials: [{ platform: 'kick', url: `https://kick.com/${encodeURIComponent(row.slug || normalized)}` }] };
  }
  throw new HttpError(501, `${platform} does not expose an official channel lookup API for this feature.`, 'platform_capability_unavailable');
}

async function twitchFollowing(env, row) {
  row = await refreshConnection(env, row);
  const token = await connectionToken(env, row);
  const payload = await twitchApi(env, `/streams/followed?user_id=${encodeURIComponent(row.platform_user_id)}&first=100`, token);
  const users = await twitchUsers(env, (payload.data || []).map(item => item.user_id));
  const byId = new Map(users.map(user => [user.id, user]));
  return (payload.data || []).map(stream => normalizeTwitchStream(stream, byId.get(stream.user_id))).sort((a, b) => b.viewers - a.viewers);
}

async function youtubeFollowing(env, row) {
  const cacheKey = `following:youtube:v4:${row.user_id}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  row = await refreshConnection(env, row);
  const token = await connectionToken(env, row);
  let videoIds = [];
  let checkedSubscriptions = 0;
  let totalSubscriptions = 0;
  let partial = false;
  try {
    const activities = await youtubeApi(env, '/activities?part=snippet,contentDetails&home=true&maxResults=50', token);
    videoIds = [...new Set((activities.items || []).flatMap(item => [
      item.contentDetails?.upload?.videoId,
      item.contentDetails?.playlistItem?.resourceId?.videoId,
      item.contentDetails?.recommendation?.resourceId?.videoId
    ]).filter(Boolean))].slice(0, 50);
    checkedSubscriptions = Number(activities.pageInfo?.totalResults || activities.items?.length || 0);
    totalSubscriptions = checkedSubscriptions;
    partial = Boolean(activities.nextPageToken);
  } catch {
    const subscriptions = await youtubeApi(env, '/subscriptions?part=snippet&mine=true&maxResults=10&order=relevance', token);
    const subscriptionIds = (subscriptions.items || []).map(item => item.snippet?.resourceId?.channelId).filter(Boolean);
    const subscribedChannels = await youtubeChannels(env, subscriptionIds, token);
    const uploads = subscribedChannels.map(channel => channel.contentDetails?.relatedPlaylists?.uploads).filter(Boolean);
    const recentUploads = await Promise.allSettled(uploads.map(playlistId => youtubeApi(env, `/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(playlistId)}&maxResults=2`, token)));
    videoIds = [...new Set(recentUploads.flatMap(result => result.status === 'fulfilled'
      ? (result.value.items || []).map(item => item.contentDetails?.videoId).filter(Boolean)
      : []))].slice(0, 50);
    checkedSubscriptions = subscriptionIds.length;
    totalSubscriptions = Number(subscriptions.pageInfo?.totalResults || subscriptionIds.length);
    partial = Boolean(subscriptions.nextPageToken);
  }
  const videos = await youtubeVideoDetails(env, videoIds, token);
  const channels = await youtubeChannels(env, videos.map(video => video.snippet?.channelId).filter(Boolean), token);
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  const streams = videos
    .map(video => normalizeYoutubeVideo(video, byId.get(video.snippet?.channelId)))
    .filter(video => video.live)
    .sort((a, b) => Number(b.viewers || 0) - Number(a.viewers || 0));
  const result = { streams, checkedSubscriptions, totalSubscriptions, partial };
  return cachePut(env, cacheKey, result, 900);
}

async function rumbleConnectedLive(env, row) {
  const apiUrl = await connectionToken(env, row);
  const response = await fetch(apiUrl, { headers: { accept: 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, 'The connected Rumble Live Stream API URL failed.', 'rumble_api_error');
  return (payload.livestreams || []).filter(item => item.is_live).map(item => ({
    id: String(item.id), platform: 'rumble', name: row.platform_username || String(payload.user_id || 'Rumble creator'), username: row.platform_username || String(payload.user_id || ''),
    title: item.title || '', category: item.categories?.primary?.title || 'Live', categoryId: item.categories?.primary?.slug || '', viewers: Number(item.watching_now || 0),
    startedAt: item.created_on || '', durationSeconds: item.created_on ? Math.floor((Date.now() - new Date(item.created_on).getTime()) / 1000) : 0,
    tags: [], thumbnail: item.thumbnail || '', avatar: '', banner: '', url: item.url || `https://rumble.com/${encodeURIComponent(String(item.id))}`, live: true
  }));
}

export async function followingLive(request, env) {
  const session = await requireSession(request, env);
  const rows = (await env.DB.prepare('SELECT * FROM oauth_connections WHERE user_id = ?1 ORDER BY platform').bind(session.user_id).all()).results || [];
  const streams = [];
  const platformStatus = {};
  for (const row of rows) {
    try {
      if (row.platform === 'twitch') { const result = await twitchFollowing(env, row); streams.push(...result); platformStatus.twitch = { connected: true, count: result.length, complete: true }; }
      else if (row.platform === 'youtube') { const result = await youtubeFollowing(env, row); streams.push(...result.streams); platformStatus.youtube = { connected: true, count: result.streams.length, complete: !result.partial, checkedSubscriptions: result.checkedSubscriptions, totalSubscriptions: result.totalSubscriptions }; }
      else if (row.platform === 'rumble') {
        const metadata = parseJson(row.metadata_json, {});
        if (metadata.connectionType === 'account-popup') platformStatus.rumble = { connected: true, count: 0, complete: false, note: 'Rumble account sign-in confirmed; Rumble does not expose followed-live data.' };
        else { const result = await rumbleConnectedLive(env, row); streams.push(...result); platformStatus.rumble = { connected: true, count: result.length, complete: false, note: PLATFORM_CAPABILITIES.rumble.followsNote }; }
      }
      else platformStatus[row.platform] = { connected: true, count: 0, complete: false, note: PLATFORM_CAPABILITIES[row.platform]?.followsNote || 'Following data is unavailable.' };
    } catch (error) {
      platformStatus[row.platform] = { connected: true, count: 0, complete: false, error: error.message };
    }
  }
  streams.sort((a, b) => b.viewers - a.viewers);
  return { streams, liveCount: streams.length, platformStatus, capabilities: PLATFORM_CAPABILITIES };
}

export async function browse(env, platform, view, options = {}) {
  const limit = clampInt(options.limit, 1, 100, view === 'categories' ? 30 : 40);
  const query = String(options.query || '').trim();
  const categoryId = String(options.categoryId || '').trim();
  const channelId = String(options.channelId || '').trim();
  const chart = String(options.chart || '').trim();
  const cacheKey = `browse:v3:${platform}:${view}:${limit}:${categoryId}:${channelId}:${chart}:${query.toLowerCase()}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  let items;
  if (platform === 'twitch' && view === 'live') items = await twitchLive(env, limit, categoryId, query);
  else if (platform === 'twitch' && view === 'categories') items = await twitchCategories(env, limit, query);
  else if (platform === 'twitch' && view === 'clips') items = await twitchClips(env, limit, categoryId, options.broadcasterId);
  else if (platform === 'youtube' && view === 'live') items = await youtubeSearchVideos(env, { limit, query, live: true, categoryId });
  else if (platform === 'youtube' && view === 'categories') items = await youtubeCategories(env, limit, query);
  else if (platform === 'youtube' && view === 'clips' && chart === 'mostPopular') items = await youtubeMostPopular(env, limit);
  else if (platform === 'youtube' && view === 'clips') items = await youtubeSearchVideos(env, { limit, query, categoryId, channelId, live: false });
  else if (platform === 'kick' && view === 'live') items = await kickLive(env, limit, categoryId);
  else if (platform === 'kick' && view === 'categories') items = await kickCategories(env, limit, query);
  else if (platform === 'kick' && view === 'clips') throw new HttpError(501, PLATFORM_CAPABILITIES.kick.clipsNote, 'platform_capability_unavailable');
  else if (platform === 'rumble') throw new HttpError(501, PLATFORM_CAPABILITIES.rumble.browseNote, 'platform_capability_unavailable');
  else throw new HttpError(400, 'Unsupported platform or browse view.', 'invalid_browse_request');
  const result = { platform, view, items, count: items.length, capabilities: PLATFORM_CAPABILITIES[platform] };
  await cachePut(env, cacheKey, result, view === 'live' ? 45 : 300);
  return result;
}

export async function featured(env, limit = 20) {
  const cacheKey = `featured:v4:${limit}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  const config = parseJson(env.FEATURED_CHANNELS_JSON, {});
  const configured = [];
  for (const [platform, names] of Object.entries(config)) for (const name of names || []) configured.push({ platform, name });
  const selected = configured.slice(0, limit);
  const settled = await Promise.allSettled(selected.map(item => channelDetail(env, item.platform, item.name, { skipLiveSearch: item.platform === 'youtube' })));
  const results = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
  const youtubeNames = selected.filter(item => item.platform === 'youtube').map(item => item.name);
  if (youtubeNames.length) {
    try {
      const live = await youtubeSearchVideos(env, { limit: 20, query: youtubeNames.join('|'), live: true });
      for (const channel of results.filter(item => item.platform === 'youtube')) {
        const stream = live.find(item => item.channelId === channel.id);
        if (stream) Object.assign(channel, { live: true, stream, category: stream.category, title: stream.title, viewers: stream.viewers, url: stream.url });
      }
    } catch {}
  }
  results.sort((a, b) => Number(b.live) - Number(a.live) || Number(b.viewers || 0) - Number(a.viewers || 0));
  return cachePut(env, cacheKey, results, 1200);
}

async function creatorSearch(env, path) {
  if (!env.SCRAPECREATORS_API_KEY) throw new HttpError(503, 'The public search fallback is not configured.', 'provider_not_configured');
  const response = await fetch(`https://api.scrapecreators.com${path}`, {
    headers: { 'x-api-key': env.SCRAPECREATORS_API_KEY, accept: 'application/json' }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, 'The public search fallback failed.', 'provider_api_error');
  return payload;
}

async function searchTwitchChannels(env, query, limit) {
  const search = await twitchApi(env, `/search/channels?query=${encodeURIComponent(query)}&first=${limit}`);
  const users = await twitchUsers(env, (search.data || []).map(item => item.id));
  const byId = new Map(users.map(item => [item.id, item]));
  const liveIds = (search.data || []).filter(item => item.is_live).map(item => item.id);
  const streamParams = new URLSearchParams();
  liveIds.forEach(id => streamParams.append('user_id', id));
  const streams = liveIds.length ? (await twitchApi(env, `/streams?${streamParams}`)).data || [] : [];
  const streamsByUserId = new Map(streams.map(stream => [stream.user_id, stream]));
  return (search.data || []).map(item => {
    const stream = streamsByUserId.get(item.id);
    return {
      platform: 'twitch', id: item.id, name: item.display_name, username: item.broadcaster_login,
      avatar: byId.get(item.id)?.profile_image_url || item.thumbnail_url || '', banner: byId.get(item.id)?.offline_image_url || '',
      live: Boolean(stream), category: stream?.game_name || item.game_name || '', viewers: stream ? Number(stream.viewer_count) : null,
      viewerCountAvailable: Boolean(stream && Number.isFinite(Number(stream.viewer_count))),
      url: `https://www.twitch.tv/${encodeURIComponent(item.broadcaster_login)}`
    };
  });
}

function normalizeCreatorYoutubeChannel(item) {
  const id = item.id || item.channelId || '';
  const username = String(item.handle || item.channelName || item.title || id).replace(/^@/, '');
  return {
    platform: 'youtube', id, name: item.channelName || item.title || username, username,
    avatar: item.thumbnail || item.avatar || '', banner: '', live: false, category: '', viewers: null, viewerCountAvailable: false,
    url: id ? `https://www.youtube.com/channel/${encodeURIComponent(id)}` : `https://www.youtube.com/@${encodeURIComponent(username)}`
  };
}

async function searchYoutubeChannels(env, query, limit) {
  try {
    const fallback = await creatorSearch(env, `/v1/youtube/search?query=${encodeURIComponent(query)}&type=channels`);
    return (fallback.channels || []).slice(0, limit).map(normalizeCreatorYoutubeChannel);
  } catch (error) {
    const handlePayload = await youtubeApi(env, `/channels?part=snippet,statistics,brandingSettings&forHandle=${encodeURIComponent(query)}`);
    return (handlePayload.items || []).slice(0, limit).map(channel => ({
      platform: 'youtube', id: channel.id, name: channel.snippet?.title || query, username: channel.snippet?.customUrl || query,
      avatar: channel.snippet?.thumbnails?.high?.url || '', banner: channel.brandingSettings?.image?.bannerExternalUrl || '',
      live: false, category: '', viewers: null, viewerCountAvailable: false,
      url: `https://www.youtube.com/channel/${encodeURIComponent(channel.id)}`
    }));
  }
}

async function searchKickChannels(env, query, limit) {
  const normalized = query.toLowerCase();
  const live = await kickLive(env, 100);
  const matches = live.filter(item => `${item.name} ${item.username}`.toLowerCase().includes(normalized)).slice(0, limit);
  if (!matches.some(item => item.username.toLowerCase() === normalized)) {
    try {
      const exact = await channelDetail(env, 'kick', query);
      matches.unshift(exact);
    } catch {}
  }
  return matches.slice(0, limit).map(item => ({
    platform: 'kick', id: item.id, name: item.name, username: item.username, avatar: '', banner: item.banner || '',
    live: Boolean(item.live), category: item.category || '', viewers: item.viewerCountAvailable && Number.isFinite(Number(item.viewers)) ? Number(item.viewers) : null, viewerCountAvailable: Boolean(item.live && item.viewerCountAvailable),
    url: item.url || `https://kick.com/${encodeURIComponent(item.username)}`
  }));
}

async function searchRumbleChannels(env, query, limit) {
  const payload = await creatorSearch(env, `/v1/rumble/search?query=${encodeURIComponent(query)}`);
  const candidates = [...(payload.channels || []), ...(payload.lives || []), ...(payload.videos || []).map(item => item.channel || {})];
  const unique = new Map();
  for (const item of candidates) {
    const username = item.handle || item.slug || item.username || item.name || '';
    if (!username) continue;
    const key = username.toLowerCase();
    const viewerCount = availableNumber(item.viewers, item.watching_now, item.viewer_count);
    if (!unique.has(key)) unique.set(key, {
      platform: 'rumble', id: String(item.id || username), name: item.name || item.title || username, username,
      avatar: item.thumbnail || item.avatar || '', banner: '', live: Boolean(item.live || item.is_live),
      category: item.category || '', viewers: viewerCount, viewerCountAvailable: Boolean((item.live || item.is_live) && viewerCount !== null),
      url: item.url || `https://rumble.com/c/${encodeURIComponent(username)}`
    });
  }
  return [...unique.values()].slice(0, limit);
}

export async function globalSearch(env, query, limit = 20) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const perPlatform = clampInt(Math.ceil(Number(limit || 20) / 4), 2, 10, 5);
  const cacheKey = `search:global:v3:${q.toLowerCase()}:${perPlatform}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  const settled = await Promise.allSettled([
    searchTwitchChannels(env, q, perPlatform),
    searchYoutubeChannels(env, q, perPlatform),
    searchKickChannels(env, q, perPlatform),
    searchRumbleChannels(env, q, perPlatform)
  ]);
  const results = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  await cachePut(env, cacheKey, results, 120);
  return results;
}

export { PLATFORM_CAPABILITIES, channelDetail };
