import assert from 'node:assert/strict';
import test from 'node:test';
import { isCreatorYoutubeLivePayload, normalizeKickChannel, normalizeKickLive } from '../src/platforms.js';

test('YouTube fallback candidates require a current live broadcast signal', () => {
  assert.equal(isCreatorYoutubeLivePayload({ durationMs: null, publishDateText: 'Started streaming 2 hours ago' }), true);
  assert.equal(isCreatorYoutubeLivePayload({ isLiveNow: true, durationMs: 12_000 }), true);
  assert.equal(isCreatorYoutubeLivePayload({ durationMs: 12_000, publishDateText: 'Started streaming yesterday' }), false);
  assert.equal(isCreatorYoutubeLivePayload({ durationMs: null, publishDateText: 'Streamed 2 hours ago' }), false);
  assert.equal(isCreatorYoutubeLivePayload({ durationMs: null, actualEndTime: '2026-07-23T12:00:00Z', publishDateText: 'Started streaming yesterday' }), false);
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
