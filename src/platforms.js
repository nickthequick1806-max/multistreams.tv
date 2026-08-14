import { HttpError, clampInt } from './lib/http.js';
import { cacheDelete, cacheFindLatest, cacheGet, cacheGetStale, cachePut, nowIso, optionalSession, parseJson, requireSession } from './lib/db.js';
import { decrypt, encrypt, randomId } from './lib/crypto.js';

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

async function appToken(env, platform, forceRefresh = false) {
  const key = `${platform}:app-token`;
  if (!forceRefresh) {
    const cached = await cacheGet(env, key);
    if (cached?.ciphertext) {
      try { return await decrypt(cached.ciphertext, env.TOKEN_ENCRYPTION_KEY); } catch {}
    }
  } else {
    await cacheDelete(env, key);
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
  const request = async token => {
    const response = await fetch(`https://api.twitch.tv/helix${path}`, { headers: { authorization: `Bearer ${token}`, 'client-id': env.TWITCH_CLIENT_ID } });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  };
  let token = accessToken || await appToken(env, 'twitch');
  let result = await request(token);
  if (result.response.status === 401 && !accessToken) {
    token = await appToken(env, 'twitch', true);
    result = await request(token);
  }
  if (!result.response.ok) {
    const status = result.response.status;
    throw new HttpError(status === 401 ? 401 : status === 429 ? 429 : 502, `Twitch API request failed (${status}).`, 'twitch_api_error', {
      providerMessage: String(result.payload?.message || '').slice(0, 200)
    });
  }
  return result.payload;
}

async function kickApi(env, path, accessToken) {
  const request = async token => {
    const response = await fetch(`https://api.kick.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  };
  let token = accessToken || await appToken(env, 'kick');
  let result = await request(token);
  if (result.response.status === 401 && !accessToken) {
    token = await appToken(env, 'kick', true);
    result = await request(token);
  }
  if (!result.response.ok) {
    const status = result.response.status;
    throw new HttpError(status === 401 ? 401 : status === 429 ? 429 : 502, `Kick API request failed (${status}).`, 'kick_api_error', {
      providerMessage: String(result.payload?.message || result.payload?.error || '').slice(0, 200)
    });
  }
  return result.payload;
}

async function youtubeApi(env, path, accessToken) {
  const publicCacheKey = accessToken ? '' : `youtube:response:v5:${path}`;
  let stale = null;
  if (publicCacheKey) {
    const cached = await cacheGet(env, publicCacheKey);
    if (cached) return cached;
    stale = await cacheGetStale(env, publicCacheKey, 86400);
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
        const isScopedLiveSearch = isLiveSearch && /(?:^|[?&])(?:q|channelId|videoCategoryId)=/.test(path);
        const ttl = isLiveSearch ? (isScopedLiveSearch ? 180 : 600) : isSearch ? 1800 : path.startsWith('/videoCategories?') ? 86400 : 900;
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
  if (quotaLimited && stale) return stale;
  if (accessToken && status === 401) throw new HttpError(401, 'YouTube authorization expired. Reconnect YouTube to continue.', 'platform_reauthorization_required');
  throw new HttpError(quotaLimited ? 429 : 502, quotaLimited ? 'YouTube data is temporarily using its cached results. Please try again shortly.' : `YouTube API request failed (${reason || status}).`, quotaLimited ? 'youtube_rate_limited' : 'youtube_api_error');
}

async function connection(env, userId, platform) {
  return env.DB.prepare('SELECT * FROM oauth_connections WHERE user_id = ?1 AND platform = ?2').bind(userId, platform).first();
}

async function connectionToken(env, row) {
  return decrypt(row.access_token, env.TOKEN_ENCRYPTION_KEY);
}

async function refreshConnection(env, row, { force = false } = {}) {
  if (!row.refresh_token) return row;
  if (!force && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now() + 120_000)) return row;
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
  if (!response.ok || !payload.access_token) {
    throw new HttpError(401, `${row.platform} authorization expired. Reconnect the account to continue.`, 'platform_reauthorization_required');
  }
  const expiresAt = payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : row.expires_at;
  const encryptedAccessToken = await encrypt(payload.access_token, env.TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = payload.refresh_token ? await encrypt(payload.refresh_token, env.TOKEN_ENCRYPTION_KEY) : row.refresh_token;
  await env.DB.prepare('UPDATE oauth_connections SET access_token = ?1, refresh_token = ?2, expires_at = ?3, updated_at = ?4 WHERE id = ?5')
    .bind(encryptedAccessToken, encryptedRefreshToken, expiresAt, nowIso(), row.id).run();
  return { ...row, access_token: encryptedAccessToken, refresh_token: encryptedRefreshToken, expires_at: expiresAt };
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
    const params = new URLSearchParams({ first: String(Math.min(100, limit)) });
    // Browse clips stay recent, while profile clips should include the creator's
    // full catalogue so a connected account never appears empty merely because
    // it has not published a clip in the last seven days.
    if (!broadcasterId) {
      params.set('started_at', start.toISOString());
      params.set('ended_at', end.toISOString());
    }
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

async function youtubeChannelByHandle(env, handle, accessToken) {
  const normalized = String(handle || '').trim().replace(/^@/, '');
  if (!normalized) return null;
  const payload = await youtubeApi(env, `/channels?part=snippet,statistics,brandingSettings,contentDetails&forHandle=${encodeURIComponent(normalized)}`, accessToken);
  return payload.items?.[0] || null;
}

async function youtubeChannelVideosBySearch(env, channel, limit = 24, accessToken) {
  const channelId = channel?.id || '';
  if (!channelId) return [];
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    channelId,
    maxResults: String(Math.min(50, limit)),
    order: 'date',
    videoEmbeddable: 'true',
    safeSearch: 'moderate'
  });
  const search = await youtubeApi(env, `/search?${params}`, accessToken);
  const ids = (search.items || []).map(item => item.id?.videoId).filter(Boolean);
  const videos = await youtubeVideoDetails(env, ids, accessToken);
  return videos
    .filter(video => video.status?.embeddable !== false)
    .map(video => normalizeYoutubeVideo(video, channel));
}

async function youtubeChannelUploads(env, channelId, limit = 24, accessToken) {
  const channels = await youtubeChannels(env, [channelId], accessToken);
  const channel = channels[0];
  if (!channel) return [];
  const uploadsId = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (uploadsId) {
    try {
      const playlist = await youtubeApi(env, `/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(uploadsId)}&maxResults=${Math.min(50, limit)}`, accessToken);
      const ids = (playlist.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
      if (ids.length) {
        const videos = await youtubeVideoDetails(env, ids, accessToken);
        const normalized = videos
          .filter(video => video.status?.embeddable !== false)
          .map(video => normalizeYoutubeVideo(video, channel));
        if (normalized.length) return normalized;
      }
    } catch (error) {
      if (error?.code === 'youtube_rate_limited' || error?.code === 'platform_reauthorization_required') throw error;
      // Some valid channels expose an uploads playlist id that playlistItems
      // rejects with playlistNotFound. The channel-scoped search below is the
      // official API fallback for those accounts.
    }
  }
  return youtubeChannelVideosBySearch(env, channel, limit, accessToken);
}

function normalizeYoutubeVideo(video, channel, categoryNames = new Map()) {
  const liveDetails = video.liveStreamingDetails || {};
  const isLive = Boolean(liveDetails.actualStartTime && !liveDetails.actualEndTime);
  const durationMatch = String(video.contentDetails?.duration || '').match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  const recordedDurationSeconds = durationMatch
    ? Number(durationMatch[1] || 0) * 86400 + Number(durationMatch[2] || 0) * 3600 + Number(durationMatch[3] || 0) * 60 + Number(durationMatch[4] || 0)
    : 0;
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
    durationSeconds: liveDetails.actualStartTime
      ? Math.max(0, Math.floor((Date.now() - new Date(liveDetails.actualStartTime).getTime()) / 1000))
      : recordedDurationSeconds,
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

const YOUTUBE_CATEGORY_NAMES = new Map([
  ['1', 'Film & Animation'],
  ['2', 'Autos & Vehicles'],
  ['10', 'Music'],
  ['15', 'Pets & Animals'],
  ['17', 'Sports'],
  ['19', 'Travel & Events'],
  ['20', 'Gaming'],
  ['22', 'People & Blogs'],
  ['23', 'Comedy'],
  ['24', 'Entertainment'],
  ['25', 'News & Politics'],
  ['26', 'Howto & Style'],
  ['27', 'Education'],
  ['28', 'Science & Technology'],
  ['29', 'Nonprofits & Activism']
]);

function creatorNumber(value, text = '') {
  const direct = Number(value);
  const match = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return Number.isFinite(direct) ? direct : null;
  const scale = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[String(match[2] || '').toUpperCase()] || 1;
  return Math.round(Number(match[1]) * scale);
}

function normalizeCreatorYoutubeLive(item, options = {}) {
  const channel = item.channel || {};
  const id = String(item.id || item.videoId || '');
  const channelId = String(channel.id || item.channelId || options.channelId || '');
  const category = options.categoryId ? YOUTUBE_CATEGORY_NAMES.get(String(options.categoryId)) || 'YouTube Live' : 'YouTube Live';
  const viewers = creatorNumber(
    item.concurrentViewers ?? item.concurrentViewersInt,
    item.concurrentViewersText
  );
  const channelHandle = String(channel.handle || channel.title || channelId).replace(/^@/, '');
  return {
    id,
    channelId,
    platform: 'youtube',
    name: channel.title || options.channelName || item.channelTitle || 'YouTube',
    username: channelHandle.startsWith('channel/') ? channelId : channelHandle,
    title: item.title || 'YouTube livestream',
    category,
    categoryId: String(options.categoryId || ''),
    viewers,
    viewerCountAvailable: viewers !== null,
    views: 0,
    startedAt: item.actualStartTime || item.startedAt || '',
    durationSeconds: 0,
    tags: [],
    thumbnail: item.thumbnail || item.thumbnailUrl || '',
    avatar: channel.thumbnail || channel.avatar || options.avatar || '',
    banner: options.banner || '',
    url: item.url || `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
    embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1`,
    live: true,
    createdAt: ''
  };
}

function isCreatorYoutubeLivePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.isLiveNow === true || payload.isLive === true || payload.live === true) return true;
  if (payload.isLiveNow === false || payload.isLive === false || payload.live === false) return false;
  if (payload.actualEndTime || payload.endTime) return false;
  if (payload.durationMs !== undefined && payload.durationMs !== null) return false;
  return /^Started streaming\b/i.test(String(payload.publishDateText || payload.publishedText || ''));
}

async function verifyCreatorYoutubeLiveCandidates(env, candidates, limit, options = {}) {
  const selected = candidates.slice(0, Math.min(30, Math.max(12, limit * 2)));
  if (!selected.length) return [];

  try {
    const videos = await youtubeVideoDetails(env, selected.map(item => item.id));
    if (videos.length) {
      const channels = await youtubeChannels(env, videos.map(video => video.snippet?.channelId).filter(Boolean));
      const channelsById = new Map(channels.map(channel => [channel.id, channel]));
      const candidatesById = new Map(selected.map(item => [item.id, item]));
      return videos
        .map(video => {
          const candidate = candidatesById.get(video.id) || {};
          const verified = normalizeYoutubeVideo(video, channelsById.get(video.snippet?.channelId));
          return {
            ...candidate,
            ...verified,
            avatar: verified.avatar || candidate.avatar || '',
            banner: verified.banner || candidate.banner || ''
          };
        })
        .filter(item => item.live)
        .sort((a, b) => Number(b.viewers || 0) - Number(a.viewers || 0))
        .slice(0, limit);
    }
  } catch {}

  const verified = [];
  for (let offset = 0; offset < selected.length && verified.length < limit; offset += 6) {
    const batch = selected.slice(offset, offset + 6);
    const settled = await Promise.allSettled(batch.map(async candidate => {
      const payload = await creatorSearch(env, `/v1/youtube/video?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${candidate.id}`)}`);
      if (!isCreatorYoutubeLivePayload(payload)) return null;
      const channel = payload.channel || {};
      const current = normalizeCreatorYoutubeLive({
        ...payload,
        id: candidate.id,
        channel: {
          ...candidate.channel,
          ...channel,
          id: channel.id || candidate.channelId,
          title: channel.title || candidate.name,
          thumbnail: channel.thumbnail || candidate.avatar
        }
      }, {
        ...options,
        channelId: channel.id || candidate.channelId || options.channelId,
        channelName: channel.title || candidate.name || options.channelName,
        avatar: channel.thumbnail || candidate.avatar || options.avatar
      });
      return {
        ...candidate,
        ...current,
        viewers: current.viewers,
        viewerCountAvailable: current.viewerCountAvailable,
        startedAt: payload.actualStartTime || payload.startTime || '',
        live: true
      };
    }));
    verified.push(...settled.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value));
  }
  return verified
    .sort((a, b) => Number(b.viewers || 0) - Number(a.viewers || 0))
    .slice(0, limit);
}

async function youtubeCreatorLiveFallback(env, { limit = 24, query = '', categoryId = '', channelId = '', channelName = '' } = {}) {
  const cacheKey = `creator:youtube:live:v3:${limit}:${categoryId}:${channelId}:${query.toLowerCase()}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  const categoryName = categoryId ? YOUTUBE_CATEGORY_NAMES.get(String(categoryId)) || '' : '';
  const searchQuery = query || (categoryName ? `${categoryName} live` : '') || channelName || 'live now';
  const payload = channelId
    ? await creatorSearch(env, `/v1/youtube/channel/lives?channelId=${encodeURIComponent(channelId)}`)
    : await creatorSearch(env, `/v1/youtube/search?query=${encodeURIComponent(searchQuery)}&sortBy=popular`);
  const candidates = [
    ...(payload.lives || []),
    ...(payload.videos || []).filter(item => item.type === 'live' || item.lengthText === 'LIVE' || (item.badges || []).some(badge => /\blive\b/i.test(String(badge?.text || badge))))
  ];
  const unique = new Map();
  for (const item of candidates) {
    const normalized = normalizeCreatorYoutubeLive(item, { categoryId, channelId, channelName });
    if (!normalized.id) continue;
    if (channelId && normalized.channelId && normalized.channelId !== channelId) continue;
    if (!unique.has(normalized.id)) unique.set(normalized.id, normalized);
  }
  const results = await verifyCreatorYoutubeLiveCandidates(
    env,
    [...unique.values()],
    limit,
    { categoryId, channelId, channelName }
  );
  return cachePut(env, cacheKey, results, 30);
}

async function youtubeCreatorChannelDetail(env, identifier) {
  const normalized = String(identifier || '').trim().replace(/^@/, '');
  if (/^[A-Za-z0-9_-]{11}$/.test(normalized)) {
    const payload = await creatorSearch(env, `/v1/youtube/video?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${normalized}`)}`);
    const channel = payload.channel || {};
    const live = isCreatorYoutubeLivePayload(payload);
    const requestedVideo = {
      ...normalizeCreatorYoutubeLive({ ...payload, id: normalized, channel }, { channelId: channel.id, channelName: channel.title, avatar: channel.thumbnail }),
      live,
      viewers: null,
      viewerCountAvailable: false,
      durationSeconds: live ? 0 : Math.max(0, Math.floor(Number(payload.durationMs || 0) / 1000)),
      category: payload.genre || 'YouTube',
      categoryId: '',
      views: Number(payload.viewCountInt || 0),
      createdAt: payload.publishDate || '',
      startedAt: ''
    };
    const stream = live ? requestedVideo : null;
    return {
      platform: 'youtube',
      id: channel.id || requestedVideo.channelId,
      username: String(channel.handle || channel.id || '').replace(/^@/, ''),
      name: channel.title || requestedVideo.name,
      description: payload.description || '',
      avatar: channel.thumbnail || '',
      banner: '',
      followers: null,
      live,
      stream,
      requestedVideo,
      category: requestedVideo.category,
      title: requestedVideo.title,
      viewers: 0,
      url: requestedVideo.url,
      socials: [{ platform: 'youtube', url: channel.id ? `https://www.youtube.com/channel/${channel.id}` : requestedVideo.url }]
    };
  }

  const lookupPath = /^UC[A-Za-z0-9_-]{20,}$/.test(normalized)
    ? `/v1/youtube/channel?channelId=${encodeURIComponent(normalized)}`
    : `/v1/youtube/channel?url=${encodeURIComponent(`https://www.youtube.com/@${normalized}`)}`;
  const channel = await creatorSearch(env, lookupPath);
  const channelId = String(channel.channelId || channel.id || '');
  if (!channelId) throw new HttpError(404, 'YouTube channel not found.', 'channel_not_found');
  let streams = [];
  try {
    streams = await youtubeCreatorLiveFallback(env, { limit: 10, channelId, channelName: channel.name || channel.channel, query: channel.name || normalized });
  } catch {}
  const stream = streams[0] || null;
  const username = String(channel.handle || channel.name || channelId).replace(/^@/, '');
  return {
    platform: 'youtube',
    id: channelId,
    username,
    name: channel.name || channel.channel || username,
    description: channel.description || '',
    avatar: channel.avatar || '',
    banner: channel.banner || '',
    followers: creatorNumber(channel.subscriberCount, channel.subscriberCountText),
    live: Boolean(stream),
    stream,
    requestedVideo: null,
    category: stream?.category || '',
    title: stream?.title || '',
    viewers: stream?.viewers || 0,
    url: `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`,
    socials: [{ platform: 'youtube', url: `https://www.youtube.com/channel/${encodeURIComponent(channelId)}` }]
  };
}

async function youtubeSearchVideos(env, { limit = 24, query = '', live = false, categoryId = '', channelId = '', accessToken } = {}) {
  const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: String(Math.min(50, limit)), order: 'viewCount', videoEmbeddable: 'true', safeSearch: 'moderate' });
  if (query) params.set('q', query);
  if (live) params.set('eventType', 'live');
  else params.set('publishedAfter', new Date(Date.now() - 30 * 86400_000).toISOString());
  if (categoryId) params.set('videoCategoryId', categoryId);
  if (channelId) params.set('channelId', channelId);
  let search;
  try {
    search = await youtubeApi(env, `/search?${params}`, accessToken);
  } catch (error) {
    if (live && error?.code === 'youtube_rate_limited' && env.SCRAPECREATORS_API_KEY) {
      return youtubeCreatorLiveFallback(env, { limit, query, categoryId, channelId });
    }
    if (accessToken || error?.code !== 'youtube_rate_limited') throw error;
    if (channelId && !live) return (await youtubeChannelUploads(env, channelId, limit)).slice(0, limit);
    if (!live) {
      const popular = await youtubeMostPopular(env, Math.max(limit, 24));
      const words = String(query || '').toLowerCase().split(/\s+/).filter(word => word.length > 1);
      const matches = popular.filter(video => {
        if (categoryId && video.categoryId !== categoryId) return false;
        if (!words.length) return true;
        const haystack = `${video.name} ${video.title}`.toLowerCase();
        return words.every(word => haystack.includes(word));
      });
      return (matches.length ? matches : popular).slice(0, limit);
    }
    search = await cacheFindLatest(
      env,
      'youtube:response:v5:/search?',
      ['type=video', 'eventType=live'],
      ['&q=', 'channelId=', 'videoCategoryId='],
      86400
    );
    if (!search) throw error;
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
  const normalized = videos.map(video => normalizeYoutubeVideo(video, byId.get(video.snippet?.channelId), categoryNames));
  const words = String(query || '').toLowerCase().split(/\s+/).filter(word => word.length > 1);
  const matches = normalized.filter(video => {
    if (live && !video.live) return false;
    if (categoryId && video.categoryId !== categoryId) return false;
    if (channelId && video.channelId !== channelId) return false;
    if (!words.length) return true;
    const haystack = `${video.name} ${video.title}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
  return (words.length || channelId || categoryId ? matches : normalized).slice(0, limit);
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
  let categories;
  try {
    const categoriesPayload = await youtubeApi(env, '/videoCategories?part=snippet&regionCode=US');
    categories = (categoriesPayload.items || []).filter(item => item.snippet?.assignable);
  } catch {
    categories = [...YOUTUBE_CATEGORY_NAMES].map(([id, name]) => ({ id, snippet: { title: name, assignable: true } }));
  }
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

async function kickUsers(env, ids = []) {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))].slice(0, 100);
  if (!uniqueIds.length) return [];
  const params = new URLSearchParams();
  uniqueIds.forEach(id => params.append('id', id));
  return (await kickApi(env, `/public/v1/users?${params}`)).data || [];
}

function normalizeKickLive(item, userOverride = null) {
  const channel = item.channel || item.livestream?.channel || {};
  const category = item.category || item.livestream?.category || {};
  const user = userOverride || item.broadcaster_user || item.user || channel.user || {};
  const slug = channel.slug || item.channel_slug || item.slug || user.username || '';
  const viewerCount = availableNumber(item.viewer_count, item.viewers, item.livestream?.viewer_count);
  const viewerCountAvailable = viewerCount !== null && viewerCount > 0;
  const startedAt = item.started_at || item.start_time || item.created_at || '';
  return {
    id: String(item.id || item.livestream_id || slug), broadcasterUserId: String(user.id || user.user_id || item.broadcaster_user_id || ''),
    platform: 'kick', name: user.name || user.username || channel.name || slug, username: slug,
    title: item.stream_title || item.title || channel.stream_title || '', category: category.name || category.title || 'Live', categoryId: String(category.id || category.category_id || ''),
    viewers: viewerCountAvailable ? viewerCount : null, viewerCountAvailable, startedAt,
    durationSeconds: startedAt ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0,
    tags: item.custom_tags || item.tags || category.tags || [], thumbnail: item.thumbnail || item.thumbnail_url || channel.thumbnail || '',
    avatar: user.profile_picture || user.profilePicture || user.avatar || '', banner: channel.banner_picture || channel.banner_image || channel.banner || '',
    url: `https://kick.com/${encodeURIComponent(slug)}`, live: true
  };
}

function normalizeKickChannel(row, user = {}) {
  const slug = String(row.slug || user.username || user.name || '').trim();
  const streamData = row.stream || {};
  const isLive = streamData.is_live === true;
  const rawViewerCount = isLive ? availableNumber(streamData.viewer_count) : null;
  const viewerCountAvailable = isLive && rawViewerCount !== null && rawViewerCount > 0;
  const startedAt = isLive && streamData.start_time && !String(streamData.start_time).startsWith('0001-')
    ? streamData.start_time
    : '';
  const base = {
    platform: 'kick',
    id: String(row.broadcaster_user_id || row.id || user.user_id || slug),
    broadcasterUserId: String(row.broadcaster_user_id || user.user_id || ''),
    username: slug,
    name: user.name || user.username || row.name || slug,
    description: row.channel_description || row.description || '',
    avatar: user.profile_picture || row.profile_picture || '',
    banner: row.banner_picture || row.banner_image || '',
    followers: null,
    live: isLive,
    category: row.category?.name || '',
    categoryId: String(row.category?.id || ''),
    title: row.stream_title || '',
    viewers: viewerCountAvailable ? rawViewerCount : null,
    viewerCountAvailable,
    url: `https://kick.com/${encodeURIComponent(slug)}`,
    socials: [{ platform: 'kick', url: `https://kick.com/${encodeURIComponent(slug)}` }]
  };
  const stream = isLive ? {
    id: String(row.broadcaster_user_id || slug),
    broadcasterUserId: base.broadcasterUserId,
    platform: 'kick',
    name: base.name,
    username: slug,
    title: base.title,
    category: base.category || 'Live',
    categoryId: base.categoryId,
    viewers: base.viewers,
    viewerCountAvailable,
    startedAt,
    durationSeconds: startedAt ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0,
    tags: row.custom_tags || [],
    thumbnail: streamData.thumbnail || '',
    avatar: base.avatar,
    banner: base.banner,
    url: base.url,
    live: true
  } : null;
  return { ...base, stream };
}

async function kickChannelDetail(env, identifier) {
  const normalized = String(identifier || '').trim().replace(/^@/, '').toLowerCase();
  const cacheKey = `kick:channel:v3:${normalized}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  const params = new URLSearchParams(); params.append('slug', normalized);
  const payload = await kickApi(env, `/public/v1/channels?${params}`);
  const row = payload.data?.[0] || null;
  if (!row) throw new HttpError(404, 'Kick channel not found.', 'channel_not_found');
  let user = {};
  const userId = row.broadcaster_user_id || row.id;
  if (userId) {
    try { user = (await kickUsers(env, [userId]))[0] || {}; } catch {}
  }
  const detail = normalizeKickChannel(row, user);
  await cachePut(env, cacheKey, detail, detail.live ? 45 : 300);
  return detail;
}

async function kickLive(env, limit = 40, categoryId = '') {
  const params = new URLSearchParams({ limit: String(Math.min(100, limit)), sort: 'viewer_count' });
  if (categoryId) params.set('category_id', categoryId);
  const payload = await kickApi(env, `/public/v2/livestreams?${params}`);
  const rows = payload.data || payload.livestreams || [];
  const normalized = rows.map(item => normalizeKickLive(item));
  const missingAvatarIds = normalized.filter(item => !item.avatar && item.broadcasterUserId).map(item => item.broadcasterUserId);
  if (missingAvatarIds.length) {
    try {
      const users = await kickUsers(env, missingAvatarIds);
      const usersById = new Map(users.map(user => [String(user.user_id || user.id), user]));
      for (const item of normalized) {
        const user = usersById.get(item.broadcasterUserId);
        if (user && !item.avatar) {
          item.avatar = user.profile_picture || '';
          item.name = user.name || item.name;
        }
      }
    } catch {}
  }
  return normalized.sort((a, b) => Number(b.viewers || 0) - Number(a.viewers || 0)).slice(0, limit);
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
    try {
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
      const streams = requestedVideo
        ? (requestedVideo.live ? [requestedVideo] : [])
        : options.skipLiveSearch
          ? []
          : await youtubeSearchVideos(env, { limit: 1, live: true, channelId: channel.id });
      const stream = streams[0] || null;
      return { platform, id: channel.id, username: channel.snippet?.customUrl || channel.id, name: channel.snippet?.title || '', description: channel.snippet?.description || '', avatar: channel.snippet?.thumbnails?.high?.url || '', banner: channel.brandingSettings?.image?.bannerExternalUrl || '', followers: Number(channel.statistics?.subscriberCount || 0), live: Boolean(stream), stream, requestedVideo, category: stream?.category || requestedVideo?.category || '', title: stream?.title || requestedVideo?.title || '', viewers: stream?.viewers || 0, url: requestedVideo?.url || `https://www.youtube.com/channel/${channel.id}`, socials: [{ platform: 'youtube', url: `https://www.youtube.com/channel/${channel.id}` }] };
    } catch (error) {
      if (env.SCRAPECREATORS_API_KEY && error?.code === 'youtube_rate_limited') return youtubeCreatorChannelDetail(env, normalized);
      throw error;
    }
  }
  if (platform === 'kick') {
    return kickChannelDetail(env, normalized);
  }
  throw new HttpError(501, `${platform} does not expose an official channel lookup API for this feature.`, 'platform_capability_unavailable');
}

async function twitchFollowing(env, row) {
  row = await refreshConnection(env, row);
  let token = await connectionToken(env, row);
  let payload;
  try {
    payload = await twitchApi(env, `/streams/followed?user_id=${encodeURIComponent(row.platform_user_id)}&first=100`, token);
  } catch (error) {
    if (error.status !== 401) throw error;
    row = await refreshConnection(env, row, { force: true });
    token = await connectionToken(env, row);
    payload = await twitchApi(env, `/streams/followed?user_id=${encodeURIComponent(row.platform_user_id)}&first=100`, token);
  }
  const users = await twitchUsers(env, (payload.data || []).map(item => item.user_id));
  const byId = new Map(users.map(user => [user.id, user]));
  return (payload.data || []).map(stream => normalizeTwitchStream(stream, byId.get(stream.user_id))).sort((a, b) => b.viewers - a.viewers);
}

async function runBatches(env, statements, size = 75) {
  for (let index = 0; index < statements.length; index += size) await env.DB.batch(statements.slice(index, index + size));
}

async function syncYoutubeSubscriptions(env, row, accessToken) {
  const subscriptions = [];
  let pageToken = '';
  do {
    const suffix = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const page = await youtubeApi(env, `/subscriptions?part=snippet&mine=true&maxResults=50&order=alphabetical${suffix}`, accessToken);
    subscriptions.push(...(page.items || []));
    pageToken = String(page.nextPageToken || '');
  } while (pageToken);
  const uniqueIds = [...new Set(subscriptions.map(item => item.snippet?.resourceId?.channelId).filter(Boolean))];
  const channelRows = [];
  for (let index = 0; index < uniqueIds.length; index += 50) channelRows.push(...await youtubeChannels(env, uniqueIds.slice(index, index + 50), accessToken));
  const channelById = new Map(channelRows.map(channel => [channel.id, channel]));
  const timestamp = nowIso();
  const statements = [env.DB.prepare('DELETE FROM youtube_subscriptions WHERE user_id = ?1').bind(row.user_id)];
  for (const channelId of uniqueIds) {
    const channel = channelById.get(channelId);
    statements.push(env.DB.prepare(`INSERT INTO youtube_subscriptions
      (user_id, channel_id, channel_title, avatar_url, uploads_playlist_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`)
      .bind(row.user_id, channelId, channel?.snippet?.title || '', channel?.snippet?.thumbnails?.high?.url || channel?.snippet?.thumbnails?.default?.url || '', channel?.contentDetails?.relatedPlaylists?.uploads || '', timestamp));
  }
  await runBatches(env, statements);
  await env.DB.prepare(`DELETE FROM youtube_live_state WHERE user_id = ?1
    AND channel_id NOT IN (SELECT channel_id FROM youtube_subscriptions WHERE user_id = ?1)`).bind(row.user_id).run();
  return uniqueIds.length;
}

export async function syncYoutubeSubscriptionsForUser(env, userId) {
  let row = await env.DB.prepare(`SELECT * FROM oauth_connections WHERE user_id = ?1 AND platform = 'youtube'`).bind(userId).first();
  if (!row) return { count: 0, connected: false };
  row = await refreshConnection(env, row);
  const token = await connectionToken(env, row);
  const count = await syncYoutubeSubscriptions(env, row, token);
  await cacheDelete(env, `following:youtube:v6:${userId}`);
  return { count, connected: true };
}

async function youtubeFollowing(env, row) {
  const cacheKey = `following:youtube:v6:${row.user_id}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  row = await refreshConnection(env, row);
  const token = await connectionToken(env, row);
  let stored = (await env.DB.prepare('SELECT * FROM youtube_subscriptions WHERE user_id = ?1 ORDER BY channel_id').bind(row.user_id).all()).results || [];
  const oldestSync = stored.reduce((oldest, item) => !oldest || item.updated_at < oldest ? item.updated_at : oldest, '');
  if (!stored.length || !oldestSync || Date.now() - new Date(oldestSync).getTime() > 24 * 3600_000) {
    await syncYoutubeSubscriptions(env, row, token);
    stored = (await env.DB.prepare('SELECT * FROM youtube_subscriptions WHERE user_id = ?1 ORDER BY channel_id').bind(row.user_id).all()).results || [];
  }
  const states = (await env.DB.prepare('SELECT * FROM youtube_live_state WHERE user_id = ?1').bind(row.user_id).all()).results || [];
  const discoverySize = Math.min(30, stored.length);
  const discoveryStart = stored.length > discoverySize ? (Math.floor(Date.now() / 600_000) * discoverySize) % stored.length : 0;
  const discovery = stored.length <= discoverySize
    ? stored
    : [...stored.slice(discoveryStart), ...stored.slice(0, discoveryStart)].slice(0, discoverySize);
  const videoIds = states.filter(state => state.is_live && state.video_id).map(state => state.video_id);
  for (let index = 0; index < discovery.length; index += 15) {
    const results = await Promise.allSettled(discovery.slice(index, index + 15).filter(item => item.uploads_playlist_id).map(item =>
      youtubeApi(env, `/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(item.uploads_playlist_id)}&maxResults=2`, token)));
    for (const result of results) if (result.status === 'fulfilled') videoIds.push(...(result.value.items || []).map(item => item.contentDetails?.videoId).filter(Boolean));
  }
  const videos = [];
  const uniqueVideoIds = [...new Set(videoIds)];
  for (let index = 0; index < uniqueVideoIds.length; index += 50) videos.push(...await youtubeVideoDetails(env, uniqueVideoIds.slice(index, index + 50), token));
  const byId = new Map(stored.map(channel => [channel.channel_id, { id: channel.channel_id, snippet: { title: channel.channel_title, thumbnails: { high: { url: channel.avatar_url } } } }]));
  const streams = videos.map(video => normalizeYoutubeVideo(video, byId.get(video.snippet?.channelId)))
    .filter(video => video.live).sort((a, b) => Number(b.viewers || 0) - Number(a.viewers || 0));
  const activeByChannel = new Map(streams.map(stream => [stream.channelId, stream]));
  const timestamp = nowIso();
  const previousByChannel = new Map(states.map(state => [state.channel_id, state]));
  const statements = [];
  const channelsToUpdate = new Map(discovery.map(subscription => [subscription.channel_id, subscription]));
  for (const state of states.filter(state => state.is_live)) {
    const subscription = stored.find(item => item.channel_id === state.channel_id);
    if (subscription) channelsToUpdate.set(subscription.channel_id, subscription);
  }
  for (const subscription of channelsToUpdate.values()) {
    const stream = activeByChannel.get(subscription.channel_id);
    const previous = previousByChannel.get(subscription.channel_id);
    const videoId = stream?.id || '';
    const shouldNotify = Boolean(videoId && previous?.notified_video_id !== videoId);
    statements.push(env.DB.prepare(`INSERT INTO youtube_live_state
      (user_id, channel_id, video_id, is_live, notified_video_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(user_id, channel_id) DO UPDATE SET video_id = excluded.video_id, is_live = excluded.is_live,
        notified_video_id = CASE WHEN excluded.notified_video_id != '' THEN excluded.notified_video_id ELSE youtube_live_state.notified_video_id END,
        updated_at = excluded.updated_at`).bind(row.user_id, subscription.channel_id, videoId, stream ? 1 : 0, shouldNotify ? videoId : '', timestamp));
    if (shouldNotify) statements.push(env.DB.prepare(`INSERT INTO notifications (id, user_id, type, message, metadata_json, created_at)
      VALUES (?1, ?2, 'live', ?3, ?4, ?5)`).bind(randomId(), row.user_id, `${stream.name} is live: ${stream.title || 'Live now'}`, JSON.stringify({
        platform: 'youtube', channelId: stream.channelId, videoId: stream.id, username: stream.username, name: stream.name,
        title: stream.title, avatar: stream.avatar, thumbnail: stream.thumbnail, viewers: stream.viewers, startedAt: stream.startedAt
      }), timestamp));
  }
  if (statements.length) await runBatches(env, statements);
  const result = { streams, checkedSubscriptions: stored.length, totalSubscriptions: stored.length, partial: false };
  return cachePut(env, cacheKey, result, 600);
}

export async function profileMedia(env, platform, platformUserId, platformUsername, limit = 24, fallbackUsername = '') {
  if (platform === 'twitch') {
    const logins = [...new Set([platformUsername, fallbackUsername].map(value => String(value || '').trim().replace(/^@/, '')).filter(Boolean))];
    const users = await twitchUsers(env, platformUserId ? [platformUserId] : [], logins);
    return users[0] ? twitchClips(env, clampInt(limit, 1, 40, 24), '', users[0].id) : [];
  }
  if (platform === 'youtube') {
    const mediaLimit = clampInt(limit, 1, 40, 24);
    const attemptedIds = new Set();
    const loadChannel = async channelId => {
      const id = String(channelId || '').trim();
      if (!id || attemptedIds.has(id)) return [];
      attemptedIds.add(id);
      return youtubeChannelUploads(env, id, mediaLimit);
    };
    if (platformUserId) {
      const items = await loadChannel(platformUserId);
      if (items.length) return items;
    }
    const handles = [...new Set([platformUsername, fallbackUsername].map(value => String(value || '').trim()).filter(Boolean))];
    for (const handle of handles) {
      if (/^UC[\w-]+$/i.test(handle)) {
        const items = await loadChannel(handle);
        if (items.length) return items;
        continue;
      }
      const channel = await youtubeChannelByHandle(env, handle);
      const items = await loadChannel(channel?.id);
      if (items.length) return items;
    }
    return [];
  }
  return [];
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
  const cacheKey = `browse:v8:${platform}:${view}:${limit}:${categoryId}:${channelId}:${chart}:${query.toLowerCase()}`;
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
  const cacheKey = `featured:v9:${limit}`;
  const lastGoodKey = `featured:last-good:v1:${limit}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;
  const config = parseJson(env.FEATURED_CHANNELS_JSON, {});
  const configured = [];
  for (const [platform, names] of Object.entries(config)) for (const name of names || []) configured.push({ platform, name });
  const configuredResults = await Promise.allSettled(configured.slice(0, 30).map(item => channelDetail(env, item.platform, item.name)));
  const liveConfigured = configuredResults.filter(result => result.status === 'fulfilled' && result.value.live).map(result => result.value);
  const fallbackResults = await Promise.allSettled([
    twitchLive(env, Math.min(40, Math.max(12, limit))),
    kickLive(env, Math.min(40, Math.max(12, limit))),
    youtubeSearchVideos(env, { limit: Math.min(20, Math.max(8, limit)), live: true }),
    env.SCRAPECREATORS_API_KEY ? searchRumbleChannels(env, 'live', Math.min(20, Math.max(8, limit))) : []
  ]);
  const liveFallback = fallbackResults.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const unique = new Map();
  for (const item of [...liveConfigured, ...liveFallback]) {
    if (!item?.live) continue;
    const key = `${item.platform}:${String(item.username || item.name || '').toLowerCase()}`;
    const previous = unique.get(key);
    if (!previous || Number(item.viewers || 0) > Number(previous.viewers || 0)) unique.set(key, item);
  }
  let ranked = [...unique.values()].sort((a, b) => Number(b.viewers || 0) - Number(a.viewers || 0));
  const minimumHealthySize = Math.min(6, limit);
  let reusedPrevious = false;
  if (ranked.length < minimumHealthySize) {
    const previous = await cacheGetStale(env, lastGoodKey, 300)
      || await cacheGetStale(env, `featured:v8:${limit}`, 300);
    if (Array.isArray(previous) && previous.length > ranked.length) {
      for (const item of previous) {
        if (!item?.live) continue;
        const key = `${item.platform}:${String(item.username || item.name || '').toLowerCase()}`;
        if (!unique.has(key)) unique.set(key, item);
      }
      ranked = [...unique.values()].sort((a, b) => Number(b.viewers || 0) - Number(a.viewers || 0));
      reusedPrevious = true;
    }
  }
  const platformOrder = ['twitch', 'youtube', 'kick', 'rumble'];
  const groups = new Map(platformOrder.map(platform => [platform, ranked.filter(item => item.platform === platform)]));
  for (const item of ranked) if (!groups.has(item.platform)) groups.set(item.platform, ranked.filter(candidate => candidate.platform === item.platform));
  const mixed = [];
  while (mixed.length < limit) {
    let added = false;
    for (const group of groups.values()) {
      const item = group.shift();
      if (!item) continue;
      mixed.push(item);
      added = true;
      if (mixed.length >= limit) break;
    }
    if (!added) break;
  }
  if (!reusedPrevious && mixed.length >= minimumHealthySize) await cachePut(env, lastGoodKey, mixed, 3600);
  return cachePut(env, cacheKey, mixed, 60);
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

async function searchYoutubeChannels(env, query, limit) {
  let exact = null;
  try { exact = await youtubeChannelByHandle(env, query); } catch {}
  let searchItems = [];
  try {
    const search = await youtubeApi(env, `/search?part=snippet&type=channel&maxResults=${limit}&q=${encodeURIComponent(query)}`);
    searchItems = search.items || [];
  } catch (error) {
    if (error?.code === 'youtube_rate_limited' && env.SCRAPECREATORS_API_KEY) {
      const payload = await creatorSearch(env, `/v1/youtube/search?query=${encodeURIComponent(query)}&sortBy=popular`);
      const liveItems = (payload.lives || []).map(item => normalizeCreatorYoutubeLive(item));
      const channels = new Map();
      for (const item of payload.channels || []) {
        const id = String(item.id || item.channelId || '');
        if (!id) continue;
        channels.set(id, {
          platform: 'youtube',
          id,
          name: item.channelName || item.title || item.name || id,
          username: String(item.handle || id).replace(/^@/, ''),
          avatar: item.thumbnail || item.avatar || '',
          banner: '',
          live: false,
          category: '',
          viewers: null,
          viewerCountAvailable: false,
          url: `https://www.youtube.com/channel/${encodeURIComponent(id)}`
        });
      }
      for (const live of liveItems) {
        const current = channels.get(live.channelId);
        channels.set(live.channelId || live.id, {
          ...(current || {}),
          platform: 'youtube',
          id: live.channelId || live.id,
          name: live.name,
          username: live.channelId || live.username,
          avatar: live.avatar,
          banner: '',
          live: true,
          category: live.category,
          viewers: live.viewers,
          viewerCountAvailable: live.viewerCountAvailable,
          url: live.channelId ? `https://www.youtube.com/channel/${encodeURIComponent(live.channelId)}` : live.url
        });
      }
      return [...channels.values()].slice(0, limit);
    }
    if (!exact || error?.code !== 'youtube_rate_limited') throw error;
  }
  if (exact && !searchItems.some(item => item.id?.channelId === exact.id)) {
    searchItems.unshift({
      id: { channelId: exact.id },
      snippet: {
        channelTitle: exact.snippet?.title || '',
        title: exact.snippet?.title || '',
        thumbnails: exact.snippet?.thumbnails || {}
      }
    });
  }
  let liveVideos = [];
  try { liveVideos = await youtubeSearchVideos(env, { limit: Math.min(10, Math.max(limit, 5)), query, live: true }); } catch {}
  const liveByChannelId = new Map(liveVideos.map(video => [video.channelId, video]));
  return searchItems.slice(0, limit).map(item => {
    const stream = liveByChannelId.get(item.id?.channelId);
    return {
      platform: 'youtube', id: item.id?.channelId, name: item.snippet?.channelTitle || item.snippet?.title || '',
      username: item.snippet?.channelTitle || '', avatar: item.snippet?.thumbnails?.high?.url || '', banner: '',
      live: Boolean(stream), category: stream?.category || '', viewers: stream?.viewerCountAvailable ? Number(stream.viewers) : null,
      viewerCountAvailable: Boolean(stream?.viewerCountAvailable),
      url: `https://www.youtube.com/channel/${encodeURIComponent(item.id?.channelId || '')}`
    };
  });
}

async function searchKickChannels(env, query, limit) {
  const normalized = query.toLowerCase();
  const live = await kickLive(env, 100);
  const matches = live.filter(item => `${item.name} ${item.username}`.toLowerCase().includes(normalized)).slice(0, limit);
  if (!matches.some(item => item.username.toLowerCase() === normalized)) {
    try {
      const exact = await kickChannelDetail(env, query);
      matches.unshift(exact);
    } catch {}
  }
  return matches.slice(0, limit).map(item => ({
    platform: 'kick', id: item.id, name: item.name, username: item.username, avatar: item.avatar || '', banner: item.banner || '',
    title: item.title || item.stream?.title || '',
    live: Boolean(item.live), category: item.category || '', viewers: item.viewerCountAvailable && Number.isFinite(Number(item.viewers)) ? Number(item.viewers) : null, viewerCountAvailable: Boolean(item.live && item.viewerCountAvailable),
    url: item.url || `https://kick.com/${encodeURIComponent(item.username)}`
  }));
}

async function searchRumbleChannels(env, query, limit) {
  const payload = await creatorSearch(env, `/v1/rumble/search?query=${encodeURIComponent(query)}`);
  const candidates = [
    ...(payload.channels || []).map(item => ({ ...item, _liveResult: false })),
    ...(payload.lives || []).map(item => ({ ...item, _liveResult: true })),
    ...(payload.videos || []).map(item => ({ ...(item.channel || {}), _liveResult: Boolean(item.live || item.is_live) }))
  ];
  const unique = new Map();
  for (const item of candidates) {
    const username = item.handle || item.slug || item.username || item.name || '';
    if (!username) continue;
    const key = username.toLowerCase();
    const viewerCount = availableNumber(item.viewers, item.watching_now, item.viewer_count);
    if (!unique.has(key)) unique.set(key, {
      platform: 'rumble', id: String(item.id || username), name: item.name || item.title || username, username,
      avatar: item.thumbnail || item.avatar || '', banner: '', live: Boolean(item._liveResult || item.live || item.is_live),
      category: item.category || '', viewers: viewerCount, viewerCountAvailable: Boolean((item._liveResult || item.live || item.is_live) && viewerCount !== null),
      url: item.url || `https://rumble.com/c/${encodeURIComponent(username)}`
    });
  }
  return [...unique.values()].slice(0, limit);
}

export async function globalSearch(env, query, limit = 20) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const perPlatform = clampInt(Math.ceil(Number(limit || 20) / 4), 2, 10, 5);
  const cacheKey = `search:global:v6:${q.toLowerCase()}:${perPlatform}`;
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

export { PLATFORM_CAPABILITIES, channelDetail, isCreatorYoutubeLivePayload, normalizeKickChannel, normalizeKickLive };
