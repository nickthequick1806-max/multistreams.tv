import assert from 'node:assert/strict';
import test from 'node:test';
import { browse, isCreatorYoutubeLivePayload, normalizeKickChannel, normalizeKickLive, normalizeYoutubeVideo, parseYoutubeBatchResponse, profileMedia } from '../src/platforms.js';

function apiTestEnv() {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => null,
              run: async () => ({ success: true })
            };
          }
        };
      }
    },
    TOKEN_ENCRYPTION_KEY: 'profile-media-test-encryption-key',
    TWITCH_CLIENT_ID: 'twitch-client',
    TWITCH_CLIENT_SECRET: 'twitch-secret',
    YOUTUBE_API_KEY: 'youtube-key',
    APP_ORIGIN: 'https://multistreams.tv'
  };
}

test('YouTube fallback candidates require a current live broadcast signal', () => {
  assert.equal(isCreatorYoutubeLivePayload({ durationMs: null, publishDateText: 'Started streaming 2 hours ago' }), true);
  assert.equal(isCreatorYoutubeLivePayload({ isLiveNow: true, durationMs: 12_000 }), true);
  assert.equal(isCreatorYoutubeLivePayload({ durationMs: 12_000, publishDateText: 'Started streaming yesterday' }), false);
  assert.equal(isCreatorYoutubeLivePayload({ durationMs: null, publishDateText: 'Streamed 2 hours ago' }), false);
  assert.equal(isCreatorYoutubeLivePayload({ durationMs: null, actualEndTime: '2026-07-23T12:00:00Z', publishDateText: 'Started streaming yesterday' }), false);
});

test('YouTube batch responses retain every subscription result and tolerate failed parts', () => {
  const boundary = 'batch_response';
  const body = [
    `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-item-0>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"items":[{"contentDetails":{"videoId":"live-a"}}]}\r\n`,
    `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-item-1>\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"code":404}}\r\n`,
    `--${boundary}--\r\n`
  ].join('');
  const parsed = parseYoutubeBatchResponse(body, boundary, 2);
  assert.equal(parsed[0].items[0].contentDetails.videoId, 'live-a');
  assert.equal(parsed[1], null);
});

test('YouTube live records expose the real video category instead of a platform label', () => {
  const stream = normalizeYoutubeVideo({
    id: 'live-video',
    snippet: { channelId: 'UC1', channelTitle: 'Creator', title: 'Live now', categoryId: '20', thumbnails: {} },
    liveStreamingDetails: { actualStartTime: '2026-08-14T12:00:00Z', concurrentViewers: '123' },
    statistics: {}, contentDetails: {}, status: { embeddable: true }
  }, { id: 'UC1', snippet: { title: 'Creator', customUrl: '@creator', thumbnails: {} } }, new Map([['20', 'Gaming']]));
  assert.equal(stream.category, 'Gaming');
  assert.equal(stream.live, true);
});

test('sidebar Twitch categories count current channels from category-specific pages', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'id.twitch.tv') return Response.json({ access_token: 'app-token', expires_in: 3600 });
    if (url.pathname.endsWith('/games/top')) return Response.json({ data: [
      { id: '1', name: 'One', box_art_url: 'https://img.test/{width}x{height}.jpg' },
      { id: '2', name: 'Two', box_art_url: 'https://img.test/{width}x{height}.jpg' }
    ] });
    if (url.pathname.endsWith('/streams')) {
      const gameId = url.searchParams.get('game_id');
      if (gameId === '1' && !url.searchParams.has('after')) return Response.json({
        data: [{ viewer_count: 30 }, { viewer_count: 20 }],
        pagination: { cursor: 'next-short-page' }
      });
      return Response.json({ data: gameId === '1' ? [{ viewer_count: 10 }] : [{ viewer_count: 7 }], pagination: {} });
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
  try {
    const categories = await browse(apiTestEnv(), 'twitch', 'categories', { limit: 2 });
    assert.equal(categories.items[0].liveChannels, 2);
    assert.equal(categories.items[0].liveChannelsComplete, false);
    const result = await browse(apiTestEnv(), 'twitch', 'category-stats', { categoryId: '1' });
    assert.equal(result.items[0].liveChannels, 3);
    assert.equal(result.items[0].watching, 60);
    assert.equal(result.items[0].liveChannelsComplete, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Kick live records use the official broadcaster profile and positive viewer count', () => {
  const stream = normalizeKickLive({
    id: 'live-1',
    title: 'Ranked grind',
    viewer_count: 245,
    started_at: '2026-07-23T12:00:00Z',
    category: { id: 15, name: 'Just Chatting' },
    channel: { slug: 'creator' },
    broadcaster_user: {
      id: 42,
      username: 'Creator',
      profile_picture: 'https://files.kick.com/profile.webp'
    }
  });

  assert.equal(stream.live, true);
  assert.equal(stream.username, 'creator');
  assert.equal(stream.name, 'Creator');
  assert.equal(stream.avatar, 'https://files.kick.com/profile.webp');
  assert.equal(stream.viewers, 245);
  assert.equal(stream.viewerCountAvailable, true);
  assert.equal(stream.category, 'Just Chatting');
  assert.equal(stream.title, 'Ranked grind');
});

test('Kick live records with hidden or zero viewers remain live and omit the count', () => {
  const stream = normalizeKickLive({
    id: 'live-hidden',
    title: 'Live without a public count',
    viewer_count: 0,
    category: { name: 'Gaming' },
    channel: { slug: 'hiddencreator' },
    broadcaster_user: { id: 43, username: 'HiddenCreator', profile_picture: '' }
  });

  assert.equal(stream.live, true);
  assert.equal(stream.viewers, null);
  assert.equal(stream.viewerCountAvailable, false);
  assert.equal(stream.avatar, '');
});

test('Kick channel records centralize offline, live, optional, and profile-picture fields', () => {
  const offline = normalizeKickChannel({
    broadcaster_user_id: 676,
    slug: 'xqc',
    channel_description: 'Channel description',
    banner_picture: 'https://files.kick.com/banner.webp',
    stream: { is_live: false, viewer_count: 0 },
    category: { id: 0, name: '' }
  }, {
    user_id: 676,
    name: 'xQc',
    profile_picture: 'https://files.kick.com/xqc.webp'
  });

  assert.equal(offline.live, false);
  assert.equal(offline.stream, null);
  assert.equal(offline.avatar, 'https://files.kick.com/xqc.webp');
  assert.equal(offline.viewers, null);
  assert.equal(offline.viewerCountAvailable, false);

  const hiddenLive = normalizeKickChannel({
    broadcaster_user_id: 99,
    slug: 'livecreator',
    stream_title: 'Live title',
    stream: { is_live: true, viewer_count: null, thumbnail: 'https://images.kick.com/live.webp' },
    category: { id: 15, name: 'Just Chatting' }
  }, {
    user_id: 99,
    name: 'LiveCreator',
    profile_picture: 'https://files.kick.com/livecreator.webp'
  });

  assert.equal(hiddenLive.live, true);
  assert.equal(hiddenLive.stream.live, true);
  assert.equal(hiddenLive.avatar, 'https://files.kick.com/livecreator.webp');
  assert.equal(hiddenLive.viewers, null);
  assert.equal(hiddenLive.viewerCountAvailable, false);
  assert.equal(hiddenLive.stream.viewerCountAvailable, false);
});

test('profile Twitch clips use the full broadcaster catalogue instead of a seven-day window', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let clipRequest = '';
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.startsWith('https://id.twitch.tv/oauth2/token')) return Response.json({ access_token: 'app-token', expires_in: 3600 });
    if (url.includes('/helix/users')) return Response.json({ data: [{ id: '42', login: 'creator', display_name: 'Creator', profile_image_url: 'https://img.test/avatar.jpg' }] });
    if (url.includes('/helix/clips')) {
      clipRequest = url;
      return Response.json({ data: [{ id: 'ClipOne', broadcaster_id: '42', broadcaster_name: 'Creator', title: 'Classic clip', view_count: 99, duration: 21, created_at: '2025-01-01T00:00:00Z', thumbnail_url: 'https://img.test/clip.jpg', url: 'https://clips.twitch.tv/ClipOne' }] });
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
  try {
    const clips = await profileMedia(apiTestEnv(), 'twitch', '42', 'creator', 24);
    assert.equal(clips.length, 1);
    assert.equal(clips[0].id, 'ClipOne');
    assert.match(clipRequest, /broadcaster_id=42/);
    assert.doesNotMatch(clipRequest, /started_at|ended_at/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('profile YouTube videos fall back to channel search when uploads playlist is unavailable', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let usedChannelSearch = false;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/channels')) return Response.json({ items: [{ id: 'UC123', snippet: { title: 'Creator', customUrl: '@creator', thumbnails: { high: { url: 'https://img.test/avatar.jpg' } } }, contentDetails: { relatedPlaylists: { uploads: 'UU123' } }, brandingSettings: {} }] });
    if (url.pathname.endsWith('/playlistItems')) return Response.json({ error: { errors: [{ reason: 'playlistNotFound' }] } }, { status: 404 });
    if (url.pathname.endsWith('/search')) {
      usedChannelSearch = url.searchParams.get('channelId') === 'UC123' && url.searchParams.get('order') === 'date';
      return Response.json({ items: [{ id: { videoId: 'video-1' } }] });
    }
    if (url.pathname.endsWith('/videos')) return Response.json({ items: [{ id: 'video-1', snippet: { channelId: 'UC123', channelTitle: 'Creator', title: 'Latest video', publishedAt: '2026-08-01T00:00:00Z', thumbnails: { high: { url: 'https://img.test/video.jpg' } } }, statistics: { viewCount: '1200' }, contentDetails: { duration: 'PT8M4S' }, status: { embeddable: true } }] });
    throw new Error(`Unexpected test request: ${url}`);
  };
  try {
    const videos = await profileMedia(apiTestEnv(), 'youtube', 'UC123', '@creator', 24);
    assert.equal(usedChannelSearch, true);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].id, 'video-1');
    assert.equal(videos[0].durationSeconds, 484);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('profile YouTube videos can use the saved public channel when the OAuth channel is empty', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const requestedChannelIds = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/channels') && url.searchParams.has('id')) {
      const id = url.searchParams.get('id');
      requestedChannelIds.push(id);
      return Response.json({ items: [{ id, snippet: { title: id === 'UC_PUBLIC' ? 'Public Creator' : 'Empty OAuth Channel', customUrl: id === 'UC_PUBLIC' ? '@publiccreator' : '@emptychannel', thumbnails: {} }, contentDetails: {}, brandingSettings: {} }] });
    }
    if (url.pathname.endsWith('/channels') && url.searchParams.has('forHandle')) {
      const handle = url.searchParams.get('forHandle').replace(/^@/, '');
      return Response.json({ items: [{ id: handle === 'publiccreator' ? 'UC_PUBLIC' : 'UC_EMPTY', snippet: { title: handle, customUrl: `@${handle}`, thumbnails: {} }, contentDetails: {}, brandingSettings: {} }] });
    }
    if (url.pathname.endsWith('/search')) {
      const channelId = url.searchParams.get('channelId');
      return Response.json({ items: channelId === 'UC_PUBLIC' ? [{ id: { videoId: 'public-video' } }] : [] });
    }
    if (url.pathname.endsWith('/videos')) return Response.json({ items: [{ id: 'public-video', snippet: { channelId: 'UC_PUBLIC', channelTitle: 'Public Creator', title: 'Public video', publishedAt: '2026-08-01T00:00:00Z', thumbnails: {} }, statistics: {}, contentDetails: { duration: 'PT2M' }, status: { embeddable: true } }] });
    throw new Error(`Unexpected test request: ${url}`);
  };
  try {
    const videos = await profileMedia(apiTestEnv(), 'youtube', 'UC_EMPTY', '@emptychannel', 24, '@publiccreator');
    assert.deepEqual(requestedChannelIds, ['UC_EMPTY', 'UC_PUBLIC']);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].id, 'public-video');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
